use focusfeed_core::{CoreEngine, CoreOperation as Op, CoreRequest};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::TempDir;

static SEQUENCE: AtomicU64 = AtomicU64::new(1);
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn request(operation: Op, args: Value, generation: u64) -> CoreRequest {
    CoreRequest {
        request_id: format!("test-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed)),
        account_generation: generation,
        source_revision: 0,
        deadline_millis: now() + 30_000,
        priority: 1,
        operation,
        arguments_json: args.to_string(),
    }
}
fn call(core: &CoreEngine, op: Op, args: Value, generation: u64) -> Value {
    serde_json::from_str(&core.execute(request(op, args, generation)).unwrap()).unwrap()
}
fn author(id: &str, name: &str) -> Value {
    json!({"id":id,"username":name,"displayName":name,"avatarUrl":"https://pbs.twimg.com/profile_images/test/avatar.jpg"})
}
fn post(id: &str) -> Value {
    json!({"id":id,"text":"Post","author":author("2","reader"),"createdAt":"2026-10-30T08:00:00Z",
        "media":[{"kind":"image","url":"https://pbs.twimg.com/media/image.jpg","variants":[]}],"provider":"ios-direct"})
}
fn page(posts: Vec<Value>, cursor: Option<&str>) -> Value {
    json!({"posts":posts,"cursor":cursor,"fetchedAt":"2026-10-30T08:00:00Z","provider":"ios-direct","fromCache":false})
}
fn engine() -> (TempDir, CoreEngine) {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreEngine::open(dir.path()).unwrap();
    call(
        &core,
        Op::SetAccount,
        json!({"account":author("1","owner")}),
        1,
    );
    (dir, core)
}

#[test]
fn stale_cancelled_expired_and_obsolete_source_results_never_ingest() {
    let (_dir, core) = engine();
    let args = json!({"feed":"following","body":page(vec![post("10")],None)});
    let cancelled = request(Op::IngestFeed, args.clone(), 1);
    core.cancel_request(&cancelled.request_id);
    assert_eq!(core.execute(cancelled).unwrap_err().code, "cancelled");
    let mut expired = request(Op::IngestFeed, args.clone(), 1);
    expired.deadline_millis = 0;
    assert_eq!(core.execute(expired).unwrap_err().code, "cancelled");
    let mut fresh = request(Op::IngestFeed, args.clone(), 1);
    fresh.source_revision = 2;
    core.execute(fresh).unwrap();
    let mut obsolete = request(
        Op::IngestFeed,
        json!({"feed":"following","body":page(vec![post("11")],None)}),
        1,
    );
    obsolete.source_revision = 1;
    assert_eq!(core.execute(obsolete).unwrap_err().code, "stale_request");
    call(
        &core,
        Op::SetAccount,
        json!({"account":author("3","other")}),
        2,
    );
    assert_eq!(
        core.execute(request(Op::IngestFeed, args, 1))
            .unwrap_err()
            .code,
        "stale_request"
    );
    assert_eq!(
        call(&core, Op::GetFeed, json!({"feed":"following"}), 2)["posts"],
        json!([])
    );
}

#[test]
fn account_epoch_change_invalidates_old_media_and_repeated_recovery_is_bounded() {
    let (_dir, core) = engine();
    let registered = call(
        &core,
        Op::RegisterMedia,
        json!({"url":"https://pbs.twimg.com/media/test.jpg","postId":"10"}),
        1,
    );
    let handle = registered["handle"].as_str().unwrap();
    assert!(handle.starts_with("ffmedia:"));
    assert!(!registered.to_string().contains("twimg.com"));
    let resolved = call(&core, Op::GetMediaUrl, json!({"handle":handle}), 1);
    let old = resolved["url"].as_str().unwrap();
    assert!(old.starts_with("http://127.0.0.1:"));
    assert!(core
        .execute(request(
            Op::ValidateMediaUrl,
            json!({"url":old.replace("127.0.0.1","localhost")}),
            1
        ))
        .is_err());
    assert!(core
        .execute(request(
            Op::ProbeMedia,
            json!({"url":"https://example.invalid/"}),
            1
        ))
        .is_err());
    let missing = format!("{}00", old.rsplit_once('/').unwrap().0.to_string() + "/");
    assert_eq!(
        call(&core, Op::ProbeMedia, json!({"url":missing}), 1)["kind"],
        "registration"
    );
    call(&core, Op::RestartMedia, json!({}), 1);
    assert!(core
        .execute(request(Op::ValidateMediaUrl, json!({"url":old}), 1))
        .is_err());
    for _ in 0..100 {
        let registered = call(
            &core,
            Op::RegisterMedia,
            json!({"url":"https://pbs.twimg.com/media/test.jpg","postId":"10"}),
            1,
        );
        assert!(call(
            &core,
            Op::GetMediaUrl,
            json!({"handle":registered["handle"]}),
            1
        )["valid"]
            .as_bool()
            .unwrap());
        call(&core, Op::CancelMedia, json!({}), 1);
        assert!(core
            .execute(request(
                Op::GetMediaUrl,
                json!({"handle":registered["handle"]}),
                1
            ))
            .is_err());
    }
    let diagnostics = call(&core, Op::Diagnostics, json!({}), 1);
    assert_eq!(diagnostics["media"]["registrations"], 0);
    assert_eq!(diagnostics["media"]["available"], true);
    assert!(core
        .execute(request(
            Op::RegisterMedia,
            json!({"url":"https://pbs.twimg.com.evil.test/media/test.jpg"}),
            1
        ))
        .is_err());
}

#[test]
fn lists_keep_former_followed_members_and_pin_read_muted_state_matches_canonical_store() {
    let (_dir, core) = engine();
    call(
        &core,
        Op::IngestFollowing,
        json!({"accounts":[author("2","reader"),author("3","third")],"syncId":"first","complete":true}),
        1,
    );
    call(
        &core,
        Op::UpsertList,
        json!({"id":"list-a","name":"Read","color":"#123456"}),
        1,
    );
    call(
        &core,
        Op::SetListMember,
        json!({"listId":"list-a","authorId":"2","member":true}),
        1,
    );
    call(
        &core,
        Op::PinAccount,
        json!({"authorId":"2","pinned":true}),
        1,
    );
    let pinned = call(&core, Op::GetPinnedAccounts, json!({}), 1);
    assert_eq!(pinned[0]["id"], "2");
    assert!(pinned[0]["avatarUrl"]
        .as_str()
        .unwrap()
        .starts_with("ffmedia:"));
    call(
        &core,
        Op::IngestFollowing,
        json!({"accounts":[author("3","third")],"syncId":"second","complete":true}),
        1,
    );
    let candidates = call(
        &core,
        Op::GetGroupCandidates,
        json!({"groupId":"list-a"}),
        1,
    );
    let former = candidates
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["author"]["id"] == "2")
        .unwrap();
    assert_eq!(former["following"], false);
    assert_eq!(former["member"], true);
    assert!(core
        .execute(request(
            Op::SetListMember,
            json!({"listId":"missing","authorId":"3","member":true}),
            1
        ))
        .is_err());
    call(&core, Op::MarkRead, json!({"postId":"10","read":true}), 1);
    assert_eq!(call(&core, Op::GetReadIds, json!({}), 1), json!(["10"]));
    call(
        &core,
        Op::SetMutedWord,
        json!({"word":"spoiler","muted":true}),
        1,
    );
    assert_eq!(
        call(&core, Op::GetMutedWords, json!({}), 1),
        json!(["spoiler"])
    );
}

