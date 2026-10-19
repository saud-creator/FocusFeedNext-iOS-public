//! TwitterCliProvider — the live backend.
//!
//! Talks to the `twitter` executable (twitter-cli) that Agent Reach manages.
//! Rules enforced here:
//!   * every invocation is built from a validated operation + an argument
//!     ARRAY. No shell strings are ever constructed.
//!   * only read operations in `security::ALLOWED_OPS` can run.
//!   * every call has a timeout and kills the child process on expiry.
//!   * stdout/stderr are drained on separate threads so a chatty process can
//!     never deadlock on a full pipe.
//!   * credentials are fetched from the OS credential store and written *only*
//!     into the child's environment block, immediately before spawn. They are
//!     never logged, never returned to the frontend, and never placed on the
//!     command line, where any other user on the machine could read them out of
//!     the process table.
//!
//! ## Two things about twitter-cli 0.8.5 that are not obvious
//!
//! 1. **`PYTHONIOENCODING=utf-8` is mandatory on Windows.** The tool writes its
//!    output through `click.echo`, and on a machine whose console codepage is
//!    cp1252 that call raises `UnicodeEncodeError` the moment the payload holds
//!    a character outside Latin-1. Since X posts routinely contain emoji — and
//!    this app is explicitly built for Arabic — practically every real request
//!    would crash without it. Verified directly: `twitter --help` alone fails,
//!    because the help text contains 🐦.
//!
//! 2. **`following` and `followers` take a positional handle, not a flag.**
//!    `twitter following <screen_name>`. There is no "my following" default, so
//!    the active account has to be resolved with `whoami` first.

use super::{ProviderCapabilities, XDataProvider, FOLLOWING_REQUEST_MAX};
use crate::credentials::CredentialStore;
use crate::models::*;
use crate::security;
use chrono::Utc;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The upstream commit this release is built and tested against.
///
/// Focus Feed Next pins twitter-cli to an exact commit rather than tracking
/// `main`. The CLI is the app's entire view of X, and its output contract has
/// already changed once under us (0.8.5 → 0.8.6 moved profile fields, switched
/// SearchTimeline to POST and added `pagination`). A moving dependency there is
/// a moving parser here.
pub const PINNED_COMMIT: &str = "7c634e0d396b1e7af9f63315b414925fe4f29ae7";

/// The version string the pinned commit reports.
pub const PINNED_VERSION: &str = "0.8.6";

/// Install the pinned build. Shown verbatim in Diagnostics when the version
/// on disk is not the pinned one.
pub const PINNED_INSTALL_HINT: &str = concat!(
    "pipx install --force \"git+https://github.com/public-clis/twitter-cli.git@",
    "7c634e0d396b1e7af9f63315b414925fe4f29ae7\""
);

pub struct TwitterCliProvider {
    bin: Option<PathBuf>,
    timeout: Duration,
    store: Arc<dyn CredentialStore>,
}

impl TwitterCliProvider {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            bin: locate_binary(),
            // Generous on purpose. A rate-limited request retries internally
            // three times with ~5s/10s/20s backoff before it reports anything,
            // and a large `--max` sleeps ~2.5s between internal pages. A tight
            // timeout would kill requests that were about to succeed.
            timeout: Duration::from_secs(120),
            store,
        }
    }

    /// A provider with no credential store. Used by tests that only exercise
    /// argument validation and never reach a spawn.
    #[cfg(test)]
    pub fn detached() -> Self {
        Self::new(Arc::new(crate::credentials::MemoryStore::new()))
    }

    pub fn with_timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    pub fn is_installed(&self) -> bool {
        self.bin.is_some()
    }

    pub fn binary_path(&self) -> Option<String> {
        self.bin.as_ref().map(|p| p.display().to_string())
    }

    pub fn version(&self) -> Option<String> {
        let out = self
            .run_raw(&["--version".into()], Duration::from_secs(15))
            .ok()?;
        Some(out.trim().to_string())
    }

    fn bin_path(&self) -> AppResult<&PathBuf> {
        self.bin.as_ref().ok_or_else(|| {
            AppError::new(
                ErrorCode::ToolMissing,
                "twitter-cli is not installed or not on PATH.",
            )
            .with_repair("Install it with: pipx install twitter-cli")
        })
    }

    /// Spawn the process, drain both pipes concurrently, enforce the timeout.
    fn run_raw(&self, args: &[String], timeout: Duration) -> AppResult<String> {
        let bin = self.bin_path()?;
        let mut cmd = Command::new(bin);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        // Force UTF-8 on the child's stdio. See the module docs: without this
        // the tool dies on any emoji or Arabic character under a cp1252
        // console, which is every interesting request.
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.env("PYTHONUTF8", "1");

        // Credentials go here and nowhere else. The scope block keeps the
        // decrypted values alive for as few statements as possible; the
        // `XCredentials` destructor wipes the buffers.
        match self.store.load() {
            Ok(Some(creds)) => {
                cmd.env("TWITTER_AUTH_TOKEN", &creds.auth_token);
                cmd.env("TWITTER_CT0", &creds.ct0);
            }
            Ok(None) => {
                // No stored session. Actively strip any inherited variables so
                // behaviour depends only on what was connected inside the app —
                // a leftover `setx` from an earlier experiment must not make a
                // disconnected app quietly appear to work.
                cmd.env_remove("TWITTER_AUTH_TOKEN");
                cmd.env_remove("TWITTER_CT0");
            }
            Err(e) => return Err(e),
        }

        let mut child = cmd.spawn().map_err(|e| {
            AppError::new(
                ErrorCode::ProcessCrashed,
                format!("could not start twitter-cli: {e}"),
            )
        })?;

        // Read raw bytes and decode as UTF-8 explicitly. twitter-cli writes
        // `ensure_ascii=False` JSON, so Arabic, CJK and emoji arrive as real
        // UTF-8; decoding with the OS ANSI codepage would mangle every one of
        // them. Lossy decoding means a truncated multi-byte sequence at a pipe
        // boundary degrades one character instead of failing the whole request.
        let mut so = child.stdout.take();
        let mut se = child.stderr.take();
        let h_out = std::thread::spawn(move || {
            let mut b = Vec::new();
            if let Some(p) = so.as_mut() {
                let _ = p.read_to_end(&mut b);
            }
            String::from_utf8_lossy(&b).into_owned()
        });
        let h_err = std::thread::spawn(move || {
            let mut b = Vec::new();
            if let Some(p) = se.as_mut() {
                let _ = p.read_to_end(&mut b);
            }
            String::from_utf8_lossy(&b).into_owned()
        });

        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {
                    if started.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(AppError::new(
                            ErrorCode::ProcessTimeout,
                            format!("twitter-cli timed out after {}s", timeout.as_secs()),
                        )
                        .with_repair("Retry, or check your network connection."));
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
                Err(e) => {
                    return Err(AppError::new(
                        ErrorCode::ProcessCrashed,
                        format!("process error: {e}"),
                    ))
                }
            }
        };

        let stdout = h_out.join().unwrap_or_default();
        let stderr = h_err.join().unwrap_or_default();

        // A JSON body on stdout is the structured envelope — including the
        // `ok:false` form. Hand it back so the caller maps `error.code`
        // precisely instead of guessing from the message text.
        if stdout.contains('{') || stdout.contains('[') {
            return Ok(stdout);
        }

        // Everything below is a failure that never reached the envelope.
        //
        // Exit 2 is click's usage error: we passed an argument this build does
        // not understand. That is a version-drift problem, not a network one,
        // and the repair is to update the tool — so say exactly that rather
        // than reporting a generic API failure.
        if status.code() == Some(2) {
            return Err(AppError::new(
                ErrorCode::SchemaChanged,
                format!(
                    "twitter-cli rejected the arguments for this operation: {}",
                    security::sanitize(&first_line(&stderr))
                ),
            )
            .with_repair("Update twitter-cli: pipx upgrade twitter-cli"));
        }

        if let Some(err) = classify_error(&stderr) {
            return Err(err);
        }

        if !status.success() {
            // An unhandled Python exception: traceback on stderr, nothing on
            // stdout. The last line carries the actual exception.
            return Err(AppError::new(
                ErrorCode::ProcessCrashed,
                format!(
                    "twitter-cli failed: {}",
                    security::sanitize(&last_line(&stderr))
                ),
            )
            .with_repair("Run Diagnostics → Run Health Check."));
        }

        Ok(stdout)
    }

    /// Run an allowlisted operation and hand back the raw envelope.
    ///
    /// Exposed for Diagnostics and the development probe, which need to see the
    /// envelope itself rather than a mapped model — capability detection has to
    /// read `pagination` before any parser exists for it. The allowlist and the
    /// blocklist in [`run_op`] still apply, so this cannot reach a write
    /// command; it is a narrower door, not a bypass.
    pub fn raw_op(&self, op: &str, extra: &[String]) -> AppResult<String> {
        self.run_op(op, extra)
    }

    /// Validated entry point: `op` must be an allowlisted read operation.
    fn run_op(&self, op: &str, extra: &[String]) -> AppResult<String> {
        if security::is_blocked(op) {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                format!("operation '{op}' is a write command and is blocked in this release"),
            ));
        }
        if !security::is_allowed(op) {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                format!("operation '{op}' is not in the read-only allowlist"),
            ));
        }
        let mut args: Vec<String> = vec![op.to_string()];
        args.extend_from_slice(extra);
        self.run_raw(&args, self.timeout)
    }

    /// The write path. Separate from [`run_op`] by design.
    ///
    /// `run_op` consults `ALLOWED_OPS` and `BLOCKED_OPS`, and `unfollow` is in
    /// the blocked list — so the read path cannot reach it no matter what is
    /// passed. This function is the only other door, it accepts only
    /// `GATED_WRITE_OPS`, and it requires a permit that cannot exist unless the
    /// preference was checked and found on.
    fn run_write_op(&self, permit: &security::WritePermit, extra: &[String]) -> AppResult<String> {
        let op = permit.op();
        if !security::GATED_WRITE_OPS.contains(&op) {
            return Err(AppError::new(
                ErrorCode::BlockedOperation,
                format!("operation '{op}' is not a permitted write operation"),
            ));
        }
        let mut args: Vec<String> = vec![op.to_string()];
        args.extend_from_slice(extra);
        self.run_raw(&args, self.timeout)
    }

    fn run_bookmark_write(
        &self,
        _permit: &security::BookmarkPermit,
        post_id: &str,
    ) -> AppResult<String> {
        let id = security::clean_numeric_id(post_id)
            .ok_or_else(|| AppError::new(ErrorCode::ApiError, "invalid post id"))?;
        // This path is deliberately separate from the read allowlist and the
        // Follow/Unfollow permit. The operation name and arguments are fixed;
        // no arbitrary provider command can reach the child process.
        self.run_raw(
            &[security::BOOKMARK_WRITE_OP.to_string(), id, "--json".into()],
            self.timeout,
        )
    }

    fn feed(&self, kind: &str, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        // 0.8.6 added `--cursor` to `feed` and `list` (and only those two —
        // checked against `--help` for every read command on the pinned build).
        // The response carries `pagination.nextCursor`, so continuation is real
        // here and the feed engine can offer Load More honestly.
        let mut args: Vec<String> = vec![
            "-t".into(),
            kind.into(),
            "--max".into(),
            max.clamp(1, 100).to_string(),
            // Asked for on every timeline that accepts it, and never offered as
            // a toggle. It is not sufficient on its own: a live following page
            // requested exactly this way still came back 20 ads in 45 posts, so
            // `database::passes` drops them again on the way out. This flag
            // reduces what has to be thrown away; it does not decide what the
            // reader sees.
            "--no-include-promoted".into(),
            "--json".into(),
        ];
        if let Some(c) = clean_cursor(cursor.as_deref()) {
            args.push("--cursor".into());
            args.push(c);
        }
        parse_feed(&self.run_op("feed", &args)?, "twitter-cli")
    }
}

