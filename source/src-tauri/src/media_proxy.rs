//! Loopback media proxy — the production transport for X video.
//!
//! ## Why this exists
//!
//! X's video URLs are publicly fetchable. Measured against three real posts,
//! a plain Range request returns `206`, `Content-Type: video/mp4`,
//! `Accept-Ranges: bytes` and `Access-Control-Allow-Origin: *`, with no cookie
//! or authorization header sent, and every stream is `avc1`/H.264 — which
//! WebView2 decodes natively. Handed the same URL directly, WebView2 reports
//! `MEDIA_ERR_SRC_NOT_SUPPORTED`. The bytes are fine; the *origin* is the
//! problem — a request made from `tauri.localhost` is cross-site, and the CDN
//! does not serve it.
//!
//! So this is **not** an authenticated media bridge. No credential is involved
//! anywhere in this module, deliberately: adding one would widen the blast
//! radius to solve a problem that was never about authentication.
//!
//! ## Shape
//!
//! A hyper server bound to `127.0.0.1:0` — loopback only, with the port chosen
//! by Windows. It starts with the application and stops with it. One route:
//!
//! ```text
//! GET|HEAD /media/{per-process-secret}/{opaque-media-id}
//! ```
//!
//! Both path segments are unguessable. The secret is regenerated on every
//! launch and never written to disk or a log. The media id is meaningless on
//! its own: it is a key into an in-memory registry that maps it back to a URL
//! **the Rust side already parsed out of a trusted X payload**. React can
//! therefore never ask this server to fetch an arbitrary address — the only
//! URLs reachable are ones the provider itself produced. That is what keeps
//! this from being an open SSRF proxy.
//!
//! ## What is deliberately not done
//!
//! * No disk cache. Bytes are streamed upstream-to-WebView2 and never stored,
//!   so there is nothing to clean up and nothing that can outlive the process.
//! * No whole-body buffering. A 50 MB video occupies stream-sized chunks, not
//!   50 MB of RAM, and every response has a hard size ceiling.
//! * No `Cookie`, `Authorization` or `Set-Cookie` in either direction.
//! * No wildcard CORS. The only permitted origin is the app's own.

use crate::models::{AppError, AppResult, ErrorCode};
use futures_util::TryStreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration,Instant};
use std::pin::Pin;
use std::task::{Context,Poll};

/// Hosts this proxy is permitted to fetch from.
///
/// Exact matches only — no suffix rule. `video.twimg.com.evil.test` ends with
/// `video.twimg.com` under a naive `ends_with` and must not pass. Both entries
/// were observed in real parsed payloads: video and animated GIF media come
/// from `video.twimg.com`, still images from `pbs.twimg.com`.
pub const TRUSTED_MEDIA_HOSTS: &[&str] = &["video.twimg.com", "pbs.twimg.com"];

/// The app's own origin, and the only one allowed to read from this server.
///
/// Tauri v2 serves Windows from `http(s)://tauri.localhost` and WKWebView from
/// the native `tauri://localhost` protocol. Keep this exact list rather than a
/// wildcard: the loopback server carries signed media URLs for this app only.
pub const ALLOWED_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

/// Upper bound on live registrations. Feeds are long; without a cap the map
/// would grow for the lifetime of the session.
const MAX_REGISTRY_ENTRIES: usize = 4096;

/// A single response may be large enough for a normal X clip but can never
/// turn the proxy into an unbounded byte pump. Range requests are still
/// supported, so seeking does not require buffering the whole asset.
const MAX_MEDIA_BYTES: u64 = 128 * 1024 * 1024;

/// Reqwest also has a parser limit, but keep an explicit application-side
/// ceiling so diagnostics and tests can state the same policy as the stream.
const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;

/// Separate bounded pools keep long video transfers from starving pictures.
const MAX_CONCURRENT_TRANSFERS: usize = 4;

/// Fixed-size, session-only aggregates. No URL, account, content, secret, or
/// individual request history is retained by the transport diagnostics.
#[derive(Default)]
struct PoolMetrics {
    requests_total: AtomicU64,
    active_transfers: AtomicU64,
    queued_transfers: AtomicU64,
    queue_wait_ms_total: AtomicU64,
    queue_wait_ms_max: AtomicU64,
    upstream_headers_ms_total: AtomicU64,
    upstream_headers_ms_max: AtomicU64,
    bytes_streamed: AtomicU64,
    completed: AtomicU64,
    cancelled: AtomicU64,
    failures: AtomicU64,
}
#[derive(Default)]
struct ProxyMetrics {
    images: Arc<PoolMetrics>,
    videos: Arc<PoolMetrics>,
}
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolMetricsSnapshot {
    /// Authorized GET and HEAD requests, including native diagnostic probes.
    pub requests_total: u64,
    pub active_transfers: u64,
    pub queued_transfers: u64,
    pub queue_wait_ms_total: u64,
    pub queue_wait_ms_max: u64,
    pub upstream_headers_ms_total: u64,
    pub upstream_headers_ms_max: u64,
    /// Payload emitted by this proxy, excluding headers/TLS/IP overhead. This
    /// does not claim that a client decoded or displayed the emitted bytes.
    pub bytes_streamed: u64,
    pub completed: u64,
    pub cancelled: u64,
    pub failures: u64,
}
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetricsSnapshot {
    #[serde(flatten)]
    pub total: PoolMetricsSnapshot,
    pub images: PoolMetricsSnapshot,
    pub videos: PoolMetricsSnapshot,
}
fn add_counter(counter: &AtomicU64, value: u64) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| {
        Some(old.saturating_add(value))
    });
}
fn measured_ms(since: Instant) -> u64 {
    since.elapsed().as_millis().min(u64::MAX as u128) as u64
}
impl PoolMetrics {
    fn snapshot(&self) -> PoolMetricsSnapshot {
        let load = |value: &AtomicU64| value.load(Ordering::Relaxed);
        PoolMetricsSnapshot {
            requests_total: load(&self.requests_total),
            active_transfers: load(&self.active_transfers),
            queued_transfers: load(&self.queued_transfers),
            queue_wait_ms_total: load(&self.queue_wait_ms_total),
            queue_wait_ms_max: load(&self.queue_wait_ms_max),
            upstream_headers_ms_total: load(&self.upstream_headers_ms_total),
            upstream_headers_ms_max: load(&self.upstream_headers_ms_max),
            bytes_streamed: load(&self.bytes_streamed),
            completed: load(&self.completed),
            cancelled: load(&self.cancelled),
            failures: load(&self.failures),
        }
    }
    fn queue_wait(&self, start: Instant) {
        let ms = measured_ms(start);
        add_counter(&self.queue_wait_ms_total, ms);
        self.queue_wait_ms_max.fetch_max(ms, Ordering::Relaxed);
    }
    fn header_wait(&self, start: Instant) {
        let ms = measured_ms(start);
        add_counter(&self.upstream_headers_ms_total, ms);
        self.upstream_headers_ms_max
            .fetch_max(ms, Ordering::Relaxed);
    }
}
impl ProxyMetrics {
    fn pool(&self, image: bool) -> Arc<PoolMetrics> {
        Arc::clone(if image { &self.images } else { &self.videos })
    }
    fn snapshot(&self) -> MediaMetricsSnapshot {
        let images = self.images.snapshot();
        let videos = self.videos.snapshot();
        let sum = |a: u64, b: u64| a.saturating_add(b);
        let total = PoolMetricsSnapshot {
            requests_total: sum(images.requests_total, videos.requests_total),
            active_transfers: sum(images.active_transfers, videos.active_transfers),
            queued_transfers: sum(images.queued_transfers, videos.queued_transfers),
            queue_wait_ms_total: sum(images.queue_wait_ms_total, videos.queue_wait_ms_total),
            queue_wait_ms_max: images.queue_wait_ms_max.max(videos.queue_wait_ms_max),
            upstream_headers_ms_total: sum(
                images.upstream_headers_ms_total,
                videos.upstream_headers_ms_total,
            ),
            upstream_headers_ms_max: images
                .upstream_headers_ms_max
                .max(videos.upstream_headers_ms_max),
            bytes_streamed: sum(images.bytes_streamed, videos.bytes_streamed),
            completed: sum(images.completed, videos.completed),
            cancelled: sum(images.cancelled, videos.cancelled),
            failures: sum(images.failures, videos.failures),
        };
        MediaMetricsSnapshot {
            total,
            images,
            videos,
        }
    }
}
#[derive(Clone, Copy, PartialEq)]
enum TransferOutcome {
    Pending,
    Completed,
    Failed,
}
/// The permit and counters have one owner from queue admission until the
/// response stream is consumed or cancelled, including future cancellation.
struct MeasuredTransfer {
    metrics: Arc<PoolMetrics>,
    queue_started: Option<Instant>,
    headers_started: Option<Instant>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    outcome: TransferOutcome,
}
impl MeasuredTransfer {
    fn queued(metrics: Arc<PoolMetrics>) -> Self {
        add_counter(&metrics.requests_total, 1);
        add_counter(&metrics.queued_transfers, 1);
        Self {
            metrics,
            queue_started: Some(Instant::now()),
            headers_started: None,
            permit: None,
            outcome: TransferOutcome::Pending,
        }
    }
    fn finish_queue(&mut self) {
        if let Some(start) = self.queue_started.take() {
            self.metrics
                .queued_transfers
                .fetch_sub(1, Ordering::Relaxed);
            self.metrics.queue_wait(start);
        }
    }
    fn activate(&mut self, permit: tokio::sync::OwnedSemaphorePermit) {
        self.finish_queue();
        self.permit = Some(permit);
        add_counter(&self.metrics.active_transfers, 1);
        self.headers_started = Some(Instant::now());
    }
    fn headers(&mut self) {
        if let Some(start) = self.headers_started.take() {
            self.metrics.header_wait(start);
        }
    }
    fn complete(&mut self) {
        if self.outcome == TransferOutcome::Pending {
            self.outcome = TransferOutcome::Completed;
        }
    }
    fn fail(&mut self) {
        self.outcome = TransferOutcome::Failed;
    }
}
impl Drop for MeasuredTransfer {
    fn drop(&mut self) {
        self.finish_queue();
        self.headers();
        if self.permit.is_some() {
            self.metrics
                .active_transfers
                .fetch_sub(1, Ordering::Relaxed);
        }
        add_counter(
            match self.outcome {
                TransferOutcome::Pending => &self.metrics.cancelled,
                TransferOutcome::Completed => &self.metrics.completed,
                TransferOutcome::Failed => &self.metrics.failures,
            },
            1,
        );
    }
}
struct MeasuredMediaStream {
    upstream:
        Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + Sync>>,
    registry: Arc<MediaRegistry>,
    generation: u64,
    received: u64,
    expected: Option<u64>,
    transfer: Option<MeasuredTransfer>,
    ended: bool,
}
impl futures_util::Stream for MeasuredMediaStream {
    type Item = Result<Frame<Bytes>, std::io::Error>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.ended {
            return Poll::Ready(None);
        }
        match this.upstream.as_mut().poll_next(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(None) => {
                this.ended = true;
                if let Some(transfer) = this.transfer.as_mut() {
                    if this
                        .expected
                        .is_some_and(|expected| expected != this.received)
                    {
                        transfer.fail();
                    } else {
                        transfer.complete();
                    }
                }
                this.transfer.take();
                Poll::Ready(None)
            }
            Poll::Ready(Some(item)) => {
                let item = match item {
                    _ if this.registry.generation() != this.generation => {
                        Err(std::io::Error::other("media session ended"))
                    }
                    Ok(chunk) => {
                        this.received = this.received.saturating_add(chunk.len() as u64);
                        if this.received > MAX_MEDIA_BYTES {
                            if let Some(transfer) = this.transfer.as_mut() {
                                transfer.fail();
                            }
                            Err(std::io::Error::other(
                                "media response exceeded its size limit",
                            ))
                        } else {
                            if let Some(transfer) = this.transfer.as_mut() {
                                add_counter(&transfer.metrics.bytes_streamed, chunk.len() as u64);
                                if this.expected == Some(this.received) {
                                    transfer.complete();
                                }
                            }
                            Ok(Frame::data(chunk))
                        }
                    }
                    Err(error) => {
                        if let Some(transfer) = this.transfer.as_mut() {
                            transfer.fail();
                        }
                        Err(error)
                    }
                };
                if item.is_err() {
                    this.ended = true;
                    this.transfer.take();
                }
                Poll::Ready(Some(item))
            }
        }
    }
}

