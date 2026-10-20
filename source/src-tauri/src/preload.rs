//! Background traversal of the two lists that cannot be paged.
//!
//! Following is the only list here with no provider-side cursor traversal.
//! twitter-cli takes `--max` for both; its patched Bookmarks command follows
//! its own internal cursor to exhaustion, while Following assembles
//! the whole batch internally — roughly 20–25 accounts per internal request,
//! sequentially — and returns nothing at all until it is finished. Measured
//! against a real account of 191 follows: 30 in 2.1s, 60 in 5.2s, 191 in 36.3s.
//!
//! That shape forces the design. There is no way to *continue* a Following
//! list, only to ask for a bigger one, so "load the rest" is a fresh request
//! with a larger `--max` rather than a continuation. And because a full
//! traversal takes half a minute, it cannot happen anywhere the reader is
//! waiting: it runs here, in the background, reporting progress as it goes.
//!
//! Three rules the workers in this module keep:
//!
//! 1. **They never hold the shared provider lock.** A background worker builds
//!    its own provider, so a 36-second Following traversal cannot block the
//!    feed the reader is actually looking at. This is the whole of "yield to
//!    foreground requests" — there is no priority system, there is simply no
//!    contention.
//! 2. **One of each, ever.** Claiming a slot is a `compare_exchange`; a second
//!    request while one is running is refused rather than queued.
//! 3. **Cancellation is checked between requests, not during one.** A child
//!    process that has already been started is allowed to finish; killing it
//!    mid-flight would leave a partial read that says nothing. On exit and on
//!    account switch the flag is set and the worker stops at the next boundary.

use crate::models::{AppError, AppResult, Author, ErrorCode};
use crate::providers::XDataProvider;
use std::sync::atomic::{AtomicBool, Ordering};

/// Event name for Following traversal progress.
pub const FOLLOWING_PROGRESS: &str = "following:progress";
/// Event name for the Bookmarks preload.
pub const BOOKMARKS_PROGRESS: &str = "bookmarks:progress";

/// How many accounts to ask for when nothing is known about the list's size.
///
/// Large enough that most accounts finish in one request, small enough that the
/// first progress event arrives in seconds rather than half a minute.
pub const FOLLOWING_STEP: u32 = 200;

/// Largest Following request the real provider can honour.
///
/// This must equal [`crate::providers::FOLLOWING_REQUEST_MAX`]. A higher value
/// is unsafe: the provider clamps it, and the traversal can mistake that
/// clamped response for a short final page and prune accounts it never saw.
pub const FOLLOWING_CEILING: u32 = crate::providers::FOLLOWING_REQUEST_MAX;

/// Head-room added to a known follow count.
///
/// The count comes from a profile that was read before the request starts, so
/// it can be a few behind. Asking for exactly it would return exactly it, which
/// is indistinguishable from truncation and would force a second full pass.
pub const FOLLOWING_MARGIN: u32 = 25;

/// The unlimited bookmark request passed to the patched provider.
///
/// The patched twitter-cli follows its own internal cursor until X returns no
/// more bookmarks instead of applying its generic fetch-count ceiling. The
/// app deliberately does not impose a 30/100/200/400-row bookmark limit.
pub const BOOKMARKS_PRELOAD_MAX: u32 = u32::MAX;

/// What a worker is doing, as the interface reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Claimed the slot; the first request has not returned yet.
    Starting,
    /// A batch arrived and was stored. More is being asked for.
    Batch,
    /// The whole list was obtained, or the ceiling was reached.
    Complete,
    /// Stopped at a boundary because the app is exiting or the account changed.
    Cancelled,
    /// The backend refused or the session is unusable. `message` says how.
    Failed,
}

/// One progress event.
///
/// `loaded` is a real count of rows stored, never an estimate, and `total` is
/// present only when the account's own profile stated one. A progress bar with
/// an invented denominator is a progress bar that lies.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub loaded: usize,
    pub done: bool,
    pub stage: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Sanitised. Present on `Failed` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Progress {
    pub fn starting(total: Option<u64>) -> Self {
        Self {
            loaded: 0,
            done: false,
            stage: Stage::Starting,
            total,
            message: None,
        }
    }

    pub fn batch(loaded: usize, total: Option<u64>) -> Self {
        Self {
            loaded,
            done: false,
            stage: Stage::Batch,
            total,
            message: None,
        }
    }

    pub fn complete(loaded: usize, total: Option<u64>) -> Self {
        Self {
            loaded,
            done: true,
            stage: Stage::Complete,
            total,
            message: None,
        }
    }

    pub fn cancelled(loaded: usize) -> Self {
        Self {
            loaded,
            done: true,
            stage: Stage::Cancelled,
            total: None,
            message: None,
        }
    }

    /// A failure carries the sanitised message and nothing else. `crate::security::sanitize`
    /// runs here rather than at the call site so no route to this event can
    /// forget it.
    pub fn failed(loaded: usize, e: &AppError) -> Self {
        Self {
            loaded,
            done: true,
            stage: Stage::Failed,
            total: None,
            message: Some(crate::security::sanitize(&e.message)),
        }
    }
}

