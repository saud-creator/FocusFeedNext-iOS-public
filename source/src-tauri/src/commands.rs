//! Tauri command surface.
//!
//! This is the only way the frontend can reach the backend. There is no
//! "run arbitrary command" entry point by design.

use crate::agent_reach::AgentReachManager;
use crate::companion::{CompanionHost, CompanionHostStatus, RemoteProvider};
use crate::credentials::{CredentialStore, KeyringStore, XCredentials};
use crate::database::{DashboardStats, Db, FeedFilters, Group};
use crate::durable::Durable;
use crate::ephemeral::{directory_size, EphemeralSession};
use crate::media_proxy::{MediaProxy, MediaRegistry};
use crate::models::*;
use crate::providers::{select_provider, ProviderCapabilities, ProviderKind, XDataProvider};
use crate::security;
pub use crate::session::Probe;
use crate::session::{SessionManager, SessionSnapshot};
use std::fs::File;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct WebviewStorage {
    pub dir: std::path::PathBuf,
    lock: Option<File>,
}

pub struct AppState {
    /// Session-scoped content. Always an in-memory database; it is dropped on
    /// exit and never becomes a content.db file.
    pub db: Db,
    /// The small allowlisted set of things that survive a restart.
    pub durable: Durable,
    /// The per-run lock/profile directory. `None` in tests, which use an
    /// in-memory database and have nothing on disk to clean up.
    pub storage: Mutex<Option<EphemeralSession>>,
    /// A separate WebView directory used only when the session directory could
    /// not be created. In the normal path the WebView lives inside the
    /// `EphemeralSession` directory and is removed with it.
    pub webview_dir: Mutex<Option<WebviewStorage>>,
    /// Opaque-id → trusted-media-URL map backing the loopback proxy. Always
    /// present, so registration is never conditional; the proxy in front of it
    /// may be absent if the socket could not be bound.
    pub media: Arc<MediaRegistry>,
    /// The running proxy. `None` in tests and if binding failed, in which case
    /// video reports "local proxy unavailable" rather than silently handing the
    /// webview a CDN URL that will not play.
    pub proxy: Mutex<Option<MediaProxy>>,
    pub agent: AgentReachManager,
    /// Narrow, paired provider bridge used by the iPhone build. It is stopped
    /// by default and can only be started explicitly from the Windows UI.
    pub companion: CompanionHost,
    pub provider: Mutex<Box<dyn XDataProvider>>,
    pub kind: Mutex<ProviderKind>,
    pub session: SessionManager,
    pub store: Arc<dyn CredentialStore>,
    pub last_error: Mutex<Option<String>>,
    pub last_request_ms: Mutex<u64>,
    pub last_request_count: Mutex<usize>,
    /// One account-changing operation at a time, ever. A double-submitted
    /// dialog must not send two unfollows, and there is no queue: the second
    /// is refused rather than deferred.
    pub write_in_flight: std::sync::atomic::AtomicBool,
    /// One health check at a time. Startup, Test Connection, a resume and a
    /// route change can all ask at once; without this each would spawn its own
    /// `twitter.exe`. The second caller gets the current snapshot rather than
    /// a second process.
    pub health_in_flight: std::sync::atomic::AtomicBool,
    /// Number of live foreground provider requests. Startup preloads wait for
    /// these to drain so a slow first feed/profile request keeps the network
    /// and rate-limit budget instead of competing with background traversal.
    pub foreground_requests: std::sync::atomic::AtomicUsize,
    /// Changes at every connect/disconnect identity boundary. Results captured
    /// under an older value are refused before reaching the interface.
    pub account_epoch: std::sync::atomic::AtomicU64,
    /// Short identity/DB commit barrier. Network calls never hold this lock.
    pub account_commit: Mutex<()>,
    /// The background traversal slots. See [`crate::preload`].
    pub workers: crate::preload::Workers,
    /// One automatic preload plan per worker epoch. Launch, the frontend
    /// health handoff and reconnect can all observe the same connected result;
    /// they must not each create a sleeping scheduler thread.
    pub preload_scheduled: Mutex<Option<u64>>,
    /// Where background progress events go. `NullSink` until the shell is up,
    /// so a worker that starts before the window exists reports into nothing
    /// rather than failing.
    pub events: Mutex<Arc<dyn crate::preload::ProgressSink>>,
    pub following_progress: Mutex<Option<(u64, crate::preload::Progress, String)>>,
}

impl AppState {
    /// Production state: credentials in Windows Credential Manager.
    pub fn new(db: Db) -> Self {
        Self::with_store(db, Arc::new(KeyringStore::new()))
    }

    pub fn with_store(db: Db, store: Arc<dyn CredentialStore>) -> Self {
        // There is no mock fallback any more. The live provider is always
        // selected; when there is no usable session the session layer says so
        // and the interface shows a connect screen rather than invented posts.
        let (provider, kind) = select_provider(store.clone());
        Self {
            db,
            durable: Durable::in_memory().expect("in-memory preferences must open"),
            storage: Mutex::new(None),
            webview_dir: Mutex::new(None),
            media: Arc::new(MediaRegistry::new()),
            proxy: Mutex::new(None),
            agent: AgentReachManager::new(),
            companion: CompanionHost::default(),
            provider: Mutex::new(provider),
            kind: Mutex::new(kind),
            session: SessionManager::new(Box::new(SharedStore(store.clone()))),
            store,
            last_error: Mutex::new(None),
            last_request_ms: Mutex::new(0),
            last_request_count: Mutex::new(0),
            write_in_flight: std::sync::atomic::AtomicBool::new(false),
            health_in_flight: std::sync::atomic::AtomicBool::new(false),
            foreground_requests: std::sync::atomic::AtomicUsize::new(0),
            account_epoch: std::sync::atomic::AtomicU64::new(0),
            account_commit: Mutex::new(()),
            workers: crate::preload::Workers::default(),
            preload_scheduled: Mutex::new(None),
            events: Mutex::new(Arc::new(crate::preload::NullSink)),
            following_progress: Mutex::new(None),
        }
    }

    /// Attach the on-disk preferences store. Startup only.
    pub fn with_durable(mut self, durable: Durable) -> Self {
        self.durable = durable;
        self
    }

    /// Attach the per-run session directory. Startup only.
    pub fn with_storage(self, storage: EphemeralSession) -> Self {
        *self.storage.lock().unwrap() = Some(storage);
        self
    }

    /// Attach a WebView-only fallback directory. Startup only.
    pub fn with_webview_dir(self, dir: std::path::PathBuf) -> Self {
        let lock = Some(
            File::create(dir.join("session.lock"))
                .expect("private WebView profile must have a cleanup lock"),
        );
        *self.webview_dir.lock().unwrap() = Some(WebviewStorage { dir, lock });
        self
    }

    /// Attach the running media proxy. Startup only.
    pub fn with_proxy(self, proxy: MediaProxy) -> Self {
        *self.proxy.lock().unwrap() = Some(proxy);
        self
    }

    /// Point background progress at the shell. Startup only.
    pub fn set_event_sink(&self, sink: Arc<dyn crate::preload::ProgressSink>) {
        *self.events.lock().unwrap() = sink;
    }

    pub fn emit(&self, event: &str, progress: &crate::preload::Progress) {
        let sink = self.events.lock().unwrap().clone();
        sink.emit(event, progress);
    }

    fn emit_following(&self, epoch: u64, progress: &crate::preload::Progress) {
        if !self.workers.is_current(epoch) { return; }
        *self.following_progress.lock().unwrap() = Some((epoch, progress.clone(), chrono::Utc::now().to_rfc3339()));
        self.emit(crate::preload::FOLLOWING_PROGRESS, progress);
    }

    /// Mark one user-visible provider request as active. The guard makes the
    /// decrement unconditional across success, provider errors and task
    /// cancellation.
    pub fn foreground_request(&self) -> ForegroundRequest<'_> {
        self.foreground_requests.fetch_add(1, Ordering::SeqCst);
        ForegroundRequest { state: self }
    }

    pub fn foreground_is_busy(&self) -> bool {
        self.foreground_requests.load(Ordering::SeqCst) != 0
    }

    /// A provider for a background worker to use on its own.
    ///
    /// Deliberately *not* the one behind `self.provider`. A Following traversal
    /// takes upwards of half a minute and holding the shared lock for that long
    /// would stall every feed request the reader made in the meantime. Building
    /// a second one costs a struct allocation — the child process is spawned
    /// per call either way — and it goes through `select_provider` so the
    /// dev-mock gate still applies to background work.
    pub fn background_provider(&self) -> AppResult<Box<dyn XDataProvider>> {
        let _account_commit = self.account_commit.lock().unwrap();
        self.background_provider_unlocked()
    }

    fn background_provider_unlocked(&self) -> AppResult<Box<dyn XDataProvider>> {
        // Snapshot the credentials while the identity commit barrier is held.
        // A later account replacement cannot make an A traversal spawn its next
        // child with B's credentials.
        let snapshot = Arc::new(crate::credentials::MemoryStore::new());
        if let Some(creds) = self.store.load()? {
            snapshot.save(&creds)?;
        }
        Ok(select_provider(snapshot).0)
    }

    /// Snapshot the handle, denominator and credentials for one Following run.
    /// The three values have to come from the same account boundary; reading the
    /// handle first and the credential store later can otherwise pair account A
    /// with account B during a fast connection switch.
    pub fn background_account(&self) -> AppResult<(String, Option<u64>, Box<dyn XDataProvider>)> {
        let _account_commit = self.account_commit.lock().unwrap();
        let handle = self.active_handle()?;
        let total = self.session.account().and_then(|a| a.following_count);
        let provider = self.background_provider_unlocked()?;
        Ok((handle, total, provider))
    }

    /// Rewrite every post-media URL so the frontend only ever sees a loopback
    /// URL. Images, posters and video variants all use the same bounded,
    /// no-cache proxy; this keeps WebView2 from creating a disk cache for
    /// fetched content and keeps signed CDN URLs out of the renderer.
    ///
    /// When the proxy is not running the original URL is cleared rather than
    /// passed through: a CDN URL that cannot play is not a useful fallback, and
    /// leaking a signed URL to the webview is exactly what this avoids. The
    /// player reads the empty source as "local proxy unavailable".
    pub fn proxy_media(&self, posts: &mut [Post]) {
        let guard = self.proxy.lock().unwrap();
        let proxy = guard.as_ref();
        let account = self
            .session
            .account()
            .map(|a| a.username)
            .unwrap_or_default();
        for post in posts.iter_mut() {
            let post_id = post.id.clone();
            rewrite_author_images(&self.media, proxy, &mut post.author, &account);
            if let Some(reposter) = post.reposted_by.as_mut() {
                rewrite_author_images(&self.media, proxy, reposter, &account);
            }
            if let Some(proxy) = proxy { rewrite_media_urls(&self.media, proxy, &mut post.media, &post_id, &account); }
            else { clear_media_urls(&mut post.media); }
            if let Some(quoted) = post.quoted.as_mut() {
                rewrite_author_images(&self.media, proxy, &mut quoted.author, &account);
                if let Some(proxy) = proxy { rewrite_media_urls(&self.media, proxy, &mut quoted.media, &post_id, &account); }
                else { clear_media_urls(&mut quoted.media); }
            }
        }
    }

    /// Rewrite copies sent over IPC; DB/session/durable identities retain the
    /// upstream URL so a future process can issue a fresh local registration.
    pub fn proxy_authors(&self, authors: &mut [Author]) {
        let guard = self.proxy.lock().unwrap();
        let account = self.session.account().map(|a| a.username).unwrap_or_default();
        for author in authors { rewrite_author_images(&self.media, guard.as_ref(), author, &account); }
    }
    fn proxy_snapshot(&self, mut snapshot: SessionSnapshot) -> SessionSnapshot {
        if let Some(author) = snapshot.account.as_mut() { self.proxy_authors(std::slice::from_mut(author)); }
        snapshot
    }

    /// Same, for a whole page.
    pub fn proxy_page(&self, page: &mut FeedPage) {
        self.proxy_media(&mut page.posts);
    }

    /// Release the session database and delete everything this run wrote.
    ///
    /// Called once, on application exit. Idempotent, because Tauri can deliver
    /// both a window-destroyed and an exit event.
    pub fn shutdown(&self) -> crate::ephemeral::CleanupReport {
        // Prevent a provider response already in flight from writing after the
        // session database has been closed or replaced.
        self.workers.cancel_all();
        // List definitions are the one user-authored part of the session
        // database. Preserve them before closing and deleting the ephemeral
        // content store, so a normal app exit is also a safe migration point
        // for lists created by the current run.
        if let Some(account) = self.session.account() {
            if let Err(e) = persist_session_lists(self, &account.id) {
                log::warn!(
                    "could not persist local lists during shutdown: {}",
                    e.message
                );
            }
        }
        // Stop the LAN listener before closing the provider/database state it
        // reads. The listener holds only a Weak<AppState>, so this is also the
        // explicit point at which new phone requests stop being accepted.
        self.companion.stop();
        // Stop serving before anything else: the registry is emptied with it,
        // so no media id survives even for the moment the socket takes to
        // close. Nothing was written to disk, so there is no media cache to
        // remove — the mapping only ever existed in this process's memory.
        if let Ok(mut guard) = self.proxy.lock() {
            if let Some(proxy) = guard.as_mut() {
                proxy.shutdown();
            }
            *guard = None;
        }
        self.media.invalidate_all();
        // The connection must go first: Windows refuses to unlink a file that
        // still has an open handle.
        self.db.close();
        let mut report = match self.storage.lock().unwrap().as_mut() {
            Some(s) => s.cleanup(),
            None => crate::ephemeral::CleanupReport::default(),
        };
        if let Some(storage) = self.webview_dir.lock().unwrap().take() {
            let WebviewStorage { dir, lock } = storage;
            drop(lock);
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => {
                    if let Some(parent) = dir.parent() {
                        let _ = std::fs::remove_dir(parent);
                        if parent.file_name().and_then(|name| name.to_str()) == Some("webview") {
                            if let Some(grandparent) = parent.parent() {
                                let _ = std::fs::remove_dir(grandparent);
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && !dir.exists() => {}
                Err(e) => {
                    report.errors.push(format!("WebView directory: {e}"));
                }
            }
            // WebView2 may recreate the directory after remove_dir_all returns
            // while its browser process is still unwinding. The cleanup child
            // is safe to launch for an already-gone directory and makes the
            // post-exit no-files guarantee hold for this fallback path too.
            if dir.exists() {
                report
                    .errors
                    .push("WebView directory still exists after cleanup".into());
            }
            crate::portable::schedule_deferred_cleanup(&dir);
        }
        report
    }

    fn note_error(&self, e: &AppError) {
        if matches!(e.code,ErrorCode::BlockedOperation) { return; }
        if let Ok(mut g) = self.last_error.lock() {
            *g = Some(security::sanitize(&format!("{:?}: {}", e.code, e.message)));
        }
        self.session.note_request_failure(e);
    }

    fn note_success(&self) {
        self.session.note_request_success();
    }

    /// Refuse to start a provider request when the session cannot serve one.
    ///
    /// This is what stops a rejected session from retrying in a tight loop and
    /// what guarantees a failed request never falls back to fabricated content.
    fn guard(&self) -> AppResult<()> {
        let snap = self.session.snapshot();
        if snap.checking || snap.reason == crate::session::SessionReason::NotChecked {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                "the X session is still being checked",
            )
            .with_repair("Wait for the connection check to finish, then try again."));
        }
        if snap.reason.blocks_requests() {
            return Err(reason_error(snap.reason));
        }
        Ok(())
    }

    /// Claim the single health-check slot, or `None` when one is already
    /// running.
    ///
    /// `compare_exchange`, not read-then-write: startup, Test Connection and a
    /// monitoring tick can arrive in the same instant, and only one of them may
    /// start a `twitter.exe`.
    fn begin_health_check(&self) -> Option<HealthSlot<'_>> {
        self.health_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| HealthSlot(self))
    }

    /// The connected account's handle, needed by operations that take one.
    fn active_handle(&self) -> AppResult<String> {
        self.session.account().map(|a| a.username).ok_or_else(|| {
            AppError::new(
                ErrorCode::NotAuthenticated,
                "no connected account has been identified yet",
            )
            .with_repair("Open Settings → X Connection and connect an account.")
        })
    }

    fn account_epoch(&self) -> u64 {
        self.account_epoch.load(Ordering::SeqCst)
    }

    fn ensure_account_epoch(&self, expected: u64) -> AppResult<()> {
        if self.account_epoch() == expected {
            return Ok(());
        }
        Err(AppError::new(
            ErrorCode::BlockedOperation,
            "the connected account changed while this request was running",
        )
        .with_repair("Retry the request for the current account."))
    }
}

fn clear_media_urls(media: &mut [PostMedia]) {
    for item in media {
        item.url.clear();
        item.preview_url = None;
        item.variants.clear();
    }
}

fn rewrite_author_images(registry: &MediaRegistry, proxy: Option<&MediaProxy>, author: &mut Author, account: &str) {
    for source in [&mut author.avatar_url, &mut author.banner_url] {
        *source = source.as_deref().and_then(|url| {
            // Account images are public images, not video or arbitrary URLs.
            let valid = crate::media_proxy::validate_media_url(url)?;
            if !valid.starts_with("https://pbs.twimg.com/") { return None; }
            let proxy = proxy?;
            registry.register(valid, &author.id, account).map(|id| proxy.url_for(&id))
        });
    }
}

fn rewrite_media_urls(
    registry: &MediaRegistry,
    proxy: &MediaProxy,
    media: &mut [PostMedia],
    post_id: &str,
    account: &str,
) {
    for item in media {
        match registry.register(&item.url, post_id, account) {
            Some(id) => item.url = proxy.url_for(&id),
            // An untrusted host never reaches the webview at all.
            None => item.url.clear(),
        }
        if let Some(preview) = item.preview_url.as_deref() {
            item.preview_url = registry
                .register(preview, post_id, account)
                .map(|id| proxy.url_for(&id));
        }
        // Every rendition gets its own opaque id. A variant that fails
        // validation is dropped from the list rather than blanked, because a
        // quality the reader can select and cannot play is worse than one that
        // was never offered.
        item.variants.retain_mut(|variant| {
            match registry.register(&variant.url, post_id, account) {
                Some(id) => {
                    variant.url = proxy.url_for(&id);
                    true
                }
                None => false,
            }
        });
    }
}

/// Resolve the account namespace for durable user-authored lists. A remembered
/// identity is deliberately not enough: list reads and writes must stay behind
/// the live authenticated session boundary so a stale account label cannot
/// expose another account's definitions.
fn active_account_id(st: &AppState) -> AppResult<String> {
    st.session
        .account()
        .map(|a| a.id)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::NotAuthenticated,
                "no connected account has been identified yet",
            )
            .with_repair("Open Settings → X Connection and connect an account.")
        })
}

/// Copy the durable list definitions into the current throwaway DB. Only the
/// definitions cross the boundary; post and author rows still expire with the
/// session.
fn restore_account_lists(st: &AppState, account_id: &str) -> AppResult<()> {
    st.db.clear_groups()?;
    for list in st.durable.account_lists(account_id)? {
        st.db.create_group(&list.id, &list.name, &list.color)?;
        for author_id in list.member_ids {
            st.db.set_group_member(&list.id, &author_id, true)?;
        }
    }
    Ok(())
}

/// Preserve any session-created lists before an account replacement clears the
/// throwaway database. This is also the migration path for lists created by an
/// older build while they are still present in the current run.
fn persist_session_lists(st: &AppState, account_id: &str) -> AppResult<()> {
    for list in st.db.groups()? {
        st.durable
            .upsert_account_list(account_id, &list.id, &list.name, &list.color)?;
        let member_ids = st.db.group_member_ids(&list.id)?;
        st.durable
            .replace_account_list_members(account_id, &list.id, &member_ids)?;
    }
    Ok(())
}

pub struct ForegroundRequest<'a> {
    state: &'a AppState,
}

impl Drop for ForegroundRequest<'_> {
    fn drop(&mut self) {
        self.state
            .foreground_requests
            .fetch_sub(1, Ordering::SeqCst);
    }
}

/// Exclusive hold on the health-check slot, released on drop.
///
/// A guard rather than a matching `store(false)` at the end of the function:
/// the probe body has several early returns, and a flag left set would wedge
/// every later check into answering with a stale snapshot for the rest of the
/// run — including the one the reader presses Test Connection for.
struct HealthSlot<'a>(&'a AppState);

impl Drop for HealthSlot<'_> {
    fn drop(&mut self) {
        self.0.health_in_flight.store(false, Ordering::SeqCst);
    }
}

/// Adapts the shared `Arc` store to the owned `Box` the session manager holds,
/// so both refer to the same underlying credential storage.
struct SharedStore(Arc<dyn CredentialStore>);

impl CredentialStore for SharedStore {
    fn save(&self, creds: &XCredentials) -> AppResult<()> {
        self.0.save(creds)
    }
    fn load(&self) -> AppResult<Option<XCredentials>> {
        self.0.load()
    }
    fn delete(&self) -> AppResult<()> {
        self.0.delete()
    }
}

/// Turn a blocking session reason into the error the UI renders.
fn reason_error(reason: crate::session::SessionReason) -> AppError {
    use crate::session::SessionReason as R;
    match reason {
        R::AuthFailed => AppError::new(
            ErrorCode::CookieExpired,
            "The connected provider session is no longer valid.",
        )
        .with_repair("Open Settings and reconnect the provider."),
        R::ToolMissing => AppError::new(ErrorCode::ToolMissing, "twitter-cli is not installed.")
            .with_repair("Install it with: pipx install twitter-cli"),
        _ => AppError::new(ErrorCode::NotAuthenticated, "No X account is connected.")
            .with_repair("Open Settings and connect a provider."),
    }
}

type Sh<'a> = State<'a, Arc<AppState>>;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedResponse {
    pub posts: Vec<Post>,
    pub from_cache: bool,
    pub provider: String,
    pub last_sync: Option<String>,
    pub read_ids: Vec<String>,
    pub total_cached: i64,
    /// Where the page after this one starts, or `None` when there is no next
    /// page to ask for. Only a live fetch can know this, so a cached answer
    /// always says `None` rather than guessing from the last run.
    pub next_cursor: Option<String>,
}