/// Reject a handle that could be read as a flag before it reaches an argument
/// array. See `security::clean_screen_name`.
fn screen_name_arg(raw: &str) -> AppResult<String> {
    security::clean_screen_name(raw).ok_or_else(|| {
        AppError::new(
            ErrorCode::ApiError,
            "that is not a valid X handle (letters, numbers and underscore, up to 15 characters)",
        )
    })
}

/// Validate a cursor before it goes back on a command line.
///
/// A rejected cursor degrades to "first page" rather than erroring: the cursor
/// is an optimisation, and refusing to show the feed because a stale token was
/// malformed would be the wrong trade.
fn clean_cursor(raw: Option<&str>) -> Option<String> {
    raw.and_then(security::clean_cursor)
}

fn locate_binary() -> Option<PathBuf> {
    // 1. explicit override, 2. PATH, 3. the pipx default location.
    if let Ok(p) = std::env::var("FFN_TWITTER_CLI") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let names = if cfg!(windows) {
        "twitter.exe"
    } else {
        "twitter"
    };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(names);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        let candidate = home.join(".local").join("bin").join(names);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Map an `error.code` from the structured envelope onto our error model.
///
/// twitter-cli always reports failures as a machine-readable code, so we switch
/// on that and never on the free-text message — the message is localised prose
/// that changes between releases.
fn error_from_envelope(code: &str, message: &str) -> AppError {
    let msg = message.trim();
    match code {
        "not_authenticated" => {
            // The same code covers "never had cookies" and "cookies rejected".
            // The distinction matters: one asks the user to connect, the other
            // to reconnect.
            if msg.to_lowercase().contains("expired") || msg.contains("401") {
                AppError::new(ErrorCode::CookieExpired, "The X session has expired.")
                    .with_repair("Open Settings → X Connection and replace auth_token and ct0.")
            } else {
                AppError::new(ErrorCode::NotAuthenticated, "No valid X session.")
                    .with_repair("Open Settings → X Connection and connect an account.")
            }
        }
        "rate_limited" => AppError::new(ErrorCode::RateLimited, "X is rate limiting this account.")
            .with_repair("Wait a few minutes before refreshing."),
        "not_found" => AppError::new(ErrorCode::ApiError, "X returned no such account or post.")
            .with_repair("Check the handle; the account may have been renamed or suspended."),
        // twitter-cli could not resolve a GraphQL query id: X changed its API
        // surface under the tool. That is a schema problem, not our bug.
        "query_id_error" => AppError::new(
            ErrorCode::SchemaChanged,
            "twitter-cli could not resolve an X API endpoint.",
        )
        .with_repair("Update twitter-cli: pipx upgrade twitter-cli"),
        "network_error" => AppError::new(ErrorCode::NetworkUnavailable, "No network connection."),
        _ => AppError::new(ErrorCode::ApiError, security::sanitize(msg)),
    }
}

/// Last-resort classification for output that never reached the envelope —
/// Python tracebacks and click usage errors, which are printed raw on stderr.
fn classify_error(out: &str) -> Option<AppError> {
    let l = out.to_lowercase();
    if l.contains("not_authenticated") || l.contains("no twitter cookies found") {
        return Some(
            AppError::new(ErrorCode::NotAuthenticated, "No valid X session.")
                .with_repair("Open Settings → X Connection and connect an account."),
        );
    }
    if l.contains("cookie expired") || l.contains("session expired") {
        return Some(
            AppError::new(ErrorCode::CookieExpired, "The X session has expired.")
                .with_repair("Open Settings → X Connection and replace auth_token and ct0."),
        );
    }
    if l.contains("rate_limited") || l.contains("too many requests") || l.contains("429") {
        return Some(
            AppError::new(ErrorCode::RateLimited, "X is rate limiting this account.")
                .with_repair("Wait a few minutes before refreshing."),
        );
    }
    if l.contains("temporary failure in name resolution")
        || l.contains("failed to establish a new connection")
        || l.contains("network is unreachable")
        || l.contains("getaddrinfo failed")
    {
        return Some(AppError::new(
            ErrorCode::NetworkUnavailable,
            "No network connection.",
        ));
    }
    if l.contains("unicodeencodeerror") {
        // Should be impossible now that the child gets PYTHONIOENCODING, but if
        // it ever comes back, say so precisely instead of "invalid JSON".
        return Some(
            AppError::new(
                ErrorCode::ProcessCrashed,
                "twitter-cli could not encode its output.",
            )
            .with_repair("Report this: the UTF-8 environment override is not taking effect."),
        );
    }
    None
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
//
// Every `--json` document is `{"ok":true,"schema_version":"1","data":<payload>}`
// or `{"ok":false,"schema_version":"1","error":{"code","message"}}`. Branch on
// `ok`; never infer success from the presence of `data`.

/// The `data` payload plus anything the envelope carries alongside it.
///
/// 0.8.6 added a `pagination` object as a **sibling** of `data`, not a field
/// inside it. Verified against a real `feed` response: the root object has four
/// keys — `ok`, `schema_version`, `data`, `pagination` — and `pagination` holds
/// a single `nextCursor` string.
pub struct Envelope {
    pub data: Value,
    /// `Some` only when the command actually emitted one. Commands without
    /// cursor support simply omit the key, so this is genuine per-command
    /// capability detection rather than a table we have to keep in sync.
    pub next_cursor: Option<String>,
}

/// Unwrap the envelope and return the `data` payload.
pub fn unwrap_envelope(raw: &str) -> AppResult<Value> {
    unwrap_envelope_full(raw).map(|e| e.data)
}

/// Unwrap the envelope, keeping the pagination sibling.
pub fn unwrap_envelope_full(raw: &str) -> AppResult<Envelope> {
    let root = parse_json(raw, "twitter-cli")?;

    // Read the cursor before `data` is moved out. An empty string is treated as
    // absent: "" would otherwise be handed straight back to `--cursor`, where it
    // means "start from the beginning" and would loop the feed forever.
    let next_cursor = root
        .get("pagination")
        .and_then(|p| pick_str(p, &["nextCursor", "next_cursor"]))
        .filter(|c| !c.trim().is_empty());

    match root.get("ok") {
        Some(Value::Bool(true)) => {
            let data = root.get("data").cloned().ok_or_else(|| {
                AppError::new(
                    ErrorCode::SchemaChanged,
                    "twitter-cli reported success but sent no data payload",
                )
                .with_repair("Update twitter-cli: pipx upgrade twitter-cli")
            })?;
            Ok(Envelope { data, next_cursor })
        }
        Some(Value::Bool(false)) => {
            let err = root.get("error");
            let code = err
                .and_then(|e| pick_str(e, &["code"]))
                .unwrap_or_else(|| "api_error".into());
            let message = err
                .and_then(|e| pick_str(e, &["message"]))
                .unwrap_or_else(|| "twitter-cli reported a failure".into());
            Err(error_from_envelope(&code, &message))
        }
        // No `ok` key at all: either a very old build or something that is not
        // twitter-cli output. Do not guess.
        _ => Err(AppError::new(
            ErrorCode::SchemaChanged,
            "twitter-cli output was not in the expected {ok, data} envelope",
        )
        .with_repair("Update twitter-cli: pipx upgrade twitter-cli")),
    }
}

// ---------------------------------------------------------------------------
// Tolerant JSON mapping
// ---------------------------------------------------------------------------

fn pick_str(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        match v.get(*k) {
            Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            Some(Value::Number(n)) => return Some(n.to_string()),
            _ => {}
        }
    }
    None
}

fn pick_u64(v: &Value, keys: &[&str]) -> Option<u64> {
    for k in keys {
        match v.get(*k) {
            Some(Value::Number(n)) => return n.as_u64(),
            Some(Value::String(s)) => {
                if let Ok(n) = s.replace(',', "").parse::<u64>() {
                    return Some(n);
                }
            }
            _ => {}
        }
    }
    None
}

fn pick_bool(v: &Value, keys: &[&str]) -> bool {
    for k in keys {
        match v.get(*k) {
            Some(Value::Bool(b)) => return *b,
            Some(Value::String(s)) if s == "true" => {
                return true;
            }
            _ => {}
        }
    }
    false
}

/// Map any of twitter-cli's three user shapes onto one `Author`.
///
/// The three are: the 5-key author embedded in a tweet; the 14-key profile from
/// `user`/`following` (has `createdAtISO`, no `username`); and the 14-key
/// profile from `whoami`/`status` (has `username`, no `createdAtISO`). Reading
/// both spellings of every field lets one function serve all three.
///
/// Empty strings are treated as absent: twitter-cli emits `""` rather than
/// `null` for an unset bio, location or website, and rendering an empty bio
/// block would look like a loading failure.
fn map_author(v: &Value) -> Author {
    let node = v
        .get("author")
        .or_else(|| v.get("user"))
        .or_else(|| v.get("account"))
        .unwrap_or(v);
    let username = pick_str(node, &["screenName", "username", "screen_name", "handle"])
        .unwrap_or_else(|| "unknown".into());
    Author {
        id: pick_str(node, &["id", "id_str", "rest_id", "user_id"])
            .unwrap_or_else(|| username.clone()),
        display_name: pick_str(node, &["name", "display_name", "displayName"])
            .unwrap_or_else(|| username.clone()),
        username,
        avatar_url: pick_str(
            node,
            &["profileImageUrl", "profile_image_url_https", "avatar_url"],
        ),
        // twitter-cli 0.8.5 never emits a banner. Kept so a future release, or
        // another provider, can populate it without a model change.
        banner_url: pick_str(node, &["bannerUrl", "profile_banner_url"]),
        verified: pick_bool(node, &["verified", "isVerified", "is_blue_verified"]),
        bio: pick_str(node, &["bio", "description"]),
        followers_count: pick_u64(node, &["followers", "followers_count"]),
        following_count: pick_u64(node, &["following", "friends_count"]),
        location: pick_str(node, &["location"]),
        website: pick_str(node, &["url", "website", "expanded_url"]),
        joined_at: pick_str(node, &["createdAtISO", "createdAt", "created_at"])
            .and_then(|raw| normalize_time(Some(raw))),
        posts_count: pick_u64(node, &["tweets", "statuses_count", "posts"]),
    }
}

/// Map the `media` array.
///
/// twitter-cli emits one typed array — `{type, url, width, height}` — where
/// `type` is `photo`, `video` or `animated_gif`. For video and GIF the `url` is
/// the highest-bitrate MP4, not a thumbnail.
///
/// `variants` is present only on a build carrying the project's media patch
/// (`tools/twitter-cli/`); stock 0.8.6 keeps the largest rendition and discards
/// the rest before serialising. Both are handled: an absent or empty array
/// yields no variants at all, and the interface then shows an honest single
/// quality rather than a picker with one invented entry.
fn map_media(v: &Value) -> Vec<PostMedia> {
    let Some(Value::Array(items)) = v.get("media") else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let url = pick_str(item, &["url", "media_url_https"])?;
            let kind = match pick_str(item, &["type"]).unwrap_or_default().as_str() {
                "video" => MediaKind::Video,
                "animated_gif" => MediaKind::Gif,
                _ => MediaKind::Image,
            };
            Some(PostMedia {
                kind,
                url,
                // No poster frame is provided for video; the player shows its
                // own placeholder rather than a frame we do not have.
                preview_url: pick_str(item, &["preview", "previewUrl", "poster"]),
                width: pick_u64(item, &["width"]).map(|n| n as u32),
                height: pick_u64(item, &["height"]).map(|n| n as u32),
                alt: pick_str(item, &["alt", "altText"]),
                duration_ms: pick_u64(item, &["durationMs", "duration_ms"]),
                variants: map_variants(item),
            })
        })
        .collect()
}

