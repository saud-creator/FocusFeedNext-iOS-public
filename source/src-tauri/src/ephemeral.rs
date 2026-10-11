//! Ephemeral session storage.
//!
//! Fetched X content is **not** durable data. The database is held in memory
//! for the run, while this per-run directory exists only for the lock and the
//! WebView2 profile. It is deleted when the process exits, so closing Focus
//! Feed Next leaves no posts, avatars, media or thumbnails behind.
//!
//! In a normal debug run, metadata may use the compatibility store. In a
//! portable release, the small metadata store remains beside the executable;
//! fetched content is memory-only and the browser profile is per-run scoped.
//! Credentials are separate and live in Windows Credential Manager.
//!
//! ## Detecting an abandoned session after a crash
//!
//! A crashed run cannot clean up after itself, so the next startup has to do
//! it — but it must not delete the directory of a *second copy of the app that
//! is running right now*.
//!
//! We hold an open handle on `session.lock` for the whole process lifetime.
//! Windows refuses to delete a file that another process has open without
//! `FILE_SHARE_DELETE`, which we do not request. So the test "can I delete this
//! lock file?" answers "is that session dead?" exactly, with no process
//! enumeration and no dependency. On non-Windows platforms the delete would
//! succeed regardless, so the age guard below is the fallback; this app ships
//! for Windows only.

use crate::models::{AppError, AppResult, ErrorCode};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const LOCK_FILE: &str = "session.lock";

/// A session directory older than this is treated as abandoned even if its
/// lock file cannot be removed, so a permissions oddity can never leak storage
/// forever.
const MAX_SESSION_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const CLEANUP_ATTEMPTS: usize = 40;
const CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Candidate roots that hold every per-run directory.
pub fn session_roots() -> Vec<PathBuf> {
    crate::portable::session_roots()
}

/// The preferred root that holds every per-run directory.
pub fn sessions_root() -> PathBuf {
    session_roots()
        .into_iter()
        .next()
        .unwrap_or_else(|| std::env::temp_dir().join("FocusFeedNext").join("sessions"))
}

/// One run's throwaway storage.
pub struct EphemeralSession {
    root: PathBuf,
    dir: PathBuf,
    /// Held open for the process lifetime; see the module docs.
    lock: Option<File>,
    cleaned: bool,
    deferred_cleanup_scheduled: bool,
}

impl EphemeralSession {
    /// Create a fresh session directory under `root`.
    pub fn create_in(root: &Path) -> AppResult<Self> {
        fs::create_dir_all(root).map_err(|e| {
            AppError::new(
                ErrorCode::DatabaseError,
                format!("could not create session root: {e}"),
            )
        })?;

        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let dir = root.join(format!("s-{}-{}", std::process::id(), stamp));
        if let Err(e) = fs::create_dir_all(&dir) {
            let _ = fs::remove_dir_all(&dir);
            return Err(AppError::new(
                ErrorCode::DatabaseError,
                format!("could not create session directory: {e}"),
            ));
        }

        let lock = match File::create(dir.join(LOCK_FILE)) {
            Ok(lock) => lock,
            Err(e) => {
                let _ = fs::remove_dir_all(&dir);
                return Err(AppError::new(
                    ErrorCode::DatabaseError,
                    format!("could not lock session directory: {e}"),
                ));
            }
        };

        Ok(Self {
            root: root.to_path_buf(),
            dir,
            lock: Some(lock),
            cleaned: false,
            deferred_cleanup_scheduled: false,
        })
    }