fn build_response(
    state: &AppState,
    feed: &str,
    mut posts: Vec<Post>,
    from_cache: bool,
    next_cursor: Option<String>,
) -> AppResult<FeedResponse> {
    // Every feed answer leaves through here, which makes this the one place
    // video URLs have to be swapped for loopback ones. The database keeps the
    // original CDN URL so a retry can re-register it; the frontend never sees
    // it.
    state.proxy_media(&mut posts);
    let read_ids = state.db.read_ids_for_posts(&posts)?;
    Ok(FeedResponse {
        posts,
        from_cache,
        provider: state.kind.lock().unwrap().as_str().to_string(),
        last_sync: state.db.last_sync(feed)?,
        read_ids,
        total_cached: state.db.total_posts()?,
        next_cursor,
    })
}

/// Resolve and authorise a local list id against the currently connected
/// account. A list from another account (or an id that was never created) must
/// not be reachable by invoking a Tauri command directly.
fn active_list_scope(st: &AppState, raw_id: &str) -> AppResult<(String, String)> {
    let id = security::clean_local_list_id(raw_id)
        .ok_or_else(|| AppError::new(ErrorCode::ApiError, "invalid local list id"))?;
    let account_id = active_account_id(st)?;
    if !st.durable.account_list_exists(&account_id, &id)? {
        return Err(AppError::new(
            ErrorCode::ApiError,
            "the requested list does not belong to the active account",
        ));
    }
    Ok((account_id, id))
}

fn load_feed_response(
    state: &AppState,
    feed: &str,
    filters: &FeedFilters,
    limit: i64,
    from_cache: bool,
    next_cursor: Option<String>,
    expected_epoch: Option<u64>,
) -> AppResult<FeedResponse> {
    let _account_commit = state.account_commit.lock().unwrap();
    if let Some(epoch) = expected_epoch {
        state.ensure_account_epoch(epoch)?;
    }
    // Feed delivery is page-bounded. Bookmarks use the dedicated keyset API;
    // this guard also protects older callers from turning the generic command
    // into an all-bookmarks materializer.
    let page_limit = if feed == crate::database::BOOKMARKS_FEED {
        limit.clamp(1, 80)
    } else {
        limit.clamp(1, 512)
    };
    let posts = state.db.load_feed(feed, filters, page_limit)?;
    build_response(state, feed, posts, from_cache, next_cursor)
}

// ---------------------------------------------------------------------------
// Provider / health
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_provider_status(state: Sh<'_>) -> Result<ProviderStatus, AppError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let kind = *st.kind.lock().unwrap();
        // Read the cached session state rather than probing. `status` is two
        // network round trips inside twitter-cli, and this runs on the Home
        // dashboard; the probe is scheduled separately by `check_session`.
        let snap = st.session.snapshot();
        // Never run `agent-reach doctor` here either: it probes every channel,
        // some over the network, and would leave the dashboard stuck on
        // "Checking...". Diagnostics runs the full health check explicitly.
        let (
            live_available,
            twitter_cli_version,
            agent_reach_version,
            agent_reach_installed,
            cached,
            message,
        ) = match kind {
            ProviderKind::TwitterCli => {
                let live = crate::providers::twitter_cli::TwitterCliProvider::new(st.store.clone());
                (
                    live.is_installed(),
                    live.version(),
                    st.agent.version(),
                    st.agent.is_installed(),
                    st.agent.cached_health(),
                    "Live data via twitter-cli.".to_string(),
                )
            }
            ProviderKind::IphoneCompanion => (
                st.store.has(),
                None,
                None,
                false,
                None,
                "Live data through the paired Windows companion.".to_string(),
            ),
            ProviderKind::IosDirect => (
                st.store.has(), None, None, false, None,
                "Direct Twitter connection from this iPhone.".to_string(),
            ),
            ProviderKind::Mock => (
                true,
                None,
                None,
                false,
                None,
                "Fabricated development data.".to_string(),
            ),
        };
        Ok(ProviderStatus {
            active_provider: kind.as_str().to_string(),
            live_available,
            authenticated: snap.state == crate::session::SessionState::Connected,
            twitter_cli_version,
            agent_reach_version,
            agent_reach_installed,
            active_backend: cached
                .as_ref()
                .and_then(|h| h.channels.iter().find(|c| c.key == "twitter"))
                .and_then(|c| c.active_backend.clone()),
            message,
            // A production build has no path to synthetic content at all.
            using_mock: kind.is_synthetic(),
        })
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))?
}

/// Runtime target used by the shared React shell to choose desktop or iPhone
/// connection and navigation surfaces.
#[tauri::command]
pub fn runtime_platform() -> String {
    if cfg!(target_os = "ios") {
        "ios".into()
    } else if cfg!(target_os = "windows") {
        "windows".into()
    } else if cfg!(target_os = "macos") {
        "macos".into()
    } else if cfg!(target_os = "android") {
        "android".into()
    } else {
        std::env::consts::OS.into()
    }
}

/// Current safe pairing information for the Windows Settings page.
#[tauri::command]
pub fn iphone_companion_status(state: Sh<'_>) -> Result<CompanionHostStatus, AppError> {
    Ok(state.companion.status())
}

/// Open the explicitly enabled, read-only LAN bridge used by the iPhone app.
#[tauri::command]
pub async fn start_iphone_companion(state: Sh<'_>) -> Result<CompanionHostStatus, AppError> {
    let shared = state.inner().clone();
    shared.companion.start(Arc::downgrade(&shared)).await
}

#[tauri::command]
pub fn stop_iphone_companion(state: Sh<'_>) -> Result<CompanionHostStatus, AppError> {
    Ok(state.companion.stop())
}

// ---------------------------------------------------------------------------
// X connection and session
// ---------------------------------------------------------------------------

/// Validate a credential pair and, only if it works, store it.
///
/// The two values arrive from the masked inputs, are used to run one read-only
/// identity command, and are written to Windows Credential Manager **only after
/// that succeeds**. They are never echoed back, never logged and never stored
/// anywhere else. On failure the previously working credentials are left
/// exactly as they were.
#[tauri::command]
pub async fn sign_in_ios(state: Sh<'_>) -> Result<SessionSnapshot, AppError> {
    if !cfg!(target_os = "ios") {
        return Err(AppError::new(ErrorCode::BlockedOperation, "Twitter sign-in is available in the iPhone app."));
    }
    let st = state.inner().clone();
    claim_session_mutation(&st)?;
    let worker = st.clone();
    st.session.set_checking(true);
    crate::providers::native_ios::cancel_reads();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        #[derive(serde::Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
        #[serde(rename_all = "camelCase")]
        struct LoginResult { auth_token: String, ct0: String }
        let _authentication = crate::providers::native_ios::AuthenticationGuard::new();
        let mut candidate: AppResult<LoginResult> = crate::providers::native_ios::native_call("login", serde_json::json!({}));
        let attempt = loop {
            let result = match candidate { Ok(result) => result, Err(error) => break Err(error) };
            let verification = (|| {
                let credentials = XCredentials::parse(&result.auth_token, &result.ct0)?;
                let scratch = Arc::new(crate::credentials::MemoryStore::new());
                scratch.save(&credentials)?;
                let probe = crate::providers::native_ios::NativeIosProvider::new(scratch);
                let status = probe.status()?;
                if !status.authenticated { return Err(AppError::new(ErrorCode::NotAuthenticated, "X did not accept the session.")); }
                let committed: LoginResult = crate::providers::native_ios::login_call("commit", serde_json::json!({}))?;
                let credentials = XCredentials::parse(&committed.auth_token,&committed.ct0)?;
                commit_validated(&worker, credentials, status, probe.name())
            })();
            match verification {
                Ok(snapshot) => break Ok(snapshot),
                Err(error) => {
                    // A deliberate user choice can recheck the captured session.
                    // No automatic loop, re-entered password, or replayed mutation.
                    let recoverable = error.native_connection_fault.as_ref().is_some_and(|f|
                        ["transport_initialization","network_failure","timeout","provider_rejection",
                         "rate_limited","account_challenge","authentication_expired","unsupported_response"].contains(&f.code.as_str()));
                    if !recoverable { break Err(error); }
                    let code = error.native_connection_fault.as_ref().unwrap().code.clone();
                    candidate = crate::providers::native_ios::native_call("recoverLogin",serde_json::json!({"code":code}));
                    if let Err(recovery) = candidate {
                        if recovery.native_connection_fault.as_ref().is_some_and(|f|f.code == "cancelled") { break Err(recovery); }
                        break Err(error);
                    }
                }
            }
        };
        if let Err(error) = &attempt {
            // Validation failures also release the temporary transport session.
            // Previously only failures after Keychain commit ran this cleanup.
            let _ = crate::providers::native_ios::native_call::<serde_json::Value>("rollback", serde_json::json!({}));
            let code = error.native_connection_fault.as_ref().map(|fault|fault.code.as_str()).unwrap_or(match error.code {
                ErrorCode::NotAuthenticated|ErrorCode::CookieExpired => "authentication_expired",
                ErrorCode::ProcessTimeout => "timeout",
                ErrorCode::BlockedOperation => "cancelled",
                ErrorCode::ProviderUnavailable => "session_storage",
                _ => "network_failure",
            });
            let _ = crate::providers::native_ios::native_call::<serde_json::Value>("endLogin",serde_json::json!({"code":code}));
        } else {
            let _ = crate::providers::native_ios::login_call::<serde_json::Value>("finalize", serde_json::json!({}));
        }
        attempt
    }).await;
    st.session.set_checking(false);
    st.write_in_flight.store(false, Ordering::SeqCst);
    let snapshot = outcome.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable, "Sign-in could not complete. Try again."))??;
    Ok(st.proxy_snapshot(snapshot))
}

#[tauri::command]
pub async fn present_ios_media(state: Sh<'_>, items: Vec<serde_json::Value>, index: usize, position: Option<f64>, playing: Option<bool>, speed: Option<f64>, muted: Option<bool>, loop_playback: Option<bool>, retry_label: Option<String>, locale: Option<String>, revision: Option<u64>) -> Result<serde_json::Value, AppError> {
    if !cfg!(target_os = "ios") { return Err(AppError::new(ErrorCode::BlockedOperation,"Native media requires iOS.")); }
    let epoch=state.account_epoch();
    if items.is_empty() || items.len()>16 || index>=items.len() || position.is_some_and(|n| !n.is_finite() || !(0.0..=86400.0).contains(&n)) || speed.is_some_and(|n| !n.is_finite() || !(0.25..=3.0).contains(&n)) {
        return Err(AppError::new(ErrorCode::BlockedOperation,"Invalid media presentation."));
    }
    {
        let guard=state.proxy.lock().unwrap();
        let proxy=guard.as_ref().ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable,"Media proxy unavailable."))?;
        for item in &items {
            let url=item["url"].as_str().unwrap_or_default();
            let id=url.strip_prefix(&(proxy.base_url()+"/")).unwrap_or_default();
            if !["image","video"].contains(&item["kind"].as_str().unwrap_or_default()) || state.media.lookup(id).is_none() || proxy.url_for(id)!=url || item["alt"].as_str().is_some_and(|v| v.len()>4096) {
                return Err(AppError::new(ErrorCode::BlockedOperation,"This media is no longer available in the current account."));
            }
        }
    }
    state.ensure_account_epoch(epoch)?;
    let result=tauri::async_runtime::spawn_blocking(move || crate::providers::native_ios::native_call::<serde_json::Value>("presentMedia",serde_json::json!({"items":items,"index":index,"position":position,"playing":playing,"speed":speed,"muted":muted,"loop":loop_playback,"retryLabel":retry_label.filter(|v|v.len()<100),"locale":if locale.as_deref()==Some("ar") {"ar"}else{"en"},"revision":revision})))
        .await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable,"Media presentation ended."))??;
    state.ensure_account_epoch(epoch)?;
    Ok(result)
}

#[tauri::command]
pub async fn dismiss_ios_media(revision: Option<u64>) -> Result<(), AppError> {
    if !cfg!(target_os = "ios") { return Ok(()); }
    tauri::async_runtime::spawn_blocking(move || crate::providers::native_ios::native_call::<serde_json::Value>("dismissMedia",serde_json::json!({"revision":revision})).map(|_| ()))
        .await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable,"Media dismissal ended."))?
}

#[tauri::command]
pub async fn set_ios_chrome_visible(visible: bool, revision: Option<u64>) -> Result<(), AppError> {
    if !cfg!(target_os = "ios") { return Ok(()); }
    tauri::async_runtime::spawn_blocking(move || {
        crate::providers::native_ios::native_call::<serde_json::Value>("setChromeVisible", serde_json::json!({"visible":visible,"revision":revision})).map(|_| ())
    }).await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable,"Navigation could not update."))?
}

#[tauri::command]
pub async fn configure_ios_chrome(labels: Vec<String>, selected: String, dark: bool, visible: bool, routes: Option<Vec<String>>, accent: Option<String>, haptics: Option<bool>, rtl: Option<bool>, accessibility_labels: Option<Vec<String>>, revision: Option<u64>, follow_system: Option<bool>) -> Result<bool, AppError> {
    if !cfg!(target_os = "ios") { return Ok(false); }
    if labels.len() != 5 || labels.iter().any(|v| v.len() > 100) { return Err(AppError::new(ErrorCode::BlockedOperation, "Invalid navigation labels.")); }
    let accessibility_labels = accessibility_labels.unwrap_or_else(|| labels.clone());
    if accessibility_labels.len() != 5 || accessibility_labels.iter().any(|v| v.len() > 100) { return Err(AppError::new(ErrorCode::BlockedOperation,"Invalid navigation labels.")); }
    let routes = routes.unwrap_or_else(|| ["following","focus","bookmarks","accounts","more"].map(String::from).to_vec());
    let primary = &routes[..routes.len().min(4)];
    let tabs = serde_json::to_string(primary).unwrap_or_default();
    crate::preferences::validate(&[("navigation.tabs".into(), tabs)],false)?;
    if routes.len() != 5 || routes[4] != "more" { return Err(AppError::new(ErrorCode::BlockedOperation,"Invalid navigation.")); }
    let accent = accent.unwrap_or_default();
    crate::preferences::validate(&[("appearance.accent".into(),accent.clone())],false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result: serde_json::Value = crate::providers::native_ios::native_call("configureChrome", serde_json::json!({"labels": labels, "accessibilityLabels":accessibility_labels, "selected": selected, "dark": dark, "visible": visible,"routes":routes,"accent":accent,"haptics":haptics.unwrap_or(true),"rtl":rtl.unwrap_or(false),"revision":revision,"followSystem":follow_system.unwrap_or(false)}))?;
        Ok(result["native"].as_bool().unwrap_or(false))
    }).await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable, "Navigation could not initialize."))?
}

#[tauri::command]
pub async fn connect_x_account(
    state: Sh<'_>,
    auth_token: String,
    ct0: String,
) -> Result<SessionSnapshot, AppError> {
    if cfg!(mobile) {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "Use the native Twitter sign-in button on iPhone.",
        ));
    }
    let st = state.inner().clone();
    claim_session_mutation(&st)?;
    let worker_state = st.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        connect_blocking(&worker_state, &auth_token, &ct0)
    })
    .await
    .map_err(|e| {
        st.write_in_flight.store(false, Ordering::SeqCst);
        AppError::new(ErrorCode::ProviderUnavailable, e.to_string())
    })?;
    st.write_in_flight.store(false, Ordering::SeqCst);
    let snapshot = st.proxy_snapshot(outcome?);
    // Connecting from Settings has the same foreground-feed race as the
    // launch path. Give the newly opened feed a short head start before the
    // background Following/Bookmarks traversals begin.
    schedule_preload(st);
    Ok(snapshot)
}

/// Pair the iOS build with the read-only provider bridge in the Windows app.
///
/// The short code is exchanged for a random bearer token. Only that token and
/// the private LAN address are stored in iOS Keychain; the X cookies never
/// leave Windows.
#[tauri::command]
pub async fn connect_iphone_companion(
    state: Sh<'_>,
    address: String,
    code: String,
) -> Result<SessionSnapshot, AppError> {
    if cfg!(target_os = "ios") || !cfg!(mobile) {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "only the iPhone build can pair with a Windows companion",
        ));
    }
    let st = state.inner().clone();
    claim_session_mutation(&st)?;
    let worker_state = st.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let credentials = RemoteProvider::pair(&address, &code)?;
        let probe_store = Arc::new(crate::credentials::MemoryStore::new());
        probe_store.save(&credentials)?;
        let probe = RemoteProvider::new(probe_store);
        connect_validated(&worker_state, credentials, &probe)
    })
    .await
    .map_err(|error| {
        st.write_in_flight.store(false, Ordering::SeqCst);
        AppError::new(ErrorCode::ProviderUnavailable, error.to_string())
    })?;
    st.write_in_flight.store(false, Ordering::SeqCst);
    let snapshot = st.proxy_snapshot(outcome?);
    schedule_preload(st);
    Ok(snapshot)
}

/// The body of [`connect_x_account`], split out so the replacement guarantee is
/// directly testable.
///
/// The ordering here *is* the guarantee: nothing that can fail is allowed to
/// run after the durable store has been written.
///
///   1. Parse and validate the shape — a malformed paste never reaches a child
///      process.
///   2. Verify the pair against a **scratch** in-memory store, so the live
///      credentials are untouched while the new ones are unproven.
///   3. Resolve the account identity with those same scratch credentials.
///   4. Only once all of that has succeeded, write to the real store.
///
/// Any failure returns before step 4, so the previously working account stays
/// connected and usable.
fn connect_blocking(st: &AppState, auth_token: &str, ct0: &str) -> AppResult<SessionSnapshot> {
    let creds = XCredentials::parse(auth_token, ct0)?;

    // A scratch store, so the live credentials stay untouched while the new
    // pair is unproven.
    let probe_store = Arc::new(crate::credentials::MemoryStore::new());
    probe_store.save(&creds)?;
    let probe = crate::providers::twitter_cli::TwitterCliProvider::new(probe_store);

    connect_validated(st, creds, &probe)
}

/// Steps 2–4 of the connect flow, with the validating provider injected.
///
/// Separated so the ordering guarantee can be tested against a stub provider
/// rather than a real subprocess — a test that reached the network would be
/// slow, flaky, and would send junk credentials to X.
fn connect_validated(
    st: &AppState,
    creds: XCredentials,
    probe: &dyn XDataProvider,
) -> AppResult<SessionSnapshot> {
    let mut status = probe.status()?;
    if status.authenticated && status.account.is_none() { status.account = Some(probe.get_current_user()?); }
    commit_validated(st,creds,status,probe.name())
}
fn commit_validated(st: &AppState, creds: XCredentials, status: AuthenticationStatus, provider_name: &str) -> AppResult<SessionSnapshot> {
    if !status.authenticated {
        return Err(AppError::new(
            ErrorCode::NotAuthenticated,
            "The provider did not accept the connection.",
        )
        .with_repair("Check the connection details and try again."));
    }
    // The status response normally already carries the full profile. Keep the
    // identity fallback for providers that only return an authenticated flag.
    let account = match status.account {
        Some(account) => account,
        None => return Err(AppError::new(ErrorCode::NotAuthenticated,"The provider did not identify an account.")),
    };

    // A short commit barrier, never held during network I/O. Every provider
    // result takes it before DB/session side effects and checks this epoch.
    let _identity_barrier = st.account_commit.lock().unwrap();
    st.account_epoch.fetch_add(1, Ordering::SeqCst);
    crate::providers::native_ios::invalidate_account();

    // Save the current run's list definitions before clearing its ephemeral
    // database. This is intentionally best-effort: a storage failure must not
    // turn a valid X connection attempt into a half-connected state.
    if let Some(previous) = st.session.account() {
        if let Err(e) = persist_session_lists(st, &previous.id) {
            log::warn!("could not persist local lists before account switch: {}", e.message);
        }
    }

    // Content from any previous account must not survive the switch. This runs
    // before credentials or the new identity are recorded, so a database
    // failure leaves the old account intact rather than showing its content
    // beneath a new identity. Background workers are
    // stopped first: a traversal started under the previous account must not
    // write its rows back in after the table has been emptied.
    reset_following(st);
    st.db.clear_cache()?;
    st.store.save(&creds)?;
    st.session.reset();
    st.session.set_account(Some(account.clone()));
    let snap = st.session.apply(Probe::Authenticated {
        account: Some(account.clone()),
    });
    let _ = st.db.upsert_author(&account);

    // Remember who this is — name, handle and avatar only — so the next launch
    // can render the account chip before any network call. `from_author` drops
    // the bio and counts that came in on the profile: those are content.
    // A new connection is a new account until proven otherwise, so media
    // registered against the previous one is dropped rather than reused.
    st.media.invalidate_all();
    if let Err(e) = st
        .durable
        .set_identity(&crate::durable::AccountIdentity::from_author(
            &account,
            provider_name,
            "connected",
        ))
    {
        // Not fatal: the connection works, the chip just starts empty next run.
        log::warn!("could not record the account identity: {}", e.message);
    }
    if let Err(e) = restore_account_lists(st, &account.id) {
        log::warn!("could not restore local lists: {}", e.message);
    }
    Ok(snap)
}

/// Re-run validation against the stored credentials.
///
/// This is the only health operation in the app, and it is the narrowest one
/// the provider has: `status`, with a `whoami` fallback only when the response
/// does not include an identity. It never
/// fetches a feed, bookmarks, followed accounts, or runs Agent Reach's doctor —
/// a health check that costs as much as the work it is checking on is not a
/// health check.
///
/// Single-flight. A second caller while one is in flight gets the current
/// snapshot back instead of starting another `twitter.exe`.
#[tauri::command]
pub async fn check_session(state: Sh<'_>, force: bool) -> Result<SessionSnapshot, AppError> {
    let st = state.inner().clone();
    let worker_state = st.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || check_session_blocking(&worker_state, force))
            .await
            .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))??;
    let snapshot = st.proxy_snapshot(snapshot);
    if snapshot.state == crate::session::SessionState::Connected {
        // Let the first visible feed request win the startup bandwidth race.
        // The preload is still automatic, but it is deliberately scheduled
        // behind the reader's first interaction rather than starting two more
        // provider processes as soon as health turns green.
        schedule_preload(st);
    }
    Ok(snapshot)
}

