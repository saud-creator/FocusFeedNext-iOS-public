use crate::{
    database::{Db, FeedFilters},
    durable::{AccountIdentity, Durable},
    media_proxy::{MediaProxy, MediaRegistry},
    metadata::{backup_preferences, Metadata},
    models::*,
    provider_parser, FilterPreset, ResumeState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const PAYLOAD_BUDGET_BYTES: usize = 64 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreError {
    pub code: String,
    pub message: String,
}
impl CoreError {
    pub(crate) fn invalid() -> Self {
        Self {
            code: "invalid_request".into(),
            message: "The request was invalid. No action was performed.".into(),
        }
    }
    pub(crate) fn storage() -> Self {
        Self {
            code: "storage_unavailable".into(),
            message: "Local data could not be verified. Existing data was preserved.".into(),
        }
    }
    fn stale() -> Self {
        Self {
            code: "stale_request".into(),
            message: "This request no longer belongs to the current account or source.".into(),
        }
    }
    fn cancelled() -> Self {
        Self {
            code: "cancelled".into(),
            message: "This request was cancelled or its deadline expired.".into(),
        }
    }
    fn unavailable() -> Self {
        Self {
            code: "core_closed".into(),
            message: "The reader core is closed.".into(),
        }
    }
}
impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CoreError {}
impl From<AppError> for CoreError {
    fn from(e: AppError) -> Self {
        Self {
            code: serde_json::to_value(e.code)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "core_error".into()),
            message: crate::security::sanitize(&e.message),
        }
    }
}
impl From<rusqlite::Error> for CoreError {
    fn from(_: rusqlite::Error) -> Self {
        Self::storage()
    }
}

