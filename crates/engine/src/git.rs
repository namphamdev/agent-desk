use crate::EngineError;
use crate::registry::HarnessRegistry;
use comet_harness::{CancellationToken, RunControls, SteerMessage};
use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, RunRequest, SandboxLevel, UserInputAnswer, UserInputQuestion,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileChange>,
    pub is_repo: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub kind: String,
    pub staged: bool,
    pub unstaged: bool,
    pub xy: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitMessage {
    pub subject: String,
    pub body: String,
    pub raw: String,
}

fn validate_cwd(cwd: &Path) -> Result<(), EngineError> {
    if !cwd.is_absolute() {
        return Err(EngineError::Other("cwd must be absolute".to_string()));
    }
    Ok(())
}

fn validate_paths(paths: &[String]) -> Result<(), EngineError> {
    for p in paths {
        if p.trim().is_empty() {
            return Err(EngineError::Other("path cannot be empty".to_string()));
        }
    }
    Ok(())
}

pub async fn status(cwd: &Path) -> Result<GitStatus, EngineError> {
    validate_cwd(cwd)?;

    let out = Command::new("git")
        .current_dir(cwd)
        .args(&["status", "--porcelain=v1", "-b"])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git status failed to spawn: {}", e)))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        if msg.to_lowercase().contains("not a git repository") {
            return Ok(GitStatus {
                branch: None,
                ahead: 0,
                behind: 0,
                files: vec![],
                is_repo: false,
            });
        }
        return Err(EngineError::Other(format!("git status failed: {}", msg)));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();

    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        if line.starts_with("## ") {
            let (b, a, bh) = parse_branch_header(line);
            branch = b;
            ahead = a;
            behind = bh;
            continue;
        }
        if let Some(f) = parse_porcelain_line(line) {
            files.push(f);
        }
    }

    Ok(GitStatus {
        branch,
        ahead,
        behind,
        files,
        is_repo: true,
    })
}

pub async fn stage(cwd: &Path, paths: &[String]) -> Result<(), EngineError> {
    validate_cwd(cwd)?;
    validate_paths(paths)?;

    if paths.is_empty() {
        return Ok(());
    }

    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));

    let out = run_git(cwd, &args, "git add").await?;
    if out.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&out.stderr);
    if is_index_lock_error(&stderr) && remove_index_lock(cwd).await? {
        let retry = run_git(cwd, &args, "git add").await?;
        if retry.status.success() {
            return Ok(());
        }
        return Err(git_command_error("git add", &retry.stderr));
    }

    Err(git_command_error("git add", &out.stderr))
}

async fn run_git(
    cwd: &Path,
    args: &[&str],
    operation: &str,
) -> Result<std::process::Output, EngineError> {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .await
        .map_err(|error| EngineError::Other(format!("{operation} failed to spawn: {error}")))
}

fn git_command_error(operation: &str, stderr: &[u8]) -> EngineError {
    EngineError::Other(format!(
        "{operation} failed: {}",
        String::from_utf8_lossy(stderr).trim()
    ))
}

fn is_index_lock_error(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("unable to create") && stderr.contains("index.lock")
}

/// Remove the index lock Git reports while staging, then allow one retry.
///
/// `git rev-parse --git-path` resolves both standard repositories and worktrees,
/// so the cleanup always targets this repository's index lock.
async fn remove_index_lock(cwd: &Path) -> Result<bool, EngineError> {
    let lock_path = run_git(
        cwd,
        &["rev-parse", "--git-path", "index.lock"],
        "git rev-parse",
    )
    .await?;
    if !lock_path.status.success() {
        return Ok(false);
    }

    let lock_path = String::from_utf8_lossy(&lock_path.stdout)
        .trim()
        .to_string();
    if lock_path.is_empty() {
        return Ok(false);
    }
    let lock_path = Path::new(&lock_path);
    let lock_path = if lock_path.is_absolute() {
        lock_path.to_path_buf()
    } else {
        cwd.join(lock_path)
    };

    match tokio::fs::remove_file(&lock_path).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(EngineError::Other(format!(
            "could not remove stale git index lock: {error}"
        ))),
    }
}

