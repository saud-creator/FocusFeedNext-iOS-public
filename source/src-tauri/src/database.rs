//! Session-scoped SQLite storage.
//!
//! Everything here is **ephemeral**. The connection is opened in memory and
//! is dropped when the app exits, so fetched posts, read state, saved posts,
//! hidden posts, pinned accounts, groups, muted words, sync cursors, provider
//! health history and per-session settings all disappear with the run that
//! fetched them. `Db::open` remains only as a compatibility/test helper for
//! inspecting old on-disk databases; production never calls it.
//!
//! The handful of things that must survive a restart — language, theme,
//! density, window geometry, updater preferences and the connected account's
//! identity — live in `durable.rs` instead, behind an allowlist.
//!
//! Credentials are in neither. See `credentials.rs` and `security.rs`.

use crate::models::*;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use std::path::Path;
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

/// Filters applied before posts are handed to the UI. Hiding never deletes:
/// relaxing a filter brings the post straight back.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FeedFilters {
    pub hide_promoted: bool,
    pub hide_reposts: bool,
    pub hide_read: bool,
    pub unread_only: bool,
    pub images_only: bool,
    pub videos_only: bool,
    pub text_only: bool,
    pub max_age_hours: u64,
    pub muted_words: Vec<String>,
    pub languages: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub total_posts: i64,
    pub unread_count: i64,
    pub new_count: i64,
    pub pinned_count: i64,
    pub group_count: i64,
    pub hidden_count: i64,
    pub read_today: i64,
    pub last_sync: Option<String>,
    pub cache_bytes: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub member_count: i64,
}

/// One row of the group member picker.
///
/// `following` is not decoration. A group can outlive a follow, so the picker
/// has to be able to show "in this group, but you no longer follow them"
/// instead of dropping the row and editing the user's group for them.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCandidate {
    pub author: Author,
    /// True when the account is in the connected user's real Following list.
    pub following: bool,
    /// True when the account is already a member of the group asked about.
    pub member: bool,
}

const SCHEMA_VERSION: i64 = 1;