/// Map one media item's `variants` array, if the backend published one.
///
/// Only MP4 survives: the webview plays MP4 over the loopback proxy, and an
/// HLS playlist listed as a quality would be an entry that cannot play.
/// Renditions are deduplicated by resolution keeping the highest bitrate —
/// X routinely publishes two encodes of the same size — and sorted largest
/// first, so "best available" is simply the first.
///
/// A rendition X described with neither a resolution nor a bitrate is dropped
/// rather than listed, because there is no truthful way to name it.
fn map_variants(item: &Value) -> Vec<MediaVariant> {
    let Some(Value::Array(list)) = item.get("variants") else {
        return Vec::new();
    };
    let mut out: Vec<MediaVariant> = Vec::new();
    for v in list {
        let content_type = pick_str(v, &["contentType", "content_type"]).unwrap_or_default();
        if !content_type.is_empty() && content_type != "video/mp4" {
            continue;
        }
        let Some(url) = pick_str(v, &["url"]) else {
            continue;
        };
        let width = pick_u64(v, &["width"]).map(|n| n as u32);
        let height = pick_u64(v, &["height"]).map(|n| n as u32);
        let bitrate = pick_u64(v, &["bitrate"]);
        let Some(label) = MediaVariant::label_for(width, height, bitrate) else {
            continue;
        };
        out.push(MediaVariant {
            label,
            url,
            bitrate,
            width,
            height,
        });
    }
    // Largest first, ranked by the same side the label names so the menu can
    // never read out of order. Equal sizes fall back to bitrate so the dedupe
    // below keeps the better encode of a duplicated size.
    fn rank(v: &MediaVariant) -> u32 {
        match (v.width.filter(|n| *n > 0), v.height.filter(|n| *n > 0)) {
            (Some(w), Some(h)) => w.min(h),
            (None, Some(h)) => h,
            (Some(w), None) => w,
            (None, None) => 0,
        }
    }
    out.sort_by(|a, b| {
        rank(b)
            .cmp(&rank(a))
            .then(b.bitrate.unwrap_or(0).cmp(&a.bitrate.unwrap_or(0)))
    });
    let mut seen = std::collections::HashSet::new();
    out.retain(|v| seen.insert((v.width, v.height)));
    out
}

/// Map the `metrics` object. All six keys are always present and integral.
fn map_metrics(v: &Value) -> PostMetrics {
    let Some(node) = v.get("metrics") else {
        return PostMetrics::default();
    };
    PostMetrics {
        replies: pick_u64(node, &["replies"]).unwrap_or(0),
        reposts: pick_u64(node, &["retweets"]).unwrap_or(0),
        likes: pick_u64(node, &["likes"]).unwrap_or(0),
        quotes: pick_u64(node, &["quotes"]).unwrap_or(0),
        views: pick_u64(node, &["views"]).unwrap_or(0),
        bookmarks: pick_u64(node, &["bookmarks"]).unwrap_or(0),
    }
}

/// twitter-cli exposes no permalink field, so build the canonical one.
///
/// This is derivation, not invention: `https://x.com/<handle>/status/<id>` is
/// how X addresses every post, and both components come straight from the
/// payload.
fn permalink(username: &str, id: &str) -> Option<String> {
    (username != "unknown" && !id.is_empty())
        .then(|| format!("https://x.com/{username}/status/{id}"))
}

fn normalize_time(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&raw) {
        return Some(dt.to_rfc3339());
    }
    // Classic Twitter format: "Wed Oct 05 20:14:03 +0000 2022"
    if let Ok(dt) = chrono::DateTime::parse_from_str(&raw, "%a %b %d %H:%M:%S %z %Y") {
        return Some(dt.to_rfc3339());
    }
    if let Ok(secs) = raw.parse::<i64>() {
        if let Some(dt) = chrono::DateTime::from_timestamp(secs, 0) {
            return Some(dt.to_rfc3339());
        }
    }
    None
}

