//! Session health.
//!
//! One place decides whether the app currently has a working X session, so the
//! sidebar dot, the Home header, Diagnostics and every guarded provider call
//! all agree.
//!
//! Deliberately free of I/O: nothing here spawns a process or opens a socket.
//! The caller performs the probe and hands the outcome to [`SessionManager::apply`].
//! That keeps the state machine exhaustively testable without a live account,
//! and keeps the expensive part (a `twitter-cli status` subprocess) under the
//! caller's scheduling control so it never lands on a hot UI path.

use crate::credentials::CredentialStore;
use crate::models::{AppError, Author, ErrorCode};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::sync::Mutex;

/// The four states the interface renders. Colour is *never* the only cue: each
/// state carries a `reason` the UI turns into visible text and an accessible
/// label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    /// Green — authenticated and the last provider request succeeded.
    Connected,
    /// Yellow — a session exists but is degraded, rate-limited, stale or
    /// awaiting confirmation.
    Degraded,
    /// Red — credentials are expired, invalid or rejected, or the backend
    /// cannot run at all.
    Expired,
    /// Grey — no credentials stored, or nothing has been checked yet.
    Disconnected,
}

/// Why we are in that state. Maps 1:1 onto an i18n key, so the message the
/// user reads is translated rather than an English string from the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionReason {
    /// No credentials have been saved.
    NoCredentials,
    /// Credentials exist but have not been validated in this run yet.
    NotChecked,
    /// A validation request is in flight.
    Checking,
    /// Authenticated and working.
    Ok,
    /// Authenticated, but the most recent request failed for a non-auth reason.
    RequestFailed,
    /// X is rate limiting us.
    RateLimited,
    /// No network.
    Offline,
    /// The last successful check is old enough that we no longer trust it.
    Stale,
    /// X rejected the credentials.
    AuthFailed,
    /// twitter-cli is not installed.
    ToolMissing,
}

impl SessionReason {
    /// The state each reason implies.
    pub fn state(self) -> SessionState {
        use SessionReason::*;
        match self {
            NoCredentials | NotChecked => SessionState::Disconnected,
            Ok => SessionState::Connected,
            Checking | RequestFailed | RateLimited | Offline | Stale => SessionState::Degraded,
            AuthFailed | ToolMissing => SessionState::Expired,
        }
    }

    /// True when the app must stop issuing provider requests and show
    /// "Reconnect required" instead.
    pub fn blocks_requests(self) -> bool {
        matches!(
            self,
            SessionReason::AuthFailed | SessionReason::NoCredentials | SessionReason::ToolMissing
        )
    }
}

/// What the UI needs to render the indicator and the account chip.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub state: SessionState,
    pub reason: SessionReason,
    /// True while a validation is in flight, so the dot can show activity
    /// without discarding the state it already had.
    pub checking: bool,
    /// Safe identity of the connected account. Never contains a secret.
    pub account: Option<Author>,
    pub checked_at: Option<String>,
    pub last_success_at: Option<String>,
    /// How long the last **successful** provider health request took, end to
    /// end: from immediately before the operation starts until its structured
    /// result has been parsed. Not a network ping: it includes child-process
    /// startup, the round trip to X, and parsing, because that is what the
    /// reader actually waits for.
    ///
    /// `None` when nothing has completed. It is never guessed at: a failed or
    /// in-flight request leaves the previous value alone rather than inventing
    /// one, and clearing the session clears this with it.
    pub latency_ms: Option<u64>,
    pub has_credentials: bool,
    /// Sanitised English detail for Diagnostics. The interface shows the
    /// translated `reason`, not this.
    pub detail: Option<String>,
}

impl SessionSnapshot {
    fn disconnected(has_credentials: bool) -> Self {
        let reason = if has_credentials {
            SessionReason::NotChecked
        } else {
            SessionReason::NoCredentials
        };
        Self {
            state: reason.state(),
            reason,
            checking: false,
            account: None,
            checked_at: None,
            last_success_at: None,
            latency_ms: None,
            has_credentials,
            detail: None,
        }
    }
}

/// Outcome of one validation attempt.
///
/// The error is boxed so a failure does not carry two heap strings inline.
/// The success variant stays unboxed even though `Author` is the larger of the
/// two: a `Probe` is constructed at most a few times per session, so boxing the
/// common path would buy nothing and would push a `Box` into every call site.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum Probe {
    /// `status`/`whoami` confirmed a working session.
    Authenticated { account: Option<Author> },
    /// The probe ran and told us something is wrong.
    Failed(Box<AppError>),
}

