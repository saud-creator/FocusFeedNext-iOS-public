//! Paired Windows-to-iPhone provider bridge.
//!
//! iOS cannot execute `twitter-cli`: Apple applications cannot spawn the
//! Python command-line process that the Windows build uses.  The mobile build
//! therefore implements the same [`XDataProvider`] trait by calling a narrow,
//! read-only provider endpoint on the user's running Windows app.
//!
//! The X cookies never cross the network.  The host invokes the already
//! configured provider and returns only the stable models from `models.rs`.
//! Pairing exchanges an eight-digit, one-use code for a random bearer token;
//! the iPhone stores that token in Keychain through the existing credential
//! store abstraction.

use crate::commands::AppState;
use crate::credentials::{CredentialStore, XCredentials};
use crate::models::*;
use crate::providers::{ProviderCapabilities, XDataProvider};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const PAIR_FAILURE_LIMIT: u8 = 5;
const PAIR_BLOCK_TIME: Duration = Duration::from_secs(30);
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(150);

/// Safe information displayed by the Windows Settings page.
///
/// The bearer token is deliberately absent.  The short pairing code is meant
/// to be copied to the phone and rotates after every successful exchange.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionHostStatus {
    pub running: bool,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub pairing_code: Option<String>,
    #[serde(default)]
    pub paired_once: bool,
}

impl CompanionHostStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            address: None,
            port: None,
            pairing_code: None,
            paired_once: false,
        }
    }
}

/// Owns the optional LAN listener in the Windows process.
pub struct CompanionHost {
    server: Mutex<Option<CompanionServer>>,
    starting: AtomicBool,
}

impl Default for CompanionHost {
    fn default() -> Self {
        Self {
            server: Mutex::new(None),
            starting: AtomicBool::new(false),
        }
    }
}

impl CompanionHost {
    pub fn status(&self) -> CompanionHostStatus {
        self.server
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(CompanionServer::status))
            .unwrap_or_else(CompanionHostStatus::stopped)
    }

    /// Start the read-only provider bridge on an OS-selected port.
    pub async fn start(&self, state: Weak<AppState>) -> AppResult<CompanionHostStatus> {
        if cfg!(mobile) {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                "an iPhone cannot host the Windows companion service",
            ));
        }
        if self.status().running {
            return Ok(self.status());
        }
        if self
            .starting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                "the iPhone companion service is already starting",
            ));
        }
        let _starting = StartingGuard(&self.starting);

        let advertised_ip = local_lan_ip().ok_or_else(|| {
            AppError::new(
                ErrorCode::NetworkUnavailable,
                "no private local-network address is available for the iPhone companion",
            )
            .with_repair(
                "Connect Windows to the same private Wi-Fi network as the iPhone, then try again.",
            )
        })?;
        // Bind only the exact private interface advertised to the phone. This
        // keeps the listener off unrelated adapters instead of accepting on
        // every IPv4 interface through 0.0.0.0.
        let listener = tokio::net::TcpListener::bind(SocketAddr::new(advertised_ip, 0))
            .await
            .map_err(|e| {
                AppError::new(
                    ErrorCode::NetworkUnavailable,
                    format!("could not open the iPhone companion port: {e}"),
                )
                .with_repair("Allow Focus Feed Next through Windows Firewall, then try again.")
            })?;
        let port = listener
            .local_addr()
            .map_err(|e| {
                AppError::new(
                    ErrorCode::NetworkUnavailable,
                    format!("the iPhone companion port has no local address: {e}"),
                )
            })?
            .port();

        let token = random_hex(32)?;
        let context = Arc::new(CompanionContext {
            state,
            token,
            pairing_code: Mutex::new(random_pair_code()?),
            paired_once: AtomicBool::new(false),
            throttle: Mutex::new(PairThrottle::new()),
        });
        let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let accept_context = Arc::clone(&context);

        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    biased;
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((stream, _peer)) = accepted else {
                    continue;
                };
                let context = Arc::clone(&accept_context);
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        let context = Arc::clone(&context);
                        async move {
                            Ok::<_, std::convert::Infallible>(
                                handle_request(request, context).await,
                            )
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });

        let server = CompanionServer {
            port,
            advertised_ip: Some(advertised_ip),
            context,
            shutdown: Some(shutdown),
        };
        let status = server.status();
        let mut guard = self.server.lock().map_err(|_| {
            AppError::new(
                ErrorCode::ProviderUnavailable,
                "the companion service state is unavailable",
            )
        })?;
        if guard.is_some() {
            return Ok(guard.as_ref().expect("checked above").status());
        }
        *guard = Some(server);
        log::info!("iPhone companion listening on LAN port {port}");
        Ok(status)
    }

    pub fn stop(&self) -> CompanionHostStatus {
        if let Ok(mut guard) = self.server.lock() {
            if let Some(mut server) = guard.take() {
                server.shutdown();
            }
        }
        CompanionHostStatus::stopped()
    }
}