struct TransferPools {
    images: Arc<tokio::sync::Semaphore>,
    videos: Arc<tokio::sync::Semaphore>,
}

impl TransferPools {
    fn new() -> Self {
        Self {
            images: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_TRANSFERS)),
            videos: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_TRANSFERS)),
        }
    }

    fn for_url(&self, url: &str) -> &Arc<tokio::sync::Semaphore> {
        if reqwest::Url::parse(url).ok().is_some_and(|url| url.host_str() == Some("pbs.twimg.com")) {
            &self.images
        } else {
            &self.videos
        }
    }
}

async fn acquire_transfer(semaphore: &Arc<tokio::sync::Semaphore>) -> Option<tokio::sync::OwnedSemaphorePermit> {
    // A normal viewport asks for several avatars and photos together. Queue
    // that burst instead of turning requests beyond the first four into 429s.
    tokio::time::timeout(Duration::from_secs(10), Arc::clone(semaphore).acquire_owned()).await.ok()?.ok()
}

/// Redirect hops permitted before a fetch is abandoned.
const MAX_REDIRECTS: usize = 3;

/// Request headers forwarded upstream, lowercased.
///
/// Range and its conditional companions are what make seeking work. Everything
/// else — above all `Cookie`, `Authorization` and `Origin` — is dropped, so the
/// upstream request carries nothing about this user.
const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
    "accept",
];

/// Response headers passed back to the webview, lowercased.
///
/// `set-cookie` is absent on purpose and is additionally stripped by name in
/// [`copy_response_headers`]: an upstream that tries to set a cookie must not
/// be able to reach the webview's cookie jar through us.
const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
];

/// One registered piece of media.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaEntry {
    /// The trusted upstream URL. Never leaves Rust.
    pub url: String,
    pub post_id: String,
    /// Handle of the account whose session registered this.
    pub account: String,
    /// Registry generation. A media id from a previous account or a previous
    /// session is refused even if the id itself is still in the map.
    pub generation: u64,
}

/// Validate a media URL before it can ever be registered.
///
/// Refuses anything that is not `https` on an exactly-matching trusted host:
/// embedded credentials, loopback, private addresses, control characters, and
/// every non-HTTPS scheme.
pub fn validate_media_url(url: &str) -> Option<&str> {
    let trimmed = url.trim();
    if trimmed.len() > 2048 {
        return None;
    }
    if trimmed.chars().any(|c| c.is_control() || c == ' ') {
        return None;
    }
    // HTTPS only. `http://` upstream would be a downgrade we have no reason to
    // accept, and every other scheme is a local-handler risk.
    let rest = trimmed.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // `https://video.twimg.com@evil.test/x` has authority `video.twimg.com@evil.test`
    // and resolves to evil.test. Reject any userinfo outright.
    if authority.contains('@') {
        return None;
    }
    // A port is not needed for these hosts, and allowing one would let
    // `video.twimg.com:9999` reach an unexpected service.
    let host = authority.to_ascii_lowercase();
    if !TRUSTED_MEDIA_HOSTS.contains(&host.as_str()) {
        return None;
    }
    Some(trimmed)
}

/// True when a host string is loopback, private, or otherwise not a public
/// destination. Used to re-check redirect targets.
pub fn is_private_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        Ok(IpAddr::V6(v6)) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 unique-local and fe80::/10 link-local
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

