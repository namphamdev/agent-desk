//! `LocalEnvironment` — a faithful port of
//! `src/minisweagent/environments/local.py`.
//!
//! Core behaviors preserved exactly:
//! - **Fresh subshell per command** (Python `shell=True`): `sh -c <command>`
//!   on Unix, `cmd /C <command>` on Windows. No persistent shell state —
//!   central to mini-swe-agent's design and to sandboxability.
//! - **Merged stdout/stderr** (`stderr=STDOUT`): one combined observation.
//! - **Timeout with full-group kill.** Python uses `start_new_session` +
//!   `killpg(SIGKILL)`. We spawn the child in its own process group so a
//!   timeout/interrupt tears down the whole descendant tree (no orphans).
//! - **`COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` detection** (`_check_finished`):
//!   when the first line of output (stripped) equals the sentinel and the
//!   return code is 0, the remainder is the submission and the run ends.

use std::collections::HashMap;
use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use comet_harness::CancellationToken;

/// The sentinel the instance template tells the model to emit to finish.
pub const COMPLETE_SENTINEL: &str = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";

/// The env vars mini injects to quiet pagers/progress bars (merged onto the
/// inherited process env in [`LocalEnvironment::extra_env`]).
fn default_extra_env() -> HashMap<String, String> {
    [
        ("PAGER", "cat"),
        ("MANPAGER", "cat"),
        ("LESS", "-R"),
        ("PIP_PROGRESS_BAR", "off"),
        ("TQDM_DISABLE", "1"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// Raw output of one executed command, mirroring mini's `{output, returncode,
/// exception_info}` dict.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EnvOutput {
    /// Merged stdout+stderr (utf-8, lossy on bad bytes).
    pub output: String,
    /// Process exit code, or `-1` when execution raised (timeout / spawn fail).
    pub returncode: i32,
    /// Empty on success; a human message when execution raised.
    pub exception_info: String,
}

/// What `_check_finished` reports for one command.
#[derive(Debug, Clone, PartialEq)]
pub enum FinishCheck {
    /// The first line was the sentinel — the remainder is the submission.
    Submitted(String),
    Run,
}

/// The local bash/sh environment.
pub struct LocalEnvironment {
    cwd: String,
    extra_env: HashMap<String, String>,
}

impl LocalEnvironment {
    /// New environment rooted at `cwd`, with mini's default pager/progress env.
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            cwd: cwd.into(),
            extra_env: default_extra_env(),
        }
    }

    /// Override the extra-env map (test seam / provider injection).
    pub fn with_extra_env(mut self, env: HashMap<String, String>) -> Self {
        self.extra_env = env;
        self
    }

    /// Execute one bash action. Runs `sh -c <command>` (Unix) / `cmd /C
    /// <command>` (Windows) in a fresh subshell in its own process group,
    /// merging stdout+stderr. On timeout (or `interrupt`) the whole group is
    /// killed. Returns the raw output + the finish-check result.
    pub async fn execute(
        &self,
        command: &str,
        timeout_secs: u64,
        interrupt: &CancellationToken,
    ) -> (EnvOutput, FinishCheck) {
        let output = run_command(command, &self.cwd, &self.extra_env, timeout_secs, interrupt)
            .await;
        let finish = check_finished(&output);
        (output, finish)
    }
}

/// `_check_finished` from local.py: the first stripped line equal to the
/// sentinel + returncode 0 ⇒ the rest of the output is the submission.
pub(crate) fn check_finished(output: &EnvOutput) -> FinishCheck {
    if output.returncode != 0 {
        return FinishCheck::Run;
    }
    let body = output.output.trim_start();
    let mut lines = body.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return FinishCheck::Run;
    };
    if first.trim() == COMPLETE_SENTINEL {
        let submission: String = lines.collect();
        FinishCheck::Submitted(submission)
    } else {
        FinishCheck::Run
    }
}