#[test]
fn account_actions_require_confirmation_and_uncertain_results_are_not_replayed() {
    let (_dir, core) = engine();
    call(
        &core,
        Op::IngestFeed,
        json!({"feed":"bookmarks","body":page(vec![post("10")],None)}),
        1,
    );
    assert_eq!(
        core.execute(request(
            Op::PrepareAction,
            json!({"operation":"unbookmark","postId":"10"}),
            1
        ))
        .unwrap_err()
        .code,
        "confirmation_required"
    );
    assert_eq!(
        core.execute(request(
            Op::PrepareAction,
            json!({"operation":"unbookmark","postId":"11","confirmed":true}),
            1
        ))
        .unwrap_err()
        .code,
        "not_bookmarked"
    );
    assert_eq!(
        core.execute(request(
            Op::PrepareAction,
            json!({"operation":"unfollow","username":"reader"}),
            1
        ))
        .unwrap_err()
        .code,
        "confirmation_required"
    );
    let action = call(
        &core,
        Op::PrepareAction,
        json!({"operation":"unbookmark","postId":"10","confirmed":true}),
        1,
    );
    assert_eq!(
        core.execute(request(Op::ClearSession, json!({"disconnect":true}), 1))
            .unwrap_err()
            .code,
        "action_in_flight"
    );
    assert_eq!(
        core.execute(request(
            Op::SetAccount,
            json!({"account":author("3","other")}),
            2
        ))
        .unwrap_err()
        .code,
        "action_in_flight"
    );
    let result = call(
        &core,
        Op::FinishAction,
        json!({"token":action["token"],"outcome":"uncertain"}),
        1,
    );
    assert_eq!(result["requiresReconciliation"], true);
    assert_eq!(result["automaticRetry"], false);
    assert_eq!(
        call(&core, Op::GetFeed, json!({"feed":"bookmarks"}), 1)["posts"][0]["id"],
        "10"
    );
    assert!(core
        .execute(request(
            Op::FinishAction,
            json!({"token":action["token"],"outcome":"succeeded"}),
            1
        ))
        .is_err());
}