/// Closed operation surface. JSON is a bounded DTO payload, never a command,
/// code string, arbitrary URL fetch, SQL statement or secret-bearing record.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreOperation {
    ParseIdentity,
    ParsePostContent,
    ParseReplies,
    SetAccount,
    IngestFeed,
    IngestProfile,
    IngestFollowing,
    GetFeed,
    GetBookmarkSlice,
    GetProfile,
    GetFollowing,
    GetPost,
    GetReadIds,
    MarkRead,
    SetHidden,
    GetPinnedAccounts,
    PinAccount,
    GetMutedWords,
    SetMutedWord,
    GetLists,
    GetGroupCandidates,
    GetGroupFeed,
    UpsertList,
    DeleteList,
    SetListMember,
    GetPreferences,
    SetPreferences,
    GetFilterPresets,
    SetFilterPresets,
    GetResumeState,
    SetResumeState,
    PrepareAction,
    BeginAction,
    FinishAction,
    RegisterMedia,
    GetMediaUrl,
    ValidateMediaUrl,
    RecoverMedia,
    ProbeMedia,
    MediaHealth,
    RestartMedia,
    CancelMedia,
    Diagnostics,
    Search,
    ClearSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRequest {
    pub request_id: String,
    pub account_generation: u64,
    pub source_revision: u64,
    pub deadline_millis: u64,
    pub priority: u8,
    pub operation: CoreOperation,
    pub arguments_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedView {
    pub posts: Vec<Post>,
    pub read_ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub from_cache: bool,
    pub total_cached: usize,
    pub missing_post_ids: Vec<String>,
    pub next_offset: Option<usize>,
    pub last_sync: Option<String>,
    pub provider: String,
}

struct MediaBroker {
    runtime: Option<tokio::runtime::Runtime>,
    proxy: Option<MediaProxy>,
    registry: Arc<MediaRegistry>,
    epoch: u64,
    probe_client: reqwest::Client,
}

enum PreparedMediaProbe {
    Immediate(Value),
    Request(MediaProbeSnapshot),
}

/// Holds only cloneable request resources. The engine's state mutex and the
/// owning runtime are never borrowed across network I/O. A broker restart
/// cancels the spawned task and the caller rejects its obsolete epoch.
struct MediaProbeSnapshot {
    runtime: tokio::runtime::Handle,
    client: reqwest::Client,
    url: String,
    epoch: u64,
    registry_generation: u64,
}
impl MediaProbeSnapshot {
    fn run(self, mut check: impl FnMut() -> Result<(), CoreError>) -> Result<Value, CoreError> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let epoch = self.epoch;
        let task = self.runtime.spawn(async move {
            let value = match self.client.head(self.url).send().await {
                Ok(response) => classify_probe(response.status().as_u16(),response.headers().get("x-focusfeed-failure-origin").and_then(|value|value.to_str().ok()),epoch),
                Err(error) => json!({"kind":if error.is_timeout(){"probe_timeout"}else{"local_listener"},"httpStatus":null,"retryable":true,"brokerEpoch":epoch}),
            };
            let _ = sender.send(value);
        });
        // Dropping a Tokio JoinHandle normally detaches it. Every exit here,
        // including cancellation/deadline, must explicitly cancel its work.
        struct AbortProbe(tokio::task::JoinHandle<()>);
        impl Drop for AbortProbe {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _task = AbortProbe(task);
        loop {
            check()?;
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => {
                    check()?;
                    return Ok(value);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(CoreError::stale())
                }
            }
        }
    }
}
impl MediaBroker {
    fn new(epoch: u64) -> Result<Self, CoreError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("focusfeed-media")
            .enable_all()
            .build()
            .map_err(|_| CoreError {
                code: "media_unavailable".into(),
                message: "The local media service could not start.".into(),
            })?;
        let registry = Arc::new(MediaRegistry::new());
        let proxy = runtime
            .block_on(MediaProxy::start(registry.clone()))
            .map_err(CoreError::from)?;
        let probe_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| CoreError::unavailable())?;
        Ok(Self {
            runtime: Some(runtime),
            proxy: Some(proxy),
            registry,
            epoch,
            probe_client,
        })
    }
    fn stop(&mut self) {
        if let Some(mut proxy) = self.proxy.take() {
            proxy.shutdown();
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_secs(1));
        }
    }
    fn register(&self, url: &str, post: &str, account: &str) -> Option<String> {
        let id = self.registry.register(url, post, account)?;
        Some(format!("ffmedia:{id}"))
    }
    fn resolve(&self, handle: &str) -> Option<String> {
        let id = handle.strip_prefix("ffmedia:")?;
        self.registry.lookup(id)?;
        Some(self.proxy.as_ref()?.url_for(id))
    }
    fn validate(&self, url: &str) -> bool {
        let Some(proxy) = self.proxy.as_ref() else {
            return false;
        };
        let prefix = format!("{}/", proxy.base_url());
        url.strip_prefix(&prefix)
            .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit()))
            .and_then(|id| self.registry.lookup(id))
            .is_some()
    }
    fn health(&self) -> Value {
        let listening = self.proxy.as_ref().is_some_and(|p| {
            std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], p.port())),
                Duration::from_millis(250),
            )
            .is_ok()
        });
        json!({"available":listening,"epoch":self.epoch,"registrations":self.registry.len(),"transfers":self.proxy.as_ref().map(|proxy|proxy.metrics()).unwrap_or_default()})
    }
    fn prepare_probe(&self, url: &str) -> Result<PreparedMediaProbe, CoreError> {
        let Some(proxy) = self.proxy.as_ref() else {
            return Ok(PreparedMediaProbe::Immediate(
                json!({"kind":"local_listener","httpStatus":null,"retryable":true,"brokerEpoch":self.epoch}),
            ));
        };
        let prefix = format!("{}/", proxy.base_url());
        let id = url
            .strip_prefix(&prefix)
            .filter(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(CoreError::invalid)?;
        if self.registry.lookup(id).is_none() {
            return Ok(PreparedMediaProbe::Immediate(
                json!({"kind":"registration","httpStatus":404,"retryable":true,"brokerEpoch":self.epoch}),
            ));
        }
        let runtime = self.runtime.as_ref().ok_or_else(CoreError::unavailable)?;
        Ok(PreparedMediaProbe::Request(MediaProbeSnapshot {
            runtime: runtime.handle().clone(),
            client: self.probe_client.clone(),
            url: url.into(),
            epoch: self.epoch,
            registry_generation: self.registry.generation(),
        }))
    }
}
impl Drop for MediaBroker {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
struct Action {
    token: String,
    operation: String,
    target: String,
    generation: u64,
    preparation_request: String,
    preparation_deadline: u64,
    executing: bool,
}
struct EngineState {
    account: Option<Author>,
    generation: u64,
    revisions: HashMap<String, u64>,
    indices: HashMap<String, Vec<String>>,
    bookmark_complete: bool,
    resident: HashMap<String, usize>,
    lru: VecDeque<String>,
    payload_bytes: usize,
    action: Option<Action>,
    sequence: u64,
    media: MediaBroker,
}
/// The synchronous boundary is intentionally UI-agnostic. Swift executes it on
/// its off-main serial core executor. Media owns a dedicated Tokio runtime;
/// shutting down or restarting it aborts old socket/stream work.
pub struct CoreEngine {
    db: Db,
    durable: Durable,
    metadata: Metadata,
    state: Mutex<EngineState>,
    cancelled: Mutex<VecDeque<String>>,
    closed: AtomicBool,
}
impl CoreEngine {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self, CoreError> {
        let dir = data_dir.as_ref();
        std::fs::create_dir_all(dir).map_err(|_| CoreError::storage())?;
        let preferences = dir.join("preferences.db");
        backup_preferences(&preferences)?;
        let durable = Durable::open(&preferences)?;
        let metadata = Metadata::open(&dir.join("native-reader.db"))?;
        Ok(Self {
            db: Db::in_memory()?,
            durable,
            metadata,
            state: Mutex::new(EngineState {
                account: None,
                generation: 0,
                revisions: HashMap::new(),
                indices: HashMap::new(),
                bookmark_complete: false,
                resident: HashMap::new(),
                lru: VecDeque::new(),
                payload_bytes: 0,
                action: None,
                sequence: 0,
                media: MediaBroker::new(1)?,
            }),
            cancelled: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
        })
    }
    pub fn cancel_request(&self, request_id: &str) {
        if let Ok(mut queue) = self.cancelled.lock() {
            if queue.len() >= 1024 {
                queue.pop_front();
            }
            if !queue.iter().any(|id| id == request_id) {
                queue.push_back(request_id.into());
            }
        }
    }
    fn check(&self, request: &CoreRequest) -> Result<(), CoreError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(CoreError::unavailable());
        }
        if request.request_id.is_empty()
            || request.request_id.len() > 64
            || request.priority > 3
            || request.arguments_json.len() > MAX_INPUT_BYTES
        {
            return Err(CoreError::invalid());
        }
        if request.deadline_millis <= now()
            || self
                .cancelled
                .lock()
                .map_err(|_| CoreError::unavailable())?
                .iter()
                .any(|id| id == &request.request_id)
        {
            return Err(CoreError::cancelled());
        }
        Ok(())
    }
    pub fn execute(&self, request: CoreRequest) -> Result<String, CoreError> {
        self.check(&request)?;
        let args: Value =
            serde_json::from_str(&request.arguments_json).map_err(|_| CoreError::invalid())?;
        if !args.is_object() {
            return Err(CoreError::invalid());
        }
        if request.operation == CoreOperation::ProbeMedia {
            return serde_json::to_string(&self.probe_media(&request, &args)?)
                .map_err(|_| CoreError::invalid());
        }
        let mut state = self.state.lock().map_err(|_| CoreError::unavailable())?;
        self.check(&request)?;
        self.reap_cancelled_preparation(&mut state)?;
        if request.operation != CoreOperation::SetAccount
            && request.account_generation != state.generation
        {
            return Err(CoreError::stale());
        }
        let source = args
            .get("feed")
            .or_else(|| args.get("username"))
            .and_then(Value::as_str)
            .unwrap_or("session")
            .to_owned();
        if request.operation != CoreOperation::SetAccount
            && state
                .revisions
                .get(&source)
                .is_some_and(|revision| request.source_revision < *revision)
        {
            return Err(CoreError::stale());
        }
        let result = self.perform(&mut state, &request, &args)?;
        self.complete_request(&mut state, &request, result)
    }
    fn complete_request(
        &self,
        state: &mut EngineState,
        request: &CoreRequest,
        result: Value,
    ) -> Result<String, CoreError> {
        // Once an account transition committed, its generation must reach the
        // trusted Swift adapter even if the caller cancelled presentation. The
        // adapter serializes transitions and suppresses stale UI publication.
        if matches!(request.operation, CoreOperation::SetAccount | CoreOperation::ClearSession) {
            return serde_json::to_string(&result).map_err(|_| CoreError::invalid());
        }
        // State-changing methods check before their commit. A cancellation that
        // arrives after a successful commit suppresses presentation; it never
        // replays or claims to undo a committed account action.
        if let Err(error) = self.check(request) {
            // Preparation has not dispatched a provider write. Its token may
            // never reach Swift, so cancellation must release that reservation.
            // Executing actions remain owned until an explicit outcome settles.
            if request.operation == CoreOperation::PrepareAction {
                self.reap_cancelled_preparation(state)?;
            }
            return Err(error);
        }
        serde_json::to_string(&result).map_err(|_| CoreError::invalid())
    }
    fn reap_cancelled_preparation(&self, state: &mut EngineState) -> Result<(), CoreError> {
        if let Some(action) = state.action.as_ref().filter(|action| !action.executing) {
            let cancelled = action.preparation_deadline <= now()
                || self.cancelled.lock().map_err(|_| CoreError::unavailable())?
                    .iter().any(|id| id == &action.preparation_request);
            if cancelled { state.action = None; }
        }
        Ok(())
    }
    fn probe_media(&self, request: &CoreRequest, args: &Value) -> Result<Value, CoreError> {
        let prepared = {
            let state = self.state.lock().map_err(|_| CoreError::unavailable())?;
            self.check(request)?;
            if request.account_generation != state.generation {
                return Err(CoreError::stale());
            }
            state.media.prepare_probe(text(args, "url")?)?
        };
        match prepared {
            PreparedMediaProbe::Immediate(value) => {
                self.check(request)?;
                Ok(value)
            }
            PreparedMediaProbe::Request(snapshot) => {
                let epoch = snapshot.epoch;
                let registry_generation = snapshot.registry_generation;
                let result = snapshot.run(|| self.check(request))?;
                let state = self.state.lock().map_err(|_| CoreError::unavailable())?;
                self.check(request)?;
                if state.generation != request.account_generation
                    || state.media.epoch != epoch
                    || state.media.registry.generation() != registry_generation
                {
                    return Err(CoreError::stale());
                }
                Ok(result)
            }
        }
    }
    pub fn call_json(&self, operation: &str, payload_json: &str) -> Result<String, CoreError> {
        let operation: CoreOperation = serde_json::from_value(Value::String(operation.into()))
            .map_err(|_| CoreError::invalid())?;
        let (generation, sequence) = {
            let mut state = self.state.lock().map_err(|_| CoreError::unavailable())?;
            state.sequence = state.sequence.saturating_add(1);
            (state.generation, state.sequence)
        };
        self.execute(CoreRequest {
            request_id: format!("internal-{}-{sequence}", now()),
            account_generation: generation,
            source_revision: 0,
            deadline_millis: now() + 30000,
            priority: 1,
            operation,
            arguments_json: payload_json.into(),
        })
    }
    pub fn shutdown(&self) -> Result<(), CoreError> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let mut state = self.state.lock().map_err(|_| CoreError::unavailable())?;
        state.media.stop();
        self.db.clear_cache()?;
        state.indices.clear();
        state.resident.clear();
        state.payload_bytes = 0;
        Ok(())
    }
    fn account<'a>(&self, state: &'a EngineState) -> Result<&'a str, CoreError> {
        state
            .account
            .as_ref()
            .map(|a| a.id.as_str())
            .ok_or_else(|| CoreError {
                code: "not_authenticated".into(),
                message: "Connect an account before using this feature.".into(),
            })
    }
    fn perform(&self, s: &mut EngineState, r: &CoreRequest, a: &Value) -> Result<Value, CoreError> {
        use CoreOperation::*;
        match r.operation {
            ParseIdentity => {
                let author = provider_parser::authenticated_identity(
                    a.get("body").ok_or_else(CoreError::invalid)?,
                )?;
                Ok(json!(self.safe_author(s, &author)))
            }
            ParsePostContent => {
                self.account(s)?;
                let id = text(a, "postId")?;
                let body = a.get("body").ok_or_else(CoreError::invalid)?;
                let raw = body
                    .pointer("/data/tweetResult/result")
                    .ok_or_else(CoreError::invalid)?;
                let raw = raw.get("tweet").unwrap_or(raw);
                let post = provider_parser::parse_post(raw, false)
                    .filter(|p| p.id == id)
                    .ok_or_else(CoreError::invalid)?;
                self.check(r)?;
                self.cache_detail(s, &post)?;
                let mut article = crate::content::article(raw);
                if let Some(article) = article.as_mut() {
                    for block in &mut article.blocks {
                        if block.kind == "image" {
                            block.text = s
                                .media
                                .register(&block.text, &post.id, self.account(s)?)
                                .unwrap_or_default();
                        }
                    }
                }
                Ok(json!(PostContent {
                    post: self.safe_post(s, &post),
                    article
                }))
            }
            ParseReplies => {
                self.account(s)?;
                let id = text(a, "postId")?;
                let mut page = provider_parser::parse_replies(
                    a.get("body").ok_or_else(CoreError::invalid)?,
                    id,
                    a.get("first").and_then(Value::as_bool).unwrap_or(true),
                )?;
                self.check(r)?;
                for post in &page.posts {
                    self.cache_detail(s, post)?;
                }
                page.posts = page.posts.iter().map(|p| self.safe_post(s, p)).collect();
                Ok(json!(page))
            }
            SetAccount => {
                let account: Author = if let Some(body) = a.get("body") {
                    provider_parser::authenticated_identity(body)?
                } else {
                    decode(a.get("account").ok_or_else(CoreError::invalid)?)?
                };
                if account.id.is_empty()
                    || account.id.len() > 64
                    || crate::security::clean_screen_name(&account.username).is_none()
                {
                    return Err(CoreError::invalid());
                }
                if r.account_generation < s.generation
                    || (s.account.as_ref().map(|old| old.id.as_str()) != Some(account.id.as_str())
                        && r.account_generation <= s.generation)
                {
                    return Err(CoreError::stale());
                }
                if s.action.is_some() {
                    return Err(CoreError {
                        code: "action_in_flight".into(),
                        message: "Finish the current account action before changing accounts."
                            .into(),
                    });
                }
                self.check(r)?;
                if s.account.as_ref().map(|x| &x.id) != Some(&account.id)
                    || r.account_generation != s.generation
                {
                    self.db.clear_cache()?;
                    s.media.registry.invalidate_all();
                    s.indices.clear();
                    s.resident.clear();
                    s.lru.clear();
                    s.payload_bytes = 0;
                    s.revisions.clear();
                    s.action = None;
                    s.bookmark_complete = false;
                }
                self.check(r)?;
                self.db.upsert_author(&account)?;
                self.durable.set_identity(&AccountIdentity::from_author(
                    &account,
                    "ios-direct",
                    "connected",
                ))?;
                s.account = Some(account);
                s.generation = r.account_generation;
                Ok(
                    json!({"accountGeneration":s.generation,"account":self.safe_author(s,s.account.as_ref().unwrap())}),
                )
            }
            IngestFeed => {
                self.account(s)?;
                let feed = feed(a)?;
                let body = a.get("body").ok_or_else(CoreError::invalid)?;
                let page: FeedPage = if body.get("posts").is_some() {
                    decode(body)?
                } else {
                    provider_parser::parse_page(body)?
                };
                if page.posts.len() > 256 || page.cursor.as_ref().is_some_and(|c| c.len() > 4096) {
                    return Err(CoreError::invalid());
                }
                let costs: Vec<_> = page
                    .posts
                    .iter()
                    .map(|p| {
                        serde_json::to_vec(p)
                            .map(|v| (p.id.clone(), v.len()))
                            .map_err(|_| CoreError::invalid())
                    })
                    .collect::<Result<_, _>>()?;
                if costs.iter().map(|(_, cost)| cost).sum::<usize>() > PAYLOAD_BUDGET_BYTES {
                    return Err(CoreError {
                        code: "payload_too_large".into(),
                        message: "The provider page exceeded the reader's memory budget.".into(),
                    });
                }
                self.check(r)?;
                self.db.save_feed_page(&feed, &page)?;
                let prior = s.indices.entry(feed.clone()).or_default();
                let mut ids: Vec<String> = page.posts.iter().map(|p| p.id.clone()).collect();
                if a.get("append").and_then(Value::as_bool).unwrap_or(false) {
                    let known: HashSet<_> = prior.iter().cloned().collect();
                    prior.extend(ids.into_iter().filter(|id| !known.contains(id)));
                } else {
                    let incoming: HashSet<_> = ids.iter().cloned().collect();
                    ids.extend(prior.iter().filter(|id| !incoming.contains(*id)).cloned());
                    *prior = ids;
                }
                if feed == "bookmarks" {
                    self.db.record_bookmark_order(prior)?;
                    s.bookmark_complete = a
                        .get("complete")
                        .and_then(Value::as_bool)
                        .unwrap_or(page.cursor.is_none());
                }
                for (id, cost) in costs {
                    if let Some(old) = s.resident.insert(id.clone(), cost) {
                        s.payload_bytes = s.payload_bytes.saturating_sub(old);
                    }
                    s.payload_bytes += cost;
                    s.lru.retain(|key| key != &id);
                    s.lru.push_back(id);
                }
                self.enforce_budget(s)?;
                s.revisions.insert(feed.clone(), r.source_revision);
                // Ingestion returns the current provider page, not the entire
                // growing cache. Callers append this page once and request a
                // cache window explicitly when restoring an older position.
                let posts = self.db.filter_feed_page(page.posts, &filters(a)?, 80)?;
                let read_ids = self.db.read_ids_for_posts(&posts)?;
                Ok(json!(FeedView {
                    posts: posts.iter().map(|post| self.safe_post(s, post)).collect(),
                    read_ids,
                    next_cursor: page.cursor,
                    from_cache: false,
                    total_cached: s.indices.get(&feed).map_or(0, Vec::len),
                    missing_post_ids: vec![],
                    next_offset: None,
                    last_sync: Some(page.fetched_at),
                    provider: page.provider
                }))
            }
            IngestProfile => {
                self.account(s)?;
                let author = if let Some(author) = a.get("author") {
                    decode(author)?
                } else {
                    let body = a.get("body").ok_or_else(CoreError::invalid)?;
                    provider_parser::parse_author(
                        body.pointer("/data/user/result").unwrap_or(body),
                    )?
                };
                self.check(r)?;
                self.db.upsert_author(&author)?;
                Ok(serde_json::to_value(self.safe_author(s, &author))
                    .map_err(|_| CoreError::invalid())?)
            }
            IngestFollowing => {
                self.account(s)?;
                let accounts: Vec<Author> = if let Some(accounts) = a.get("accounts") {
                    decode(accounts)?
                } else {
                    let mut accounts = Vec::new();
                    let mut seen = HashSet::new();
                    provider_parser::walk(
                        a.get("body").ok_or_else(CoreError::invalid)?,
                        &mut |node| {
                            if let Ok(author) = provider_parser::parse_author(node) {
                                if seen.insert(author.id.clone()) {
                                    accounts.push(author);
                                }
                            }
                        },
                    );
                    accounts
                };
                if accounts.len() > 1000 {
                    return Err(CoreError::invalid());
                }
                self.check(r)?;
                self.db.merge_following_accounts(
                    &accounts,
                    a.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize,
                    a.get("syncId").and_then(Value::as_str).unwrap_or("native"),
                    a.get("complete").and_then(Value::as_bool).unwrap_or(false),
                )?;
                Ok(
                    json!({"accounts":accounts.iter().map(|p|self.safe_author(s,p)).collect::<Vec<_>>(),"total":self.db.following_count()?}),
                )
            }
            GetFeed => self.feed_value(
                s,
                &feed(a)?,
                filters(a)?,
                a.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize,
                limit(a),
                true,
            ),
            GetBookmarkSlice => {
                let request: BookmarkSliceRequest = decode(a.get("request").unwrap_or(a))?;
                let mut slice =
                    self.db
                        .load_bookmark_slice(&filters(a)?, &request, s.bookmark_complete)?;
                for post in &mut slice.posts {
                    *post = self.safe_post(s, post);
                }
                let missing = s
                    .indices
                    .get("bookmarks")
                    .into_iter()
                    .flatten()
                    .filter(|id| !s.resident.contains_key(*id))
                    .cloned()
                    .collect::<Vec<_>>();
                let mut value = serde_json::to_value(slice).map_err(|_| CoreError::invalid())?;
                value["totalDiscovered"] = json!(s.indices.get("bookmarks").map_or(0, Vec::len));
                value["missingPostIds"] = json!(missing.into_iter().take(80).collect::<Vec<_>>());
                Ok(value)
            }
            GetProfile => {
                let username = text(a, "username")?;
                let id = self.db.author_id_for_username(username)?;
                let author = id
                    .map(|id| self.db.authors_by_ids(&[id]))
                    .transpose()?
                    .and_then(|mut rows| rows.pop());
                Ok(json!(author.map(|p| self.safe_author(s, &p))))
            }
            GetFollowing => {
                let authors = self.db.following_accounts()?;
                let offset = a.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                Ok(
                    json!({"accounts":authors.iter().skip(offset).take(limit(a)).map(|p|self.safe_author(s,p)).collect::<Vec<_>>(),"total":authors.len()}),
                )
            }
            GetPost | RecoverMedia => {
                let id = a
                    .get("postId")
                    .or_else(|| a.get("id"))
                    .and_then(Value::as_str)
                    .ok_or_else(CoreError::invalid)?;
                match self.db.get_post(id)? {
                    Some(post) => Ok(json!(self.safe_post(s, &post))),
                    None => Ok(json!({"missingPostIds":[id]})),
                }
            }
            GetReadIds => Ok(json!(self.db.read_ids()?)),
            MarkRead => {
                let read = a.get("read").and_then(Value::as_bool).unwrap_or(true);
                let ids: Vec<String> = if let Some(ids) = a.get("postIds") {
                    decode(ids)?
                } else {
                    vec![text(a, "postId")?.into()]
                };
                if ids.len() > 256
                    || ids
                        .iter()
                        .any(|id| crate::security::clean_numeric_id(id).is_none())
                {
                    return Err(CoreError::invalid());
                }
                self.check(r)?;
                for id in ids {
                    self.db.set_read(&id, read)?;
                }
                Ok(json!({"updated":true}))
            }
            SetHidden => {
                let id = text(a, "postId")?;
                self.check(r)?;
                if a.get("hidden").and_then(Value::as_bool).unwrap_or(true) {
                    self.db.hide_post(id)?
                } else {
                    self.db.unhide_post(id)?
                }
                Ok(json!({"updated":true}))
            }
            GetPinnedAccounts => Ok(json!(self
                .db
                .pinned_accounts()?
                .iter()
                .map(|author| self.safe_author(s, author))
                .collect::<Vec<_>>())),
            PinAccount => {
                let id = text(a, "authorId")?;
                if self.db.authors_by_ids(&[id.to_string()])?.is_empty() {
                    return Err(CoreError::invalid());
                }
                self.check(r)?;
                self.db
                    .pin_account(id, a.get("pinned").and_then(Value::as_bool).unwrap_or(true))?;
                Ok(json!({"updated":true}))
            }
            GetMutedWords => Ok(json!(self.db.muted_words()?)),
            SetMutedWord => {
                let word = text(a, "word")?;
                if word.trim().is_empty() || word.len() > 200 {
                    return Err(CoreError::invalid());
                }
                self.check(r)?;
                self.db.set_muted_word(
                    word,
                    a.get("muted").and_then(Value::as_bool).unwrap_or(true),
                )?;
                Ok(json!({"updated":true}))
            }
            GetLists => Ok(json!(self.durable.account_lists(self.account(s)?)?)),
            GetGroupCandidates => {
                let account = self.account(s)?;
                let id = a
                    .get("groupId")
                    .or_else(|| a.get("listId"))
                    .and_then(Value::as_str)
                    .ok_or_else(CoreError::invalid)?;
                let list = self
                    .durable
                    .account_lists(account)?
                    .into_iter()
                    .find(|list| list.id == id)
                    .ok_or_else(CoreError::invalid)?;
                let members: HashSet<_> = list.member_ids.into_iter().collect();
                let followed = self.db.following_accounts()?;
                let following: HashSet<_> =
                    followed.iter().map(|author| author.id.clone()).collect();
                let mut authors = followed;
                let extras = members
                    .iter()
                    .filter(|id| !following.contains(*id))
                    .cloned()
                    .collect::<Vec<_>>();
                authors.extend(self.db.authors_by_ids(&extras)?);
                Ok(json!(authors.iter().map(|author|json!({"author":self.safe_author(s,author),"following":following.contains(&author.id),"member":members.contains(&author.id)})).collect::<Vec<_>>()))
            }
            GetGroupFeed => {
                let account = self.account(s)?;
                let id = text(a, "groupId")?;
                let list = self
                    .durable
                    .account_lists(account)?
                    .into_iter()
                    .find(|list| list.id == id)
                    .ok_or_else(CoreError::invalid)?;
                let all = self
                    .db
                    .group_timeline(&list.member_ids, &filters(a)?, i64::MAX)?;
                let offset = a
                    .get("offset")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(1_000_000) as usize;
                let limit = limit(a);
                let selected = all
                    .iter()
                    .skip(offset)
                    .take(limit)
                    .cloned()
                    .collect::<Vec<_>>();
                let read = self.db.read_ids_for_posts(&selected)?;
                Ok(
                    json!({"posts":selected.iter().map(|post|self.safe_post(s,post)).collect::<Vec<_>>(),"fromCache":true,"provider":"ios-direct","lastSync":null,"readIds":read,"totalCached":all.len(),"nextCursor":null,"failures":[],"nextOffset":(offset+selected.len()<all.len()).then_some(offset+selected.len()),"memberCount":list.member_ids.len(),"loadedAccounts":self.db.authors_by_ids(&list.member_ids)?.len()}),
                )
            }
            UpsertList => {
                let account = self.account(s)?;
                self.check(r)?;
                let id = text(a, "id")?;
                if id.len() > 64 {
                    return Err(CoreError::invalid());
                }
                self.durable.upsert_account_list(
                    account,
                    id,
                    text(a, "name")?,
                    a.get("color").and_then(Value::as_str).unwrap_or("#6366f1"),
                )?;
                Ok(json!(self.durable.account_lists(account)?))
            }
            DeleteList => {
                let account = self.account(s)?;
                self.check(r)?;
                self.durable.delete_account_list(account, text(a, "id")?)?;
                Ok(json!({"deleted":true}))
            }
            SetListMember => {
                let account = self.account(s)?;
                let member = a.get("member").and_then(Value::as_bool).unwrap_or(true);
                let author = text(a, "authorId")?;
                let list_id = text(a, "listId")?;
                if !self.durable.account_list_exists(account, list_id)? {
                    return Err(CoreError::invalid());
                }
                if member && !self.db.is_following(author)? {
                    return Err(CoreError {
                        code: "not_following".into(),
                        message: "Only accounts you follow can be added to a local list.".into(),
                    });
                }
                self.check(r)?;
                self.durable
                    .set_account_list_member(account, list_id, author, member)?;
                Ok(json!({"updated":true}))
            }
            GetPreferences => Ok(json!(self
                .durable
                .all_preferences()?
                .into_iter()
                .collect::<HashMap<_, _>>())),
            SetPreferences => {
                let values: HashMap<String, String> = decode(a.get("preferences").unwrap_or(a))?;
                let entries = values.into_iter().collect::<Vec<_>>();
                self.check(r)?;
                self.durable.set_preferences_batch(
                    &entries,
                    a.get("portable").and_then(Value::as_bool).unwrap_or(false),
                )?;
                Ok(json!({"updated":true}))
            }
            GetFilterPresets => Ok(json!(self.metadata.presets(self.account(s)?)?)),
            SetFilterPresets => {
                let presets: Vec<FilterPreset> =
                    decode(a.get("presets").ok_or_else(CoreError::invalid)?)?;
                self.check(r)?;
                self.metadata.set_presets(self.account(s)?, &presets)?;
                Ok(json!(presets))
            }
            GetResumeState => Ok(json!(self.metadata.resume(
                self.account(s)?,
                a.get("route").and_then(Value::as_str),
                now()
            )?)),
            SetResumeState => {
                let state: ResumeState = decode(a.get("state").ok_or_else(CoreError::invalid)?)?;
                self.check(r)?;
                self.metadata.set_resume(self.account(s)?, state, now())?;
                Ok(json!({"updated":true}))
            }
            PrepareAction => self.prepare_action(s, r, a),
            BeginAction => self.begin_action(s, r, a),
            FinishAction => self.finish_action(s, r, a),
            RegisterMedia => {
                let account = self.account(s)?;
                let url = text(a, "url")?;
                let registered = s
                    .media
                    .register(
                        url,
                        a.get("postId").and_then(Value::as_str).unwrap_or("account"),
                        account,
                    )
                    .ok_or_else(CoreError::invalid)?;
                Ok(json!({"handle":registered,"url":registered}))
            }
            GetMediaUrl | ValidateMediaUrl => {
                let url = a
                    .get("url")
                    .or_else(|| a.get("handle"))
                    .and_then(Value::as_str)
                    .ok_or_else(CoreError::invalid)?;
                let resolved = if r.operation == GetMediaUrl {
                    s.media.resolve(url)
                } else {
                    s.media.validate(url).then(|| url.to_string())
                };
                let Some(resolved) = resolved else {
                    return Err(CoreError {
                        code: "expired_media".into(),
                        message: "This media registration expired. Reload the item.".into(),
                    });
                };
                Ok(json!({"url":resolved,"valid":true}))
            }
            ProbeMedia => Err(CoreError::invalid()), // dispatched without the state lock in execute
            MediaHealth => {
                let mut health = s.media.health();
                if let Some(url) = a.get("url").and_then(Value::as_str) {
                    health["valid"] = json!(s.media.validate(url));
                }
                Ok(health)
            }
            RestartMedia => {
                let epoch = s.media.epoch + 1;
                s.media.stop();
                s.media = MediaBroker::new(epoch)?;
                Ok(s.media.health())
            }
            CancelMedia => {
                s.media.registry.invalidate_all();
                Ok(json!({"cancelled":true}))
            }
            Diagnostics => Ok(
                json!({"accountGeneration":s.generation,"payloadBytes":s.payload_bytes,"payloadBudgetBytes":PAYLOAD_BUDGET_BYTES,"residentPosts":s.resident.len(),"indexedPosts":s.indices.values().map(Vec::len).sum::<usize>(),"media":s.media.health(),"pendingAction":s.action.is_some(),"provider":"ios-direct","synthetic":false}),
            ),
            Search => {
                let query = text(a, "query")?;
                if query.len() > 512 {
                    return Err(CoreError::invalid());
                }
                let rows = self.db.search_cached_posts(
                    query,
                    a.get("offset").and_then(Value::as_i64).unwrap_or(0),
                    limit(a) as i64,
                )?;
                Ok(json!(rows
                    .iter()
                    .map(|p| self.safe_post(s, p))
                    .collect::<Vec<_>>()))
            }
            ClearSession => {
                if s.action.is_some() {
                    return Err(CoreError {
                        code: "action_in_flight".into(),
                        message:
                            "Finish the current account action before changing the connection."
                                .into(),
                    });
                }
                self.check(r)?;
                if a.get("disconnect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    if let Some(account) = s.account.as_ref() {
                        self.metadata.clear_resume(&account.id)?;
                    }
                    self.durable.clear_identity()?;
                }
                self.db.clear_cache()?;
                s.media.registry.invalidate_all();
                s.indices.clear();
                s.revisions.clear();
                s.resident.clear();
                s.lru.clear();
                s.payload_bytes = 0;
                s.action = None;
                s.account = None;
                s.bookmark_complete = false;
                s.generation = r.account_generation.saturating_add(1);
                Ok(json!({"accountGeneration":s.generation}))
            }
        }
    }
    fn cache_detail(&self, s: &mut EngineState, post: &Post) -> Result<(), CoreError> {
        let cost = serde_json::to_vec(post)
            .map_err(|_| CoreError::invalid())?
            .len();
        if cost > MAX_INPUT_BYTES {
            return Err(CoreError::invalid());
        }
        self.db.save_feed_page(
            "native-detail",
            &FeedPage {
                posts: vec![post.clone()],
                cursor: None,
                fetched_at: chrono::Utc::now().to_rfc3339(),
                provider: "ios-direct".into(),
                from_cache: false,
            },
        )?;
        if let Some(old) = s.resident.insert(post.id.clone(), cost) {
            s.payload_bytes = s.payload_bytes.saturating_sub(old);
        }
        s.payload_bytes += cost;
        s.lru.retain(|id| id != &post.id);
        s.lru.push_back(post.id.clone());
        self.enforce_budget(s)
    }
    fn enforce_budget(&self, s: &mut EngineState) -> Result<(), CoreError> {
        let mut evict = vec![];
        while s.payload_bytes > PAYLOAD_BUDGET_BYTES {
            let id = s.lru.pop_front().ok_or_else(CoreError::invalid)?;
            if let Some(cost) = s.resident.remove(&id) {
                s.payload_bytes = s.payload_bytes.saturating_sub(cost);
                evict.push(id);
            }
        }
        self.db.evict_native_payloads(&evict)?;
        Ok(())
    }
    fn feed_value(
        &self,
        s: &EngineState,
        feed: &str,
        filters: FeedFilters,
        offset: usize,
        limit: usize,
        cached: bool,
    ) -> Result<Value, CoreError> {
        let ids = s.indices.get(feed).map(Vec::as_slice).unwrap_or(&[]);
        let mut posts = vec![];
        let mut missing = vec![];
        for id in ids.iter().skip(offset).take(limit) {
            if let Some(post) = self.db.get_post(id)? {
                posts.push(post);
            } else {
                missing.push(id.clone());
            }
        }
        let posts = self.db.filter_feed_page(posts, &filters, limit as i64)?;
        let read_ids = self.db.read_ids_for_posts(&posts)?;
        let view = FeedView {
            posts: posts.iter().map(|p| self.safe_post(s, p)).collect(),
            read_ids,
            next_cursor: self.db.cursor(feed)?,
            from_cache: cached,
            total_cached: ids.len(),
            missing_post_ids: missing,
            next_offset: (offset + limit < ids.len()).then_some(offset + limit),
            last_sync: self.db.last_sync(feed)?,
            provider: "ios-direct".into(),
        };
        serde_json::to_value(view).map_err(|_| CoreError::invalid())
    }
    fn safe_author(&self, s: &EngineState, a: &Author) -> Author {
        let mut a = a.clone();
        let account = s.account.as_ref().map(|p| p.id.as_str()).unwrap_or("");
        a.avatar_url = a
            .avatar_url
            .as_deref()
            .and_then(|url| s.media.register(url, "account", account));
        a.banner_url = a
            .banner_url
            .as_deref()
            .and_then(|url| s.media.register(url, "account", account));
        a
    }
    fn safe_post(&self, s: &EngineState, p: &Post) -> Post {
        let mut p = p.clone();
        let account = s.account.as_ref().map(|a| a.id.as_str()).unwrap_or("");
        p.author = self.safe_author(s, &p.author);
        if let Some(author) = p.reposted_by.as_mut() {
            *author = self.safe_author(s, author);
        }
        rewrite_media(&s.media, &mut p.media, &p.id, account);
        if let Some(quote) = p.quoted.as_mut() {
            quote.author = self.safe_author(s, &quote.author);
            rewrite_media(&s.media, &mut quote.media, &quote.id, account);
        }
        p
    }
    fn prepare_action(
        &self,
        s: &mut EngineState,
        r: &CoreRequest,
        a: &Value,
    ) -> Result<Value, CoreError> {
        self.account(s)?;
        if s.action.is_some() {
            return Err(CoreError {
                code: "action_in_flight".into(),
                message: "Wait for the current account action to finish.".into(),
            });
        }
        let operation = text(a, "operation")?;
        let confirmed = a.get("confirmed").and_then(Value::as_bool).unwrap_or(false);
        let target = match operation {
            "follow" | "unfollow" => {
                if !self.durable.allow_unfollow() {
                    return Err(CoreError {
                        code: "blocked_operation".into(),
                        message: "Account actions are disabled in Settings.".into(),
                    });
                }
                if operation == "unfollow" && !confirmed {
                    return Err(CoreError {
                        code: "confirmation_required".into(),
                        message: "Confirm unfollowing this account first.".into(),
                    });
                }
                crate::security::clean_screen_name(text(a, "username")?)
                    .ok_or_else(CoreError::invalid)?
            }
            "unbookmark" | "delete_bookmark" => {
                if !confirmed {
                    return Err(CoreError {
                        code: "confirmation_required".into(),
                        message: "Confirm removal of this bookmark first.".into(),
                    });
                }
                let id = text(a, "postId")?;
                if crate::security::clean_numeric_id(id).is_none()
                    || !s
                        .indices
                        .get("bookmarks")
                        .is_some_and(|ids| ids.iter().any(|known| known == id))
                {
                    return Err(CoreError {
                        code: "not_bookmarked".into(),
                        message: "This post is not in the current account's discovered bookmarks."
                            .into(),
                    });
                }
                id.into()
            }
            _ => {
                return Err(CoreError {
                    code: "blocked_operation".into(),
                    message: "This account action is unavailable.".into(),
                })
            }
        };
        self.check(r)?;
        s.sequence += 1;
        let token = format!("{}-{}", s.generation, s.sequence);
        s.action = Some(Action {
            token: token.clone(),
            operation: operation.into(),
            target: target.clone(),
            generation: s.generation,
            preparation_request: r.request_id.clone(),
            preparation_deadline: r.deadline_millis,
            executing: false,
        });
        Ok(json!({"token":token,"operation":operation,"target":target,"automaticRetry":false}))
    }
    fn begin_action(&self, s: &mut EngineState, r: &CoreRequest, a: &Value) -> Result<Value, CoreError> {
        let token = text(a, "token")?;
        let action = s.action.as_mut()
            .filter(|pending| pending.token == token && pending.generation == s.generation)
            .ok_or_else(CoreError::stale)?;
        if action.executing {
            return Err(CoreError {
                code: "action_already_started".into(),
                message: "This account action has already been dispatched.".into(),
            });
        }
        self.check(r)?;
        action.executing = true;
        Ok(json!({"token":token,"operation":action.operation,"automaticRetry":false}))
    }
    fn finish_action(
        &self,
        s: &mut EngineState,
        r: &CoreRequest,
        a: &Value,
    ) -> Result<Value, CoreError> {
        let token = text(a, "token")?;
        let action = s
            .action
            .as_ref()
            .filter(|pending| pending.token == token && pending.generation == s.generation)
            .cloned()
            .ok_or_else(CoreError::stale)?;
        let outcome = text(a, "outcome")?;
        if !["succeeded", "failed", "uncertain"].contains(&outcome) {
            return Err(CoreError::invalid());
        }
        if outcome == "succeeded" && !action.executing {
            return Err(CoreError::invalid());
        }
        self.check(r)?;
        if outcome == "succeeded" {
            if ["unbookmark", "delete_bookmark"].contains(&action.operation.as_str()) {
                self.db.remove_bookmark(&action.target)?;
                if let Some(ids) = s.indices.get_mut("bookmarks") {
                    ids.retain(|id| id != &action.target);
                }
            } else {
                self.db
                    .set_following_by_username(&action.target, action.operation == "follow")?;
            }
        }
        s.action = None;
        Ok(
            json!({"outcome":outcome,"requiresReconciliation":outcome=="uncertain","automaticRetry":false}),
        )
    }
}
impl Drop for CoreEngine {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, CoreError> {
    serde_json::from_value(value.clone()).map_err(|_| CoreError::invalid())
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, CoreError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(CoreError::invalid)
}
fn feed(value: &Value) -> Result<String, CoreError> {
    let feed = text(value, "feed")?;
    if feed.len() > 160
        || !(matches!(
            feed,
            "following" | "focus" | "for-you" | "originals" | "bookmarks"
        ) || feed.starts_with("user:")
            || feed.starts_with("list:")
            || feed.starts_with("group:"))
    {
        return Err(CoreError::invalid());
    }
    Ok(feed.into())
}
fn filters(value: &Value) -> Result<FeedFilters, CoreError> {
    value
        .get("filters")
        .map(decode)
        .unwrap_or_else(|| Ok(FeedFilters::default()))
}
fn limit(value: &Value) -> usize {
    value
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .clamp(1, 80) as usize
}
fn rewrite_media(broker: &MediaBroker, media: &mut [PostMedia], id: &str, account: &str) {
    for item in media {
        item.url = broker.register(&item.url, id, account).unwrap_or_default();
        item.preview_url = item
            .preview_url
            .as_deref()
            .and_then(|url| broker.register(url, id, account));
        item.variants.retain_mut(|variant| {
            if let Some(url) = broker.register(&variant.url, id, account) {
                variant.url = url;
                true
            } else {
                false
            }
        });
    }
}

fn classify_probe(status: u16, origin: Option<&str>, epoch: u64) -> Value {
    let kind = if (200..300).contains(&status) {
        "ready"
    } else {
        match origin {
            Some("local_queue") => "local_queue",
            Some("registration") => "registration",
            Some("upstream_network") => "upstream_network",
            Some("upstream_http") => "upstream_http",
            _ if status == 404 => "registration",
            _ => "local_listener",
        }
    };
    let retryable = match kind {
        "ready" => false,
        "upstream_http" => matches!(status, 403 | 410 | 416 | 500 | 502 | 503 | 504),
        _ => true,
    };
    json!({"kind":kind,"httpStatus":status,"retryable":retryable,"brokerEpoch":epoch})
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    #[test]
    fn committed_account_transitions_acknowledge_their_generation_after_late_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let core = CoreEngine::open(directory.path()).unwrap();
        let mut state = core.state.lock().unwrap();
        for (operation, generation, args, expected_generation) in [
            (CoreOperation::SetAccount, 1, json!({"account":{"id":"1","username":"fixture","displayName":"Fixture"}}), 1),
            (CoreOperation::ClearSession, 1, json!({"disconnect":true}), 2),
        ] {
            let request = CoreRequest {
                request_id: format!("late-cancel-{expected_generation}"), account_generation: generation,
                source_revision: 0, deadline_millis: now() + 30_000, priority: 1,
                operation, arguments_json: args.to_string(),
            };
            let committed = core.perform(&mut state, &request, &args).unwrap();
            // Force the exact completion race instead of relying on timing.
            core.cancel_request(&request.request_id);
            let acknowledgement: Value = serde_json::from_str(
                &core.complete_request(&mut state, &request, committed).unwrap()
            ).unwrap();
            assert_eq!(acknowledgement["accountGeneration"], expected_generation);
            assert_eq!(state.generation, expected_generation);
        }
        let read = CoreRequest {
            request_id: "late-cancel-read".into(), account_generation: 2,
            source_revision: 0, deadline_millis: now() + 30_000, priority: 1,
            operation: CoreOperation::GetPreferences, arguments_json: "{}".into(),
        };
        let result = core.perform(&mut state, &read, &json!({})).unwrap();
        core.cancel_request(&read.request_id);
        assert_eq!(core.complete_request(&mut state, &read, result).unwrap_err().code, "cancelled");
    }