struct StartingGuard<'a>(&'a AtomicBool);

impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct CompanionServer {
    port: u16,
    advertised_ip: Option<IpAddr>,
    context: Arc<CompanionContext>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl CompanionServer {
    fn status(&self) -> CompanionHostStatus {
        CompanionHostStatus {
            running: true,
            address: self
                .advertised_ip
                .map(|ip| format!("http://{ip}:{}", self.port)),
            port: Some(self.port),
            pairing_code: self.context.pairing_code.lock().ok().map(|v| v.clone()),
            paired_once: self.context.paired_once.load(Ordering::SeqCst),
        }
    }

    fn shutdown(&mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
            log::info!("iPhone companion stopped");
        }
    }
}

impl Drop for CompanionServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct CompanionContext {
    state: Weak<AppState>,
    token: String,
    pairing_code: Mutex<String>,
    paired_once: AtomicBool,
    throttle: Mutex<PairThrottle>,
}

struct PairThrottle {
    window_started: Instant,
    failures: u8,
    blocked_until: Option<Instant>,
}

impl PairThrottle {
    fn new() -> Self {
        Self {
            window_started: Instant::now(),
            failures: 0,
            blocked_until: None,
        }
    }

    fn permit(&mut self) -> bool {
        let now = Instant::now();
        if self.blocked_until.is_some_and(|until| until > now) {
            return false;
        }
        if now.duration_since(self.window_started) >= Duration::from_secs(60) {
            self.window_started = now;
            self.failures = 0;
            self.blocked_until = None;
        }
        true
    }

    fn failed(&mut self) {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= PAIR_FAILURE_LIMIT {
            self.blocked_until = Some(Instant::now() + PAIR_BLOCK_TIME);
        }
    }

    fn succeeded(&mut self) {
        self.window_started = Instant::now();
        self.failures = 0;
        self.blocked_until = None;
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRequest {
    op: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    ok: bool,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<AppError>,
}

impl BridgeResponse {
    fn success<T: Serialize>(value: T) -> Self {
        match serde_json::to_value(value) {
            Ok(data) => Self {
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => Self::failure(AppError::new(
                ErrorCode::InvalidJson,
                format!("could not encode companion response: {error}"),
            )),
        }
    }

    fn failure(error: AppError) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(error),
        }
    }
}

async fn handle_request(
    request: Request<Incoming>,
    context: Arc<CompanionContext>,
) -> Response<Full<Bytes>> {
    if request.method() != Method::POST {
        return json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            BridgeResponse::failure(AppError::new(
                ErrorCode::BlockedOperation,
                "the companion bridge accepts POST requests only",
            )),
        );
    }
    let path = request.uri().path().to_string();
    if path != "/v1/pair" && path != "/v1/provider" {
        return json_response(
            StatusCode::NOT_FOUND,
            BridgeResponse::failure(AppError::new(
                ErrorCode::BlockedOperation,
                "the companion route does not exist",
            )),
        );
    }