/// Run `command` in a fresh subshell in its own process group, merging
/// stdout+stderr, killing the whole group on timeout or interrupt.
pub(crate) async fn run_command(
    command: &str,
    cwd: &str,
    extra_env: &HashMap<String, String>,
    timeout_secs: u64,
    interrupt: &CancellationToken,
) -> EnvOutput {
    #[cfg(unix)]
    {
        run_command_unix(command, cwd, extra_env, timeout_secs, interrupt).await
    }
    #[cfg(not(unix))]
    {
        run_command_windows(command, cwd, extra_env, timeout_secs, interrupt).await
    }
}

#[cfg(unix)]
async fn run_command_unix(
    command: &str,
    cwd: &str,
    extra_env: &HashMap<String, String>,
    timeout_secs: u64,
    interrupt: &CancellationToken,
) -> EnvOutput {
    use std::os::unix::process::CommandExt;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = Command::new(shell);
    cmd.arg("-c").arg(command);
    cmd.current_dir(if cwd.is_empty() { "." } else { cwd });
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    // Put the child in its own process group (Python: start_new_session=True
    // calls setsid()). process_group(0) makes the child a group leader so we
    // can killpg(-pgid) on timeout/interrupt.
    cmd.process_group(0);
    cmd.kill_on_drop(true);

    let Ok(mut child) = cmd.spawn() else {
        return EnvOutput {
            output: String::new(),
            returncode: -1,
            exception_info: "failed to spawn subshell".into(),
        };
    };
    let pid = child.id();

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let timeout = std::time::Duration::from_secs(timeout_secs);
    let timed_out = tokio::select! {
        biased;
        _ = interrupt.cancelled() => false, // interrupt handled below
        _ = tokio::time::sleep(timeout) => true,
        s = child.wait() => {
            return finalize_unix(s, stdout_task, stderr_task).await;
        }
    };
    // If we get here, either the interrupt fired or the timeout fired. Either
    // way: kill the group and reap. A timeout surfaces as a -1 code (mirroring
    // Python's TimeoutExpired raising), an interrupt likewise.
    kill_process_group_unix(pid);
    let _ = child.kill().await;
    let status = child.wait().await;
    let (out_buf, err_buf) = (
        stdout_task.await.unwrap_or_default(),
        stderr_task.await.unwrap_or_default(),
    );
    let mut output = String::from_utf8_lossy(&out_buf).into_owned();
    let err = String::from_utf8_lossy(&err_buf);
    if !err.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&err);
    }
    let _ = status;
    let message = if timed_out {
        format!("Command timed out after {timeout_secs}s and was killed")
    } else {
        "Run interrupted".to_string()
    };
    EnvOutput {
        output,
        returncode: -1,
        exception_info: message,
    }
}

#[cfg(unix)]
async fn finalize_unix(
    status: std::io::Result<std::process::ExitStatus>,
    stdout_task: tokio::task::JoinHandle<Vec<u8>>,
    stderr_task: tokio::task::JoinHandle<Vec<u8>>,
) -> EnvOutput {
    let (out_buf, err_buf) = (
        stdout_task.await.unwrap_or_default(),
        stderr_task.await.unwrap_or_default(),
    );
    match status {
        Ok(status) => {
            let mut output = String::from_utf8_lossy(&out_buf).into_owned();
            let err = String::from_utf8_lossy(&err_buf);
            if !err.is_empty() {
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push_str(&err);
            }
            EnvOutput {
                output,
                returncode: status.code().unwrap_or(-1),
                exception_info: String::new(),
            }
        }
        Err(e) => EnvOutput {
            output: String::new(),
            returncode: -1,
            exception_info: format!("failed to wait on subshell: {e}"),
        },
    }
}