pub fn map_post(v: &Value, provider: &str) -> Option<Post> {
    let id = pick_str(v, &["id"])?;
    let text = pick_str(v, &["text"]).unwrap_or_default();
    let author = map_author(v);

    // A quote carries only id, text and a two-field author. No timestamp, no
    // metrics, no media — so none are fabricated here.
    let quoted = v.get("quotedTweet").and_then(|q| {
        let qid = pick_str(q, &["id"])?;
        let qauthor = map_author(q);
        Some(Box::new(QuotedPost {
            url: permalink(&qauthor.username, &qid),
            id: qid,
            author: qauthor,
            text: pick_str(q, &["text"]).unwrap_or_default(),
            created_at: None,
            media: vec![],
        }))
    });

    // For a repost every field above describes the ORIGINAL post; the reposter
    // is reported as a bare handle string, which is all we can say about them.
    let is_repost = pick_bool(v, &["isRetweet"]);
    let reposted_by = pick_str(v, &["retweetedBy"]).map(Author::from_handle);

    let article_title = pick_str(v, &["articleTitle"]);

    Some(Post {
        url: permalink(&author.username, &id),
        id,
        text,
        author,
        // `createdAtISO` is the parseable one. `createdAtLocal` is deliberately
        // ignored: it is formatted in the *host machine's* timezone with no
        // offset, so it cannot be converted back reliably.
        created_at: normalize_time(pick_str(v, &["createdAtISO", "createdAt"]))?,
        lang: pick_str(v, &["lang"]),
        is_repost,
        reposted_by,
        // 0.8.6 exposes a real `isPromoted` boolean; 0.8.5 had none, so this
        // was hardcoded `false`. Timelines are still requested with promoted
        // content excluded at source, making this a second line of defence
        // rather than the only one.
        is_promoted: pick_bool(v, &["isPromoted"]),
        quoted,
        metrics: map_metrics(v),
        media: map_media(v),
        is_article: article_title.is_some(),
        article_title,
        // twitter-cli exposes no reply linkage at all. Left None rather than
        // guessed — and this release never fetches conversations anyway.
        in_reply_to: None,
        provider: provider.to_string(),
    })
}

/// Parse a tweet-array command (`feed`, `bookmarks`, `user-posts`, `search`,
/// `list`).
pub fn parse_feed(raw: &str, provider: &str) -> AppResult<FeedPage> {
    if raw.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::EmptyResponse,
            "twitter-cli returned no output",
        ));
    }
    let Envelope { data, next_cursor } = unwrap_envelope_full(raw)?;

    let Value::Array(arr) = &data else {
        return Err(AppError::new(
            ErrorCode::SchemaChanged,
            "twitter-cli returned a post payload that was not an array",
        )
        .with_repair("Update twitter-cli: pipx upgrade twitter-cli"));
    };

    let posts: Vec<Post> = arr.iter().filter_map(|v| map_post(v, provider)).collect();
    // "X returned nothing" and "we could not read what X returned" must never
    // look the same to the reader.
    if posts.is_empty() && !arr.is_empty() {
        return Err(AppError::new(
            ErrorCode::SchemaChanged,
            "posts were returned but no known fields could be mapped",
        )
        .with_repair("Update twitter-cli: pipx upgrade twitter-cli"));
    }

    Ok(FeedPage {
        posts,
        // Whatever the envelope actually carried. `feed` and `list` emit one in
        // 0.8.6; `search`, `user-posts` and `bookmarks` do not, and for those
        // this stays `None` — so the UI's Load More affordance appears only when
        // a real cursor exists, rather than from a table we assert by hand.
        cursor: next_cursor,
        fetched_at: Utc::now().to_rfc3339(),
        provider: provider.to_string(),
        from_cache: false,
    })
}

/// Extract "0.8.6" from twitter-cli's `--version` line ("twitter, version X").
pub fn parse_version(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .last()
        .map(str::trim)
        .filter(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

impl XDataProvider for TwitterCliProvider {
    fn name(&self) -> &'static str {
        "twitter-cli"
    }

    /// Checked against the pinned build: `--help` for every command we call,
    /// plus the shape of its real responses.
    ///
    /// `following_cursor` and `user_posts_cursor` are false because those
    /// commands take `--max` and nothing else, and their envelopes carry no
    /// `pagination` key — twitter-cli gathers the whole requested count
    /// internally before returning.
    ///
    /// Nothing here describes search. The CLI can still do it; this app cannot
    /// ask, which is the more useful thing for the interface to know.
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            feed_cursor: true,
            list_cursor: true,
            following_cursor: false,
            user_posts_cursor: false,
            promoted_flag: true,
            unfollow: true,
            follow: true,
            unbookmark: true,
            // No `mute` and no `block` subcommand exists on this build. The
            // interface reads these to say so plainly rather than showing an
            // action that could only ever fail.
            mute: false,
            block: false,
        }
    }

    fn get_following_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        self.feed("following", max, cursor)
    }

    fn get_for_you_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        self.feed("for-you", max, cursor)
    }

    fn unfollow_account(&self, username: &str, permit: &security::WritePermit) -> AppResult<()> {
        let handle = screen_name_arg(username)?;
        let out = self.run_write_op(permit, &[handle, "--json".into()])?;
        // A write still returns the ordinary envelope, so an `ok:false` here is
        // reported as the failure it is rather than being assumed to have
        // worked because the process exited zero.
        unwrap_envelope(&out)?;
        Ok(())
    }

    /// `twitter follow SCREEN_NAME`. Identical in shape to the unfollow above,
    /// and identical in gating: the permit carries which of the two it is, so
    /// neither can be reached by passing the other's arguments.
    fn follow_account(&self, username: &str, permit: &security::WritePermit) -> AppResult<()> {
        let handle = screen_name_arg(username)?;
        let out = self.run_write_op(permit, &[handle, "--json".into()])?;
        unwrap_envelope(&out)?;
        Ok(())
    }

    fn remove_bookmark(
        &self,
        post_id: &str,
        permit: &security::BookmarkPermit,
    ) -> AppResult<()> {
        let out = self.run_bookmark_write(permit, post_id)?;
        unwrap_envelope(&out)?;
        Ok(())
    }

    fn get_user_profile(&self, username: &str) -> AppResult<Author> {
        let out = self.run_op("user", &[screen_name_arg(username)?, "--json".into()])?;
        // `user` returns a single profile object, not an array.
        let author = map_author(&unwrap_envelope(&out)?);
        if author.username == "unknown" {
            return Err(AppError::new(
                ErrorCode::SchemaChanged,
                "the profile payload had no recognisable handle",
            )
            .with_repair("Update twitter-cli: pipx upgrade twitter-cli"));
        }
        Ok(author)
    }

    fn get_user_posts(&self, username: &str, max: u32) -> AppResult<FeedPage> {
        let out = self.run_op(
            "user-posts",
            &[
                screen_name_arg(username)?,
                "--max".into(),
                max.to_string(),
                "--json".into(),
            ],
        )?;
        parse_feed(&out, self.name())
    }

    /// The accounts `username` follows.
    ///
    /// `following` has no "me" default — the handle is a required positional
    /// argument — so callers resolve the active account through `whoami` first.
    fn get_following_accounts(&self, username: &str, max: u32) -> AppResult<Vec<Author>> {
        let out = self.run_op(
            "following",
            &[
                screen_name_arg(username)?,
                "--max".into(),
                max.clamp(1, FOLLOWING_REQUEST_MAX).to_string(),
                "--json".into(),
            ],
        )?;
        parse_accounts(&out)
    }

    fn get_bookmarks(&self, max: u32) -> AppResult<FeedPage> {
        let out = self.run_op(
            "bookmarks",
            &["--max".into(), max.to_string(), "--json".into()],
        )?;
        parse_feed(&out, self.name())
    }

    fn get_list_timeline(&self, list_id: &str, max: u32) -> AppResult<FeedPage> {
        let id = security::clean_numeric_id(list_id)
            .ok_or_else(|| AppError::new(ErrorCode::ApiError, "invalid list id"))?;
        let out = self.run_op(
            "list",
            &[id, "--max".into(), max.to_string(), "--json".into()],
        )?;
        parse_feed(&out, self.name())
    }

    fn get_list_timeline_page(
        &self,
        list_id: &str,
        max: u32,
        cursor: Option<String>,
    ) -> AppResult<FeedPage> {
        let id = security::clean_numeric_id(list_id)
            .ok_or_else(|| AppError::new(ErrorCode::ApiError, "invalid list id"))?;
        let mut args: Vec<String> = vec![id, "--max".into(), max.to_string(), "--json".into()];
        if let Some(c) = clean_cursor(cursor.as_deref()) {
            args.push("--cursor".into());
            args.push(c);
        }
        parse_feed(&self.run_op("list", &args)?, self.name())
    }

    fn get_current_user(&self) -> AppResult<Author> {
        let out = self.run_op("whoami", &["--json".into()])?;
        // `whoami` nests the profile one level down: data.user
        let data = unwrap_envelope(&out)?;
        let node = data.get("user").cloned().unwrap_or(data);
        let author = map_author(&node);
        if author.username == "unknown" {
            return Err(AppError::new(
                ErrorCode::SchemaChanged,
                "whoami returned no recognisable account handle",
            )
            .with_repair("Update twitter-cli, then run Diagnostics → Run Health Check."));
        }
        Ok(author)
    }

    fn status(&self) -> AppResult<AuthenticationStatus> {
        // "not authenticated" is an answer, not a failure — the session layer
        // needs it to render the red state rather than an error toast. It can
        // arrive either as an `ok:false` envelope (the normal path) or, if the
        // process died before printing one, from the stderr classifier.
        let unauthenticated = |e: AppError| AuthenticationStatus {
            authenticated: false,
            username: None,
            account: None,
            checked_at: Utc::now().to_rfc3339(),
            message: e.message,
        };
        match self.run_op("status", &["--json".into()]) {
            Ok(raw) => match parse_status(&raw) {
                Ok(s) => Ok(s),
                Err(e) if is_auth_error(&e) => Ok(unauthenticated(e)),
                Err(e) => Err(e),
            },
            Err(e) if is_auth_error(&e) => Ok(unauthenticated(e)),
            Err(e) => Err(e),
        }
    }
}