/// Hex-encoded cryptographically random token of `bytes` bytes.
fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // A failure here means the OS entropy source is unavailable, which is not a
    // condition we can paper over: without it the secret would be predictable.
    getrandom::getrandom(&mut buf).expect("OS entropy source unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compare two secrets without leaking their common prefix through timing.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The opaque-id → trusted-URL map.
///
/// Lives in memory only. Nothing here is written to the session database or
/// anywhere else on disk, so "cleared on exit" is a property of the process
/// rather than a cleanup step that could fail.
#[derive(Debug)]
pub struct MediaRegistry {
    inner: Mutex<RegistryInner>,
    generation: AtomicU64,
}

#[derive(Debug, Default)]
struct RegistryInner {
    entries: HashMap<String, MediaEntry>,
    by_url: HashMap<String, String>,
    /// Least recently used first, including live range requests and refreshes.
    order: Vec<String>,
}

impl Default for MediaRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner::default()),
            generation: AtomicU64::new(1),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Register a trusted URL and return its opaque id.
    ///
    /// `None` when the URL does not pass [`validate_media_url`] — which is the
    /// only way a URL can enter this map at all.
    pub fn register(&self, url: &str, post_id: &str, account: &str) -> Option<String> {
        let url = validate_media_url(url)?.to_string();
        let generation = self.generation();
        let mut guard = self.inner.lock().ok()?;

        // The same URL in the same generation keeps its id, so re-rendering a
        // card does not leak registrations or restart a download.
        if let Some(id) = guard.by_url.get(&url).cloned() {
            if guard.entries.get(&id).is_some_and(|e| e.generation == generation) {
                guard.order.retain(|old| old != &id);
                guard.order.push(id.clone());
                return Some(id);
            }
        }

        let id = random_token(16);
        if guard.order.len() >= MAX_REGISTRY_ENTRIES {
            if let Some(oldest) = guard.order.first().cloned() {
                guard.order.remove(0);
                if let Some(entry) = guard.entries.remove(&oldest) { guard.by_url.remove(&entry.url); }
            }
        }
        guard.by_url.insert(url.clone(),id.clone());
        guard.entries.insert(
            id.clone(),
            MediaEntry {
                url,
                post_id: post_id.to_string(),
                account: account.to_string(),
                generation,
            },
        );
        guard.order.push(id.clone());
        Some(id)
    }

    /// Look up an id, refusing entries from a superseded generation.
    pub fn lookup(&self, id: &str) -> Option<MediaEntry> {
        let current = self.generation();
        let mut guard = self.inner.lock().ok()?;
        let entry = guard
            .entries
            .get(id)
            .filter(|e| e.generation == current)
            .cloned()?;
        guard.order.retain(|old| old != id);
        guard.order.push(id.to_owned());
        Some(entry)
    }

    /// Register a URL that bypasses host validation, for pointing tests at a
    /// local fixture server. `cfg(test)` only.
    #[cfg(any(test, all(feature = "dev-mock", debug_assertions)))]
    pub fn register_for_test(&self, url: &str) -> String {
        let id = random_token(16);
        let mut guard = self.inner.lock().unwrap();
        guard.entries.insert(
            id.clone(),
            MediaEntry {
                url: url.to_string(),
                post_id: "test".into(),
                account: "test".into(),
                generation: self.generation(),
            },
        );
        guard.order.push(id.clone());
        id
    }

    /// Drop a single registration — used when the player retries, so the stale
    /// id cannot be replayed.
    pub fn remove(&self, id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(entry) = guard.entries.remove(id) { guard.by_url.remove(&entry.url); }
            guard.order.retain(|x| x != id);
        }
    }

    /// Invalidate everything: account switch, disconnect, or session end.
    ///
    /// Bumping the generation makes every previously issued id fail its
    /// `lookup` even in the window before the map is cleared.
    pub fn invalidate_all(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.lock() {
            guard.entries.clear();
            guard.by_url.clear();
            guard.order.clear();
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.entries.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A running proxy.
pub struct MediaProxy {
    port: u16,
    secret: String,
    registry: Arc<MediaRegistry>,
    metrics:Arc<ProxyMetrics>,
    /// Dropping this tells the accept loop to stop.
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl MediaProxy {
    /// The base URL the frontend should use. Contains the secret, so this is
    /// handed to the webview and never logged.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/media/{}", self.port, self.secret)
    }

    /// A local URL for one registered media id.
    pub fn url_for(&self, media_id: &str) -> String {
        format!("{}/{}", self.base_url(), media_id)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn registry(&self) -> Arc<MediaRegistry> {
        Arc::clone(&self.registry)
    }
    /// A bounded aggregate snapshot for authorized native diagnostics. Counter
    /// reads are individually atomic; concurrent requests may advance between
    /// fields. No remote destination or per-request identifier is exposed.
    pub fn metrics(&self)->MediaMetricsSnapshot {self.metrics.snapshot()}

    /// Bind and start serving.
    ///
    /// Binds `127.0.0.1` explicitly — never `0.0.0.0`, never the LAN address,
    /// never the IPv6 wildcard — so nothing outside this machine can reach it
    /// even before the secret is checked. Port `0` lets Windows pick a free
    /// port, which also means the address is not predictable between runs.
    pub async fn start(registry: Arc<MediaRegistry>) -> AppResult<Self> {
        Self::start_inner(registry, None).await
    }

    /// Start with one extra upstream origin permitted, so the streaming path
    /// can be exercised against a local fixture server.
    ///
    /// `cfg(test)` only: a release binary has no code path that can widen the
    /// host allowlist, because this function is not compiled into one.
    #[cfg(any(test, all(feature = "dev-mock", debug_assertions)))]
    pub async fn start_with_test_upstream(
        registry: Arc<MediaRegistry>,
        prefix: String,
    ) -> AppResult<Self> {
        Self::start_inner(registry, Some(prefix)).await
    }

    async fn start_inner(
        registry: Arc<MediaRegistry>,
        #[allow(unused_variables)] test_upstream_prefix: Option<String>,
    ) -> AppResult<Self> {
        let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
        let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
            AppError::new(
                ErrorCode::MediaUnavailable,
                format!("could not start the local media server: {e}"),
            )
            .with_repair("Video playback will be unavailable this session.")
        })?;
        let port = listener
            .local_addr()
            .map_err(|e| {
                AppError::new(
                    ErrorCode::MediaUnavailable,
                    format!("local media server has no address: {e}"),
                )
            })?
            .port();

        let secret = random_token(24);

        let client = reqwest::Client::builder()
            // Every hop is re-validated against the trusted-host list, so a
            // redirect cannot walk the fetch off the CDN and onto an internal
            // address.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    return attempt.error("too many redirects");
                }
                match validate_media_url(attempt.url().as_str()) {
                    Some(_) => attempt.follow(),
                    None => attempt.stop(),
                }
            }))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| {
                AppError::new(
                    ErrorCode::MediaUnavailable,
                    format!("could not build the media client: {e}"),
                )
            })?;

        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        let metrics=Arc::new(ProxyMetrics::default());
        let ctx = Arc::new(ProxyContext {
            secret: secret.clone(),
            registry: Arc::clone(&registry),
            client,
            transfers: TransferPools::new(),
            metrics:Arc::clone(&metrics),
            #[cfg(any(test, all(feature = "dev-mock", debug_assertions)))]
            test_upstream_prefix,
        });

        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    biased;
                    _ = &mut rx => break,
                    a = listener.accept() => a,
                };
                let Ok((stream, peer)) = accepted else {
                    continue;
                };
                // Belt and braces: the socket is already loopback-bound, but a
                // non-loopback peer is refused rather than served.
                if !peer.ip().is_loopback() {
                    continue;
                }
                let ctx = Arc::clone(&ctx);
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let ctx = Arc::clone(&ctx);
                        async move { Ok::<_, std::convert::Infallible>(handle(req, ctx).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });

        log::info!("media proxy listening on 127.0.0.1:{port}");
        Ok(Self {
            port,
            secret,
            registry,
            metrics,
            shutdown: Some(tx),
        })
    }

    /// Stop serving and drop every registration.
    pub fn shutdown(&mut self) {
        // Idempotent: `AppState::shutdown` calls this, and so does `Drop` a
        // moment later. Only the first call has a sender to take, so only the
        // first one says anything — a second "stopped" line in the log would
        // read like the proxy restarted in between.
        let Some(tx) = self.shutdown.take() else {
            return;
        };
        let _ = tx.send(());
        self.registry.invalidate_all();
        log::info!("media proxy stopped");
    }
}

impl Drop for MediaProxy {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct ProxyContext {
    secret: String,
    registry: Arc<MediaRegistry>,
    client: reqwest::Client,
    transfers: TransferPools,
    metrics:Arc<ProxyMetrics>,
    /// See [`MediaProxy::start_with_test_upstream`]. Absent from release builds.
    #[cfg(any(test, all(feature = "dev-mock", debug_assertions)))]
    test_upstream_prefix: Option<String>,
}

impl ProxyContext {
    /// The host check applied at fetch time.
    ///
    /// In a release build this is exactly [`validate_media_url`]; the test
    /// branch does not exist there.
    fn allow<'a>(&self, url: &'a str) -> Option<&'a str> {
        #[cfg(any(test, all(feature = "dev-mock", debug_assertions)))]
        if let Some(prefix) = &self.test_upstream_prefix {
            if url.starts_with(prefix.as_str()) {
                return Some(url);
            }
        }
        validate_media_url(url)
    }
}