#[cfg(unix)]
fn kill_process_group_unix(pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: killing our own child's process group. A negative pid targets
        // the whole group; matches `killpg(pid, SIGKILL)`.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
async fn run_command_windows(
    command: &str,
    cwd: &str,
    extra_env: &HashMap<String, String>,
    timeout_secs: u64,
    interrupt: &CancellationToken,
) -> EnvOutput {
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg(command);
    cmd.current_dir(if cwd.is_empty() { "." } else { cwd });
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.kill_on_drop(true);

    let Ok(mut child) = cmd.spawn() else {
        return EnvOutput {
            output: String::new(),
            returncode: -1,
            exception_info: "failed to spawn subshell".into(),
        };
    };

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    // Windows process-tree kill: assign the child to a Job Object with
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so terminating the job tears down the
    // whole descendant tree (cmd /C → ping, etc.).
    let job = create_kill_on_close_job();
    if let Some(job) = job {
        if let Some(pid) = child.id() {
            assign_to_job(job, pid);
        }
    }

    let timeout = std::time::Duration::from_secs(timeout_secs);
    let timed_out = tokio::select! {
        biased;
        _ = interrupt.cancelled() => false,
        _ = tokio::time::sleep(timeout) => true,
        s = child.wait() => {
            // Success path: the command finished on its own. Close (but don't
            // terminate) the job to release its handle.
            if let Some(job) = job {
                close_job(job);
            }
            return finalize_windows(s, stdout_task, stderr_task).await;
        }
    };
    // Terminate the whole process tree via the Job Object (kills the child AND
    // all descendants — e.g. the `ping` grandchild — which closes their pipe
    // handles so the read tasks unblock). Fall back to start_kill if no job.
    if let Some(job) = job {
        terminate_job(job);
    } else {
        let _ = child.start_kill();
    }
    let status = child.wait().await;
    // The pipe reads now unblock (the tree is dead); bound the wait defensively.
    let (out_buf, err_buf) = (
        tokio::time::timeout(std::time::Duration::from_secs(5), stdout_task)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default(),
        tokio::time::timeout(std::time::Duration::from_secs(5), stderr_task)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default(),
    );
    let mut output = String::from_utf8_lossy(&out_buf).into_owned();
    let err = String::from_utf8_lossy(&err_buf);
    if !err.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&err);
    }
    let _ = status;
    let message = if timed_out {
        format!("Command timed out after {timeout_secs}s and was killed")
    } else {
        "Run interrupted".to_string()
    };
    EnvOutput {
        output,
        returncode: -1,
        exception_info: message,
    }
}

#[cfg(not(unix))]
async fn finalize_windows(
    status: std::io::Result<std::process::ExitStatus>,
    stdout_task: tokio::task::JoinHandle<Vec<u8>>,
    stderr_task: tokio::task::JoinHandle<Vec<u8>>,
) -> EnvOutput {
    let (out_buf, err_buf) = (
        stdout_task.await.unwrap_or_default(),
        stderr_task.await.unwrap_or_default(),
    );
    match status {
        Ok(status) => {
            let mut output = String::from_utf8_lossy(&out_buf).into_owned();
            let err = String::from_utf8_lossy(&err_buf);
            if !err.is_empty() {
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push_str(&err);
            }
            EnvOutput {
                output,
                returncode: status.code().unwrap_or(-1),
                exception_info: String::new(),
            }
        }
        Err(e) => EnvOutput {
            output: String::new(),
            returncode: -1,
            exception_info: format!("failed to wait on subshell: {e}"),
        },
    }
}

/// Opaque job handle (`HANDLE` = `*mut c_void` in windows-sys 0.59). Wrapped
/// in a newtype so it can cross `.await` points in a multi-threaded runtime
/// (raw pointers are `!Send` by default).
#[cfg(not(unix))]
#[repr(transparent)]
#[derive(Clone, Copy)]
struct JobHandle(*mut core::ffi::c_void);

#[cfg(not(unix))]
unsafe impl Send for JobHandle {}

#[cfg(not(unix))]
type Handle = JobHandle;

#[cfg(not(unix))]
fn create_kill_on_close_job() -> Option<Handle> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, SetInformationJobObject,
    };
    // SAFETY: CreateJobObjectW with no name + default security returns a fresh
    // job handle (NULL / INVALID_HANDLE_VALUE on failure). We never deref the
    // opaque handle; it's passed straight back to the Job API.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            return None;
        }
        Some(JobHandle(job))
    }
}

