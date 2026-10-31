//! Durable storage — the short list of things that outlive a run.
//!
//! Focus Feed Next keeps two stores, and the split is deliberate:
//!
//! - **This one** lives in `%APPDATA%\FocusFeedNext\preferences.db` only in
//!   debug/non-portable compatibility runs and holds interface preferences plus
//!   the identity of the connected account.
//! - **`database.rs`** is an in-memory connection for the current run and
//!   holds every piece of fetched content. It is dropped when the app exits;
//!   the per-run directory holds only the cleanup lock and WebView2 profile.
//!
//! Release portable runs open the metadata file beside the executable; fetched
//! content remains ephemeral while preferences, identity and local list
//! definitions survive a restart.
//!
//! Credentials are in neither: they belong to Windows Credential Manager and
//! only there (`credentials.rs`).
//!
//! ## Why an allowlist
//!
//! The persistence rule is enforced by naming what may persist, not by naming
//! what may not. A key added anywhere else in the app is ephemeral until
//! somebody deliberately adds it to [`DURABLE_PREFERENCES`], so durability
//! cannot be acquired by accident — which is the failure mode a denylist has.

use crate::models::{AccountList, AppError, AppResult, Author, ErrorCode};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

/// Every preference key permitted to survive a restart.
///
/// Deliberately small. Reading position, filters, hidden posts, muted words and
/// pinned handles are session-scoped and are **not** here. Local list
/// definitions are durable in their own account-scoped tables below, rather
/// than being serialized as a preference blob.
pub const DURABLE_PREFERENCES: &[&str] = &[
    "migration.iosVideoQuality080",
    "performance.mode", "reading.size", "appearance.haptics", "video.autoplay", "navigation.tabs",
    // Appearance and language.
    "language",
    "theme",
    "density",
    "appearance.radius",
    "appearance.shadow",
    "appearance.accent",
    "appearance.background",
    "appearance.surface",
    "appearance.elevated",
    "appearance.border",
    "appearance.mediaBackground",
    "appearance.textContrast",
    "appearance.timestampStyle",
    "appearance.collapseLongPosts",
    // Window geometry, so the app reopens where the user left it.
    "window.width",
    "window.height",
    "window.x",
    "window.y",
    "window.maximized",
    // Updater behaviour.
    "updates.autoCheck",
    "updates.channel",
    // The account-changing actions this release can perform. Unfollow is on by
    // default and can be explicitly switched off. See [`ALLOW_UNFOLLOW`].
    "actions.allowUnfollow",
    // Unlocks the *interface* for operations beyond Follow/Unfollow. Rust still
    // refuses anything the provider does not genuinely support, so this hides
    // controls rather than granting permission. See [`ADVANCED_ACTIONS`].
    "actions.advanced",
    // Whether the app may re-check the connection on its own while its window
    // is visible. Durable because it is a standing decision about the app
    // talking to X unprompted, not a session preference. See [`AUTO_CHECK`].
    "monitoring.autoCheck",
    "monitoring.intervalMinutes",
    // What a page does when it is opened, globally and per route. The per-route
    // keys are enumerated rather than pattern-matched: an allowlist that accepts
    // a prefix is not an allowlist.
    "pages.openBehavior",
    "pages.openBehavior.following",
    "pages.openBehavior.bookmarks",
    "pages.openBehavior.accounts",
    "pages.openBehavior.groups",
    "pages.openBehavior.profile",
    // Background work started after a successful startup authentication.
    "startup.preloadBookmarks",
    "startup.preloadFollowing",
    // Reading behaviour. No "content.showReplies": replies are not fetched or
    // rendered anywhere in the app, so there is no state for it to carry.
    "content.hideReposts",
    "content.unreadOnly",
    "content.readDelayMs",
    "content.autoRefreshMinutes",
    // Playback behaviour.
    "video.loop",
    "video.clickToggle",
    "video.gifAutoplay",
    "video.offscreenCleanup",
    "video.quality",
    "video.defaultSpeed",
];