/// The three reasons not to probe, in the order they are cheapest to answer.
///
/// Split out from the command so each one is testable without a Tauri handle
/// and, more to the point, without ever reaching a real provider: a test that
/// falls through to `check_session_inner` would spawn `twitter.exe`.
fn check_session_blocking(st: &AppState, force: bool) -> AppResult<SessionSnapshot> {
    // The launch thread already owns the health slot. Return the in-memory
    // snapshot so frontend joiners do not repeatedly re-open Credential
    // Manager while waiting for the one real provider response.
    if st.health_in_flight.load(Ordering::SeqCst) {
        return Ok(st.session.snapshot_cached());
    }
    if !st.session.has_credentials() {
        let _identity_barrier = st.account_commit.lock().unwrap();
        if st.session.has_credentials() {
            return Ok(st.session.snapshot());
        }
        st.session.reset();
        return Ok(st.session.snapshot());
    }
    // The conservative interval lives here, not in the UI, so no amount of
    // re-rendering — or of monitoring ticks — can turn this into a polling loop.
    if !force && !st.session.due_for_check(st.durable.monitor_interval_minutes()) {
        return Ok(st.session.snapshot());
    }
    // The second caller gets the current snapshot rather than a second process.
    let Some(_slot) = st.begin_health_check() else {
        return Ok(st.session.snapshot());
    };
    check_session_inner(st)
}

/// Run one health check, honouring the single-flight flag.
///
/// The shared entry point for **both** callers: the Tauri command and the
/// background probe `lib.rs` starts at launch. They used to be separate code
/// paths, and the startup thread called `provider.status()` directly — so the
/// frontend's own startup check found the flag clear and spawned a second
/// `twitter.exe` against the same session. Routing both through here is what
/// makes "exactly one startup connection test" true rather than aspirational.
///
/// Returns the current snapshot untouched when a check is already running.
pub fn probe_once(st: &AppState) -> AppResult<SessionSnapshot> {
    use std::sync::atomic::Ordering;

    if !st.session.has_credentials() {
        let _identity_barrier = st.account_commit.lock().unwrap();
        if st.session.has_credentials() {
            return Ok(st.session.snapshot());
        }
        st.session.reset();
        return Ok(st.session.snapshot());
    }
    if st
        .health_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(st.session.snapshot());
    }
    let outcome = check_session_inner(st);
    st.health_in_flight.store(false, Ordering::SeqCst);
    outcome
}

fn check_session_inner(st: &AppState) -> AppResult<SessionSnapshot> {
    {
        let epoch = st.account_epoch();
        st.session.set_checking(true);
        // Timed from immediately before the operation starts until its
        // structured result has been parsed — which is what the reader waits
        // for. Measuring only process startup would report a number that has
        // nothing to do with whether X is responding.
        let started = std::time::Instant::now();
        let probe = {
            // Keep the shared provider lock only for the provider call. The
            // session/account commit below is local work and must not make a
            // feed or profile wait behind a slow health response.
            let provider = st.provider.lock().unwrap();
            match provider.status() {
                Ok(s) if s.authenticated => {
                    // Pinned twitter-cli includes the profile in `status`, so
                    // the normal path is one child process instead of `status`
                    // plus `whoami`. Older or reduced providers can still fall
                    // back to the identity call when they only return a handle.
                    let account = if st.session.account().is_none() {
                        s.account.or_else(|| provider.get_current_user().ok())
                    } else {
                        None
                    };
                    Probe::Authenticated { account }
                }
                Ok(_) => Probe::failed(AppError::new(
                    ErrorCode::NotAuthenticated,
                    "X did not confirm this session.",
                )),
                Err(e) => Probe::failed(e),
            }
        };
        let elapsed = started.elapsed().as_millis() as u64;
        #[cfg(target_os = "ios")]
        let probe = if matches!(&probe, Probe::Authenticated { .. }) {
            let migration = (|| -> AppResult<()> {
                if let Some(credentials) = st.store.load()? {
                    let _: serde_json::Value = crate::providers::native_ios::native_call("migrateSession",serde_json::json!({"authToken":credentials.auth_token,"ct0":credentials.ct0}))?;
                }
                Ok(())
            })();
            match migration { Ok(()) => probe, Err(error) => Probe::failed(error) }
        } else { probe };
        let _identity_barrier = st.account_commit.lock().unwrap();
        st.ensure_account_epoch(epoch)?;
        if matches!(&probe, Probe::Failed(error) if error.code == ErrorCode::BlockedOperation) {
            st.session.set_checking(false); return Ok(st.session.snapshot());
        }
        // Only a completed, successful check produces a latency. A failure
        // leaves the previous figure alone rather than reporting the time it
        // took to fail, which would read as a slow connection when in fact
        // nothing came back.
        let succeeded = matches!(probe, Probe::Authenticated { .. });
        let snap = st.session.apply(probe);
        if succeeded {
            st.session.note_latency(elapsed);
            if let Some(account) = st.session.account() {
                if let Err(e) = restore_account_lists(st, &account.id) {
                    log::warn!("could not restore local lists after health check: {}", e.message);
                }
            }
            return Ok(st.session.snapshot());
        }
        Ok(snap)
    }
}

/// Cheap read of the current session state. Never performs I/O.
#[tauri::command]
pub fn session_status(state: Sh<'_>) -> Result<SessionSnapshot, AppError> {
    Ok(state.proxy_snapshot(state.session.snapshot_cached()))
}

/// Forget the connected account: delete the credentials and every cached row
/// that belonged to it.
#[tauri::command]
pub async fn disconnect_x_account(state: Sh<'_>) -> Result<SessionSnapshot, AppError> {
    let st = state.inner().clone();
    claim_session_mutation(&st)?;
    #[cfg(target_os = "ios")]
    { let generation = crate::providers::native_ios::cancel_reads(); let _ = crate::providers::native_ios::native_call::<serde_json::Value>("cancelReads", serde_json::json!({"beforeGeneration": generation})); }
    let worker_state = st.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let st = worker_state;
        // Keep the same provider -> account-commit lock order as foreground
        // requests. The commit barrier is what prevents a last worker batch
        // from being written after this clear has completed.
        let _provider_barrier = st.provider.lock().unwrap();
        let _account_barrier = st.account_commit.lock().unwrap();
        st.account_epoch.fetch_add(1, Ordering::SeqCst);
        // Disconnect clears fetched content and credentials, but local list
        // definitions belong to the account namespace and must remain so the
        // same account gets its lists back after a later reconnect.
        if let Some(account) = st.session.account() {
            if let Err(e) = persist_session_lists(&st, &account.id) {
                log::warn!(
                    "could not persist local lists before disconnect: {}",
                    e.message
                );
            }
        }
        // Clear account-scoped data before deleting the usable identity. If
        // SQLite refuses, the old session stays coherent and the caller gets
        // an error instead of a disconnected view over stale content.
        reset_following(&st);
        st.db.clear_cache()?;
        #[cfg(target_os = "ios")]
        { crate::providers::native_ios::invalidate_account(); let _: serde_json::Value = crate::providers::native_ios::native_call("logout", serde_json::json!({}))?; }
        st.store.delete()?;
        st.session.reset();
        // Every media id issued under the previous account stops resolving.
        // Without this, a proxy URL still held by a rendered card would keep
        // streaming the old account's media after a disconnect.
        st.media.invalidate_all();
        // Disconnecting must leave no trace of who was signed in, including the
        // remembered name and avatar in durable storage.
        if let Err(e) = st.durable.clear_identity() {
            log::warn!("could not clear the stored identity: {}", e.message);
        }
        Ok(st.session.snapshot())
    })
    .await
    .map_err(|e| {
        st.write_in_flight.store(false, Ordering::SeqCst);
        AppError::new(ErrorCode::ProviderUnavailable, e.to_string())
    })?;
    st.write_in_flight.store(false, Ordering::SeqCst);
    outcome
}

/// Whether credentials exist. Presence only — never a value, and there is no
/// command anywhere that can return one.
#[tauri::command]
pub fn has_credentials(state: Sh<'_>) -> Result<bool, AppError> {
    Ok(state.session.has_credentials())
}

/// How long a validated session is trusted before it is re-checked.

#[tauri::command]
pub async fn run_health_check(state: Sh<'_>, force: bool) -> Result<HealthReport, AppError> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = st.agent.health(force);
        let _ = st.db.record_health(
            "agent-reach",
            if report.error.is_some() {
                "error"
            } else {
                "ok"
            },
            report.error.as_deref().unwrap_or("doctor completed"),
        );
        Ok(report)
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::AgentReachUnavailable, e.to_string()))?
}

/// Rebuild the provider and re-validate the session. Used by the Reconnect
/// action after the user repairs a broken installation.
#[tauri::command]
pub async fn reconnect_provider(state: Sh<'_>) -> Result<ProviderStatus, AppError> {
    {
        let st = state.inner().clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let (p, k) = select_provider(st.store.clone());
            *st.provider.lock().unwrap() = p;
            *st.kind.lock().unwrap() = k;
        })
        .await;
    }
    let _ = check_session(state.clone(), true).await;
    get_provider_status(state).await
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_cached_feed(
    state: Sh<'_>,
    feed: String,
    filters: Option<FeedFilters>,
    limit: Option<i64>,
) -> Result<FeedResponse, AppError> {
    let f = filters.unwrap_or_default();
    // No cursor: nothing was fetched, so there is no live position to continue
    // from. Handing back a cursor left over from a previous run would offer a
    // "Load more" that continues someone else's request.
    let epoch = state.account_epoch();
    let st = state.inner().clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        load_feed_response(&st, &feed, &f, limit.unwrap_or(60), true, None, Some(epoch))
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))??;
    state.ensure_account_epoch(epoch)?;
    Ok(response)
}

/// Return one bounded keyset page from the complete bookmark order. The
/// provider may have discovered thousands of bookmarks, but the IPC response
/// never contains more than one reader-sized page.
#[tauri::command]
pub async fn get_bookmark_slice(
    state: Sh<'_>,
    request: BookmarkSliceRequest,
    filters: Option<FeedFilters>,
) -> Result<BookmarkSlice, AppError> {
    let f = filters.unwrap_or_default();
    let epoch = state.account_epoch();
    let st = state.inner().clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let _account_commit = st.account_commit.lock().unwrap();
        st.ensure_account_epoch(epoch)?;
        let sync_complete = st
            .db
            .get_setting(BOOKMARKS_COMPLETE)?
            .as_deref()
            == Some("1");
        st.db.load_bookmark_slice(&f, &request, sync_complete)
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))??;
    state.ensure_account_epoch(epoch)?;

    let mut response = response;
    state.proxy_media(&mut response.posts);
    Ok(response)
}

/// Which feed name maps onto which provider call, and whether a cursor may be
/// carried into it.
///
/// twitter-cli 0.8.6 accepts `--cursor` on `feed` and `list` and on nothing
/// else. `bookmarks` and `user-posts` return a first batch and stop, so a
/// cursor for them cannot exist — asking for one would silently re-fetch page
/// one and look like duplicate posts rather than depth.
fn feed_accepts_cursor(caps: &ProviderCapabilities, feed: &str) -> bool {
    if feed.starts_with("list:") {
        return caps.list_cursor;
    }
    if feed == "bookmarks" { return cfg!(target_os = "ios"); }
    if feed.starts_with("user:") { return caps.user_posts_cursor; }
    // "following", the derived "focus" feed, and "for-you" all come from `feed`.
    caps.feed_cursor
}

/// Fetch one page of `feed`, continuing from `cursor` when the command supports
/// one. Shared by the first fetch and every later one so the two cannot drift.
fn fetch_feed_page(
    provider: &dyn XDataProvider,
    feed: &str,
    max: u32,
    cursor: Option<String>,
) -> AppResult<FeedPage> {
    match feed {
        "for-you" => provider.get_for_you_feed(max, cursor),
        "bookmarks" => provider.get_bookmarks_page(max, cursor),
        other if other.starts_with("list:") => {
            provider.get_list_timeline_page(other.trim_start_matches("list:"), max, cursor)
        }
        other if other.starts_with("user:") => {
            provider.get_user_posts_page(other.trim_start_matches("user:"), max, cursor)
        }
        // "following" and the derived "focus" feed share one source.
        _ => provider.get_following_feed(max, cursor),
    }
}

/// The cursor to hand the frontend after a page came back.
///
/// Two things are refused here rather than downstream. A cursor that repeats
/// the one just sent means X has run out and is echoing the request — following
/// it would fetch the same page forever. A cursor outside the shape
/// [`security::clean_cursor`] accepts could never be sent back anyway, so
/// offering it would produce a "Load more" that always fails. Both become
/// "there is no next page", which is the truthful answer in each case.
fn next_cursor_after(page: &FeedPage, sent: Option<&str>) -> Option<String> {
    let raw = page.cursor.as_deref()?;
    let cleaned = security::clean_cursor(raw)?;
    if sent == Some(cleaned.as_str()) {
        return None;
    }
    Some(cleaned)
}

#[tauri::command]
pub async fn refresh_feed(
    state: Sh<'_>,
    feed: String,
    max: Option<u32>,
    filters: Option<FeedFilters>,
    limit: Option<i64>,
) -> Result<FeedResponse, AppError> {
    state.guard()?;
    let _foreground = state.inner().foreground_request();
    let epoch = state.account_epoch();
    let st = state.inner().clone();
    let feed2 = feed.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> AppResult<Option<String>> {
        let started = std::time::Instant::now();
        let max = max.unwrap_or(30);
        // Snapshot credentials once, then keep the shared provider mutex free
        // while twitter-cli performs the slow operation. The epoch check below
        // prevents a response captured for account A from being committed to B.
        let provider = st.background_provider()?;
        let can_page = feed_accepts_cursor(&provider.capabilities(), &feed2);
        let _priority = crate::providers::native_ios::PriorityGuard::new(0);
        let page = fetch_feed_page(provider.as_ref(), &feed2, max, None)?;
        let _commit = st.account_commit.lock().unwrap();
        st.ensure_account_epoch(epoch)?;
        *st.last_request_ms.lock().unwrap() = started.elapsed().as_millis() as u64;
        *st.last_request_count.lock().unwrap() = page.posts.len();
        st.db.save_feed_page(&feed2, &page)?;
        if feed2 == crate::database::BOOKMARKS_FEED {
            let _ = st.db.set_setting(BOOKMARKS_COMPLETE, "0");
        }
        Ok(if can_page {
            next_cursor_after(&page, None)
        } else {
            None
        })
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))?;
    state.ensure_account_epoch(epoch)?;

    let cursor = match result {
        Ok(c) => c,
        Err(e) => {
            state.note_error(&e);
            // A failed refresh may still show what this session already fetched —
            // that is genuine content from this run, not a fabricated stand-in.
            // It is labelled `fromCache` so the interface can say so.
            let f = filters.unwrap_or_default();
            if let Ok(response) = load_feed_response(
                &state,
                &feed,
                &f,
                limit.unwrap_or(60),
                true,
                None,
                Some(epoch),
            ) {
                if !response.posts.is_empty() {
                    return Ok(response);
                }
            }
            return Err(e);
        }
    };

    state.note_success();
    let f = filters.unwrap_or_default();
    let response = load_feed_response(
        &state,
        &feed,
        &f,
        limit.unwrap_or(60),
        false,
        cursor,
        Some(epoch),
    )?;
    // The foreground bookmark request is intentionally short so the first
    // cards paint quickly. Always follow it with the exhaustive background
    // pass; otherwise this refresh would make `last_sync` look complete and
    // suppress the worker that fills the rest of the list.
    if feed == "bookmarks" && !cfg!(target_os = "ios") {
        let _ = spawn_bookmark_sync(state.inner().clone());
    }
    Ok(response)
}

/// Continue a feed from a cursor the previous page returned.
///
/// Deliberately separate from [`refresh_feed`]: a refresh asks X for the newest
/// posts, this asks for older ones, and conflating them is how a "Load more"
/// ends up quietly re-fetching page one. The response contains only the newly
/// fetched page; the frontend owns the already-rendered list and appends that
/// delta locally. That keeps deep scrolling proportional to one provider page
/// instead of repeatedly serializing the whole accumulated feed.
#[tauri::command]
pub async fn load_feed_page(
    state: Sh<'_>,
    feed: String,
    cursor: Option<String>,
    max: Option<u32>,
    filters: Option<FeedFilters>,
    limit: Option<i64>,
) -> Result<FeedResponse, AppError> {
    state.guard()?;
    let _foreground = state.inner().foreground_request();
    let epoch = state.account_epoch();

    // A cursor arrives from the frontend, which means it has left the process
    // and come back: it is untrusted input by the time it reaches a command
    // line. Refuse it rather than repair it — a silently dropped cursor would
    // re-fetch page one and read as duplicate posts.
    let sent = match cursor.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(raw) => Some(security::clean_cursor(raw).ok_or_else(|| {
            AppError::new(
                ErrorCode::BlockedOperation,
                "that pagination cursor is not in a shape X issues",
            )
            .with_repair("Refresh the feed to start again from the newest posts.")
        })?),
        None => None,
    };

    let st = state.inner().clone();
    let feed2 = feed.clone();
    let sent2 = sent.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || -> AppResult<(FeedPage, Option<String>)> {
            let started = std::time::Instant::now();
            let max = max.unwrap_or(30);
            let provider = st.background_provider()?;
            if sent2.is_some() && !feed_accepts_cursor(&provider.capabilities(), &feed2) {
                return Err(AppError::new(
                    ErrorCode::BlockedOperation,
                    "this feed cannot be paged: the backend has no cursor for it",
                ));
            }
            let _priority = crate::providers::native_ios::PriorityGuard::new(1);
            let page = fetch_feed_page(provider.as_ref(), &feed2, max, sent2.clone())?;
            let _commit = st.account_commit.lock().unwrap();
            st.ensure_account_epoch(epoch)?;
            *st.last_request_ms.lock().unwrap() = started.elapsed().as_millis() as u64;
            *st.last_request_count.lock().unwrap() = page.posts.len();
            // Post id is the deduplication key, so a page that overlaps the one
            // before it updates rows instead of doubling them.
            st.db.save_feed_page(&feed2, &page)?;
            let next = next_cursor_after(&page, sent2.as_deref());
            Ok((page, next))
        })
        .await
        .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))?;
    state.ensure_account_epoch(epoch)?;

    let (page, next) = match result {
        Ok(value) => value,
        Err(e) => {
            state.note_error(&e);
            // Nothing falls back here. A failed continuation must not return
            // the rows already on screen as though the page had arrived — the
            // reader would see "Load more" do nothing and assume the feed ended.
            return Err(e);
        }
    };

    state.note_success();
    let f = filters.unwrap_or_default();
    // The page has already crossed the account barrier and been committed.
    // Filter only those new rows, then build the normal response metadata. A
    // full `load_feed_response` here would reread every older post on every
    // continuation and was the main deep-scroll cost.
    let _account_barrier = state.inner().account_commit.lock().unwrap();
    state.ensure_account_epoch(epoch)?;
    let posts = state
        .inner()
        .db
        .filter_feed_page(page.posts, &f, limit.unwrap_or(60))?;
    build_response(&state, &feed, posts, false, next)
}

/// Whether the backend can fetch a page beyond the first.
///
/// True since twitter-cli 0.8.6, which added `--cursor` to `feed` and `list`
/// and returns `pagination.nextCursor`. It stays a command rather than a
/// constant so the interface asks the backend rather than hard-coding an
/// assumption — which is precisely the assumption that had to be unwound here.
#[tauri::command]
pub fn supports_pagination(state: Sh<'_>) -> Result<bool, AppError> {
    Ok(state.provider.lock().unwrap().capabilities().feed_cursor)
}

/// Everything the active backend can do, for Diagnostics and for deciding
/// which controls exist at all.
#[tauri::command]
pub fn provider_capabilities(state: Sh<'_>) -> Result<ProviderCapabilities, AppError> {
    Ok(state.provider.lock().unwrap().capabilities())
}

#[tauri::command]
pub fn get_post(state: Sh<'_>, id: String) -> Result<Option<Post>, AppError> {
    let epoch=state.account_epoch();
    let mut found = state.db.get_post(&id)?;
    if let Some(post) = found.as_mut() {
        state.proxy_media(std::slice::from_mut(post));
    }
    state.ensure_account_epoch(epoch)?;
    Ok(found)
}

#[tauri::command]
pub fn get_posts_by_authors(
    state: Sh<'_>,
    author_ids: Vec<String>,
    limit: Option<i64>,
) -> Result<Vec<Post>, AppError> {
    let mut posts = state
        .db
        .posts_by_authors(&author_ids, limit.unwrap_or(60))?;
    state.proxy_media(&mut posts);
    Ok(posts)
}

// ---------------------------------------------------------------------------
// Reading / library state
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_read(state: Sh<'_>, post_id: String, read: bool) -> Result<(), AppError> {
    state.db.set_read(&post_id, read)?;
    Ok(())
}

#[tauri::command]
pub fn mark_many_read(state: Sh<'_>, post_ids: Vec<String>) -> Result<(), AppError> {
    for id in post_ids {
        state.db.set_read(&id, true)?;
    }
    Ok(())
}

#[tauri::command]
pub fn hide_post(state: Sh<'_>, post_id: String, hidden: bool) -> Result<(), AppError> {
    if hidden {
        state.db.hide_post(&post_id)?;
    } else {
        state.db.unhide_post(&post_id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_recent_activity(state: Sh<'_>, limit: Option<i64>) -> Result<Vec<Post>, AppError> {
    let mut posts = state.db.recent_activity(limit.unwrap_or(8))?;
    state.proxy_media(&mut posts);
    Ok(posts)
}

// ---------------------------------------------------------------------------
// Accounts / groups
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_account_relationship(state: Sh<'_>, username: String) -> Result<AccountRelationship, AppError> {
    let username = security::clean_screen_name(&username).ok_or_else(|| AppError::new(ErrorCode::BlockedOperation,"Invalid account handle."))?;
    state.guard()?;
    let epoch = state.account_epoch();
    let st = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let provider = st.provider.lock().unwrap();
        let relationship = provider.get_account_relationship(&username)?;
        st.ensure_account_epoch(epoch)?;
        if relationship != AccountRelationship::Unknown { return Ok(relationship); }
        let cached = st.db.following_accounts()?;
        if cached.iter().any(|author| author.username.eq_ignore_ascii_case(&username)) { return Ok(AccountRelationship::Following); }
        if st.db.get_setting(FOLLOWING_COMPLETE)?.as_deref() == Some("1") { return Ok(AccountRelationship::NotFollowing); }
        Ok(AccountRelationship::Unknown)
    }).await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable,"Relationship check was interrupted."))?;
    state.ensure_account_epoch(epoch)?;
    result
}