pub async fn unstage(cwd: &Path, paths: &[String]) -> Result<(), EngineError> {
    validate_cwd(cwd)?;
    validate_paths(paths)?;

    if paths.is_empty() {
        return Ok(());
    }

    // Try `restore --staged` first
    let mut args1 = vec!["restore", "--staged", "--"];
    args1.extend(paths.iter().map(|s| s.as_str()));

    let out = Command::new("git")
        .current_dir(cwd)
        .args(&args1)
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git restore failed to spawn: {}", e)))?;

    if out.status.success() {
        return Ok(());
    }

    // Fallback to `reset HEAD`
    let mut args2 = vec!["reset", "HEAD", "--"];
    args2.extend(paths.iter().map(|s| s.as_str()));

    let out2 = Command::new("git")
        .current_dir(cwd)
        .args(&args2)
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git reset failed to spawn: {}", e)))?;

    if !out2.status.success() {
        let stderr = String::from_utf8_lossy(&out2.stderr);
        return Err(EngineError::Other(format!(
            "git unstage failed: {}",
            stderr.trim()
        )));
    }

    Ok(())
}

/// Restore a tracked path to its index state, or remove an untracked path.
/// The path is passed as a single `--`-separated git argument, never through a
/// shell, so spaces and metacharacters remain safe.
pub async fn discard(cwd: &Path, path: &str, untracked: bool) -> Result<(), EngineError> {
    validate_cwd(cwd)?;
    validate_paths(&[path.to_string()])?;

    let mut args = if untracked {
        vec!["clean", "-f", "--"]
    } else {
        vec!["restore", "--worktree", "--"]
    };
    args.push(path);
    let out = Command::new("git")
        .current_dir(cwd)
        .args(&args)
        .output()
        .await
        .map_err(|error| EngineError::Other(format!("git discard failed to spawn: {error}")))?;
    if !out.status.success() {
        return Err(EngineError::Other(format!(
            "git discard failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Add a repository-relative path to the root `.gitignore`.
pub async fn ignore(cwd: &Path, path: &str) -> Result<(), EngineError> {
    validate_cwd(cwd)?;
    validate_paths(&[path.to_string()])?;
    let root = Command::new("git")
        .current_dir(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .await
        .map_err(|error| EngineError::Other(format!("git rev-parse failed to spawn: {error}")))?;
    if !root.status.success() {
        return Err(EngineError::Other("Not a git repository.".into()));
    }
    let ignore_path =
        Path::new(std::str::from_utf8(&root.stdout).unwrap_or("").trim()).join(".gitignore");
    let existing = tokio::fs::read_to_string(&ignore_path)
        .await
        .unwrap_or_default();
    if !existing.lines().any(|line| line.trim() == path) {
        let separator = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        tokio::fs::write(&ignore_path, format!("{existing}{separator}{path}\n"))
            .await
            .map_err(|error| EngineError::Other(format!("could not update .gitignore: {error}")))?;
    }
    Ok(())
}

/// Open the host system file browser with this path selected.
pub async fn reveal(cwd: &Path, path: &str) -> Result<(), EngineError> {
    validate_cwd(cwd)?;
    validate_paths(&[path.to_string()])?;
    let full_path = cwd.join(path);
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.args(["-R"]).arg(&full_path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", full_path.display()));
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(full_path.parent().unwrap_or(cwd));
        command
    };
    command
        .spawn()
        .map_err(|error| EngineError::Other(format!("could not reveal file: {error}")))?;
    Ok(())
}

pub async fn commit(cwd: &Path, subject: &str, body: Option<&str>) -> Result<String, EngineError> {
    validate_cwd(cwd)?;

    let subj = subject.trim();
    if subj.is_empty() {
        return Err(EngineError::Other("Commit subject is required".to_string()));
    }

    let message = if let Some(b) = body {
        if b.trim().is_empty() {
            subj.to_string()
        } else {
            format!("{}\n\n{}", subj, b.trim())
        }
    } else {
        subj.to_string()
    };

    let check = Command::new("git")
        .current_dir(cwd)
        .args(&["diff", "--cached", "--name-only"])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git diff failed to spawn: {}", e)))?;

    if !check.status.success() {
        return Err(EngineError::Other(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&check.stderr).trim()
        )));
    }
    if String::from_utf8_lossy(&check.stdout).trim().is_empty() {
        return Err(EngineError::Other("Nothing staged to commit.".to_string()));
    }

    let out = Command::new("git")
        .current_dir(cwd)
        .args(&["commit", "-m", &message])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git commit failed to spawn: {}", e)))?;

    if !out.status.success() {
        return Err(EngineError::Other(format!(
            "git commit failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    let rev = Command::new("git")
        .current_dir(cwd)
        .args(&["rev-parse", "--short", "HEAD"])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git rev-parse failed to spawn: {}", e)))?;

    let hash = if rev.status.success() {
        String::from_utf8_lossy(&rev.stdout).trim().to_string()
    } else {
        "".to_string()
    };

    Ok(hash)
}

fn summarize_git_remote_output(stdout: &str, stderr: &str) -> String {
    let combined = format!("{}\n{}", stdout.trim(), stderr.trim());
    let mut lines = combined.lines().map(|l| l.trim()).filter(|l| !l.is_empty());
    let last = lines.next_back().unwrap_or("").to_string();
    if last.is_empty() {
        "".to_string()
    } else {
        last
    }
}

pub async fn fetch(cwd: &Path) -> Result<String, EngineError> {
    validate_cwd(cwd)?;

    let out = Command::new("git")
        .current_dir(cwd)
        .args(&["fetch", "--prune", "--progress"])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git fetch failed to spawn: {}", e)))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(EngineError::Other(format!("git fetch failed: {}", msg)));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut summary = summarize_git_remote_output(&stdout, &stderr);
    if summary.is_empty() {
        summary = "Fetch complete.".to_string();
    }

    Ok(summary)
}

pub async fn push(cwd: &Path) -> Result<String, EngineError> {
    validate_cwd(cwd)?;

    let up = Command::new("git")
        .current_dir(cwd)
        .args(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git rev-parse failed to spawn: {}", e)))?;

    let has_upstream =
        up.status.success() && !String::from_utf8_lossy(&up.stdout).trim().is_empty();

    let mut args = vec!["push"];
    if !has_upstream {
        args.extend(&["-u", "origin", "HEAD"]);
    }
    args.push("--progress");

    let out = Command::new("git")
        .current_dir(cwd)
        .args(&args)
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git push failed to spawn: {}", e)))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(EngineError::Other(format!("git push failed: {}", msg)));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut summary = summarize_git_remote_output(&stdout, &stderr);
    if summary.is_empty() {
        summary = "Push complete.".to_string();
    }

    Ok(summary)
}

pub async fn generate_commit_message(
    registry: &HarnessRegistry,
    cwd: &Path,
    harness_id: HarnessId,
    model: Option<String>,
) -> Result<GitCommitMessage, EngineError> {
    validate_cwd(cwd)?;
    let status = status(cwd).await?;
    if !status.is_repo {
        return Err(EngineError::Other("Not a git repository.".into()));
    }
    if status.files.is_empty() {
        return Err(EngineError::Other("No changes to commit.".into()));
    }

    let staged = status.files.iter().any(|file| file.staged);
    let diff_args = if staged {
        vec!["diff", "--cached", "--stat", "-p", "--"]
    } else {
        vec!["diff", "HEAD", "--stat", "-p", "--"]
    };
    let diff_output = Command::new("git")
        .current_dir(cwd)
        .args(&diff_args)
        .output()
        .await
        .map_err(|error| EngineError::Other(format!("git diff failed to spawn: {error}")))?;
    if !diff_output.status.success() {
        return Err(EngineError::Other(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&diff_output.stderr).trim()
        )));
    }

    let mut context = format!(
        "Branch: {}\n\nFiles:\n",
        status.branch.as_deref().unwrap_or("(unknown)")
    );
    for file in &status.files {
        let state = match (file.staged, file.unstaged) {
            (true, true) => "staged+unstaged",
            (true, false) => "staged",
            _ => "unstaged",
        };
        context.push_str(&format!("- [{}/{}] {}\n", file.kind, state, file.path));
    }
    context.push_str(if staged {
        "\nStaged diff:\n"
    } else {
        "\nWorking tree diff:\n"
    });
    context.push_str(&String::from_utf8_lossy(&diff_output.stdout));
    const MAX_CONTEXT: usize = 24_000;
    if context.len() > MAX_CONTEXT {
        context.truncate(MAX_CONTEXT);
        context.push_str("\n\n…(diff truncated)");
    }

    let prompt = format!(
        "You are writing a git commit message for the changes below.\n\
         Rules:\n\
         - Output ONLY the commit message, with no preamble or markdown fences.\n\
         - First line: imperative subject of at most 72 characters. Use Conventional \
           Commits style when it fits.\n\
         - Optional body after a blank line: explain why, not how.\n\
         - Do not run tools, stage files, or commit.\n\n\
         Changes:\n{context}"
    );
    let harness = registry
        .resolve(harness_id)
        .map_err(|error| EngineError::Other(error.to_string()))?;
    let request = RunRequest {
        prompt,
        model,
        reasoning: None,
        model_options: serde_json::Map::new(),
        cwd: cwd.to_string_lossy().into_owned(),
        sandbox: SandboxLevel::ReadOnly,
        auto_approve: true,
        attachments: Vec::new(),
        resume: None,
        seed: None,
        seed_purpose: None,
        harness: None,
        seed_role: None,
        acp_agent_id: None,
    };
    let (steer_tx, steer_rx) = tokio::sync::mpsc::channel::<SteerMessage>(1);
    let controls = RunControls {
        request_input: Box::new(|_questions: Vec<UserInputQuestion>| {
            let (tx, rx) = tokio::sync::oneshot::channel::<Vec<UserInputAnswer>>();
            let _ = tx.send(Vec::new());
            rx
        }),
        steering: steer_rx,
        interrupt: CancellationToken::new(),
        report_memory: Box::new(|_| {}),
    };
    let mut stream = harness.run(request, controls).await?;
    let mut raw = String::new();
    while let Some(event) = stream.next().await {
        match event? {
            AgentEvent::TextDelta { text } => raw.push_str(&text),
            AgentEvent::Error { message } => {
                return Err(EngineError::Other(format!(
                    "commit message generation failed: {message}"
                )));
            }
            AgentEvent::Done { status, error, .. } => {
                if status != DoneStatus::Completed {
                    return Err(EngineError::Other(format!(
                        "commit message generation ended {status:?}: {}",
                        error.unwrap_or_default()
                    )));
                }
                break;
            }
            _ => {}
        }
    }
    drop(steer_tx);
    parse_commit_message(&raw)
}

fn parse_commit_message(raw: &str) -> Result<GitCommitMessage, EngineError> {
    let mut text = raw.trim();
    if text.starts_with("```") && text.ends_with("```") {
        text = text
            .strip_prefix("```")
            .unwrap_or(text)
            .trim_start_matches(|c: char| c.is_ascii_alphanumeric())
            .trim_start()
            .strip_suffix("```")
            .unwrap_or(text)
            .trim();
    }
    for prefix in ["commit message:", "subject:", "title:"] {
        if text.to_ascii_lowercase().starts_with(prefix) {
            text = text[prefix.len()..].trim_start();
            break;
        }
    }
    let mut lines = text.lines();
    let subject = lines
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(['"', '\''])
        .to_string();
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    if subject.is_empty() {
        return Err(EngineError::Other(
            "Agent returned an empty commit message.".into(),
        ));
    }
    Ok(GitCommitMessage {
        subject,
        body,
        raw: raw.trim().to_string(),
    })
}

fn kind_from_xy(x: char, y: char) -> &'static str {
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return "conflict";
    }
    if x == '?' || y == '?' {
        return "untracked";
    }
    if x == 'R' || y == 'R' {
        return "renamed";
    }
    if x == 'C' || y == 'C' {
        return "copied";
    }
    if x == 'A' || y == 'A' {
        return "added";
    }
    if x == 'D' || y == 'D' {
        return "deleted";
    }
    if x == 'T' || y == 'T' {
        return "typechange";
    }
    if x == 'M' || y == 'M' {
        return "modified";
    }
    "unknown"
}

fn unquote_path(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        let mut out = String::new();
        let mut chars = s[1..s.len() - 1].chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(nc) = chars.next() {
                    match nc {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        other => out.push(other),
                    }
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    s.to_string()
}

pub fn parse_porcelain_line(line: &str) -> Option<GitFileChange> {
    if line.is_empty() || line.starts_with("##") || line.len() < 3 {
        return None;
    }

    let chars: Vec<char> = line.chars().collect();
    let x = chars.get(0).copied().unwrap_or(' ');
    let y = chars.get(1).copied().unwrap_or(' ');
    let rest = &line[3..];

    let (path, old_path) = if let Some(arrow) = rest.find(" -> ")
        && (x == 'R' || x == 'C' || y == 'R' || y == 'C')
    {
        (
            unquote_path(&rest[arrow + 4..]),
            Some(unquote_path(&rest[0..arrow])),
        )
    } else {
        (unquote_path(rest), None)
    };

    if path.is_empty() {
        return None;
    }

    let staged = x != ' ' && x != '?';
    let unstaged = y != ' ' || x == '?';

    Some(GitFileChange {
        path,
        old_path,
        kind: kind_from_xy(x, y).to_string(),
        staged,
        unstaged,
        xy: format!("{}{}", x, y),
    })
}

pub fn parse_branch_header(line: &str) -> (Option<String>, u32, u32) {
    if !line.starts_with("## ") {
        return (None, 0, 0);
    }
    let body = line[3..].trim();
    if body.starts_with("HEAD ") || body == "HEAD (no branch)" {
        return (Some("HEAD".to_string()), 0, 0);
    }
    let no_track = body.split("...").next().unwrap_or(body).trim();
    let branch = no_track.split_whitespace().next().map(|s| s.to_string());

    let mut ahead = 0;
    let mut behind = 0;

    if let Some(start) = body.find('[') {
        if let Some(end) = body[start..].find(']') {
            let inner = &body[start + 1..start + end];

            // "ahead 1, behind 2"
            if let Some(a_idx) = inner.find("ahead ") {
                let rest = &inner[a_idx + 6..];
                let num_str = rest
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .unwrap_or("");
                if let Ok(n) = num_str.parse::<u32>() {
                    ahead = n;
                }
            }
            if let Some(b_idx) = inner.find("behind ") {
                let rest = &inner[b_idx + 7..];
                let num_str = rest
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .unwrap_or("");
                if let Ok(n) = num_str.parse::<u32>() {
                    behind = n;
                }
            }
        }
    }

    (branch, ahead, behind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_branch_header() {
        assert_eq!(
            parse_branch_header("## main...origin/main [ahead 1, behind 2]"),
            (Some("main".to_string()), 1, 2)
        );
        assert_eq!(
            parse_branch_header("## HEAD (no branch)"),
            (Some("HEAD".to_string()), 0, 0)
        );
        assert_eq!(
            parse_branch_header("## master...origin/master [ahead 3]"),
            (Some("master".to_string()), 3, 0)
        );
    }

    #[test]
    fn test_parse_porcelain_line() {
        let f = parse_porcelain_line("M  src/main.rs").unwrap();
        assert_eq!(f.path, "src/main.rs");
        assert_eq!(f.kind, "modified");
        assert!(f.staged);
        assert!(!f.unstaged);
        assert_eq!(f.xy, "M ");

        let f = parse_porcelain_line("?? new_file.txt").unwrap();
        assert_eq!(f.path, "new_file.txt");
        assert_eq!(f.kind, "untracked");
        assert!(!f.staged);
        assert!(f.unstaged);
        assert_eq!(f.xy, "??");

        let f = parse_porcelain_line("R  old.txt -> new.txt").unwrap();
        assert_eq!(f.path, "new.txt");
        assert_eq!(f.old_path, Some("old.txt".to_string()));
        assert_eq!(f.kind, "renamed");
        assert!(f.staged);
        assert!(!f.unstaged);
        assert_eq!(f.xy, "R ");
    }

    #[test]
    fn parses_generated_commit_message() {
        let message = parse_commit_message(
            "```text\nfeat: add git actions\n\nSupport staging and push.\n```",
        )
        .unwrap();
        assert_eq!(message.subject, "feat: add git actions");
        assert_eq!(message.body, "Support staging and push.");

        let message = parse_commit_message("Subject: fix: refresh status").unwrap();
        assert_eq!(message.subject, "fix: refresh status");
        assert!(message.body.is_empty());
    }

    #[tokio::test]
    async fn stage_removes_stale_index_lock_and_retries() {
        let repo = tempfile::tempdir().unwrap();
        let output = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["init"])
            .output()
            .unwrap();
        assert!(output.status.success());

        std::fs::write(repo.path().join("file.txt"), "contents").unwrap();
        std::fs::write(repo.path().join(".git/index.lock"), "").unwrap();

        stage(repo.path(), &["file.txt".to_string()]).await.unwrap();

        assert!(!repo.path().join(".git/index.lock").exists());
        let output = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["diff", "--cached", "--name-only"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "file.txt");
    }
}
