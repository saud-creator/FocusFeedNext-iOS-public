//! Stable internal data models.
//!
//! These are the ONLY shapes the frontend ever sees. Every provider is
//! responsible for converting its own raw output into these types, so a change
//! in twitter-cli's schema is absorbed by a provider adapter and never reaches
//! a React component.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AccountRelationship { Following, NotFollowing, Pending, Unknown }

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub id: String,
    pub username: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub banner_url: Option<String>,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub followers_count: Option<u64>,
    #[serde(default)]
    pub following_count: Option<u64>,
    #[serde(default)]
    pub location: Option<String>,
    /// The account's own website link, not a link to the profile.
    #[serde(default)]
    pub website: Option<String>,
    /// Account creation time, RFC3339. Shown as "Joined ..." on the profile.
    #[serde(default)]
    pub joined_at: Option<String>,
    #[serde(default)]
    pub posts_count: Option<u64>,
}

impl Author {
    /// A minimal author when only a handle is known.
    ///
    /// twitter-cli reports the reposter of a retweet as a bare `screenName`
    /// string, so this is all the truth we have about them. Every other field
    /// stays `None` rather than being filled with a plausible-looking guess.
    pub fn from_handle(username: impl Into<String>) -> Self {
        let username = username.into();
        Self {
            id: username.clone(),
            display_name: username.clone(),
            username,
            avatar_url: None,
            banner_url: None,
            verified: false,
            bio: None,
            followers_count: None,
            following_count: None,
            location: None,
            website: None,
            joined_at: None,
            posts_count: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Video,
    Gif,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaVariant {
    /// Human label, e.g. "720p", or a bitrate when the resolution is unknown.
    /// Never invented: a variant with neither is dropped rather than labelled.
    pub label: String,
    /// A loopback proxy URL by the time this reaches the frontend. The signed
    /// CDN URL it was registered from never leaves the backend.
    pub url: String,
    #[serde(default)]
    pub bitrate: Option<u64>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

impl MediaVariant {
    /// The label a rendition earns from what X actually said about it.
    ///
    /// Resolution first, because that is what a reader chooses by. Bitrate only
    /// when there is no resolution — and when there is neither, `None`, so the
    /// caller drops the variant instead of listing an unnameable one.
    ///
    /// The number in "720p" is the **shorter** side, not the height. That
    /// distinction is invisible on landscape video and wrong on everything
    /// else: a real bookmark in this account holds a 1080x1920 portrait clip,
    /// and naming it by height offered the reader "1920p / 1280p / 852p /
    /// 568p" for what is an ordinary 1080p/720p/480p/320p ladder. Vertical
    /// video is most of what X serves, so that was the common case reading as
    /// the exotic one.
    pub fn label_for(
        width: Option<u32>,
        height: Option<u32>,
        bitrate: Option<u64>,
    ) -> Option<String> {
        let short = match (width.filter(|n| *n > 0), height.filter(|n| *n > 0)) {
            (Some(w), Some(h)) => Some(w.min(h)),
            // One dimension is still better than none: X's own naming uses the
            // height for landscape, which is what a lone height most likely is.
            (None, Some(h)) => Some(h),
            (Some(w), None) => Some(w),
            (None, None) => None,
        };
        if let Some(n) = short {
            return Some(format!("{n}p"));
        }
        bitrate
            .filter(|b| *b > 0)
            .map(|b| format!("{} kbps", b / 1000))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostMedia {
    pub kind: MediaKind,
    pub url: String,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub alt: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub variants: Vec<MediaVariant>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostMetrics {
    #[serde(default)]
    pub replies: u64,
    #[serde(default)]
    pub reposts: u64,
    #[serde(default)]
    pub likes: u64,
    #[serde(default)]
    pub quotes: u64,
    #[serde(default)]
    pub views: u64,
    #[serde(default)]
    pub bookmarks: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// A quoted post.
///
/// Deliberately shallow: twitter-cli serialises a quote as exactly `id`, `text`
/// and an author with only `screenName` and `name`. There is no timestamp, no
/// metrics and no media, so those fields are optional here and the interface
/// omits them rather than showing zeros that would read as real values.
pub struct QuotedPost {
    pub id: String,
    pub author: Author,
    pub text: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub media: Vec<PostMedia>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: String,
    pub text: String,
    pub author: Author,
    /// RFC3339 timestamp.
    pub created_at: String,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub is_repost: bool,
    /// Present when `is_repost` is true: who put it in the timeline.
    ///
    /// Note that for a repost every other field on this struct — text, author,
    /// metrics, media, timestamp — describes the **original** post, which is
    /// how twitter-cli models it.
    #[serde(default)]
    pub reposted_by: Option<Author>,
    /// Whether this is an advertisement.
    ///
    /// Read from the `isPromoted` boolean 0.8.6 added, not assumed. It is
    /// frequently true: one live following page of 45 posts held 20 ads, and
    /// that page was requested with `--no-include-promoted`. Excluding at the
    /// source is asked for and does not work, so the filter in
    /// `database::passes` is what actually keeps advertising out of the reader's
    /// feed. Nothing in the interface can turn that filter off.
    #[serde(default)]
    pub is_promoted: bool,
    #[serde(default)]
    pub quoted: Option<Box<QuotedPost>>,
    #[serde(default)]
    pub metrics: PostMetrics,
    #[serde(default)]
    pub media: Vec<PostMedia>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub is_article: bool,
    #[serde(default)]
    pub article_title: Option<String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// Which provider produced this row ("mock", "twitter-cli", ...).
    #[serde(default)]
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPage {
    pub accounts: Vec<Author>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    pub posts: Vec<Post>,
    #[serde(default)]
    pub cursor: Option<String>,
    pub fetched_at: String,
    pub provider: String,
    /// True when these rows came from SQLite rather than a live provider call.
    #[serde(default)]
    pub from_cache: bool,
}

/// The direction of a bounded bookmark page. Positions are stable within the
/// current account/session snapshot: zero is the oldest discovered bookmark
/// and the largest position is the newest.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BookmarkDirection {
    Older,
    Newer,
    Oldest,
    Newest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkSliceRequest {
    #[serde(default)]
    pub anchor_position: Option<i64>,
    pub direction: BookmarkDirection,
    pub limit: i64,
}

/// A page of the complete locally discovered bookmark order. The page itself
/// is bounded; `total_discovered` is metadata, not a request to materialize
/// every bookmark in the IPC response or in React state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkSlice {
    pub posts: Vec<Post>,
    pub first_position: Option<i64>,
    pub last_position: Option<i64>,
    pub total_discovered: i64,
    pub sync_complete: bool,
    pub has_older: bool,
    pub has_newer: bool,
    pub read_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XList {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub member_count: Option<u64>,
}

/// A user-authored local list. Only the definition survives a restart;
/// fetched posts and author payloads remain session-scoped in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountList {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub member_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationStatus {
    pub authenticated: bool,
    #[serde(default)]
    pub username: Option<String>,
    /// Some twitter-cli builds include the complete authenticated user in the
    /// status response. Keeping it here lets the session reuse that payload
    /// instead of immediately spawning a second `whoami` process. It is an
    /// internal provider detail and is never serialized across IPC.
    #[serde(skip)]
    pub account: Option<Author>,
    pub checked_at: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// Provider currently serving data ("mock" / "twitter-cli").
    pub active_provider: String,
    pub live_available: bool,
    pub authenticated: bool,
    #[serde(default)]
    pub twitter_cli_version: Option<String>,
    #[serde(default)]
    pub agent_reach_version: Option<String>,
    #[serde(default)]
    pub agent_reach_installed: bool,
    #[serde(default)]
    pub active_backend: Option<String>,
    pub message: String,
    #[serde(default)]
    pub using_mock: bool,
}

/// One channel row from `agent-reach doctor --json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelHealth {
    pub key: String,
    pub name: String,
    /// ok | warn | off | error
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub tier: i64,
    #[serde(default)]
    pub backends: Vec<String>,
    #[serde(default)]
    pub active_backend: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub agent_reach_installed: bool,
    #[serde(default)]
    pub agent_reach_version: Option<String>,
    #[serde(default)]
    pub channels: Vec<ChannelHealth>,
    #[serde(default)]
    pub twitter_status: Option<String>,
    pub checked_at: String,
    #[serde(default)]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Every error the frontend can receive. Mirrors the error list in the project
/// plan so the UI can always map a code to a message + repair action.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ToolMissing,
    NotAuthenticated,
    CookieExpired,
    RateLimited,
    ApiError,
    SchemaChanged,
    EmptyResponse,
    ProcessTimeout,
    ProcessCrashed,
    InvalidJson,
    DatabaseError,
    MediaUnavailable,
    NetworkUnavailable,
    ProviderUnavailable,
    AgentReachUnavailable,
    BlockedOperation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default)]
    pub repair: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_connection_fault: Option<tauri_plugin_ios_reader::NativeConnectionFault>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: crate::security::sanitize(&message.into()),
            repair: None,
            native_connection_fault: None,
        }
    }

    pub fn with_repair(mut self, repair: impl Into<String>) -> Self {
        self.repair = Some(repair.into());
        self
    }

    pub fn database(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::DatabaseError, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::database(e.to_string())
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
