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

/// One `git log` entry — the wire shape for the commit-history view.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    /// Full 40-char object id.
    pub hash: String,
    /// Abbreviated id shown in the list.
    pub short_hash: String,
    pub author: String,
    /// ISO-8601 commit date (`--date=iso-strict`).
    pub date: String,
    /// First line of the commit message.
    pub subject: String,
    /// The commit message body (paragraphs, may be empty).
    pub body: String,
    /// Repository-relative paths the commit touched (`--name-only`).
    pub files: Vec<String>,
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

/// Default number of commits `log` returns when the caller doesn't ask.
pub const GIT_LOG_DEFAULT_COUNT: usize = 50;

/// Fetch recent commit history for the repository rooted at `cwd`.
///
/// Runs `git log -z --name-only` with a `\x1f`-separated pretty format and a
/// `%x00` marker after `%b`: each commit header is NUL-terminated and the
/// `--name-only` paths ride along in their own NUL chunk (`\n`-separated), so
/// every field — including multi-line bodies — survives intact. See
/// [`parse_log_output`].
pub async fn log(cwd: &Path, count: Option<usize>) -> Result<Vec<GitCommitInfo>, EngineError> {
    validate_cwd(cwd)?;
    let count = count.unwrap_or(GIT_LOG_DEFAULT_COUNT).clamp(1, 500);
    let out = Command::new("git")
        .current_dir(cwd)
        .args([
            "log",
            "-z",
            "--date=iso-strict",
            &format!("-n{count}"),
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%b%x00",
            "--name-only",
        ])
        .output()
        .await
        .map_err(|error| EngineError::Other(format!("git log failed to spawn: {error}")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        if msg.to_lowercase().contains("not a git repository") {
            return Ok(Vec::new());
        }
        return Err(EngineError::Other(format!("git log failed: {msg}")));
    }

    Ok(parse_log_output(&out.stdout))
}

/// Parse `git log -z --name-only` output produced by the format in [`log`].
///
/// Layout per commit: `<header>\0<paths>\0`, where `<header>` is the pretty
/// line (`hash, short-hash, author, date, subject, body` joined by `\x1f`,
/// body terminating in a `%x00` marker) and `<paths>` is the `\n`-separated
/// `--name-only` list. Merge commits emit no `<paths>` chunk. Headers are
/// detected by their 40-hex-char first field.
pub fn parse_log_output(bytes: &[u8]) -> Vec<GitCommitInfo> {
    let mut commits = Vec::new();
    let mut pending: Option<GitCommitInfo> = None;
    for chunk in bytes.split(|&b| b == 0) {
        let text = String::from_utf8_lossy(chunk);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut fields = trimmed.split('\x1f');
        let first = fields.next().unwrap_or("");
        let is_header = trimmed.contains('\x1f')
            && first.len() == 40
            && first.bytes().all(|b| b.is_ascii_hexdigit());
        if is_header {
            if let Some(commit) = pending.take() {
                commits.push(commit);
            }
            let mut iter = trimmed.split('\x1f');
            let _ = iter.next(); // full hash (already captured)
            pending = Some(GitCommitInfo {
                hash: first.to_string(),
                short_hash: iter.next().unwrap_or("").to_string(),
                author: iter.next().unwrap_or("").to_string(),
                date: iter.next().unwrap_or("").to_string(),
                subject: iter.next().unwrap_or("").to_string(),
                body: iter.collect::<Vec<_>>().join("\n"),
                files: Vec::new(),
            });
        } else if let Some(commit) = pending.as_mut() {
            // `<paths>` chunk: git separates the message from `--name-only`
            // paths with a blank line, so it starts with `\n` — strip and
            // split the remaining newline-separated paths.
            for line in trimmed.lines() {
                if !line.is_empty() {
                    commit.files.push(line.to_string());
                }
            }
        }
    }
    if let Some(commit) = pending {
        commits.push(commit);
    }
    commits
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

/// The outcome of a `git pull`: a human-readable summary plus, when the merge
/// stopped on conflicts, the paths Git could not merge. The UI keys its
/// conflict-resolution modal off `conflicted`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub summary: String,
    pub conflicted: bool,
    pub conflicts: Vec<String>,
}

/// `git pull --no-rebase`: fetches and merges the upstream branch. When the
/// merge halts on conflicts the command exits non-zero, but the working tree
/// is left mid-merge with `UU`/`AA`/`DD` index entries — we surface those as
/// `conflicts` so the UI can offer AI-assisted resolution instead of treating
/// it as a hard failure.
pub async fn pull(cwd: &Path) -> Result<PullResult, EngineError> {
    validate_cwd(cwd)?;

    let out = Command::new("git")
        .current_dir(cwd)
        .args(&["pull", "--no-rebase", "--progress"])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git pull failed to spawn: {}", e)))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    // A non-zero exit mid-merge means conflicts (or an aborted merge). The
    // authoritative source of conflict paths is the porcelain status, not the
    // command's stderr — so re-snapshot and collect unmerged entries.
    let conflicts = if out.status.success() {
        Vec::new()
    } else {
        conflicted_paths(cwd).await?
    };

    let conflicted = !conflicts.is_empty();
    let mut summary = if conflicted {
        "Merge conflicts — resolve to continue.".to_string()
    } else if out.status.success() {
        summarize_git_remote_output(&stdout, &stderr)
    } else {
        let msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(EngineError::Other(format!("git pull failed: {}", msg)));
    };
    if !conflicted && summary.is_empty() {
        summary = "Pull complete.".to_string();
    }

    Ok(PullResult {
        summary,
        conflicted,
        conflicts,
    })
}

/// Collect repository-relative paths with unmerged index entries
/// (`U`/`A`/`D` in both columns), i.e. the files Git flags as conflicted.
async fn conflicted_paths(cwd: &Path) -> Result<Vec<String>, EngineError> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(&["diff", "--name-only", "--diff-filter=U"])
        .output()
        .await
        .map_err(|e| EngineError::Other(format!("git diff failed to spawn: {}", e)))?;
    if !out.status.success() {
        // Status introspection failing shouldn't mask the original pull error;
        // report no conflicts and let the caller surface the failure.
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
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
    acp_agent_id: Option<&str>,
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
        acp_agent_id: acp_agent_id.map(|id| id.to_string()),
        custom_provider: None,
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

/// The outcome of an AI-assisted conflict resolution: the resolved file's
/// path and a short status note the pane surfaces in its info banner.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictResult {
    pub path: String,
    pub resolved: bool,
    pub summary: String,
}

/// Resolve a merge conflict in `path` by handing the conflicted file to a
/// harness agent (with workspace-write + auto-approve) that edits the file in
/// place to drop the `<<<<<<<`/`=======`/`>>>>>>>` markers, then stages it.
///
/// Reuses the same harness-run plumbing as [`generate_commit_message`] but at
/// `WorkspaceWrite` so the agent can actually rewrite the file. If the agent
/// leaves markers behind (a half-resolution), the file is not staged and the
/// caller is told resolution is incomplete.
pub async fn resolve_conflict(
    registry: &HarnessRegistry,
    cwd: &Path,
    path: &str,
    harness_id: HarnessId,
    model: Option<String>,
    acp_agent_id: Option<&str>,
) -> Result<ResolveConflictResult, EngineError> {
    validate_cwd(cwd)?;
    validate_paths(&[path.to_string()])?;

    // Confirm the file is actually conflicted before spinning up an agent —
    // avoids a confusing no-op (or an agent rewrite) on a clean path.
    let conflicts = conflicted_paths(cwd).await?;
    if !conflicts.iter().any(|c| c == path) {
        return Ok(ResolveConflictResult {
            path: path.to_string(),
            resolved: true,
            summary: format!("{path} is not conflicted."),
        });
    }

    let prompt = format!(
        "The file `{path}` has unresolved git merge conflicts (lines bracketed by \
         `<<<<<<<`, `=======`, and `>>>>>>>`). Resolve them: keep the correct \
         changes from both sides, remove every conflict marker, and preserve the \
         file's intent and formatting. Edit the file in place. Do not run git, \
         commit, or touch any other file. Output only a one-line summary of what \
         you changed."
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
        sandbox: SandboxLevel::WorkspaceWrite,
        auto_approve: true,
        attachments: Vec::new(),
        resume: None,
        seed: None,
        seed_purpose: None,
        harness: None,
        seed_role: None,
        acp_agent_id: acp_agent_id.map(|id| id.to_string()),
        custom_provider: None,
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
    let mut summary = String::new();
    while let Some(event) = stream.next().await {
        match event? {
            AgentEvent::TextDelta { text } => summary.push_str(&text),
            AgentEvent::Error { message } => {
                return Err(EngineError::Other(format!(
                    "conflict resolution failed: {message}"
                )));
            }
            AgentEvent::Done { status, error, .. } => {
                if status != DoneStatus::Completed {
                    return Err(EngineError::Other(format!(
                        "conflict resolution ended {status:?}: {}",
                        error.unwrap_or_default()
                    )));
                }
                break;
            }
            _ => {}
        }
    }
    drop(steer_tx);

    let summary = summary.trim().to_string();
    // Stage only if the agent actually cleared the markers; otherwise leave
    // the conflict for the user and report it as unresolved.
    let remaining = conflicted_paths(cwd).await?;
    let resolved = !remaining.iter().any(|c| c == path);
    if resolved {
        // `git add` finalizes the resolution; a failure here is non-fatal —
        // the file is already fixed on disk, the user can stage manually.
        let _ = stage(cwd, &[path.to_string()]).await;
    }
    Ok(ResolveConflictResult {
        path: path.to_string(),
        resolved,
        summary: if resolved {
            if summary.is_empty() {
                format!("Resolved {path}.")
            } else {
                summary
            }
        } else {
            format!("{path} still has unresolved markers — review and retry.")
        },
    })
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

    /// A real `git log -z --name-only` stream (see [`log`]'s format): each
    /// commit header (fields joined by `\x1f`, body terminated by a `%x00`
    /// marker) is NUL-delimited, then a `\n`-led chunk carries the touched
    /// paths. A merge commit emits no path chunk — the next header follows
    /// directly.
    #[test]
    fn parses_log_output() {
        let full = "a".repeat(40);
        let short = "aaaaaaa";
        let bytes = format!(
            "{full}\x1f{short}\x1fAlice\x1f2026-08-15T14:15:43+07:00\x1ffix(ui): keep commit description scrolling inside its box\x1f\
             First paragraph.\nSecond line.\n\x00\nsrc/main.rs\nsrc/lib.rs\x00\x00\
             {full}\x1f{short}\x1fBob\x1f2026-08-14T09:00:00+07:00\x1fmerge: feature branch\x1f\x00\x00"
        );
        let commits = parse_log_output(bytes.as_bytes());
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, full);
        assert_eq!(commits[0].short_hash, short);
        assert_eq!(commits[0].author, "Alice");
        assert_eq!(commits[0].subject, "fix(ui): keep commit description scrolling inside its box");
        assert_eq!(commits[0].body, "First paragraph.\nSecond line.");
        assert_eq!(commits[0].files, vec!["src/main.rs", "src/lib.rs"]);
        // Merge commit: no path chunk, next header directly after the NULs.
        assert_eq!(commits[1].author, "Bob");
        assert_eq!(commits[1].subject, "merge: feature branch");
        assert!(commits[1].files.is_empty());
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

    /// `log` against a real temp repository: two commits, one with a
    /// multi-line body, must come back in newest-first order with their
    /// touched paths attached.
    #[tokio::test]
    async fn log_lists_commits_in_order() {
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .current_dir(repo.path())
                .args(args)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);

        std::fs::write(repo.path().join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "first commit"]);
        std::fs::write(repo.path().join("b.txt"), "two\n").unwrap();
        git(&["add", "b.txt"]);
        git(&["commit", "-q", "-m", "second\n\nwith a body"]);

        let commits = log(repo.path(), Some(10)).await.unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second");
        assert_eq!(commits[0].body, "with a body");
        assert_eq!(commits[0].files, vec!["b.txt".to_string()]);
        assert_eq!(commits[1].subject, "first commit");
        assert_eq!(commits[1].files, vec!["a.txt".to_string()]);
        assert_eq!(commits[0].hash.len(), 40);
        assert!(!commits[0].date.is_empty());
    }

    /// A real two-branch merge that touches the same line produces a `UU`
    /// index entry. `conflicted_paths` must surface exactly that file — this
    /// is the signal the UI uses to open the conflict-resolution modal after a
    /// conflicting pull.
    #[tokio::test]
    async fn conflicted_paths_lists_unmerged_files() {
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .current_dir(repo.path())
                .args(args)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);

        std::fs::write(repo.path().join("file.txt"), "base\n").unwrap();
        git(&["add", "file.txt"]);
        git(&["commit", "-q", "-m", "base"]);

        // Diverge: change the same line differently on two branches.
        git(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.path().join("file.txt"), "feature\n").unwrap();
        git(&["commit", "-q", "-am", "feature"]);

        // The default branch is `master` on older git and `main` on newer —
        // return to whichever exists.
        let default_branch = if git(&["rev-parse", "-q", "--verify", "master"]).status.success() {
            "master"
        } else {
            "main"
        };
        git(&["checkout", "-q", default_branch]);
        std::fs::write(repo.path().join("file.txt"), "trunk\n").unwrap();
        git(&["commit", "-q", "-am", "trunk"]);
        // Merge feature onto the base branch — conflicts on file.txt.
        let merge = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["merge", "-q", "--no-ff", "feature"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "merge should have conflicted");

        let conflicts = conflicted_paths(repo.path()).await.unwrap();
        assert_eq!(conflicts, vec!["file.txt".to_string()]);
    }
}