    #[test]
    fn an_expired_reservation_is_reaped_but_an_executing_action_is_never_reaped() {
        let directory = tempfile::tempdir().unwrap();
        let core = CoreEngine::open(directory.path()).unwrap();
        for executing in [false, true] {
            core.state.lock().unwrap().action = Some(Action {
                token: "fixture".into(), operation: "follow".into(), target: "reader".into(),
                generation: 0, preparation_request: "expired-preparation".into(),
                preparation_deadline: 0, executing,
            });
            let diagnostic: Value = serde_json::from_str(&core.execute(CoreRequest {
                request_id: format!("phase-{executing}"), account_generation: 0,
                source_revision: 0, deadline_millis: now() + 30_000, priority: 1,
                operation: CoreOperation::Diagnostics, arguments_json: "{}".into(),
            }).unwrap()).unwrap();
            assert_eq!(diagnostic["pendingAction"], executing);
        }
    }

    #[test]
    fn identical_http_status_retains_authoritative_failure_provenance() {
        let local = classify_probe(429, Some("local_queue"), 1);
        let upstream = classify_probe(429, Some("upstream_http"), 1);
        assert_eq!(local["kind"], "local_queue");
        assert_eq!(local["retryable"], true);
        assert_eq!(upstream["kind"], "upstream_http");
        assert_eq!(upstream["retryable"], false);
        assert_eq!(
            classify_probe(200, Some("upstream_http"), 1)["kind"],
            "ready"
        );
    }

