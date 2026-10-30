//! Provider abstraction.
//!
//! The frontend never learns which backend produced a post. Every provider
//! converts its own raw output into the stable models in `models.rs`, so a
//! twitter-cli schema change is absorbed here and never reaches React.

/// The offline fixture provider.
///
/// **Not reachable from a production build.** It exists so the test suite can
/// exercise the database, the feed engine and the components without a live X
/// session, and so `cargo run --features dev-mock` gives a working interface
/// while developing. A shipped binary has no code path that can select it —
/// see [`select_provider`]. Showing fabricated posts as if they were somebody's
/// real timeline is the specific failure this gate exists to prevent.
#[cfg(any(test, feature = "dev-mock"))]
pub mod mock;

pub mod twitter_cli;
pub mod native_ios;
pub mod native_parser;
pub mod content;

use crate::credentials::CredentialStore;
use crate::models::*;
use std::sync::Arc;

/// Largest followed-account request the pinned twitter-cli build will honour.
///
/// The background traversal must share this exact limit. If it asks for more
/// while the provider silently clamps the argument, a clamped response looks
/// shorter than requested and can be mistaken for the end of the list.
pub const FOLLOWING_REQUEST_MAX: u32 = 1000;

/// What the backend behind this provider can actually do.
///
/// Reported to Diagnostics and used by the interface to decide which
/// affordances exist at all. Every field is a statement about the *pinned*
/// build, checked against its `--help` and its real responses — not an
/// aspiration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    /// Cursor continuation, per command.
    pub feed_cursor: bool,
    pub list_cursor: bool,
    pub following_cursor: bool,
    pub user_posts_cursor: bool,
    /// A real `isPromoted` flag on each post.
    pub promoted_flag: bool,
    /// `unfollow` exists as a command. Whether the app will *run* it is a
    /// separate, default-off preference — see `durable::ALLOW_UNFOLLOW`.
    pub unfollow: bool,
    /// `follow` exists as a command, gated by the same preference.
    pub follow: bool,
    /// `unbookmark` exists as a post-specific write command.
    pub unbookmark: bool,
    /// `mute` exists as a command. False on the pinned build: twitter-cli 0.8.6
    /// has no such subcommand. Reported rather than assumed so the interface can
    /// say "not available through this backend" instead of offering a control
    /// that would always fail.
    pub mute: bool,
    /// `block` exists as a command. False, for the same reason as `mute`.
    pub block: bool,
}

impl ProviderCapabilities {
    /// Nothing supported. The honest default for a provider that has not
    /// declared otherwise.
    pub const fn none() -> Self {
        Self {
            feed_cursor: false,
            list_cursor: false,
            following_cursor: false,
            user_posts_cursor: false,
            promoted_flag: false,
            unfollow: false,
            follow: false,
            unbookmark: false,
            mute: false,
            block: false,
        }
    }
}

/// The common interface every X data source implements.
///
/// Narrowed for 0.2.0: `get_post`, `get_thread` and `get_followers` were
/// removed along with reply threads and the followers view. Narrowed again for
/// 0.5.0: `search_posts` and `search_posts_tab` went with the Search page, so
/// the one free-text path into X no longer exists anywhere in the app.
pub trait XDataProvider: Send + Sync {
    fn get_post_replies(&self,_id:&str,_cursor:Option<String>)->AppResult<FeedPage> {
        Err(AppError::new(ErrorCode::ProviderUnavailable,"Comments are unavailable from this provider."))
    }
    fn get_post_content(&self,_id:&str)->AppResult<PostContent> {
        Err(AppError::new(ErrorCode::ProviderUnavailable,"Full post content is unavailable from this provider."))
    }
    fn name(&self) -> &'static str;

