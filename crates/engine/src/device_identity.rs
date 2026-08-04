//! Stable per-installation device identity.
//!
//! Two layers of defense against losing the device id:
//!
//! **Multi-location persistence** - the `device-id` file in the data dir is the
//! primary copy, but the id is also written to an OS-level backup location so
//! that deleting the cache directory does not orphan the workspace. The backup
//! locations are:
//! - Windows: `%APPDATA%\comet\device-id`
//! - macOS:   `~/Library/Application Support/comet/device-id`
//! - Linux:   `$XDG_CONFIG_HOME/comet/device-id` (default `~/.config/`)
//!
//! **Machine fingerprint** - a stable hash of the OS-provided machine UUID,
//! used as a secondary identity in the workspace device registry. When a device
//! row arrives with the same fingerprint as the running device but a different
//! id (the inevitable result of cache loss), the engine merges the stale
//! registration into the current one - no matter the app version.
//!
//! OS machine UUID sources:
//! - Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`
//! - macOS:   `IOPlatformUUID` (`ioreg`)
//! - Linux:   `/etc/machine-id` or `/var/lib/dbus/machine-id`

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::EngineError;

// -- public API --

/// Load the device id from the primary file, falling back to the OS-level
/// backup. If neither exists, mint a new UUID, persist it to both locations.
pub fn load_or_create_device_id(data_dir: &Path) -> Result<String, EngineError> {
    let primary = data_dir.join("device-id");

    // 1. Primary file.
    if let Some(id) = read_non_empty(&primary)? {
        return Ok(id);
    }

    // 2. OS-level backup.
    if let Some(backup_path) = backup_path()
        && let Some(id) = read_non_empty(&backup_path)?
    {
        // Restore the primary from backup.
        std::fs::create_dir_all(data_dir)?;
        std::fs::write(&primary, &id)?;
        return Ok(id);
    }

    // 3. Mint a fresh id and persist everywhere.
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(&primary, &id)?;
    write_backup(&id);

    Ok(id)
}

/// Stable machine fingerprint derived from the OS-provided machine UUID, or
/// `None` if no source is available. The fingerprint is a truncated SHA-256
/// (16 hex chars) of the raw UUID string - short enough for a workspace doc
/// field, long enough to avoid collisions in any realistic fleet.
pub fn machine_fingerprint() -> Option<String> {
    let uuid = platform_machine_uuid()?;
    let mut hasher = Sha256::new();
    hasher.update(uuid.as_bytes());
    let hash = hasher.finalize();
    let hex = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Some(hex[..16].to_string())
}

// -- file helpers --

/// Read and trim a file, returning `None` for missing/empty.
fn read_non_empty(path: &Path) -> Result<Option<String>, EngineError> {
    match std::fs::read_to_string(path) {
        Ok(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// -- OS-level backup persistence --

/// Best-effort write of the device id to the OS-level backup location.
/// Failures are logged but never propagated: the primary file is the source of
/// truth, and the backup is strictly opportunistic.
fn write_backup(id: &str) {
    let Some(path) = backup_path() else {
        return;
    };
    if let Err(err) = std::fs::create_dir_all(path.parent().unwrap_or(Path::new("")))
        .and_then(|_| std::fs::write(&path, id))
    {
        tracing::warn!(error = %err, "device-id backup write failed (non-fatal)");
    }
}

/// The OS-level backup path for the device id, or `None` if the platform does
/// not have a known config directory.
fn backup_path() -> Option<PathBuf> {
    cfg_if::cfg_if! {
        if #[cfg(target_os = "windows")] {
            std::env::var("APPDATA").ok()
                .map(|base| PathBuf::from(base).join("comet").join("device-id"))
        } else if #[cfg(target_os = "macos")] {
            std::env::var("HOME").ok().map(|home| {
                PathBuf::from(home)
                    .join("Library/Application Support/comet/device-id")
            })
        } else if #[cfg(target_os = "linux")] {
            let base = std::env::var("XDG_CONFIG_HOME")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.config")))?;
            Some(PathBuf::from(base).join("comet").join("device-id"))
        } else {
            None
        }
    }
}