impl Probe {
    /// Convenience constructor so callers need not box by hand.
    pub fn failed(e: AppError) -> Self {
        Probe::Failed(Box::new(e))
    }
}

/// After this long without a successful check, a session is shown as stale
/// (yellow) rather than continuing to claim green.
const STALE_AFTER_MINUTES: i64 = 30;

pub struct SessionManager {
    store: Box<dyn CredentialStore>,
    snapshot: Mutex<SessionSnapshot>,
}

impl SessionManager {
    pub fn new(store: Box<dyn CredentialStore>) -> Self {
        let has = store.has();
        Self {
            store,
            snapshot: Mutex::new(SessionSnapshot::disconnected(has)),
        }
    }

    pub fn store(&self) -> &dyn CredentialStore {
        self.store.as_ref()
    }

    /// Whether credentials are stored, asked of the store every time.
    ///
    /// Deliberately **not** cached. A cache was tried and reverted: it made
    /// `deleting_the_credentials_forces_grey_even_after_a_green_probe` fail,
    /// because credentials removed out of band — by this test, by another
    /// process, or by the user in Credential Manager — would go unnoticed and
    /// the interface would keep claiming a session it no longer has. Reading
    /// presence is cheap and local; being wrong about it is not.
    pub fn has_credentials(&self) -> bool {
        self.store.has()
    }

    /// Current state without re-opening the credential store.
    ///
    /// Startup callers use this while another health probe already owns the
    /// provider slot. Re-reading Windows Credential Manager every 100 ms while
    /// joining one in-flight request adds IPC/local-store work exactly where
    /// launch latency is most visible. A normal `snapshot()` still performs
    /// the out-of-band credential-presence check at real session boundaries.
    pub fn snapshot_cached(&self) -> SessionSnapshot {
        let mut s = self.snapshot.lock().unwrap().clone();
        if s.reason == SessionReason::Ok && is_stale(s.last_success_at.as_deref()) {
            s.reason = SessionReason::Stale;
            s.state = SessionState::Degraded;
        }
        s
    }

    /// Current state, with staleness applied at read time so a long-idle
    /// window does not keep claiming a green dot.
    pub fn snapshot(&self) -> SessionSnapshot {
        let mut s = self.snapshot_cached();
        s.has_credentials = self.has_credentials();
        if !s.has_credentials {
            return SessionSnapshot::disconnected(false);
        }
        if s.reason == SessionReason::Ok && is_stale(s.last_success_at.as_deref()) {
            s.reason = SessionReason::Stale;
            s.state = SessionState::Degraded;
        }
        s
    }

    pub fn set_checking(&self, checking: bool) {
        self.snapshot.lock().unwrap().checking = checking;
    }

    /// Record the result of a validation attempt.
    pub fn apply(&self, probe: Probe) -> SessionSnapshot {
        let now = Utc::now().to_rfc3339();
        let mut s = self.snapshot.lock().unwrap();
        s.checking = false;
        s.checked_at = Some(now.clone());
        s.has_credentials = self.has_credentials();

        match probe {
            Probe::Authenticated { account } => {
                s.reason = SessionReason::Ok;
                s.state = SessionState::Connected;
                s.last_success_at = Some(now);
                s.detail = None;
                // A probe that returns no profile must not erase the identity
                // we already resolved — `status` is cheaper than `whoami` and
                // legitimately carries no account.
                if account.is_some() {
                    s.account = account;
                }
            }
            Probe::Failed(e) => {
                s.reason = reason_for(&e);
                s.state = s.reason.state();
                s.detail = Some(e.message.clone());
                if s.reason == SessionReason::AuthFailed {
                    // The stored identity belongs to a session that no longer
                    // works; showing it beside a red dot would be misleading,
                    // and so would a latency measured against it.
                    s.account = None;
                    s.latency_ms = None;
                }
            }
        }
        s.clone()
    }

    /// Record how long a completed provider operation took.
    ///
    /// Only ever called with a measurement that actually finished. A timeout or
    /// a crash leaves the previous figure in place rather than replacing it
    /// with the time it took to fail, which would read as a very slow
    /// connection when in fact nothing came back at all.
    pub fn note_latency(&self, ms: u64) {
        self.snapshot.lock().unwrap().latency_ms = Some(ms);
    }

    /// A provider request succeeded. Green requires *both* an authenticated
    /// session and a working last request, so this refreshes the success clock.
    pub fn note_request_success(&self) {
        let mut s = self.snapshot.lock().unwrap();
        if s.reason != SessionReason::AuthFailed && s.reason != SessionReason::NoCredentials {
            s.reason = SessionReason::Ok;
            s.state = SessionState::Connected;
            s.last_success_at = Some(Utc::now().to_rfc3339());
            s.detail = None;
        }
    }