    /// What this backend can do. Defaults to "nothing declared" so a provider
    /// that forgets to answer under-promises rather than over-promises.
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities::none()
    }

    /// Stop following an account.
    ///
    /// One of the two operations in this trait that change anything on X. It
    /// takes a [`crate::security::WritePermit`], which cannot be constructed
    /// unless the durable "Allow account actions" preference is on — so a
    /// caller cannot reach this without having consulted it. Providers default
    /// to refusing.
    fn unfollow_account(
        &self,
        _username: &str,
        _permit: &crate::security::WritePermit,
    ) -> AppResult<()> {
        Err(AppError::new(
            ErrorCode::BlockedOperation,
            "this provider cannot change the account",
        ))
    }

    /// Start following an account. The exact mirror of [`Self::unfollow_account`]
    /// — same permit type, same default refusal — because the ability to undo an
    /// unfollow should not be harder to reach than the unfollow was.
    fn follow_account(
        &self,
        _username: &str,
        _permit: &crate::security::WritePermit,
    ) -> AppResult<()> {
        Err(AppError::new(
            ErrorCode::BlockedOperation,
            "this provider cannot change the account",
        ))
    }

    /// Remove one bookmark after the frontend's post-specific confirmation.
    /// Providers default to refusal so a read-only adapter cannot accidentally
    /// inherit a write path merely by implementing the feed methods.
    fn remove_bookmark(
        &self,
        _post_id: &str,
        _permit: &crate::security::BookmarkPermit,
    ) -> AppResult<()> {
        Err(AppError::new(
            ErrorCode::BlockedOperation,
            "this provider cannot remove bookmarks",
        ))
    }

    /// One page of a List timeline. Providers without cursor support ignore it.
    fn get_list_timeline_page(
        &self,
        list_id: &str,
        max: u32,
        _cursor: Option<String>,
    ) -> AppResult<FeedPage> {
        self.get_list_timeline(list_id, max)
    }

    fn get_following_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage>;
    fn get_for_you_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage>;
    fn get_user_profile(&self, username: &str) -> AppResult<Author>;
    fn refresh_user_profile(&self,username:&str)->AppResult<Author> {self.get_user_profile(username)}
    fn get_account_relationship(&self, _username: &str) -> AppResult<AccountRelationship> { Ok(AccountRelationship::Unknown) }
    fn get_user_posts(&self, username: &str, max: u32) -> AppResult<FeedPage>;
    fn get_user_posts_page(&self, username: &str, max: u32, _cursor: Option<String>) -> AppResult<FeedPage> {
        self.get_user_posts(username, max)
    }
    /// Accounts followed by `username`. The handle is required: the backend has
    /// no notion of "the current user" for this operation.
    fn get_following_accounts(&self, username: &str, max: u32) -> AppResult<Vec<Author>>;
    fn get_following_accounts_page(&self, _username: &str, _max: u32, _cursor: Option<String>) -> AppResult<AccountPage> {
        Err(AppError::new(ErrorCode::BlockedOperation, "This provider does not support account cursors."))
    }
    fn get_bookmarks(&self, max: u32) -> AppResult<FeedPage>;
    fn get_bookmarks_page(&self, max: u32, _cursor: Option<String>) -> AppResult<FeedPage> {
        self.get_bookmarks(max)
    }
    /// Timeline of one X List.
    ///
    /// There is intentionally no `get_lists()`. twitter-cli has no command that
    /// enumerates the account's Lists — `list` takes a required list id — so
    /// the app cannot discover them. Lists the user wants to read are stored as
    /// durable user-authored data (id + name they gave it) and their timelines
    /// are fetched live through this method. Inventing a list directory would
    /// be exactly the fabrication this release removes.
    fn get_list_timeline(&self, list_id: &str, max: u32) -> AppResult<FeedPage>;
    fn get_current_user(&self) -> AppResult<Author>;
    fn status(&self) -> AppResult<AuthenticationStatus>;
}

/// Which provider the app is currently serving data from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    TwitterCli,
    IosDirect,
    /// The iOS build delegates provider operations to the paired Windows app.
    IphoneCompanion,
    /// Only ever reachable in tests or a `dev-mock` build.
    Mock,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::TwitterCli => "twitter-cli",
            ProviderKind::IosDirect => "ios-direct",
            ProviderKind::IphoneCompanion => "iphone-companion",
            ProviderKind::Mock => "mock",
        }
    }

    /// True when this provider serves fabricated content. The interface uses
    /// this to label a development build unmistakably.
    pub fn is_synthetic(&self) -> bool {
        matches!(self, ProviderKind::Mock)
    }
}

/// Build the provider for this run.
///
/// There is deliberately **no fallback**. In 0.1.0 this function silently
/// returned the mock provider whenever the live session was unavailable, which
/// meant a user with an expired cookie saw invented posts and no indication
/// anything was wrong. Now an unusable session is surfaced as a session state
/// and an empty/connect screen, and the provider is always the real one.
pub fn select_provider(store: Arc<dyn CredentialStore>) -> (Box<dyn XDataProvider>, ProviderKind) {
    #[cfg(mobile)]
    {
        return (
            Box::new(native_ios::NativeIosProvider::new(store)),
            ProviderKind::IosDirect,
        );
    }

    #[cfg(not(mobile))]
    #[cfg(feature = "dev-mock")]
    {
        // Opt-in, compile-time only, and loudly announced at startup.
        if std::env::var("FFN_DEV_MOCK").is_ok() {
            log::warn!("dev-mock build: serving FABRICATED content, not real X data");
            return (Box::new(mock::MockXProvider::new()), ProviderKind::Mock);
        }
    }
    #[cfg(not(mobile))]
    {
        (
            Box::new(twitter_cli::TwitterCliProvider::new(store)),
            ProviderKind::TwitterCli,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryStore;

    #[test]
    fn production_selection_never_yields_the_mock_provider() {
        let (provider, kind) = select_provider(Arc::new(MemoryStore::new()));
        assert_eq!(kind, ProviderKind::TwitterCli);
        assert_eq!(provider.name(), "twitter-cli");
        assert!(!kind.is_synthetic());
    }

    #[test]
    fn an_empty_credential_store_still_selects_the_live_provider() {
        // The old build fell back to fixtures here. It must now select the real
        // provider and let the session layer report "not connected".
        let store = Arc::new(MemoryStore::new());
        assert!(!store.has());
        let (_, kind) = select_provider(store);
        assert_eq!(kind, ProviderKind::TwitterCli);
    }
}