#[tauri::command]
pub async fn open_creator_subscription(username: String) -> Result<(), AppError> {
    let username = security::clean_screen_name(&username).ok_or_else(|| AppError::new(ErrorCode::BlockedOperation,"Invalid account handle."))?;
    if !cfg!(target_os = "ios") { return Err(AppError::new(ErrorCode::BlockedOperation,"Open the creator's official Twitter profile to subscribe.")); }
    tauri::async_runtime::spawn_blocking(move || crate::providers::native_ios::native_call::<serde_json::Value>("openProfile",serde_json::json!({"username":username})).map(|_| ()))
        .await.map_err(|_|AppError::new(ErrorCode::ProviderUnavailable,"The creator profile could not open."))?
}

#[tauri::command]
pub async fn get_connection_metrics(state: Sh<'_>) -> Result<serde_json::Value, AppError> {
    if !cfg!(target_os = "ios") { return Ok(serde_json::json!([])); }
    let epoch = state.account_epoch();
    let value = tauri::async_runtime::spawn_blocking(|| crate::providers::native_ios::native_call::<serde_json::Value>("connectionMetrics",serde_json::json!({})))
        .await.map_err(|_|AppError::new(ErrorCode::ProviderUnavailable,"Connection measurements are unavailable."))??;
    state.ensure_account_epoch(epoch)?;
    let samples: Vec<serde_json::Value> = value["samples"].as_array().into_iter().flatten().take(32).filter_map(|sample| {
        let id = sample["requestId"].as_str()?;
        if id.len() > 32 || !id.bytes().all(|b|b.is_ascii_digit()) { return None; }
        let mut safe = serde_json::json!({"requestId":id});
        for key in ["queueMs","bootstrapMs","providerMs","parseMs","totalMs","nativeMs"] {
            let number = sample[key].as_f64().filter(|n|n.is_finite() && *n >= 0. && *n <= 75000.)?;
            safe[key] = serde_json::json!(number);
        }
        Some(safe)
    }).collect();
    Ok(serde_json::json!(samples))
}

#[tauri::command]
pub fn pin_account(state: Sh<'_>, author_id: String, pinned: bool) -> Result<(), AppError> {
    state.db.pin_account(&author_id, pinned)?;
    Ok(())
}

#[tauri::command]
pub fn get_pinned_accounts(state: Sh<'_>) -> Result<Vec<Author>, AppError> {
    let mut authors = state.db.pinned_accounts()?;
    state.proxy_authors(&mut authors);
    Ok(authors)
}

#[tauri::command]
pub fn get_known_accounts(state: Sh<'_>) -> Result<Vec<Author>, AppError> {
    let mut authors = state.db.all_authors()?;
    state.proxy_authors(&mut authors);
    Ok(authors)
}

/// How many accounts to ask for when the caller does not say.
///
/// Measured against a real account of 191 follows: twitter-cli pages this
/// endpoint internally at roughly 20–25 per request, sequentially, and returns
/// nothing until the whole batch is assembled. The cost is close to linear —
/// 30 accounts in 2.1s, 60 in 5.2s, 191 in 36.3s — so the size of this number
/// *is* the page's time to first content. The interface asks for a small first
/// batch, renders it, then requests a larger one in the background.
pub const FOLLOWING_FIRST_PAGE: u32 = 30;

/// The ceiling for "load the full list".
///
/// `following` has no cursor, so there is no way to continue where the first
/// batch stopped — the whole list has to be asked for again in one call, and
/// the only lever is how many to stop at. twitter-cli returns everything it
/// finds and stops early when the account runs out, so this is a bound on a
/// pathological case rather than a target: an account following 5000 people
/// would otherwise page for a quarter of an hour with nothing on screen. The
/// first 30 stay readable throughout, which is what makes the wait tolerable.
pub const FOLLOWING_FULL_PAGE: u32 = crate::providers::FOLLOWING_REQUEST_MAX;

/// The accounts the connected account follows.
///
/// `following` needs a handle, which comes from the cached session identity —
/// no `status` or `whoami` round trip is made here, so one page load costs
/// exactly one provider call.
#[tauri::command]
pub async fn get_following_accounts(
    state: Sh<'_>,
    max: Option<u32>,
) -> Result<Vec<Author>, AppError> {
    state.guard()?;
    let epoch = state.account_epoch();
    let (handle, _total, provider) = state.background_account()?;
    let max = max.unwrap_or(FOLLOWING_FIRST_PAGE);
    let st = state.inner().clone();
    let live = tauri::async_runtime::spawn_blocking(move || {
        let list = provider.get_following_accounts(&handle, max)?;
        let _commit = st.account_commit.lock().unwrap();
        st.ensure_account_epoch(epoch)?;
        st.db
            .merge_following_accounts(&list, 0, &sync_id(), false)?;
        Ok(list)
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))?;
    state.ensure_account_epoch(epoch)?;
    match live {
        Ok(mut list) => {
            state.note_success();
            // Recorded as a *partial* batch: 30 accounts say nothing about the
            // ones beyond them, so nothing is pruned on the strength of it. The
            // full list is the traversal's job.
            state.proxy_authors(&mut list);
            Ok(list)
        }
        Err(e) => {
            state.note_error(&e);
            // No silent substitution: the caller renders a real error state.
            Err(e)
        }
    }
}

/// Session-scoped setting recording that a traversal reached the end of the
/// list. Cleared whenever the list stops being trustworthy.
const FOLLOWING_COMPLETE: &str = "following.syncComplete";
/// True only after the unbounded bookmark traversal reached X's end. A
/// foreground page is useful immediately but never proves completeness.
const BOOKMARKS_COMPLETE: &str = "bookmarks.syncComplete";

/// An id shared by every batch of one traversal.
///
/// Wall-clock plus a counter rather than wall-clock alone: two traversals can
/// start inside the same millisecond on a fast machine, and two traversals that
/// share an id would prune each other's rows.
fn sync_id() -> String {
    use std::sync::atomic::AtomicU64;
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}#{}",
        chrono::Utc::now().to_rfc3339(),
        N.fetch_add(1, Ordering::SeqCst)
    )
}

/// What the interface knows about the Following list right now.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowingSnapshot {
    /// Everything obtained so far, in X's own order.
    pub accounts: Vec<Author>,
    /// True only when a traversal reached the end of the list. A partial first
    /// batch, a cancelled run and a run stopped by the request ceiling all
    /// leave this false — "we have some of them" must never render as "this is
    /// who you follow".
    pub complete: bool,
    /// True while a traversal is running, so the interface can show that the
    /// list is still filling in rather than that it is short.
    pub syncing: bool,
    pub state: String,
    pub last_error: Option<String>,
    pub last_progress_at: Option<String>,
}

/// Everything obtained so far, without touching the network.
///
/// The companion to [`start_following_sync`]: the traversal writes, this reads,
/// and the progress events tell the interface when to read again.
#[tauri::command]
pub fn get_following_snapshot(state: Sh<'_>) -> Result<FollowingSnapshot, AppError> {
    following_snapshot(&state)
}

/// Release binaries always return None. Only an explicitly enabled debug
/// simulator build can register the fixed loopback fixtures.
#[tauri::command]
pub fn get_ui_test_fixture(state: Sh<'_>) -> Option<serde_json::Value> {
    #[cfg(all(feature = "dev-mock", debug_assertions, target_os = "ios"))]
    if let Ok(scenario) = std::env::var("FFN_UI_TEST_SCENARIO") {
        if !scenario.is_empty() {
            let proxy = state.proxy.lock().unwrap();
            let proxy = proxy.as_ref()?;
            let urls: Vec<String> = ["image.png", "video.mp4", "missing.png"].iter().map(|path| {
                proxy.url_for(&state.media.register_for_test(&format!("http://127.0.0.1:8769/fixtures/{path}")))
            }).collect();
            return Some(serde_json::json!({"scenario":scenario,"image":urls[0],"video":urls[1],"failedImage":urls[2]}));
        }
    }
    let _ = state;
    None
}

fn following_snapshot(state: &AppState) -> Result<FollowingSnapshot, AppError> {
    let mut accounts = state.db.following_accounts()?;
    state.proxy_authors(&mut accounts);
    let progress = state.following_progress.lock().unwrap().clone().filter(|(epoch,_,_)| state.workers.is_current(*epoch));
    let complete = state.db.get_setting(FOLLOWING_COMPLETE)?.as_deref() == Some("1");
    let (sync_state,last_error,last_progress_at) = match progress {
        Some((_,p,time)) if matches!(p.stage, crate::preload::Stage::Starting | crate::preload::Stage::Batch) && !state.workers.following.is_running() =>
            ("failed".to_owned(),Some("Account loading stopped. Try again.".to_owned()),Some(time)),
        Some((_,p,time)) => (match p.stage {
            crate::preload::Stage::Starting | crate::preload::Stage::Batch => "loading",
            crate::preload::Stage::Complete => "complete", crate::preload::Stage::Failed => "failed",
            crate::preload::Stage::Cancelled => "cancelled",
        }.to_owned(), p.message, Some(time)),
        // Every current worker stores Starting before it can be observed.
        // A claimed slot without current progress belongs to a cancelled account.
        None => ((if complete {"complete"} else {"idle"}).into(),None,None),
    };
    Ok(FollowingSnapshot {
        accounts,
        complete,
        syncing: sync_state == "loading",
        state:sync_state, last_error, last_progress_at,
    })
}

/// Begin, or continue, obtaining the complete Following list in the background.
///
/// Returns whether this call started a worker. `false` means one is already
/// running — which is a normal answer, not a failure: startup preload, a route
/// change and a manual refresh all legitimately ask.
///
/// This never blocks. `following` takes 36 seconds for 191 accounts on a real
/// account, so the only acceptable shape is "return immediately and report
/// progress", which is what [`crate::preload::FOLLOWING_PROGRESS`] is for.
#[tauri::command]
pub fn start_following_sync(state: Sh<'_>) -> Result<bool, AppError> {
    state.guard()?;
    Ok(spawn_following_sync(state.inner().clone()))
}

/// Start the traversal thread if the slot is free.
///
/// Shared by the command and by the startup preload, so the two cannot drift
/// into starting two workers between them.
pub fn spawn_following_sync(st: Arc<AppState>) -> bool {
    use crate::preload::Progress;

    let snapshot = st.session.snapshot();
    if snapshot.checking
        || snapshot.reason == crate::session::SessionReason::NotChecked
        || snapshot.reason.blocks_requests()
        || st.workers.following.is_running()
    {
        return false;
    }
    // Claim and store initial state before returning. The first snapshot can
    // now reconcile even when every progress event is missed.
    let Some(guard) = st.workers.following.claim_owned() else { return false; };
    let epoch = st.workers.epoch();
    st.emit_following(epoch, &Progress::starting(None));
    std::thread::spawn(move || {
        let _priority = crate::providers::native_ios::PriorityGuard::new(2);
        if !st.workers.is_current(epoch) {
            return;
        }
        let (handle, total, provider) = match st.background_account() {
            Ok(snapshot) => snapshot,
            Err(e) => {
                st.emit_following(epoch, &Progress::failed(0, &e));
                return;
            }
        };
        if !st.workers.is_current(epoch) {
            return;
        }
        // The account's own profile is the only honest source for a total, and
        // it is already cached from `whoami` — no extra round trip, and no
        // per-account lookups anywhere in this path.
        st.emit_following(epoch, &Progress::starting(total));

        let id = sync_id();
        let cancel = || guard.cancelled();
        let outcome = crate::preload::traverse_following(
            provider.as_ref(),
            &handle,
            total,
            &cancel,
            |batch, done| {
                if guard.cancelled() || !st.workers.is_current(epoch) {
                    return Ok(());
                }
                let _commit = st.account_commit.lock().unwrap();
                st.ensure_account_epoch(epoch)?;
                st.db.merge_following_accounts(batch, 0, &id, false)?;
                let loaded = st.db.following_count()? as usize;
                let p = Progress::batch(loaded, total);
                let _ = done;
                st.emit_following(epoch, &p);
                Ok(())
            },
        );

        match outcome {
            Ok(t) if t.cancelled || guard.cancelled() || !st.workers.is_current(epoch) => {
                st.emit_following(epoch, &Progress::cancelled(t.loaded));
            }
            Ok(t) => {
                let _commit = st.account_commit.lock().unwrap();
                if st.ensure_account_epoch(epoch).is_err() {
                    st.emit_following(epoch, &Progress::cancelled(t.loaded));
                    return;
                }
                st.note_success();
                // Pruning is only safe once the list genuinely ran out. A run
                // stopped by the request ceiling proved nothing about the
                // accounts beyond it, so its rows stay.
                if t.exhaustive {
                    if let Err(error)=st.db.prune_following_accounts(&id).and_then(|_|st.db.set_setting(FOLLOWING_COMPLETE,"1")) {
                        st.emit_following(epoch,&Progress::failed(t.loaded,&error));return;
                    }
                }
                st.emit_following(epoch, &Progress::complete(t.loaded, total));
            }
            Err(e) => {
                st.note_error(&e);
                st.emit_following(epoch, &Progress::failed(st.db.following_count().unwrap_or(0) as usize, &e));
            }
        }
    });
    true
}

/// The provider patches this build expects the provider to carry.
///
/// Read from `tools/twitter-cli/PATCH_SHA256.txt` at compile time, so the two
/// cannot drift: changing the patch without rebuilding is visible, and a
/// diagnostic report can be matched to the backend it was written against.
pub const EXPECTED_PATCH_SHA256: &str = include_str!("../../tools/twitter-cli/PATCH_SHA256.txt");

/// The unlimited bookmark request passed to the patched provider.
///
/// twitter-cli follows its own internal bookmark cursor until X returns no
/// more rows. The app deliberately has no 30/100/200/400-row bookmark ceiling.
pub const BOOKMARK_PRELOAD_MAX: u32 = crate::preload::BOOKMARKS_PRELOAD_MAX;

/// Start the background bookmark traversal if the slot is free.
///
/// Mirrors [`spawn_following_sync`]: returns immediately, claims a single-slot
/// guard so a second caller cannot start a second worker, and reports through
/// the same progress channel.
///
/// The order the provider returns is the order X bookmarked them in, and it is
/// recorded as an explicit sequence here rather than inferred later — see
/// [`crate::database::Db::record_bookmark_order`]. Nothing in this path sorts
/// by the tweet's own timestamp, which is what made an old post bookmarked
/// this morning sink to the bottom.
pub fn spawn_bookmark_sync(st: Arc<AppState>) -> bool {
    use crate::preload::{Progress, BOOKMARKS_PROGRESS};

    if st.session.snapshot().reason.blocks_requests() || st.workers.bookmarks.is_running() {
        return false;
    }
    let epoch = st.workers.epoch();
    std::thread::spawn(move || {
        let Some(guard) = st.workers.bookmarks.claim() else {
            return;
        };
        if !st.workers.is_current(epoch) {
            return;
        }
        {
            let _commit = st.account_commit.lock().unwrap();
            if st.ensure_account_epoch(epoch).is_err() {
                st.emit(BOOKMARKS_PROGRESS, &Progress::cancelled(0));
                return;
            }
            let _ = st.db.set_setting(BOOKMARKS_COMPLETE, "0");
        }
        st.emit(BOOKMARKS_PROGRESS, &Progress::starting(None));
        if guard.cancelled() {
            st.emit(BOOKMARKS_PROGRESS, &Progress::cancelled(0));
            return;
        }
        let provider = match st.background_provider() {
            Ok(provider) => provider,
            Err(e) => {
                st.emit(BOOKMARKS_PROGRESS, &Progress::failed(0, &e));
                return;
            }
        };
        if guard.cancelled() || !st.workers.is_current(epoch) {
            st.emit(BOOKMARKS_PROGRESS, &Progress::cancelled(0));
            return;
        }
        match provider.get_bookmarks(BOOKMARK_PRELOAD_MAX) {
            Ok(page) => {
                if guard.cancelled() || !st.workers.is_current(epoch) {
                    st.emit(BOOKMARKS_PROGRESS, &Progress::cancelled(0));
                    return;
                }
                let _commit = st.account_commit.lock().unwrap();
                if st.ensure_account_epoch(epoch).is_err() {
                    st.emit(BOOKMARKS_PROGRESS, &Progress::cancelled(0));
                    return;
                }
                let loaded = page.posts.len();
                // `save_feed_page` is what records the bookmark sequence, so
                // the ordering guarantee comes from using the same path the
                // foreground refresh uses rather than a shortcut of its own.
                match st.db.save_feed_page("bookmarks", &page) {
                    Ok(_) => {
                        let _ = st.db.set_setting(BOOKMARKS_COMPLETE, "1");
                        st.note_success();
                        st.emit(BOOKMARKS_PROGRESS, &Progress::complete(loaded, None));
                    }
                    Err(e) => st.emit(BOOKMARKS_PROGRESS, &Progress::failed(loaded, &e)),
                }
            }
            Err(e) => {
                st.note_error(&e);
                st.emit(BOOKMARKS_PROGRESS, &Progress::failed(0, &e));
            }
        }
    });
    true
}

/// Begin the background work that a successful startup authentication unlocks.
///
/// Called once, from the startup probe thread, and only after the session came
/// back usable — preloading against a session X has already rejected would be
/// two guaranteed failures and two child processes for nothing.
///
/// Each half is gated by its own durable preference, both default on. Returns
/// which workers were actually started, for the log.
pub fn start_preload(st: &Arc<AppState>) -> (bool, bool) {
    if st.session.snapshot().reason.blocks_requests() {
        return (false, false);
    }
    let following_needed = st
        .db
        .get_setting(FOLLOWING_COMPLETE)
        .ok()
        .flatten()
        .as_deref()
        != Some("1");
    let following_active = st.workers.following.is_running();
    let following =
        following_needed && st.durable.preload_following() && spawn_following_sync(st.clone());
    // This scheduler runs once per connected-account epoch. Do not use
    // `last_sync` as a gate here: opening Bookmarks can perform a quick
    // foreground refresh before this worker starts, and that short page must
    // not make the exhaustive background pass disappear.
    let bookmarks_requested = st.durable.preload_bookmarks();
    // Following can be a 30-second, multi-request traversal. Starting the
    // bookmark request beside it competes for the same network session and
    // rate-limit budget, even though the workers intentionally use separate
    // provider structs. Queue bookmarks behind Following so the feed and the
    // first list a reader opens remain responsive.
    let bookmarks = if bookmarks_requested && (following || following_active) {
        schedule_bookmarks_after_following(st.clone());
        true
    } else {
        bookmarks_requested && spawn_bookmark_sync(st.clone())
    };
    (following, bookmarks)
}