type ProxyBody = BoxBody<Bytes, std::io::Error>;

fn empty_body() -> ProxyBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

fn text_body(s: &'static str) -> ProxyBody {
    Full::new(Bytes::from_static(s.as_bytes()))
        .map_err(|never| match never {})
        .boxed()
}

/// A refusal. Deliberately terse and identical in shape for every cause: an
/// attacker probing ids should not learn *why* a request failed.
fn refuse(status: StatusCode) -> Response<ProxyBody> {
    let mut res = Response::new(text_body("media unavailable"));
    *res.status_mut() = status;
    res.headers_mut()
        .insert("content-type", HeaderValue::from_static("text/plain"));
    harden(res.headers_mut());
    res
}

/// Provenance is attached only after the process secret and a live registered
/// media id have been verified. Unknown paths retain the identical refusal
/// shape above; native diagnostics cannot turn this into a probing oracle.
fn refuse_validated(status:StatusCode,origin:&'static str)->Response<ProxyBody>{
    let mut response=refuse(status);
    response.headers_mut().insert("x-focusfeed-failure-origin",HeaderValue::from_static(origin));
    response
}

/// Headers set on every response we produce.
fn harden(h: &mut HeaderMap) {
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    // Nothing here is a document; make that unambiguous to the webview.
    h.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert(
        "cache-control",
        HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
    );
    h.insert("pragma", HeaderValue::from_static("no-cache"));
    h.insert("vary", HeaderValue::from_static("Origin"));
}

/// Decide the `Access-Control-Allow-Origin` value for a request.
///
/// Returns `None` when the request carries an origin that is not the app's, in
/// which case no CORS header is emitted at all. A wildcard is never returned —
/// this server is reachable by anything running as this user on this machine,
/// and the secret is the only thing standing between them and the media.
pub fn cors_origin_for(request_origin: Option<&str>) -> Option<&'static str> {
    let origin = request_origin?;
    ALLOWED_ORIGINS
        .iter()
        .find(|allowed| **allowed == origin)
        .copied()
}

/// Split `/media/{secret}/{id}` into its two secret-bearing parts.
pub fn parse_media_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/media/")?;
    let (secret, id) = rest.split_once('/')?;
    if secret.is_empty() || id.is_empty() || id.contains('/') {
        return None;
    }
    // Ids and secrets are hex from `random_token`. Anything else is not one of
    // ours, so reject before it reaches a map lookup.
    let hexish = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    (hexish(secret) && hexish(id)).then_some((secret, id))
}

async fn handle(req: Request<Incoming>, ctx: Arc<ProxyContext>) -> Response<ProxyBody> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let allow_origin = cors_origin_for(origin.as_deref());

    // Preflight. WebView2 does not preflight a plain media load, but a `fetch`
    // for diagnostics would, and answering correctly is cheaper than debugging
    // why it did not.
    if req.method() == Method::OPTIONS {
        let mut res = Response::new(empty_body());
        *res.status_mut() = StatusCode::NO_CONTENT;
        let h = res.headers_mut();
        if let Some(o) = allow_origin {
            h.insert("access-control-allow-origin", HeaderValue::from_static(o));
            h.insert(
                "access-control-allow-methods",
                HeaderValue::from_static("GET, HEAD"),
            );
            h.insert(
                "access-control-allow-headers",
                HeaderValue::from_static("Range, If-Range, If-None-Match, If-Modified-Since"),
            );
        }
        harden(h);
        return res;
    }

    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return refuse(StatusCode::METHOD_NOT_ALLOWED);
    }

    let Some((secret, id)) = parse_media_path(req.uri().path()) else {
        return refuse(StatusCode::NOT_FOUND);
    };
    if !constant_time_eq(secret, &ctx.secret) {
        return refuse(StatusCode::NOT_FOUND);
    }
    // Unknown id, or an id from a superseded account/session generation.
    let Some(entry) = ctx.registry.lookup(id) else {
        return refuse(StatusCode::NOT_FOUND);
    };
    // The host allowlist is re-checked at fetch time, not only at registration.
    let Some(url) = ctx.allow(&entry.url) else {
        return refuse(StatusCode::FORBIDDEN);
    };
    let image_request=reqwest::Url::parse(url).ok().is_some_and(|parsed|parsed.host_str()==Some("pbs.twimg.com"));
    let mut measured=MeasuredTransfer::queued(ctx.metrics.pool(image_request));

    // Diagnostics must not queue behind the transfers they are diagnosing.
    // A HEAD from the trusted app returns local queue exhaustion immediately;
    // ordinary media GETs retain the existing bounded ten-second wait.
    let acquired=if req.method()==Method::HEAD {Arc::clone(ctx.transfers.for_url(url)).try_acquire_owned().ok()}else{acquire_transfer(ctx.transfers.for_url(url)).await};
    let permit = match acquired {
        Some(permit) => permit,
        None => {measured.fail();return refuse_validated(StatusCode::TOO_MANY_REQUESTS,"local_queue");},
    };
    measured.activate(permit);
    if ctx.registry.generation()!=entry.generation {return refuse_validated(StatusCode::NOT_FOUND,"registration");}

    let mut upstream = ctx.client.get(url).timeout(Duration::from_secs(if image_request {20}else{90}));
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(v) = req.headers().get(*name) {
            upstream = upstream.header(*name, v);
        }
    }

    let response = match upstream.send().await {
        Ok(r) => r,
        Err(e) => {
            measured.fail();
            // The URL is never logged: it is signed, and a log file is a
            // durable artefact this app otherwise avoids producing.
            log::warn!(
                "media fetch failed for post {}: {}",
                entry.post_id,
                if e.is_timeout() {
                    "timeout"
                } else if e.is_connect() {
                    "connect"
                } else {
                    "request"
                }
            );
            return refuse_validated(StatusCode::BAD_GATEWAY,"upstream_network");
        }
    };
    measured.headers();

    let header_bytes: usize = response
        .headers()
        .iter()
        .map(|(name, value)| name.as_str().len() + value.as_bytes().len() + 4)
        .sum();
    if header_bytes > MAX_RESPONSE_HEADER_BYTES {
        measured.fail();
        return refuse_validated(StatusCode::BAD_GATEWAY,"upstream_http");
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MEDIA_BYTES)
    {
        measured.fail();
        return refuse_validated(StatusCode::PAYLOAD_TOO_LARGE,"upstream_http");
    }

    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if !status.is_success() && status!=StatusCode::NOT_MODIFIED{measured.fail();}
    let mut out = Response::new(empty_body());
    *out.status_mut() = status;
    copy_response_headers(response.headers(), out.headers_mut());
    // A forwarded CDN 429 is distinct from exhausting our own transfer pool.
    // The upstream response cannot supply or override this private header.
    out.headers_mut().insert("x-focusfeed-failure-origin",HeaderValue::from_static("upstream_http"));
    if let Some(o) = allow_origin {
        out.headers_mut()
            .insert("access-control-allow-origin", HeaderValue::from_static(o));
    }
    harden(out.headers_mut());

    // HEAD, 304 and 416 carry no body; their headers are the whole answer.
    if req.method() == Method::HEAD || status == StatusCode::NOT_MODIFIED {
        measured.complete();
        return out;
    }

    // Stream. `bytes_stream` yields chunks as they arrive, so peak memory is a
    // chunk rather than a file, and dropping the response — which is what
    // happens when the webview cancels or the card unmounts — cancels the
    // upstream request with it.
    let expected=response.content_length();
    if expected==Some(0){measured.complete();}
    let stream=MeasuredMediaStream{
        upstream:Box::pin(response.bytes_stream().map_err(|error|std::io::Error::other(error.to_string()))),
        registry:Arc::clone(&ctx.registry),generation:entry.generation,received:0,expected,
        transfer:Some(measured),ended:false,
    };
    *out.body_mut() = StreamBody::new(stream).boxed();
    out
}