    let authorized = if path == "/v1/provider" {
        request
            .headers()
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|value| constant_time_eq(value.as_bytes(), context.token.as_bytes()))
    } else {
        true
    };
    if !authorized {
        return json_response(
            StatusCode::UNAUTHORIZED,
            BridgeResponse::failure(
                AppError::new(
                    ErrorCode::NotAuthenticated,
                    "the iPhone companion token was not accepted",
                )
                .with_repair("Pair the iPhone with the current Windows session again."),
            ),
        );
    }

    let body = match limited_body(request.into_body()).await {
        Ok(body) => body,
        Err(response) => return response,
    };

    if path == "/v1/pair" {
        let request: PairRequest = match serde_json::from_slice(&body) {
            Ok(request) => request,
            Err(_) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    BridgeResponse::failure(AppError::new(
                        ErrorCode::InvalidJson,
                        "the pairing request was not valid JSON",
                    )),
                )
            }
        };
        return pair_response(&context, request);
    }

    let request: ProviderRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                BridgeResponse::failure(AppError::new(
                    ErrorCode::InvalidJson,
                    "the provider request was not valid JSON",
                )),
            )
        }
    };
    let Some(state) = context.state.upgrade() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            BridgeResponse::failure(AppError::new(
                ErrorCode::ProviderUnavailable,
                "the Windows application is shutting down",
            )),
        );
    };
    let result = tokio::task::spawn_blocking(move || dispatch_provider(&state, request)).await;
    match result {
        Ok(Ok(value)) => json_response(StatusCode::OK, BridgeResponse::success(value)),
        Ok(Err(error)) => json_response(StatusCode::OK, BridgeResponse::failure(error)),
        Err(error) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            BridgeResponse::failure(AppError::new(
                ErrorCode::ProviderUnavailable,
                format!("the provider task did not complete: {error}"),
            )),
        ),
    }
}

fn pair_response(context: &CompanionContext, request: PairRequest) -> Response<Full<Bytes>> {
    let mut throttle = match context.throttle.lock() {
        Ok(throttle) => throttle,
        Err(_) => {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                BridgeResponse::failure(AppError::new(
                    ErrorCode::ProviderUnavailable,
                    "the pairing guard is unavailable",
                )),
            )
        }
    };
    if !throttle.permit() {
        return json_response(
            StatusCode::TOO_MANY_REQUESTS,
            BridgeResponse::failure(
                AppError::new(
                    ErrorCode::RateLimited,
                    "too many incorrect pairing attempts",
                )
                .with_repair("Wait 30 seconds, then use the current code shown on Windows."),
            ),
        );
    }
    let accepted = context
        .pairing_code
        .lock()
        .ok()
        .is_some_and(|code| constant_time_eq(code.as_bytes(), request.code.trim().as_bytes()));
    if !accepted {
        throttle.failed();
        return json_response(
            StatusCode::UNAUTHORIZED,
            BridgeResponse::failure(
                AppError::new(
                    ErrorCode::NotAuthenticated,
                    "the pairing code was not accepted",
                )
                .with_repair("Enter the eight-digit code currently shown by the Windows app."),
            ),
        );
    }

    throttle.succeeded();
    context.paired_once.store(true, Ordering::SeqCst);
    if let Ok(mut code) = context.pairing_code.lock() {
        if let Ok(next) = random_pair_code() {
            *code = next;
        }
    }
    json_response(
        StatusCode::OK,
        BridgeResponse::success(json!({ "token": context.token })),
    )
}

async fn limited_body(mut body: Incoming) -> Result<Vec<u8>, Response<Full<Bytes>>> {
    let mut output = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| {
            json_response(
                StatusCode::BAD_REQUEST,
                BridgeResponse::failure(AppError::new(
                    ErrorCode::InvalidJson,
                    "the companion request body could not be read",
                )),
            )
        })?;
        if let Some(data) = frame.data_ref() {
            if output.len().saturating_add(data.len()) > MAX_REQUEST_BYTES {
                return Err(json_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    BridgeResponse::failure(AppError::new(
                        ErrorCode::BlockedOperation,
                        "the companion request was too large",
                    )),
                ));
            }
            output.extend_from_slice(data);
        }
    }
    Ok(output)
}