// -- platform machine UUID --

/// Best-effort retrieval of the OS-provided machine UUID.
#[allow(unused_variables)]
fn platform_machine_uuid() -> Option<String> {
    cfg_if::cfg_if! {
        if #[cfg(target_os = "windows")] {
            windows_machine_guid()
        } else if #[cfg(target_os = "macos")] {
            macos_platform_uuid()
        } else if #[cfg(target_os = "linux")] {
            linux_machine_id()
        } else {
            None
        }
    }
}

// -- Windows --

#[cfg(target_os = "windows")]
fn windows_machine_guid() -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            hkey: *const std::ffi::c_void,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            type_ptr: *mut u32,
            data: *mut u8,
            data_len: *mut u32,
        ) -> i32;
    }

    const HKEY_LOCAL_MACHINE: usize = 0x80000002;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;

    let sub_key: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let value: Vec<u16> = "MachineGuid".encode_utf16().chain(std::iter::once(0)).collect();

    let mut buf = [0u8; 256];
    let mut buf_len: u32 = buf.len() as u32;
    let mut buf_type: u32 = 0;

    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE as *const _,
            sub_key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            &mut buf_type,
            buf.as_mut_ptr(),
            &mut buf_len,
        )
    };

    if result != 0 {
        return None;
    }

    // buf_len includes the trailing NUL in bytes.
    let utf16: Vec<u16> = buf[..buf_len as usize / 2]
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .take_while(|&c| c != 0)
        .collect();

    OsString::from_wide(&utf16)
        .to_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(not(target_os = "windows"))]
fn windows_machine_guid() -> Option<String> {
    None
}

// -- macOS --

#[cfg(target_os = "macos")]
fn macos_platform_uuid() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-d2", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            // Extract the quoted value after the '=' sign.
            if let Some(eq_pos) = line.rfind('=') {
                let rest = &line[eq_pos + 1..];
                if let Some(start) = rest.find('"') {
                    let after_start = &rest[start + 1..];
                    if let Some(end) = after_start.find('"') {
                        let uuid = after_start[..end].trim();
                        if !uuid.is_empty() {
                            return Some(uuid.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn macos_platform_uuid() -> Option<String> {
    None
}

// -- Linux --

#[cfg(target_os = "linux")]
fn linux_machine_id() -> Option<String> {
    for path in &["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(id) = std::fs::read_to_string(path) {
            let id = id.trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn linux_machine_id() -> Option<String> {
    None
}

// -- tests --

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_format() {
        if let Some(fp) = machine_fingerprint() {
            assert_eq!(fp.len(), 16, "fingerprint should be 16 hex chars");
            assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn load_or_create_persists_and_reuses() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = load_or_create_device_id(dir.path()).unwrap();
        assert!(!id1.is_empty());

        // Second call on the same dir should return the same id.
        let id2 = load_or_create_device_id(dir.path()).unwrap();
        assert_eq!(id1, id2);

        // The primary file should exist.
        let primary = dir.path().join("device-id");
        assert!(primary.exists());
        assert_eq!(std::fs::read_to_string(&primary).unwrap().trim(), id1);
    }

    #[test]
    fn load_recovers_from_backup_when_primary_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = load_or_create_device_id(dir.path()).unwrap();

        // Simulate cache directory deletion.
        let primary = dir.path().join("device-id");
        std::fs::remove_file(&primary).unwrap();

        // If the OS backup exists and matches, the id should be recovered.
        if let Some(backup) = backup_path()
            && backup.exists()
            && std::fs::read_to_string(&backup).unwrap().trim() == id1
        {
            let id2 = load_or_create_device_id(dir.path()).unwrap();
            assert_eq!(id1, id2);
            assert!(primary.exists(), "primary should be restored from backup");
        }
        // If no backup path exists on this platform, this test is a no-op.
    }
}