/// Copy only the allowlisted response headers.
///
/// `set-cookie` can never appear here: it is not in the allowlist, and the
/// allowlist is exhaustive rather than a denylist, so a header we have not
/// thought about is dropped by default rather than forwarded by default.
pub fn copy_response_headers(from: &HeaderMap, to: &mut HeaderMap) {
    for name in FORWARDED_RESPONSE_HEADERS {
        if let Some(v) = from.get(*name) {
            if let Ok(hn) = HeaderName::from_bytes(name.as_bytes()) {
                to.insert(hn, v.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn measured_phases_remain_separate_and_each_pool_accounts_for_its_own_work() {
        let metrics=super::ProxyMetrics::default();
        let slots=std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let mut transfer=super::MeasuredTransfer::queued(metrics.pool(true));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        transfer.activate(std::sync::Arc::clone(&slots).acquire_owned().await.unwrap());
        assert_eq!(metrics.snapshot().images.active_transfers,1);
        assert_eq!(metrics.snapshot().images.queued_transfers,0);
        let queued_ms=metrics.snapshot().images.queue_wait_ms_total;
        assert!(queued_ms>=10);
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        transfer.headers();transfer.complete();drop(transfer);
        let cancelled=super::MeasuredTransfer::queued(metrics.pool(false));drop(cancelled);
        let result=metrics.snapshot();
        assert_eq!(result.images.requests_total,1);assert_eq!(result.images.completed,1);
        assert_eq!(result.images.queue_wait_ms_total,queued_ms);
        assert!(result.images.upstream_headers_ms_total>=15);
        assert_eq!(result.videos.cancelled,1);assert_eq!(result.videos.completed,0);
        assert_eq!(result.total.requests_total,2);assert_eq!(result.total.active_transfers,0);assert_eq!(result.total.queued_transfers,0);
        assert_eq!(slots.available_permits(),1);
    }
    #[tokio::test]
    async fn pictures_have_bounded_capacity_even_when_every_video_slot_is_busy() {
        let pools = super::TransferPools::new();
        let videos = pools.for_url("https://video.twimg.com/clip.mp4");
        let mut held = Vec::new();
        for _ in 0..super::MAX_CONCURRENT_TRANSFERS {
            held.push(super::acquire_transfer(videos).await.unwrap());
        }
        assert!(videos.try_acquire().is_err());
        let pictures = pools.for_url("https://pbs.twimg.com/profile_images/avatar.jpg");
        let mut images = Vec::new();
        for _ in 0..super::MAX_CONCURRENT_TRANSFERS {
            images.push(tokio::time::timeout(std::time::Duration::from_millis(100), super::acquire_transfer(pictures)).await.unwrap().unwrap());
        }
        assert!(pictures.try_acquire().is_err());
        drop(held);
        assert!(videos.try_acquire().is_ok());
        assert!(pictures.try_acquire().is_err());
    }
    #[tokio::test]
    async fn a_normal_avatar_burst_waits_for_capacity_instead_of_failing() {
        let slots=std::sync::Arc::new(tokio::sync::Semaphore::new(4));
        let mut held=Vec::new();
        for _ in 0..4 {held.push(super::acquire_transfer(&slots).await.unwrap());}
        let waiting_slots=std::sync::Arc::clone(&slots);
        let waiting=tokio::spawn(async move {super::acquire_transfer(&waiting_slots).await});
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(),"the fifth visible image was rejected instead of queued");
        held.pop();
        assert!(tokio::time::timeout(std::time::Duration::from_secs(1),waiting).await.unwrap().unwrap().is_some());
    }
    use super::*;

    // -----------------------------------------------------------------------
    // URL validation / SSRF
    // -----------------------------------------------------------------------

    #[test]
    fn real_x_media_urls_are_accepted() {
        // Shapes taken from live payloads: video is signed with a `tag` query
        // parameter, images are not.
        assert!(validate_media_url(
            "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280/abc.mp4?tag=12"
        )
        .is_some());
        assert!(validate_media_url("https://pbs.twimg.com/media/Abc123.jpg").is_some());
    }

    #[test]
    fn a_lookalike_host_is_refused() {
        // The whole point of exact matching: these all end with a trusted host.
        for url in [
            "https://video.twimg.com.evil.test/a.mp4",
            "https://evil.test/video.twimg.com/a.mp4",
            "https://notvideo.twimg.com/a.mp4",
        ] {
            assert!(validate_media_url(url).is_none(), "accepted {url}");
        }
    }

    #[test]
    fn embedded_credentials_cannot_redirect_the_host() {
        // Resolves to evil.test while reading as twimg.
        assert!(validate_media_url("https://video.twimg.com@evil.test/a.mp4").is_none());
        assert!(validate_media_url("https://user:pass@video.twimg.com/a.mp4").is_none());
    }

    #[test]
    fn only_https_is_accepted() {
        for url in [
            "http://video.twimg.com/a.mp4",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:video/mp4;base64,AAAA",
            "ftp://video.twimg.com/a.mp4",
        ] {
            assert!(validate_media_url(url).is_none(), "accepted {url}");
        }
    }

    #[test]
    fn a_port_on_a_trusted_host_is_refused() {
        // `video.twimg.com:9999` is a different service on the same name.
        assert!(validate_media_url("https://video.twimg.com:9999/a.mp4").is_none());
    }

    #[test]
    fn whitespace_and_control_characters_are_refused() {
        assert!(validate_media_url("https://video.twimg.com/a b.mp4").is_none());
        assert!(validate_media_url("https://video.twimg.com/a\nb.mp4").is_none());
        assert!(validate_media_url("https://video.twimg.com/a\0b.mp4").is_none());
    }

    #[test]
    fn loopback_and_private_addresses_are_recognised() {
        for h in [
            "localhost",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.1",
            "172.16.0.1",
            "169.254.169.254", // cloud metadata
            "0.0.0.0",
            "[::1]",
        ] {
            assert!(is_private_host(h), "{h} not treated as private");
        }
        assert!(!is_private_host("video.twimg.com"));
        assert!(!is_private_host("8.8.8.8"));
    }

    #[test]
    fn a_private_address_is_not_a_trusted_media_host_anyway() {
        // Two independent guards; neither relies on the other.
        assert!(validate_media_url("https://127.0.0.1/a.mp4").is_none());
        assert!(validate_media_url("https://169.254.169.254/latest/meta-data").is_none());
    }

    // -----------------------------------------------------------------------
    // Registry
    // -----------------------------------------------------------------------

    #[test]
    fn only_a_validated_url_can_be_registered() {
        let reg = MediaRegistry::new();
        assert!(reg.register("https://evil.test/a.mp4", "1", "me").is_none());
        assert!(reg.register("file:///C:/secret.txt", "1", "me").is_none());
        assert!(reg.is_empty());
    }

    #[test]
    fn an_opaque_id_reveals_nothing_about_the_url() {
        let reg = MediaRegistry::new();
        let id = reg
            .register("https://video.twimg.com/ext/vid/abc.mp4?tag=12", "99", "me")
            .unwrap();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!id.contains("twimg"));
        // A random hexadecimal id can contain "abc" by chance. Verify the
        // private lookup instead of rejecting a legitimate random sample.
        assert_eq!(reg.lookup(&id).unwrap().url,"https://video.twimg.com/ext/vid/abc.mp4?tag=12");
    }

    #[test]
    fn two_different_urls_get_two_different_ids() {
        let reg = MediaRegistry::new();
        let a = reg
            .register("https://video.twimg.com/a.mp4", "1", "me")
            .unwrap();
        let b = reg
            .register("https://video.twimg.com/b.mp4", "1", "me")
            .unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn re_registering_the_same_url_is_stable() {
        // Re-rendering a card must not leak a new registration each time.
        let reg = MediaRegistry::new();
        let a = reg
            .register("https://video.twimg.com/a.mp4", "1", "me")
            .unwrap();
        let b = reg
            .register("https://video.twimg.com/a.mp4", "1", "me")
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn an_unknown_id_resolves_to_nothing() {
        let reg = MediaRegistry::new();
        assert!(reg.lookup("deadbeef").is_none());
        assert!(reg.lookup("").is_none());
    }

    #[test]
    fn an_account_switch_invalidates_every_existing_id() {
        let reg = MediaRegistry::new();
        let id = reg
            .register("https://video.twimg.com/a.mp4", "1", "me")
            .unwrap();
        assert!(reg.lookup(&id).is_some());

        reg.invalidate_all();

        assert!(reg.lookup(&id).is_none(), "id survived an account switch");
        assert!(reg.is_empty());
    }

    #[test]
    fn a_generation_bump_beats_a_surviving_map_entry() {
        // Guards the window between bumping the generation and clearing the
        // map: the entry may still be present, but must not resolve.
        let reg = MediaRegistry::new();
        let id = reg
            .register("https://video.twimg.com/a.mp4", "1", "me")
            .unwrap();
        reg.generation.fetch_add(1, Ordering::SeqCst);
        assert!(reg.lookup(&id).is_none());
    }

    #[test]
    fn a_removed_id_cannot_be_replayed() {
        let reg = MediaRegistry::new();
        let id = reg
            .register("https://video.twimg.com/a.mp4", "1", "me")
            .unwrap();
        reg.remove(&id);
        assert!(reg.lookup(&id).is_none());
    }

    #[test]
    fn the_registry_is_bounded() {
        let reg = MediaRegistry::new();
        for i in 0..MAX_REGISTRY_ENTRIES + 50 {
            reg.register(&format!("https://video.twimg.com/{i}.mp4"), "1", "me")
                .unwrap();
        }
        assert!(reg.len() <= MAX_REGISTRY_ENTRIES, "len {}", reg.len());
    }

    #[test]
    fn active_video_ranges_survive_account_image_churn() {
        let registry = MediaRegistry::new();
        let video = registry.register("https://video.twimg.com/active.mp4","1","me").unwrap();
        let stale = registry.register("https://pbs.twimg.com/profile_images/stale.jpg","2","me").unwrap();
        for i in 0..MAX_REGISTRY_ENTRIES + 20 {
            assert!(registry.lookup(&video).is_some());
            registry.register(&format!("https://pbs.twimg.com/profile_images/{i}.jpg"),"2","me").unwrap();
        }
        assert!(registry.lookup(&video).is_some());
        assert!(registry.lookup(&stale).is_none());
        assert_eq!(registry.len(),MAX_REGISTRY_ENTRIES);
        registry.invalidate_all();
        assert!(registry.lookup(&video).is_none());
        assert!(registry.inner.lock().unwrap().by_url.is_empty());
    }

    // -----------------------------------------------------------------------
    // Path, secret, CORS
    // -----------------------------------------------------------------------

    #[test]
    fn the_media_path_needs_both_segments() {
        assert_eq!(parse_media_path("/media/aabb/ccdd"), Some(("aabb", "ccdd")));
        assert!(parse_media_path("/media/aabb").is_none());
        assert!(parse_media_path("/media//ccdd").is_none());
        assert!(parse_media_path("/media/aabb/").is_none());
        assert!(parse_media_path("/").is_none());
        assert!(parse_media_path("/other/aabb/ccdd").is_none());
    }

    #[test]
    fn path_traversal_and_non_hex_segments_are_refused() {
        // There is no filesystem behind this route, but a lookup key that is
        // not one of ours should never reach the map.
        assert!(parse_media_path("/media/../../etc/passwd").is_none());
        assert!(parse_media_path("/media/aabb/../../secret").is_none());
        assert!(parse_media_path("/media/aabb/cc dd").is_none());
    }

    #[test]
    fn secret_comparison_rejects_wrong_and_short_values() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        // A prefix must not pass — the classic early-return bug.
        assert!(!constant_time_eq("abc", "abc123"));
        assert!(!constant_time_eq("", "abc123"));
    }

    #[test]
    fn a_fresh_secret_is_generated_each_time() {
        let a = random_token(24);
        let b = random_token(24);
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
    }

    #[test]
    fn cors_never_answers_with_a_wildcard() {
        assert_eq!(
            cors_origin_for(Some("http://tauri.localhost")),
            Some("http://tauri.localhost")
        );
        assert_eq!(
            cors_origin_for(Some("https://tauri.localhost")),
            Some("https://tauri.localhost")
        );
        assert_eq!(
            cors_origin_for(Some("tauri://localhost")),
            Some("tauri://localhost")
        );
        // Anything else gets no CORS header at all, rather than `*`.
        assert_eq!(cors_origin_for(Some("http://evil.test")), None);
        assert_eq!(cors_origin_for(Some("null")), None);
        assert_eq!(cors_origin_for(None), None);
        assert!(!ALLOWED_ORIGINS.contains(&"*"));
    }

    // -----------------------------------------------------------------------
    // Header handling
    // -----------------------------------------------------------------------

    #[test]
    fn set_cookie_is_never_forwarded_to_the_webview() {
        let mut from = HeaderMap::new();
        from.insert("set-cookie", HeaderValue::from_static("a=b; HttpOnly"));
        from.insert("content-type", HeaderValue::from_static("video/mp4"));
        from.insert("server", HeaderValue::from_static("tsa_o"));
        let mut to = HeaderMap::new();
        copy_response_headers(&from, &mut to);

        assert!(to.get("set-cookie").is_none());
        // Server identification is not needed for playback, so it is dropped.
        assert!(to.get("server").is_none());
        assert_eq!(to.get("content-type").unwrap(), "video/mp4");
    }

    #[test]
    fn the_headers_that_make_seeking_work_survive() {
        let mut from = HeaderMap::new();
        from.insert("content-range", HeaderValue::from_static("bytes 0-99/1000"));
        from.insert("content-length", HeaderValue::from_static("100"));
        from.insert("accept-ranges", HeaderValue::from_static("bytes"));
        from.insert("etag", HeaderValue::from_static("\"v1\""));
        from.insert(
            "last-modified",
            HeaderValue::from_static("Wed, 01 Jul 2026 00:00:00 GMT"),
        );
        from.insert("cache-control", HeaderValue::from_static("max-age=3600"));
        let mut to = HeaderMap::new();
        copy_response_headers(&from, &mut to);

        assert_eq!(to.get("content-range").unwrap(), "bytes 0-99/1000");
        assert_eq!(to.get("content-length").unwrap(), "100");
        assert_eq!(to.get("accept-ranges").unwrap(), "bytes");
        assert_eq!(to.get("etag").unwrap(), "\"v1\"");
        assert!(to.get("last-modified").is_some());
        assert!(to.get("cache-control").is_none());

        harden(&mut to);
        assert_eq!(
            to.get("cache-control").unwrap(),
            "no-store, no-cache, must-revalidate, max-age=0"
        );
        assert_eq!(to.get("pragma").unwrap(), "no-cache");
    }

    #[test]
    fn credentials_are_not_in_the_forwarded_request_set() {
        for banned in ["cookie", "authorization", "proxy-authorization", "origin"] {
            assert!(
                !FORWARDED_REQUEST_HEADERS.contains(&banned),
                "{banned} would be forwarded upstream"
            );
        }
        // And the ones that make Range work are.
        for needed in ["range", "if-range", "if-none-match", "if-modified-since"] {
            assert!(FORWARDED_REQUEST_HEADERS.contains(&needed));
        }
    }

    #[test]
    fn set_cookie_is_absent_from_the_response_allowlist() {
        assert!(!FORWARDED_RESPONSE_HEADERS.contains(&"set-cookie"));
        assert!(!FORWARDED_RESPONSE_HEADERS.contains(&"server"));
    }

    // -----------------------------------------------------------------------
    // End to end, over real sockets
    // -----------------------------------------------------------------------
    //
    // These run the actual hyper server and speak real HTTP to it. A fixture
    // upstream stands in for the CDN so Range, conditional requests and status
    // passthrough are exercised without touching the network.

    const FIXTURE_LEN: usize = 300_000;

    /// A minimal CDN: serves one body, honours Range and If-None-Match, and
    /// tries to set a cookie so we can prove the proxy strips it.
    async fn start_fixture_upstream() -> u16 {
        let listener = tokio::net::TcpListener::bind::<SocketAddr>(([127, 0, 0, 1], 0).into())
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                tokio::spawn(async move {
                    let service = service_fn(|req: Request<Incoming>| async move {
                        Ok::<_, std::convert::Infallible>(fixture_respond(req))
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        port
    }

    fn fixture_respond(req: Request<Incoming>) -> Response<Full<Bytes>> {
        if req.uri().path()=="/limited" {
            let mut response=Response::new(Full::new(Bytes::new()));
            *response.status_mut()=StatusCode::TOO_MANY_REQUESTS;
            // A CDN cannot forge a local failure classification.
            response.headers_mut().insert("x-focusfeed-failure-origin",HeaderValue::from_static("local_queue"));
            return response;
        }
        let body: Vec<u8> = (0..FIXTURE_LEN).map(|i| (i % 251) as u8).collect();
        let total = body.len();
        let mut res = Response::new(Full::new(Bytes::new()));
        let common = |h: &mut HeaderMap| {
            h.insert("content-type", HeaderValue::from_static("video/mp4"));
            h.insert("accept-ranges", HeaderValue::from_static("bytes"));
            h.insert("etag", HeaderValue::from_static("\"fixture-v1\""));
            // Both of these must be dropped by the proxy.
            h.insert(
                "set-cookie",
                HeaderValue::from_static("sid=secret; HttpOnly"),
            );
            h.insert("server", HeaderValue::from_static("fixture-cdn"));
        };

        if req
            .headers()
            .get("if-none-match")
            .and_then(|v| v.to_str().ok())
            == Some("\"fixture-v1\"")
        {
            *res.status_mut() = StatusCode::NOT_MODIFIED;
            common(res.headers_mut());
            return res;
        }

        if let Some(range) = req.headers().get("range").and_then(|v| v.to_str().ok()) {
            let spec = range.trim_start_matches("bytes=");
            let (s, e) = spec.split_once('-').unwrap_or(("0", ""));
            let start: usize = s.parse().unwrap_or(0);
            let end: usize = e.parse().unwrap_or(total - 1).min(total - 1);
            if start >= total || start > end {
                *res.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
                common(res.headers_mut());
                res.headers_mut().insert(
                    "content-range",
                    HeaderValue::from_str(&format!("bytes */{total}")).unwrap(),
                );
                return res;
            }
            let slice = body[start..=end].to_vec();
            *res.status_mut() = StatusCode::PARTIAL_CONTENT;
            common(res.headers_mut());
            res.headers_mut().insert(
                "content-range",
                HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")).unwrap(),
            );
            res.headers_mut().insert(
                "content-length",
                HeaderValue::from_str(&slice.len().to_string()).unwrap(),
            );
            *res.body_mut() = Full::new(Bytes::from(slice));
            return res;
        }

        common(res.headers_mut());
        res.headers_mut().insert(
            "content-length",
            HeaderValue::from_str(&total.to_string()).unwrap(),
        );
        *res.body_mut() = Full::new(Bytes::from(body));
        res
    }

    /// Proxy + fixture upstream + a registered id pointing at it.
    async fn harness() -> (MediaProxy, String, reqwest::Client) {
        let up = start_fixture_upstream().await;
        let prefix = format!("http://127.0.0.1:{up}/");
        let registry = Arc::new(MediaRegistry::new());
        let id = registry.register_for_test(&format!("{prefix}video.mp4"));
        let proxy = MediaProxy::start_with_test_upstream(registry, prefix)
            .await
            .unwrap();
        let url = proxy.url_for(&id);
        (proxy, url, reqwest::Client::new())
    }

    #[tokio::test]
    async fn it_binds_only_to_loopback_on_a_random_port() {
        let registry = Arc::new(MediaRegistry::new());
        let proxy = MediaProxy::start(registry).await.unwrap();
        assert_ne!(proxy.port(), 0, "port 0 means nothing was bound");
        assert!(proxy.base_url().starts_with("http://127.0.0.1:"));
        // Never the wildcard or a routable interface.
        assert!(!proxy.base_url().contains("0.0.0.0"));
        assert!(!proxy.base_url().contains("localhost"));
    }

    #[tokio::test]
    async fn two_launches_get_different_secrets() {
        let a = MediaProxy::start(Arc::new(MediaRegistry::new()))
            .await
            .unwrap();
        let b = MediaProxy::start(Arc::new(MediaRegistry::new()))
            .await
            .unwrap();
        assert_ne!(a.base_url(), b.base_url());
    }

    #[tokio::test]
    async fn a_whole_body_is_served_with_the_right_type() {
        let (_proxy, url, client) = harness().await;
        let res = client.get(&url).send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "video/mp4");
        assert_eq!(res.headers()["accept-ranges"], "bytes");
        let bytes = res.bytes().await.unwrap();
        assert_eq!(bytes.len(), FIXTURE_LEN);
    }

    #[tokio::test]
    async fn real_completed_body_is_counted_and_unknown_requests_are_not() {
        let (proxy,url,client)=harness().await;
        assert_eq!(client.get(proxy.url_for("00")).send().await.unwrap().status(),404);
        assert_eq!(proxy.metrics().total.requests_total,0);
        let body=client.get(&url).send().await.unwrap().bytes().await.unwrap();
        assert_eq!(body.len(),FIXTURE_LEN);
        let deadline=tokio::time::Instant::now()+Duration::from_secs(1);
        loop {let metrics=proxy.metrics();if metrics.total.active_transfers==0{assert_eq!(metrics.total.completed,1);assert_eq!(metrics.total.cancelled,0);assert_eq!(metrics.total.bytes_streamed,FIXTURE_LEN as u64);break;}assert!(tokio::time::Instant::now()<deadline);tokio::time::sleep(Duration::from_millis(10)).await;}
        let encoded=serde_json::to_string(&proxy.metrics()).unwrap();
        assert!(!encoded.contains(&proxy.secret));assert!(!encoded.contains("127.0.0.1"));assert!(!encoded.contains("twimg"));
    }

    #[tokio::test]
    async fn a_range_request_comes_back_as_206_with_content_range() {
        // This is what seeking is built on.
        let (_proxy, url, client) = harness().await;
        let res = client
            .get(&url)
            .header("range", "bytes=100-199")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 206);
        assert_eq!(
            res.headers()["content-range"],
            format!("bytes 100-199/{FIXTURE_LEN}").as_str()
        );
        assert_eq!(res.headers()["content-length"], "100");
        let bytes = res.bytes().await.unwrap();
        assert_eq!(bytes.len(), 100);
        // The right 100 bytes, not just 100 of them. The fixture body is
        // `i % 251`, so byte 100 is 100 and byte 199 is 199.
        assert_eq!(bytes[0], 100);
        assert_eq!(bytes[99], 199);
    }

    #[tokio::test]
    async fn seeking_to_two_different_offsets_returns_two_different_slices() {
        let (_proxy, url, client) = harness().await;
        let first = client
            .get(&url)
            .header("range", "bytes=0-49")
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let later = client
            .get(&url)
            .header("range", "bytes=1000-1049")
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(first.len(), 50);
        assert_eq!(later.len(), 50);
        assert_ne!(first, later);
    }

    #[tokio::test]
    async fn an_unsatisfiable_range_is_passed_through_as_416() {
        let (_proxy, url, client) = harness().await;
        let res = client
            .get(&url)
            .header("range", "bytes=99999999-")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 416);
        assert!(res.headers().contains_key("content-range"));
    }

    #[tokio::test]
    async fn a_conditional_request_is_passed_through_as_304() {
        let (_proxy, url, client) = harness().await;
        let res = client
            .get(&url)
            .header("if-none-match", "\"fixture-v1\"")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 304);
        assert_eq!(res.bytes().await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn an_upstream_cookie_never_reaches_the_webview() {
        let (_proxy, url, client) = harness().await;
        let res = client.get(&url).send().await.unwrap();
        assert!(
            res.headers().get("set-cookie").is_none(),
            "the proxy forwarded a Set-Cookie"
        );
        assert!(res.headers().get("server").is_none());
    }

    #[tokio::test]
    async fn head_returns_the_headers_and_no_body() {
        let (_proxy, url, client) = harness().await;
        let res = client.head(&url).send().await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "video/mp4");
        assert_eq!(res.bytes().await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn native_probe_provenance_cannot_be_forged_by_upstream_or_observed_on_unknown_paths() {
        let port=start_fixture_upstream().await;
        let prefix=format!("http://127.0.0.1:{port}");
        let registry=Arc::new(MediaRegistry::new());
        let id=registry.register_for_test(&format!("{prefix}/limited"));
        let proxy=MediaProxy::start_with_test_upstream(registry,prefix).await.unwrap();
        let client=reqwest::Client::new();
        let response=client.head(proxy.url_for(&id)).send().await.unwrap();
        assert_eq!(response.status(),StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers().get("x-focusfeed-failure-origin").unwrap(),"upstream_http");
        let metrics=proxy.metrics();assert_eq!(metrics.total.requests_total,1);assert_eq!(metrics.total.failures,1);assert_eq!(metrics.total.completed,0);assert_eq!(metrics.total.active_transfers,0);
        let unknown=client.head(proxy.url_for("0011")).send().await.unwrap();
        assert_eq!(unknown.status(),StatusCode::NOT_FOUND);
        assert!(!unknown.headers().contains_key("x-focusfeed-failure-origin"));
        let local=refuse_validated(StatusCode::TOO_MANY_REQUESTS,"local_queue");
        assert_eq!(local.headers().get("x-focusfeed-failure-origin").unwrap(),"local_queue");
    }

    #[tokio::test]
    async fn write_methods_are_rejected() {
        let (_proxy, url, client) = harness().await;
        for m in [
            reqwest::Method::POST,
            reqwest::Method::PUT,
            reqwest::Method::DELETE,
            reqwest::Method::PATCH,
        ] {
            let res = client.request(m.clone(), &url).send().await.unwrap();
            assert_eq!(res.status(), 405, "{m} was not rejected");
        }
    }

    #[tokio::test]
    async fn a_wrong_secret_is_refused_even_with_a_valid_id() {
        let (proxy, url, client) = harness().await;
        let id = url.rsplit('/').next().unwrap();
        let forged = format!(
            "http://127.0.0.1:{}/media/{}/{id}",
            proxy.port(),
            "0".repeat(48)
        );
        assert_eq!(client.get(&forged).send().await.unwrap().status(), 404);
    }

    #[tokio::test]
    async fn an_unknown_media_id_is_refused() {
        let (proxy, url, client) = harness().await;
        let secret = url.split('/').nth(4).unwrap();
        let bogus = format!(
            "http://127.0.0.1:{}/media/{secret}/{}",
            proxy.port(),
            "ab".repeat(16)
        );
        assert_eq!(client.get(&bogus).send().await.unwrap().status(), 404);
    }

    #[tokio::test]
    async fn an_id_stops_working_after_the_session_is_invalidated() {
        let (proxy, url, client) = harness().await;
        assert_eq!(client.get(&url).send().await.unwrap().status(), 200);
        proxy.registry().invalidate_all();
        assert_eq!(
            client.get(&url).send().await.unwrap().status(),
            404,
            "media stayed reachable after an account switch"
        );
    }

    #[tokio::test]
    async fn there_is_no_route_other_than_media() {
        let (proxy, _url, client) = harness().await;
        for path in ["/", "/media", "/index.html", "/../Cargo.toml"] {
            let res = client
                .get(format!("http://127.0.0.1:{}{path}", proxy.port()))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 404, "{path} was served");
        }
    }

    #[tokio::test]
    async fn cors_answers_the_app_origin_and_refuses_others() {
        let (_proxy, url, client) = harness().await;
        let ours = client
            .get(&url)
            .header("origin", "http://tauri.localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(
            ours.headers()["access-control-allow-origin"],
            "http://tauri.localhost"
        );

        let theirs = client
            .get(&url)
            .header("origin", "http://evil.test")
            .send()
            .await
            .unwrap();
        assert!(
            theirs
                .headers()
                .get("access-control-allow-origin")
                .is_none(),
            "a foreign origin was granted access"
        );
    }

    #[tokio::test]
    async fn the_body_arrives_in_chunks_rather_than_one_buffer() {
        // Proof the response is streamed: a body larger than a single chunk
        // must reach us across several frames.
        use futures_util::StreamExt;
        let (_proxy, url, client) = harness().await;
        let res = client.get(&url).send().await.unwrap();
        let mut stream = res.bytes_stream();
        let mut chunks = 0usize;
        let mut total = 0usize;
        while let Some(Ok(c)) = stream.next().await {
            chunks += 1;
            total += c.len();
        }
        assert_eq!(total, FIXTURE_LEN);
        assert!(chunks > 1, "whole body arrived as one buffer ({chunks})");
    }

    #[tokio::test]
    async fn an_account_switch_aborts_an_already_open_media_stream() {
        use futures_util::StreamExt;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let prefix=format!("http://{}/",listener.local_addr().unwrap());
        let release=Arc::new(tokio::sync::Notify::new());
        let upstream_release=Arc::clone(&release);
        let server=tokio::spawn(async move {
            let (socket,_)=listener.accept().await.unwrap();
            let service=service_fn(move |_request:Request<Incoming>| {
                let release=Arc::clone(&upstream_release);
                async move {
                    let first=futures_util::stream::iter([Ok::<_,std::io::Error>(Frame::data(Bytes::from(vec![1;1024])))]);
                    let second=futures_util::stream::once(async move {
                        release.notified().await;
                        Ok::<_,std::io::Error>(Frame::data(Bytes::from(vec![2;1024])))
                    });
                    let response=Response::builder().header("content-type","video/mp4").header("content-length","2048")
                        .body(StreamBody::new(first.chain(second))).unwrap();
                    Ok::<_,std::convert::Infallible>(response)
                }
            });
            let _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service).await;
        });
        let registry=Arc::new(MediaRegistry::new());
        let id=registry.register_for_test(&format!("{prefix}video.mp4"));
        let proxy=MediaProxy::start_with_test_upstream(registry,prefix).await.unwrap();
        let mut response=reqwest::Client::new().get(proxy.url_for(&id)).timeout(Duration::from_secs(3)).send().await.unwrap();
        let mut received=0;
        while received<1024 {received+=response.chunk().await.unwrap().expect("stream ended before the first fixture block").len();}
        assert_eq!(received,1024);
        proxy.registry().invalidate_all();
        release.notify_one();
        assert!(!matches!(response.chunk().await,Ok(Some(_))),"Old-account bytes continued after invalidation");
        server.abort();
    }

    #[tokio::test]
    async fn dropping_a_real_stalled_body_releases_the_permit_and_records_cancellation() {
        use futures_util::StreamExt;
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let prefix=format!("http://{}/",listener.local_addr().unwrap());
        let release=Arc::new(tokio::sync::Notify::new());let upstream_release=Arc::clone(&release);
        let server=tokio::spawn(async move{
            let (socket,_)=listener.accept().await.unwrap();
            let service=service_fn(move |_request:Request<Incoming>|{
                let release=Arc::clone(&upstream_release);
                async move{
                    let first=futures_util::stream::iter([Ok::<_,std::io::Error>(Frame::data(Bytes::from(vec![1;1024])))]);
                    let rest=futures_util::stream::once(async move{release.notified().await;Ok::<_,std::io::Error>(Frame::data(Bytes::from(vec![2;1024])))});
                    Ok::<_,std::convert::Infallible>(Response::builder().header("content-type","video/mp4").header("content-length","2048").body(StreamBody::new(first.chain(rest))).unwrap())
                }
            });
            let _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service).await;
        });
        let registry=Arc::new(MediaRegistry::new());let id=registry.register_for_test(&format!("{prefix}video.mp4"));
        let proxy=MediaProxy::start_with_test_upstream(registry,prefix).await.unwrap();
        let mut response=reqwest::Client::new().get(proxy.url_for(&id)).timeout(Duration::from_secs(3)).send().await.unwrap();
        let chunk=response.chunk().await.unwrap().unwrap();assert_eq!(chunk.len(),1024);
        assert_eq!(proxy.metrics().videos.active_transfers,1);
        drop(response);
        let deadline=tokio::time::Instant::now()+Duration::from_secs(1);
        loop{
            let metrics=proxy.metrics();
            if metrics.total.active_transfers==0{assert_eq!(metrics.total.cancelled,1);assert_eq!(metrics.total.completed,0);assert_eq!(metrics.total.failures,0);assert_eq!(metrics.total.bytes_streamed,1024);assert_eq!(metrics.total.queued_transfers,0);break;}
            assert!(tokio::time::Instant::now()<deadline,"cancelled stream retained its transfer permit");tokio::time::sleep(Duration::from_millis(10)).await;
        }
        release.notify_one();server.abort();
    }

    #[tokio::test]
    async fn the_server_stops_answering_once_it_is_shut_down() {
        let (mut proxy, url, client) = harness().await;
        assert_eq!(client.get(&url).send().await.unwrap().status(), 200);

        proxy.shutdown();
        // The registry is emptied on the way out, so nothing is resolvable even
        // if a connection races the accept loop closing.
        assert!(proxy.registry().is_empty());

        let after = client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        let refused = match after {
            Err(_) => true,
            Ok(r) => r.status() == 404,
        };
        assert!(refused, "the proxy still served media after shutdown");
    }
}