/// Give the foreground feed a short head start before background preloads.
///
/// The delay is cancellable in small slices so an account switch or shutdown
/// never wakes a stale worker after the new epoch has begun. This is a network
/// scheduling guard, not a correctness dependency: a later `check_session` or
/// an explicit sync can still start the workers when appropriate.
pub fn schedule_preload(st: Arc<AppState>) {
    // iPhone fetches on demand: a hidden full bookmark/following traversal must
    // never compete with the reader's visible timeline or wake suspended work.
    if cfg!(target_os = "ios") { return; }
    const GRACE_MS: u64 = 2_500;
    let epoch = st.workers.epoch();
    {
        let mut scheduled = st.preload_scheduled.lock().unwrap();
        if *scheduled == Some(epoch) {
            return;
        }
        *scheduled = Some(epoch);
    }
    std::thread::spawn(move || {
        let mut waited = 0;
        while waited < GRACE_MS {
            if !st.workers.is_current(epoch) {
                return;
            }
            let step = (GRACE_MS - waited).min(100);
            std::thread::sleep(std::time::Duration::from_millis(step));
            waited += step;
        }
        if !st.workers.is_current(epoch) || st.session.snapshot().reason.blocks_requests() {
            return;
        }
        // The grace period is only the earliest start. If the reader actually
        // opened a feed or profile, let that foreground request finish before
        // spending another provider process on background traversal. This is
        // especially important for a large media response: a fixed delay can
        // expire while the first request is still assembling its page.
        while st.workers.is_current(epoch) && st.foreground_is_busy() {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if !st.workers.is_current(epoch) || st.session.snapshot().reason.blocks_requests() {
            return;
        }
        let (following, bookmarks) = start_preload(&st);
        log::info!("scheduled preload: following={following} bookmarks={bookmarks}");
    });
}

/// Queue bookmarks after a Following traversal has released its slot.
fn schedule_bookmarks_after_following(st: Arc<AppState>) {
    let epoch = st.workers.epoch();
    std::thread::spawn(move || {
        while st.workers.is_current(epoch) && st.workers.following.is_running() {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        if !st.workers.is_current(epoch) || st.session.snapshot().reason.blocks_requests() {
            return;
        }
        if st.durable.preload_bookmarks() {
            let _ = spawn_bookmark_sync(st);
        }
    });
}

/// Forget the Following list and stop anything still filling it in.
///
/// Called on disconnect and on account switch. The order matters: cancelling
/// first means a traversal in flight cannot write the previous account's rows
/// back in after the table has been emptied. It can still land one final batch
/// from a request already in flight, which the next sync overwrites — the
/// alternative is killing a child process mid-read, which produces a partial
/// list that claims to be whole.
pub fn reset_following(st: &AppState) {
    st.workers.cancel_all();
    let _ = st.db.clear_following_accounts();
    let _ = st.db.set_setting(FOLLOWING_COMPLETE, "0");
    let _ = st.db.set_setting(BOOKMARKS_COMPLETE, "0");
}

/// Read state shared by feeds, profiles, and groups in this session.
#[tauri::command]
pub fn get_read_ids(state: Sh<'_>) -> Result<Vec<String>, AppError> {
    state.db.read_ids()
}

/// Who may be added to a group.
///
/// Backed by the real Following list and by nothing else. This used to be
/// `get_known_accounts`, which is every author seen in any payload — so a
/// reposter, a quoted author or a search hit appeared in the picker as though
/// the reader had a relationship with them.
///
/// Members who are no longer followed are still returned, flagged
/// `following: false`. Dropping them would let an unfollow quietly edit a group
/// the reader built.
#[tauri::command]
pub fn get_group_candidates(
    state: Sh<'_>,
    group_id: String,
) -> Result<Vec<crate::database::GroupCandidate>, AppError> {
    let (_, group_id) = active_list_scope(state.inner(), &group_id)?;
    let mut candidates = state.db.group_candidates(&group_id)?;
    for candidate in &mut candidates { state.proxy_authors(std::slice::from_mut(&mut candidate.author)); }
    Ok(candidates)
}

/// One account's profile, for the internal profile page.
#[tauri::command]
pub async fn get_user_profile(state: Sh<'_>, username: String) -> Result<Author, AppError> {
    state.guard()?;
    let _foreground = state.inner().foreground_request();
    let epoch = state.account_epoch();
    let st = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Use a credential snapshot so a slow profile request does not hold
        // the shared provider mutex and block the feed or health check.
        let provider = st.background_provider()?;
        let author = provider.get_user_profile(&username)?;
        let _commit = st.account_commit.lock().unwrap();
        st.ensure_account_epoch(epoch)?;
        st.db.upsert_author(&author)?;
        Ok(author)
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))?;
    state.ensure_account_epoch(epoch)?;
    match result {
        Ok(mut author) => {
            state.note_success();
            state.proxy_authors(std::slice::from_mut(&mut author));
            Ok(author)
        }
        Err(e) => {
            state.note_error(&e);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn create_group(
    state: Sh<'_>,
    id: String,
    name: String,
    color: Option<String>,
) -> Result<(), AppError> {
    let id = security::clean_local_list_id(&id)
        .ok_or_else(|| AppError::new(ErrorCode::ApiError, "invalid local list id"))?;
    let account_id = active_account_id(state.inner())?;
    let color = color.unwrap_or_else(|| "#6366f1".into());
    state
        .durable
        .upsert_account_list(&account_id, &id, &name, &color)?;
    state.db.create_group(&id, &name, &color)?;
    Ok(())
}

#[tauri::command]
pub fn update_group(
    state: Sh<'_>,
    id: String,
    name: String,
    color: String,
) -> Result<(), AppError> {
    let (account_id, id) = active_list_scope(state.inner(), &id)?;
    state
        .durable
        .upsert_account_list(&account_id, &id, &name, &color)?;
    state.db.update_group(&id, &name, &color)?;
    Ok(())
}

#[tauri::command]
pub fn delete_group(state: Sh<'_>, id: String) -> Result<(), AppError> {
    let (account_id, id) = active_list_scope(state.inner(), &id)?;
    state.durable.delete_account_list(&account_id, &id)?;
    state.db.delete_group(&id)?;
    Ok(())
}

#[tauri::command]
pub fn set_group_member(
    state: Sh<'_>,
    group_id: String,
    author_id: String,
    member: bool,
) -> Result<(), AppError> {
    let (account_id, group_id) = active_list_scope(state.inner(), &group_id)?;
    let author_id = author_id.trim().to_string();
    if author_id.is_empty() || author_id.len() > 64 {
        return Err(AppError::new(ErrorCode::ApiError, "invalid account id"));
    }
    if member && !state.db.is_following(&author_id)? {
        // Preserve an existing member who was unfollowed, but never allow a
        // new public/unfollowed account to be inserted through a direct IPC
        // call that bypasses the Following-backed picker.
        let already_member = state
            .db
            .group_member_ids(&group_id)?
            .iter()
            .any(|id| id == &author_id);
        if !already_member {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                "only accounts you follow can be added to a list",
            ));
        }
    }
    state.durable.set_account_list_member(
        &account_id,
        &group_id,
        &author_id,
        member,
    )?;
    state.db.set_group_member(&group_id, &author_id, member)?;
    Ok(())
}

#[tauri::command]
pub fn get_groups(state: Sh<'_>) -> Result<Vec<Group>, AppError> {
    let account_id = active_account_id(state.inner())?;
    restore_account_lists(state.inner(), &account_id)?;
    state.db.groups()
}

/// Full durable list definitions for consumers that need the account scope and
/// member ids (the legacy `get_groups` summary remains for the existing page).
#[tauri::command]
pub fn get_account_lists(state: Sh<'_>) -> Result<Vec<crate::models::AccountList>, AppError> {
    let account_id = active_account_id(state.inner())?;
    state.durable.account_lists(&account_id)
}

#[tauri::command]
pub fn get_group_members(state: Sh<'_>, group_id: String) -> Result<Vec<String>, AppError> {
    let (_, group_id) = active_list_scope(state.inner(), &group_id)?;
    state.db.group_member_ids(&group_id)
}

// ---------------------------------------------------------------------------
// Group feeds
// ---------------------------------------------------------------------------

/// How many posts to ask for from each member of a group.
///
/// The old group feed asked for nothing at all — it read whatever the cache
/// happened to hold, which for most members was the single post that had
/// appeared in the Following feed. That is the whole defect: a "group feed"
/// that is one post per account is a list of accounts, not a feed.
pub const GROUP_POSTS_PER_ACCOUNT: u32 = 15;

/// How many members one refresh call fetches for.
///
/// `user-posts` is a child process per account and there is no batch form, so
/// the cost is linear in group size. Bounding it per call is what keeps a
/// twenty-account group from being a ninety-second request; the rest continue
/// from `nextOffset`.
pub const GROUP_ACCOUNTS_PER_CALL: usize = 6;

/// One member the refresh could not read, and why.
///
/// Reported rather than swallowed, and reported *alongside* the posts that did
/// arrive. A group feed that fails wholesale because one account is suspended
/// or protected is worse than one that says which account it could not reach.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountFailure {
    pub username: String,
    pub code: String,
    /// Sanitised — this reaches the interface.
    pub message: String,
}

/// A group refresh: the merged page, what failed, and where to continue.
///
/// Deliberately not `Debug`. It carries a `FeedResponse`, which carries the
/// reader's posts, and a type that can be `{:?}`-printed is a type that
/// eventually ends up in a log line. `FeedResponse` is not `Debug` for the same
/// reason; the fix for this struct is to drop the derive, not to add one there.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupFeedResponse {
    #[serde(flatten)]
    pub feed: FeedResponse,
    /// Members that could not be read this time. Empty is the normal case.
    pub failures: Vec<AccountFailure>,
    /// Where the next call should start in the member list, or `None` when
    /// every member has been fetched for.
    pub next_offset: Option<usize>,
    /// How many members the group has, so the interface can show "6 of 20
    /// accounts loaded" rather than an unexplained partial page.
    pub member_count: usize,
    /// Members reached successfully by this call.
    pub loaded_accounts: usize,
}

/// The feed name a group's posts are stored under.
fn group_feed_name(group_id: &str) -> String {
    format!("group:{group_id}")
}

/// The cached combined timeline of a group. No network.
#[tauri::command]
pub async fn get_group_feed(
    state: Sh<'_>,
    group_id: String,
    filters: Option<FeedFilters>,
    limit: Option<i64>,
) -> Result<FeedResponse, AppError> {
    let (_, group_id) = active_list_scope(state.inner(), &group_id)?;
    let epoch = state.account_epoch();
    let st = state.inner().clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let _account_barrier = st.account_commit.lock().unwrap();
        st.ensure_account_epoch(epoch)?;
        let members = st.db.group_member_ids(&group_id)?;
        let posts =
            st.db
                .group_timeline(&members, &filters.unwrap_or_default(), limit.unwrap_or(60))?;
        build_response(&st, &group_feed_name(&group_id), posts, true, None)
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))??;
    state.ensure_account_epoch(epoch)?;
    Ok(response)
}

/// Fetch recent posts for a slice of a group's members and return the merged
/// page.
///
/// `offset` continues where a previous call stopped. It walks the *member
/// list*, not a cursor: `user-posts` has no cursor, so depth per account comes
/// from `--max` and breadth across the group comes from calling again.
///
/// A member that fails is recorded in `failures` and skipped. Everything that
/// succeeded is still stored and still returned — the alternative, failing the
/// whole request because one account is protected, throws away work that was
/// already paid for.
#[tauri::command]
pub async fn refresh_group_feed(
    state: Sh<'_>,
    group_id: String,
    offset: Option<usize>,
    per_account: Option<u32>,
    filters: Option<FeedFilters>,
    limit: Option<i64>,
) -> Result<GroupFeedResponse, AppError> {
    state.guard()?;
    let (_, group_id) = active_list_scope(state.inner(), &group_id)?;
    let epoch = state.account_epoch();
    let members = state.db.group_member_ids(&group_id)?;
    let member_count = members.len();
    let offset = offset.unwrap_or(0).min(member_count);
    let per_account = per_account.unwrap_or(GROUP_POSTS_PER_ACCOUNT);

    // Handles, not ids: `user-posts` takes a screen name. They come from this
    // session's author cache, so there is no per-account profile lookup — the
    // N+1 that a naive "resolve each member" would introduce.
    let slice: Vec<String> = members
        .iter()
        .skip(offset)
        .take(GROUP_ACCOUNTS_PER_CALL)
        .cloned()
        .collect();
    let handles: Vec<String> = state
        .db
        .authors_by_ids(&slice)?
        .into_iter()
        .map(|a| a.username)
        .filter(|u| !u.is_empty() && u != "unknown")
        .collect();

    let feed = group_feed_name(&group_id);
    let st = state.inner().clone();
    let feed2 = feed.clone();
    let fetched =
        tauri::async_runtime::spawn_blocking(move || -> AppResult<(usize, Vec<AccountFailure>)> {
            let mut failures = Vec::new();
            let mut ok = 0usize;
            // Do not hold the shared provider mutex across the whole six-account
            // batch. Each child uses this credential snapshot, while the epoch
            // check before every write keeps an account switch fail-closed.
            let provider = st.background_provider()?;
            for handle in handles {
                let page = provider.get_user_posts(&handle, per_account);
                match page {
                    Ok(page) => {
                        let _commit = st.account_commit.lock().unwrap();
                        if let Err(e) = st.ensure_account_epoch(epoch) {
                            failures.push(AccountFailure {
                                username: handle,
                                code: format!("{:?}", e.code),
                                message: security::sanitize(&e.message),
                            });
                            break;
                        }
                        ok += 1;
                        // Stored under the group's own feed name as well as
                        // deduplicated into `posts` by id, so the group has a real
                        // `last_sync` and the rows are shared with every other view
                        // rather than duplicated.
                        if let Err(e) = st.db.save_feed_page(&feed2, &page) {
                            log::warn!("could not store {handle}'s posts: {}", e.message);
                        }
                    }
                    Err(e) => failures.push(AccountFailure {
                        username: handle,
                        code: format!("{:?}", e.code),
                        message: security::sanitize(&e.message),
                    }),
                }
            }
            Ok((ok, failures))
        })
        .await
        .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))??;
    let (loaded_accounts, failures) = fetched;
    if loaded_accounts > 0 {
        state.note_success();
    }

    let next = offset + slice.len();
    let _account_barrier = state.account_commit.lock().unwrap();
    state.ensure_account_epoch(epoch)?;
    let posts =
        state
            .db
            .group_timeline(&members, &filters.unwrap_or_default(), limit.unwrap_or(60))?;
    let feed_response = build_response(&state, &feed, posts, loaded_accounts == 0, None)?;
    Ok(GroupFeedResponse {
        feed: feed_response,
        failures,
        next_offset: (next < member_count).then_some(next),
        member_count,
        loaded_accounts,
    })
}

// ---------------------------------------------------------------------------
// Lists / bookmarks
// ---------------------------------------------------------------------------

/// The X Lists the user has added by id.
///
/// twitter-cli has no command that enumerates an account's Lists — `list`
/// requires a list id — so there is nothing to discover. These are the entries
/// the user added themselves, which is durable user-authored data, not fetched
/// content. Returning an invented directory here is exactly the fabrication
/// this release removes.
#[tauri::command]
pub fn get_lists(state: Sh<'_>) -> Result<Vec<XList>, AppError> {
    state.db.saved_lists()
}

#[tauri::command]
pub fn add_list(state: Sh<'_>, id: String, name: String) -> Result<(), AppError> {
    let id = security::clean_numeric_id(&id).ok_or_else(|| {
        AppError::new(
            ErrorCode::ApiError,
            "an X List id is the number at the end of its URL",
        )
    })?;
    state.db.add_saved_list(&id, name.trim())?;
    Ok(())
}

#[tauri::command]
pub fn remove_list(state: Sh<'_>, id: String) -> Result<(), AppError> {
    state.db.remove_saved_list(&id)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dashboard / settings / diagnostics
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_dashboard(state: Sh<'_>) -> Result<DashboardStats, AppError> {
    state.db.stats()
}

/// The connected account, from the session cache. Returns `None` rather than
/// an invented placeholder when nothing is connected.
#[tauri::command]
pub fn get_current_user(state: Sh<'_>) -> Result<Option<Author>, AppError> {
    let mut author = state.session.account();
    if let Some(author) = author.as_mut() { state.proxy_authors(std::slice::from_mut(author)); }
    Ok(author)
}

/// Every setting the interface can read, from both stores.
///
/// Durable ones win on a key collision: a stale session row must never shadow
/// the preference the user actually chose.
#[tauri::command]
pub fn get_settings(state: Sh<'_>) -> Result<Vec<(String, String)>, AppError> {
    settings_inner(&state)
}

fn settings_inner(state: &AppState) -> AppResult<Vec<(String, String)>> {
    let durable = state.durable.all_preferences()?;
    let mut out: Vec<(String, String)> = state
        .db
        .all_settings()?
        .into_iter()
        .filter(|(k, _)| !crate::durable::is_durable_preference(k))
        .collect();
    out.extend(durable);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

#[tauri::command]
pub fn set_setting(state: Sh<'_>, key: String, value: String) -> Result<(), AppError> {
    set_setting_inner(&state, &key, &value)
}

#[tauri::command]
pub fn set_preferences_batch(state: Sh<'_>, entries: Vec<(String,String)>, portable: bool) -> Result<(),AppError> {
    state.durable.set_preferences_batch(&entries, portable)
}
#[tauri::command]
pub async fn share_preferences(entries: Vec<(String,String)>) -> Result<(),AppError> {
    crate::preferences::validate(&entries,true)?;
    if !cfg!(target_os="ios") { return Err(AppError::new(ErrorCode::BlockedOperation,"Use file export on desktop.")); }
    tauri::async_runtime::spawn_blocking(move || crate::providers::native_ios::native_call::<serde_json::Value>("sharePreferences",serde_json::json!({"bundle":serde_json::json!({"version":1,"preferences":entries}).to_string()})))
        .await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable,"Export could not complete."))??;
    Ok(())
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSearchPage { posts: Vec<Post>, read_ids: Vec<String>, next_offset: Option<i64> }
#[tauri::command]
pub async fn search_cached_posts(state: Sh<'_>, query: String, offset: i64) -> Result<CachedSearchPage,AppError> {
    if query.len() > 512 || !(0..=1_000_000).contains(&offset) { return Err(AppError::new(ErrorCode::BlockedOperation, "Invalid search.")); }
    let st = state.inner().clone();
    let epoch = st.account_epoch();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _barrier = st.account_commit.lock().unwrap();
        st.ensure_account_epoch(epoch)?;
        let mut posts = st.db.search_cached_posts(&query, offset, 51)?;
        let next_offset = if posts.len() > 50 { posts.truncate(50); Some(offset + 50) } else { None };
        st.proxy_media(&mut posts);
        Ok(CachedSearchPage { posts, read_ids: st.db.read_ids()?, next_offset })
    }).await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable, "Search could not complete."))?;
    state.ensure_account_epoch(epoch)?;
    result
}
#[tauri::command]
pub async fn runtime_snapshot() -> Result<serde_json::Value,AppError> {
    if !cfg!(target_os = "ios") { return Ok(serde_json::json!({})); }
    tauri::async_runtime::spawn_blocking(|| crate::providers::native_ios::native_call("runtime", serde_json::json!({})))
        .await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable, "Device status unavailable."))?
}
#[tauri::command]
pub async fn cancel_native_reads() -> Result<(),AppError> {
    let generation = crate::providers::native_ios::cancel_reads();
    if !cfg!(target_os = "ios") { return Ok(()); }
    tauri::async_runtime::spawn_blocking(move || crate::providers::native_ios::native_call::<serde_json::Value>("cancelReads", serde_json::json!({"beforeGeneration":generation})))
        .await.map_err(|_| AppError::new(ErrorCode::ProviderUnavailable, "Request cancellation failed."))??;
    Ok(())
}

/// Route a setting to the store its key belongs to.
///
/// Allowlisted preferences go to the durable store and survive a restart;
/// everything else goes to the session database and dies with the run. The
/// credential-shape check is a second line of defence — the connect flow never
/// routes through here — so that a future caller cannot accidentally make
/// SQLite a credential store.
fn set_setting_inner(state: &AppState, key: &str, value: &str) -> AppResult<()> {
    if security::is_credential_shaped_key(key) {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "credential-like keys cannot be stored in settings",
        ));
    }
    if crate::durable::is_durable_preference(key) {
        state.durable.set_preference(key, value)?;
    } else {
        state.db.set_setting(key, value)?;
    }
    Ok(())
}

/// Command bodies reachable without a Tauri `State`.
///
/// `State` cannot be constructed outside a running app, so integration tests
/// would otherwise have to duplicate the routing logic they are meant to be
/// checking. These call exactly the same functions the commands do.
#[cfg(test)]
pub mod testing {
    use super::*;

    pub fn set_setting(state: &AppState, key: &str, value: &str) -> AppResult<()> {
        set_setting_inner(state, key, value)
    }

    pub fn settings(state: &AppState) -> AppResult<Vec<(String, String)>> {
        settings_inner(state)
    }

    pub(crate) use super::AccountAction;

    /// The pre-flight gates of an account action, including claiming the
    /// single-write flag. Mirrors what the command does before spawning.
    pub(crate) fn begin_account_action(
        state: &AppState,
        action: AccountAction,
        confirmed: bool,
    ) -> AppResult<()> {
        super::begin_account_action(state, action, confirmed)
    }

    /// The worker half. Callers pair it with [`begin_account_action`] and clear
    /// the flag, exactly as the command does.
    pub(crate) fn perform_account_action(
        state: &AppState,
        action: AccountAction,
        username: &str,
    ) -> AppResult<()> {
        super::perform_account_action(state, action, username)
    }

    pub(crate) fn end_account_action(state: &AppState) {
        state
            .write_in_flight
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// The two account-changing actions
// ---------------------------------------------------------------------------

/// Which direction an account action goes.
///
/// Follow and unfollow are inverses of one another and share every gate, so
/// they share one implementation. What differs is exactly two things — which
/// permit constructor applies and which provider method runs — and keeping the
/// difference this small is what makes "the follow path is no weaker than the
/// unfollow path" checkable rather than a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccountAction {
    Follow,
    Unfollow,
}

impl AccountAction {
    fn verb(self) -> &'static str {
        match self {
            AccountAction::Follow => "follow",
            AccountAction::Unfollow => "unfollow",
        }
    }

    /// `allowed` must come from the durable preference; the permit type is what
    /// carries that fact into the provider.
    fn permit(self, allowed: bool) -> Option<security::WritePermit> {
        match self {
            AccountAction::Follow => security::WritePermit::follow(allowed),
            AccountAction::Unfollow => security::WritePermit::unfollow(allowed),
        }
    }

    fn run(
        self,
        provider: &dyn XDataProvider,
        username: &str,
        permit: &security::WritePermit,
    ) -> AppResult<()> {
        match self {
            AccountAction::Follow => provider.follow_account(username, permit),
            AccountAction::Unfollow => provider.unfollow_account(username, permit),
        }
    }
}

/// Whether account actions are currently permitted. Read by the interface to
/// decide whether the Follow / Unfollow control exists at all.
///
/// One preference covers both directions — see [`security::WritePermit::follow`]
/// for why — so this answers for both. The command keeps its original name so
/// the existing frontend binding and the stored key stay in step.
#[tauri::command]
pub fn unfollow_allowed(state: Sh<'_>) -> Result<bool, AppError> {
    Ok(state.durable.allow_unfollow())
}

/// Stop following an account.
///
/// Four independent gates, in order, and all of them are on this side of the
/// IPC boundary:
///
/// 1. `confirmed` must be true. The interface shows a dialog naming the exact
///    handle; this makes a mis-wired caller fail rather than act.
/// 2. The durable preference must be on. When it is off **no child process is
///    started at all** — the refusal happens before any argument is built.
/// 3. A [`security::WritePermit`] must be constructible, which is only true if
///    (2) held. The provider method cannot be called without one.
/// 4. Nothing else may be in flight.
///
/// There is no retry. A failed unfollow is reported and left alone: retrying an
/// operation that changes somebody's account, when the failure might mean "it
/// already worked and the response was lost", is not a decision this app makes
/// on the reader's behalf.
#[tauri::command]
pub async fn unfollow_account(
    state: Sh<'_>,
    username: String,
    confirmed: bool,
) -> Result<(), AppError> {
    account_action(state, AccountAction::Unfollow, username, confirmed).await
}

/// Start following an account.
///
/// The same four gates in the same order as [`unfollow_account`], including the
/// confirmation: following somebody is still a change to the reader's real
/// account and still shows up on the other person's notifications.
///
/// There is no bulk form and no retry, for the same reasons.
#[tauri::command]
pub async fn follow_account(
    state: Sh<'_>,
    username: String,
    confirmed: bool,
) -> Result<(), AppError> {
    account_action(state, AccountAction::Follow, username, confirmed).await
}