/// Where progress events go.
///
/// A trait rather than an `AppHandle` because an `AppHandle` cannot be built
/// outside a running Tauri app, and a traversal whose progress reporting is
/// only exercised in production is a traversal whose progress reporting is
/// not tested.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, event: &str, progress: &Progress);
}

/// Discards everything. The state's default before the shell is up.
pub struct NullSink;
impl ProgressSink for NullSink {
    fn emit(&self, _event: &str, _progress: &Progress) {}
}

/// One background slot: at most one worker, cancellable.
#[derive(Debug, Default)]
pub struct Slot {
    running: AtomicBool,
    cancel: AtomicBool,
}

impl Slot {
    pub fn claim_owned(self: &std::sync::Arc<Self>) -> Option<OwnedSlotGuard> {
        self.running.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).ok()?;
        self.cancel.store(false,Ordering::SeqCst);
        Some(OwnedSlotGuard(std::sync::Arc::clone(self)))
    }
    /// Take the slot, or `None` when a worker already holds it.
    ///
    /// `compare_exchange`, not read-then-write: startup preload, a manual
    /// refresh and an account switch can all arrive in the same instant and
    /// only one may start a traversal.
    pub fn claim(&self) -> Option<SlotGuard<'_>> {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        // A cancellation belongs to the run it interrupted. Clearing it as the
        // next run starts is what stops one cancelled traversal from making
        // every later one stop immediately.
        self.cancel.store(false, Ordering::SeqCst);
        Some(SlotGuard(self))
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

/// Releases the slot on drop, including on a panic or an early return.
pub struct SlotGuard<'a>(&'a Slot);

pub struct OwnedSlotGuard(std::sync::Arc<Slot>);
impl OwnedSlotGuard { pub fn cancelled(&self) -> bool {self.0.cancelled()} }
impl Drop for OwnedSlotGuard {fn drop(&mut self) {self.0.running.store(false,Ordering::SeqCst);}}

impl SlotGuard<'_> {
    pub fn cancelled(&self) -> bool {
        self.0.cancelled()
    }
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

/// The two background slots this release has.
#[derive(Debug, Default)]
pub struct Workers {
    pub following: std::sync::Arc<Slot>,
    pub bookmarks: Slot,
    epoch: std::sync::atomic::AtomicU64,
}

impl Workers {
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub fn is_current(&self, epoch: u64) -> bool {
        self.epoch() == epoch
    }

    /// Stop everything at the next boundary. Called on exit, on disconnect and
    /// on account switch — the last of which matters most, because a traversal
    /// started under one account must never write rows after another one is
    /// connected.
    pub fn cancel_all(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.following.cancel();
        self.bookmarks.cancel();
    }
}

/// How large the first Following request should be.
pub fn initial_request_size(known_total: Option<u64>) -> u32 {
    match known_total {
        Some(n) if n > 0 => (n.min(u32::MAX as u64) as u32)
            .saturating_add(FOLLOWING_MARGIN)
            .min(FOLLOWING_CEILING),
        _ => FOLLOWING_STEP,
    }
}

/// Outcome of a traversal, distinct from an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Traversal {
    /// Accounts in the final, largest batch.
    pub loaded: usize,
    /// True when the list ended on its own. False when the ceiling stopped it
    /// or the worker was cancelled.
    pub exhaustive: bool,
    pub cancelled: bool,
}