/// The feed name the bookmark timeline is stored under.
///
/// A constant because three places have to agree on it — the fetch route, the
/// order recorder and the ordering branch in [`Db::load_feed`] — and a typo in
/// any one of them would silently restore publication ordering.
pub const BOOKMARKS_FEED: &str = "bookmarks";

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = match Connection::open(path) {
            Ok(c) => c,
            Err(e) => {
                // Corrupted-database recovery: move the bad file aside and
                // start clean rather than refusing to launch.
                log::warn!("database open failed, recreating: {e}");
                let backup = path.with_extension("corrupt.db");
                let _ = std::fs::rename(path, backup);
                Connection::open(path)?
            }
        };
        let db = Self {
            conn: Mutex::new(conn),
        };
        if db.migrate().is_err() {
            // Schema is unusable (corrupt page / foreign schema). Reset it.
            let mut guard = db.conn.lock().unwrap();
            *guard = Connection::open_in_memory()?;
            drop(guard);
            db.migrate()?;
        }
        Ok(db)
    }

    pub fn in_memory() -> AppResult<Self> {
        let db = Self {
            conn: Mutex::new(Connection::open_in_memory()?),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Release the session file so it can be deleted.
    ///
    /// Windows will not unlink a file that still has an open handle, and the
    /// shutdown path deletes the whole session directory. Swapping in an
    /// in-memory connection drops the real one — and leaves the `Db` usable
    /// rather than poisoned, so a late call during teardown cannot panic.
    pub fn close(&self) {
        if let Ok(mut guard) = self.conn.lock() {
            if let Ok(blank) = Connection::open_in_memory() {
                *guard = blank;
            }
        }
    }

    pub fn migrate(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS authors (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL,
                avatar_url TEXT,
                banner_url TEXT,
                verified INTEGER NOT NULL DEFAULT 0,
                bio TEXT,
                followers_count INTEGER,
                following_count INTEGER,
                location TEXT,
                website TEXT,
                joined_at TEXT,
                posts_count INTEGER,
                updated_at TEXT NOT NULL
            );

            -- X Lists the user added by id. Not fetched content: twitter-cli
            -- has no command that enumerates an account's Lists.
            CREATE TABLE IF NOT EXISTS saved_lists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                added_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS posts (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                author_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                lang TEXT,
                is_repost INTEGER NOT NULL DEFAULT 0,
                reposted_by_json TEXT,
                is_promoted INTEGER NOT NULL DEFAULT 0,
                quoted_json TEXT,
                metrics_json TEXT,
                media_json TEXT,
                url TEXT,
                is_article INTEGER NOT NULL DEFAULT 0,
                article_title TEXT,
                in_reply_to TEXT,
                provider TEXT NOT NULL DEFAULT 'unknown',
                first_fetched_at TEXT NOT NULL,
                last_updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);

            CREATE TABLE IF NOT EXISTS feed_entries (
                feed TEXT NOT NULL,
                post_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (feed, post_id)
            );
            CREATE INDEX IF NOT EXISTS idx_feed_entries ON feed_entries(feed, position);

            -- The order X returned the bookmark timeline in.
            --
            -- Bookmarks are ordered by *when they were bookmarked*, which is
            -- information the tweet itself does not carry: twitter-cli returns
            -- no `bookmarked_at` field, and there is no way to derive one from
            -- a tweet's publication time. Ordering the page by `created_at`
            -- therefore produced a list nobody recognised — an article
            -- bookmarked this morning sat below a week-old post that had been
            -- bookmarked last year.
            --
            -- The one thing the backend does convey is the order of the array
            -- it returns, which is X's own bookmark order, most recently
            -- bookmarked first. That position is recorded here and nowhere
            -- else. `seq` is a position, not a time: 0 is the top of the
            -- bookmark timeline. No timestamp is invented.
            CREATE TABLE IF NOT EXISTS bookmark_order (
                post_id TEXT PRIMARY KEY,
                seq INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bookmark_order ON bookmark_order(seq);

            -- The accounts the connected user genuinely follows.
            --
            -- Separate from `authors`, which accumulates every account seen in
            -- any payload — a reposter, a quoted author, a search hit. Group
            -- membership candidates come from this table alone, so offering
            -- somebody the user does not follow is not possible by
            -- construction. `position` preserves the order the backend
            -- returned, which is X's own Following order.
            CREATE TABLE IF NOT EXISTS following_accounts (
                author_id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                synced_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_following_position ON following_accounts(position);

            CREATE TABLE IF NOT EXISTS read_states (
                post_id TEXT PRIMARY KEY,
                is_read INTEGER NOT NULL DEFAULT 0,
                read_at TEXT
            );

            CREATE TABLE IF NOT EXISTS hidden_posts (
                post_id TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pinned_accounts (
                author_id TEXT PRIMARY KEY,
                pinned_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS account_preferences (
                author_id TEXT PRIMARY KEY,
                repost_mode TEXT NOT NULL DEFAULT 'global',
                muted INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS muted_words (
                word TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS custom_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#6366f1',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS group_members (
                group_id TEXT NOT NULL,
                author_id TEXT NOT NULL,
                PRIMARY KEY (group_id, author_id)
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                feed TEXT PRIMARY KEY,
                cursor TEXT,
                last_sync_at TEXT,
                last_error TEXT
            );

            CREATE TABLE IF NOT EXISTS provider_health (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                checked_at TEXT NOT NULL,
                provider TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reading_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id TEXT NOT NULL,
                read_at TEXT NOT NULL
            );
            "#,
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }

    pub fn schema_version(&self) -> AppResult<i64> {
        let conn = self.conn.lock().unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        Ok(v)
    }

    // -- writing -----------------------------------------------------------

    pub fn upsert_author(&self, a: &Author) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        Self::upsert_author_conn(&conn, a)
    }

    fn upsert_author_conn(conn: &rusqlite::Connection, a: &Author) -> AppResult<()> {
        conn.execute(
            // COALESCE on the optional columns: a tweet-embedded author carries
            // only five fields, so upserting one must not wipe the richer
            // profile a `user` lookup already stored for the same account.
            "INSERT INTO authors (id, username, display_name, avatar_url, banner_url, verified, bio,
                followers_count, following_count, location, website, joined_at, posts_count, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET username=excluded.username, display_name=excluded.display_name,
               avatar_url=COALESCE(excluded.avatar_url, authors.avatar_url),
               banner_url=COALESCE(excluded.banner_url, authors.banner_url),
               -- Embedded tweet authors can omit verification and arrive as
               -- `false`. Never let that partial shape erase a richer
               -- verified profile already cached for the same account.
               verified=CASE WHEN excluded.verified <> 0 THEN 1 ELSE authors.verified END,
               bio=COALESCE(excluded.bio, authors.bio),
               followers_count=COALESCE(excluded.followers_count, authors.followers_count),
               following_count=COALESCE(excluded.following_count, authors.following_count),
               location=COALESCE(excluded.location, authors.location),
               website=COALESCE(excluded.website, authors.website),
               joined_at=COALESCE(excluded.joined_at, authors.joined_at),
               posts_count=COALESCE(excluded.posts_count, authors.posts_count),
               updated_at=excluded.updated_at",
            params![
                a.id, a.username, a.display_name, a.avatar_url, a.banner_url,
                a.verified as i64, a.bio,
                a.followers_count.map(|v| v as i64),
                a.following_count.map(|v| v as i64),
                a.location, a.website, a.joined_at,
                a.posts_count.map(|v| v as i64),
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Store a page. Post ID is the deduplication key: re-fetching a post
    /// updates it in place and never creates a duplicate row.
    ///
    /// For [`BOOKMARKS_FEED`] the *order* of `page.posts` is recorded as well —
    /// see [`Self::record_bookmark_order`]. That order is the only bookmark
    /// chronology that exists anywhere in the payload, so it has to be captured
    /// at the moment the page arrives or it is gone.
    pub fn save_feed_page(&self, feed: &str, page: &FeedPage) -> AppResult<usize> {
        let mut inserted = 0usize;
        let now = Utc::now().to_rfc3339();
        let mut conn = self.conn.lock().unwrap();
        // A page is one logical cache update. One transaction removes the
        // implicit commit per author/post/feed row and prevents a half-written
        // page from being visible when one row fails.
        let tx = conn.transaction()?;
        for (idx, post) in page.posts.iter().enumerate() {
            Self::upsert_author_conn(&tx, &post.author)?;
            if let Some(rb) = &post.reposted_by {
                Self::upsert_author_conn(&tx, rb)?;
            }
            tx.execute(
                "INSERT INTO posts (id, text, author_id, created_at, lang, is_repost, reposted_by_json,
                    is_promoted, quoted_json, metrics_json, media_json, url, is_article, article_title,
                    in_reply_to, provider, first_fetched_at, last_updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
                 ON CONFLICT(id) DO UPDATE SET
                    author_id=excluded.author_id,
                    text=excluded.text,
                    created_at=excluded.created_at,
                    lang=excluded.lang,
                    is_repost=excluded.is_repost,
                    reposted_by_json=excluded.reposted_by_json,
                    is_promoted=excluded.is_promoted,
                    quoted_json=excluded.quoted_json,
                    metrics_json=excluded.metrics_json,
                    media_json=excluded.media_json,
                    url=excluded.url,
                    is_article=excluded.is_article,
                    article_title=excluded.article_title,
                    in_reply_to=excluded.in_reply_to,
                    provider=excluded.provider,
                    last_updated_at=excluded.last_updated_at",
                params![
                    post.id,
                    post.text,
                    post.author.id,
                    post.created_at,
                    post.lang,
                    post.is_repost as i64,
                    post.reposted_by.as_ref().map(|r| serde_json::to_string(r).unwrap_or_default()),
                    post.is_promoted as i64,
                    post.quoted.as_ref().map(|q| serde_json::to_string(q).unwrap_or_default()),
                    serde_json::to_string(&post.metrics).unwrap_or_default(),
                    serde_json::to_string(&post.media).unwrap_or_default(),
                    post.url,
                    post.is_article as i64,
                    post.article_title,
                    post.in_reply_to,
                    post.provider,
                    now,
                    now,
                ],
            )?;
            tx.execute(
                "INSERT INTO feed_entries (feed, post_id, position, fetched_at) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(feed, post_id) DO UPDATE SET fetched_at=excluded.fetched_at",
                params![feed, post.id, idx as i64, now],
            )?;
            inserted += 1;
        }
        tx.execute(
            "INSERT INTO sync_state (feed, cursor, last_sync_at, last_error) VALUES (?1,?2,?3,NULL)
             ON CONFLICT(feed) DO UPDATE SET cursor=excluded.cursor, last_sync_at=excluded.last_sync_at, last_error=NULL",
            params![feed, page.cursor, now],
        )?;
        tx.commit()?;
        drop(conn);
        if feed == BOOKMARKS_FEED {
            let ids: Vec<String> = page.posts.iter().map(|p| p.id.clone()).collect();
            self.record_bookmark_order(&ids)?;
        }
        Ok(inserted)
    }

    // -- bookmark order ----------------------------------------------------

    /// Record the order X returned the bookmark timeline in.
    ///
    /// `ids` arrives in source order, most recently bookmarked first, exactly
    /// as the backend emitted it. Nothing about it is re-sorted on the way in.
    ///
    /// `bookmarks` has no cursor, so every fetch is the top of the list again.
    /// The merge rule follows from that: the ids just returned take the first
    /// positions in the order they were returned, and ids this session has seen
    /// before but that were not in this batch keep their existing relative
    /// order behind them. A previously seen bookmark missing from a fresh top-N
    /// is below that batch's tail, so appending it is the truthful placement —
    /// and it is a placement, not a claim about when it was bookmarked.
    ///
    /// The whole table is rewritten because `seq` is a *position*: inserting a
    /// new bookmark at the top moves everything below it down, and a position
    /// that is not renumbered is a position that is wrong.
    pub fn record_bookmark_order(&self, ids: &[String]) -> AppResult<usize> {
        let mut fresh: Vec<String> = Vec::with_capacity(ids.len());
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if seen.insert(id.as_str()) {
                fresh.push(id.clone());
            }
        }

        let conn = self.conn.lock().unwrap();
        let mut trailing: Vec<String> = {
            let mut stmt = conn.prepare("SELECT post_id FROM bookmark_order ORDER BY seq ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.filter_map(Result::ok).collect()
        };
        trailing.retain(|id| !seen.contains(id.as_str()));

        conn.execute("DELETE FROM bookmark_order", [])?;
        {
            let mut stmt =
                conn.prepare("INSERT INTO bookmark_order (post_id, seq) VALUES (?1, ?2)")?;
            for (i, id) in fresh.iter().chain(trailing.iter()).enumerate() {
                stmt.execute(params![id, i as i64])?;
            }
        }
        Ok(fresh.len() + trailing.len())
    }

    /// Position in the bookmark timeline, or `None` for a post that has never
    /// been seen in one. Exposed for tests and diagnostics.
    pub fn bookmark_position(&self, post_id: &str) -> AppResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<i64> = conn
            .query_row(
                "SELECT seq FROM bookmark_order WHERE post_id = ?1",
                params![post_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v)
    }

    /// Remove a post from the session's bookmark index after X confirmed the
    /// remote unbookmark. The post row itself is shared with other feeds and
    /// must remain available there.
    pub fn remove_bookmark(&self, post_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let position: Option<i64> = conn
            .query_row(
                "SELECT seq FROM bookmark_order WHERE post_id = ?1",
                params![post_id],
                |r| r.get(0),
            )
            .optional()?;
        conn.execute(
            "DELETE FROM feed_entries WHERE feed = ?1 AND post_id = ?2",
            params![BOOKMARKS_FEED, post_id],
        )?;
        conn.execute("DELETE FROM bookmark_order WHERE post_id = ?1", params![post_id])?;
        if let Some(position) = position {
            conn.execute(
                "UPDATE bookmark_order SET seq = seq - 1 WHERE seq > ?1",
                params![position],
            )?;
        }
        Ok(())
    }

    // -- reading -----------------------------------------------------------

    fn row_to_post(row: &rusqlite::Row<'_>) -> rusqlite::Result<Post> {
        let metrics: PostMetrics = row
            .get::<_, Option<String>>("metrics_json")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let media: Vec<PostMedia> = row
            .get::<_, Option<String>>("media_json")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let quoted: Option<Box<QuotedPost>> = row
            .get::<_, Option<String>>("quoted_json")?
            .and_then(|s| serde_json::from_str(&s).ok());
        let reposted_by: Option<Author> = row
            .get::<_, Option<String>>("reposted_by_json")?
            .and_then(|s| serde_json::from_str(&s).ok());

        Ok(Post {
            id: row.get("id")?,
            text: row.get("text")?,
            author: Author {
                id: row.get("author_id")?,
                username: row.get("username").unwrap_or_default(),
                display_name: row.get("display_name").unwrap_or_default(),
                avatar_url: row.get("avatar_url").ok(),
                banner_url: row.get("banner_url").ok(),
                verified: row.get::<_, i64>("verified").unwrap_or(0) == 1,
                bio: row.get("bio").ok(),
                followers_count: row.get::<_, i64>("followers_count").ok().map(|v| v as u64),
                following_count: row.get::<_, i64>("following_count").ok().map(|v| v as u64),
                location: row.get("location").ok(),
                website: row.get("website").ok(),
                joined_at: row.get("joined_at").ok(),
                posts_count: row.get::<_, i64>("posts_count").ok().map(|v| v as u64),
            },
            created_at: row.get("created_at")?,
            lang: row.get("lang")?,
            is_repost: row.get::<_, i64>("is_repost")? == 1,
            reposted_by,
            is_promoted: row.get::<_, i64>("is_promoted")? == 1,
            quoted,
            metrics,
            media,
            url: row.get("url")?,
            is_article: row.get::<_, i64>("is_article")? == 1,
            article_title: row.get("article_title")?,
            in_reply_to: row.get("in_reply_to")?,
            provider: row.get("provider")?,
        })
    }

    const SELECT_POST: &'static str =
        "SELECT p.*, a.username, a.display_name, a.avatar_url, a.banner_url,
            a.verified, a.bio, a.followers_count, a.following_count,
            a.location, a.website, a.joined_at, a.posts_count,
            COALESCE(r.is_read,0) AS is_read
        FROM posts p
        JOIN authors a ON a.id = p.author_id
        LEFT JOIN read_states r ON r.post_id = p.id";

    /// Load a cached feed, applying filters in Rust so nothing is deleted.
    ///
    /// Ordering is per-feed rather than global. Every timeline X serves is in
    /// publication order except the bookmark timeline, which is in the order
    /// things were bookmarked — so that one reads its recorded position instead.
    /// A bookmarked post with no recorded position sorts last rather than
    /// first: it is a row this session never saw in a bookmark page, and
    /// guessing it belongs at the top would be inventing the very ordering this
    /// table exists to stop being invented.
    pub fn search_cached_posts(&self, query: &str, offset: i64, limit: i64) -> AppResult<Vec<Post>> {
        if query.trim().is_empty() { return Ok(Vec::new()); }
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE p.id NOT IN (SELECT post_id FROM hidden_posts)
            AND (instr(lower(p.text),lower(?1)) > 0 OR instr(lower(a.username),lower(?1)) > 0 OR instr(lower(a.display_name),lower(?1)) > 0)
            ORDER BY p.created_at DESC,p.id DESC LIMIT ?2 OFFSET ?3", Self::SELECT_POST);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![query.trim(),limit.clamp(1,51),offset.max(0)], Self::row_to_post)?;
        Ok(rows.collect::<Result<Vec<_>,_>>()?)
    }
    pub fn load_feed(&self, feed: &str, filters: &FeedFilters, limit: i64) -> AppResult<Vec<Post>> {
        let target = usize::try_from(limit).unwrap_or(0);
        if target == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let (extra_join, order_by) = if feed == BOOKMARKS_FEED {
            (
                "LEFT JOIN bookmark_order b ON b.post_id = p.id",
                "ORDER BY b.seq IS NULL ASC, b.seq ASC, p.created_at DESC",
            )
        } else {
            ("", "ORDER BY p.created_at DESC")
        };
        let sql = format!(
            "{} JOIN feed_entries f ON f.post_id = p.id {}
             WHERE f.feed = ?1 AND p.id NOT IN (SELECT post_id FROM hidden_posts)
             {} LIMIT ?2 OFFSET ?3",
            Self::SELECT_POST,
            extra_join,
            order_by
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut out = Vec::new();
        let batch = i64::try_from(target.clamp(64, 512)).unwrap_or(512);
        let mut offset = 0i64;
        loop {
            let mut rows = stmt.query(params![feed, batch, offset])?;
            let mut scanned = 0i64;
            while let Some(row) = rows.next()? {
                scanned += 1;
                let read: i64 = row.get("is_read").unwrap_or(0);
                let post = Self::row_to_post(row)?;
                if !passes(&post, read == 1, filters) {
                    continue;
                }
                out.push(post);
                if out.len() >= target {
                    return Ok(out);
                }
            }
            if scanned < batch {
                break;
            }
            offset = offset.saturating_add(scanned);
        }
        Ok(out)
    }

    /// Load one bounded page from the complete bookmark order.
    ///
    /// This is deliberately a keyset-style walk over `bookmark_order`, not an
    /// OFFSET query that asks Rust/IPC/React Query to carry the whole
    /// collection. Filters are applied while scanning, and the scan advances
    /// by the bookmark sequence so a page remains bounded even when the
    /// account has a very large bookmark collection or a restrictive filter.
    pub fn load_bookmark_slice(
        &self,
        filters: &FeedFilters,
        request: &BookmarkSliceRequest,
        sync_complete: bool,
    ) -> AppResult<BookmarkSlice> {
        const PAGE_MAX: i64 = 80;
        const SCAN_BATCH: i64 = 256;
        let target = request.limit.clamp(1, PAGE_MAX) as usize;
        let direction = request.direction;

        let (posts, positions, total_discovered) = {
            let conn = self.conn.lock().unwrap();
            let total: i64 = conn.query_row(
                "SELECT COUNT(*)
                 FROM bookmark_order b
                 JOIN feed_entries f ON f.post_id = b.post_id
                 WHERE f.feed = ?1",
                params![BOOKMARKS_FEED],
                |row| row.get(0),
            )?;
            if total == 0 {
                (Vec::new(), Vec::new(), 0)
            } else {
                let backwards = matches!(direction, BookmarkDirection::Older | BookmarkDirection::Newest);
                let mut cursor = if backwards {
                    request.anchor_position.unwrap_or(total).clamp(0, total)
                } else {
                    request.anchor_position.unwrap_or(-1).clamp(-1, total - 1)
                };
                let select = Self::SELECT_POST.replace(
                    "SELECT p.*,",
                    "SELECT b.seq AS bookmark_seq, p.* ,",
                );
                let (operator, order) = if backwards { ("<", "DESC") } else { (">", "ASC") };
                let sql = format!(
                    "{select}
                     JOIN feed_entries f ON f.post_id = p.id
                     JOIN bookmark_order b ON b.post_id = p.id
                     WHERE f.feed = ?1
                       AND p.id NOT IN (SELECT post_id FROM hidden_posts)
                       AND b.seq {operator} ?2
                     ORDER BY b.seq {order}
                     LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let mut selected: Vec<(i64, Post)> = Vec::with_capacity(target);

                loop {
                    let mut rows = stmt.query(params![BOOKMARKS_FEED, cursor, SCAN_BATCH])?;
                    let mut batch: Vec<(i64, Post, bool)> = Vec::new();
                    while let Some(row) = rows.next()? {
                        let position: i64 = row.get("bookmark_seq")?;
                        let read = row.get::<_, i64>("is_read").unwrap_or(0) == 1;
                        let post = Self::row_to_post(row)?;
                        batch.push((position, post, read));
                    }
                    if batch.is_empty() {
                        break;
                    }

                    for (position, post, read) in &batch {
                        if passes(post, *read, filters) {
                            selected.push((*position, post.clone()));
                            if selected.len() >= target {
                                break;
                            }
                        }
                    }
                    if selected.len() >= target || batch.len() < SCAN_BATCH as usize {
                        break;
                    }
                    cursor = if backwards {
                        batch.last().map(|(position, _, _)| *position).unwrap_or(cursor)
                    } else {
                        batch.last().map(|(position, _, _)| *position).unwrap_or(cursor)
                    };
                }

                if backwards {
                    selected.reverse();
                }
                let positions = selected.iter().map(|(position, _)| *position).collect::<Vec<_>>();
                let posts = selected.into_iter().map(|(_, post)| post).collect::<Vec<_>>();
                (posts, positions, total)
            }
        };

        // The position metadata needed for navigation is based on the rows
        // returned, while the boundary flags need the complete scanned range.
        // Re-read only the small surrounding existence checks; never load the
        // collection into memory to calculate these booleans.
        let (has_older, has_newer) = if total_discovered == 0 || positions.is_empty() {
            (false, false)
        } else {
            let first = positions[0];
            let last = *positions.last().unwrap_or(&first);
            let conn = self.conn.lock().unwrap();
            let exists_before: i64 = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM bookmark_order b
                    JOIN feed_entries f ON f.post_id = b.post_id
                    WHERE f.feed = ?1 AND b.seq < ?2
                )",
                params![BOOKMARKS_FEED, first],
                |row| row.get(0),
            )?;
            let exists_after: i64 = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM bookmark_order b
                    JOIN feed_entries f ON f.post_id = b.post_id
                    WHERE f.feed = ?1 AND b.seq > ?2
                )",
                params![BOOKMARKS_FEED, last],
                |row| row.get(0),
            )?;
            (exists_before == 1, exists_after == 1)
        };
        let read_ids = self.read_ids_for_posts(&posts)?;
        Ok(BookmarkSlice {
            first_position: positions.first().copied(),
            last_position: positions.last().copied(),
            total_discovered,
            sync_complete,
            has_older,
            has_newer,
            read_ids,
            posts,
        })
    }

    /// Apply the same visibility rules used by a cached feed to a freshly
    /// fetched provider page without rereading the entire accumulated feed.
    ///
    /// Cursor continuation already gives us the new rows in source order. The
    /// old path saved those rows and then loaded every older row again just to
    /// construct the response. Keeping this operation page-scoped preserves
    /// hidden/read/filter semantics while making the bridge payload proportional
    /// to the one page the provider actually returned.
    pub fn filter_feed_page(
        &self,
        posts: Vec<Post>,
        filters: &FeedFilters,
        limit: i64,
    ) -> AppResult<Vec<Post>> {
        let target = usize::try_from(limit).unwrap_or(0);
        if target == 0 || posts.is_empty() {
            return Ok(Vec::new());
        }

        let read: std::collections::HashSet<String> =
            self.read_ids_for_posts(&posts)?.into_iter().collect();
        let hidden = self.hidden_ids_for_posts(&posts)?;

        Ok(posts
            .into_iter()
            .filter(|post| {
                !hidden.contains(&post.id) && passes(post, read.contains(&post.id), filters)
            })
            .take(target)
            .collect())
    }

    fn hidden_ids_for_posts(&self, posts: &[Post]) -> AppResult<std::collections::HashSet<String>> {
        if posts.is_empty() {
            return Ok(std::collections::HashSet::new());
        }

        // Keep this below SQLite's usual variable ceiling even if a future
        // caller uses a larger continuation page.
        const CHUNK: usize = 900;
        let conn = self.conn.lock().unwrap();
        let mut hidden = std::collections::HashSet::new();
        for chunk in posts.chunks(CHUNK) {
            let placeholders = (1..=chunk.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("SELECT post_id FROM hidden_posts WHERE post_id IN ({placeholders})");
            let values: Vec<&dyn ToSql> = chunk.iter().map(|post| &post.id as &dyn ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(values.as_slice(), |row| row.get::<_, String>(0))?;
            hidden.extend(rows.filter_map(|row| row.ok()));
        }
        Ok(hidden)
    }

    pub fn get_post(&self, id: &str) -> AppResult<Option<Post>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE p.id = ?1", Self::SELECT_POST);
        let mut stmt = conn.prepare(&sql)?;
        let post = stmt.query_row(params![id], Self::row_to_post).optional()?;
        Ok(post)
    }

    /// A detail refresh updates cached bytes without touching bookmark order or feed membership.
    pub fn update_cached_post(&self,post:&Post)->AppResult<()> {
        self.upsert_author(&post.author)?;
        self.conn.lock().unwrap().execute("UPDATE posts SET text=?1,media_json=?2,article_title=COALESCE(?3,article_title),is_article=CASE WHEN ?4<>0 THEN 1 ELSE is_article END,last_updated_at=?5,quoted_json=?7 WHERE id=?6",
            params![post.text,serde_json::to_string(&post.media).unwrap_or_default(),post.article_title,post.is_article as i64,Utc::now().to_rfc3339(),post.id,post.quoted.as_ref().map(|q|serde_json::to_string(q).unwrap_or_default())])?;
        Ok(())
    }

    pub fn posts_by_authors(&self, author_ids: &[String], limit: i64) -> AppResult<Vec<Post>> {
        if author_ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = author_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "{} WHERE p.author_id IN ({}) AND p.id NOT IN (SELECT post_id FROM hidden_posts)
             ORDER BY p.created_at DESC LIMIT {}",
            Self::SELECT_POST,
            placeholders,
            limit
        );
        let mut stmt = conn.prepare(&sql)?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = author_ids
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let rows = stmt.query_map(params_vec.as_slice(), Self::row_to_post)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// The combined timeline of a set of accounts.
    ///
    /// Not [`Self::posts_by_authors`], which is a flat `created_at DESC` read
    /// and is why a group feed showed roughly one post per account: whatever
    /// happened to be cached, in whatever quantity, with the most prolific
    /// account taking as much of the page as it liked.
    ///
    /// Filters run in Rust for the same reason they do everywhere else — so
    /// nothing is deleted — and the result is interleaved by
    /// [`interleave_by_author`] before the limit is applied, so the limit
    /// truncates a fair page rather than an unfair one.
    pub fn group_timeline(
        &self,
        author_ids: &[String],
        filters: &FeedFilters,
        limit: i64,
    ) -> AppResult<Vec<Post>> {
        if author_ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = author_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "{} WHERE p.author_id IN ({placeholders})
               AND p.id NOT IN (SELECT post_id FROM hidden_posts)
             ORDER BY p.created_at DESC",
            Self::SELECT_POST
        );
        let mut stmt = conn.prepare(&sql)?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = author_ids
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let rows = stmt.query_map(params_vec.as_slice(), |r| {
            let read: i64 = r.get("is_read").unwrap_or(0);
            Ok((Self::row_to_post(r)?, read == 1))
        })?;

        let mut kept = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in rows {
            let (post, is_read) = row?;
            if !passes(&post, is_read, filters) {
                continue;
            }
            // Post id is the deduplication key. A repost of a group member by
            // another group member reaches this query twice.
            if seen.insert(post.id.clone()) {
                kept.push(post);
            }
        }
        let mut merged = interleave_by_author(kept);
        merged.truncate(limit.max(0) as usize);
        Ok(merged)
    }

    /// The cached profiles for a set of ids, in the order asked for.
    pub fn authors_by_ids(&self, ids: &[String]) -> AppResult<Vec<Author>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM authors WHERE id IN ({placeholders})"
        ))?;
        let p: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(p.as_slice(), row_to_author)?;
        let found: Vec<Author> = rows.filter_map(|r| r.ok()).collect();
        Ok(ids
            .iter()
            .filter_map(|id| found.iter().find(|a| &a.id == id).cloned())
            .collect())
    }

    // No `search_local`. The Search page it backed is gone, and a query method
    // with no caller is a query method nobody is maintaining.

    // -- state -------------------------------------------------------------

    pub fn set_read(&self, post_id: &str, read: bool) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let was_read = conn
            .query_row(
                "SELECT is_read FROM read_states WHERE post_id = ?1",
                params![post_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            != 0;
        conn.execute(
            "INSERT INTO read_states (post_id, is_read, read_at) VALUES (?1,?2,?3)
             ON CONFLICT(post_id) DO UPDATE SET is_read=excluded.is_read, read_at=excluded.read_at",
            params![post_id, read as i64, now],
        )?;
        // Reading activity is a transition, not a count of duplicate writes.
        // IntersectionObservers on two views can report the same already-read
        // card; that must not inflate the dashboard's "read today" number.
        if read && !was_read {
            conn.execute(
                "INSERT INTO reading_activity (post_id, read_at) VALUES (?1,?2)",
                params![post_id, now],
            )?;
        }
        Ok(())
    }

    pub fn is_read(&self, post_id: &str) -> AppResult<bool> {
        let conn = self.conn.lock().unwrap();
        let v: Option<i64> = conn
            .query_row(
                "SELECT is_read FROM read_states WHERE post_id = ?1",
                params![post_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.unwrap_or(0) == 1)
    }

    pub fn read_ids(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT post_id FROM read_states WHERE is_read = 1")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Read state for one response page, rather than every post read in this
    /// session.
    ///
    /// Feed responses only need to decorate the posts they carry. Returning the
    /// entire `read_states` table made every refresh grow with the reader's
    /// history and needlessly copied those ids through SQLite, Rust, JSON and
    /// the WebView. Keep the full-table [`read_ids`] command for screens that
    /// explicitly need it, but keep the hot feed path bounded by its page size.
    pub fn read_ids_for_posts(&self, posts: &[Post]) -> AppResult<Vec<String>> {
        if posts.is_empty() {
            return Ok(Vec::new());
        }

        // SQLite's default variable ceiling is commonly 999. Chunking keeps
        // this safe even if a future caller asks for a much larger page.
        const CHUNK: usize = 900;
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::new();
        for chunk in posts.chunks(CHUNK) {
            let placeholders = (1..=chunk.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT post_id FROM read_states WHERE is_read = 1 AND post_id IN ({placeholders})"
            );
            let values: Vec<&dyn ToSql> = chunk.iter().map(|post| &post.id as &dyn ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(values.as_slice(), |row| row.get::<_, String>(0))?;
            out.extend(rows.filter_map(|row| row.ok()));
        }
        Ok(out)
    }

    pub fn hide_post(&self, post_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO hidden_posts (post_id, hidden_at) VALUES (?1,?2)",
            params![post_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn unhide_post(&self, post_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM hidden_posts WHERE post_id = ?1",
            params![post_id],
        )?;
        Ok(())
    }

    pub fn pin_account(&self, author_id: &str, pinned: bool) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        if pinned {
            conn.execute(
                "INSERT OR REPLACE INTO pinned_accounts (author_id, pinned_at) VALUES (?1,?2)",
                params![author_id, Utc::now().to_rfc3339()],
            )?;
        } else {
            conn.execute(
                "DELETE FROM pinned_accounts WHERE author_id = ?1",
                params![author_id],
            )?;
        }
        Ok(())
    }

    pub fn pinned_accounts(&self) -> AppResult<Vec<Author>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT a.* FROM authors a JOIN pinned_accounts p ON p.author_id = a.id ORDER BY p.pinned_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_author)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn all_authors(&self) -> AppResult<Vec<Author>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT * FROM authors ORDER BY display_name COLLATE NOCASE")?;
        let rows = stmt.query_map([], row_to_author)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // -- who the connected account actually follows -------------------------

    /// Record a batch of followed accounts in the order the backend returned
    /// them.
    ///
    /// `complete` is the difference between a first batch and a finished
    /// traversal, and it decides whether absence means anything. A partial
    /// batch says nothing about the accounts it did not reach, so it only adds;
    /// a complete traversal has seen the whole list, so an account missing from
    /// it is one the user no longer follows and its row is removed.
    ///
    /// `offset` is where this batch starts in the whole list, so a traversal
    /// that arrives in pieces still produces one continuous ordering rather
    /// than several runs that all begin at zero.
    ///
    /// `sync_id` identifies the traversal, not the batch. Every batch of one
    /// traversal carries the same id, which is what lets the final batch prune
    /// safely: pruning on a per-call timestamp would delete the earlier batches
    /// of the very traversal that is finishing.
    ///
    /// Within a batch the first occurrence of an id wins — twitter-cli
    /// assembles this list from several internal pages and a repeat across a
    /// page boundary must not push the account down. Across batches the newer
    /// statement wins, because a later batch is a fresher reading of the same
    /// list.
    pub fn merge_following_accounts(
        &self,
        authors: &[Author],
        offset: usize,
        sync_id: &str,
        complete: bool,
    ) -> AppResult<usize> {
        for a in authors {
            self.upsert_author(a)?;
        }
        let now = sync_id;
        let conn = self.conn.lock().unwrap();
        let mut seen: Vec<&str> = Vec::with_capacity(authors.len());
        {
            let mut stmt = conn.prepare(
                "INSERT INTO following_accounts (author_id, position, synced_at) VALUES (?1,?2,?3)
                 ON CONFLICT(author_id) DO UPDATE SET
                    position=excluded.position,
                    synced_at=excluded.synced_at",
            )?;
            for (i, a) in authors.iter().enumerate() {
                if seen.contains(&a.id.as_str()) {
                    continue;
                }
                seen.push(&a.id);
                stmt.execute(params![a.id, (offset + i) as i64, now])?;
            }
        }
        if complete {
            conn.execute(
                "DELETE FROM following_accounts WHERE synced_at <> ?1",
                params![now],
            )?;
        }
        Ok(seen.len())
    }

    /// Everything the connected account follows, in X's own order.
    pub fn following_accounts(&self) -> AppResult<Vec<Author>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT a.* FROM authors a
             JOIN following_accounts f ON f.author_id = a.id
             ORDER BY f.position ASC",
        )?;
        let rows = stmt.query_map([], row_to_author)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn following_count(&self) -> AppResult<i64> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT COUNT(*) FROM following_accounts", [], |r| r.get(0))?)
    }

    /// Whether an account is in the connected user's cached Following list.
    ///
    /// List membership writes use this as a backend guard as well as relying
    /// on the picker UI. A direct Tauri invocation must not be able to add an
    /// arbitrary public account that was never followed.
    pub fn is_following(&self, author_id: &str) -> AppResult<bool> {
        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM following_accounts WHERE author_id = ?1)",
            params![author_id],
            |row| row.get(0),
        )?;
        Ok(exists != 0)
    }

    /// Add or remove one account, after a follow or unfollow succeeded.
    ///
    /// Reconciling immediately rather than waiting for the next traversal is
    /// what stops an account the user just unfollowed from still being offered
    /// as a group candidate for the rest of the session. A new follow goes to
    /// the top, which is where X puts it.
    pub fn set_following(&self, author_id: &str, followed: bool) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        if followed {
            conn.execute(
                "INSERT INTO following_accounts (author_id, position, synced_at)
                 VALUES (?1, COALESCE((SELECT MIN(position) FROM following_accounts), 0) - 1, ?2)
                 ON CONFLICT(author_id) DO UPDATE SET synced_at=excluded.synced_at",
                params![author_id, Utc::now().to_rfc3339()],
            )?;
        } else {
            conn.execute(
                "DELETE FROM following_accounts WHERE author_id = ?1",
                params![author_id],
            )?;
        }
        Ok(())
    }

    /// The cached id for a handle, if this session has seen the account.
    ///
    /// Case-insensitive because X treats handles that way and the same account
    /// arrives spelled differently in different payloads.
    pub fn author_id_for_username(&self, username: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT id FROM authors WHERE username = ?1 COLLATE NOCASE LIMIT 1",
                params![username],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v)
    }

    /// Reconcile the Following list after a follow or unfollow succeeded.
    ///
    /// Returns false when the handle is not one this session has cached, which
    /// only happens for a follow of somebody who was never on screen. The
    /// caller marks the list incomplete in that case rather than inventing an
    /// author row from a handle.
    pub fn set_following_by_username(&self, username: &str, followed: bool) -> AppResult<bool> {
        let Some(id) = self.author_id_for_username(username)? else {
            return Ok(false);
        };
        self.set_following(&id, followed)?;
        Ok(true)
    }

    /// Drop rows that a finished traversal did not see.
    ///
    /// Separate from [`Self::merge_following_accounts`] because pruning is only
    /// safe once the *whole* list has been read. A traversal that stopped at
    /// the request ceiling, or was cancelled, has not proved anything about the
    /// accounts it never reached — deleting them would silently shrink the
    /// group member picker on a large account.
    pub fn prune_following_accounts(&self, sync_id: &str) -> AppResult<usize> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "DELETE FROM following_accounts WHERE synced_at <> ?1",
            params![sync_id],
        )?)
    }

    /// Forget the traversal. Used on account switch, where the previous
    /// account's Following list is not merely stale but somebody else's.
    pub fn clear_following_accounts(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM following_accounts", [])?;
        Ok(())
    }

    /// Who may be added to a group, and who is already in it.
    ///
    /// Candidates come from [`Self::following_accounts`] and from nowhere else:
    /// the picker used to be backed by every author ever seen, so a reposter or
    /// a search hit the user has no relationship with appeared alongside the
    /// accounts they follow.
    ///
    /// Current members are unioned in even when they are absent from the
    /// Following list, flagged `following: false`. Silently dropping them would
    /// mean an unfollow quietly edits a group the user built, and the member
    /// would vanish from the picker while still being in the group.
    pub fn group_candidates(&self, group_id: &str) -> AppResult<Vec<GroupCandidate>> {
        let members = self.group_member_ids(group_id)?;
        let mut out: Vec<GroupCandidate> = self
            .following_accounts()?
            .into_iter()
            .map(|author| GroupCandidate {
                member: members.contains(&author.id),
                following: true,
                author,
            })
            .collect();

        let present: std::collections::HashSet<String> =
            out.iter().map(|c| c.author.id.clone()).collect();
        let orphans: Vec<String> = members
            .into_iter()
            .filter(|id| !present.contains(id))
            .collect();
        if !orphans.is_empty() {
            let conn = self.conn.lock().unwrap();
            let placeholders = orphans.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let mut stmt = conn.prepare(&format!(
                "SELECT * FROM authors WHERE id IN ({placeholders})"
            ))?;
            let p: Vec<&dyn rusqlite::ToSql> =
                orphans.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let rows = stmt.query_map(p.as_slice(), row_to_author)?;
            for author in rows.filter_map(|r| r.ok()) {
                out.push(GroupCandidate {
                    author,
                    following: false,
                    member: true,
                });
            }
        }
        Ok(out)
    }

    // -- groups ------------------------------------------------------------

    pub fn create_group(&self, id: &str, name: &str, color: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO custom_groups (id, name, color, created_at) VALUES (?1,?2,?3,?4)",
            params![id, name, color, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn delete_group(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM custom_groups WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM group_members WHERE group_id = ?1", params![id])?;
        Ok(())
    }

    pub fn update_group(&self, id: &str, name: &str, color: &str) -> AppResult<()> {
        let name = name.trim();
        if name.is_empty() || name.len() > 120 {
            return Err(AppError::new(ErrorCode::ApiError, "list name is invalid"));
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE custom_groups SET name = ?1, color = ?2 WHERE id = ?3",
            params![name, color, id],
        )?;
        Ok(())
    }

    /// Remove the session copy of list definitions before restoring the
    /// definitions for a different account.
    pub fn clear_groups(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM group_members; DELETE FROM custom_groups;")?;
        Ok(())
    }

    pub fn set_group_member(&self, group_id: &str, author_id: &str, member: bool) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        if member {
            conn.execute(
                "INSERT OR REPLACE INTO group_members (group_id, author_id) VALUES (?1,?2)",
                params![group_id, author_id],
            )?;
        } else {
            conn.execute(
                "DELETE FROM group_members WHERE group_id = ?1 AND author_id = ?2",
                params![group_id, author_id],
            )?;
        }
        Ok(())
    }

    pub fn groups(&self) -> AppResult<Vec<Group>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT g.id, g.name, g.color, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
             FROM custom_groups g ORDER BY g.created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Group {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                member_count: r.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn group_member_ids(&self, group_id: &str) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT author_id FROM group_members WHERE group_id = ?1")?;
        let rows = stmt.query_map(params![group_id], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // -- settings / health -------------------------------------------------

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1,?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v)
    }

    pub fn all_settings(&self) -> AppResult<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn record_health(&self, provider: &str, status: &str, message: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO provider_health (checked_at, provider, status, message) VALUES (?1,?2,?3,?4)",
            params![
                Utc::now().to_rfc3339(),
                provider,
                status,
                crate::security::sanitize(message)
            ],
        )?;
        Ok(())
    }

    pub fn muted_words(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT word FROM muted_words ORDER BY word")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_muted_word(&self, word: &str, muted: bool) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        if muted {
            conn.execute(
                "INSERT OR REPLACE INTO muted_words (word, created_at) VALUES (?1,?2)",
                params![word.to_lowercase(), Utc::now().to_rfc3339()],
            )?;
        } else {
            conn.execute(
                "DELETE FROM muted_words WHERE word = ?1",
                params![word.to_lowercase()],
            )?;
        }
        Ok(())
    }

    pub fn last_sync(&self, feed: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT last_sync_at FROM sync_state WHERE feed = ?1",
                params![feed],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v)
    }

    pub fn cursor(&self, feed: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT cursor FROM sync_state WHERE feed = ?1",
                params![feed],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.flatten_empty())
    }

    pub fn stats(&self) -> AppResult<DashboardStats> {
        let conn = self.conn.lock().unwrap();
        let one =
            |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0) };
        let today = Utc::now().format("%Y-%m-%d").to_string();
        let read_today: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM reading_activity WHERE read_at LIKE ?1",
                params![format!("{today}%")],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let last_sync: Option<String> = conn
            .query_row(
                "SELECT last_sync_at FROM sync_state ORDER BY last_sync_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);

        Ok(DashboardStats {
            total_posts: one("SELECT COUNT(*) FROM posts"),
            unread_count: one(
                "SELECT COUNT(*) FROM posts p LEFT JOIN read_states r ON r.post_id = p.id
                 WHERE COALESCE(r.is_read,0) = 0 AND p.id NOT IN (SELECT post_id FROM hidden_posts)",
            ),
            new_count: one(
                "SELECT COUNT(*) FROM posts p LEFT JOIN read_states r ON r.post_id = p.id
                 WHERE COALESCE(r.is_read,0) = 0",
            ),
            pinned_count: one("SELECT COUNT(*) FROM pinned_accounts"),
            group_count: one("SELECT COUNT(*) FROM custom_groups"),
            hidden_count: one("SELECT COUNT(*) FROM hidden_posts"),
            read_today,
            last_sync,
            cache_bytes: one("SELECT COALESCE(SUM(LENGTH(text)),0) FROM posts"),
        })
    }

    /// The feed response only needs this one count. Calling `stats()` from
    /// every feed refresh also recalculated unread, groups, hidden posts,
    /// reading activity and cache bytes even though the dashboard owns those
    /// figures separately.
    pub fn total_posts(&self) -> AppResult<i64> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT COUNT(*) FROM posts", [], |r| r.get(0))?)
    }

    pub fn recent_activity(&self, limit: i64) -> AppResult<Vec<Post>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} JOIN reading_activity ra ON ra.post_id = p.id ORDER BY ra.read_at DESC LIMIT ?1",
            Self::SELECT_POST
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit], Self::row_to_post)?;
        let mut seen = std::collections::HashSet::new();
        Ok(rows
            .filter_map(|r| r.ok())
            .filter(|p| seen.insert(p.id.clone()))
            .collect())
    }

    /// Drop every row of fetched content.
    ///
    /// Used when switching accounts and by the Clear Cache action. This removes
    /// saved posts too: a "saved post" is a copy of somebody's content, and
    /// carrying it across an account switch would show one account's material
    /// under another's identity.
    pub fn clear_cache(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM feed_entries;
             DELETE FROM bookmark_order;
             DELETE FROM read_states;
             DELETE FROM hidden_posts;
             DELETE FROM reading_activity;
             DELETE FROM posts;
             DELETE FROM pinned_accounts;
             DELETE FROM group_members;
             DELETE FROM custom_groups;
             DELETE FROM following_accounts;
             DELETE FROM account_preferences;
             DELETE FROM saved_lists;
             DELETE FROM muted_words;
             DELETE FROM authors;
             DELETE FROM sync_state;",
        )?;
        Ok(())
    }

    // -- X Lists the user added themselves ---------------------------------
    //
    // twitter-cli cannot enumerate an account's Lists, so these are not
    // fetched content: they are the ids and names the user typed in.

    pub fn saved_lists(&self) -> AppResult<Vec<XList>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, name FROM saved_lists ORDER BY name COLLATE NOCASE")?;
        let rows = stmt.query_map([], |r| {
            Ok(XList {
                id: r.get("id")?,
                name: r.get("name")?,
                description: None,
                member_count: None,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn add_saved_list(&self, id: &str, name: &str) -> AppResult<()> {
        let name = if name.is_empty() { id } else { name };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO saved_lists (id, name, added_at) VALUES (?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name",
            params![id, name, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn remove_saved_list(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM saved_lists WHERE id = ?1", params![id])?;
        Ok(())
    }
}

trait FlattenEmpty {
    fn flatten_empty(self) -> Option<String>;
}
impl FlattenEmpty for Option<String> {
    fn flatten_empty(self) -> Option<String> {
        self.filter(|s| !s.trim().is_empty())
    }
}

fn row_to_author(r: &rusqlite::Row<'_>) -> rusqlite::Result<Author> {
    Ok(Author {
        id: r.get("id")?,
        username: r.get("username")?,
        display_name: r.get("display_name")?,
        avatar_url: r.get("avatar_url")?,
        banner_url: r.get("banner_url")?,
        verified: r.get::<_, i64>("verified")? == 1,
        bio: r.get("bio")?,
        followers_count: r
            .get::<_, Option<i64>>("followers_count")?
            .map(|v| v as u64),
        following_count: r
            .get::<_, Option<i64>>("following_count")?
            .map(|v| v as u64),
        location: r.get("location")?,
        website: r.get("website")?,
        joined_at: r.get("joined_at")?,
        posts_count: r.get::<_, Option<i64>>("posts_count")?.map(|v| v as u64),
    })
}

/// Merge several accounts' posts into one page nobody can monopolise.
///
/// `posts` arrives newest-first. Each post is given its rank *within its own
/// author's* run — newest is 0, the one before it is 1 — and the page is then
/// ordered by rank first and time second. Every account's newest post therefore
/// appears before any account's second-newest, and an account that posted
/// forty times today cannot push the rest of the group off the page.
///
/// This is a deliberate departure from strict chronology, and it is bounded:
/// within a rank the order is exactly chronological, so the page still reads as
/// a timeline rather than as a shuffle. A purely chronological merge is what
/// the old group feed did, and on any group containing one prolific account it
/// produced a page of that account.
///
/// Stable, so two posts of the same rank and the same timestamp keep the order
/// the query returned and the page does not reshuffle between reads.
pub fn interleave_by_author(posts: Vec<Post>) -> Vec<Post> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut ranked: Vec<(usize, Post)> = posts
        .into_iter()
        .map(|p| {
            let slot = counts.entry(p.author.id.clone()).or_insert(0);
            let rank = *slot;
            *slot += 1;
            (rank, p)
        })
        .collect();
    // Stability is the point, not an incidental property: within one rank the
    // posts must stay in the chronological order they arrived in. `sort_by_key`
    // is a stable sort, so round-robin across accounts is layered on top of
    // that order rather than replacing it.
    ranked.sort_by_key(|a| a.0);
    ranked.into_iter().map(|(_, p)| p).collect()
}

/// Filter predicate. Returning false hides the post from this view only —
/// the row stays in SQLite so relaxing the filter restores it.
pub fn passes(post: &Post, is_read: bool, f: &FeedFilters) -> bool {
    // Promoted content is excluded unconditionally — note this ignores
    // `f.hide_promoted` entirely. Timelines are already requested with
    // `--no-include-promoted`, and measured against the live account that
    // request is largely ignored: one 45-post following page arrived carrying
    // 20 ads. This line is therefore not a second line of defence, it is the
    // one that works, and the whole point of this application is that it is not
    // a place advertising arrives. The field survives in `FeedFilters` only so
    // an older stored filter set still deserializes; nothing can set it to a
    // value that shows an ad.
    if post.is_promoted {
        return false;
    }
    if f.hide_reposts && post.is_repost {
        return false;
    }
    if (f.hide_read || f.unread_only) && is_read {
        return false;
    }
    let has_image = post.media.iter().any(|m| m.kind == MediaKind::Image);
    let has_video = post
        .media
        .iter()
        .any(|m| matches!(m.kind, MediaKind::Video | MediaKind::Gif));
    if f.images_only && !has_image {
        return false;
    }
    if f.videos_only && !has_video {
        return false;
    }
    if f.text_only && !post.media.is_empty() {
        return false;
    }
    // No engagement threshold. The interface shows no like, repost or reply
    // count anywhere, and a filter on a number the reader is never shown is one
    // they cannot predict the effect of.
    if f.max_age_hours > 0 {
        if let Ok(created) = chrono::DateTime::parse_from_rfc3339(&post.created_at) {
            let age = Utc::now().signed_duration_since(created.with_timezone(&Utc));
            // A future timestamp has a negative age. Casting it to u64 wraps it
            // into a huge value and incorrectly hides a brand-new post.
            let max_age = i64::try_from(f.max_age_hours).unwrap_or(i64::MAX);
            if age > chrono::Duration::hours(max_age) {
                return false;
            }
        }
    }
    if !f.muted_words.is_empty() {
        let lower = post.text.to_lowercase();
        if f.muted_words
            .iter()
            .any(|w| !w.trim().is_empty() && lower.contains(&w.to_lowercase()))
        {
            return false;
        }
    }
    if !f.languages.is_empty() {
        match &post.lang {
            Some(l) if f.languages.iter().any(|x| x == l) => {}
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::mock::MockXProvider;
    use crate::providers::XDataProvider;

    fn sample_page() -> FeedPage {
        MockXProvider::new().get_following_feed(20, None).unwrap()
    }

    #[test]
    fn local_search_is_literal_paginated_hidden_aware_and_session_only() {
        let db = Db::in_memory().unwrap(); let mut page = sample_page();
        for post in &mut page.posts { post.text = "مرحبا cached 100%_complete".into(); }
        db.save_feed_page("following", &page).unwrap();
        let all = db.search_cached_posts("مرحبا",0,51).unwrap(); assert_eq!(all.len(),page.posts.len());
        assert_eq!(db.search_cached_posts("100%_complete",0,51).unwrap().len(),all.len());
        let first=db.search_cached_posts("CACHED",0,3).unwrap(); let second=db.search_cached_posts("cached",3,3).unwrap();
        assert_eq!(first.len(),3); assert!(first.iter().all(|p| !second.iter().any(|q|q.id==p.id)));
        db.hide_post(&first[0].id).unwrap(); assert_eq!(db.search_cached_posts("cached",0,51).unwrap().len(),all.len()-1);
        db.clear_cache().unwrap(); assert!(db.search_cached_posts("cached",0,51).unwrap().is_empty());
    }

    #[test]
    fn migrations_create_schema() {
        let db = Db::in_memory().unwrap();
        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn migrations_are_idempotent() {
        let db = Db::in_memory().unwrap();
        db.migrate().unwrap();
        db.migrate().unwrap();
        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
    }

    /// Posts from a fixture page that are allowed to reach a feed at all.
    ///
    /// Promoted posts are stored — hiding is never deletion — but never
    /// loaded, so a test about storage or deduplication has to compare against
    /// this rather than against the raw page length.
    fn visible_len(page: &FeedPage) -> usize {
        page.posts.iter().filter(|p| !p.is_promoted).count()
    }

    #[test]
    fn saves_and_loads_a_feed_page() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        let n = db.save_feed_page("following", &page).unwrap();
        // Everything is stored, including the promoted post.
        assert_eq!(n, page.posts.len());
        let loaded = db
            .load_feed("following", &FeedFilters::default(), 100)
            .unwrap();
        assert_eq!(loaded.len(), visible_len(&page));
    }

    #[test] fn a_detail_repair_does_not_reorder_bookmarks_or_change_membership() {
        let db=Db::in_memory().unwrap();let page=sample_page();
        db.save_feed_page("bookmarks",&page).unwrap();
        let mut post=page.posts[0].clone();let position=db.bookmark_position(&post.id).unwrap();
        post.text="Repaired original text".into();db.update_cached_post(&post).unwrap();
        assert_eq!(db.bookmark_position(&post.id).unwrap(),position);
        assert_eq!(db.get_post(&post.id).unwrap().unwrap().text,post.text);
    }

    #[test]
    fn post_id_deduplicates_across_refreshes() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        db.save_feed_page("following", &page).unwrap();
        let loaded = db
            .load_feed("following", &FeedFilters::default(), 500)
            .unwrap();
        assert_eq!(loaded.len(), visible_len(&page), "duplicates were stored");
    }

    #[test]
    fn a_refetch_updates_all_mutable_post_fields() {
        let db = Db::in_memory().unwrap();
        let mut first_page = sample_page();
        let original = first_page.posts[0].clone();
        db.save_feed_page("following", &first_page).unwrap();

        let mut updated = original.clone();
        updated.author = author("replacement-author");
        updated.text = "the provider corrected this post".into();
        updated.created_at = "2030-01-02T03:04:05Z".into();
        updated.lang = None;
        updated.is_repost = true;
        updated.reposted_by = Some(author("reposter"));
        updated.is_promoted = true;
        updated.quoted = None;
        updated.url = Some("https://x.com/replacement-author/status/updated".into());
        updated.is_article = true;
        updated.article_title = Some("Corrected title".into());
        updated.in_reply_to = Some("parent".into());
        updated.provider = "replacement-provider".into();
        first_page.posts = vec![updated.clone()];

        db.save_feed_page("following", &first_page).unwrap();
        let stored = db.get_post(&original.id).unwrap().unwrap();

        assert_eq!(stored.author.id, updated.author.id);
        assert_eq!(stored.text, updated.text);
        assert_eq!(stored.created_at, updated.created_at);
        assert_eq!(stored.lang, updated.lang);
        assert_eq!(stored.is_repost, updated.is_repost);
        assert_eq!(
            stored.reposted_by.as_ref().map(|a| &a.id),
            updated.reposted_by.as_ref().map(|a| &a.id)
        );
        assert_eq!(stored.is_promoted, updated.is_promoted);
        assert_eq!(
            stored.quoted.as_ref().map(|q| &q.id),
            updated.quoted.as_ref().map(|q| &q.id)
        );
        assert_eq!(stored.url, updated.url);
        assert_eq!(stored.is_article, updated.is_article);
        assert_eq!(stored.article_title, updated.article_title);
        assert_eq!(stored.in_reply_to, updated.in_reply_to);
        assert_eq!(stored.provider, updated.provider);
    }

    #[test]
    fn a_partial_author_update_does_not_erase_verified_status() {
        let db = Db::in_memory().unwrap();
        let mut verified = author("verified");
        verified.verified = true;
        db.upsert_author(&verified).unwrap();

        // This represents an embedded author shape that did not carry a
        // verification field and was therefore mapped to the model default.
        db.upsert_author(&author("verified")).unwrap();

        assert!(
            db.all_authors()
                .unwrap()
                .into_iter()
                .find(|a| a.id == "verified")
                .unwrap()
                .verified
        );
    }

    #[test]
    fn read_state_round_trips() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        let id = &page.posts[0].id;
        assert!(!db.is_read(id).unwrap());
        db.set_read(id, true).unwrap();
        assert!(db.is_read(id).unwrap());
    }

    #[test]
    fn page_read_state_does_not_return_unrelated_history() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        db.set_read(&page.posts[0].id, true).unwrap();
        db.set_read("old-post-from-an-earlier-page", true).unwrap();

        let ids = db.read_ids_for_posts(&page.posts[1..]).unwrap();
        assert!(
            ids.is_empty(),
            "unrelated read history leaked into the page"
        );

        let ids = db.read_ids_for_posts(&page.posts[..1]).unwrap();
        assert_eq!(ids, vec![page.posts[0].id.clone()]);
    }

    #[test]
    fn a_new_page_can_be_filtered_without_rereading_older_feed_rows() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        db.set_read(&page.posts[0].id, true).unwrap();
        db.hide_post(&page.posts[1].id).unwrap();

        let visible = db
            .filter_feed_page(
                page.posts.clone(),
                &FeedFilters {
                    hide_read: true,
                    ..FeedFilters::default()
                },
                20,
            )
            .unwrap();

        assert!(!visible.iter().any(|post| post.id == page.posts[0].id));
        assert!(!visible.iter().any(|post| post.id == page.posts[1].id));
        assert!(visible.len() <= page.posts.len() - 2);
        assert!(!visible.is_empty());
    }

    #[test]
    fn hidden_filter_does_not_delete_the_row() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        let id = page.posts[0].id.clone();
        db.hide_post(&id).unwrap();
        let visible = db
            .load_feed("following", &FeedFilters::default(), 500)
            .unwrap();
        assert!(!visible.iter().any(|p| p.id == id));
        // still present in storage
        assert!(db.get_post(&id).unwrap().is_some());
        db.unhide_post(&id).unwrap();
        let visible = db
            .load_feed("following", &FeedFilters::default(), 500)
            .unwrap();
        assert!(visible.iter().any(|p| p.id == id));
    }

    #[test]
    fn promoted_posts_are_excluded_even_when_the_filter_is_off() {
        // The strongest form of the guarantee: there is no filter setting that
        // brings advertising back. `hide_promoted: false` is the value an old
        // stored filter set or a hostile caller would use.
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        let f = FeedFilters {
            hide_promoted: false,
            ..Default::default()
        };
        let loaded = db.load_feed("following", &f, 500).unwrap();
        assert!(
            loaded.iter().all(|p| !p.is_promoted),
            "a promoted post reached the feed"
        );
    }

    #[test]
    fn promoted_and_repost_filters_apply() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        let f = FeedFilters {
            hide_promoted: true,
            hide_reposts: true,
            ..Default::default()
        };
        let filtered = db.load_feed("following", &f, 500).unwrap();
        assert!(filtered.iter().all(|p| !p.is_promoted && !p.is_repost));
        assert!(!filtered.is_empty());
    }

    #[test]
    fn a_future_timestamp_does_not_wrap_into_an_ancient_post() {
        let mut post = sample_page().posts.remove(0);
        post.created_at = (Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let filters = FeedFilters {
            max_age_hours: 1,
            ..FeedFilters::default()
        };
        assert!(passes(&post, false, &filters));
    }

    #[test]
    fn filtering_scans_past_rejected_rows_instead_of_stopping_at_three_times_limit() {
        let db = Db::in_memory().unwrap();
        let mut page = sample_page();
        let template = page.posts[0].clone();
        page.posts = (0..5)
            .map(|i| {
                let mut post = template.clone();
                post.id = format!("scan-{i}");
                post.created_at = (Utc::now() - chrono::Duration::minutes(i)).to_rfc3339();
                post.is_promoted = i < 4;
                post
            })
            .collect();
        db.save_feed_page("following", &page).unwrap();
        let loaded = db
            .load_feed("following", &FeedFilters::default(), 1)
            .unwrap();
        assert_eq!(
            loaded
                .iter()
                .map(|post| post.id.as_str())
                .collect::<Vec<_>>(),
            vec!["scan-4"]
        );
    }

    #[test]
    fn setting_an_already_read_post_does_not_double_count_activity() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        let id = &page.posts[0].id;
        db.set_read(id, true).unwrap();
        db.set_read(id, true).unwrap();
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM reading_activity WHERE post_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn muted_words_hide_matching_posts() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        let word = page.posts[0]
            .text
            .split_whitespace()
            .find(|w| w.len() > 4)
            .unwrap()
            .to_string();
        let f = FeedFilters {
            muted_words: vec![word.clone()],
            ..Default::default()
        };
        let filtered = db.load_feed("following", &f, 500).unwrap();
        assert!(filtered
            .iter()
            .all(|p| !p.text.to_lowercase().contains(&word.to_lowercase())));
    }

    #[test]
    fn pinning_round_trips() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        db.pin_account(&page.posts[0].author.id, true).unwrap();
        assert_eq!(db.pinned_accounts().unwrap().len(), 1);
    }

    #[test]
    fn groups_track_membership() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        db.create_group("g1", "AI", "#f00").unwrap();
        db.set_group_member("g1", &page.posts[0].author.id, true)
            .unwrap();
        let groups = db.groups().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].member_count, 1);
    }

    #[test]
    fn stats_reflect_stored_data() {
        let db = Db::in_memory().unwrap();
        let page = sample_page();
        db.save_feed_page("following", &page).unwrap();
        let s = db.stats().unwrap();
        assert_eq!(s.total_posts as usize, page.posts.len());
        assert!(s.unread_count > 0);
        assert!(s.last_sync.is_some());
    }

    #[test]
    fn health_messages_are_sanitized_before_storage() {
        let db = Db::in_memory().unwrap();
        db.record_health("twitter-cli", "warn", "failed auth_token=leakedvalue")
            .unwrap();
        let conn = db.conn.lock().unwrap();
        let msg: String = conn
            .query_row("SELECT message FROM provider_health LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!msg.contains("leakedvalue"), "{msg}");
    }

    // --- bookmark order ----------------------------------------------------

    /// A bookmark page built by hand, so publication time and bookmark order
    /// can be made to disagree deliberately.
    fn bookmark_page(entries: &[(&str, &str)]) -> FeedPage {
        let mut page = sample_page();
        let template = page.posts[0].clone();
        page.posts = entries
            .iter()
            .map(|(id, created)| Post {
                id: (*id).to_string(),
                created_at: (*created).to_string(),
                is_promoted: false,
                ..template.clone()
            })
            .collect();
        page
    }

    #[test]
    fn bookmarks_are_ordered_by_when_they_were_bookmarked_not_when_posted() {
        // The defect, in its smallest form: an old post bookmarked a moment ago
        // must sit above a new post bookmarked long ago. Publication order says
        // the opposite, which is exactly what shipped.
        let db = Db::in_memory().unwrap();
        let page = bookmark_page(&[
            ("old-post-bookmarked-now", "2019-01-01T00:00:00Z"),
            ("new-post-bookmarked-long-ago", "2026-07-01T00:00:00Z"),
        ]);
        db.save_feed_page(BOOKMARKS_FEED, &page).unwrap();

        let loaded = db
            .load_feed(BOOKMARKS_FEED, &FeedFilters::default(), 100)
            .unwrap();
        let ids: Vec<&str> = loaded.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["old-post-bookmarked-now", "new-post-bookmarked-long-ago"],
            "the bookmark page fell back to publication order"
        );
    }

    #[test]
    fn bookmark_slices_are_bounded_and_navigate_by_position() {
        let db = Db::in_memory().unwrap();
        let page = bookmark_page(&[
            ("b0", "2020-01-01T00:00:00Z"),
            ("b1", "2020-01-02T00:00:00Z"),
            ("b2", "2020-01-03T00:00:00Z"),
            ("b3", "2020-01-04T00:00:00Z"),
            ("b4", "2020-01-05T00:00:00Z"),
            ("b5", "2020-01-06T00:00:00Z"),
        ]);
        db.save_feed_page(BOOKMARKS_FEED, &page).unwrap();

        let newest = db
            .load_bookmark_slice(
                &FeedFilters::default(),
                &BookmarkSliceRequest {
                    anchor_position: None,
                    direction: BookmarkDirection::Newest,
                    limit: 2,
                },
                true,
            )
            .unwrap();
        assert_eq!(newest.posts.len(), 2);
        assert_eq!(newest.posts[0].id, "b4");
        assert_eq!(newest.posts[1].id, "b5");
        assert_eq!(newest.first_position, Some(4));
        assert_eq!(newest.last_position, Some(5));
        assert_eq!(newest.total_discovered, 6);
        assert!(newest.sync_complete);
        assert!(newest.has_older);
        assert!(!newest.has_newer);

        let older = db
            .load_bookmark_slice(
                &FeedFilters::default(),
                &BookmarkSliceRequest {
                    anchor_position: newest.first_position,
                    direction: BookmarkDirection::Older,
                    limit: 2,
                },
                true,
            )
            .unwrap();
        assert_eq!(
            older.posts.iter().map(|post| post.id.as_str()).collect::<Vec<_>>(),
            vec!["b2", "b3"]
        );
        assert!(older.has_older);
        assert!(older.has_newer);

        let oldest = db
            .load_bookmark_slice(
                &FeedFilters::default(),
                &BookmarkSliceRequest {
                    anchor_position: None,
                    direction: BookmarkDirection::Oldest,
                    limit: 2,
                },
                false,
            )
            .unwrap();
        assert_eq!(
            oldest.posts.iter().map(|post| post.id.as_str()).collect::<Vec<_>>(),
            vec!["b0", "b1"]
        );
        assert!(!oldest.has_older);
        assert!(oldest.has_newer);
        assert!(!oldest.sync_complete);
    }

    #[test]
    fn every_other_feed_still_reads_in_publication_order() {
        // The ordering change must not leak into timelines that genuinely are
        // chronological.
        let db = Db::in_memory().unwrap();
        let page = bookmark_page(&[
            ("older", "2019-01-01T00:00:00Z"),
            ("newer", "2026-07-01T00:00:00Z"),
        ]);
        db.save_feed_page("following", &page).unwrap();
        let loaded = db
            .load_feed("following", &FeedFilters::default(), 100)
            .unwrap();
        let ids: Vec<&str> = loaded.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["newer", "older"]);
    }

    #[test]
    fn a_newly_bookmarked_post_moves_to_the_top_on_the_next_fetch() {
        // `bookmarks` has no cursor: every fetch is the top of the list again,
        // so a new bookmark arrives at position 0 and pushes the rest down.
        let db = Db::in_memory().unwrap();
        db.save_feed_page(
            BOOKMARKS_FEED,
            &bookmark_page(&[("a", "2026-01-01T00:00:00Z"), ("b", "2026-01-02T00:00:00Z")]),
        )
        .unwrap();
        db.save_feed_page(
            BOOKMARKS_FEED,
            &bookmark_page(&[
                ("c", "2020-01-01T00:00:00Z"),
                ("a", "2026-01-01T00:00:00Z"),
                ("b", "2026-01-02T00:00:00Z"),
            ]),
        )
        .unwrap();
        let ids: Vec<String> = db
            .load_feed(BOOKMARKS_FEED, &FeedFilters::default(), 100)
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
        assert_eq!(db.bookmark_position("c").unwrap(), Some(0));
    }

    #[test]
    fn a_bookmark_below_the_fetched_batch_keeps_its_relative_position() {
        // A shorter second fetch must not lose the tail of a longer first one,
        // and must not promote it either.
        let db = Db::in_memory().unwrap();
        db.record_bookmark_order(&["a".into(), "b".into(), "c".into()])
            .unwrap();
        db.record_bookmark_order(&["d".into(), "a".into()]).unwrap();
        assert_eq!(db.bookmark_position("d").unwrap(), Some(0));
        assert_eq!(db.bookmark_position("a").unwrap(), Some(1));
        assert_eq!(db.bookmark_position("b").unwrap(), Some(2));
        assert_eq!(db.bookmark_position("c").unwrap(), Some(3));
    }

    #[test]
    fn removing_a_bookmark_evicts_only_the_bookmark_feed_row() {
        let db = Db::in_memory().unwrap();
        let page = bookmark_page(&[("123", "2026-01-01T00:00:00Z"), ("456", "2026-01-02T00:00:00Z")]);
        db.save_feed_page(BOOKMARKS_FEED, &page).unwrap();
        db.save_feed_page("following", &page).unwrap();

        db.remove_bookmark("123").unwrap();

        let bookmark_ids: Vec<String> = db
            .load_feed(BOOKMARKS_FEED, &FeedFilters::default(), 100)
            .unwrap()
            .into_iter()
            .map(|post| post.id)
            .collect();
        assert_eq!(bookmark_ids, vec!["456"]);
        assert_eq!(db.bookmark_position("123").unwrap(), None);

        let following_ids: Vec<String> = db
            .load_feed("following", &FeedFilters::default(), 100)
            .unwrap()
            .into_iter()
            .map(|post| post.id)
            .collect();
        assert_eq!(following_ids, vec!["456", "123"]);
    }

    #[test]
    fn a_repeated_id_within_one_batch_does_not_break_the_sequence() {
        let db = Db::in_memory().unwrap();
        let n = db
            .record_bookmark_order(&["a".into(), "b".into(), "a".into()])
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(db.bookmark_position("a").unwrap(), Some(0));
        assert_eq!(db.bookmark_position("b").unwrap(), Some(1));
    }

    #[test]
    fn a_bookmarked_post_never_seen_in_a_bookmark_page_sorts_last() {
        // No recorded position means no known bookmark time. Placing it at the
        // top would be inventing the ordering this table exists to record.
        let db = Db::in_memory().unwrap();
        let page = bookmark_page(&[("known", "2019-01-01T00:00:00Z")]);
        db.save_feed_page(BOOKMARKS_FEED, &page).unwrap();
        // A second post reaches the bookmarks feed without an order row.
        let stray = bookmark_page(&[("stray", "2030-01-01T00:00:00Z")]);
        db.save_feed_page("following", &stray).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO feed_entries (feed, post_id, position, fetched_at)
                 VALUES ('bookmarks','stray',9,'2030-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let ids: Vec<String> = db
            .load_feed(BOOKMARKS_FEED, &FeedFilters::default(), 100)
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, vec!["known", "stray"]);
    }

    // --- the real Following list -------------------------------------------

    fn author(id: &str) -> Author {
        Author {
            id: id.into(),
            username: id.into(),
            display_name: id.to_uppercase(),
            ..Default::default()
        }
    }

    #[test]
    fn following_accounts_keep_the_order_the_backend_returned() {
        let db = Db::in_memory().unwrap();
        db.merge_following_accounts(
            &[author("zeta"), author("alpha"), author("mid")],
            0,
            "s1",
            true,
        )
        .unwrap();
        let names: Vec<String> = db
            .following_accounts()
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(names, vec!["zeta", "alpha", "mid"], "sorted alphabetically");
    }

    #[test]
    fn a_partial_batch_adds_and_a_complete_traversal_prunes() {
        let db = Db::in_memory().unwrap();
        db.merge_following_accounts(&[author("a"), author("b")], 0, "sync-1", false)
            .unwrap();
        // A partial batch says nothing about accounts it did not reach.
        db.merge_following_accounts(&[author("a")], 0, "sync-1", false)
            .unwrap();
        assert_eq!(db.following_count().unwrap(), 2);
        // A later traversal saw the whole list, so absence is real this time.
        db.merge_following_accounts(&[author("a")], 0, "sync-2", true)
            .unwrap();
        assert_eq!(db.following_count().unwrap(), 1);
    }

    #[test]
    fn a_repeat_inside_one_batch_keeps_its_first_position() {
        // twitter-cli assembles this list from several internal pages; an
        // account that appears on both sides of a page boundary must not be
        // pushed down the list by its own duplicate.
        let db = Db::in_memory().unwrap();
        let n = db
            .merge_following_accounts(&[author("a"), author("b"), author("a")], 0, "s1", false)
            .unwrap();
        assert_eq!(n, 2);
        let ids: Vec<String> = db
            .following_accounts()
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn a_batch_arriving_later_continues_the_order_rather_than_restarting_it() {
        // The traversal renders a fast first batch and then keeps going. The
        // second batch is a continuation, not a new list, so its offset says
        // where it belongs.
        let db = Db::in_memory().unwrap();
        db.merge_following_accounts(&[author("first"), author("second")], 0, "s1", false)
            .unwrap();
        db.merge_following_accounts(&[author("third"), author("fourth")], 2, "s1", true)
            .unwrap();
        let ids: Vec<String> = db
            .following_accounts()
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, vec!["first", "second", "third", "fourth"]);
    }

    #[test]
    fn a_follow_and_an_unfollow_reconcile_immediately() {
        let db = Db::in_memory().unwrap();
        db.merge_following_accounts(&[author("a")], 0, "s1", true)
            .unwrap();
        db.upsert_author(&author("new")).unwrap();
        db.set_following("new", true).unwrap();
        let ids: Vec<String> = db
            .following_accounts()
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, vec!["new", "a"], "a new follow belongs at the top");
        db.set_following("a", false).unwrap();
        assert_eq!(db.following_count().unwrap(), 1);
    }

    #[test]
    fn group_candidates_come_only_from_the_following_list() {
        // The defect: the picker was every author ever seen, so a reposter or a
        // search hit appeared as somebody you could group.
        let db = Db::in_memory().unwrap();
        db.upsert_author(&author("a-stranger-seen-in-a-repost"))
            .unwrap();
        db.merge_following_accounts(&[author("followed")], 0, "s1", true)
            .unwrap();
        db.create_group("g1", "AI", "#f00").unwrap();
        assert!(db.is_following("followed").unwrap());
        assert!(!db.is_following("a-stranger-seen-in-a-repost").unwrap());

        let ids: Vec<String> = db
            .group_candidates("g1")
            .unwrap()
            .into_iter()
            .map(|c| c.author.id)
            .collect();
        assert_eq!(ids, vec!["followed"]);
        assert!(
            db.all_authors().unwrap().len() > 1,
            "the stranger is still cached"
        );
    }

    #[test]
    fn a_member_who_is_no_longer_followed_is_flagged_not_dropped() {
        let db = Db::in_memory().unwrap();
        db.upsert_author(&author("departed")).unwrap();
        db.merge_following_accounts(&[author("still-here")], 0, "s1", true)
            .unwrap();
        db.create_group("g1", "AI", "#f00").unwrap();
        db.set_group_member("g1", "departed", true).unwrap();
        db.set_group_member("g1", "still-here", true).unwrap();

        let candidates = db.group_candidates("g1").unwrap();
        let departed = candidates
            .iter()
            .find(|c| c.author.id == "departed")
            .expect("a group member vanished from their own group's picker");
        assert!(!departed.following);
        assert!(departed.member);
        let here = candidates
            .iter()
            .find(|c| c.author.id == "still-here")
            .unwrap();
        assert!(here.following && here.member);
    }

    #[test]
    fn switching_account_forgets_the_previous_following_list() {
        let db = Db::in_memory().unwrap();
        db.merge_following_accounts(&[author("a"), author("b")], 0, "s1", true)
            .unwrap();
        db.clear_following_accounts().unwrap();
        assert_eq!(db.following_count().unwrap(), 0);
        db.merge_following_accounts(&[author("a")], 0, "s1", true)
            .unwrap();
        db.clear_cache().unwrap();
        assert_eq!(db.following_count().unwrap(), 0);
    }
}