/// Remove one bookmark from the connected X account. This is intentionally a
/// post-specific write path, separate from Follow/Unfollow preferences: the
/// dialog confirmation is the permission boundary for this destructive action.
#[tauri::command]
pub async fn remove_bookmark(
    state: Sh<'_>,
    post_id: String,
    confirmed: bool,
) -> Result<(), AppError> {
    begin_bookmark_action(&state, &post_id, confirmed)?;
    let st = state.inner().clone();
    let epoch = st.account_epoch();
    let id = post_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        perform_bookmark_action(&st, &id, epoch)
    })
    .await
    .map_err(|e| {
        state.write_in_flight.store(false, Ordering::SeqCst);
        AppError::new(ErrorCode::ProviderUnavailable, e.to_string())
    })?;
    let result = match outcome {
        Ok(()) => {
            state.note_success();
            Ok(())
        }
        Err(e) => {
            state.note_error(&e);
            Err(e)
        }
    };
    state.write_in_flight.store(false, Ordering::SeqCst);
    result
}

/// The shared body of both account actions.
async fn account_action(
    state: Sh<'_>,
    action: AccountAction,
    username: String,
    confirmed: bool,
) -> Result<(), AppError> {
    use std::sync::atomic::Ordering;

    // Everything that can refuse without touching a child process happens here,
    // and on success this has claimed the single-write flag.
    begin_account_action(&state, action, confirmed)?;

    let handle = username.clone();
    let st = state.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        perform_account_action(&st, action, &username)
    })
    .await
    .map_err(|e| {
        // The worker never ran, so nothing else will clear the flag.
        state.write_in_flight.store(false, Ordering::SeqCst);
        AppError::new(ErrorCode::ProviderUnavailable, e.to_string())
    })?;

    let result = match outcome {
        Ok(()) => {
            state.note_success();
            reconcile_following(&state, action, &handle);
            Ok(())
        }
        Err(e) => {
            state.note_error(&e);
            Err(e)
        }
    };
    state.write_in_flight.store(false, Ordering::SeqCst);
    result
}

/// Use the account-action slot for credential/identity changes as well. This
/// prevents a Follow intended for A from starting with B's newly saved pair.
fn claim_session_mutation(st: &AppState) -> AppResult<()> {
    if st
        .write_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "an account action or connection change is already running",
        )
        .with_repair("Wait for it to finish, then try again."));
    }
    Ok(())
}

/// Bring the Following list back in step with an action that just succeeded.
///
/// Without this, an account the reader unfollowed a moment ago is still offered
/// as a group candidate for the rest of the session — the traversal is far too
/// expensive to re-run for a one-account delta.
///
/// A follow of somebody this session has never cached cannot be placed: there
/// is no author row and inventing one from a handle would put a fabricated
/// account in the picker. The list is marked incomplete instead, so the
/// interface can say so and the next traversal resolves it.
fn reconcile_following(st: &AppState, action: AccountAction, username: &str) {
    let followed = matches!(action, AccountAction::Follow);
    match st.db.set_following_by_username(username, followed) {
        Ok(true) => {}
        _ => {
            let _ = st.db.set_setting(FOLLOWING_COMPLETE, "0");
        }
    }
}

/// Gates 1, 2 and 4. Returns `Ok` only after claiming `write_in_flight`, so
/// every caller must ensure the flag is cleared afterwards.
fn begin_account_action(st: &AppState, action: AccountAction, confirmed: bool) -> AppResult<()> {
    use std::sync::atomic::Ordering;

    let verb = action.verb();
    if !confirmed {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            format!("{verb} was not confirmed"),
        ));
    }
    if !st.durable.allow_unfollow() {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "Account actions are turned off.",
        )
        .with_repair("Turn on Settings → Actions → Allow Unfollow actions first."));
    }
    st.guard()?;

    // `compare_exchange` rather than read-then-write: two dialogs confirmed in
    // the same instant must not both pass. One flag covers both directions, so
    // a follow cannot race an unfollow either.
    if st
        .write_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "another account action is already running",
        )
        .with_repair("Wait for it to finish, then try again."));
    }
    Ok(())
}

/// Gate 3 and the operation itself. Runs on a worker thread.
fn perform_account_action(st: &AppState, action: AccountAction, username: &str) -> AppResult<()> {
    match action.permit(st.durable.allow_unfollow()) {
        // Re-checked here: the preference could have been turned off between
        // the pre-flight check and this line.
        None => Err(AppError::new(
            ErrorCode::BlockedOperation,
            "Account actions are turned off.",
        )),
        Some(permit) => {
            let provider = st.provider.lock().unwrap();
            action.run(&**provider, username, &permit)
        }
    }
}

fn begin_bookmark_action(st: &AppState, post_id: &str, confirmed: bool) -> AppResult<()> {
    if !confirmed {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "bookmark removal was not confirmed",
        ));
    }
    if security::clean_numeric_id(post_id).is_none() {
        return Err(AppError::new(ErrorCode::ApiError, "invalid post id"));
    }
    st.guard()?;
    // A cheap authenticated/status probe can be valid without carrying a
    // profile. Bookmark writes still need an explicit account identity so a
    // confirmed action cannot run against an ambiguous session namespace.
    active_account_id(st)?;
    if !st.provider.lock().unwrap().capabilities().unbookmark {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "this provider cannot remove X bookmarks",
        ));
    }
    if st
        .write_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "another account action is already running",
        ));
    }
    Ok(())
}

fn perform_bookmark_action(st: &AppState, post_id: &str, epoch: u64) -> AppResult<()> {
    let permit = security::BookmarkPermit::confirmed(true).ok_or_else(|| {
        AppError::new(
            ErrorCode::BlockedOperation,
            "bookmark removal was not confirmed",
        )
    })?;
    {
        let provider = st.provider.lock().unwrap();
        provider.remove_bookmark(post_id, &permit)?;
    }
    let _account_barrier = st.account_commit.lock().unwrap();
    st.ensure_account_epoch(epoch)?;
    st.db.remove_bookmark(post_id)?;
    Ok(())
}

#[tauri::command]
pub fn get_muted_words(state: Sh<'_>) -> Result<Vec<String>, AppError> {
    state.db.muted_words()
}

#[tauri::command]
pub fn set_muted_word(state: Sh<'_>, word: String, muted: bool) -> Result<(), AppError> {
    state.db.set_muted_word(&word, muted)?;
    Ok(())
}

#[tauri::command]
pub fn clear_cache(state: Sh<'_>) -> Result<(), AppError> {
    // Cache clearing is also an invalidation boundary. Without a new epoch, a
    // foreground fetch that was already on the wire could save its old page
    // immediately after this command emptied the database.
    let _account_barrier = state.account_commit.lock().unwrap();
    state.account_epoch.fetch_add(1, Ordering::SeqCst);
    reset_following(&state);
    state.db.clear_cache()?;
    state.media.invalidate_all();
    Ok(())
}

/// A copyable diagnostic report. Sanitized: it can never contain cookies or
/// tokens, only whether credentials are present.
#[tauri::command]
pub async fn diagnostics_report(state: Sh<'_>) -> Result<String, AppError> {
    let st = state.inner().clone();
    if cfg!(target_os = "ios") {
        return tauri::async_runtime::spawn_blocking(|| {
            let snapshot: serde_json::Value = crate::providers::native_ios::native_call("connectionDiagnostics",serde_json::json!({}))?;
            serde_json::to_string_pretty(&snapshot).map_err(|_|AppError::new(ErrorCode::ProviderUnavailable,"Diagnostic report could not be generated."))
        }).await.map_err(|_|AppError::new(ErrorCode::ProviderUnavailable,"Diagnostic report could not be generated."))?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let health = st.agent.health(false);
        let live = crate::providers::twitter_cli::TwitterCliProvider::new(st.store.clone());
        let stats = st.db.stats().unwrap_or_default();
        let kind = *st.kind.lock().unwrap();
        let snap = st.session.snapshot();

        let mut s = String::new();
        s.push_str("Focus Feed Next - diagnostic report\n");
        s.push_str(&format!(
            "app version:        {}\n",
            env!("CARGO_PKG_VERSION")
        ));
        s.push_str(&format!(
            "generated:          {}\n",
            chrono::Utc::now().to_rfc3339()
        ));
        s.push_str(&format!("active provider:    {}\n", kind.as_str()));
        // Which provider patches this build was written against, so a report
        // can be matched to a backend. The hashes name the patch set, not the
        // installed copy: video quality and exhaustive bookmark completion are
        // the runtime observables that confirm the provider carries it.
        s.push_str(&format!(
            "provider pin:       {}\n",
            crate::providers::twitter_cli::PINNED_COMMIT
        ));
        s.push_str(&format!(
            "provider patches:   {}\n",
            EXPECTED_PATCH_SHA256.trim()
        ));
        s.push_str(&format!(
            "agent reach:        {} ({})\n",
            if health.agent_reach_installed {
                "installed"
            } else {
                "not installed"
            },
            health
                .agent_reach_version
                .clone()
                .unwrap_or_else(|| "unknown".into())
        ));
        s.push_str(&format!(
            "twitter-cli:        {} ({})\n",
            if live.is_installed() {
                "installed"
            } else {
                "not installed"
            },
            live.version().unwrap_or_else(|| "unknown".into())
        ));
        s.push_str(&format!(
            "active x backend:   {}\n",
            health
                .channels
                .iter()
                .find(|c| c.key == "twitter")
                .and_then(|c| c.active_backend.clone())
                .unwrap_or_else(|| "none".into())
        ));
        // Presence only. There is no code path anywhere that can put a
        // credential value into this report.
        s.push_str(&format!(
            "credentials:        {} (Windows Credential Manager, values never read)\n",
            if snap.has_credentials {
                "stored"
            } else {
                "not stored"
            }
        ));
        s.push_str(&format!(
            "session:            {:?} / {:?}\n",
            snap.state, snap.reason
        ));
        s.push_str(&format!(
            "account:            {}\n",
            snap.account
                .as_ref()
                .map(|a| format!("@{}", a.username))
                .unwrap_or_else(|| "none".into())
        ));
        s.push_str(&format!("last health check:  {}\n", health.checked_at));
        s.push_str(&format!(
            "last request:       {} ms, {} posts\n",
            st.last_request_ms.lock().unwrap(),
            st.last_request_count.lock().unwrap()
        ));
        let proxy_status = st
            .proxy
            .lock()
            .unwrap()
            .as_ref()
            .map(|proxy| format!("loopback:{}", proxy.port()))
            .unwrap_or_else(|| "unavailable".into());
        s.push_str(&format!("media proxy:        {proxy_status}\n"));
        s.push_str(&format!(
            "media registrations: {} / 1024\n",
            st.media.len()
        ));
        s.push_str(&format!(
            "bookmarks sync:     {}\n",
            if st
                .db
                .get_setting(BOOKMARKS_COMPLETE)
                .ok()
                .flatten()
                .as_deref()
                == Some("1")
            {
                "complete"
            } else {
                "partial or not started"
            }
        ));
        s.push_str(&format!(
            "session content:    {} posts, {} pinned, {} groups\n",
            stats.total_posts, stats.pinned_count, stats.group_count
        ));
        // Makes the session-only claim checkable: the database is in memory;
        // this directory contains only the lock and WebView2 profile and is
        // deleted on exit, so the user can compare before and after.
        match st.storage.lock().unwrap().as_ref() {
            Some(sess) => s.push_str(&format!(
                "session storage:    {} ({} bytes, content database in memory, deleted on exit)\n",
                sess.dir().display(),
                sess.size_bytes()
            )),
            None => match st.webview_dir.lock().unwrap().as_ref() {
                Some(storage) => s.push_str(&format!(
                    "session storage:    {} ({} bytes, content database in memory, deleted on exit)\n",
                    storage.dir.display(),
                    directory_size(&storage.dir)
                )),
                None => s.push_str(
                    "session storage:    in memory only (no throwaway directory on disk)\n",
                ),
            },
        }
        s.push_str(&format!(
            "durable storage:    {} (preferences, account identity and local list definitions)\n",
            crate::preferences_path().display()
        ));
        s.push_str(&format!("unread:             {}\n", stats.unread_count));
        s.push_str(&format!(
            "last sync:          {}\n",
            stats.last_sync.unwrap_or_else(|| "never".into())
        ));
        s.push_str(&format!(
            "last error:         {}\n",
            st.last_error
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "none".into())
        ));
        s.push_str("\nchannels:\n");
        for c in &health.channels {
            s.push_str(&format!(
                "  {:<14} {:<6} {}\n",
                c.key,
                c.status,
                c.active_backend.clone().unwrap_or_else(|| "-".into())
            ));
        }
        // Belt and braces: sanitize the whole report before it leaves.
        Ok(security::sanitize(&s))
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::ProviderUnavailable, e.to_string()))?
}

/// Where this run's WebView/lock directory is being held, and how much of it
/// there is. The content database itself is always in memory.
///
/// Shown in Diagnostics so the session-only claim is measurable rather than
/// asserted: the user can watch the number grow while reading and confirm the
/// directory is gone after closing the app.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStorage {
    /// Absent when no throwaway directory could be created.
    pub directory: Option<String>,
    pub bytes: u64,
    /// True because the session database is held in memory. The optional
    /// directory is still deleted on exit when WebView2 needed one.
    pub in_memory: bool,
}

#[tauri::command]
pub fn session_storage(state: Sh<'_>) -> Result<SessionStorage, AppError> {
    let guard = state.storage.lock().unwrap();
    if let Some(session) = guard.as_ref() {
        return Ok(SessionStorage {
            directory: Some(session.dir().display().to_string()),
            bytes: session.size_bytes(),
            in_memory: true,
        });
    }
    drop(guard);

    let fallback = state.webview_dir.lock().unwrap();
    Ok(match fallback.as_ref() {
                Some(storage) => SessionStorage {
                    directory: Some(storage.dir.display().to_string()),
                    bytes: directory_size(&storage.dir),
            in_memory: true,
        },
        None => SessionStorage {
            directory: None,
            bytes: 0,
            in_memory: true,
        },
    })
}

/// Which page the window should open on. Set with `--page <route>` or the
/// FFN_PAGE environment variable. Used for deterministic screenshots and for
/// jumping straight to Diagnostics when troubleshooting a launch.
#[tauri::command]
pub fn initial_route() -> Result<Option<String>, AppError> {
    const ROUTES: &[&str] = &[
        "home",
        "following",
        "search",
        "library",
        "originals",
        "focus",
        "pinned",
        "groups",
        "lists",
        "bookmarks",
        "accounts",
        "diagnostics",
        "settings",
    ];

    let mut wanted = std::env::var("FFN_PAGE").ok();
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--page") {
        if let Some(v) = args.get(i + 1) {
            wanted = Some(v.clone());
        }
    }

    // Only ever return a known route; never echo arbitrary input back to the UI.
    Ok(wanted
        .map(|w| w.trim().to_ascii_lowercase())
        .filter(|w| ROUTES.contains(&w.as_str())))
}

// No `open_external`, `open_x_url`, `post_permalink`, `profile_permalink` or
// `hand_to_browser`. Nothing in the interface leaves for a browser any more, so
// the one point where a URL used to escape the app is gone rather than left
// registered with no caller. `security::validate_x_url` and its host allowlist
// stay: they are covered by tests and cost nothing to keep correct.

#[tauri::command]
pub fn get_data_dir() -> Result<String, AppError> {
    if crate::portable::is_portable() {
        return Ok(
            "portable mode: no durable app-data file; session files are deleted on exit".into(),
        );
    }
    Ok(crate::data_dir().display().to_string())
}