/// Fetch the complete Following list, escalating `--max` until it stops
/// growing.
///
/// `following` has no cursor, so each request returns the list from the top
/// again. That means every batch is a superset of the one before it and
/// `offset` is always zero — the escalation is not pagination and is not
/// described as such. A batch that comes back *shorter* than it was asked for
/// is the end of the list, which is the only completion signal this backend
/// gives.
///
/// `on_batch` receives every batch, including intermediate ones, so the
/// interface fills in as the list grows rather than waiting for the end.
pub fn traverse_following(
    provider: &dyn XDataProvider,
    handle: &str,
    known_total: Option<u64>,
    cancel: &dyn Fn() -> bool,
    mut on_batch: impl FnMut(&[Author], bool) -> AppResult<()>,
) -> AppResult<Traversal> {
    if provider.capabilities().following_cursor {
        let mut cursor = None; let mut cursors = std::collections::HashSet::new();
        let mut authors = std::collections::HashSet::new(); let mut loaded = 0; let mut empty_pages=0;
        loop {
            if cancel() { return Ok(Traversal { loaded, exhaustive:false, cancelled:true }); }
            let page = provider.get_following_accounts_page(handle, if cursor.is_none() {30} else {60}, cursor)?;
            if cancel() { return Ok(Traversal { loaded, exhaustive:false, cancelled:true }); }
            let batch: Vec<_> = page.accounts.into_iter().filter(|a| authors.insert(a.id.clone())).collect();
            loaded += batch.len();
            let done = page.cursor.is_none();
            empty_pages=if batch.is_empty() && !done {empty_pages+1}else{0};
            if empty_pages>=2 {
                return Err(AppError::new(ErrorCode::SchemaChanged,"Account loading made no progress. Loaded accounts remain available; try again."));
            }
            on_batch(&batch, done)?;
            if done { return Ok(Traversal {loaded,exhaustive:true,cancelled:false}); }
            cursor = page.cursor;
            if !cursors.insert(cursor.clone().unwrap()) {
                return Err(AppError::new(ErrorCode::SchemaChanged,"Twitter repeated an account page. Loaded accounts remain available; retry the list."));
            }
        }
    }
    let mut want = initial_request_size(known_total);
    let mut loaded = 0usize;
    loop {
        if cancel() {
            return Ok(Traversal {
                loaded,
                exhaustive: false,
                cancelled: true,
            });
        }
        let batch = provider.get_following_accounts(handle, want)?;
        // Cancellation can happen while twitter-cli is doing its (potentially
        // long) read. Never deliver that old-account response to the callback:
        // the caller may already have cleared the tables for a new identity.
        if cancel() {
            return Ok(Traversal {
                loaded,
                exhaustive: false,
                cancelled: true,
            });
        }
        loaded = batch.len();
        // Short of what was asked for means the account ran out, which is the
        // only "you have it all" this backend expresses.
        let ended = (loaded as u32) < want;
        let at_ceiling = want >= FOLLOWING_CEILING;
        let done = ended || at_ceiling;
        on_batch(&batch, done)?;
        if done {
            return Ok(Traversal {
                loaded,
                exhaustive: ended,
                cancelled: false,
            });
        }
        want = want.saturating_mul(2).min(FOLLOWING_CEILING);
    }
}

