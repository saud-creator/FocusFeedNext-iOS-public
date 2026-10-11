//! Release storage policy.
//!
//! A portable release must not quietly create a second installation under
//! `%APPDATA%` or `%LOCALAPPDATA%`. The release build therefore keeps its
//! private browser profile in the per-run directory created by `ephemeral.rs`.
//! Fetched content is held in the in-memory database; durable metadata
//! (preferences, identity and local list definitions) remains in the portable
//! root so it survives a restart. The root is next to the executable when that
//! location is writable, and the session/profile portion falls back to the
//! system temp directory on read-only media.
//!
//! Debug builds retain the normal per-user preferences store so development
//! runs do not unexpectedly discard a developer's settings. `FFN_PORTABLE=1`
//! and `FFN_PORTABLE=0` are explicit overrides for testing either mode.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const APP_NAME: &str = "FocusFeedNext";
const PORTABLE_DIR: &str = ".focusfeed-next";
const CLEANUP_ARGUMENT: &str = "--cleanup-session";
const WEBVIEW_LOCK_FILE: &str = "session.lock";
// WebView2 can keep its profile lock alive well after the UI process has
// exited. Keep the invisible same-EXE cleanup child around long enough to
// cover that shutdown window without leaving a helper file behind.
const DEFERRED_CLEANUP_ATTEMPTS: usize = 1_200;
const DEFERRED_CLEANUP_DELAY: std::time::Duration = std::time::Duration::from_millis(100);
const DEFERRED_CLEANUP_INITIAL_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether this process should use the portable release storage policy.
pub fn is_portable() -> bool {
    // An iOS app is already sandboxed and has no meaningful "beside the EXE"
    // writable location.  Use its Application Support/Cache containers so the
    // paired token and user preferences survive an ordinary app restart.
    if cfg!(mobile) {
        return false;
    }
    match env::var("FFN_PORTABLE") {
        Ok(value)
            if matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no"
            ) =>
        {
            false
        }
        Ok(value)
            if matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            ) =>
        {
            true
        }
        _ => !cfg!(debug_assertions),
    }
}

/// The directory containing the running executable, when it can be resolved.
pub fn executable_dir() -> Option<PathBuf> {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
}

/// The portable root. It is deliberately hidden. A normal close removes empty
/// per-run parents, but leaves this root when the durable preferences database
/// or account-scoped List definitions exist.
pub fn portable_root() -> PathBuf {
    executable_dir()
        .map(|dir| dir.join(PORTABLE_DIR))
        .unwrap_or_else(|| env::temp_dir().join(APP_NAME))
}

/// The compatibility path used only by debug/non-portable runs.
pub fn legacy_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_NAME)
}

/// The path exposed by the backend's data-directory diagnostic command.
pub fn data_dir() -> PathBuf {
    if is_portable() {
        portable_root()
    } else {
        legacy_data_dir()
    }
}

/// Candidate session roots, ordered from the location the user asked for to a
/// safe fallback. The caller tries each candidate without ever switching to
/// AppData in portable mode.
pub fn session_roots() -> Vec<PathBuf> {
    let primary = if is_portable() {
        portable_root().join("sessions")
    } else {
        dirs::cache_dir()
            .or_else(dirs::data_local_dir)
            .unwrap_or_else(env::temp_dir)
            .join(APP_NAME)
            .join("sessions")
    };

    let fallback = env::temp_dir().join(APP_NAME).join("sessions");
    if primary == fallback {
        vec![primary]
    } else {
        vec![primary, fallback]
    }
}