    /// Create a session under the default root.
    pub fn create() -> AppResult<Self> {
        let mut last_error = None;
        for root in session_roots() {
            match Self::create_in(&root) {
                Ok(session) => return Ok(session),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| {
            AppError::new(
                ErrorCode::DatabaseError,
                "no writable session root was available",
            )
        }))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Total bytes currently held by this session directory. The content
    /// database is not included because it is intentionally in memory; the
    /// measured bytes are the lock and the per-run WebView2 profile.
    pub fn size_bytes(&self) -> u64 {
        dir_size(&self.dir)
    }

    /// Release the lock and delete everything this session wrote.
    ///
    /// Best-effort by design: this removes the files and the directory, which
    /// is all a userspace process can honestly promise. It does **not** and
    /// cannot guarantee the blocks are unrecoverable on an SSD, where wear
    /// levelling and the FTL keep copies out of the operating system's reach.
    pub fn cleanup(&mut self) -> CleanupReport {
        if self.cleaned {
            return CleanupReport::default();
        }
        let before = dir_size(&self.dir);
        // Drop the handle first or Windows will refuse to remove the file.
        self.lock = None;

        let mut report = CleanupReport {
            bytes_freed: before,
            ..Default::default()
        };

        // The directory may contain a legacy content.db or media folder from
        // an older build, as well as the current WebView2 profile. Removing
        // the whole validated run directory handles both without ever
        // touching durable preferences or another sibling session.
        let files_before = file_count(&self.dir);
        match remove_dir_all_with_retry(&self.dir) {
            Ok(()) => {
                report.directory_removed = true;
                report.files_removed = files_before;
            }
            Err(e) => report.errors.push(format!("session directory: {e}")),
        }
        if report.directory_removed && self.dir.exists() {
            report.directory_removed = false;
            report
                .errors
                .push("session directory still exists after cleanup".into());
        }

        // Schedule the same-EXE cleanup child even when the first removal
        // appeared to succeed. WebView2 can recreate its profile directory
        // after this check while its browser process is still unwinding.
        if !self.deferred_cleanup_scheduled {
            self.deferred_cleanup_scheduled = crate::portable::schedule_deferred_cleanup(&self.dir);
        }

        // Release mode creates the root beside the executable only for the
        // duration of a run. Remove empty parents too, but never recurse or
        // delete a non-empty directory: a second running copy may still own a
        // sibling session.
        if report.directory_removed {
            // A sharing violation from WebView2 can make the first removal
            // attempt fail while the browser child process is unwinding. Keep
            // cleanup retryable until the directory is actually gone; Drop
            // will make a final attempt if the caller does not retry.
            self.cleaned = true;
            let _ = fs::remove_dir(&self.root);
            if self.root.file_name().and_then(|name| name.to_str()) == Some("sessions") {
                if let Some(parent) = self.root.parent() {
                    let _ = fs::remove_dir(parent);
                }
            }
        }
        report
    }
}

fn remove_dir_all_with_retry(path: &Path) -> std::io::Result<()> {
    let mut last_error = None;
    for attempt in 0..CLEANUP_ATTEMPTS {
        match fs::remove_dir_all(path) {
            Ok(()) if !path.exists() => return Ok(()),
            Ok(()) if attempt + 1 < CLEANUP_ATTEMPTS => {
                std::thread::sleep(CLEANUP_RETRY_DELAY);
            }
            Ok(()) => {
                return Err(std::io::Error::other(
                    "session directory still exists after cleanup",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !path.exists() => {
                return Ok(());
            }
            Err(error)
                if attempt + 1 < CLEANUP_ATTEMPTS
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::WouldBlock
                    ) =>
            {
                last_error = Some(error);
                std::thread::sleep(CLEANUP_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error
        .unwrap_or_else(|| std::io::Error::other("session cleanup exhausted its retry budget")))
}

impl Drop for EphemeralSession {
    fn drop(&mut self) {
        // A normal exit calls cleanup() explicitly; this covers panics and the
        // early-return paths during startup.
        let _ = self.cleanup();
    }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub files_removed: usize,
    pub directory_removed: bool,
    pub bytes_freed: u64,
    pub errors: Vec<String>,
}

/// Delete session directories left behind by crashed runs.
///
/// Returns how many were removed. A directory is removed when its lock file
/// can be deleted (nobody holds it open) or when it is older than
/// [`MAX_SESSION_AGE`]. `skip` is the current session, which is never touched.
pub fn purge_stale(root: &Path, skip: Option<&Path>) -> usize {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0usize;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if skip.is_some_and(|s| s == path) {
            continue;
        }

        let lock = path.join(LOCK_FILE);
        let abandoned = if lock.exists() {
            // Succeeds only if no live process holds the handle.
            fs::remove_file(&lock).is_ok() || is_older_than(&path, MAX_SESSION_AGE)
        } else {
            // No lock file at all: either an interrupted create or a directory
            // we already partly cleaned. Either way it is ours to remove.
            true
        };

        if abandoned && fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Measure a validated throwaway directory for Diagnostics. Durable stores
/// are never passed here by production callers.
pub fn directory_size(path: &Path) -> u64 {
    dir_size(path)
}

fn is_older_than(path: &Path, age: Duration) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|elapsed| elapsed > age)
}

/// Recursive byte total. Symlinks are not followed.
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

fn file_count(path: &Path) -> usize {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => file_count(&entry.path()),
            Ok(kind) if kind.is_file() => 1,
            _ => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test gets its own root so they can run in parallel.
    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ffn-test-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn creates_a_session_directory_with_a_lock_but_no_content_files() {
        let root = temp_root("create");
        let s = EphemeralSession::create_in(&root).unwrap();
        assert!(s.dir().is_dir());
        assert!(s.dir().join(LOCK_FILE).is_file());
        assert!(!s.dir().join("content.db").exists());
        assert!(!s.dir().join("media").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_sessions_never_share_a_directory() {
        let root = temp_root("distinct");
        let a = EphemeralSession::create_in(&root).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = EphemeralSession::create_in(&root).unwrap();
        assert_ne!(a.dir(), b.dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_removes_the_database_and_the_whole_directory() {
        let root = temp_root("cleanup");
        let mut s = EphemeralSession::create_in(&root).unwrap();
        let dir = s.dir().to_path_buf();

        // Simulate a session that fetched content.
        fs::write(dir.join("content.db"), vec![7u8; 4096]).unwrap();
        fs::write(dir.join("content.db-wal"), vec![7u8; 2048]).unwrap();
        let media = dir.join("media");
        fs::create_dir_all(&media).unwrap();
        fs::write(media.join("avatar.png"), vec![1u8; 512]).unwrap();
        assert!(s.size_bytes() >= 4096 + 2048 + 512);

        let report = s.cleanup();
        assert!(report.directory_removed, "{report:?}");
        assert!(report.errors.is_empty(), "{report:?}");
        assert!(report.bytes_freed >= 6656);
        assert!(!dir.exists(), "session directory survived cleanup");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_removes_webview_files_and_empty_portable_parents() {
        let base = temp_root("portable-parents");
        let root = base.join("sessions");
        let mut s = EphemeralSession::create_in(&root).unwrap();
        let dir = s.dir().to_path_buf();

        // A WebView2 profile is outside the database/media files and must be
        // removed by the same per-run cleanup boundary.
        let profile = dir.join("webview").join("Default");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("Preferences"), b"profile").unwrap();

        let report = s.cleanup();
        assert!(report.directory_removed, "{report:?}");
        assert!(report.errors.is_empty(), "{report:?}");
        assert!(!dir.exists(), "session directory survived cleanup");
        assert!(!root.exists(), "session root survived cleanup");
        assert!(!base.exists(), "portable parent survived cleanup");
    }

    #[test]
    fn cleanup_is_idempotent() {
        let root = temp_root("idem");
        let mut s = EphemeralSession::create_in(&root).unwrap();
        let first = s.cleanup();
        assert!(first.directory_removed);
        let second = s.cleanup();
        assert_eq!(second.files_removed, 0);
        assert!(second.errors.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dropping_a_session_deletes_it() {
        let root = temp_root("drop");
        let dir = {
            let s = EphemeralSession::create_in(&root).unwrap();
            fs::write(s.dir().join("content.db"), b"content").unwrap();
            s.dir().to_path_buf()
        };
        assert!(!dir.exists(), "drop did not clean the session directory");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_sessions_from_a_crash_are_purged_at_startup() {
        let root = temp_root("stale");
        // A directory left by a run that died without cleaning up: the lock
        // file exists but no process holds it.
        let crashed = root.join("s-999999-1");
        fs::create_dir_all(crashed.join("media")).unwrap();
        fs::write(crashed.join(LOCK_FILE), b"").unwrap();
        fs::write(crashed.join("content.db"), vec![0u8; 1024]).unwrap();

        assert_eq!(purge_stale(&root, None), 1);
        assert!(!crashed.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn purging_never_deletes_the_live_session() {
        let root = temp_root("live");
        let s = EphemeralSession::create_in(&root).unwrap();
        let crashed = root.join("s-1-1");
        fs::create_dir_all(&crashed).unwrap();
        fs::write(crashed.join(LOCK_FILE), b"").unwrap();

        // The live session is passed as `skip`, and on Windows its open lock
        // handle would also protect it.
        assert_eq!(purge_stale(&root, Some(s.dir())), 1);
        assert!(s.dir().is_dir(), "the running session was deleted");
        assert!(!crashed.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn purging_an_empty_or_missing_root_is_harmless() {
        let root = temp_root("empty");
        assert_eq!(purge_stale(&root, None), 0);
        fs::create_dir_all(&root).unwrap();
        assert_eq!(purge_stale(&root, None), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_without_a_lock_file_is_treated_as_abandoned() {
        let root = temp_root("nolock");
        let orphan = root.join("s-orphan");
        fs::create_dir_all(&orphan).unwrap();
        assert_eq!(purge_stale(&root, None), 1);
        assert!(!orphan.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