/// The application version compiled into the backend. Keeping this in Rust
/// means the Settings screen reports the same version as the executable and
/// diagnostic report, rather than a separately maintained UI string.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Report whether inherited credential environment variables exist on this
/// machine — presence only, never values.
///
/// 0.2.0 stores credentials in Windows Credential Manager and actively strips
/// these from the child environment, so a `true` here is informational: it
/// tells the user a stale `setx` from an earlier setup is still on their
/// account and is being ignored.
#[tauri::command]
pub fn auth_env_present() -> Result<Vec<(String, bool)>, AppError> {
    Ok(security::SENSITIVE_ENV
        .iter()
        .map(|k| (k.to_string(), security::env_present(k)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryStore;
    use crate::database::Db;
    use crate::session::{SessionReason, SessionState};

    const GOOD_TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const GOOD_CT0: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const OTHER_TOKEN: &str = "ffffffffffffffffffffffffffffffffffffffff";
    const OTHER_CT0: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    pub(super) fn state_with(store: Arc<MemoryStore>) -> AppState {
        AppState::with_store(Db::in_memory().unwrap(), store)
    }

    pub(super) fn connected_state() -> (AppState, Arc<MemoryStore>) {
        let store = Arc::new(MemoryStore::new());
        store
            .save(&XCredentials::parse(GOOD_TOKEN, GOOD_CT0).unwrap())
            .unwrap();
        let st = state_with(store.clone());
        st.session.apply(Probe::Authenticated {
            account: Some(Author::from_handle("reader")),
        });
        (st, store)
    }

    #[test]
    fn following_terminal_failure_survives_a_missed_event() {
        let (st, _) = connected_state();
        st.emit_following(st.workers.epoch(), &crate::preload::Progress::failed(0,
            &AppError::new(ErrorCode::NetworkUnavailable, "Connection interrupted")));
        let snapshot = following_snapshot(&st).unwrap();
        assert_eq!(snapshot.state, "failed");
        assert!(!snapshot.syncing);
        assert_eq!(snapshot.last_error.as_deref(), Some("Connection interrupted"));
        assert!(snapshot.last_progress_at.is_some());
        st.workers.cancel_all();
        assert_ne!(following_snapshot(&st).unwrap().state, "failed", "a different account inherited the failure");
    }

    #[test]
    fn a_following_worker_that_exits_without_a_terminal_event_is_not_loading() {
        let (st, _) = connected_state();
        let guard = st.workers.following.claim().unwrap();
        st.emit_following(st.workers.epoch(), &crate::preload::Progress::starting(None));
        assert!(following_snapshot(&st).unwrap().syncing);
        drop(guard);
        let snapshot = following_snapshot(&st).unwrap();
        assert_eq!(snapshot.state, "failed");
        assert!(!snapshot.syncing);
    }

    #[test]
    fn an_old_account_worker_does_not_look_like_current_account_progress() {
        let (st, _) = connected_state();
        let _old_worker = st.workers.following.claim().unwrap();
        st.emit_following(st.workers.epoch(), &crate::preload::Progress::starting(None));
        st.workers.cancel_all();
        let snapshot=following_snapshot(&st).unwrap();
        assert_eq!(snapshot.state,"idle");
        assert!(!snapshot.syncing);
        assert!(snapshot.last_progress_at.is_none());
    }

    #[test]
    fn a_malformed_replacement_leaves_the_working_credentials_untouched() {
        // Requirement: a failed Replace Credentials must not disconnect the
        // account that currently works.
        let (st, store) = connected_state();
        assert_eq!(st.session.snapshot().state, SessionState::Connected);

        // Every one of these fails before the durable store is written.
        for (t, c) in [
            ("", GOOD_CT0),
            ("short", GOOD_CT0),
            (GOOD_TOKEN, ""),
            ("has spaces in it aaaaaaaaaaaaaaaaaaaa", GOOD_CT0),
            (
                &format!("auth_token={GOOD_TOKEN}; ct0={GOOD_CT0}"),
                GOOD_CT0,
            ),
        ] {
            assert!(connect_blocking(&st, t, c).is_err(), "{t:?} was accepted");
        }

        let kept = store.load().unwrap().expect("credentials were deleted");
        assert_eq!(kept.auth_token, GOOD_TOKEN, "the stored token changed");
        assert_eq!(kept.ct0, GOOD_CT0, "the stored ct0 changed");
        assert_eq!(
            st.session.snapshot().state,
            SessionState::Connected,
            "a failed replacement disconnected a working session"
        );
        assert_eq!(st.session.account().unwrap().username, "reader");
    }

    /// A provider that answers without touching the network, so the connect
    /// ordering can be tested in both directions.
    struct StubProvider {
        authenticated: bool,
        identity_fails: bool,
    }

    impl XDataProvider for StubProvider {
        fn name(&self) -> &'static str {
            "stub"
        }
        fn status(&self) -> AppResult<AuthenticationStatus> {
            Ok(AuthenticationStatus {
                authenticated: self.authenticated,
                username: None,
                account: None,
                checked_at: String::new(),
                message: String::new(),
            })
        }
        fn get_current_user(&self) -> AppResult<Author> {
            if self.identity_fails {
                return Err(AppError::new(ErrorCode::SchemaChanged, "no handle"));
            }
            Ok(Author::from_handle("newaccount"))
        }
        fn get_following_feed(&self, _: u32, _: Option<String>) -> AppResult<FeedPage> {
            unreachable!("connect must not fetch a feed")
        }
        fn get_for_you_feed(&self, _: u32, _: Option<String>) -> AppResult<FeedPage> {
            unreachable!()
        }
        fn get_user_profile(&self, _: &str) -> AppResult<Author> {
            unreachable!()
        }
        fn get_user_posts(&self, _: &str, _: u32) -> AppResult<FeedPage> {
            unreachable!()
        }
        fn get_following_accounts(&self, _: &str, _: u32) -> AppResult<Vec<Author>> {
            unreachable!()
        }
        fn get_bookmarks(&self, _: u32) -> AppResult<FeedPage> {
            unreachable!()
        }
        fn get_list_timeline(&self, _: &str, _: u32) -> AppResult<FeedPage> {
            unreachable!()
        }
    }

    #[test]
    fn credentials_x_rejects_are_never_stored() {
        let (st, store) = connected_state();
        let new_pair = XCredentials::parse(OTHER_TOKEN, OTHER_CT0).unwrap();

        let err = connect_validated(
            &st,
            new_pair,
            &StubProvider {
                authenticated: false,
                identity_fails: false,
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAuthenticated);

        let kept = store.load().unwrap().unwrap();
        assert_eq!(kept.auth_token, GOOD_TOKEN, "an unproven token was stored");
        assert_eq!(st.session.snapshot().state, SessionState::Connected);
        assert_eq!(st.session.account().unwrap().username, "reader");
    }

    #[test]
    fn a_failure_after_authentication_still_leaves_the_old_account_intact() {
        // X accepted the pair but the identity lookup failed. Because the store
        // is written only after both succeed, nothing may have changed.
        let (st, store) = connected_state();
        let new_pair = XCredentials::parse(OTHER_TOKEN, OTHER_CT0).unwrap();

        assert!(connect_validated(
            &st,
            new_pair,
            &StubProvider {
                authenticated: true,
                identity_fails: true,
            },
        )
        .is_err());

        assert_eq!(store.load().unwrap().unwrap().auth_token, GOOD_TOKEN);
        assert_eq!(st.session.account().unwrap().username, "reader");
    }

    #[test]
    fn a_successful_replacement_swaps_the_account_and_wipes_the_old_content() {
        let (st, store) = connected_state();
        // Content belonging to the outgoing account.
        st.db
            .upsert_author(&Author::from_handle("olddata"))
            .unwrap();
        st.db.create_group("g_ai", "AI", "#6366f1").unwrap();
        st.db.set_group_member("g_ai", "old-author", true).unwrap();
        let new_pair = XCredentials::parse(OTHER_TOKEN, OTHER_CT0).unwrap();

        let snap = connect_validated(
            &st,
            new_pair,
            &StubProvider {
                authenticated: true,
                identity_fails: false,
            },
        )
        .unwrap();

        assert_eq!(snap.state, SessionState::Connected);
        assert_eq!(snap.account.unwrap().username, "newaccount");
        assert_eq!(
            store.load().unwrap().unwrap().auth_token,
            OTHER_TOKEN,
            "the new credentials were not stored"
        );
        // The only author left is the incoming account itself.
        let authors = st.db.all_authors().unwrap();
        assert!(
            !authors.iter().any(|a| a.username == "olddata"),
            "content from the previous account survived the switch"
        );
        assert_eq!(st.db.groups().unwrap().len(), 0);
        let old_lists = st.durable.account_lists("reader").unwrap();
        assert_eq!(old_lists.len(), 1);
        assert_eq!(old_lists[0].member_ids, vec!["old-author"]);
        assert!(st.durable.account_lists("newaccount").unwrap().is_empty());
    }

    #[test]
    fn shutdown_migrates_session_lists_without_losing_members() {
        let st = AppState::with_store(
            Db::in_memory().unwrap(),
            Arc::new(MemoryStore::new()),
        )
        .with_durable(Durable::in_memory().unwrap());
        st.session.apply(Probe::Authenticated {
            account: Some(Author::from_handle("reader")),
        });
        st.db.create_group("g_ai", "AI", "#6366f1").unwrap();
        st.db.set_group_member("g_ai", "author-1", true).unwrap();
        st.db.set_group_member("g_ai", "author-2", true).unwrap();

        st.shutdown();

        let lists = st.durable.account_lists("reader").unwrap();
        assert_eq!(lists.len(), 1);
        assert_eq!(lists[0].id, "g_ai");
        assert_eq!(lists[0].member_ids, vec!["author-1", "author-2"]);
    }

    // -- startup and monitoring coordination --------------------------------
    //
    // Every one of these asserts that the provider is *not* reached. That is
    // the point of the whole arrangement: a launch with no session, a second
    // caller, and a monitoring tick behind a fresh feed must all cost nothing.
    // They are also why these paths can be tested at all — falling through to
    // `check_session_inner` would spawn a real `twitter.exe`.

    #[test]
    fn a_startup_check_without_credentials_never_reaches_the_provider() {
        let st = state_with(Arc::new(MemoryStore::new()));
        let snap = check_session_blocking(&st, true).unwrap();
        assert_eq!(snap.state, SessionState::Disconnected);
        assert_eq!(snap.reason, SessionReason::NoCredentials);
        assert!(
            !st.health_in_flight.load(Ordering::SeqCst),
            "a check that never ran still claimed the slot"
        );
    }

    #[test]
    fn only_one_health_check_can_hold_the_slot() {
        let (st, _) = connected_state();
        let held = st.begin_health_check().expect("the first check gets in");
        assert!(st.begin_health_check().is_none(), "two probes ran at once");
        drop(held);
        assert!(
            st.begin_health_check().is_some(),
            "the slot was never released"
        );
    }

    #[test]
    fn a_forced_check_still_refuses_to_run_beside_another() {
        // Test Connection forces past the interval, but not past the slot.
        let (st, _) = connected_state();
        let _held = st.begin_health_check().unwrap();
        let snap = check_session_blocking(&st, true).unwrap();
        assert_eq!(snap.state, SessionState::Connected, "{snap:?}");
    }

    #[test]
    fn a_monitoring_tick_behind_a_fresh_feed_does_nothing() {
        // `connected_state` has just applied a successful probe, so the
        // unforced path must answer from the snapshot alone.
        let (st, _) = connected_state();
        let snap = check_session_blocking(&st, false).unwrap();
        assert_eq!(snap.reason, SessionReason::Ok);
        assert!(
            !st.health_in_flight.load(Ordering::SeqCst),
            "a skipped tick left the slot claimed"
        );
    }

    #[test]
    fn guard_blocks_requests_when_nothing_is_connected() {
        let st = state_with(Arc::new(MemoryStore::new()));
        let err = st.guard().unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAuthenticated);
        assert!(err.repair.is_some());
    }

    #[test]
    fn guard_blocks_requests_after_credentials_are_rejected() {
        let (st, _) = connected_state();
        st.session.apply(Probe::failed(AppError::new(
            ErrorCode::NotAuthenticated,
            "rejected",
        )));
        let err = st.guard().unwrap_err();
        assert_eq!(err.code, ErrorCode::CookieExpired);
    }

    #[test]
    fn guard_blocks_requests_until_health_check_confirms_credentials() {
        let (st, _) = connected_state();
        st.session.reset();
        let err = st.guard().unwrap_err();
        assert_eq!(err.code, ErrorCode::BlockedOperation);

        st.session.set_checking(true);
        let err = st.guard().unwrap_err();
        assert_eq!(err.code, ErrorCode::BlockedOperation);
    }

    #[test]
    fn guard_allows_requests_while_merely_degraded() {
        // Rate limiting and offline must not stop the app from retrying.
        let (st, _) = connected_state();
        st.session
            .apply(Probe::failed(AppError::new(ErrorCode::RateLimited, "429")));
        assert!(st.guard().is_ok());
    }

    #[test]
    fn operations_needing_a_handle_refuse_before_reaching_the_backend() {
        let st = state_with(Arc::new(MemoryStore::new()));
        let err = st.active_handle().unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAuthenticated);
    }

    #[test]
    fn disconnecting_removes_credentials_identity_and_content() {
        let (st, store) = connected_state();
        st.db
            .upsert_author(&Author::from_handle("someone"))
            .unwrap();

        store.delete().unwrap();
        st.session.reset();
        st.db.clear_cache().unwrap();

        assert!(store.load().unwrap().is_none());
        let snap = st.session.snapshot();
        assert_eq!(snap.state, SessionState::Disconnected);
        assert_eq!(snap.reason, SessionReason::NoCredentials);
        assert!(snap.account.is_none());
        assert!(st.db.all_authors().unwrap().is_empty());
    }

    #[test]
    fn no_command_response_type_can_carry_a_secret() {
        let (st, _) = connected_state();
        // Every payload shape the IPC layer serialises back to React, plus the
        // error path — an error message is the likeliest place for a stray
        // credential to escape.
        st.note_error(&AppError::new(
            ErrorCode::ApiError,
            format!("failed: auth_token={GOOD_TOKEN}; ct0={GOOD_CT0}"),
        ));
        let payloads = [
            serde_json::to_string(&st.session.snapshot()).unwrap(),
            // `None` cursor: this test is about what the serialised payload can
            // leak, and an absent cursor is the shape a cached response has.
            serde_json::to_string(&build_response(&st, "following", vec![], true, None).unwrap())
                .unwrap(),
            st.last_error.lock().unwrap().clone().unwrap_or_default(),
        ];
        for payload in payloads {
            assert!(!payload.contains(GOOD_TOKEN), "token leaked in: {payload}");
            assert!(!payload.contains(GOOD_CT0), "ct0 leaked in: {payload}");
        }
    }

    #[test]
    fn pagination_now_follows_the_provider_rather_than_a_constant() {
        // This asserted `false` for 0.8.5, which had no cursor anywhere. 0.8.6
        // added one to `feed`, and the answer must come from the provider so a
        // capability change cannot leave a stale constant behind.
        let st = state_with(Arc::new(MemoryStore::new()));
        let caps = st.provider.lock().unwrap().capabilities();
        assert!(caps.feed_cursor, "the pinned build paginates the feed");
        assert!(!caps.following_cursor, "following still has no cursor");
    }

    // -----------------------------------------------------------------------
    // Unfollow
    // -----------------------------------------------------------------------

    #[test]
    fn a_health_check_already_in_flight_is_not_started_twice() {
        // The startup thread in lib.rs and the interface's own startup check
        // both call `probe_once`. Whichever arrives second must get the
        // current snapshot rather than spawning another twitter.exe.
        use std::sync::atomic::Ordering;
        let st = state_with(Arc::new(MemoryStore::new()));
        st.health_in_flight.store(true, Ordering::SeqCst);

        // Returns immediately: with the flag set there is nothing to wait for,
        // and no provider call is made.
        let snap = probe_once(&st).unwrap();
        assert!(!snap.checking, "a second caller flipped the checking state");
        assert!(
            st.health_in_flight.load(Ordering::SeqCst),
            "the second caller cleared a flag it did not set"
        );
    }

    // --- the Following list and the group picker ---------------------------

    fn known(st: &AppState, username: &str, id: &str) {
        st.db
            .upsert_author(&Author {
                id: id.into(),
                username: username.into(),
                display_name: username.into(),
                ..Default::default()
            })
            .unwrap();
    }

    #[test]
    fn an_unfollow_removes_the_account_from_the_group_picker_immediately() {
        // Re-running the traversal for a one-account delta costs 36 seconds, so
        // without reconciliation the account the reader just unfollowed stays
        // in the picker for the rest of the session.
        let (st, _) = connected_state();
        known(&st, "leaving", "1");
        st.db
            .merge_following_accounts(&st.db.all_authors().unwrap(), 0, "s1", true)
            .unwrap();
        assert_eq!(st.db.following_count().unwrap(), 1);

        reconcile_following(&st, AccountAction::Unfollow, "leaving");
        assert_eq!(st.db.following_count().unwrap(), 0);
    }

    #[test]
    fn a_follow_of_a_cached_account_puts_it_at_the_top_of_the_list() {
        let (st, _) = connected_state();
        known(&st, "existing", "1");
        known(&st, "newcomer", "2");
        st.db
            .merge_following_accounts(
                &[Author {
                    id: "1".into(),
                    username: "existing".into(),
                    ..Default::default()
                }],
                0,
                "s1",
                true,
            )
            .unwrap();

        reconcile_following(&st, AccountAction::Follow, "newcomer");
        let ids: Vec<String> = st
            .db
            .following_accounts()
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect();
        assert_eq!(ids, vec!["2", "1"]);
    }

    #[test]
    fn following_an_account_this_session_never_saw_marks_the_list_incomplete() {
        // There is no author row to place, and inventing one from a handle
        // would put a fabricated account in the picker. Saying "the list is no
        // longer known to be complete" is the truthful alternative.
        let (st, _) = connected_state();
        st.db.set_setting(FOLLOWING_COMPLETE, "1").unwrap();
        reconcile_following(&st, AccountAction::Follow, "a_stranger");
        assert_eq!(
            st.db.get_setting(FOLLOWING_COMPLETE).unwrap().as_deref(),
            Some("0")
        );
        assert_eq!(st.db.following_count().unwrap(), 0);
    }

    #[test]
    fn a_partial_first_batch_never_reads_as_the_whole_list() {
        // The distinction the interface depends on: 30 accounts obtained is not
        // "you follow 30 people".
        let (st, _) = connected_state();
        known(&st, "a", "1");
        st.db
            .merge_following_accounts(&st.db.all_authors().unwrap(), 0, "s1", false)
            .unwrap();
        let complete = st.db.get_setting(FOLLOWING_COMPLETE).unwrap();
        assert!(complete.is_none() || complete.as_deref() == Some("0"));
    }

    #[test]
    fn switching_account_stops_the_traversal_and_empties_the_list() {
        let (st, _) = connected_state();
        known(&st, "a", "1");
        st.db
            .merge_following_accounts(&st.db.all_authors().unwrap(), 0, "s1", true)
            .unwrap();
        st.db.set_setting(FOLLOWING_COMPLETE, "1").unwrap();
        let guard = st.workers.following.claim().unwrap();

        reset_following(&st);

        assert!(guard.cancelled(), "the traversal was left running");
        assert_eq!(st.db.following_count().unwrap(), 0);
        assert_eq!(
            st.db.get_setting(FOLLOWING_COMPLETE).unwrap().as_deref(),
            Some("0"),
            "the previous account's list still claimed to be complete"
        );
    }

    #[test]
    fn a_traversal_is_not_started_while_one_is_running() {
        let (st, _) = connected_state();
        let st = Arc::new(st);
        let _guard = st.workers.following.claim().unwrap();
        assert!(
            !spawn_following_sync(st.clone()),
            "a second traversal was started"
        );
    }

    #[test]
    fn a_traversal_is_not_started_when_the_session_cannot_serve_requests() {
        // No credentials means no child process, not a failed one.
        let st = Arc::new(state_with(Arc::new(MemoryStore::new())));
        assert!(!spawn_following_sync(st));
    }

    #[test]
    fn a_probe_without_credentials_never_reaches_the_provider() {
        // No stored session means no process, not a failed one.
        let st = state_with(Arc::new(MemoryStore::new()));
        let snap = probe_once(&st).unwrap();
        assert_eq!(snap.state, crate::session::SessionState::Disconnected);
        assert!(snap.latency_ms.is_none());
    }

    #[test]
    fn connection_monitoring_is_on_unless_it_was_switched_off() {
        // Like Unfollow, this defaults on; it only reads, and silently not
        // monitoring leaves somebody believing a dead session is live.
        let st = state_with(Arc::new(MemoryStore::new()));
        assert!(st.durable.auto_check_connection(), "default should be on");

        testing::set_setting(&st, crate::durable::AUTO_CHECK, "false").unwrap();
        assert!(!st.durable.auto_check_connection());

        testing::set_setting(&st, crate::durable::AUTO_CHECK, "true").unwrap();
        assert!(st.durable.auto_check_connection());
    }

    #[test]
    fn the_monitoring_preference_is_actually_storable() {
        // The frontend writes `monitoring.autoCheck`; the durable allowlist is
        // the enforcing side. Without the key there, the write is rejected and
        // the toggle silently forgets itself on restart.
        assert!(crate::durable::is_durable_preference(
            crate::durable::AUTO_CHECK
        ));
        let st = state_with(Arc::new(MemoryStore::new()));
        testing::set_setting(&st, crate::durable::AUTO_CHECK, "false").unwrap();
        assert_eq!(
            st.durable
                .get_preference(crate::durable::AUTO_CHECK)
                .unwrap()
                .as_deref(),
            Some("false")
        );
    }

    #[test]
    fn unfollow_is_on_on_a_fresh_install() {
        // No row is the default-enabled state. A reader can still switch the
        // durable preference off explicitly before any account-changing call.
        let st = state_with(Arc::new(MemoryStore::new()));
        assert!(st.durable.allow_unfollow());
        assert!(security::WritePermit::unfollow(st.durable.allow_unfollow()).is_some());
    }

    #[test]
    fn only_the_exact_string_true_turns_an_explicit_unfollow_preference_on() {
        let st = state_with(Arc::new(MemoryStore::new()));
        for value in ["false", "", "1", "yes", "TRUE", "true "] {
            testing::set_setting(&st, crate::durable::ALLOW_UNFOLLOW, value).unwrap();
            assert!(
                !st.durable.allow_unfollow(),
                "{value:?} was treated as permission"
            );
        }
        testing::set_setting(&st, crate::durable::ALLOW_UNFOLLOW, "true").unwrap();
        assert!(st.durable.allow_unfollow());
    }

    #[test]
    fn the_unfollow_preference_is_durable() {
        // A standing decision about what the app may do to the account should
        // not quietly reset itself on restart.
        let st = state_with(Arc::new(MemoryStore::new()));
        testing::set_setting(&st, crate::durable::ALLOW_UNFOLLOW, "true").unwrap();
        assert!(crate::durable::is_durable_preference(
            crate::durable::ALLOW_UNFOLLOW
        ));
        // It routed to the durable store, not the session database.
        assert_eq!(
            st.durable
                .get_preference(crate::durable::ALLOW_UNFOLLOW)
                .unwrap()
                .as_deref(),
            Some("true")
        );
    }

    #[test]
    fn a_permit_cannot_be_conjured_while_the_preference_is_off() {
        // The provider method takes a permit, so this is the whole gate.
        assert!(security::WritePermit::unfollow(false).is_none());
        assert!(security::WritePermit::unfollow(true).is_some());
        assert_eq!(
            security::WritePermit::unfollow(true).unwrap().op(),
            "unfollow"
        );
    }

    #[test]
    fn bookmark_removal_refuses_without_confirmation_or_a_numeric_id() {
        let st = state_with(Arc::new(MemoryStore::new()));
        let not_confirmed = begin_bookmark_action(&st, "123", false).unwrap_err();
        assert_eq!(not_confirmed.code, ErrorCode::BlockedOperation);
        let malformed = begin_bookmark_action(&st, "tweet-id", true).unwrap_err();
        assert_eq!(malformed.code, ErrorCode::ApiError);
    }

    #[test]
    fn every_other_write_operation_stays_blocked() {
        // Upstream supports all of these. Focus Feed Next exposes none of them,
        // and adding one must be a deliberate act rather than a side effect of
        // the follow/unfollow work.
        for op in [
            "post",
            "reply",
            "quote",
            "delete",
            "like",
            "unlike",
            "retweet",
            "unretweet",
            "bookmark",
            "unbookmark",
            "favorite",
            "unfavorite",
            "mute",
            "block",
        ] {
            assert!(security::is_blocked(op), "{op} is not blocked");
            assert!(!security::is_allowed(op), "{op} is on the read allowlist");
            assert!(
                !security::GATED_WRITE_OPS.contains(&op),
                "{op} became a permitted write"
            );
        }
        // Exactly two, and both are the follow relationship. Anything else
        // appearing here is a deliberate widening that has to be argued for.
        assert_eq!(security::GATED_WRITE_OPS, &["follow", "unfollow"]);
    }

    #[test]
    fn unfollow_is_still_refused_by_the_ordinary_read_path() {
        // Two doors, and the read one stays shut regardless of the preference.
        assert!(security::is_blocked("unfollow"));
        assert!(!security::is_allowed("unfollow"));
        assert!(security::is_blocked("follow"));
        assert!(!security::is_allowed("follow"));
    }

    #[test]
    fn mute_and_block_are_reported_as_unavailable_not_offered() {
        // twitter-cli 0.8.6 has no such subcommand. The capability answer is
        // what lets the interface say so instead of showing a control that
        // could only ever fail.
        let st = state_with(Arc::new(MemoryStore::new()));
        let caps = st.provider.lock().unwrap().capabilities();
        assert!(!caps.mute, "the app claimed a mute it cannot perform");
        assert!(!caps.block, "the app claimed a block it cannot perform");
        assert!(caps.follow && caps.unfollow);
        assert!(security::is_unavailable("mute"));
        assert!(security::is_unavailable("block"));
    }

    // -----------------------------------------------------------------------
    // Follow / unfollow share every gate
    // -----------------------------------------------------------------------

    /// Records what it was asked to do and never touches the network.
    #[derive(Default)]
    struct WriteStub {
        calls: Mutex<Vec<(String, String)>>,
        fails: bool,
    }

    impl WriteStub {
        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }

        fn record(
            &self,
            op: &str,
            username: &str,
            permit: &security::WritePermit,
        ) -> AppResult<()> {
            // The permit is the proof, so assert it matches the method reached.
            assert_eq!(permit.op(), op, "a permit reached the wrong operation");
            self.calls
                .lock()
                .unwrap()
                .push((op.to_string(), username.to_string()));
            if self.fails {
                return Err(AppError::new(ErrorCode::ApiError, "X refused"));
            }
            Ok(())
        }
    }

    impl XDataProvider for Arc<WriteStub> {
        fn name(&self) -> &'static str {
            "write-stub"
        }
        fn unfollow_account(&self, u: &str, p: &security::WritePermit) -> AppResult<()> {
            self.record("unfollow", u, p)
        }
        fn follow_account(&self, u: &str, p: &security::WritePermit) -> AppResult<()> {
            self.record("follow", u, p)
        }
        fn status(&self) -> AppResult<AuthenticationStatus> {
            unreachable!()
        }
        fn get_current_user(&self) -> AppResult<Author> {
            unreachable!()
        }
        fn get_following_feed(&self, _: u32, _: Option<String>) -> AppResult<FeedPage> {
            unreachable!()
        }
        fn get_for_you_feed(&self, _: u32, _: Option<String>) -> AppResult<FeedPage> {
            unreachable!()
        }
        fn get_user_profile(&self, _: &str) -> AppResult<Author> {
            unreachable!()
        }
        fn get_user_posts(&self, _: &str, _: u32) -> AppResult<FeedPage> {
            unreachable!()
        }
        fn get_following_accounts(&self, _: &str, _: u32) -> AppResult<Vec<Author>> {
            unreachable!()
        }
        fn get_bookmarks(&self, _: u32) -> AppResult<FeedPage> {
            unreachable!()
        }
        fn get_list_timeline(&self, _: &str, _: u32) -> AppResult<FeedPage> {
            unreachable!()
        }
    }

    /// A connected state whose provider is the recording stub.
    fn state_with_write_stub(allow: bool, fails: bool) -> (AppState, Arc<WriteStub>) {
        let (st, _) = connected_state();
        let stub = Arc::new(WriteStub {
            calls: Mutex::new(vec![]),
            fails,
        });
        *st.provider.lock().unwrap() = Box::new(stub.clone());
        testing::set_setting(
            &st,
            crate::durable::ALLOW_UNFOLLOW,
            if allow { "true" } else { "false" },
        )
        .unwrap();
        (st, stub)
    }

    /// One complete action, exactly as the command sequences it.
    fn act(
        st: &AppState,
        action: testing::AccountAction,
        username: &str,
        confirmed: bool,
    ) -> AppResult<()> {
        testing::begin_account_action(st, action, confirmed)?;
        let result = testing::perform_account_action(st, action, username);
        testing::end_account_action(st);
        result
    }

    #[test]
    fn neither_direction_runs_without_confirmation() {
        // A mis-wired caller that skipped the dialog must fail rather than act.
        let (st, stub) = state_with_write_stub(true, false);
        for action in [
            testing::AccountAction::Follow,
            testing::AccountAction::Unfollow,
        ] {
            let err = act(&st, action, "quiet_reader", false).unwrap_err();
            assert_eq!(err.code, ErrorCode::BlockedOperation);
        }
        assert!(stub.calls().is_empty(), "an unconfirmed action reached X");
    }

    #[test]
    fn neither_direction_runs_while_the_preference_is_off() {
        // And the refusal happens before any argument is built, so no child
        // process is started at all.
        let (st, stub) = state_with_write_stub(false, false);
        for action in [
            testing::AccountAction::Follow,
            testing::AccountAction::Unfollow,
        ] {
            let err = act(&st, action, "quiet_reader", true).unwrap_err();
            assert_eq!(err.code, ErrorCode::BlockedOperation);
        }
        assert!(stub.calls().is_empty());
        // The worker half refuses on its own too, in case the preference is
        // switched off between the two.
        assert!(testing::perform_account_action(
            &st,
            testing::AccountAction::Follow,
            "quiet_reader"
        )
        .is_err());
    }

    #[test]
    fn a_confirmed_follow_reaches_exactly_one_account_once() {
        let (st, stub) = state_with_write_stub(true, false);
        act(&st, testing::AccountAction::Follow, "quiet_reader", true).unwrap();
        assert_eq!(stub.calls(), vec![("follow".into(), "quiet_reader".into())]);
    }

    #[test]
    fn a_confirmed_unfollow_reaches_exactly_one_account_once() {
        let (st, stub) = state_with_write_stub(true, false);
        act(&st, testing::AccountAction::Unfollow, "quiet_reader", true).unwrap();
        assert_eq!(
            stub.calls(),
            vec![("unfollow".into(), "quiet_reader".into())]
        );
    }

    #[test]
    fn only_one_account_action_can_be_in_flight() {
        // Two confirmations in the same instant: the second is refused rather
        // than queued, because a queued write is a write nobody is watching.
        let (st, stub) = state_with_write_stub(true, false);
        testing::begin_account_action(&st, testing::AccountAction::Unfollow, true).unwrap();

        // A follow cannot slip past an unfollow already running, either.
        let err =
            testing::begin_account_action(&st, testing::AccountAction::Follow, true).unwrap_err();
        assert_eq!(err.code, ErrorCode::BlockedOperation);
        assert!(err.message.contains("already running"));

        testing::end_account_action(&st);
        // And the flag really was released, so the next action works.
        act(&st, testing::AccountAction::Follow, "quiet_reader", true).unwrap();
        assert_eq!(stub.calls().len(), 1);
    }

    #[test]
    fn a_failed_action_is_reported_once_and_never_retried() {
        // Retrying could act twice: a failure might mean the request worked and
        // the response was lost.
        let (st, stub) = state_with_write_stub(true, true);
        let err = act(&st, testing::AccountAction::Follow, "quiet_reader", true).unwrap_err();
        assert_eq!(err.code, ErrorCode::ApiError);
        assert_eq!(stub.calls().len(), 1, "the backend retried on its own");
        // The flag is clear, so a deliberate second attempt is still possible.
        assert!(!st.write_in_flight.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn there_is_no_bulk_account_action() {
        // One handle per call, by signature. A list would make a misclick
        // unrecoverable, so the shape of the API is the guarantee.
        let (st, stub) = state_with_write_stub(true, false);
        act(&st, testing::AccountAction::Follow, "quiet_reader", true).unwrap();
        assert_eq!(stub.calls().len(), 1);
        assert_eq!(stub.calls()[0].1, "quiet_reader");
    }

    #[test]
    fn a_signed_media_url_never_survives_the_trip_to_the_frontend() {
        // The single most important property of the proxy: whatever the CDN
        // URL was, the webview must not receive it. With no proxy running the
        // source is cleared rather than passed through.
        let st = state_with(Arc::new(MemoryStore::new()));
        let mut posts = vec![post_with_media(
            MediaKind::Video,
            "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280/secret.mp4?tag=12",
        )];
        st.proxy_media(&mut posts);
        let url = &posts[0].media[0].url;
        assert!(!url.contains("video.twimg.com"), "leaked CDN host: {url}");
        assert!(!url.contains("secret.mp4"), "leaked path: {url}");
        assert!(!url.contains("tag="), "leaked query: {url}");
    }

    #[test]
    fn still_images_are_not_exposed_when_the_proxy_is_unavailable() {
        // Images use the same no-cache loopback transport as video. If the
        // proxy cannot start, the signed CDN URL is cleared rather than
        // leaking a direct renderer request.
        let st = state_with(Arc::new(MemoryStore::new()));
        let mut posts = vec![post_with_media(
            MediaKind::Image,
            "https://pbs.twimg.com/media/Abc123.jpg",
        )];
        st.proxy_media(&mut posts);
        assert!(posts[0].media[0].url.is_empty());
    }

    #[test]
    fn unavailable_image_proxy_clears_account_images_for_the_renderer() {
        let st = state_with(Arc::new(MemoryStore::new()));
        let mut author = Author::from_handle("reader");
        author.avatar_url = Some("https://pbs.twimg.com/profile_images/1/avatar.jpg".into());
        author.banner_url = Some("https://pbs.twimg.com/profile_banners/1/banner.jpg".into());
        st.proxy_authors(std::slice::from_mut(&mut author));
        assert!(author.avatar_url.is_none());
        assert!(author.banner_url.is_none());
    }

    #[tokio::test]
    async fn post_profile_quote_and_reposter_images_use_the_local_proxy() {
        let st = state_with(Arc::new(MemoryStore::new()));
        let proxy = MediaProxy::start(st.media.clone()).await.unwrap();
        let st = st.with_proxy(proxy);
        let mut author = Author::from_handle("reader");
        author.avatar_url = Some("https://pbs.twimg.com/profile_images/1/avatar.jpg".into());
        author.banner_url = Some("https://pbs.twimg.com/profile_banners/1/banner.jpg".into());
        st.db.upsert_author(&author).unwrap();
        let mut post = post_with_media(MediaKind::Image,"https://pbs.twimg.com/media/photo.jpg");
        post.author = author.clone();
        post.reposted_by = Some(author.clone());
        post.quoted = Some(Box::new(QuotedPost { id:"2".into(),author:author.clone(),text:"quote".into(),created_at:None,media:vec![],url:None }));
        st.proxy_media(std::slice::from_mut(&mut post));
        for author in [&post.author,post.reposted_by.as_ref().unwrap(),&post.quoted.as_ref().unwrap().author] {
            for image in [&author.avatar_url,&author.banner_url] {
                let source = image.as_ref().unwrap();
                assert!(source.starts_with("http://127.0.0.1:"));
                let id = source.rsplit('/').next().unwrap();
                assert!(st.media.lookup(id).unwrap().url.starts_with("https://pbs.twimg.com/"));
            }
        }
        assert_eq!(st.db.all_authors().unwrap()[0].avatar_url,author.avatar_url);
    }

    #[tokio::test]
    async fn renderer_identity_proxy_does_not_replace_the_session_source() {
        let st = state_with(Arc::new(MemoryStore::new()));
        let proxy = MediaProxy::start(st.media.clone()).await.unwrap();
        let st = st.with_proxy(proxy);
        let mut author = Author::from_handle("reader");
        author.avatar_url = Some("https://pbs.twimg.com/profile_images/1/avatar.jpg".into());
        st.session.set_account(Some(author.clone()));
        let result = st.proxy_snapshot(st.session.snapshot_cached());
        assert!(result.account.unwrap().avatar_url.unwrap().starts_with("http://127.0.0.1:"));
        assert_eq!(st.session.account().unwrap().avatar_url,author.avatar_url);
        let mut invalid = Author::from_handle("foreign");
        invalid.avatar_url = Some("https://evil.test/avatar.jpg".into());
        invalid.banner_url = Some("https://video.twimg.com/movie.mp4".into());
        st.proxy_authors(std::slice::from_mut(&mut invalid));
        assert!(invalid.avatar_url.is_none() && invalid.banner_url.is_none());
    }

    #[test]
    fn an_animated_gif_is_treated_as_video_by_the_rewriter() {
        // X serves GIFs as MP4, so they take the same transport as video.
        let st = state_with(Arc::new(MemoryStore::new()));
        let mut posts = vec![post_with_media(
            MediaKind::Gif,
            "https://video.twimg.com/tweet_video/abc.mp4",
        )];
        st.proxy_media(&mut posts);
        assert!(!posts[0].media[0].url.contains("twimg.com"));
    }

    fn post_with_media(kind: MediaKind, url: &str) -> Post {
        Post {
            id: "1900000000000000001".into(),
            text: "x".into(),
            author: Author::from_handle("someone"),
            created_at: chrono::Utc::now().to_rfc3339(),
            lang: None,
            is_repost: false,
            reposted_by: None,
            is_promoted: false,
            quoted: None,
            metrics: PostMetrics::default(),
            media: vec![PostMedia {
                kind,
                url: url.into(),
                preview_url: None,
                width: None,
                height: None,
                alt: None,
                duration_ms: None,
                variants: vec![],
            }],
            url: None,
            is_article: false,
            article_title: None,
            in_reply_to: None,
            provider: "twitter-cli".into(),
        }
    }

    #[test]
    fn settings_still_refuse_credential_shaped_keys() {
        let st = state_with(Arc::new(MemoryStore::new()));
        for key in ["auth_token", "TWITTER_CT0", "session_cookie", "api_token"] {
            let err = set_setting_inner(&st, key, "value").unwrap_err();
            assert_eq!(err.code, ErrorCode::BlockedOperation, "{key} was storable");
        }
        assert!(set_setting_inner(&st, "theme", "dark").is_ok());
    }

    // -- cursor continuation ------------------------------------------------

    /// Capabilities matching the pinned twitter-cli 0.8.6: a cursor on `feed`
    /// and `list`, on nothing else.
    fn caps_0_8_6() -> ProviderCapabilities {
        ProviderCapabilities {
            feed_cursor: true,
            list_cursor: true,
            promoted_flag: true,
            unfollow: true,
            ..ProviderCapabilities::none()
        }
    }

    #[test]
    fn only_the_commands_with_a_cursor_may_be_paged() {
        let caps = caps_0_8_6();
        for feed in ["following", "focus", "for-you"] {
            assert!(feed_accepts_cursor(&caps, feed), "{feed} should page");
        }
        assert!(feed_accepts_cursor(&caps, "list:1234567890"));
        // No cursor exists for these in 0.8.6. Paging them would silently
        // re-fetch the first batch.
        assert!(!feed_accepts_cursor(&caps, "bookmarks"));
        assert!(!feed_accepts_cursor(&caps, "user:someone"));
    }

    #[test]
    fn a_backend_without_cursors_may_not_be_paged_at_all() {
        // The capability is asked for rather than assumed, so pinning an older
        // twitter-cli turns paging off instead of producing failing requests.
        let none = ProviderCapabilities::none();
        for feed in ["following", "for-you", "list:1", "bookmarks"] {
            assert!(!feed_accepts_cursor(&none, feed), "{feed} claimed a cursor");
        }
    }

    fn page_with_cursor(cursor: Option<&str>) -> FeedPage {
        FeedPage {
            posts: vec![],
            cursor: cursor.map(str::to_string),
            fetched_at: chrono::Utc::now().to_rfc3339(),
            provider: "twitter-cli".into(),
            from_cache: false,
        }
    }

    #[test]
    fn a_repeated_cursor_reports_the_end_of_the_feed() {
        // X echoes the cursor back when it has nothing more. Following it would
        // fetch the same page for as long as the reader kept clicking.
        let page = page_with_cursor(Some("DAABCgABGxYz_z9__-0KAAIYFjP-"));
        assert_eq!(
            next_cursor_after(&page, Some("DAABCgABGxYz_z9__-0KAAIYFjP-")),
            None
        );
    }

    #[test]
    fn a_fresh_cursor_is_carried_forward() {
        let page = page_with_cursor(Some("DAABCgABGxYz_z9__-1KAAIYFjP-"));
        assert_eq!(
            next_cursor_after(&page, Some("DAABCgABGxYz_z9__-0KAAIYFjP-")),
            Some("DAABCgABGxYz_z9__-1KAAIYFjP-".to_string())
        );
    }

    #[test]
    fn a_cursor_that_could_never_be_sent_back_is_dropped() {
        // Offering it would put a "Load more" on screen that always fails.
        for bad in [
            "-starts-with-a-dash",
            "has spaces",
            "semi;colon",
            "quote\"mark",
        ] {
            assert_eq!(
                next_cursor_after(&page_with_cursor(Some(bad)), None),
                None,
                "{bad} was offered to the frontend"
            );
        }
    }

    #[test]
    fn a_page_without_a_cursor_ends_the_feed() {
        assert_eq!(next_cursor_after(&page_with_cursor(None), None), None);
        assert_eq!(next_cursor_after(&page_with_cursor(Some("  ")), None), None);
    }

    /// Records what it was asked for, so dispatch can be checked without a
    /// network or a subprocess.
    struct RecordingProvider {
        calls: Mutex<Vec<(String, Option<String>)>>,
    }

    impl RecordingProvider {
        fn new() -> Self {
            Self {
                calls: Mutex::new(vec![]),
            }
        }
        fn note(&self, what: &str, cursor: Option<String>) -> AppResult<FeedPage> {
            self.calls
                .lock()
                .unwrap()
                .push((what.to_string(), cursor.clone()));
            Ok(page_with_cursor(Some("DAABCgABGxYz_z9__-2KAAIYFjP-")))
        }
    }

    impl XDataProvider for RecordingProvider {
        fn name(&self) -> &'static str {
            "recording"
        }
        fn capabilities(&self) -> ProviderCapabilities {
            caps_0_8_6()
        }
        fn get_following_feed(&self, _: u32, cursor: Option<String>) -> AppResult<FeedPage> {
            self.note("following", cursor)
        }
        fn get_for_you_feed(&self, _: u32, cursor: Option<String>) -> AppResult<FeedPage> {
            self.note("for-you", cursor)
        }
        fn get_list_timeline_page(
            &self,
            id: &str,
            _: u32,
            cursor: Option<String>,
        ) -> AppResult<FeedPage> {
            self.note(&format!("list:{id}"), cursor)
        }
        fn get_bookmarks(&self, _: u32) -> AppResult<FeedPage> {
            self.note("bookmarks", None)
        }
        fn get_user_posts(&self, u: &str, _: u32) -> AppResult<FeedPage> {
            self.note(&format!("user:{u}"), None)
        }
        fn get_user_profile(&self, _: &str) -> AppResult<Author> {
            unreachable!()
        }
        fn get_following_accounts(&self, _: &str, _: u32) -> AppResult<Vec<Author>> {
            unreachable!()
        }
        fn get_list_timeline(&self, _: &str, _: u32) -> AppResult<FeedPage> {
            unreachable!("the paged variant should have been used")
        }
        fn get_current_user(&self) -> AppResult<Author> {
            unreachable!()
        }
        fn status(&self) -> AppResult<AuthenticationStatus> {
            unreachable!()
        }
    }

    #[test]
    fn the_cursor_reaches_the_commands_that_accept_one() {
        let p = RecordingProvider::new();
        let c = Some("DAABCgABGxYz_z9__-0KAAIYFjP-".to_string());
        fetch_feed_page(&p, "following", 30, c.clone()).unwrap();
        fetch_feed_page(&p, "focus", 30, c.clone()).unwrap();
        fetch_feed_page(&p, "for-you", 30, c.clone()).unwrap();
        fetch_feed_page(&p, "list:1234567890", 30, c.clone()).unwrap();

        let calls = p.calls.lock().unwrap();
        assert_eq!(
            calls.as_slice(),
            &[
                ("following".to_string(), c.clone()),
                // "focus" is derived from the following feed and shares its source.
                ("following".to_string(), c.clone()),
                ("for-you".to_string(), c.clone()),
                ("list:1234567890".to_string(), c.clone()),
            ]
        );
    }

    #[test]
    fn feeds_without_a_cursor_are_never_handed_one() {
        let p = RecordingProvider::new();
        let c = Some("DAABCgABGxYz_z9__-0KAAIYFjP-".to_string());
        fetch_feed_page(&p, "bookmarks", 30, c.clone()).unwrap();
        fetch_feed_page(&p, "user:someone", 30, c).unwrap();

        let calls = p.calls.lock().unwrap();
        assert!(
            calls.iter().all(|(_, cursor)| cursor.is_none()),
            "a cursor was passed to a command that has none: {calls:?}"
        );
    }

    #[test]
    fn an_overlapping_second_page_updates_rows_instead_of_doubling_them() {
        // The reader must never see the same post twice after Load more. Post
        // id is the deduplication key all the way down to SQLite.
        let st = state_with(Arc::new(MemoryStore::new()));
        let mut first = page_with_cursor(Some("DAABCgABGxYz_z9__-0KAAIYFjP-"));
        first.posts = vec![
            post_with_media(MediaKind::Image, "https://pbs.twimg.com/media/a.jpg"),
            {
                let mut p = post_with_media(MediaKind::Image, "https://pbs.twimg.com/media/b.jpg");
                p.id = "1900000000000000002".into();
                p
            },
        ];
        // The second page repeats the last post of the first, as X does.
        let mut second = page_with_cursor(None);
        second.posts = vec![
            {
                let mut p = post_with_media(MediaKind::Image, "https://pbs.twimg.com/media/b.jpg");
                p.id = "1900000000000000002".into();
                p
            },
            {
                let mut p = post_with_media(MediaKind::Image, "https://pbs.twimg.com/media/c.jpg");
                p.id = "1900000000000000003".into();
                p
            },
        ];

        st.db.save_feed_page("following", &first).unwrap();
        st.db.save_feed_page("following", &second).unwrap();

        let posts = st
            .db
            .load_feed("following", &FeedFilters::default(), 100)
            .unwrap();
        assert_eq!(posts.len(), 3, "an overlapping page produced duplicates");
        let mut ids: Vec<_> = posts.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            [
                "1900000000000000001",
                "1900000000000000002",
                "1900000000000000003"
            ]
        );
    }

    // Both operands are constants, so this is decided at compile time rather
    // than when the suite runs — a wrong pair should fail the build, not wait
    // for somebody to run the tests.
    const _: () = assert!(FOLLOWING_FULL_PAGE > FOLLOWING_FIRST_PAGE);

    #[test]
    fn the_first_following_batch_stays_small() {
        // The first batch is what the page renders immediately, and 30 is the
        // measured sweet spot: ~2.1s against a real account, where 191 takes
        // ~36s because twitter-cli pages internally and returns nothing until
        // the whole batch is assembled.
        assert_eq!(FOLLOWING_FIRST_PAGE, 30);
    }
}

