//! Focus Feed Next — Tauri backend entry point.

pub mod agent_reach;
pub mod commands;
pub mod companion;
pub mod credentials;
pub mod database;
pub mod durable;
pub mod ephemeral;
/// Checks that the command list, the handler registration and the frontend
/// bindings agree. Test-only: it parses source text and ships in no binary.
#[cfg(test)]
mod ipc_contract;
pub mod media_proxy;
pub mod models;
pub mod portable;
pub mod preferences;
pub mod preload;
pub mod providers;
pub mod security;
pub mod session;

use commands::AppState;
use database::Db;
use durable::Durable;
use ephemeral::EphemeralSession;
use std::sync::Arc;

/// The storage root selected for this process.
///
/// Release builds use the portable root beside the executable. Fetched content
/// is held in an in-memory database; the per-run directory contains only the
/// cleanup lock and private WebView2 profile and is deleted on exit. The small
/// durable metadata store (preferences, identity and local list definitions)
/// remains in this root so lists survive a restart. Debug builds retain the
/// legacy per-user path so development settings are not surprising.
pub fn data_dir() -> std::path::PathBuf {
    portable::data_dir()
}

/// The old installed-app path. Portable startup never reads or deletes this
/// path; it is kept only for the debug compatibility mode and migration tests.
pub fn legacy_data_dir() -> std::path::PathBuf {
    portable::legacy_data_dir()
}

/// Carries background progress from a worker thread to the interface.
///
/// Lives here rather than in `preload.rs` because it is the only part of that
/// module that needs to know Tauri exists — the traversal itself is testable
/// without a webview precisely because it reports through a trait.
struct WebviewSink {
    app: tauri::AppHandle,
}

impl preload::ProgressSink for WebviewSink {
    fn emit(&self, event: &str, progress: &preload::Progress) {
        use tauri::Emitter;
        // A failed emit means the window has gone; the worker's own cancellation
        // handles that, and there is nowhere useful to report it to anyway.
        let _ = self.app.emit(event, progress);
    }
}

/// Path of the durable metadata store for the current storage policy.
pub fn preferences_path() -> std::path::PathBuf {
    data_dir().join("preferences.db")
}