fn json_response(status: StatusCode, payload: BridgeResponse) -> Response<Full<Bytes>> {
    let encoded = serde_json::to_vec(&payload).unwrap_or_else(|_| {
        br#"{"ok":false,"error":{"code":"invalid_json","message":"response encoding failed"}}"#
            .to_vec()
    });
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Full::new(Bytes::from(encoded)))
        .expect("fixed companion response headers are valid")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedArgs {
    max: u32,
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserArgs {
    username: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserFeedArgs {
    username: String,
    max: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListArgs {
    list_id: String,
    max: u32,
    #[serde(default)]
    cursor: Option<String>,
}

fn args<T: DeserializeOwned>(value: Value) -> AppResult<T> {
    serde_json::from_value(value).map_err(|_| {
        AppError::new(
            ErrorCode::InvalidJson,
            "the iPhone companion request arguments were invalid",
        )
    })
}

fn dispatch_provider(state: &AppState, request: ProviderRequest) -> AppResult<Value> {
    let provider = state.provider.lock().map_err(|_| {
        AppError::new(
            ErrorCode::ProviderUnavailable,
            "the Windows provider is unavailable",
        )
    })?;
    let value = match request.op.as_str() {
        "capabilities" => serde_json::to_value(provider.capabilities()),
        "status" => serde_json::to_value(provider.status()?),
        "current_user" => serde_json::to_value(provider.get_current_user()?),
        "following_feed" => {
            let value: FeedArgs = args(request.args)?;
            serde_json::to_value(provider.get_following_feed(value.max, value.cursor)?)
        }
        "for_you_feed" => {
            let value: FeedArgs = args(request.args)?;
            serde_json::to_value(provider.get_for_you_feed(value.max, value.cursor)?)
        }
        "user_profile" => {
            let value: UserArgs = args(request.args)?;
            serde_json::to_value(provider.get_user_profile(&value.username)?)
        }
        "user_posts" => {
            let value: UserFeedArgs = args(request.args)?;
            serde_json::to_value(provider.get_user_posts(&value.username, value.max)?)
        }
        "following_accounts" => {
            let value: UserFeedArgs = args(request.args)?;
            serde_json::to_value(provider.get_following_accounts(&value.username, value.max)?)
        }
        "bookmarks" => {
            let value: FeedArgs = args(request.args)?;
            serde_json::to_value(provider.get_bookmarks(value.max)?)
        }
        "list_timeline" => {
            let value: ListArgs = args(request.args)?;
            serde_json::to_value(provider.get_list_timeline_page(
                &value.list_id,
                value.max,
                value.cursor,
            )?)
        }
        _ => {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                "that operation is not exposed to the iPhone companion",
            ))
        }
    };
    value.map_err(|error| {
        AppError::new(
            ErrorCode::InvalidJson,
            format!("could not encode the provider result: {error}"),
        )
    })
}

/// Mobile implementation of the existing provider interface.
pub struct RemoteProvider {
    store: Arc<dyn CredentialStore>,
    client: Option<reqwest::blocking::Client>,
}

impl RemoteProvider {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(PROVIDER_TIMEOUT)
            .build()
            .ok();
        Self { store, client }
    }

    /// Exchange the visible one-use code for the bearer token that is stored
    /// in iOS Keychain.  The X cookies remain on Windows.
    pub fn pair(address: &str, code: &str) -> AppResult<XCredentials> {
        let base = normalize_base_url(address)?;
        let code = code.trim();
        if code.len() != 8 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(AppError::new(
                ErrorCode::NotAuthenticated,
                "the pairing code must contain exactly eight digits",
            ));
        }
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| network_error("could not create the pairing client", error))?;
        let response = client
            .post(format!("{base}/v1/pair"))
            .json(&json!({ "code": code }))
            .send()
            .map_err(|error| network_error("could not reach the Windows companion", error))?;
        let bridge: BridgeResponse = response.json().map_err(|_| {
            AppError::new(
                ErrorCode::InvalidJson,
                "the Windows companion returned an unreadable pairing response",
            )
        })?;
        let data = bridge_result(bridge)?;
        let token = data
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::InvalidJson,
                    "the Windows companion returned an invalid token",
                )
            })?
            .to_string();
        Ok(XCredentials {
            auth_token: token,
            ct0: base,
        })
    }

    fn config(&self) -> AppResult<XCredentials> {
        self.store.load()?.ok_or_else(|| {
            AppError::new(
                ErrorCode::NotAuthenticated,
                "this iPhone is not paired with a Windows app",
            )
            .with_repair("Open Settings and pair with the code shown on Windows.")
        })
    }

    fn rpc<A: Serialize, T: DeserializeOwned>(&self, op: &str, arguments: A) -> AppResult<T> {
        let config = self.config()?;
        let base = normalize_base_url(&config.ct0)?;
        if config.auth_token.len() != 64
            || !config
                .auth_token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(AppError::new(
                ErrorCode::NotAuthenticated,
                "the stored iPhone companion token is invalid",
            )
            .with_repair("Pair the iPhone with Windows again."));
        }
        let client = self.client.as_ref().ok_or_else(|| {
            AppError::new(
                ErrorCode::NetworkUnavailable,
                "the iPhone network client could not be created",
            )
        })?;
        let response = client
            .post(format!("{base}/v1/provider"))
            .bearer_auth(&config.auth_token)
            .json(&ProviderRequest {
                op: op.to_string(),
                args: serde_json::to_value(arguments).map_err(|_| {
                    AppError::new(
                        ErrorCode::InvalidJson,
                        "the provider request could not be encoded",
                    )
                })?,
            })
            .send()
            .map_err(|error| network_error("the Windows companion is unreachable", error))?;
        let bridge: BridgeResponse = response.json().map_err(|_| {
            AppError::new(
                ErrorCode::InvalidJson,
                "the Windows companion returned unreadable provider data",
            )
        })?;
        serde_json::from_value(bridge_result(bridge)?).map_err(|_| {
            AppError::new(
                ErrorCode::SchemaChanged,
                "the Windows and iPhone provider models do not match",
            )
            .with_repair("Update both the Windows and iPhone apps to the same version.")
        })
    }
}