/// Preference gating unattended connection checks.
///
/// **Default on**: this only reads, and a reader who
/// leaves the window open should be told the session has lapsed rather than
/// discovering it from a failed refresh. [`Durable::auto_check_connection`]
/// therefore treats an absent value as `true` — the opposite default, for the
/// opposite reason.
pub const AUTO_CHECK: &str = "monitoring.autoCheck";

/// Preference gating the only write operation Focus Feed Next exposes.
///
/// Durable because it is a standing decision about what the app may do to the
/// account, not a session setting — and because a reader who turned it off
/// would reasonably expect it to stay off after a restart. **Default on**:
/// [`Durable::allow_unfollow`] treats an absent value as `true`; only an
/// explicitly stored value other than the literal `"true"`, or a preference
/// read failure, leaves the operation unavailable.
pub const ALLOW_UNFOLLOW: &str = "actions.allowUnfollow";

/// Preference unlocking account operations beyond Follow and Unfollow.
///
/// **Default off.** Switching it on reveals controls; it does not grant
/// permission. Rust refuses any operation the pinned provider does not
/// genuinely support whatever this says, so the two gates are independent: the
/// preference decides what is *offered*, [`crate::security`] decides what may
/// *run*. A preference alone must never be the thing standing between a click
/// and somebody's account.
pub const ADVANCED_ACTIONS: &str = "actions.advanced";

/// Longest value a preference may hold. Small on purpose: this store must not
/// become a place where content can be smuggled into durable storage.
const MAX_VALUE_LEN: usize = 512;

pub fn is_durable_preference(key: &str) -> bool {
    DURABLE_PREFERENCES.contains(&key)
}

/// The minimum needed to show "you are signed in as …" before any network call.
///
/// Nothing here is secret and nothing here is content: no bio, no counts, no
/// posts. Those are fetched fresh each run.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub provider: String,
    /// Last known connection state label, so the UI can render a plausible dot
    /// immediately instead of flashing grey while the first probe runs.
    pub last_state: String,
}

impl AccountIdentity {
    pub fn from_author(a: &Author, provider: &str, last_state: &str) -> Self {
        Self {
            id: a.id.clone(),
            username: a.username.clone(),
            display_name: a.display_name.clone(),
            avatar_url: a.avatar_url.clone(),
            provider: provider.to_string(),
            last_state: last_state.to_string(),
        }
    }
}

pub struct Durable {
    conn: Mutex<Connection>,
}