    #[test]
    fn a_stalled_probe_does_not_hold_the_engine_lock_and_cancellation_stops_it() {
        use std::io::Read;
        use std::net::TcpListener;
        use std::sync::mpsc;
        use std::time::Instant;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let upstream = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            started_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(4));
        });
        let directory = tempfile::tempdir().unwrap();
        let core = Arc::new(CoreEngine::open(directory.path()).unwrap());
        let (handle, url) = {
            let mut state = core.state.lock().unwrap();
            state.media.stop();
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            let registry = Arc::new(MediaRegistry::new());
            let prefix = format!("http://127.0.0.1:{port}");
            let id = registry.register_for_test(&format!("{prefix}/stalled"));
            let proxy = runtime
                .block_on(MediaProxy::start_with_test_upstream(
                    registry.clone(),
                    prefix,
                ))
                .unwrap();
            let url = proxy.url_for(&id);
            state.media = MediaBroker {
                runtime: Some(runtime),
                proxy: Some(proxy),
                registry,
                epoch: 2,
                probe_client: reqwest::Client::builder()
                    .timeout(Duration::from_secs(8))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap(),
            };
            (format!("ffmedia:{id}"), url)
        };
        let make_request = |operation, args: Value, id: &str| CoreRequest {
            request_id: id.into(),
            account_generation: 0,
            source_revision: 0,
            deadline_millis: now() + 30_000,
            priority: 1,
            operation,
            arguments_json: args.to_string(),
        };
        let probe_request = make_request(
            CoreOperation::ProbeMedia,
            json!({"url":url}),
            "stalled-probe",
        );
        let reader = core.clone();
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let probe = std::thread::spawn(move || {
            let _ = result_tx.send(reader.execute(probe_request));
        });
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the real probe did not reach its fixture upstream");
        let before = Instant::now();
        let resolved = core
            .execute(make_request(
                CoreOperation::GetMediaUrl,
                json!({"handle":handle}),
                "resolve-while-probing",
            ))
            .unwrap();
        assert!(resolved.contains("127.0.0.1"));
        core.execute(make_request(
            CoreOperation::GetFeed,
            json!({"feed":"following"}),
            "page-while-probing",
        ))
        .unwrap();
        assert!(
            before.elapsed() < Duration::from_secs(1),
            "a media probe blocked unrelated reader work"
        );
        core.cancel_request("stalled-probe");
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("cancelled probe did not settle")
                .unwrap_err()
                .code,
            "cancelled"
        );
        let _ = release_tx.send(());
        probe.join().unwrap();
        upstream.join().unwrap();
    }
}