fn bridge_result(response: BridgeResponse) -> AppResult<Value> {
    if response.ok {
        response.data.ok_or_else(|| {
            AppError::new(
                ErrorCode::EmptyResponse,
                "the Windows companion returned no data",
            )
        })
    } else {
        Err(response.error.unwrap_or_else(|| {
            AppError::new(
                ErrorCode::ProviderUnavailable,
                "the Windows companion reported an unknown failure",
            )
        }))
    }
}

fn network_error(context: &str, error: reqwest::Error) -> AppError {
    let detail = if error.is_timeout() {
        "request timed out"
    } else if error.is_connect() {
        "connection failed"
    } else {
        "network request failed"
    };
    AppError::new(
        ErrorCode::NetworkUnavailable,
        format!("{context}: {detail}"),
    )
    .with_repair("Keep both devices on the same Wi-Fi network and leave the Windows app open.")
}

impl XDataProvider for RemoteProvider {
    fn name(&self) -> &'static str {
        "iphone-companion"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        let mut capabilities = self
            .rpc("capabilities", json!({}))
            .unwrap_or_else(|_| ProviderCapabilities::none());
        // The companion endpoint is deliberately read-only even when the
        // Windows provider can write.  Do not let shared UI surface an action
        // that the transport will (correctly) refuse.
        capabilities.follow = false;
        capabilities.unfollow = false;
        capabilities.unbookmark = false;
        capabilities.mute = false;
        capabilities.block = false;
        capabilities
    }

    fn get_following_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        self.rpc("following_feed", json!({ "max": max, "cursor": cursor }))
    }

    fn get_for_you_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        self.rpc("for_you_feed", json!({ "max": max, "cursor": cursor }))
    }

    fn get_user_profile(&self, username: &str) -> AppResult<Author> {
        self.rpc("user_profile", json!({ "username": username }))
    }

    fn get_user_posts(&self, username: &str, max: u32) -> AppResult<FeedPage> {
        self.rpc("user_posts", json!({ "username": username, "max": max }))
    }

    fn get_following_accounts(&self, username: &str, max: u32) -> AppResult<Vec<Author>> {
        self.rpc(
            "following_accounts",
            json!({ "username": username, "max": max }),
        )
    }

    fn get_bookmarks(&self, max: u32) -> AppResult<FeedPage> {
        self.rpc("bookmarks", json!({ "max": max }))
    }

    fn get_list_timeline_page(
        &self,
        list_id: &str,
        max: u32,
        cursor: Option<String>,
    ) -> AppResult<FeedPage> {
        self.rpc(
            "list_timeline",
            json!({ "listId": list_id, "max": max, "cursor": cursor }),
        )
    }

    fn get_list_timeline(&self, list_id: &str, max: u32) -> AppResult<FeedPage> {
        self.get_list_timeline_page(list_id, max, None)
    }

    fn get_current_user(&self) -> AppResult<Author> {
        self.rpc("current_user", json!({}))
    }

    fn status(&self) -> AppResult<AuthenticationStatus> {
        let mut status: AuthenticationStatus = self.rpc("status", json!({}))?;
        // `AuthenticationStatus.account` is intentionally skipped by serde in
        // the desktop IPC model. Resolve it through the explicit endpoint so
        // the existing session startup can still populate the account chip.
        if status.authenticated {
            status.account = self.get_current_user().ok();
        }
        Ok(status)
    }
}