/// Delete the persistent content database written by 0.1.x.
///
/// 0.1.0 kept every fetched post in `%APPDATA%\FocusFeedNext\focusfeed.db`
/// indefinitely, and seeded 30 fabricated posts into it on first run. 0.2.0
/// treats fetched content as session-only, so that file has no role any more:
/// leaving it would be a durable copy of somebody's timeline that the app no
/// longer reads and the user cannot see or clear.
///
/// Returns how many files were removed (the database and its WAL sidecars).
fn remove_legacy_content_db(dir: &std::path::Path) -> usize {
    let mut removed = 0;
    for name in [
        "focusfeed.db",
        "focusfeed.db-wal",
        "focusfeed.db-shm",
        "focusfeed.corrupt.db",
    ] {
        let path = dir.join(name);
        if path.exists() {
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) => log::warn!("could not remove legacy {name}: {e}"),
            }
        }
    }
    if removed > 0 {
        log::info!("removed {removed} legacy content file(s); content is now session-only");
    }
    removed
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_ios_reader::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                // Our own messages at Info; everything else silent by default.
                //
                // `keyring` logs at Debug on every credential-store operation,
                // which put 48 of 51 lines in a short run's log file — each one
                // naming the Credential Manager entry a token lives in. None of
                // it contained a value, but a log that records every read of
                // the credential store is more detail on disk than this app has
                // any reason to keep, and it buried the three lines that
                // actually mattered.
                // The plugin defaults to an AppData LogDir target. That is
                // useful for installed apps but violates the portable release
                // contract, so keep diagnostics in-memory and log only to the
                // process stream.
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .level(log::LevelFilter::Warn)
                .level_for("app_lib", log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            use tauri::Manager;
            #[cfg(target_os = "ios")]
            providers::native_ios::initialize(app.handle().clone());

            // The portable release deliberately does not touch the old
            // installed-app directory. A user may still have a previous
            // install there, and silently deleting it would be the wrong kind
            // of portability. The compatibility mode may still remove the
            // obsolete 0.1 content database.
            if !portable::is_portable() {
                remove_legacy_content_db(&legacy_data_dir());
            }
            let mut purged = 0;
            for root in ephemeral::session_roots() {
                purged += ephemeral::purge_stale(&root, None);
            }
            if purged > 0 {
                log::info!("cleaned up {purged} session directory(ies) from an earlier run");
            }
            #[cfg(not(mobile))]
            {
                let purged_webviews = portable::purge_stale_webviews();
                if purged_webviews > 0 {
                    log::info!(
                        "cleaned up {purged_webviews} abandoned fallback WebView profile(s)"
                    );
                }
            }

            // Fetched content is held in an in-memory database for this run.
            // The throwaway directory is only the lock and the WebView2
            // profile. The durable store carries user-authored list definitions
            // and remains separate from both.
            let storage = EphemeralSession::create();
            if let Err(e) = &storage {
                // No writable session directory. Memory-only is still the
                // correct fallback; the WebView gets an isolated temp profile.
                log::error!("no session directory ({}), using temp WebView storage", e.message);
            }
            let db = Db::in_memory().expect("in-memory database must open");
            let durable = Durable::open(&preferences_path()).unwrap_or_else(|e| {
                log::error!("durable metadata unavailable, using memory: {}", e.message);
                Durable::in_memory().expect("in-memory preferences must open")
            });

            let storage_dir = storage.as_ref().ok().map(|s| s.dir().to_path_buf());
            #[cfg(not(mobile))]
            let webview_dir = storage_dir
                .as_ref()
                .map(|dir| dir.join("webview"))
                .and_then(|dir| match std::fs::create_dir_all(&dir) {
                    Ok(()) => Some(dir),
                    Err(e) => {
                        log::warn!("portable WebView directory unavailable: {e}");
                        None
                    }
                })
                .or_else(|| {
                    let fallback = portable::fallback_webview_dir();
                    if fallback.is_some() {
                        log::warn!(
                            "using a temporary WebView directory because the session directory is unavailable"
                        );
                    }
                    fallback
                });
            // WKWebView owns its data store on iOS; `data_directory` is a
            // desktop-only API. Session content is still held in the same
            // in-memory store and disappears when the process exits.
            #[cfg(mobile)]
            let webview_dir: Option<std::path::PathBuf> = None;

            #[cfg(not(mobile))]
            if webview_dir.is_none() {
                // Never let Tauri/WebView2 silently choose its permanent
                // AppData profile. A private run directory is a hard safety
                // boundary, not an optimization that may be skipped.
                return Err(
                    "could not create a private per-run WebView2 profile directory".into(),
                );
            }

            let mut state = AppState::new(db).with_durable(durable);
            if let Ok(s) = storage {
                state = state.with_storage(s);
            }
            let webview_is_separate = match (&storage_dir, &webview_dir) {
                (Some(session), Some(webview)) => !webview.starts_with(session),
                _ => webview_dir.is_some(),
            };
            if webview_is_separate {
                if let Some(dir) = webview_dir.clone() {
                    state = state.with_webview_dir(dir);
                }
            }

            // The loopback media transport. Binding a socket is instantaneous,
            // so doing it before the window appears costs nothing and means the
            // first feed already has somewhere to point its video at. A failure
            // here is not fatal: the app runs, and video reports that the local
            // proxy is unavailable instead of showing a URL that cannot play.
            let fixture_proxy = false;
            #[cfg(all(feature = "dev-mock", debug_assertions, target_os = "ios"))]
            let fixture_proxy = std::env::var("FFN_UI_TEST_SCENARIO").is_ok();
            let proxy = async {
                #[cfg(all(feature = "dev-mock", debug_assertions, target_os = "ios"))]
                if fixture_proxy {
                    return media_proxy::MediaProxy::start_with_test_upstream(Arc::clone(&state.media), "http://127.0.0.1:8769/fixtures/".into()).await;
                }
                let _ = fixture_proxy;
                media_proxy::MediaProxy::start(Arc::clone(&state.media)).await
            };
            match tauri::async_runtime::block_on(proxy) {
                Ok(proxy) => state = state.with_proxy(proxy),
                Err(e) => log::error!("media proxy unavailable: {}", e.message),
            }

            let state = Arc::new(state);

            // Give the background workers somewhere to report to.
            //
            // Without this the state keeps its default `NullSink` and every
            // progress event is discarded in silence — the traversal runs, the
            // rows land, and the interface shows a spinner that never moves
            // because nothing ever told it anything happened.
            state.set_event_sink(Arc::new(WebviewSink {
                app: app.handle().clone(),
            }));
            app.manage(state.clone());

            // Tauri normally creates configured windows before this setup
            // callback, which would make WebView2 choose its default AppData
            // profile. The config marks the window as `create: false`; build it
            // here so the browser profile lives in the same throwaway directory
            // as the session and is removed with it.
            #[cfg(not(mobile))]
            {
                let window_config = app
                    .config()
                    .app
                    .windows
                    .first()
                    .cloned()
                    .ok_or("the application has no main window configured")?;
                let mut window =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
                if let Some(dir) = webview_dir {
                    window = window.data_directory(dir);
                }
                window = window.incognito(true);
                window.build()?;
            }

            // Validate the stored session in the background. It runs two
            // network round trips inside twitter-cli, so it must never block
            // the window from appearing — the shell renders immediately and
            // the session dot resolves from grey when this finishes.
            std::thread::spawn(move || {
                // Goes through `probe_once` rather than calling the provider
                // directly. This used to be its own copy of the probe logic,
                // which meant it did not take the single-flight flag — so the
                // interface's own startup check ran a *second* `twitter.exe`
                // against the same session a moment later. One door, one
                // process.
                if let Err(e) = commands::probe_once(&state) {
                    log::warn!("startup session probe failed: {}", e.message);
                    return;
                }
                // Only now, and only from here. The scheduler gives the first
                // visible feed request a short head start, then serializes the
                // two expensive list traversals so startup does not saturate
                // the same connection it just proved usable.
                commands::schedule_preload(state.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_provider_status,
            commands::runtime_platform,
            commands::iphone_companion_status,
            commands::start_iphone_companion,
            commands::stop_iphone_companion,
            commands::run_health_check,
            commands::reconnect_provider,
            commands::connect_x_account,
            commands::sign_in_ios,
            commands::get_ui_test_fixture,
            commands::configure_ios_chrome,
            commands::set_ios_chrome_visible,
            commands::present_ios_media,
            commands::dismiss_ios_media,
            commands::connect_iphone_companion,
            commands::check_session,
            commands::session_status,
            commands::disconnect_x_account,
            commands::has_credentials,
            commands::supports_pagination,
            commands::provider_capabilities,
            commands::get_cached_feed,
            commands::get_bookmark_slice,
            commands::refresh_feed,
            commands::load_feed_page,
            commands::get_post,
            commands::get_bookmark_replies,
            commands::open_external_url,
            commands::refresh_post_content,
            commands::probe_media,
            commands::get_posts_by_authors,
            commands::get_user_profile,
            commands::get_account_relationship,
            commands::get_connection_metrics,
            commands::open_creator_subscription,
            commands::add_list,
            commands::remove_list,
            commands::set_read,
            commands::mark_many_read,
            commands::get_read_ids,
            commands::hide_post,
            commands::get_recent_activity,
            commands::pin_account,
            commands::get_pinned_accounts,
            commands::get_known_accounts,
            commands::get_following_accounts,
            commands::get_following_snapshot,
            commands::start_following_sync,
            commands::get_group_candidates,
            commands::create_group,
            commands::update_group,
            commands::delete_group,
            commands::set_group_member,
            commands::get_groups,
            commands::get_account_lists,
            commands::get_group_members,
            commands::get_group_feed,
            commands::refresh_group_feed,
            commands::get_lists,
            commands::get_dashboard,
            commands::get_current_user,
            commands::get_settings,
            commands::set_setting,
            commands::set_preferences_batch,
            commands::share_preferences,
            commands::search_cached_posts,
            commands::runtime_snapshot,
            commands::cancel_native_reads,
            commands::unfollow_allowed,
            commands::unfollow_account,
            commands::follow_account,
            commands::remove_bookmark,
            commands::get_muted_words,
            commands::set_muted_word,
            commands::clear_cache,
            commands::diagnostics_report,
            commands::share_connection_report,
            commands::get_data_dir,
            commands::get_app_version,
            commands::auth_env_present,
            commands::initial_route,
            commands::session_storage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            // The last thing this process does is delete what it fetched.
            // `Exit` fires after every window is gone and before the process
            // ends, which is the only point where the database can be closed
            // and its file removed. `AppState::shutdown` is idempotent.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(state) = handle.try_state::<Arc<AppState>>() {
                    let report = state.shutdown();
                    if report.errors.is_empty() {
                        log::info!(
                            "session storage cleared: {} bytes freed",
                            report.bytes_freed
                        );
                    } else {
                        log::warn!("session cleanup incomplete: {:?}", report.errors);
                    }
                }
            }
        });
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::credentials::{CredentialStore, MemoryStore, XCredentials};
    use crate::database::FeedFilters;
    use crate::providers::mock::MockXProvider;
    use crate::providers::XDataProvider;
    use crate::session::{SessionReason, SessionState};

    const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const CT0: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

    /// End-to-end: fetch, store, filter, read state. The mock provider stands
    /// in for a live one here — it is a test fixture, not a runtime fallback.
    #[test]
    fn a_fetched_page_round_trips_through_the_database() {
        let db = Db::in_memory().unwrap();
        let provider = MockXProvider::new();

        let page = provider.get_following_feed(30, None).unwrap();
        db.save_feed_page("following", &page).unwrap();

        let all = db
            .load_feed("following", &FeedFilters::default(), 100)
            .unwrap();
        // Everything fetched is stored, but promoted posts never load, so the
        // visible count is the non-promoted subset rather than the page size.
        let visible = page.posts.iter().filter(|p| !p.is_promoted).count();
        assert_eq!(all.len(), visible);
        assert!(
            all.iter().all(|p| !p.is_promoted),
            "a promoted post reached the feed with default filters"
        );

        // Hiding reposts must actually reduce the visible set.
        let clean = db
            .load_feed(
                "following",
                &FeedFilters {
                    hide_reposts: true,
                    ..Default::default()
                },
                100,
            )
            .unwrap();
        assert!(clean.len() < all.len());
        assert!(clean.iter().all(|p| !p.is_repost));

        // Reading a post moves it out of the unread count.
        let before = db.stats().unwrap().unread_count;
        db.set_read(&all[0].id, true).unwrap();
        assert_eq!(db.stats().unwrap().unread_count, before - 1);
    }

    #[test]
    fn refetching_the_same_posts_never_duplicates_them() {
        let db = Db::in_memory().unwrap();
        let provider = MockXProvider::new();
        let p1 = provider.get_following_feed(20, None).unwrap();
        db.save_feed_page("following", &p1).unwrap();
        // twitter-cli has no cursor, so a refresh refetches the newest rows.
        // Deduplication on post id is what keeps that from growing the feed.
        db.save_feed_page("following", &p1).unwrap();
        let all = db
            .load_feed("following", &FeedFilters::default(), 200)
            .unwrap();
        let unique: std::collections::HashSet<_> = all.iter().map(|p| &p.id).collect();
        assert_eq!(unique.len(), all.len(), "duplicate posts leaked in");
        assert_eq!(
            all.len(),
            p1.posts.iter().filter(|p| !p.is_promoted).count()
        );
    }

    #[test]
    fn a_fresh_install_starts_completely_empty() {
        // 0.1.0 seeded 30 fabricated posts here. A production build must show
        // nothing at all until a real account is connected.
        let db = Db::in_memory().unwrap();
        let state = AppState::with_store(db, std::sync::Arc::new(MemoryStore::new()));
        let stats = state.db.stats().unwrap();
        assert_eq!(stats.total_posts, 0, "demo posts were seeded");
        assert_eq!(
            state.db.groups().unwrap().len(),
            0,
            "demo groups were seeded"
        );
        assert_eq!(state.db.pinned_accounts().unwrap().len(), 0);
        assert!(state.db.all_authors().unwrap().is_empty());
    }

    /// A helper standing in for `%APPDATA%\FocusFeedNext` in the tests below.
    fn temp_data_dir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ffn-lib-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn upgrading_deletes_the_persistent_content_database_from_0_1_x() {
        // 0.1.x kept every fetched post here forever. 0.2.0 does not read this
        // file at all, so leaving it would be an invisible durable copy of the
        // user's timeline.
        let dir = temp_data_dir("legacy");
        for name in ["focusfeed.db", "focusfeed.db-wal", "focusfeed.db-shm"] {
            std::fs::write(dir.join(name), b"old content").unwrap();
        }

        assert_eq!(remove_legacy_content_db(&dir), 3);
        assert!(!dir.join("focusfeed.db").exists());
        assert!(!dir.join("focusfeed.db-wal").exists());
        assert!(!dir.join("focusfeed.db-shm").exists());

        // Idempotent: a second launch has nothing left to do.
        assert_eq!(remove_legacy_content_db(&dir), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upgrading_leaves_the_preferences_store_alone() {
        let dir = temp_data_dir("prefs-survive");
        let prefs = dir.join("preferences.db");
        let d = Durable::open(&prefs).unwrap();
        d.set_preference("language", "ar").unwrap();
        drop(d);
        std::fs::write(dir.join("focusfeed.db"), b"old content").unwrap();

        remove_legacy_content_db(&dir);

        assert!(prefs.exists(), "preferences were deleted with the content");
        let reopened = Durable::open(&prefs).unwrap();
        assert_eq!(
            reopened.get_preference("language").unwrap().as_deref(),
            Some("ar")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_leaves_no_content_behind_when_it_exits() {
        // The whole ephemeral-storage promise, end to end: fetch content into
        // the in-memory database, shut down, and confirm the throwaway
        // directory is gone without ever creating content.db.
        let root = temp_data_dir("lifecycle").join("sessions");
        let session = EphemeralSession::create_in(&root).unwrap();
        let dir = session.dir().to_path_buf();
        let db_path = dir.join("content.db");

        let db = Db::in_memory().unwrap();
        let page = MockXProvider::new().get_following_feed(20, None).unwrap();
        db.save_feed_page("following", &page).unwrap();
        db.set_read(&page.posts[0].id, true).unwrap();
        db.pin_account(&page.posts[0].author.id, true).unwrap();
        db.set_muted_word("spoilers", true).unwrap();
        db.create_group("mine", "My group", "#000").unwrap();
        db.add_saved_list("1", "People").unwrap();
        assert!(!db_path.exists());
        assert_eq!(db.stats().unwrap().total_posts, 20);

        let state =
            AppState::with_store(db, std::sync::Arc::new(MemoryStore::new())).with_storage(session);
        let report = state.shutdown();

        assert!(report.directory_removed, "{report:?}");
        assert!(report.errors.is_empty(), "{report:?}");
        assert!(!db_path.exists(), "the content database was created");
        assert!(!dir.exists(), "the session directory survived exit");

        // Everything the run accumulated in the content database went with it
        // — including pins, muted words, session list rows and saved list ids.
        // The user-authored list definitions live in Durable instead.
        let next_run = Db::in_memory().unwrap();
        assert_eq!(next_run.stats().unwrap().total_posts, 0);
        assert!(next_run.pinned_accounts().unwrap().is_empty());
        assert!(next_run.muted_words().unwrap().is_empty());
        assert!(next_run.groups().unwrap().is_empty());
        assert!(next_run.saved_lists().unwrap().is_empty());
        assert!(next_run.read_ids().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shutdown_is_safe_to_call_twice() {
        let root = temp_data_dir("double-exit").join("sessions");
        let session = EphemeralSession::create_in(&root).unwrap();
        let state = AppState::with_store(
            Db::in_memory().unwrap(),
            std::sync::Arc::new(MemoryStore::new()),
        )
        .with_storage(session);

        assert!(state.shutdown().directory_removed);
        let second = state.shutdown();
        assert!(second.errors.is_empty(), "{second:?}");
        assert_eq!(second.files_removed, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_state_with_no_session_directory_still_shuts_down_cleanly() {
        // The in-memory fallback, used when no writable directory exists.
        let state = AppState::with_store(
            Db::in_memory().unwrap(),
            std::sync::Arc::new(MemoryStore::new()),
        );
        let report = state.shutdown();
        assert!(report.errors.is_empty());
        assert_eq!(report.bytes_freed, 0);
    }

    #[test]
    fn durable_preferences_survive_a_session_being_destroyed() {
        let dir = temp_data_dir("split");
        let root = dir.join("sessions");
        let session = EphemeralSession::create_in(&root).unwrap();
        let db = Db::in_memory().unwrap();
        let durable = Durable::open(&dir.join("preferences.db")).unwrap();

        let state = AppState::with_store(db, std::sync::Arc::new(MemoryStore::new()))
            .with_durable(durable)
            .with_storage(session);

        // A durable preference and a session-scoped one, through the same call.
        commands::testing::set_setting(&state, "language", "ar").unwrap();
        commands::testing::set_setting(&state, "hideMetrics", "true").unwrap();
        let before = commands::testing::settings(&state).unwrap();
        assert!(before.contains(&("language".into(), "ar".into())));
        assert!(before.contains(&("hideMetrics".into(), "true".into())));

        state.shutdown();

        // Next run: a fresh session database, the same preferences file.
        let reopened = Durable::open(&dir.join("preferences.db")).unwrap();
        assert_eq!(
            reopened.get_preference("language").unwrap().as_deref(),
            Some("ar"),
            "the language preference did not survive"
        );
        assert!(
            !reopened
                .all_preferences()
                .unwrap()
                .iter()
                .any(|(k, _)| k == "hideMetrics"),
            "a session-scoped setting was written durably"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credentials_are_untouched_by_session_cleanup() {
        // Credentials live in Windows Credential Manager, not on the session
        // path — deleting a session must never disconnect the account.
        let root = temp_data_dir("creds").join("sessions");
        let store = std::sync::Arc::new(MemoryStore::new());
        store
            .save(&XCredentials::parse(TOKEN, CT0).unwrap())
            .unwrap();
        let session = EphemeralSession::create_in(&root).unwrap();
        let state =
            AppState::with_store(Db::in_memory().unwrap(), store.clone()).with_storage(session);

        state.shutdown();

        assert!(store.load().unwrap().is_some(), "credentials were deleted");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_state_without_credentials_reports_disconnected_and_blocks_requests() {
        let state = AppState::with_store(
            Db::in_memory().unwrap(),
            std::sync::Arc::new(MemoryStore::new()),
        );
        let snap = state.session.snapshot();
        assert_eq!(snap.state, SessionState::Disconnected);
        assert_eq!(snap.reason, SessionReason::NoCredentials);
        assert!(snap.account.is_none());
        assert!(!snap.has_credentials);
    }

    #[test]
    fn stored_credentials_are_visible_only_as_presence() {
        let store = std::sync::Arc::new(MemoryStore::new());
        store
            .save(&XCredentials::parse(TOKEN, CT0).unwrap())
            .unwrap();
        let state = AppState::with_store(Db::in_memory().unwrap(), store);

        let snap = state.session.snapshot();
        assert!(snap.has_credentials);
        // Serialising the snapshot is exactly what the IPC layer does.
        let json = serde_json::to_string(&snap).unwrap();
        assert!(
            !json.contains(TOKEN),
            "a token reached the frontend payload"
        );
        assert!(!json.contains(CT0), "ct0 reached the frontend payload");
    }

    #[test]
    fn the_provider_is_always_the_live_one_in_a_production_build() {
        let state = AppState::with_store(
            Db::in_memory().unwrap(),
            std::sync::Arc::new(MemoryStore::new()),
        );
        assert_eq!(state.provider.lock().unwrap().name(), "twitter-cli");
        assert!(!state.kind.lock().unwrap().is_synthetic());
    }

    #[test]
    fn x_lists_are_user_authored_not_fetched() {
        let db = Db::in_memory().unwrap();
        assert!(db.saved_lists().unwrap().is_empty());
        db.add_saved_list("1234567890", "Rust people").unwrap();
        let lists = db.saved_lists().unwrap();
        assert_eq!(lists.len(), 1);
        assert_eq!(lists[0].name, "Rust people");
        db.remove_saved_list("1234567890").unwrap();
        assert!(db.saved_lists().unwrap().is_empty());
    }

    #[test]
    fn clearing_the_cache_removes_every_trace_of_the_previous_account() {
        let db = Db::in_memory().unwrap();
        let page = MockXProvider::new().get_following_feed(10, None).unwrap();
        db.save_feed_page("following", &page).unwrap();
        db.pin_account(&page.posts[0].author.id, true).unwrap();
        db.set_read(&page.posts[0].id, true).unwrap();

        db.clear_cache().unwrap();

        let stats = db.stats().unwrap();
        assert_eq!(stats.total_posts, 0);
        assert_eq!(stats.pinned_count, 0);
        assert!(db.all_authors().unwrap().is_empty());
        assert!(db.read_ids().unwrap().is_empty());
    }
}