impl Durable {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if check != "ok" { return Err(AppError::database("Preferences could not be verified. Original data was preserved.")); }
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    pub fn in_memory() -> AppResult<Self> {
        let db = Self {
            conn: Mutex::new(Connection::open_in_memory()?),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS preferences (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS account_identity (
                only_row     INTEGER PRIMARY KEY CHECK (only_row = 1),
                id           TEXT NOT NULL,
                username     TEXT NOT NULL,
                display_name TEXT NOT NULL,
                avatar_url   TEXT,
                provider     TEXT NOT NULL,
                last_state   TEXT NOT NULL
            );
            -- User-authored list definitions are durable, but they contain
            -- only account/list ids and presentation metadata. Fetched posts,
            -- authors and media remain in the throwaway session database.
            CREATE TABLE IF NOT EXISTS account_lists (
                account_id TEXT NOT NULL,
                list_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#6366f1',
                created_at TEXT NOT NULL,
                PRIMARY KEY (account_id, list_id)
            );
            CREATE TABLE IF NOT EXISTS account_list_members (
                account_id TEXT NOT NULL,
                list_id TEXT NOT NULL,
                author_id TEXT NOT NULL,
                PRIMARY KEY (account_id, list_id, author_id),
                FOREIGN KEY (account_id, list_id)
                    REFERENCES account_lists(account_id, list_id)
                    ON DELETE CASCADE
            );
            COMMIT;
            "#,
        )?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        // Existing tables are not repaired by CREATE IF NOT EXISTS. Refuse an
        // incompatible schema instead of silently starting with missing data.
        for sql in [
            "SELECT key,value FROM preferences LIMIT 0",
            "SELECT id,username,display_name,avatar_url,provider,last_state FROM account_identity LIMIT 0",
            "SELECT account_id,list_id,name,color,created_at FROM account_lists LIMIT 0",
            "SELECT account_id,list_id,author_id FROM account_list_members LIMIT 0",
        ] { conn.prepare(sql)?; }
        let invalid_members: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM account_list_members m LEFT JOIN account_lists l ON l.account_id=m.account_id AND l.list_id=m.list_id WHERE l.list_id IS NULL)",
            [], |row| row.get(0))?;
        if invalid_members { return Err(AppError::database("Local list relationships could not be verified. Original data was preserved.")); }
        Ok(())
    }

    // -- preferences --------------------------------------------------------

    /// Store a preference. Rejects anything not on the allowlist.
    pub fn set_preference(&self, key: &str, value: &str) -> AppResult<()> {
        if !is_durable_preference(key) {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                format!("'{key}' is not a durable preference"),
            ));
        }
        // The allowlist already excludes credential-shaped keys; this is the
        // second lock on the same door, in case the list is ever extended.
        if crate::security::is_credential_shaped_key(key) {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                "credential-like keys cannot be stored in preferences",
            ));
        }
        if value.len() > MAX_VALUE_LEN {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                "preference value is too large",
            ));
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1,?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn set_preferences_batch(&self, entries: &[(String, String)], portable: bool) -> AppResult<()> {
        crate::preferences::validate(entries, portable)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for (key, value) in entries { tx.execute("INSERT OR REPLACE INTO preferences (key,value) VALUES (?1,?2)", params![key,value])?; }
        tx.commit()?;
        Ok(())
    }
    pub fn monitor_interval_minutes(&self) -> i64 {
        self.get_preference("monitoring.intervalMinutes").ok().flatten().and_then(|v| v.parse::<i64>().ok()).unwrap_or(5).clamp(1,60)
    }
    pub fn get_preference(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM preferences WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v)
    }

    /// Whether the reader has permitted Unfollow.
    ///
    /// A fresh install has no row and is enabled by default. Once a value is
    /// stored, only the literal `"true"` enables it; malformed values and read
    /// failures stay unavailable rather than being interpreted as permission.
    pub fn allow_unfollow(&self) -> bool {
        match self.get_preference(ALLOW_UNFOLLOW) {
            Ok(Some(value)) => value == "true",
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// Whether unattended connection monitoring is permitted.
    ///
    /// Only an explicit `"false"` turns it off. A missing row, an unreadable
    /// database or a value from a future build all leave it on, because the
    /// failure mode of monitoring-when-unwanted is a request every five
    /// minutes, while the failure mode of silently-not-monitoring is a reader
    /// who believes a dead session is live.
    pub fn auto_check_connection(&self) -> bool {
        !matches!(
            self.get_preference(AUTO_CHECK).ok().flatten().as_deref(),
            Some("false")
        )
    }

    /// Whether the background bookmark traversal may start at launch.
    ///
    /// **Default on**, like [`Self::auto_check_connection`] and for the same
    /// reason: it only reads, and the alternative is a reader opening Bookmarks
    /// and waiting for a traversal that could have been running already. Only an
    /// explicit `"false"` turns it off.
    pub fn preload_bookmarks(&self) -> bool {
        !matches!(
            self.get_preference("startup.preloadBookmarks")
                .ok()
                .flatten()
                .as_deref(),
            Some("false")
        )
    }

    /// Whether the background Following traversal may start at launch.
    ///
    /// Default on, for the same reasons — and this one also feeds the group
    /// member picker, which is empty until the list has been walked once.
    pub fn preload_following(&self) -> bool {
        !matches!(
            self.get_preference("startup.preloadFollowing")
                .ok()
                .flatten()
                .as_deref(),
            Some("false")
        )
    }

    /// Whether the interface may offer operations beyond Follow and Unfollow.
    ///
    /// Mirrors [`Self::allow_unfollow`] exactly — only a literal `"true"`
    /// enables it — because every failure mode of reading a preference should
    /// land on the safer answer.
    pub fn advanced_actions(&self) -> bool {
        matches!(
            self.get_preference(ADVANCED_ACTIONS)
                .ok()
                .flatten()
                .as_deref(),
            Some("true")
        )
    }

    pub fn all_preferences(&self) -> AppResult<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM preferences ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        // Filter on read as well as on write: a preferences file edited by hand,
        // or written by an older build with a longer list, cannot reintroduce a
        // key this build considers ephemeral.
        Ok(rows
            .filter_map(Result::ok)
            .filter(|(k, _): &(String, String)| is_durable_preference(k))
            .collect())
    }

    // -- account identity ---------------------------------------------------

    pub fn set_identity(&self, identity: &AccountIdentity) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO account_identity
               (only_row, id, username, display_name, avatar_url, provider, last_state)
             VALUES (1,?1,?2,?3,?4,?5,?6)",
            params![
                identity.id,
                identity.username,
                identity.display_name,
                identity.avatar_url,
                identity.provider,
                identity.last_state,
            ],
        )?;
        Ok(())
    }

    pub fn identity(&self) -> AppResult<Option<AccountIdentity>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT id, username, display_name, avatar_url, provider, last_state
                   FROM account_identity WHERE only_row = 1",
                [],
                |r| {
                    Ok(AccountIdentity {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        display_name: r.get(2)?,
                        avatar_url: r.get(3)?,
                        provider: r.get(4)?,
                        last_state: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Update only the remembered connection label, leaving the account alone.
    pub fn set_last_state(&self, label: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE account_identity SET last_state = ?1 WHERE only_row = 1",
            params![label],
        )?;
        Ok(())
    }

    pub fn clear_identity(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM account_identity", [])?;
        Ok(())
    }

    // -- durable, account-scoped user lists -------------------------------

    pub fn account_lists(&self, account_id: &str) -> AppResult<Vec<AccountList>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT list_id, name, color FROM account_lists
             WHERE account_id = ?1 ORDER BY created_at, list_id",
        )?;
        let rows = stmt.query_map(params![account_id], |r| {
            Ok(AccountList {
                id: r.get(0)?,
                account_id: account_id.to_string(),
                name: r.get(1)?,
                color: r.get(2)?,
                member_ids: Vec::new(),
            })
        })?;
        let mut out: Vec<AccountList> = rows.collect::<Result<_, _>>()?;
        let mut members = conn.prepare(
            "SELECT list_id, author_id FROM account_list_members
             WHERE account_id = ?1 ORDER BY author_id",
        )?;
        let member_rows = members.query_map(params![account_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in member_rows {
            let (list_id, author_id) = row?;
            if let Some(list) = out.iter_mut().find(|list| list.id == list_id) {
                list.member_ids.push(author_id);
            }
        }
        Ok(out)
    }

    pub fn upsert_account_list(
        &self,
        account_id: &str,
        list_id: &str,
        name: &str,
        color: &str,
    ) -> AppResult<()> {
        let name = name.trim();
        if name.is_empty() || name.len() > 120 {
            return Err(AppError::new(ErrorCode::ApiError, "list name is invalid"));
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO account_lists (account_id, list_id, name, color, created_at)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(account_id, list_id) DO UPDATE SET
                name=excluded.name, color=excluded.color",
            params![account_id, list_id, name, color, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn delete_account_list(&self, account_id: &str, list_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM account_lists WHERE account_id = ?1 AND list_id = ?2",
            params![account_id, list_id],
        )?;
        Ok(())
    }

    pub fn account_list_exists(&self, account_id: &str, list_id: &str) -> AppResult<bool> {
        let conn = self.conn.lock().unwrap();
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM account_lists WHERE account_id = ?1 AND list_id = ?2",
                params![account_id, list_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(exists.is_some())
    }

    pub fn set_account_list_member(
        &self,
        account_id: &str,
        list_id: &str,
        author_id: &str,
        member: bool,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        if member {
            conn.execute(
                "INSERT OR REPLACE INTO account_list_members
                 (account_id, list_id, author_id) VALUES (?1,?2,?3)",
                params![account_id, list_id, author_id],
            )?;
        } else {
            conn.execute(
                "DELETE FROM account_list_members
                 WHERE account_id = ?1 AND list_id = ?2 AND author_id = ?3",
                params![account_id, list_id, author_id],
            )?;
        }
        Ok(())
    }

    /// Replace a list's durable membership atomically during session
    /// migration. Deleting first is important: a member removed while the
    /// app was open must not be resurrected on the next account switch.
    pub fn replace_account_list_members(
        &self,
        account_id: &str,
        list_id: &str,
        member_ids: &[String],
    ) -> AppResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM account_list_members WHERE account_id = ?1 AND list_id = ?2",
            params![account_id, list_id],
        )?;
        for author_id in member_ids {
            tx.execute(
                "INSERT INTO account_list_members (account_id, list_id, author_id)
                 VALUES (?1, ?2, ?3)",
                params![account_id, list_id, author_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn account_list_member_ids(
        &self,
        account_id: &str,
        list_id: &str,
    ) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT author_id FROM account_list_members
             WHERE account_id = ?1 AND list_id = ?2 ORDER BY author_id",
        )?;
        let rows = stmt.query_map(params![account_id, list_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Table names present in this store. Used by a test that guards the
    /// durable surface from quietly growing.
    pub fn table_names(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table'
               AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_batch_and_sql_failure_never_partially_commit() {
        let d = Durable::in_memory().unwrap();
        d.set_preference("theme", "dark").unwrap();
        assert!(d.set_preferences_batch(&[("theme".into(),"light".into()),("reading.size".into(),"NaN".into())], false).is_err());
        assert_eq!(d.get_preference("theme").unwrap().as_deref(), Some("dark"));
        d.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_reading BEFORE INSERT ON preferences WHEN NEW.key = 'reading.size' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;").unwrap();
        assert!(d.set_preferences_batch(&[("theme".into(),"light".into()),("reading.size".into(),"120".into())], false).is_err());
        assert_eq!(d.get_preference("theme").unwrap().as_deref(), Some("dark"));
        assert!(d.get_preference("reading.size").unwrap().is_none());
    }
    #[test]
    fn monitoring_reads_the_committed_interval_and_has_safe_limits() {
        let d = Durable::in_memory().unwrap(); assert_eq!(d.monitor_interval_minutes(),5);
        d.set_preferences_batch(&[("monitoring.intervalMinutes".into(),"17".into())],false).unwrap();
        assert_eq!(d.monitor_interval_minutes(),17);
        assert!(d.set_preferences_batch(&[("monitoring.intervalMinutes".into(),"0".into())],false).is_err());
        assert_eq!(d.monitor_interval_minutes(),17);
    }

    fn author() -> Author {
        Author {
            id: "44196397".into(),
            username: "someone".into(),
            display_name: "Some One".into(),
            avatar_url: Some("https://pbs.twimg.com/a.jpg".into()),
            bio: Some("a bio that must not be persisted".into()),
            followers_count: Some(1234),
            ..Default::default()
        }
    }

    #[test]
    fn allowlisted_preferences_round_trip() {
        let d = Durable::in_memory().unwrap();
        d.set_preference("language", "ar").unwrap();
        d.set_preference("theme", "light").unwrap();
        assert_eq!(d.get_preference("language").unwrap().as_deref(), Some("ar"));
        assert_eq!(d.all_preferences().unwrap().len(), 2);
    }

    #[test]
    fn a_key_outside_the_allowlist_is_refused() {
        let d = Durable::in_memory().unwrap();
        // These are all real app concepts — they are simply session-scoped.
        for key in [
            "searchHistory",
            "mutedWords",
            "pinnedAccounts",
            "scrollPosition",
            "savedLists",
            "hideMetrics",
        ] {
            let err = d.set_preference(key, "x").unwrap_err();
            assert_eq!(err.code, ErrorCode::BlockedOperation, "{key} was persisted");
        }
        assert!(d.all_preferences().unwrap().is_empty());
    }

    #[test]
    fn credential_shaped_keys_are_refused_even_if_allowlisted() {
        // Guards the case where somebody extends DURABLE_PREFERENCES badly.
        let d = Durable::in_memory().unwrap();
        for key in ["auth_token", "ct0", "sessionCookie", "apiSecret"] {
            assert!(d.set_preference(key, "value").is_err(), "{key} persisted");
        }
    }

    #[test]
    fn an_oversized_value_is_refused() {
        let d = Durable::in_memory().unwrap();
        let big = "a".repeat(MAX_VALUE_LEN + 1);
        assert!(d.set_preference("theme", &big).is_err());
    }

    #[test]
    fn reading_ignores_keys_this_build_considers_ephemeral() {
        // Simulates a preferences file written by a build with a longer list,
        // or edited by hand. The row exists; it must not be honoured.
        let d = Durable::in_memory().unwrap();
        {
            let conn = d.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO preferences (key, value) VALUES ('searchHistory','rust')",
                [],
            )
            .unwrap();
        }
        assert!(d.all_preferences().unwrap().is_empty());
    }

    #[test]
    fn identity_stores_no_content() {
        let d = Durable::in_memory().unwrap();
        let id = AccountIdentity::from_author(&author(), "twitter-cli", "connected");
        d.set_identity(&id).unwrap();

        let back = d.identity().unwrap().unwrap();
        assert_eq!(back, id);
        assert_eq!(back.username, "someone");

        // The bio and follower count came in on the Author and must not have
        // been carried across: those are fetched content, refreshed each run.
        let json = serde_json::to_string(&back).unwrap();
        assert!(!json.contains("a bio that must not be persisted"));
        assert!(!json.contains("1234"));
    }

    #[test]
    fn identity_replaces_rather_than_accumulates() {
        let d = Durable::in_memory().unwrap();
        d.set_identity(&AccountIdentity::from_author(
            &author(),
            "twitter-cli",
            "connected",
        ))
        .unwrap();
        let mut other = author();
        other.id = "999".into();
        other.username = "another".into();
        d.set_identity(&AccountIdentity::from_author(
            &other,
            "twitter-cli",
            "connected",
        ))
        .unwrap();

        let back = d.identity().unwrap().unwrap();
        assert_eq!(back.username, "another", "two identities coexisted");
    }

    #[test]
    fn account_lists_round_trip_and_stay_isolated_between_accounts() {
        let d = Durable::in_memory().unwrap();
        d.upsert_account_list("account-a", "g_ai", "AI", "#6366f1")
            .unwrap();
        d.set_account_list_member("account-a", "g_ai", "author-1", true)
            .unwrap();
        d.upsert_account_list("account-b", "g_news", "News", "#10b981")
            .unwrap();

        let a = d.account_lists("account-a").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "AI");
        assert_eq!(a[0].member_ids, vec!["author-1"]);
        assert!(d.account_lists("account-b").unwrap()[0]
            .member_ids
            .is_empty());

        d.replace_account_list_members("account-a", "g_ai", &[])
            .unwrap();
        assert!(d.account_lists("account-a").unwrap()[0]
            .member_ids
            .is_empty());
    }

    #[test]
    fn disconnecting_clears_the_identity() {
        let d = Durable::in_memory().unwrap();
        d.set_identity(&AccountIdentity::from_author(
            &author(),
            "twitter-cli",
            "connected",
        ))
        .unwrap();
        d.clear_identity().unwrap();
        assert!(d.identity().unwrap().is_none());
    }

    #[test]
    fn the_last_state_label_can_be_updated_alone() {
        let d = Durable::in_memory().unwrap();
        d.set_identity(&AccountIdentity::from_author(
            &author(),
            "twitter-cli",
            "connected",
        ))
        .unwrap();
        d.set_last_state("expired").unwrap();
        let back = d.identity().unwrap().unwrap();
        assert_eq!(back.last_state, "expired");
        assert_eq!(back.username, "someone", "the account was disturbed");
    }

    #[test]
    fn the_durable_store_holds_no_content_tables() {
        // If this fails somebody has given content a way to survive a restart.
        let d = Durable::in_memory().unwrap();
        assert_eq!(
            d.table_names().unwrap(),
            vec![
                "account_identity".to_string(),
                "account_list_members".to_string(),
                "account_lists".to_string(),
                "preferences".to_string()
            ]
        );
    }
}