#[test]
fn verified_upgrade_backup_retains_settings_and_lists_and_corruption_never_deletes_source() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("preferences.db");
    {
        let durable = focusfeed_core::durable::Durable::open(&path).unwrap();
        durable.set_preference("language", "ar").unwrap();
        durable
            .upsert_account_list("1", "local", "My list", "#123456")
            .unwrap();
        durable
            .set_account_list_member("1", "local", "2", true)
            .unwrap();
    }
    let core = CoreEngine::open(dir.path()).unwrap();
    assert_eq!(
        call(&core, Op::GetPreferences, json!({}), 0)["language"],
        "ar"
    );
    call(
        &core,
        Op::SetAccount,
        json!({"account":author("1","owner")}),
        1,
    );
    assert_eq!(
        call(&core, Op::GetLists, json!({}), 1)[0]["memberIds"],
        json!(["2"])
    );
    let backup = dir.path().join("preferences.native-migration-v1.backup.db");
    assert!(backup.exists());
    let conn = rusqlite::Connection::open(backup).unwrap();
    let language: String = conn
        .query_row(
            "SELECT value FROM preferences WHERE key='language'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(language, "ar");
    drop(core);
    let bad = tempfile::tempdir().unwrap();
    let corrupt = bad.path().join("preferences.db");
    std::fs::write(&corrupt, b"not sqlite; preserve exactly").unwrap();
    assert!(CoreEngine::open(bad.path()).is_err());
    assert_eq!(
        std::fs::read(corrupt).unwrap(),
        b"not sqlite; preserve exactly"
    );
}

#[test]
fn resume_markers_are_opt_in_account_and_destination_scoped_and_deleted_on_disconnect() {
    let (_dir, core) = engine();
    assert_eq!(call(&core, Op::GetResumeState, json!({}), 1), Value::Null);
    for (route, id) in [("following", "10"), ("bookmarks", "11")] {
        call(
            &core,
            Op::SetResumeState,
            json!({"state":{"enabled":true,"route":route,"postID":id,"offset":20.0,"accountID":"1"}}),
            1,
        );
    }
    assert_eq!(
        call(&core, Op::GetResumeState, json!({"route":"following"}), 1)["postID"],
        "10"
    );
    assert_eq!(
        call(&core, Op::GetResumeState, json!({"route":"bookmarks"}), 1)["postID"],
        "11"
    );
    assert!(core
        .execute(request(
            Op::SetResumeState,
            json!({"state":{"enabled":true,"route":"search","postID":"10","offset":0.0}}),
            1
        ))
        .is_err());
    call(&core, Op::ClearSession, json!({"disconnect":true}), 1);
    call(
        &core,
        Op::SetAccount,
        json!({"account":author("1","owner")}),
        2,
    );
    assert_eq!(call(&core, Op::GetResumeState, json!({}), 2), Value::Null);
}

#[test]
fn payload_eviction_retains_complete_bookmark_index_and_reports_rehydration_ids() {
    let (_dir, core) = engine();
    // Each bounded incoming page is below the 8 MiB request ceiling. Traversal
    // nevertheless exceeds the 64 MiB body budget while every id remains
    // navigable through the independent order index.
    let text = "x".repeat(1024 * 1024);
    for batch in 0..18 {
        let posts = (0..4)
            .map(|offset| {
                let mut item = post(&(1000 + batch * 4 + offset).to_string());
                item["text"] = json!(text);
                item
            })
            .collect();
        call(
            &core,
            Op::IngestFeed,
            json!({"feed":"bookmarks","body":page(posts,Some("older")),"append":batch>0,"complete":false}),
            1,
        );
    }
    let diagnostics = call(&core, Op::Diagnostics, json!({}), 1);
    assert!(diagnostics["payloadBytes"].as_u64().unwrap() <= 64 * 1024 * 1024);
    assert_eq!(diagnostics["indexedPosts"], 72);
    assert!(diagnostics["residentPosts"].as_u64().unwrap() < 72);
    let page = call(
        &core,
        Op::GetFeed,
        json!({"feed":"bookmarks","limit":80}),
        1,
    );
    assert_eq!(page["totalCached"], 72);
    assert!(!page["missingPostIds"].as_array().unwrap().is_empty());
    assert_eq!(page["nextCursor"], "older");
}

#[test]
fn continuation_returns_only_its_new_page_and_group_reads_use_durable_members() {
    let (_dir, core) = engine();
    call(
        &core,
        Op::IngestFeed,
        json!({"feed":"following","body":page(vec![post("10")],Some("next"))}),
        1,
    );
    let next = call(
        &core,
        Op::IngestFeed,
        json!({"feed":"following","body":page(vec![post("11")],None),"append":true}),
        1,
    );
    assert_eq!(next["posts"].as_array().unwrap().len(), 1);
    assert_eq!(next["posts"][0]["id"], "11");
    assert_eq!(next["totalCached"], 2);
    call(
        &core,
        Op::IngestFollowing,
        json!({"accounts":[author("2","reader")],"complete":true}),
        1,
    );
    call(
        &core,
        Op::UpsertList,
        json!({"id":"local","name":"Reading"}),
        1,
    );
    call(
        &core,
        Op::SetListMember,
        json!({"listId":"local","authorId":"2","member":true}),
        1,
    );
    let group = call(
        &core,
        Op::GetGroupFeed,
        json!({"groupId":"local","offset":0,"limit":1}),
        1,
    );
    assert_eq!(group["memberCount"], 1);
    assert_eq!(group["totalCached"], 2);
    assert_eq!(group["posts"].as_array().unwrap().len(), 1);
    assert_eq!(group["nextOffset"], 1);
}