    /// A provider request failed. Downgrades the dot without pretending we
    /// re-validated the session.
    pub fn note_request_failure(&self, e: &AppError) {
        let mut s = self.snapshot.lock().unwrap();
        s.reason = reason_for(e);
        s.state = s.reason.state();
        s.detail = Some(e.message.clone());
        if s.reason == SessionReason::AuthFailed {
            s.account = None;
        }
    }

    /// Forget the current session state. Used by Disconnect and before an
    /// account replacement so no identity from the old account survives.
    ///
    pub fn reset(&self) {
        let has = self.has_credentials();
        *self.snapshot.lock().unwrap() = SessionSnapshot::disconnected(has);
    }

    /// Adopt an identity resolved outside a probe (e.g. `whoami` right after a
    /// successful connect).
    pub fn set_account(&self, account: Option<Author>) {
        self.snapshot.lock().unwrap().account = account;
    }

    pub fn account(&self) -> Option<Author> {
        self.snapshot.lock().unwrap().account.clone()
    }

    /// Should a periodic re-check run now?
    ///
    /// False when there is nothing to check, when a check is already in
    /// flight, or when health is already fresh — this is what keeps the
    /// conservative interval from turning into a polling loop.
    ///
    /// "Fresh" counts a successful provider request, not only a probe. A feed
    /// that came back is proof the session works, so spawning `twitter.exe
    /// status` to ask the same question would cost a subprocess to learn what
    /// the reader has already seen on screen.
    pub fn due_for_check(&self, interval_minutes: i64) -> bool {
        let s = self.snapshot.lock().unwrap();
        if s.checking || !self.store.has() {
            return false;
        }
        let newest = [s.checked_at.as_deref(), s.last_success_at.as_deref()]
            .into_iter()
            .flatten()
            .filter_map(parse_time)
            .max();
        match newest {
            None => true,
            Some(t) => Utc::now() - t >= ChronoDuration::minutes(interval_minutes.max(1)),
        }
    }
}