#[cfg(not(unix))]
fn assign_to_job(job: Handle, pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    // SAFETY: OpenProcess for the child pid with just enough rights to assign
    // it to the job; the handle is closed after assignment.
    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return;
        }
        AssignProcessToJobObject(job.0, handle);
        CloseHandle(handle);
    }
}

/// Terminate every process in the job (kills the whole descendant tree), then
/// close the handle (KILL_ON_JOB_CLOSE would do the same, but an explicit
/// terminate is immediate and unambiguous).
#[cfg(not(unix))]
fn terminate_job(job: Handle) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
    // SAFETY: job is a valid Job Object handle from create_kill_on_close_job;
    // exit code 1 is arbitrary but non-zero.
    unsafe {
        TerminateJobObject(job.0, 1);
        CloseHandle(job.0);
    }
}

/// Close a job handle without terminating (success path cleanup).
#[cfg(not(unix))]
fn close_job(job: Handle) {
    // SAFETY: job is a valid Job Object handle.
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(job.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_interrupt() -> CancellationToken {
        CancellationToken::new()
    }

    #[tokio::test]
    async fn runs_echo_and_merges() {
        #[cfg(unix)]
        let cmd = "echo hello; echo oops 1>&2";
        #[cfg(not(unix))]
        let cmd = "echo hello& echo oops 1>&2";
        let (out, finish) = LocalEnvironment::new(".")
            .execute(cmd, 10, &no_interrupt())
            .await;
        assert!(out.output.contains("hello"), "got: {:?}", out.output);
        assert!(out.output.contains("oops"), "got: {:?}", out.output);
        assert_eq!(out.returncode, 0);
        assert_eq!(finish, FinishCheck::Run);
    }

    #[tokio::test]
    async fn detects_sentinel_submission() {
        // Cross-platform: emit the sentinel on line 1 and the submission on
        // line 2. `&&` separates commands in both sh and cmd.
        let cmd = format!("echo {COMPLETE_SENTINEL}&& echo the_answer");
        let (out, finish) = LocalEnvironment::new(".")
            .execute(&cmd, 10, &no_interrupt())
            .await;
        assert_eq!(out.returncode, 0, "output: {:?}", out.output);
        match finish {
            FinishCheck::Submitted(s) => assert!(s.contains("the_answer"), "got: {s:?}"),
            other => panic!("expected Submitted, got {other:?} (output: {:?})", out.output),
        }
    }

    #[tokio::test]
    async fn non_zero_returncode_does_not_submit() {
        // The sentinel is emitted but the command then fails (exit 1), so the
        // finish check must NOT submit. `&&` short-circuits on failure in both
        // shells, so use `&`-style sequencing: echo then a guaranteed non-zero.
        #[cfg(unix)]
        let cmd = format!("echo {COMPLETE_SENTINEL}; false");
        #[cfg(not(unix))]
        let cmd = format!("echo {COMPLETE_SENTINEL}& exit /b 3");
        let (out, finish) = LocalEnvironment::new(".")
            .execute(&cmd, 10, &no_interrupt())
            .await;
        assert_ne!(out.returncode, 0, "output: {:?}", out.output);
        assert_eq!(finish, FinishCheck::Run);
    }

    #[tokio::test]
    async fn timeout_kills_child_and_descendants() {
        // A long-running command that (on Unix) spawns children. The timeout
        // must fire and the whole process group must be killed. We only assert
        // the elapsed time and that the run ended (returncode != 0 surface) —
        // the specific non-zero code is platform-dependent.
        #[cfg(unix)]
        let cmd = "sleep 30 & sleep 30 & wait";
        #[cfg(not(unix))]
        // `ping -n 31 127.0.0.1 > nul` sleeps ~30s without the input-redirection
        // objection that `timeout /t` raises under piped stdin.
        let cmd = "ping -n 31 127.0.0.1 > nul";
        let start = std::time::Instant::now();
        let (out, _finish) = LocalEnvironment::new(".")
            .execute(cmd, 2, &no_interrupt())
            .await;
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "run took {elapsed:?}"
        );
        assert_ne!(
            out.returncode, 0,
            "expected a non-zero surface code after kill, got {out:?}"
        );
    }
}