fn is_auth_error(e: &AppError) -> bool {
    matches!(
        e.code,
        ErrorCode::NotAuthenticated | ErrorCode::CookieExpired
    )
}

/// First non-empty line, capped — used for click usage errors.
fn first_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no detail")
        .chars()
        .take(200)
        .collect()
}

/// Last non-empty line, capped — a Python traceback's final line is the
/// exception itself, which is the only part worth showing.
fn last_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("no detail")
        .chars()
        .take(200)
        .collect()
}

/// Read a successful `status --json` payload: `data.authenticated` plus the
/// account under `data.user`.
///
/// A failed status never reaches here — twitter-cli reports "not logged in" as
/// `ok:false` with `error.code = not_authenticated`, which [`unwrap_envelope`]
/// turns into an error. There is no `{"authenticated": false}` shape.
///
/// A payload we cannot read is treated as **not** authenticated. That is the
/// safe direction: claiming a working session we could not prove would put a
/// green dot above an app that then fails every request.
pub fn parse_status(raw: &str) -> AppResult<AuthenticationStatus> {
    let data = unwrap_envelope(raw)?;
    let user = data.get("user");
    let authenticated = pick_bool(&data, &["authenticated"]);
    // The pinned twitter-cli includes the same profile object in `status` that
    // `whoami` returns. Reusing it removes a second child process on every
    // launch and connection test. If a future/older build only returns a
    // handle, the session layer still falls back to `whoami`.
    let account = user
        .map(map_author)
        .filter(|author| author.username != "unknown");
    Ok(AuthenticationStatus {
        authenticated,
        username: account.as_ref().map(|author| author.username.clone()),
        account,
        checked_at: Utc::now().to_rfc3339(),
        message: if authenticated {
            "twitter-cli reports an authenticated X session.".into()
        } else {
            "twitter-cli did not confirm an authenticated session.".into()
        },
    })
}

/// Find and parse the JSON body, tolerating leading log lines.
fn parse_json(out: &str, what: &str) -> AppResult<Value> {
    let start = out.find(['{', '[']).ok_or_else(|| {
        AppError::new(
            ErrorCode::InvalidJson,
            format!("no JSON found in {what} output"),
        )
    })?;
    serde_json::from_str(&out[start..]).map_err(|e| {
        AppError::new(
            ErrorCode::InvalidJson,
            format!("could not parse {what} output: {e}"),
        )
    })
}

