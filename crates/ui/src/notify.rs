//! OS-level desktop notifications — the same zero-deps approach as [`sound`]:
//! shell out to the platform's native notifier on a background thread.
//!
//! - macOS: prefers `terminal-notifier` (registers as a real app, so the
//!   notification banner surfaces even when the host process lacks
//!   "Allow Notifications" in System Settings). Falls back to
//!   `osascript display notification` if `terminal-notifier` isn't on `$PATH`.
//! - Linux: `notify-send` (freedesktop.org); falls back silently if absent
//! - Windows: WinRT toast via `Windows.UI.Notifications` through PowerShell.
//!   No third-party module needed — uses the built-in Windows Runtime that
//!   ships with Windows 10+, so it works on every stock install.
//!
//! `COMET_DISABLE_NOTIFICATIONS` env kill-switch mirrors `COMET_DISABLE_SOUND`.
//! Failures are logged and swallowed — a missing notifier must never disturb
//! the session flow.

use std::process::Stdio;

const DISABLE_ENV: &str = "COMET_DISABLE_NOTIFICATIONS";

/// Which event triggered the notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    /// A run finished (Working → Idle).
    Done,
    /// The agent is waiting on a question (→ AwaitingInput).
    Request,
}

impl NotificationKind {
    fn title(self) -> &'static str {
        match self {
            NotificationKind::Done => "Comet — task complete",
            NotificationKind::Request => "Comet — input needed",
        }
    }

    fn body(self) -> &'static str {
        match self {
            NotificationKind::Done => "The agent finished its work.",
            NotificationKind::Request => "The agent is waiting for your response.",
        }
    }
}

/// Fire a desktop notification on a background thread. Silently a no-op when
/// disabled by env or no notifier is available.
pub fn show(kind: NotificationKind) {
    if std::env::var_os(DISABLE_ENV).is_some() {
        return;
    }
    std::thread::spawn(move || {
        if let Err(err) = dispatch(kind) {
            tracing::debug!(?kind, error = %err, "desktop notification failed");
        }
    });
}

#[cfg(target_os = "macos")]
fn dispatch(kind: NotificationKind) -> Result<(), String> {
    let title = kind.title();
    let body = kind.body();
    let sound = match kind {
        NotificationKind::Done => "Glass",
        NotificationKind::Request => "Ping",
    };
    // Prefer terminal-notifier: it registers as a standalone app, so macOS
    // surfaces the banner even when the host process hasn't been granted
    // "Allow Notifications" in System Settings. osascript's `display
    // notification` routes through Script Editor (or the host bundle id) and
    // is silently suppressed for unsigned processes.
    if std::process::Command::new("terminal-notifier")
        .arg("-title")
        .arg(title)
        .arg("-message")
        .arg(body)
        .arg("-sound")
        .arg(sound)
        .arg("-ignoreDnD")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
    {
        return Ok(());
    }
    // Fallback: osascript display notification. Works when the host app
    // already has notification permission; silent otherwise.
    let script = format!(
        "display notification {body_q} with title {title_q} sound name {sound_q}",
        body_q = apple_script_quote(body),
        title_q = apple_script_quote(title),
        sound_q = apple_script_quote(sound),
    );
    let output = std::process::Command::new("osascript")
        .args(["-e", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "osascript exited with {}{}",
            output.status,
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr.trim())
            }
        ))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn dispatch(kind: NotificationKind) -> Result<(), String> {
    let title = kind.title();
    let body = kind.body();
    // `notify-send` is the freedesktop standard (libnotify). Absent on minimal
    // WM setups — the error is logged at debug and swallowed.
    let icon = match kind {
        NotificationKind::Done => "dialog-information",
        NotificationKind::Request => "dialog-question",
    };
    let status = std::process::Command::new("notify-send")
        .args(["--icon", icon, "--", title, body])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("notify-send failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("notify-send exited with {status}"))
    }
}

#[cfg(windows)]
fn dispatch(kind: NotificationKind) -> Result<(), String> {
    // WinRT toast via the built-in Windows.UI.Notifications namespace — no
    // third-party PowerShell module (BurntToast) required. Uses the AUMID of
    // Windows PowerShell ({1AC14E77-...}\WindowsPowerShell\v1.0\powershell.exe),
    // which is always registered on Windows 10+, so the toast surfaces in
    // Action Center without the host app needing its own shortcut/AUMID.
    //
    // The script is passed via -EncodedCommand (Base64 UTF-16LE) to avoid
    // quoting issues with embedded XML, single-quotes, and braces.
    let title = kind.title();
    let body = kind.body();
    // Escape for XML text content: ampersand, angle brackets.
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let xml = format!(
        "<toast><visual><binding template=\"ToastText02\">\
         <text id=\"1\">{}</text>\
         <text id=\"2\">{}</text>\
         </binding></visual></toast>",
        esc(title),
        esc(body),
    );
    let script = format!(
        "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; \
         [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]; \
         $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; \
         $xml.LoadXml('{xml_escaped}'); \
         $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); \
         [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{{1AC14E77-02E7-4E5C-B744-2EC4F3E11E6C}}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
        xml_escaped = xml.replace('\'', "''"),
    );
    let encoded = encode_powerhell(&script)?;
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("powershell failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "powershell exited with {}{}",
            output.status,
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr.trim())
            }
        ))
    }
}

/// Encode a PowerShell script as Base64 UTF-16LE for -EncodedCommand.
#[cfg(windows)]
fn encode_powerhell(script: &str) -> Result<String, String> {
    use base64::{engine::general_purpose, Engine as _};
    let utf16: Vec<u16> = script.encode_utf16().collect();
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(utf16.as_ptr() as *const u8, utf16.len() * 2) };
    Ok(general_purpose::STANDARD.encode(bytes))
}

/// Quote a string for an AppleScript string literal (double-quoted, with
/// embedded quotes escaped by doubling).
#[cfg(target_os = "macos")]
fn apple_script_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_titles_and_bodies_are_nonempty() {
        for kind in [NotificationKind::Done, NotificationKind::Request] {
            assert!(!kind.title().is_empty());
            assert!(!kind.body().is_empty());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn apple_script_quote_escapes_double_quotes() {
        assert_eq!(apple_script_quote("hi"), "\"hi\"");
        assert_eq!(apple_script_quote("say \"hi\""), "\"say \"\"hi\"\"\"");
    }
}