/// The handle a traversal needs, or the error the interface should show.
pub fn require_handle(handle: Option<String>) -> AppResult<String> {
    handle.ok_or_else(|| {
        AppError::new(
            ErrorCode::NotAuthenticated,
            "no connected account has been identified yet",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::mock::MockXProvider;
    use std::sync::Mutex;

    /// Records what was emitted, so progress reporting is testable without a
    /// Tauri app.
    #[derive(Default)]
    pub struct RecordingSink(pub Mutex<Vec<(String, Progress)>>);
    impl ProgressSink for RecordingSink {
        fn emit(&self, event: &str, progress: &Progress) {
            self.0
                .lock()
                .unwrap()
                .push((event.to_string(), progress.clone()));
        }
    }

    /// A provider whose Following list is a fixed size, counting requests.
    struct Counted {
        total: usize,
        calls: Mutex<Vec<u32>>,
        cursor_mode: bool,
        repeated: bool,
        stalled_after: Option<usize>,
    }

    impl XDataProvider for Counted {
        fn capabilities(&self) -> crate::providers::ProviderCapabilities {
            crate::providers::ProviderCapabilities { following_cursor:self.cursor_mode, ..crate::providers::ProviderCapabilities::none() }
        }
        fn get_following_accounts_page(&self, _u:&str, max:u32, cursor:Option<String>) -> AppResult<crate::models::AccountPage> {
            self.calls.lock().unwrap().push(max);
            let calls=self.calls.lock().unwrap().len();
            if self.stalled_after.is_some_and(|after| calls>after) {
                return Ok(crate::models::AccountPage {accounts:Vec::new(),cursor:Some(format!("stalled-{calls}"))});
            }
            let start=cursor.and_then(|c| c.parse::<usize>().ok()).unwrap_or(0);
            let end=(start+max as usize).min(self.total);
            Ok(crate::models::AccountPage {
                accounts:(start..end).map(|i| Author{id:format!("id{i}"),username:format!("u{i}"),..Default::default()}).collect(),
                cursor:if self.repeated {Some("0".into())} else if end<self.total {Some(end.to_string())} else {None},
            })
        }
        fn name(&self) -> &'static str {
            "counted"
        }
        fn get_following_accounts(&self, _u: &str, max: u32) -> AppResult<Vec<Author>> {
            self.calls.lock().unwrap().push(max);
            Ok((0..self.total.min(max as usize))
                .map(|i| Author {
                    id: format!("id{i}"),
                    username: format!("u{i}"),
                    ..Default::default()
                })
                .collect())
        }
        fn get_following_feed(
            &self,
            _m: u32,
            _c: Option<String>,
        ) -> AppResult<crate::models::FeedPage> {
            unimplemented!()
        }
        fn get_for_you_feed(
            &self,
            _m: u32,
            _c: Option<String>,
        ) -> AppResult<crate::models::FeedPage> {
            unimplemented!()
        }
        fn get_user_profile(&self, _u: &str) -> AppResult<Author> {
            unimplemented!()
        }
        fn get_user_posts(&self, _u: &str, _m: u32) -> AppResult<crate::models::FeedPage> {
            unimplemented!()
        }
        fn get_bookmarks(&self, _m: u32) -> AppResult<crate::models::FeedPage> {
            unimplemented!()
        }
        fn get_list_timeline(&self, _l: &str, _m: u32) -> AppResult<crate::models::FeedPage> {
            unimplemented!()
        }
        fn get_current_user(&self) -> AppResult<Author> {
            unimplemented!()
        }
        fn status(&self) -> AppResult<crate::models::AuthenticationStatus> {
            unimplemented!()
        }
    }

    fn counted(total: usize) -> Counted {
        Counted {
            total,
            calls: Mutex::new(Vec::new()),
            cursor_mode:false,
            repeated:false,
            stalled_after:None,
        }
    }

    const NEVER: &dyn Fn() -> bool = &|| false;

    #[test]
    fn native_cursor_pages_are_delivered_before_the_whole_list_finishes() {
        let mut provider=counted(95);provider.cursor_mode=true;
        let mut delivered=0;let mut progress=Vec::new();
        let result=traverse_following(&provider,"me",None,NEVER,|batch,_|{delivered+=batch.len();progress.push(delivered);Ok(())}).unwrap();
        assert_eq!(progress,vec![30,90,95]);assert_eq!(*provider.calls.lock().unwrap(),vec![30,60,60]);
        assert!(result.exhaustive);assert_eq!(result.loaded,95);
    }
    #[test]
    fn repeated_account_cursors_fail_after_preserving_the_received_pages() {
        let mut provider=counted(95);provider.cursor_mode=true;provider.repeated=true;
        let mut delivered=0;
        assert!(traverse_following(&provider,"me",None,NEVER,|batch,_|{delivered+=batch.len();Ok(())}).is_err());
        assert_eq!(delivered,60);assert_eq!(provider.calls.lock().unwrap().len(),2);
    }

    #[test]
    fn changing_cursors_without_new_accounts_cannot_keep_loading_forever() {
        for completed_pages in [0,1] {
            let mut provider=counted(95);provider.cursor_mode=true;provider.stalled_after=Some(completed_pages);
            let mut delivered=0;
            let error=traverse_following(&provider,"me",None,NEVER,|batch,_|{delivered+=batch.len();Ok(())}).unwrap_err();
            assert_eq!(error.code,ErrorCode::SchemaChanged);
            assert_eq!(delivered,if completed_pages==0 {0}else{30});
            assert_eq!(provider.calls.lock().unwrap().len(),completed_pages+2);
        }
    }

    #[test]
    fn a_short_list_finishes_in_one_request() {
        let p = counted(12);
        let mut seen = 0usize;
        let out = traverse_following(&p, "me", None, NEVER, |b, done| {
            seen = b.len();
            assert!(done);
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, 12);
        assert!(out.exhaustive);
        assert_eq!(*p.calls.lock().unwrap(), vec![FOLLOWING_STEP]);
    }

    #[test]
    fn a_list_longer_than_the_first_guess_escalates_until_it_ends() {
        // 470 follows with no known count: 200 comes back full, so ask for 400,
        // which also comes back full, then 800, which does not.
        let p = counted(470);
        let mut batches = Vec::new();
        let out = traverse_following(&p, "me", None, NEVER, |b, done| {
            batches.push((b.len(), done));
            Ok(())
        })
        .unwrap();
        assert_eq!(*p.calls.lock().unwrap(), vec![200, 400, 800]);
        assert_eq!(batches, vec![(200, false), (400, false), (470, true)]);
        assert_eq!(out.loaded, 470);
        assert!(out.exhaustive);
    }

    #[test]
    fn a_known_follow_count_is_obtained_in_a_single_request() {
        // The measured cost is linear in the number of accounts, so the point
        // of reading the profile's count first is that 191 follows cost one
        // 36-second request instead of three.
        let p = counted(191);
        let out = traverse_following(&p, "me", Some(191), NEVER, |_, _| Ok(())).unwrap();
        assert_eq!(*p.calls.lock().unwrap(), vec![191 + FOLLOWING_MARGIN]);
        assert_eq!(out.loaded, 191);
        assert!(out.exhaustive);
    }

    #[test]
    fn a_stale_follow_count_still_reaches_the_whole_list() {
        // The profile said 100; the account has since followed 200 more. The
        // count is a hint, never a stopping condition.
        let p = counted(300);
        let out = traverse_following(&p, "me", Some(100), NEVER, |_, _| Ok(())).unwrap();
        assert_eq!(out.loaded, 300);
        assert!(out.exhaustive);
        assert!(p.calls.lock().unwrap().len() > 1);
    }

    #[test]
    fn the_ceiling_stops_the_escalation_and_says_so_honestly() {
        // Nothing pretends the list ended: `exhaustive` is false, because the
        // ceiling stopped it rather than the account running out.
        let p = counted(usize::MAX);
        let out = traverse_following(&p, "me", Some(u64::MAX), NEVER, |_, _| Ok(())).unwrap();
        assert_eq!(*p.calls.lock().unwrap(), vec![FOLLOWING_CEILING]);
        assert!(!out.exhaustive);
        assert!(!out.cancelled);
    }

    #[test]
    fn the_traversal_ceiling_matches_the_real_provider_limit() {
        // 1,200 followed accounts cannot be represented by a backend with no
        // cursor that honours at most 1,000. Exactly 1,000 returned is partial,
        // never proof that the list ended.
        assert_eq!(FOLLOWING_CEILING, crate::providers::FOLLOWING_REQUEST_MAX);
        let p = counted(1_200);
        let out = traverse_following(&p, "me", Some(1_200), NEVER, |_, _| Ok(())).unwrap();
        assert_eq!(*p.calls.lock().unwrap(), vec![FOLLOWING_CEILING]);
        assert_eq!(out.loaded, FOLLOWING_CEILING as usize);
        assert!(!out.exhaustive);
    }

    #[test]
    fn cancellation_stops_before_the_next_request_is_made() {
        let p = counted(1000);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let cancel = || -> bool { calls.fetch_add(1, Ordering::SeqCst) >= 1 };
        let out = traverse_following(&p, "me", None, &cancel, |_, _| Ok(())).unwrap();
        assert!(out.cancelled);
        assert!(!out.exhaustive);
        assert_eq!(
            p.calls.lock().unwrap().len(),
            1,
            "a cancelled traversal started another request"
        );
    }

    #[test]
    fn a_provider_failure_is_reported_rather_than_returning_a_short_list() {
        // A truncated list that looks complete is the worst outcome here: the
        // group picker would silently stop offering the accounts it did not
        // reach.
        struct Broken;
        impl XDataProvider for Broken {
            fn name(&self) -> &'static str {
                "broken"
            }
            fn get_following_feed(
                &self,
                _m: u32,
                _c: Option<String>,
            ) -> AppResult<crate::models::FeedPage> {
                unimplemented!()
            }
            fn get_for_you_feed(
                &self,
                _m: u32,
                _c: Option<String>,
            ) -> AppResult<crate::models::FeedPage> {
                unimplemented!()
            }
            fn get_user_profile(&self, _u: &str) -> AppResult<Author> {
                unimplemented!()
            }
            fn get_user_posts(&self, _u: &str, _m: u32) -> AppResult<crate::models::FeedPage> {
                unimplemented!()
            }
            fn get_following_accounts(&self, _u: &str, _m: u32) -> AppResult<Vec<Author>> {
                Err(AppError::new(ErrorCode::ApiError, "rate limited"))
            }
            fn get_bookmarks(&self, _m: u32) -> AppResult<crate::models::FeedPage> {
                unimplemented!()
            }
            fn get_list_timeline(&self, _l: &str, _m: u32) -> AppResult<crate::models::FeedPage> {
                unimplemented!()
            }
            fn get_current_user(&self) -> AppResult<Author> {
                unimplemented!()
            }
            fn status(&self) -> AppResult<crate::models::AuthenticationStatus> {
                unimplemented!()
            }
        }
        let err = traverse_following(&Broken, "me", None, NEVER, |_, _| Ok(())).unwrap_err();
        assert_eq!(err.code, ErrorCode::ApiError);
    }

    #[test]
    fn the_mock_provider_traverses_to_its_fixture_size() {
        let p = MockXProvider::new();
        let out = traverse_following(&p, "focus_reader", None, NEVER, |_, _| Ok(())).unwrap();
        assert!(out.exhaustive);
        assert!(out.loaded > 0);
    }

    #[test]
    fn bookmark_request_has_no_application_count_ceiling() {
        assert_eq!(BOOKMARKS_PRELOAD_MAX, u32::MAX);
    }

    // --- slots -------------------------------------------------------------

    #[test]
    fn only_one_worker_can_hold_a_slot() {
        let slot = Slot::default();
        let first = slot.claim().expect("the slot was free");
        assert!(slot.claim().is_none(), "a second worker started");
        assert!(slot.is_running());
        drop(first);
        assert!(!slot.is_running());
        assert!(slot.claim().is_some(), "the slot was not released");
    }

    #[test]
    fn a_slot_is_released_even_when_the_worker_panics() {
        let slot = Slot::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = slot.claim().unwrap();
            panic!("worker died");
        }));
        assert!(!slot.is_running());
    }

    #[test]
    fn a_cancellation_does_not_outlive_the_run_it_interrupted() {
        let slot = Slot::default();
        {
            let guard = slot.claim().unwrap();
            slot.cancel();
            assert!(guard.cancelled());
        }
        let guard = slot.claim().unwrap();
        assert!(
            !guard.cancelled(),
            "the next traversal started already cancelled"
        );
    }

    #[test]
    fn cancelling_everything_reaches_both_workers() {
        let w = Workers::default();
        let f = w.following.claim().unwrap();
        let b = w.bookmarks.claim().unwrap();
        w.cancel_all();
        assert!(f.cancelled() && b.cancelled());
    }

    // --- progress ----------------------------------------------------------

    #[test]
    fn progress_events_carry_a_real_count_and_never_an_invented_total() {
        let p = Progress::batch(37, None);
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["loaded"], 37);
        assert_eq!(json["done"], false);
        assert_eq!(json["stage"], "batch");
        assert!(
            json.get("total").is_none(),
            "an unknown total was serialised as a number"
        );
    }

    #[test]
    fn a_known_total_is_reported_when_the_profile_stated_one() {
        let json = serde_json::to_value(Progress::complete(191, Some(191))).unwrap();
        assert_eq!(json["total"], 191);
        assert_eq!(json["stage"], "complete");
        assert_eq!(json["done"], true);
    }

    #[test]
    fn a_failure_event_cannot_carry_a_credential() {
        let e = AppError::new(
            ErrorCode::ApiError,
            "refused with auth_token=hunter2 ct0=abcd",
        );
        let json = serde_json::to_value(Progress::failed(4, &e)).unwrap();
        let text = json.to_string();
        assert!(!text.contains("hunter2"), "{text}");
        assert!(!text.contains("abcd"), "{text}");
        assert_eq!(json["stage"], "failed");
    }

    #[test]
    fn the_recording_sink_sees_what_a_worker_emits() {
        let sink = RecordingSink::default();
        sink.emit(FOLLOWING_PROGRESS, &Progress::starting(Some(10)));
        sink.emit(FOLLOWING_PROGRESS, &Progress::complete(10, Some(10)));
        let seen = sink.0.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, "following:progress");
        assert_eq!(seen[1].1.stage, Stage::Complete);
    }

    #[test]
    fn an_unknown_follow_count_falls_back_to_the_step_size() {
        assert_eq!(initial_request_size(None), FOLLOWING_STEP);
        assert_eq!(initial_request_size(Some(0)), FOLLOWING_STEP);
        assert_eq!(initial_request_size(Some(30)), 30 + FOLLOWING_MARGIN);
        assert_eq!(initial_request_size(Some(999_999)), FOLLOWING_CEILING);
    }
}