/// Parse an account list.
///
/// Unlike the old version this reports a schema problem instead of silently
/// returning an empty list — "you follow nobody" and "we could not read the
/// response" must never look the same in the interface.
pub fn parse_accounts(out: &str) -> AppResult<Vec<Author>> {
    let data = unwrap_envelope(out)?;
    let Value::Array(arr) = &data else {
        return Err(AppError::new(
            ErrorCode::SchemaChanged,
            "twitter-cli returned an account payload that was not an array",
        )
        .with_repair("Update twitter-cli: pipx upgrade twitter-cli"));
    };

    let accounts: Vec<Author> = arr
        .iter()
        .map(map_author)
        .filter(|a| a.username != "unknown")
        .collect();
    if accounts.is_empty() && !arr.is_empty() {
        return Err(AppError::new(
            ErrorCode::SchemaChanged,
            "accounts were returned but no handle field could be mapped",
        )
        .with_repair("Update twitter-cli: pipx upgrade twitter-cli"));
    }
    Ok(accounts)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures derived from twitter-cli 0.8.5's own serialisation source
    // (`serialization.py`, `output.py`, `cli.py`), not hand-invented. They are
    // the contract this parser is written against.
    const FEED: &str = include_str!("fixtures/following_feed.json");
    const BOOKMARKS: &str = include_str!("fixtures/bookmarks.json");
    const USERS: &str = include_str!("fixtures/following_users.json");

    const WHOAMI: &str = r#"{"ok":true,"schema_version":"1","data":{"user":{
        "id":"1550123456789012345","name":"Fake Dev","username":"fake_dev_zz",
        "screenName":"fake_dev_zz","bio":"Building things.","location":"Nowhere",
        "url":"https://example.invalid","followers":1832,"following":411,
        "tweets":5904,"likes":12034,"verified":true,
        "profileImageUrl":"https://pbs.twimg.com/profile_images/x_normal.jpg",
        "createdAt":"Tue Jan 12 04:15:33 +0000 2010"}}}"#;

    const STATUS_OK: &str = r#"{"ok":true,"schema_version":"1","data":{
        "authenticated":true,
        "user":{"id":"1","name":"Fake Dev","username":"fake_dev_zz","screenName":"fake_dev_zz",
                "bio":"","location":"","url":"","followers":1,"following":2,"tweets":3,
                "likes":4,"verified":false,"profileImageUrl":"","createdAt":""}}}"#;

    const NOT_AUTHENTICATED: &str = r#"{"ok":false,"schema_version":"1","error":{
        "code":"not_authenticated",
        "message":"No Twitter cookies found. Set TWITTER_AUTH_TOKEN and TWITTER_CT0"}}"#;

    // -- envelope -----------------------------------------------------------

    #[test]
    fn unwraps_the_ok_envelope_and_returns_the_data_payload() {
        let data = unwrap_envelope(FEED).unwrap();
        assert!(data.is_array());
        assert_eq!(data.as_array().unwrap().len(), 2);
    }

    #[test]
    fn an_ok_false_envelope_is_mapped_by_its_error_code_not_its_message() {
        let err = unwrap_envelope(NOT_AUTHENTICATED).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAuthenticated);
        assert!(err.repair.is_some());
    }

    #[test]
    fn every_documented_error_code_maps_to_a_distinct_outcome() {
        let cases = [
            ("not_authenticated", ErrorCode::NotAuthenticated),
            ("rate_limited", ErrorCode::RateLimited),
            ("not_found", ErrorCode::ApiError),
            ("query_id_error", ErrorCode::SchemaChanged),
            ("network_error", ErrorCode::NetworkUnavailable),
            ("api_error", ErrorCode::ApiError),
            ("something_new_upstream", ErrorCode::ApiError),
        ];
        for (code, expected) in cases {
            let raw = format!(
                r#"{{"ok":false,"schema_version":"1","error":{{"code":"{code}","message":"boom"}}}}"#
            );
            assert_eq!(unwrap_envelope(&raw).unwrap_err().code, expected, "{code}");
        }
    }

    #[test]
    fn an_expired_cookie_is_distinguished_from_never_having_connected() {
        // Both arrive as `not_authenticated`; only the message separates them,
        // and the two need different repair instructions.
        let raw = r#"{"ok":false,"schema_version":"1","error":{"code":"not_authenticated",
            "message":"Cookie expired or invalid (HTTP 401). Please re-login to x.com."}}"#;
        assert_eq!(
            unwrap_envelope(raw).unwrap_err().code,
            ErrorCode::CookieExpired
        );
    }

    #[test]
    fn output_without_an_ok_key_is_a_schema_change_not_a_silent_empty_feed() {
        for raw in [
            r#"{"tweets":[]}"#,
            r#"[{"id":"1"}]"#,
            r#"{"schema_version":"1","data":[]}"#,
        ] {
            let err = parse_feed(raw, "twitter-cli").unwrap_err();
            assert_eq!(err.code, ErrorCode::SchemaChanged, "{raw}");
        }
    }

    #[test]
    fn ok_true_without_a_data_payload_is_reported() {
        let err = unwrap_envelope(r#"{"ok":true,"schema_version":"1"}"#).unwrap_err();
        assert_eq!(err.code, ErrorCode::SchemaChanged);
    }

    // -- feed ---------------------------------------------------------------

    #[test]
    fn parses_the_real_following_feed_shape() {
        let page = parse_feed(FEED, "twitter-cli").unwrap();
        assert_eq!(page.posts.len(), 2);

        let first = &page.posts[0];
        assert_eq!(first.id, "1897452310098765432");
        assert!(first.text.starts_with("Shipped the offline reader"));
        assert_eq!(first.author.username, "fake_dev_zz");
        assert_eq!(first.author.display_name, "Fake Dev");
        assert!(first.author.verified);
        assert_eq!(first.lang.as_deref(), Some("en"));
    }

    #[test]
    fn reads_all_six_metrics_under_their_real_names() {
        let p = &parse_feed(FEED, "twitter-cli").unwrap().posts[0];
        assert_eq!(p.metrics.likes, 128);
        assert_eq!(
            p.metrics.reposts, 14,
            "`retweets` was not mapped to reposts"
        );
        assert_eq!(p.metrics.replies, 9);
        assert_eq!(p.metrics.quotes, 2, "`quotes` is easy to miss");
        assert_eq!(p.metrics.views, 20431);
        assert_eq!(p.metrics.bookmarks, 6);
    }

    #[test]
    fn a_repost_keeps_the_original_author_and_names_the_reposter_separately() {
        // This is the single most misreadable part of the schema: for a repost
        // twitter-cli replaces the payload with the ORIGINAL post and reports
        // the reposter only as a bare handle.
        let p = &parse_feed(FEED, "twitter-cli").unwrap().posts[1];
        assert!(p.is_repost);
        assert_eq!(p.author.username, "fake_two_bb", "author is the original");
        assert_eq!(p.reposted_by.as_ref().unwrap().username, "fake_relay_qq");
        assert_eq!(p.metrics.likes, 4102, "metrics belong to the original post");
    }

    #[test]
    fn a_null_reposted_by_does_not_become_an_author() {
        let p = &parse_feed(FEED, "twitter-cli").unwrap().posts[0];
        assert!(!p.is_repost);
        assert!(p.reposted_by.is_none());
    }

    #[test]
    fn timestamps_come_from_the_iso_field_not_the_host_local_one() {
        let p = &parse_feed(FEED, "twitter-cli").unwrap().posts[0];
        // createdAtLocal is "2026-03-07 08:51" on a UTC+3 host; using it would
        // silently shift every timestamp by the machine's offset.
        assert!(
            p.created_at.starts_with("2026-03-07T05:51:02"),
            "{}",
            p.created_at
        );
    }

    #[test]
    fn a_permalink_is_derived_because_the_payload_has_none() {
        let page = parse_feed(FEED, "twitter-cli").unwrap();
        assert_eq!(
            page.posts[0].url.as_deref(),
            Some("https://x.com/fake_dev_zz/status/1897452310098765432")
        );
    }

    #[test]
    fn arabic_text_survives_parsing_intact() {
        let p = &parse_feed(FEED, "twitter-cli").unwrap().posts[1];
        assert!(p.text.contains("قارئ"), "{}", p.text);
        assert_eq!(p.lang.as_deref(), Some("ar"));
    }

    #[test]
    fn media_is_read_from_the_single_typed_array() {
        let p = &parse_feed(FEED, "twitter-cli").unwrap().posts[0];
        assert_eq!(p.media.len(), 1);
        assert_eq!(p.media[0].kind, MediaKind::Image);
        assert_eq!(p.media[0].width, Some(1600));
        assert_eq!(p.media[0].height, Some(900));
    }

    #[test]
    fn video_media_is_the_mp4_itself_and_advertises_no_fake_qualities() {
        let p = &parse_feed(BOOKMARKS, "twitter-cli").unwrap().posts[0];
        assert_eq!(p.media[0].kind, MediaKind::Video);
        assert!(p.media[0].url.ends_with(".mp4"));
        assert!(
            p.media[0].variants.is_empty(),
            "a quality picker was offered for a payload with one stream"
        );
    }

    #[test]
    fn a_quoted_post_is_shallow_and_invents_no_timestamp_or_metrics() {
        let p = &parse_feed(BOOKMARKS, "twitter-cli").unwrap().posts[0];
        let q = p.quoted.as_ref().expect("quotedTweet was not mapped");
        assert_eq!(q.id, "1895117788990011223");
        assert_eq!(q.author.username, "fake_two_bb");
        assert_eq!(q.author.display_name, "Fake Author Two");
        assert!(
            q.created_at.is_none(),
            "a timestamp was invented for a quote"
        );
        assert!(q.media.is_empty());
        assert_eq!(
            q.url.as_deref(),
            Some("https://x.com/fake_two_bb/status/1895117788990011223")
        );
    }

    #[test]
    fn live_posts_are_never_marked_promoted_because_no_such_field_exists() {
        for raw in [FEED, BOOKMARKS] {
            for p in parse_feed(raw, "twitter-cli").unwrap().posts {
                assert!(!p.is_promoted);
                assert!(p.in_reply_to.is_none());
            }
        }
    }

    #[test]
    fn no_cursor_is_ever_reported_because_the_backend_exposes_none() {
        assert!(parse_feed(FEED, "twitter-cli").unwrap().cursor.is_none());
    }

    #[test]
    fn an_empty_array_is_an_empty_page_not_an_error() {
        let page = parse_feed(r#"{"ok":true,"schema_version":"1","data":[]}"#, "x").unwrap();
        assert!(page.posts.is_empty());
    }

    #[test]
    fn posts_that_map_to_nothing_are_reported_rather_than_dropped_silently() {
        let raw = r#"{"ok":true,"schema_version":"1","data":[{"unexpected":1},{"other":2}]}"#;
        let err = parse_feed(raw, "x").unwrap_err();
        assert_eq!(err.code, ErrorCode::SchemaChanged);
    }

    #[test]
    fn empty_output_is_an_error_not_a_success() {
        assert_eq!(
            parse_feed("   ", "x").unwrap_err().code,
            ErrorCode::EmptyResponse
        );
    }

    #[test]
    fn invalid_json_is_reported() {
        assert_eq!(
            parse_feed("{not json", "x").unwrap_err().code,
            ErrorCode::InvalidJson
        );
    }

    #[test]
    fn leading_log_noise_before_the_json_is_skipped() {
        let raw = format!("WARNING: something\r\n{FEED}");
        assert_eq!(parse_feed(&raw, "x").unwrap().posts.len(), 2);
    }

    #[test]
    fn an_article_post_is_recognised_by_its_title() {
        let raw = r#"{"ok":true,"schema_version":"1","data":[{"id":"1","text":"body",
            "author":{"screenName":"a","name":"A"},"createdAtISO":"2026-01-01T00:00:00Z",
            "articleTitle":"The long read",
            "isRetweet":false,"retweetedBy":null}]}"#;
        let p = &parse_feed(raw, "x").unwrap().posts[0];
        assert!(p.is_article);
        assert_eq!(p.article_title.as_deref(), Some("The long read"));
    }

    // -- accounts and profiles ---------------------------------------------

    #[test]
    fn parses_the_following_user_list_shape() {
        let users = parse_accounts(USERS).unwrap();
        assert_eq!(users.len(), 2);

        let first = &users[0];
        assert_eq!(first.username, "fake_two_bb", "`screenName` was not mapped");
        assert_eq!(first.display_name, "Fake Author Two");
        assert_eq!(first.followers_count, Some(48210));
        assert_eq!(first.following_count, Some(302));
        assert_eq!(first.posts_count, Some(19477), "`tweets` was not mapped");
        assert_eq!(
            first.bio.as_deref(),
            Some("Systems, storage, and strong opinions about caches.")
        );
        assert_eq!(first.location.as_deref(), Some("Nowhere"));
        assert_eq!(
            first.website.as_deref(),
            Some("https://example.invalid/two")
        );
        assert!(first
            .joined_at
            .as_deref()
            .unwrap()
            .starts_with("2015-09-14"));
    }

    #[test]
    fn empty_strings_are_treated_as_missing_rather_than_rendered_as_blanks() {
        // twitter-cli writes "" not null for an unset bio/location/website.
        let second = &parse_accounts(USERS).unwrap()[1];
        assert!(second.bio.is_none());
        assert!(second.location.is_none());
        assert!(second.website.is_none());
    }

    #[test]
    fn arabic_display_names_are_preserved() {
        let second = &parse_accounts(USERS).unwrap()[1];
        assert_eq!(second.display_name, "قارئ ثلاثة");
    }

    #[test]
    fn no_account_shape_ever_produces_a_banner_because_none_is_published() {
        for a in parse_accounts(USERS).unwrap() {
            assert!(a.banner_url.is_none());
        }
    }

    #[test]
    fn an_unreadable_account_payload_is_an_error_not_an_empty_following_list() {
        // "you follow nobody" and "we could not read the response" must never
        // render identically.
        let raw = r#"{"ok":true,"schema_version":"1","data":[{"nope":1}]}"#;
        assert_eq!(
            parse_accounts(raw).unwrap_err().code,
            ErrorCode::SchemaChanged
        );
        let raw = r#"{"ok":true,"schema_version":"1","data":{"users":[]}}"#;
        assert_eq!(
            parse_accounts(raw).unwrap_err().code,
            ErrorCode::SchemaChanged
        );
    }

    #[test]
    fn an_empty_following_list_is_a_legitimate_empty_result() {
        assert!(
            parse_accounts(r#"{"ok":true,"schema_version":"1","data":[]}"#)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_whoami_shape_uses_username_and_nests_under_data_user() {
        let data = unwrap_envelope(WHOAMI).unwrap();
        let author = map_author(data.get("user").unwrap());
        assert_eq!(author.username, "fake_dev_zz");
        assert_eq!(author.display_name, "Fake Dev");
        assert_eq!(author.posts_count, Some(5904));
    }

    #[test]
    fn a_tweet_embedded_author_maps_from_only_five_keys() {
        let v: Value = serde_json::from_str(
            r#"{"id":"1","name":"N","screenName":"h","profileImageUrl":"u","verified":true}"#,
        )
        .unwrap();
        let a = map_author(&v);
        assert_eq!(a.username, "h");
        assert_eq!(a.avatar_url.as_deref(), Some("u"));
        assert!(a.verified);
        // Nothing the payload does not contain may be filled in.
        assert!(a.bio.is_none());
        assert!(a.followers_count.is_none());
        assert!(a.joined_at.is_none());
    }

    // -- status -------------------------------------------------------------

    #[test]
    fn status_reports_the_authenticated_account() {
        let s = parse_status(STATUS_OK).unwrap();
        assert!(s.authenticated);
        assert_eq!(s.username.as_deref(), Some("fake_dev_zz"));
        let account = s.account.expect("status should carry the profile");
        assert_eq!(account.display_name, "Fake Dev");
        assert_eq!(account.following_count, Some(2));
    }

    #[test]
    fn status_without_credentials_surfaces_as_an_auth_error_not_a_false_flag() {
        // There is no {"authenticated": false} shape; a parser that looked for
        // one would report "connected" for an account that is not.
        let err = parse_status(NOT_AUTHENTICATED).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAuthenticated);
        assert!(is_auth_error(&err));
    }

    #[test]
    fn an_unreadable_status_payload_never_claims_authentication() {
        for raw in [
            r#"{"ok":true,"schema_version":"1","data":{}}"#,
            r#"{"ok":true,"schema_version":"1","data":{"authenticated":false}}"#,
        ] {
            assert!(!parse_status(raw).unwrap().authenticated, "{raw}");
        }
    }

    // -- command construction and safety ------------------------------------

    #[test]
    fn write_operations_are_refused_before_a_process_is_spawned() {
        let p = TwitterCliProvider::detached();
        for op in crate::security::BLOCKED_OPS {
            let err = p.run_op(op, &[]).unwrap_err();
            assert_eq!(
                err.code,
                ErrorCode::BlockedOperation,
                "op {op} was not blocked"
            );
        }
    }

    #[test]
    fn the_near_miss_write_commands_are_all_blocked() {
        // `favorite`/`bookmark`/`like`/`follow` are one character from the
        // read-only commands we do use, and every one of them mutates the
        // account with no confirmation prompt.
        let p = TwitterCliProvider::detached();
        for op in ["favorite", "bookmark", "like", "follow", "retweet"] {
            assert_eq!(
                p.run_op(op, &[]).unwrap_err().code,
                ErrorCode::BlockedOperation,
                "{op}"
            );
        }
    }

    #[test]
    fn arbitrary_operations_are_refused() {
        let p = TwitterCliProvider::detached();
        for op in ["rm -rf /", "feed; post", "likes", "show", "tweet", ""] {
            assert_eq!(
                p.run_op(op, &[]).unwrap_err().code,
                ErrorCode::BlockedOperation,
                "{op}"
            );
        }
    }

    #[test]
    fn a_handle_that_could_be_read_as_a_flag_is_rejected_before_spawning() {
        let p = TwitterCliProvider::detached();
        for bad in ["--output", "-o evil", "a b", "reader;post"] {
            let err = p.get_user_profile(bad).unwrap_err();
            assert_eq!(err.code, ErrorCode::ApiError, "{bad}");
            assert!(err.message.contains("valid X handle"), "{}", err.message);
        }
    }

    #[test]
    fn a_non_numeric_list_id_is_rejected() {
        let p = TwitterCliProvider::detached();
        assert!(p.get_list_timeline("--output", 10).is_err());
        assert!(p.get_list_timeline("abc", 10).is_err());
    }

    #[test]
    fn missing_tool_is_reported_cleanly() {
        let p = TwitterCliProvider {
            bin: None,
            timeout: Duration::from_secs(1),
            store: Arc::new(crate::credentials::MemoryStore::new()),
        };
        assert_eq!(
            p.get_following_feed(5, None).unwrap_err().code,
            ErrorCode::ToolMissing
        );
    }

    #[test]
    fn classic_twitter_timestamps_normalize() {
        let out = normalize_time(Some("Wed Oct 05 20:14:03 +0000 2022".into()));
        assert!(out.unwrap().starts_with("2022-10-05"));
    }

    #[test]
    fn a_post_without_a_parseable_timestamp_is_dropped() {
        let value: Value = serde_json::json!({
            "id": "missing-time",
            "text": "not enough data",
            "author": { "id": "a", "name": "A", "screenName": "a" },
            "createdAtISO": "not-a-timestamp"
        });
        assert!(map_post(&value, "twitter-cli").is_none());
    }

    #[test]
    fn stderr_classification_covers_the_no_envelope_failures() {
        assert_eq!(
            classify_error("RuntimeError: no twitter cookies found")
                .unwrap()
                .code,
            ErrorCode::NotAuthenticated
        );
        assert_eq!(
            classify_error("HTTP 429 Too Many Requests").unwrap().code,
            ErrorCode::RateLimited
        );
        assert_eq!(
            classify_error("socket.gaierror: getaddrinfo failed")
                .unwrap()
                .code,
            ErrorCode::NetworkUnavailable
        );
        assert_eq!(
            classify_error("UnicodeEncodeError: charmap codec cannot encode")
                .unwrap()
                .code,
            ErrorCode::ProcessCrashed
        );
        assert!(classify_error("Fetched 20 posts").is_none());
    }

    #[test]
    fn traceback_and_usage_helpers_pick_the_informative_line() {
        let traceback =
            "Traceback (most recent call last):\n  File x, line 1\n\nRuntimeError: Invalid tweet ID: abc\n";
        assert_eq!(last_line(traceback), "RuntimeError: Invalid tweet ID: abc");
        let usage = "Usage: twitter search [OPTIONS] [QUERY]\n\nError: Provide a QUERY.";
        assert_eq!(first_line(usage), "Usage: twitter search [OPTIONS] [QUERY]");
    }

    #[test]
    fn no_parsed_output_can_carry_a_credential_into_an_error_message() {
        let raw = r#"{"ok":false,"schema_version":"1","error":{"code":"api_error",
            "message":"request failed with auth_token=a1b2c3d4e5f6a7b8c9d0 and ct0=deadbeefdeadbeef"}}"#;
        let err = unwrap_envelope(raw).unwrap_err();
        assert!(
            !err.message.contains("a1b2c3d4e5f6a7b8c9d0"),
            "{}",
            err.message
        );
        assert!(!err.message.contains("deadbeefdeadbeef"), "{}", err.message);
    }

    // -----------------------------------------------------------------------
    // twitter-cli 0.8.6
    // -----------------------------------------------------------------------
    //
    // Shapes below were taken from real 0.8.6 responses via
    // `cargo run --example probe_live -- shape …`, which prints key paths and
    // types only. The values here are synthetic; the structure is not.

    /// A 0.8.6 feed envelope: four root keys, `pagination` beside `data`.
    const FEED_0_8_6: &str = r#"{"ok":true,"schema_version":"1","data":[{
        "id":"1900000000000000001","text":"hello","lang":"en",
        "createdAtISO":"2026-07-20T10:00:00+00:00","isRetweet":false,
        "isPromoted":false,"isSubscriberOnly":false,"retweetedBy":null,
        "author":{"id":"111","name":"A","screenName":"a_dev","verified":true,
        "profileImageUrl":"https://pbs.twimg.com/profile_images/a.jpg"},
        "media":[],"urls":[],"metrics":{"replies":1,"retweets":2,"likes":3,
        "quotes":0,"views":9,"bookmarks":0}}],
        "pagination":{"nextCursor":"DAABCgABGvcNs__AJxEKAAIY7T0v-QwnEAgAAwAAAAEAAA"}}"#;

    #[test]
    fn the_pagination_sibling_becomes_the_feed_cursor() {
        // 0.8.6 put `pagination` next to `data`, not inside it. Reading it from
        // the wrong level would silently disable Load More.
        let page = parse_feed(FEED_0_8_6, "twitter-cli").unwrap();
        assert_eq!(page.posts.len(), 1);
        assert_eq!(
            page.cursor.as_deref(),
            Some("DAABCgABGvcNs__AJxEKAAIY7T0v-QwnEAgAAwAAAAEAAA")
        );
    }

    #[test]
    fn a_command_without_pagination_reports_no_cursor() {
        // `search`, `user-posts` and `bookmarks` omit the key entirely. The
        // cursor must come out `None` so the UI never offers a Load More that
        // cannot work — this is the capability detection, not a lookup table.
        let no_pagination = FEED_0_8_6
            .replace(
                ",\n        \"pagination\":{\"nextCursor\":\"DAABCgABGvcNs__AJxEKAAIY7T0v-QwnEAgAAwAAAAEAAA\"}",
                "",
            );
        let page = parse_feed(&no_pagination, "twitter-cli").unwrap();
        assert!(page.cursor.is_none(), "cursor: {:?}", page.cursor);
    }

    #[test]
    fn an_empty_cursor_string_is_treated_as_absent() {
        // "" handed back to `--cursor` means "start over", which would loop the
        // feed forever instead of ending it.
        let raw = FEED_0_8_6.replace("DAABCgABGvcNs__AJxEKAAIY7T0v-QwnEAgAAwAAAAEAAA", "");
        assert!(parse_feed(&raw, "twitter-cli").unwrap().cursor.is_none());
    }

    #[test]
    fn the_real_promoted_flag_is_read_rather_than_assumed_false() {
        // 0.8.5 had no such field and this was hardcoded `false`.
        let promoted = FEED_0_8_6.replace("\"isPromoted\":false", "\"isPromoted\":true");
        let page = parse_feed(&promoted, "twitter-cli").unwrap();
        assert!(page.posts[0].is_promoted);
        assert!(!parse_feed(FEED_0_8_6, "twitter-cli").unwrap().posts[0].is_promoted);
    }

    #[test]
    fn capabilities_do_not_claim_unsupported_cursors() {
        // `following` and `user-posts` take no cursor. Claiming otherwise would
        // put a Load more button in the interface that could only re-fetch
        // page one.
        let caps = TwitterCliProvider::detached().capabilities();
        assert!(caps.feed_cursor && caps.list_cursor);
        assert!(!caps.following_cursor);
        assert!(!caps.user_posts_cursor);
    }

    #[test]
    fn capabilities_admit_that_mute_and_block_do_not_exist() {
        // `follow` and `unfollow` are real subcommands on the pinned build.
        // `mute` and `block` are not, and the honest answer is what lets the
        // interface say so rather than offer an action that must fail.
        let caps = TwitterCliProvider::detached().capabilities();
        assert!(caps.follow && caps.unfollow);
        assert!(!caps.mute);
        assert!(!caps.block);
    }

    #[test]
    fn unbookmark_validates_the_numeric_id_before_spawning() {
        let provider = TwitterCliProvider::detached();
        let permit = security::BookmarkPermit::confirmed(true).unwrap();
        let error = provider.remove_bookmark("not-a-tweet-id", &permit).unwrap_err();
        assert_eq!(error.code, ErrorCode::ApiError);
    }

    #[test]
    fn a_write_still_refuses_an_operation_outside_the_gated_set() {
        // The permit carries the operation name, so this is the check that
        // stops a future permit variant from reaching the command line just
        // because it exists.
        for op in security::GATED_WRITE_OPS {
            assert!(!security::is_unavailable(op), "{op} is not a real command");
        }
    }

    #[test]
    fn the_pinned_commit_is_a_full_length_sha() {
        // A short sha would still resolve at install time but would not pin.
        assert_eq!(PINNED_COMMIT.len(), 40);
        assert!(PINNED_COMMIT.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(PINNED_INSTALL_HINT.contains(PINNED_COMMIT));
    }

    #[test]
    fn the_version_line_is_reduced_to_a_bare_version() {
        assert_eq!(
            parse_version("twitter, version 0.8.6").as_deref(),
            Some("0.8.6")
        );
        assert_eq!(
            parse_version("  twitter, version 0.8.6  ").as_deref(),
            Some("0.8.6")
        );
        assert_eq!(parse_version("command not found"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn a_hostile_cursor_never_reaches_the_argument_array() {
        // A cursor round-trips through the frontend, so on the way back it is
        // untrusted. A leading `-` would be parsed as a flag by click.
        assert!(clean_cursor(Some("-o=/tmp/pwned")).is_none());
        assert!(clean_cursor(Some("has space")).is_none());
        assert!(clean_cursor(Some("new\nline")).is_none());
        assert!(clean_cursor(Some(&"x".repeat(600))).is_none());
        assert!(clean_cursor(Some("")).is_none());
        assert!(clean_cursor(None).is_none());
        // The real shape from a live response must survive.
        assert_eq!(
            clean_cursor(Some("DAABCgABGvcNs__AJxEKAAIY7T0v-QwnEAgAAwAAAAEAAA")).as_deref(),
            Some("DAABCgABGvcNs__AJxEKAAIY7T0v-QwnEAgAAwAAAAEAAA")
        );
    }

    #[test]
    fn a_repeated_cursor_is_detectable_by_the_caller() {
        // The feed engine stops when the cursor stops advancing. That check is
        // only possible because the parsed cursor is the raw one, unmodified.
        let page = parse_feed(FEED_0_8_6, "twitter-cli").unwrap();
        let again = parse_feed(FEED_0_8_6, "twitter-cli").unwrap();
        assert_eq!(page.cursor, again.cursor);
    }
}

/// Media variants, which exist only on a patched backend.
///
/// Stock 0.8.6 sorts a video's MP4 renditions by bitrate and keeps `[0]`; the
/// project patch in `tools/twitter-cli/` preserves all of them. Both shapes
/// reach this parser in the field, so both are tested here.
#[cfg(test)]
mod variant_tests {
    use super::*;

    fn media(variants: Value) -> Value {
        serde_json::json!({
            "media": [{
                "type": "video",
                "url": "https://video.twimg.com/ext/1280x720/a.mp4",
                "width": 1280,
                "height": 720,
                "variants": variants,
            }]
        })
    }

    #[test]
    fn an_unpatched_backend_yields_no_variants() {
        // The stock build emits no `variants` key at all. The interface must
        // then show one honest quality, not a picker with an invented entry.
        let v = serde_json::json!({
            "media": [{ "type": "video", "url": "https://video.twimg.com/a.mp4" }]
        });
        assert!(map_media(&v)[0].variants.is_empty());
    }

    #[test]
    fn an_empty_variant_list_yields_no_variants() {
        assert!(map_media(&media(serde_json::json!([])))[0]
            .variants
            .is_empty());
    }

    #[test]
    fn renditions_are_labelled_by_resolution_and_ordered_largest_first() {
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/ext/640x360/b.mp4", "contentType": "video/mp4",
             "bitrate": 832000, "width": 640, "height": 360},
            {"url": "https://video.twimg.com/ext/1280x720/a.mp4", "contentType": "video/mp4",
             "bitrate": 2176000, "width": 1280, "height": 720},
        ])));
        let labels: Vec<_> = out[0].variants.iter().map(|v| v.label.as_str()).collect();
        assert_eq!(labels, vec!["720p", "360p"]);
    }

    #[test]
    fn a_portrait_ladder_is_named_by_its_shorter_side() {
        // The exact shape a real bookmarked clip produced: 9:16 vertical, four
        // renditions. Naming these by height offered "1920p / 1280p / 852p /
        // 568p" — every number inflated, and the top one reading as 4K.
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/ext/320x568/d.mp4", "contentType": "video/mp4",
             "bitrate": 632000, "width": 320, "height": 568},
            {"url": "https://video.twimg.com/ext/1080x1920/a.mp4", "contentType": "video/mp4",
             "bitrate": 6500000, "width": 1080, "height": 1920},
            {"url": "https://video.twimg.com/ext/480x852/c.mp4", "contentType": "video/mp4",
             "bitrate": 950000, "width": 480, "height": 852},
            {"url": "https://video.twimg.com/ext/720x1280/b.mp4", "contentType": "video/mp4",
             "bitrate": 2176000, "width": 720, "height": 1280},
        ])));
        let labels: Vec<_> = out[0].variants.iter().map(|v| v.label.as_str()).collect();
        assert_eq!(labels, vec!["1080p", "720p", "480p", "320p"]);
    }

    #[test]
    fn a_square_video_is_named_by_the_side_it_shares() {
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/ext/720x720/a.mp4", "contentType": "video/mp4",
             "bitrate": 2176000, "width": 720, "height": 720},
        ])));
        assert_eq!(out[0].variants[0].label, "720p");
    }

    #[test]
    fn a_lone_height_is_still_usable_as_a_label() {
        // X has always described landscape renditions by height, so a variant
        // carrying only one dimension is taken at face value rather than
        // dropped down to its bitrate.
        assert_eq!(
            MediaVariant::label_for(None, Some(720), Some(2176000)),
            Some("720p".to_string())
        );
        assert_eq!(
            MediaVariant::label_for(Some(1280), None, None),
            Some("1280p".to_string())
        );
        assert_eq!(
            MediaVariant::label_for(None, None, Some(832000)),
            Some("832 kbps".to_string())
        );
        assert_eq!(MediaVariant::label_for(None, None, None), None);
        assert_eq!(MediaVariant::label_for(Some(0), Some(0), Some(0)), None);
    }

    #[test]
    fn a_playlist_is_never_offered_as_a_quality() {
        // HLS cannot play through the proxy, so listing it would be a choice
        // that always fails.
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/x.m3u8", "contentType": "application/x-mpegURL"},
            {"url": "https://video.twimg.com/ext/640x360/b.mp4", "contentType": "video/mp4",
             "bitrate": 832000, "width": 640, "height": 360},
        ])));
        assert_eq!(out[0].variants.len(), 1);
        assert_eq!(out[0].variants[0].label, "360p");
    }

    #[test]
    fn one_size_appears_once_keeping_the_better_encode() {
        // X routinely publishes two encodes of the same resolution.
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/ext/640x360/low.mp4", "contentType": "video/mp4",
             "bitrate": 400000, "width": 640, "height": 360},
            {"url": "https://video.twimg.com/ext/640x360/high.mp4", "contentType": "video/mp4",
             "bitrate": 832000, "width": 640, "height": 360},
        ])));
        assert_eq!(out[0].variants.len(), 1);
        assert_eq!(out[0].variants[0].bitrate, Some(832_000));
        assert!(out[0].variants[0].url.ends_with("high.mp4"));
    }

    #[test]
    fn a_rendition_with_no_resolution_falls_back_to_its_bitrate() {
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/x/a.mp4", "contentType": "video/mp4",
             "bitrate": 832000},
        ])));
        assert_eq!(out[0].variants[0].label, "832 kbps");
    }

    #[test]
    fn a_rendition_that_cannot_be_named_is_dropped() {
        // Neither resolution nor bitrate. There is no truthful label for it, so
        // it is not offered rather than listed as something vague.
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/x/a.mp4", "contentType": "video/mp4"},
        ])));
        assert!(out[0].variants.is_empty());
    }

    #[test]
    fn the_primary_url_is_unchanged_by_the_patch() {
        // Backward compatibility: `url` still means the largest rendition, so
        // an unpatched and a patched backend agree about it.
        let out = map_media(&media(serde_json::json!([
            {"url": "https://video.twimg.com/ext/640x360/b.mp4", "contentType": "video/mp4",
             "bitrate": 832000, "width": 640, "height": 360},
        ])));
        assert_eq!(out[0].url, "https://video.twimg.com/ext/1280x720/a.mp4");
    }
}