/// Create a WebView-only fallback directory if the in-memory session's
/// filesystem directory could not
/// be created. This is still cleaned by `AppState::shutdown`; it exists only
/// so a read-only portable folder does not make the WebView silently fall back
/// to its default AppData profile.
pub fn fallback_webview_dir() -> Option<PathBuf> {
    let root = env::temp_dir().join(APP_NAME).join("webview");
    fs::create_dir_all(&root).ok()?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for attempt in 0..100u32 {
        let dir = root.join(format!("run-{}-{stamp}-{attempt}", std::process::id()));
        match fs::create_dir(&dir) {
            Ok(()) => return Some(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// Remove crashed fallback WebView profiles without touching a live sibling.
/// Each fallback directory owns a lock held by `AppState`; on Windows the
/// lock cannot be removed while that process is alive. If WebView2 is still
/// unwinding after the lock is released, restore the marker and let a later
/// startup/deferred cleanup retry it.
pub fn purge_stale_webviews() -> usize {
    let root = env::temp_dir().join(APP_NAME).join("webview");
    let Ok(entries) = fs::read_dir(&root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !path.is_dir() || !name.starts_with("run-") {
            continue;
        }
        let lock = path.join(WEBVIEW_LOCK_FILE);
        if !lock.exists() || fs::remove_file(&lock).is_err() {
            continue;
        }
        if fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        } else {
            let _ = fs::File::create(lock);
        }
    }
    if removed > 0 {
        let _ = fs::remove_dir(&root);
        if let Some(parent) = root.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
    removed
}

/// Run the invisible cleanup mode when this EXE was launched by a previous
/// process whose WebView2 child still had a profile file open. Returning true
/// means `main` must exit instead of starting the UI.
pub fn run_deferred_cleanup() -> Option<i32> {
    let mut args = env::args_os();
    let _ = args.next();
    let argument = args.next()?;
    if argument != std::ffi::OsStr::new(CLEANUP_ARGUMENT) {
        return None;
    }

    let Some(path) = args.next().map(PathBuf::from) else {
        return Some(2);
    };
    if args.next().is_some() {
        return Some(3);
    }
    if !is_safe_cleanup_dir(&path) {
        return Some(4);
    }
    // The parent process may have just removed the directory while WebView2
    // is still rebuilding its profile. Wait through that transient gap before
    // treating a missing target as a completed cleanup.
    std::thread::sleep(DEFERRED_CLEANUP_INITIAL_DELAY);
    Some(if cleanup_directory(&path) { 0 } else { 5 })
}

/// Ask the same single EXE to retry a cleanup after the WebView2 host has
/// released its profile. No helper file is written. The target is validated
/// before spawning and again by the child, so an arbitrary command-line path
/// can never turn this into a general-purpose delete operation.
pub fn schedule_deferred_cleanup(path: &Path) -> bool {
    if !is_safe_cleanup_dir(path) {
        return false;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        let Ok(executable) = env::current_exe() else {
            return false;
        };
        std::process::Command::new(executable)
            .arg(CLEANUP_ARGUMENT)
            .arg(path)
            .creation_flags(0x0800_0000)
            .spawn()
            .is_ok()
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn is_safe_cleanup_dir(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    let allowed_session_roots = [
        portable_root().join("sessions"),
        env::temp_dir().join(APP_NAME).join("sessions"),
    ];
    let is_session = name.starts_with("s-")
        && allowed_session_roots
            .iter()
            .any(|candidate| same_path(candidate, parent));
    let webview_root = env::temp_dir().join(APP_NAME).join("webview");
    let is_fallback_webview = name.starts_with("run-") && same_path(&webview_root, parent);
    is_session || is_fallback_webview
}

fn same_path(left: &Path, right: &Path) -> bool {
    left == right
        || fs::canonicalize(left)
            .ok()
            .zip(fs::canonicalize(right).ok())
            .is_some_and(|(left, right)| left == right)
}

fn cleanup_directory(path: &Path) -> bool {
    let mut removed = false;
    for attempt in 0..DEFERRED_CLEANUP_ATTEMPTS {
        match fs::remove_dir_all(path) {
            Ok(()) if !path.exists() => {
                removed = true;
                break;
            }
            Ok(()) if attempt + 1 < DEFERRED_CLEANUP_ATTEMPTS => {
                std::thread::sleep(DEFERRED_CLEANUP_DELAY);
            }
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !path.exists() => {
                removed = true;
                break;
            }
            Err(error)
                if attempt + 1 < DEFERRED_CLEANUP_ATTEMPTS
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::WouldBlock
                    ) =>
            {
                std::thread::sleep(DEFERRED_CLEANUP_DELAY);
            }
            Err(_) => break,
        }
    }

    if removed {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent);
            if matches!(
                parent.file_name().and_then(|value| value.to_str()),
                Some("sessions") | Some("webview")
            ) {
                if let Some(grandparent) = parent.parent() {
                    let _ = fs::remove_dir(grandparent);
                }
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_roots_always_have_a_temp_fallback() {
        let roots = session_roots();
        assert!(!roots.is_empty());
        assert!(roots.iter().any(|root| root.starts_with(env::temp_dir())));
    }

    #[test]
    fn portable_root_is_not_the_legacy_data_dir() {
        assert_ne!(portable_root(), legacy_data_dir());
    }

    #[test]
    fn deferred_cleanup_accepts_only_its_own_run_directories() {
        let session_root = portable_root().join("sessions");
        assert!(is_safe_cleanup_dir(&session_root.join("s-test")));
        assert!(!is_safe_cleanup_dir(
            &session_root.join("nested").join("s-test")
        ));
        assert!(!is_safe_cleanup_dir(&legacy_data_dir().join("s-test")));
    }
}