fn normalize_base_url(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = reqwest::Url::parse(&candidate).map_err(|_| {
        AppError::new(
            ErrorCode::NetworkUnavailable,
            "the Windows companion address is not valid",
        )
        .with_repair("Enter the complete address shown by the Windows app.")
    })?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "only a plain local companion address is accepted",
        ));
    }
    let serialized_host = url.host_str().ok_or_else(|| {
        AppError::new(
            ErrorCode::NetworkUnavailable,
            "the Windows companion address has no host",
        )
    })?;
    // `url::Url::host_str` serializes IPv6 literals with brackets. Remove them
    // before parsing as `IpAddr`; they are restored in the normalized URL.
    let host = serialized_host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(serialized_host);
    if !is_local_host(host) {
        return Err(AppError::new(
            ErrorCode::BlockedOperation,
            "the iPhone companion address must be a private local-network IP",
        )
        .with_repair(
            "Use the address shown by the Windows app while both devices are on the same Wi-Fi.",
        ));
    }
    let port = url.port_or_known_default().ok_or_else(|| {
        AppError::new(
            ErrorCode::NetworkUnavailable,
            "the Windows companion address has no port",
        )
    })?;
    let formatted_host = match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{host}]"),
        _ => host.to_string(),
    };
    Ok(format!("http://{formatted_host}:{port}"))
}

fn is_local_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            !ip.is_unspecified() && (ip.is_private() || ip.is_loopback() || ip.is_link_local())
        }
        Ok(IpAddr::V6(ip)) => {
            !ip.is_unspecified()
                && (ip.is_loopback() || is_unique_local_v6(ip) || is_link_local_v6(ip))
        }
        Err(_) => false,
    }
}

fn local_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(1, 1, 1, 1), 80)).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if is_advertisable_ip(ip) {
        Some(ip)
    } else {
        None
    }
}

