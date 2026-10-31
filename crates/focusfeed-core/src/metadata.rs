use crate::{database::FeedFilters, CoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterPreset {
    pub id: String,
    pub name: String,
    pub filters: FeedFilters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    pub enabled: bool,
    pub route: String,
    #[serde(default, rename = "postID", alias = "postId")]
    pub post_id: Option<String>,
    pub offset: f64,
    #[serde(default, rename = "accountID", alias = "accountId")]
    pub account_id: Option<String>,
    #[serde(default)]
    pub saved_at_millis: u64,
}

pub(crate) struct Metadata {
    conn: Mutex<Connection>,
}
impl Metadata {
    pub fn open(path: &Path) -> Result<Self, CoreError> {
        let conn = Connection::open(path)?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if check != "ok" {
            return Err(CoreError::storage());
        }
        conn.execute_batch("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS native_filter_presets(account_id TEXT PRIMARY KEY,presets TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS native_resume_options(account_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
            CREATE TABLE IF NOT EXISTS native_resume_markers_v2(account_id TEXT NOT NULL,route TEXT NOT NULL,state TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(account_id,route));
            COMMIT;")?;
        // Preserve the early development schema without trusting arbitrary JSON
        // to invent a route. The original table is left available for recovery.
        let legacy:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_resume_markers')",[],|row|row.get(0))?;
        if legacy {
            let rows: Vec<(String, String, i64)> = {
                let mut statement =
                    conn.prepare("SELECT account_id,state,expires_at FROM native_resume_markers")?;
                let rows =
                    statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
                rows.collect::<Result<_, _>>()?
            };
            for (account, raw, expires) in rows {
                if let Ok(state) = serde_json::from_str::<ResumeState>(&raw) {
                    if state.enabled
                        && valid_route(&state.route)
                        && state.account_id.as_ref().is_none_or(|id| id == &account)
                    {
                        conn.execute("INSERT OR IGNORE INTO native_resume_options(account_id,enabled) VALUES(?1,1)",[&account])?;
                        conn.execute("INSERT OR IGNORE INTO native_resume_markers_v2(account_id,route,state,expires_at) VALUES(?1,?2,?3,?4)",params![account,state.route,raw,expires])?;
                    }
                }
            }
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
    pub fn presets(&self, account: &str) -> Result<Vec<FilterPreset>, CoreError> {
        let value: Option<String> = self
            .conn
            .lock()
            .map_err(|_| CoreError::storage())?
            .query_row(
                "SELECT presets FROM native_filter_presets WHERE account_id=?1",
                [account],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|v| serde_json::from_str(&v).map_err(|_| CoreError::storage()))
            .unwrap_or(Ok(vec![]))
    }
    pub fn set_presets(&self, account: &str, presets: &[FilterPreset]) -> Result<(), CoreError> {
        let mut ids = std::collections::HashSet::new();
        if account.is_empty()
            || presets.len() > 20
            || presets.iter().any(|p| {
                p.id.is_empty()
                    || p.id.len() > 64
                    || !ids.insert(&p.id)
                    || p.name.trim().is_empty()
                    || p.name.len() > 120
                    || p.filters.muted_words.len() > 100
                    || p.filters.languages.len() > 30
                    || p.filters.muted_words.iter().any(|w| w.len() > 200)
            })
        {
            return Err(CoreError::invalid());
        }
        let value = serde_json::to_string(presets).map_err(|_| CoreError::invalid())?;
        if value.len() > 32768 {
            return Err(CoreError::invalid());
        }
        self.conn.lock().map_err(|_|CoreError::storage())?.execute(
            "INSERT INTO native_filter_presets(account_id,presets) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET presets=excluded.presets", params![account,value])?;
        Ok(())
    }
    pub fn resume(
        &self,
        account: &str,
        route: Option<&str>,
        now: u64,
    ) -> Result<Option<ResumeState>, CoreError> {
        let conn = self.conn.lock().map_err(|_| CoreError::storage())?;
        if route.is_some_and(|route| !valid_route(route)) {
            return Err(CoreError::invalid());
        }
        conn.execute(
            "DELETE FROM native_resume_markers_v2 WHERE expires_at<=?1",
            [now.min(i64::MAX as u64) as i64],
        )?;
        let enabled: bool = conn
            .query_row(
                "SELECT enabled FROM native_resume_options WHERE account_id=?1",
                [account],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if !enabled {
            return Ok(None);
        }
        let value: Option<String> = if let Some(route) = route {
            conn.query_row(
                "SELECT state FROM native_resume_markers_v2 WHERE account_id=?1 AND route=?2",
                params![account, route],
                |row| row.get(0),
            )
            .optional()?
        } else {
            conn.query_row("SELECT state FROM native_resume_markers_v2 WHERE account_id=?1 ORDER BY expires_at DESC LIMIT 1",[account],|row|row.get(0)).optional()?
        };
        value
            .map(|v| serde_json::from_str(&v).map_err(|_| CoreError::storage()))
            .transpose()
            .map(|state| {
                state.or_else(|| {
                    Some(ResumeState {
                        enabled: true,
                        route: route.unwrap_or("following").into(),
                        post_id: None,
                        offset: 0.0,
                        account_id: Some(account.into()),
                        saved_at_millis: 0,
                    })
                })
            })
    }
    pub fn set_resume(
        &self,
        account: &str,
        mut state: ResumeState,
        now: u64,
    ) -> Result<(), CoreError> {
        if account.is_empty()
            || !valid_route(&state.route)
            || !state.offset.is_finite()
            || !(0.0..=100_000_000.0).contains(&state.offset)
            || state.post_id.as_ref().is_some_and(|id| {
                id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_digit())
            })
            || state.account_id.as_ref().is_some_and(|id| id != account)
        {
            return Err(CoreError::invalid());
        }
        let mut conn = self.conn.lock().map_err(|_| CoreError::storage())?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO native_resume_options(account_id,enabled) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled",params![account,state.enabled])?;
        if !state.enabled {
            tx.execute(
                "DELETE FROM native_resume_markers_v2 WHERE account_id=?1",
                [account],
            )?;
            if tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='native_resume_markers')",
                [],
                |row| row.get::<_, bool>(0),
            )? {
                tx.execute(
                    "DELETE FROM native_resume_markers WHERE account_id=?1",
                    [account],
                )?;
            }
            tx.commit()?;
            return Ok(());
        }
        state.account_id = Some(account.into());
        state.saved_at_millis = now;
        let encoded = serde_json::to_string(&state).map_err(|_| CoreError::invalid())?;
        tx.execute("INSERT INTO native_resume_markers_v2(account_id,route,state,expires_at) VALUES(?1,?2,?3,?4) ON CONFLICT(account_id,route) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at",params![account,state.route,encoded,now.saturating_add(30*24*60*60*1000).min(i64::MAX as u64) as i64])?;
        tx.commit()?;
        Ok(())
    }
    pub fn clear_resume(&self, account: &str) -> Result<(), CoreError> {
        self.set_resume(
            account,
            ResumeState {
                enabled: false,
                route: "following".into(),
                post_id: None,
                offset: 0.0,
                account_id: Some(account.into()),
                saved_at_millis: 0,
            },
            0,
        )
    }
}

fn valid_route(route: &str) -> bool {
    ["following", "focus", "bookmarks", "originals", "groups"].contains(&route)
        || route
            .strip_prefix("user:")
            .is_some_and(|name| crate::security::clean_screen_name(name).is_some())
        || route.strip_prefix("group:").is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// Create one verified SQLite online backup before the native app opens the
/// existing preferences schema. Includes WAL changes and never overwrites a
/// previous backup. Invalid source data stops migration without deleting it.
pub(crate) fn backup_preferences(path: &Path) -> Result<(), CoreError> {
    if !path.exists() {
        return Ok(());
    }
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let check: String = source.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(CoreError::storage());
    }
    let backup = path.with_file_name("preferences.native-migration-v1.backup.db");
    if !backup.exists() {
        source.backup("main", &backup, None)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| CoreError::storage())?;
    }
    let verify = Connection::open_with_flags(&backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let verified: String = verify.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if verified != "ok" {
        return Err(CoreError::storage());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn marker(route: &str, post: &str) -> ResumeState {
        ResumeState {
            enabled: true,
            route: route.into(),
            post_id: Some(post.into()),
            offset: 12.0,
            account_id: None,
            saved_at_millis: 0,
        }
    }
    #[test]
    fn resume_expiry_removes_only_expired_markers_and_preserves_opt_in() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = Metadata::open(&dir.path().join("native.db")).unwrap();
        metadata
            .set_resume("1", marker("following", "10"), 1000)
            .unwrap();
        metadata
            .set_resume("1", marker("bookmarks", "11"), 2000)
            .unwrap();
        let age = 30 * 24 * 60 * 60 * 1000;
        assert_eq!(
            metadata
                .resume("1", Some("following"), 1000 + age - 1)
                .unwrap()
                .unwrap()
                .post_id
                .as_deref(),
            Some("10")
        );
        assert_eq!(
            metadata
                .resume("1", Some("following"), 1000 + age)
                .unwrap()
                .unwrap()
                .post_id,
            None
        );
        assert_eq!(
            metadata
                .resume("1", Some("bookmarks"), 1000 + age)
                .unwrap()
                .unwrap()
                .post_id
                .as_deref(),
            Some("11")
        );
        assert!(metadata.resume("2", None, 1000).unwrap().is_none());
        metadata.clear_resume("1").unwrap();
        assert!(metadata.resume("1", None, 1000).unwrap().is_none());
    }
    #[test]
    fn filter_preset_validation_is_atomic_and_rejects_duplicate_identity() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = Metadata::open(&dir.path().join("native.db")).unwrap();
        let preset = FilterPreset {
            id: "one".into(),
            name: "Photos".into(),
            filters: FeedFilters {
                images_only: true,
                ..Default::default()
            },
        };
        metadata
            .set_presets("1", std::slice::from_ref(&preset))
            .unwrap();
        assert!(metadata
            .set_presets("1", &[preset.clone(), preset])
            .is_err());
        let saved = metadata.presets("1").unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "Photos");
        assert!(metadata.presets("2").unwrap().is_empty());
    }
}