fn parse_time(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

fn is_stale(last_success: Option<&str>) -> bool {
    match last_success.and_then(parse_time) {
        None => false,
        Some(t) => Utc::now() - t > ChronoDuration::minutes(STALE_AFTER_MINUTES),
    }
}

/// Map a provider error onto a session reason.
fn reason_for(e: &AppError) -> SessionReason {
    match e.code {
        ErrorCode::NotAuthenticated | ErrorCode::CookieExpired => SessionReason::AuthFailed,
        ErrorCode::RateLimited => SessionReason::RateLimited,
        ErrorCode::NetworkUnavailable => SessionReason::Offline,
        ErrorCode::ToolMissing => SessionReason::ToolMissing,
        _ => SessionReason::RequestFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{MemoryStore, XCredentials};

    const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const CT0: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

    fn account() -> Author {
        Author {
            id: "1".into(),
            username: "reader".into(),
            display_name: "Reader".into(),
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

    fn connected_manager() -> SessionManager {
        let store = MemoryStore::new();
        store
            .save(&XCredentials::parse(TOKEN, CT0).unwrap())
            .unwrap();
        SessionManager::new(Box::new(store))
    }

    #[test]
    fn latency_is_absent_until_something_actually_completes() {
        // A fabricated 0 ms would read as an impossibly fast connection.
        let m = connected_manager();
        assert!(m.snapshot().latency_ms.is_none());
    }

    #[test]
    fn a_measured_latency_survives_in_the_snapshot() {
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        m.note_latency(842);
        assert_eq!(m.snapshot().latency_ms, Some(842));
    }

    #[test]
    fn a_failure_does_not_overwrite_the_last_good_latency() {
        // Reporting how long a request took to fail would show a timeout as
        // "the connection is 120000 ms slow" when nothing came back at all.
        let m = connected_manager();
        m.apply(Probe::Authenticated { account: None });
        m.note_latency(500);
        m.apply(Probe::failed(AppError::new(
            ErrorCode::RateLimited,
            "X is rate limiting this account.",
        )));

        let s = m.snapshot();
        assert_eq!(s.reason, SessionReason::RateLimited);
        assert_eq!(s.state, SessionState::Degraded);
        assert_eq!(s.latency_ms, Some(500), "the last good figure was lost");
    }

    #[test]
    fn an_expired_session_clears_the_latency_with_the_identity() {
        // Both belong to a session that no longer works.
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        m.note_latency(500);
        m.apply(Probe::failed(AppError::new(
            ErrorCode::CookieExpired,
            "The X session has expired.",
        )));

        let s = m.snapshot();
        assert_eq!(s.state, SessionState::Expired);
        assert!(s.account.is_none());
        assert!(s.latency_ms.is_none());
    }

    #[test]
    fn clearing_the_credentials_clears_the_latency_too() {
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        m.note_latency(300);
        assert_eq!(m.snapshot().latency_ms, Some(300));

        m.store().delete().unwrap();

        let s = m.snapshot();
        assert_eq!(s.state, SessionState::Disconnected);
        assert!(s.latency_ms.is_none(), "latency outlived the credentials");
        assert!(s.account.is_none());
    }

    #[test]
    fn credentials_removed_out_of_band_are_noticed_immediately() {
        // Someone can delete the entry in Windows Credential Manager while the
        // app is open. Presence is therefore re-read rather than cached, and
        // the very next snapshot must go grey without any reset call.
        let store = MemoryStore::new();
        store
            .save(&XCredentials::parse(TOKEN, CT0).unwrap())
            .unwrap();
        let m = SessionManager::new(Box::new(store));
        assert!(m.has_credentials());

        m.store().delete().unwrap();

        assert!(!m.has_credentials());
        assert_eq!(m.snapshot().reason, SessionReason::NoCredentials);
    }

    #[test]
    fn no_credentials_is_grey_and_blocks_requests() {
        let m = SessionManager::new(Box::new(MemoryStore::new()));
        let s = m.snapshot();
        assert_eq!(s.state, SessionState::Disconnected);
        assert_eq!(s.reason, SessionReason::NoCredentials);
        assert!(!s.has_credentials);
        assert!(s.reason.blocks_requests());
        assert!(s.account.is_none());
    }

    #[test]
    fn stored_but_unchecked_credentials_are_grey_not_green() {
        let m = connected_manager();
        let s = m.snapshot();
        assert_eq!(s.state, SessionState::Disconnected);
        assert_eq!(s.reason, SessionReason::NotChecked);
        assert!(s.has_credentials);
    }

    #[test]
    fn a_successful_probe_turns_the_dot_green_and_names_the_account() {
        let m = connected_manager();
        let s = m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        assert_eq!(s.state, SessionState::Connected);
        assert_eq!(s.reason, SessionReason::Ok);
        assert_eq!(s.account.unwrap().username, "reader");
        assert!(s.checked_at.is_some());
        assert!(s.last_success_at.is_some());
        assert!(!s.reason.blocks_requests());
    }

    #[test]
    fn a_probe_without_a_profile_keeps_the_identity_we_already_had() {
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        let s = m.apply(Probe::Authenticated { account: None });
        assert_eq!(s.account.unwrap().username, "reader");
    }

    #[test]
    fn rejected_credentials_are_red_and_drop_the_account() {
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        let s = m.apply(Probe::failed(AppError::new(
            ErrorCode::NotAuthenticated,
            "no session",
        )));
        assert_eq!(s.state, SessionState::Expired);
        assert_eq!(s.reason, SessionReason::AuthFailed);
        assert!(s.account.is_none(), "stale identity survived a red state");
        assert!(s.reason.blocks_requests());
    }

    #[test]
    fn an_expired_cookie_is_also_red() {
        let m = connected_manager();
        let s = m.apply(Probe::failed(AppError::new(
            ErrorCode::CookieExpired,
            "expired",
        )));
        assert_eq!(s.state, SessionState::Expired);
    }

    #[test]
    fn rate_limiting_is_yellow_and_does_not_block_requests() {
        let m = connected_manager();
        let s = m.apply(Probe::failed(AppError::new(ErrorCode::RateLimited, "429")));
        assert_eq!(s.state, SessionState::Degraded);
        assert_eq!(s.reason, SessionReason::RateLimited);
        assert!(!s.reason.blocks_requests());
    }

    #[test]
    fn being_offline_is_yellow_not_red() {
        let m = connected_manager();
        let s = m.apply(Probe::failed(AppError::new(
            ErrorCode::NetworkUnavailable,
            "offline",
        )));
        assert_eq!(s.state, SessionState::Degraded);
        assert_eq!(s.reason, SessionReason::Offline);
    }

    #[test]
    fn a_missing_backend_is_red() {
        let m = connected_manager();
        let s = m.apply(Probe::failed(AppError::new(
            ErrorCode::ToolMissing,
            "not installed",
        )));
        assert_eq!(s.state, SessionState::Expired);
        assert_eq!(s.reason, SessionReason::ToolMissing);
        assert!(s.reason.blocks_requests());
    }

    #[test]
    fn any_other_failure_is_yellow() {
        let m = connected_manager();
        for code in [
            ErrorCode::SchemaChanged,
            ErrorCode::ApiError,
            ErrorCode::ProcessTimeout,
            ErrorCode::InvalidJson,
        ] {
            let s = m.apply(Probe::failed(AppError::new(code, "boom")));
            assert_eq!(s.state, SessionState::Degraded, "{code:?}");
            assert_eq!(s.reason, SessionReason::RequestFailed, "{code:?}");
        }
    }

    #[test]
    fn a_failed_request_downgrades_green_without_a_reprobe() {
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        m.note_request_failure(&AppError::new(ErrorCode::ApiError, "upstream"));
        assert_eq!(m.snapshot().state, SessionState::Degraded);
        m.note_request_success();
        assert_eq!(m.snapshot().state, SessionState::Connected);
    }

    #[test]
    fn a_succeeding_request_cannot_resurrect_a_rejected_session() {
        let m = connected_manager();
        m.apply(Probe::failed(AppError::new(
            ErrorCode::NotAuthenticated,
            "no",
        )));
        m.note_request_success();
        assert_eq!(
            m.snapshot().state,
            SessionState::Expired,
            "a stray success flipped a red session green"
        );
    }

    #[test]
    fn deleting_the_credentials_forces_grey_even_after_a_green_probe() {
        let store = MemoryStore::new();
        store
            .save(&XCredentials::parse(TOKEN, CT0).unwrap())
            .unwrap();
        let m = SessionManager::new(Box::new(store));
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        assert_eq!(m.snapshot().state, SessionState::Connected);

        m.store().delete().unwrap();
        let s = m.snapshot();
        assert_eq!(s.state, SessionState::Disconnected);
        assert_eq!(s.reason, SessionReason::NoCredentials);
        assert!(s.account.is_none());
    }

    #[test]
    fn reset_clears_the_account_identity() {
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        m.reset();
        let s = m.snapshot();
        assert!(s.account.is_none());
        assert_eq!(s.reason, SessionReason::NotChecked);
    }

    #[test]
    fn a_long_idle_session_goes_yellow_rather_than_claiming_green() {
        let m = connected_manager();
        m.apply(Probe::Authenticated {
            account: Some(account()),
        });
        {
            let mut s = m.snapshot.lock().unwrap();
            s.last_success_at =
                Some((Utc::now() - ChronoDuration::minutes(STALE_AFTER_MINUTES + 5)).to_rfc3339());
        }
        let s = m.snapshot();
        assert_eq!(s.state, SessionState::Degraded);
        assert_eq!(s.reason, SessionReason::Stale);
        // Still usable: staleness must not stop the app from trying.
        assert!(!s.reason.blocks_requests());
    }

    #[test]
    fn checks_are_due_immediately_then_rate_limited_by_the_interval() {
        let m = connected_manager();
        assert!(m.due_for_check(5), "first check should run");
        m.apply(Probe::Authenticated { account: None });
        assert!(!m.due_for_check(5), "re-checked far too soon");
    }

    #[test]
    fn a_successful_provider_request_defers_the_next_check() {
        // The monitoring interval must not spend a subprocess re-asking whether
        // the session works while the reader is watching a feed arrive.
        let m = connected_manager();
        {
            let mut s = m.snapshot.lock().unwrap();
            s.checked_at = Some((Utc::now() - ChronoDuration::minutes(40)).to_rfc3339());
        }
        assert!(m.due_for_check(5), "an old check should come due");

        m.note_request_success();
        assert!(!m.due_for_check(5), "a fresh feed did not count as health");
    }

    #[test]
    fn an_old_success_still_lets_the_check_come_due() {
        let m = connected_manager();
        m.apply(Probe::Authenticated { account: None });
        {
            let mut s = m.snapshot.lock().unwrap();
            let long_ago = (Utc::now() - ChronoDuration::minutes(40)).to_rfc3339();
            s.checked_at = Some(long_ago.clone());
            s.last_success_at = Some(long_ago);
        }
        assert!(m.due_for_check(5));
    }

    #[test]
    fn no_check_is_due_without_credentials_or_while_one_is_running() {
        let m = SessionManager::new(Box::new(MemoryStore::new()));
        assert!(!m.due_for_check(5));

        let m2 = connected_manager();
        m2.set_checking(true);
        assert!(!m2.due_for_check(5), "two checks ran concurrently");
    }

    #[test]
    fn the_snapshot_never_carries_a_secret() {
        let m = connected_manager();
        let s = m.apply(Probe::failed(AppError::new(
            ErrorCode::ApiError,
            format!("failed for auth_token={TOKEN}"),
        )));
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains(TOKEN), "{json}");
        assert!(!json.contains(CT0), "{json}");
    }
}