fn is_advertisable_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => !ip.is_unspecified() && !ip.is_loopback() && ip.is_private(),
        IpAddr::V6(ip) => {
            !ip.is_unspecified()
                && !ip.is_loopback()
                && (is_unique_local_v6(ip) || is_link_local_v6(ip))
        }
    }
}

// Keep the project compatible with its Rust 1.77.2 MSRV. The equivalent
// standard-library helpers were stabilized only in Rust 1.84.
fn is_unique_local_v6(ip: std::net::Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

fn is_link_local_v6(ip: std::net::Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfe80
}

fn random_hex(bytes: usize) -> AppResult<String> {
    let mut raw = vec![0u8; bytes];
    getrandom::getrandom(&mut raw).map_err(|_| {
        AppError::new(
            ErrorCode::ProviderUnavailable,
            "secure randomness is unavailable; companion pairing was not started",
        )
    })?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes * 2);
    for byte in raw {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(output)
}

fn random_pair_code() -> AppResult<String> {
    let mut raw = [0u8; 4];
    getrandom::getrandom(&mut raw).map_err(|_| {
        AppError::new(
            ErrorCode::ProviderUnavailable,
            "secure randomness is unavailable; no pairing code was created",
        )
    })?;
    Ok(format!("{:08}", u32::from_le_bytes(raw) % 100_000_000))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryStore;
    use crate::database::Db;
    use crate::providers::mock::MockXProvider;
    use crate::providers::ProviderKind;

    #[test]
    fn companion_addresses_are_private_and_normalized() {
        assert_eq!(
            normalize_base_url("192.168.1.4:4567/").unwrap(),
            "http://192.168.1.4:4567"
        );
        assert!(normalize_base_url("https://192.168.1.4:4567").is_err());
        assert!(normalize_base_url("http://8.8.8.8:4567").is_err());
        assert!(normalize_base_url("http://example.com:4567").is_err());
        assert!(normalize_base_url("http://192.168.1.4:4567/path").is_err());
        assert!(normalize_base_url("http://[fd12:3456::1]:4567").is_ok());
        assert!(normalize_base_url("http://[fe80::1]:4567").is_ok());
        assert!(normalize_base_url("http://[2001:4860:4860::8888]:4567").is_err());
    }

    #[test]
    fn secret_comparison_rejects_wrong_lengths_and_values() {
        assert!(constant_time_eq(b"12345678", b"12345678"));
        assert!(!constant_time_eq(b"12345678", b"12345679"));
        assert!(!constant_time_eq(b"12345678", b"1234"));
    }

    #[test]
    fn status_never_serializes_the_bearer_token() {
        let status = CompanionHostStatus {
            running: true,
            address: Some("http://192.168.1.2:1234".into()),
            port: Some(1234),
            pairing_code: Some("12345678".into()),
            paired_once: true,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("12345678"));
        assert!(!json.contains("bearer"));
        assert!(!json.contains("token"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_paired_remote_provider_reads_real_provider_models() {
        let state = Arc::new(AppState::with_store(
            Db::in_memory().unwrap(),
            Arc::new(MemoryStore::new()),
        ));
        *state.provider.lock().unwrap() = Box::new(MockXProvider::new());
        *state.kind.lock().unwrap() = ProviderKind::Mock;

        state.companion.start(Arc::downgrade(&state)).await.unwrap();
        let status = state.companion.status();
        let address = status.address.unwrap();
        let code = status.pairing_code.unwrap();

        let credentials =
            tokio::task::spawn_blocking(move || RemoteProvider::pair(&address, &code))
                .await
                .unwrap()
                .unwrap();
        let store = Arc::new(MemoryStore::new());
        store.save(&credentials).unwrap();
        let page = tokio::task::spawn_blocking(move || {
            RemoteProvider::new(store).get_following_feed(3, None)
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(page.posts.len(), 3);
        assert_eq!(page.provider, "mock");
        state.companion.stop();
    }
}