/// The startup preload, which shipped implemented and never started.
///
/// `preload.rs` was complete, tested and reachable only from a command nothing
/// called at launch. Watching the real binary showed zero `twitter.exe` after
/// the probe finished, which is what these tests now assert in miniature.
#[cfg(test)]
mod preload_startup_tests {
    use super::tests::*;
    use super::*;

    #[test]
    fn a_rejected_session_starts_no_workers() {
        // Two guaranteed failures and two child processes for nothing.
        let st = Arc::new(state_with(Arc::new(crate::credentials::MemoryStore::new())));
        assert_eq!(start_preload(&st), (false, false));
        assert!(!st.workers.following.is_running());
        assert!(!st.workers.bookmarks.is_running());
    }

    #[test]
    fn both_preferences_default_to_on() {
        // These also default on because they only read, and the cost of not
        // running them is a reader waiting for a list that could already be
        // filling in.
        let (st, _) = connected_state();
        assert!(st.durable.preload_following());
        assert!(st.durable.preload_bookmarks());
    }

    #[test]
    fn each_preference_switches_off_only_its_own_worker() {
        let (st, _) = connected_state();
        testing::set_setting(&st, "startup.preloadBookmarks", "false").unwrap();
        assert!(st.durable.preload_following());
        assert!(!st.durable.preload_bookmarks());
    }

    #[test]
    fn only_a_literal_false_switches_a_preload_off() {
        // A missing row, a hand-edited file and a value from a future build all
        // leave a read-only background task on.
        let (st, _) = connected_state();
        for value in ["", "0", "no", "FALSE", "nonsense"] {
            testing::set_setting(&st, "startup.preloadFollowing", value).unwrap();
            assert!(
                st.durable.preload_following(),
                "{value:?} should not have disabled the preload"
            );
        }
        testing::set_setting(&st, "startup.preloadFollowing", "false").unwrap();
        assert!(!st.durable.preload_following());
    }

    #[test]
    fn the_worker_slots_refuse_a_second_claim() {
        // What stops a manual sync and the startup preload becoming two
        // traversals of the same list.
        let st = Arc::new(state_with(Arc::new(crate::credentials::MemoryStore::new())));
        let first = st.workers.following.claim();
        assert!(first.is_some());
        assert!(st.workers.following.claim().is_none());
        assert!(st.workers.following.is_running());
        drop(first);
        assert!(!st.workers.following.is_running());
    }

    #[test]
    fn bookmarks_and_following_hold_independent_slots() {
        let st = Arc::new(state_with(Arc::new(crate::credentials::MemoryStore::new())));
        let _f = st.workers.following.claim();
        assert!(
            st.workers.bookmarks.claim().is_some(),
            "one worker must not block the other"
        );
    }
}

/// No frontend-supplied report text or secrets reach the share sheet.
#[tauri::command]
pub async fn share_connection_report() -> Result<(),AppError> {
    if !cfg!(target_os="ios") { return Err(AppError::new(ErrorCode::BlockedOperation,"Report sharing requires an iPhone.")); }
    tauri::async_runtime::spawn_blocking(|| crate::providers::native_ios::native_call::<serde_json::Value>("shareConnectionReport",serde_json::json!({})))
        .await.map_err(|_|AppError::new(ErrorCode::ProviderUnavailable,"The report could not be shared."))??;
    Ok(())
}
