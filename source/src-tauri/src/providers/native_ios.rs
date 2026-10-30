//! Standalone iOS provider. Network requests execute in an isolated native
//! engine with authenticated URLSession HTTP and a private cookie store. No CLI
//! process, Windows host, remote relay, or credential-bearing frontend call.
use super::{ProviderCapabilities, XDataProvider};
use crate::{credentials::CredentialStore, models::*};
use serde_json::{json, Value};
use std::{collections::{HashSet,HashMap}, sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}}, time::{Instant,SystemTime,UNIX_EPOCH}};
static REQUEST_GENERATION: AtomicU64 = AtomicU64::new(1);
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static ACCOUNT_GENERATION: AtomicU64 = AtomicU64::new(1);
type ProfileCache = HashMap<String,(u64,Instant,Author)>;
static PROFILES: std::sync::OnceLock<Mutex<ProfileCache>> = std::sync::OnceLock::new();
pub fn cancel_reads() -> u64 { REQUEST_GENERATION.fetch_add(1,Ordering::SeqCst) + 1 }
pub fn invalidate_account() { cancel_reads(); ACCOUNT_GENERATION.fetch_add(1,Ordering::SeqCst); if let Some(cache)=PROFILES.get() { cache.lock().unwrap().clear(); } }
std::thread_local! { static PRIORITY: std::cell::Cell<u8> = const { std::cell::Cell::new(1) }; }
std::thread_local! { static AUTHENTICATING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
std::thread_local! { static READ_DEADLINE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) }; }
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
/// Profile lookup and its dependent page share one foreground deadline.
struct ReadBudgetGuard(Option<u64>);
impl ReadBudgetGuard {
    fn new() -> Self { Self(READ_DEADLINE.with(|p| {let previous=p.get();p.set(Some(previous.unwrap_or_else(||now_ms()+30000)));previous})) }
}
impl Drop for ReadBudgetGuard {fn drop(&mut self) {READ_DEADLINE.with(|p|p.set(self.0));}}
pub struct AuthenticationGuard(bool);
impl AuthenticationGuard { pub fn new() -> Self { Self(AUTHENTICATING.with(|p| p.replace(true))) } }
impl Drop for AuthenticationGuard { fn drop(&mut self) { AUTHENTICATING.with(|p| p.set(self.0)); } }
pub struct PriorityGuard(u8);
impl PriorityGuard { pub fn new(priority: u8) -> Self { Self(PRIORITY.with(|p| p.replace(priority))) } }
impl Drop for PriorityGuard { fn drop(&mut self) { PRIORITY.with(|p| p.set(self.0)); } }

#[cfg(target_os = "ios")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
#[cfg(target_os = "ios")]
pub fn initialize(app: tauri::AppHandle) { let _ = APP.set(app); }

pub fn native_call<T: serde::de::DeserializeOwned>(command: &str, args: Value) -> AppResult<T> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        let app = APP.get().ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable, "The native reader is not ready."))?;
        return app.state::<tauri_plugin_ios_reader::IosReader<tauri::Wry>>()
            .call(command, args).map_err(connection_fault);
    }
    #[cfg(not(target_os = "ios"))]
    { let _ = (command, args); Err(AppError::new(ErrorCode::BlockedOperation, "Native Twitter sign-in requires an iPhone.")) }
}
pub fn connection_fault(fault: tauri_plugin_ios_reader::NativeConnectionFault) -> AppError {
    let code = match fault.code.as_str() {
        "authentication_expired" => ErrorCode::NotAuthenticated,
        "timeout" => ErrorCode::ProcessTimeout,
        "rate_limited" => ErrorCode::RateLimited,
        "account_challenge" => ErrorCode::ApiError,
        "cancelled" | "background_paused" => ErrorCode::BlockedOperation,
        "network_failure" => ErrorCode::NetworkUnavailable,
        "transaction_bootstrap" | "unsupported_response" => ErrorCode::SchemaChanged,
        _ => ErrorCode::ProviderUnavailable,
    };
    let mut error = AppError::new(code, fault.message());
    error.native_connection_fault = Some(fault);
    error
}
fn background_paused(error: &AppError) -> bool {
    error.native_connection_fault.as_ref().is_some_and(|fault| fault.code == "background_paused")
}
/// Only the explicit sign-in transaction waits for activation. Regular reads
/// remain cancellable, and account writes are never replayed by this helper.
pub fn login_call<T: serde::de::DeserializeOwned>(command: &str, args: Value) -> AppResult<T> {
    loop {
        let _: Value = native_call("waitForLoginActive", json!({}))?;
        match native_call(command, args.clone()) {
            Err(error) if background_paused(&error) => continue,
            result => return result,
        }
    }
}

pub struct NativeIosProvider { store: Arc<dyn CredentialStore> }
impl NativeIosProvider {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self { Self { store } }
    fn request(&self, operation: &str, variables: Value) -> AppResult<Value> {
        let generation = REQUEST_GENERATION.load(Ordering::SeqCst);
        let authentication = AUTHENTICATING.with(|p| p.get());
        let write = ["Follow","Unfollow","DeleteBookmark"].contains(&operation);
        let credentials = self.store.load()?.ok_or_else(|| AppError::new(ErrorCode::NotAuthenticated, "Sign in to Twitter to load your feed."))?;
        // Plugin responses and errors are stripped of headers/cookies. Never log args.
        let budget = if authentication || write { 75000 } else { 30000 };
        let mut deadline = now_ms() + budget;
        if !authentication && !write { if let Some(overall)=READ_DEADLINE.with(|p|p.get()) {deadline=deadline.min(overall);} }
        let mut retried_transport = false;
        let result = loop {
        if authentication { let _: Value = native_call("waitForLoginActive",json!({}))?; }
        let result = native_call("request", json!({"operation": operation, "variables": variables,
            "authToken": credentials.auth_token, "ct0": credentials.ct0,
            "context": {"id": REQUEST_ID.fetch_add(1,Ordering::SeqCst).to_string(), "generation": generation,
                "priority": if write || authentication { 0 } else if operation == "Me" { 3 } else { PRIORITY.with(|p| p.get()) },
                "deadline": deadline, "authentication":authentication}}));
        if authentication && result.as_ref().err().is_some_and(background_paused) {
            // WebKit work is stopped in the background. Keep the candidate
            // session and start a fresh read deadline when the scene resumes.
            let _: Value = native_call("waitForLoginActive",json!({}))?;
            deadline = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 75000;
            continue;
        }
        let transport_interrupted = result.as_ref().err().and_then(|e| e.native_connection_fault.as_ref()).is_some_and(|fault| fault.code == "transport_initialization");
        if !retried_transport && !write && transport_interrupted && (authentication || generation == REQUEST_GENERATION.load(Ordering::SeqCst)) { retried_transport = true; continue; }
        break result;
        };
        if !write && !authentication && generation != REQUEST_GENERATION.load(Ordering::SeqCst) { return Err(AppError::new(ErrorCode::BlockedOperation,"This request is no longer needed.")); }
        response_body(result?)
    }
    fn page(&self, operation: &str, max: u32, cursor: Option<String>, extra: Value) -> AppResult<FeedPage> {
        let mut variables = json!({"count": max.clamp(1, 60), "includePromotedContent": false,
            "withQuickPromoteEligibilityTweetFields": true, "withVoice": true, "withV2Timeline": true});
        if let Some(cursor) = cursor { variables["cursor"] = Value::String(cursor); }
        if let Some(extra) = extra.as_object() { for (key, value) in extra { variables[key] = value.clone(); } }
        parse_page(&self.request(operation, variables)?)
    }
    fn profile(&self, username: &str) -> AppResult<Author> {
        validate_username(username)?;
        let generation = ACCOUNT_GENERATION.load(Ordering::SeqCst);
        let key = username.to_ascii_lowercase();
        let cache = PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
        if let Some((epoch,time,author)) = cache.lock().unwrap().get(&key) {
            if *epoch == generation && time.elapsed().as_secs() < 900 { return Ok(author.clone()); }
        }
        let data = self.request("UserByScreenName", json!({"screen_name": username, "withSafetyModeUserFields": true}))?;
        let author = parse_author(data.pointer("/data/user/result").ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable, "Twitter did not return this profile."))?)?;
        let mut entries = cache.lock().unwrap();
        entries.retain(|_,(epoch,time,_)| *epoch == generation && time.elapsed().as_secs() < 900);
        if entries.len() >= 256 { entries.clear(); }
        entries.insert(key,(generation,Instant::now(),author.clone()));
        Ok(author)
    }
}
fn response_body(result: Value) -> AppResult<Value> {
    let status = result["status"].as_u64().filter(|s| (100..=599).contains(s)).map(|s| s as u16);
    let id = result.pointer("/timing/requestId").and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())).map(str::to_owned);
    let challenge = result.pointer("/body/errors").and_then(Value::as_array).is_some_and(|errors| errors.iter().any(|e| e["code"].as_u64() == Some(326)));
    response_body_inner(result).map_err(|mut error| {
        error.native_connection_fault = Some(tauri_plugin_ios_reader::NativeConnectionFault {
            code: if challenge { "account_challenge" } else { match error.code { ErrorCode::NotAuthenticated => "authentication_expired", ErrorCode::RateLimited => "rate_limited", _ => "provider_rejection" } }.into(),
            stage: "provider".into(), request_id: id, retryable: !matches!(error.code,ErrorCode::NotAuthenticated|ErrorCode::RateLimited) && !challenge, http_status: status,
            ..tauri_plugin_ios_reader::NativeConnectionFault::bridge()
        });
        error
    })
}
fn response_body_inner(result: Value) -> AppResult<Value> {
    let status = result["status"].as_u64().unwrap_or(0);
    let body = result.get("body").cloned().unwrap_or(Value::Null);
    if status == 401 { return Err(AppError::new(ErrorCode::NotAuthenticated, "Twitter rejected this session. Sign in again.")); }
    if status == 429 { return Err(AppError::new(ErrorCode::RateLimited, "Twitter is limiting requests. Your loaded posts remain available; try again later.")); }
    if let Some(errors) = body["errors"].as_array() {
        if !errors.is_empty() {
            let code = errors[0]["code"].as_u64();
            return Err(AppError::new(if code == Some(88) { ErrorCode::RateLimited } else if matches!(code, Some(32 | 89 | 215)) { ErrorCode::NotAuthenticated } else { ErrorCode::ProviderUnavailable }, "Twitter returned an API error. Reconnect or try again later."));
        }
    }
    if status == 403 { return Err(AppError::new(ErrorCode::ApiError,"Twitter refused this request. The account may need attention in the official Twitter page.")); }
    if !(200..300).contains(&status) { return Err(AppError::new(ErrorCode::ProviderUnavailable, "Twitter could not complete this request. Try again.")); }
    Ok(body)
}
impl XDataProvider for NativeIosProvider {
    fn get_post_replies(&self,id:&str,cursor:Option<String>)->AppResult<FeedPage> {
        let id=crate::security::clean_numeric_id(id).ok_or_else(||AppError::new(ErrorCode::BlockedOperation,"Invalid post ID."))?;
        let _budget=ReadBudgetGuard::new();
        let first=cursor.is_none();
        let mut vars=json!({"focalTweetId":id,"count":20,"referrer":"tweet","with_rux_injections":false,"includePromotedContent":false,"rankingMode":"Relevance","withCommunity":true,"withQuickPromoteEligibilityTweetFields":true,"withBirdwatchNotes":true,"withVoice":true});
        if let Some(cursor)=cursor {vars["cursor"]=cursor.into();}
        parse_replies(&self.request("TweetDetail",vars)?,&id,first)
    }
    fn get_post_content(&self,id:&str)->AppResult<PostContent> {
        if id.is_empty() || id.len()>32 || !id.bytes().all(|b|b.is_ascii_digit()) {return Err(AppError::new(ErrorCode::BlockedOperation,"Invalid post ID."));}
        let _budget=ReadBudgetGuard::new();
        let data=self.request("TweetResultByRestId",json!({"tweetId":id,"withCommunity":false,"includePromotedContent":false,"withVoice":false}))?;
        let raw=data.pointer("/data/tweetResult/result").ok_or_else(||AppError::new(ErrorCode::ProviderUnavailable,"This post could not be loaded."))?;
        let raw=raw.get("tweet").unwrap_or(raw);
        let post=parse_post(raw,false).filter(|post|post.id==id).ok_or_else(||AppError::new(ErrorCode::ProviderUnavailable,"This post is unavailable."))?;
        Ok(PostContent{post,article:super::content::article(raw)})
    }
    fn name(&self) -> &'static str { "ios-direct" }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities { feed_cursor: true, list_cursor: true, following_cursor: true,
            user_posts_cursor: true, promoted_flag: true, follow: true, unfollow: true,
            unbookmark: true, mute: false, block: false }
    }
    fn get_following_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> { self.page("HomeLatestTimeline", max, cursor, json!({})) }
    fn get_for_you_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> { self.page("HomeTimeline", max, cursor, json!({})) }
    fn get_user_profile(&self, username: &str) -> AppResult<Author> { self.profile(username) }
    fn refresh_user_profile(&self,username:&str)->AppResult<Author> {
        if let Some(cache)=PROFILES.get(){cache.lock().unwrap().remove(&username.to_ascii_lowercase());}
        self.profile(username)
    }
    fn get_account_relationship(&self, username: &str) -> AppResult<AccountRelationship> {
        validate_username(username)?;
        let data = self.request("UserByScreenName", json!({"screen_name":username,"withSafetyModeUserFields":true}))?;
        Ok(parse_relationship(&data["data"]["user"]["result"]))
    }
    fn get_user_posts(&self, username: &str, max: u32) -> AppResult<FeedPage> {
        self.get_user_posts_page(username, max, None)
    }
    fn get_user_posts_page(&self, username: &str, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        let _budget=ReadBudgetGuard::new();
        let profile = self.profile(username)?;
        self.page("UserTweets", max, cursor, json!({"userId": profile.id}))
    }
    fn get_bookmarks_page(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> { self.page("Bookmarks", max, cursor, json!({})) }
    fn get_bookmarks(&self, max: u32) -> AppResult<FeedPage> {
        let mut page = self.page("Bookmarks", max, None, json!({}))?;
        let mut seen: HashSet<String> = page.posts.iter().map(|p| p.id.clone()).collect();
        let mut cursors = HashSet::new();
        while page.posts.len() < max as usize {
            let Some(cursor) = page.cursor.clone() else { break };
            if !cursors.insert(cursor.clone()) { break; }
            let next = self.page("Bookmarks", (max as usize - page.posts.len()).min(60) as u32, Some(cursor), json!({}))?;
            page.cursor = next.cursor;
            page.posts.extend(next.posts.into_iter().filter(|p| seen.insert(p.id.clone())));
        }
        Ok(page)
    }
    fn get_following_accounts(&self, username: &str, max: u32) -> AppResult<Vec<Author>> {
        let profile = self.profile(username)?;
        let mut accounts = Vec::new();
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut cursors = HashSet::new();
        while accounts.len() < max.min(1000) as usize {
            let mut variables = json!({"userId": profile.id, "count": (max as usize - accounts.len()).min(60), "includePromotedContent": false});
            if let Some(value) = cursor { variables["cursor"] = Value::String(value); }
            let data = self.request("Following", variables)?;
            let mut next = None;
            walk(&data, &mut |node| {
                if node["cursorType"] == "Bottom" { next = node["value"].as_str().map(str::to_owned); }
                if let Some(user) = node.pointer("/user_results/result") {
                    if let Ok(author) = parse_author(user) { if seen.insert(author.id.clone()) { accounts.push(author); } }
                }
            });
            if next.is_none() || next.as_ref().is_some_and(|c| !cursors.insert(c.clone())) { break; }
            cursor = next;
        }
        accounts.truncate(max as usize);
        Ok(accounts)
    }
    fn get_following_accounts_page(&self, username: &str, max: u32, cursor: Option<String>) -> AppResult<AccountPage> {
        let _budget=ReadBudgetGuard::new();
        let profile = self.profile(username)?;
        let mut variables = json!({"userId":profile.id,"count":max.clamp(1,60),"includePromotedContent":false});
        if let Some(value) = cursor { variables["cursor"] = Value::String(value); }
        let data = self.request("Following", variables)?;
        let mut accounts = Vec::new(); let mut next = None; let mut seen = HashSet::new();
        walk(&data, &mut |node| {
            if node["cursorType"] == "Bottom" { next = node["value"].as_str().map(str::to_owned); }
            if let Some(user) = node.pointer("/user_results/result") {
                if let Ok(author) = parse_author(user) { if seen.insert(author.id.clone()) { accounts.push(author); } }
            }
        });
        Ok(AccountPage { accounts, cursor:next.filter(|v| !v.is_empty()) })
    }
    fn get_list_timeline(&self, list_id: &str, max: u32) -> AppResult<FeedPage> { self.get_list_timeline_page(list_id, max, None) }
    fn get_list_timeline_page(&self, list_id: &str, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        if list_id.is_empty() || !list_id.bytes().all(|b| b.is_ascii_digit()) { return Err(AppError::new(ErrorCode::BlockedOperation, "List ID must be numeric.")); }
        self.page("ListLatestTweetsTimeline", max, cursor, json!({"listId": list_id}))
    }
    fn get_current_user(&self) -> AppResult<Author> {
        let me = self.request("Me", json!({}))?;
        authenticated_identity(&me)
    }
    fn status(&self) -> AppResult<AuthenticationStatus> {
        let account = self.get_current_user()?;
        Ok(AuthenticationStatus { authenticated: true, username: Some(account.username.clone()), account: Some(account), checked_at: chrono::Utc::now().to_rfc3339(), message: "Direct connection from this iPhone.".into() })
    }
    fn follow_account(&self, username: &str, _permit: &crate::security::WritePermit) -> AppResult<()> {
        validate_username(username)?;
        reconcile_write(self.request("Follow", json!({"screen_name": username})), || self.read_relationship(username,true))
    }
    fn unfollow_account(&self, username: &str, _permit: &crate::security::WritePermit) -> AppResult<()> {
        validate_username(username)?;
        reconcile_write(self.request("Unfollow", json!({"screen_name": username})), || self.read_relationship(username,false))
    }
    fn remove_bookmark(&self, id: &str, _permit: &crate::security::BookmarkPermit) -> AppResult<()> {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) { return Err(AppError::new(ErrorCode::BlockedOperation, "Invalid post ID.")); }
        reconcile_write(self.request("DeleteBookmark", json!({"tweet_id": id})), || {
            // Absence from a prefix is not proof of removal. Keep an uncertain
            // result unless the subsequent read explicitly carries its state.
            let data=self.request("Bookmarks",json!({"count":60,"includePromotedContent":false}))?;
            let mut removed=false;
            walk(&data,&mut |node| { if node["rest_id"].as_str()==Some(id) && node["bookmarked"].as_bool()==Some(false) { removed=true; } });
            Ok(removed)
        })
    }
}
fn parse_relationship(user: &Value) -> AccountRelationship {
    if user.pointer("/relationship_perspectives/follow_request_sent").or_else(||user.pointer("/legacy/follow_request_sent")).and_then(Value::as_bool) == Some(true) { return AccountRelationship::Pending; }
    match user.pointer("/relationship_perspectives/following").or_else(||user.pointer("/legacy/following")).and_then(Value::as_bool) {
        Some(true) => AccountRelationship::Following,
        Some(false) => AccountRelationship::NotFollowing,
        _ => AccountRelationship::Unknown,
    }
}

impl NativeIosProvider {
    fn read_relationship(&self, username: &str, expected: bool) -> AppResult<bool> {
        let data=self.request("UserByScreenName",json!({"screen_name":username,"withSafetyModeUserFields":true}))?;
        let user=&data["data"]["user"]["result"];
        let following=user.pointer("/relationship_perspectives/following").or_else(||user.pointer("/legacy/following")).and_then(Value::as_bool);
        Ok(following==Some(expected))
    }
}
fn reconcile_write(result: AppResult<Value>, verify: impl FnOnce() -> AppResult<bool>) -> AppResult<()> {
    match result {
        Ok(_) => Ok(()),
        Err(error) if matches!(error.code,ErrorCode::ProviderUnavailable|ErrorCode::NetworkUnavailable|ErrorCode::ProcessTimeout|ErrorCode::InvalidJson|ErrorCode::EmptyResponse|ErrorCode::SchemaChanged) => {
            if matches!(verify(),Ok(true)) { Ok(()) }
            else { Err(error.with_repair("The action result is uncertain. A subsequent read could not confirm it. Refresh to check before another deliberate action.")) }
        }
        Err(error) => Err(error),
    }
}
use super::native_parser::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn modern_profile_bio_and_string_counts_do_not_depend_on_legacy_description() {
        let raw=json!({"rest_id":"12","core":{"name":"Author","screen_name":"author"},"profile_bio":{"description":"نبذة\nSecond line"},"legacy":{"followers_count":"12,400","friends_count":0}});
        let author=parse_author(&raw).unwrap();assert_eq!(author.bio.as_deref(),Some("نبذة\nSecond line"));assert_eq!(author.followers_count,Some(12400));assert_eq!(author.following_count,Some(0));
        let minimal=parse_author(&json!({"rest_id":"12","core":{"screen_name":"author"}})).unwrap();assert!(minimal.bio.is_none());assert!(minimal.followers_count.is_none());
    }
    #[test] fn migrated_profiles_need_no_legacy_object_and_preserve_actual_zero() {
        let raw=json!({"rest_id":"12","core":{"name":"Author","screen_name":"author"},"profile_bio":{"description":"Real bio"},"relationship_counts":{"followers":0,"following":"18"},"tweet_counts":{"tweets":7},"verification":{"verified":true},"legacy":{"followers_count":999}});
        let a=parse_author(&raw).unwrap();assert_eq!(a.bio.as_deref(),Some("Real bio"));assert_eq!(a.followers_count,Some(0));assert_eq!(a.following_count,Some(18));assert_eq!(a.posts_count,Some(7));assert!(a.verified);
        let a=parse_author(&json!({"rest_id":"12","core":{"screen_name":"author"},"profile_bio":{"description":""},"legacy":{"description":"Still available"}})).unwrap();assert_eq!(a.bio.as_deref(),Some("Still available"));
    }
    #[test] fn uncertain_write_uses_one_read_and_never_repeats_the_write() {
        let mut reads=0;
        let result=reconcile_write(Err(AppError::new(ErrorCode::ProviderUnavailable,"response lost")),||{reads+=1;Ok(true)});
        assert!(result.is_ok());assert_eq!(reads,1);
    }
    #[test] fn missing_read_evidence_keeps_the_action_uncertain() {
        let result=reconcile_write(Err(AppError::new(ErrorCode::ProcessTimeout,"response lost")),||Ok(false)).unwrap_err();
        assert!(result.repair.unwrap().contains("uncertain"));
    }
    #[test] fn success_and_rate_limits_do_not_trigger_reconciliation_traffic() {
        assert!(reconcile_write(Ok(json!({})),||panic!("unneeded read")).is_ok());
        assert!(reconcile_write(Err(AppError::new(ErrorCode::RateLimited,"wait")),||panic!("must respect rate limit")).is_err());
    }
    #[test] fn rejects_auth_and_rate_limits_without_leaking_response() {
        for (status, expected) in [(401, ErrorCode::NotAuthenticated),(403, ErrorCode::ApiError),(429, ErrorCode::RateLimited)] {
            let error = response_body(json!({"status":status,"body":{"cookie":"secret"}})).unwrap_err();
            assert_eq!(error.code, expected); assert!(!error.message.contains("secret"));
        }
    }
    #[test] fn identity_selection_matches_active_cookie_and_rejects_ambiguous_accounts() {
        let users = json!({"users":[{"user_id":"1","screen_name":"first"},{"user_id":"2","screen_name":"active"}],"activeUserId":"2"});
        assert_eq!(select_identity(&users).unwrap()["screen_name"],"active");
        assert!(select_identity(&json!({"users":users["users"]})).is_err());
        assert!(select_identity(&json!({"users":users["users"],"activeUserId":"3"})).is_err());
        assert_eq!(select_identity(&json!([{"user":{"id_str":"1","screen_name":"legacy"}}])).unwrap()["screen_name"],"legacy");
    }
    #[test] fn minimal_authenticated_identity_needs_no_graphql_profile() {
        let direct=authenticated_identity(&json!({"id_str":"42","screen_name":"reader","activeUserId":"42"})).unwrap();
        assert_eq!(direct.id,"42");
        assert!(authenticated_identity(&json!({"id_str":"42","screen_name":"reader","activeUserId":"43"})).is_err());
        let author=authenticated_identity(&json!({"users":[{"user_id":"42","screen_name":"reader","name":"Reader"}],"activeUserId":"42"})).unwrap();
        assert_eq!(author.id,"42");assert_eq!(author.username,"reader");assert_eq!(author.display_name,"Reader");
        assert_eq!(author.followers_count,None);
        let legacy=authenticated_identity(&json!([{"user":{"id_str":"43","screen_name":"legacy","followers_count":10}}])).unwrap();
        assert_eq!(legacy.followers_count,Some(10));
    }
    #[test] fn authenticated_identity_requires_a_valid_matching_account() {
        for response in [json!({"users":[{"screen_name":"reader"}]}),json!({"users":[{"user_id":"42","screen_name":"invalid handle"}]}),
            json!({"users":[{"user_id":"42","screen_name":"reader"}],"activeUserId":"43"})] {
            assert_eq!(authenticated_identity(&response).unwrap_err().native_connection_fault.unwrap().stage,"identity");
        }
    }
    #[test] fn authentication_scope_is_restored_and_pause_is_distinct_from_cancel() {
        assert!(!AUTHENTICATING.with(|p|p.get()));
        { let _guard=AuthenticationGuard::new();assert!(AUTHENTICATING.with(|p|p.get())); }
        assert!(!AUTHENTICATING.with(|p|p.get()));
        let error=connection_fault(tauri_plugin_ios_reader::fault::decode::<Value>(json!({"fault":{"code":"background_paused","stage":"identity","requestId":"3","retryable":true,"httpStatus":null}})).unwrap_err());
        assert!(background_paused(&error));assert!(!background_paused(&AppError::new(ErrorCode::BlockedOperation,"cancelled")));
    }
    #[test] fn relationships_require_explicit_evidence_and_preserve_pending_requests() {
        assert_eq!(parse_relationship(&json!({"legacy":{"following":false}})),AccountRelationship::NotFollowing);
        assert_eq!(parse_relationship(&json!({"relationship_perspectives":{"following":true}})),AccountRelationship::Following);
        assert_eq!(parse_relationship(&json!({"legacy":{"following":false,"follow_request_sent":true}})),AccountRelationship::Pending);
        assert_eq!(parse_relationship(&json!({"rest_id":"1"})),AccountRelationship::Unknown);
    }
    #[test] fn an_auth_api_code_is_distinct_from_an_unspecified_forbidden_response() {
        assert_eq!(response_body(json!({"status":403,"body":{"errors":[{"code":89,"message":"secret"}]}})).unwrap_err().code,ErrorCode::NotAuthenticated);
        let rejected = response_body(json!({"status":403,"body":{},"timing":{"requestId":"73"}})).unwrap_err();
        let metadata = rejected.native_connection_fault.unwrap();
        assert_eq!(metadata.code,"provider_rejection");
        assert_eq!(metadata.http_status,Some(403));
        assert_eq!(metadata.request_id.as_deref(),Some("73"));
        let fault = tauri_plugin_ios_reader::fault::decode::<Value>(json!({"fault":{"code":"transaction_bootstrap","stage":"bootstrap","requestId":"12","retryable":true,"httpStatus":null}})).unwrap_err();
        let error = connection_fault(fault);
        assert_eq!(error.code,ErrorCode::SchemaChanged);
        assert_eq!(error.native_connection_fault.unwrap().stage,"bootstrap");
    }
    #[test] fn native_http_fixture_yields_posts_and_cursor() {
        let data: Value = serde_json::from_str(include_str!("../../../tools/ios-native-tests/timeline.json")).unwrap();
        let page = parse_page(&data).unwrap();
        assert_eq!(page.posts.len(), 1);
        assert_eq!(page.posts[0].text, "Fixture live post");
        assert_eq!(page.posts[0].author.username, "fixture");
        assert_eq!(page.cursor.as_deref(), Some("fixture-next"));
    }
    #[test] fn unknown_schema_is_not_an_empty_success() { assert!(parse_page(&json!({"data": {}})).is_err()); }
    #[test] fn parses_cursor_post_and_video_variants_without_quote_duplicates() {
        let author=json!({"rest_id":"1","legacy":{"screen_name":"reader","name":"Reader"}});
        let tweet=json!({"rest_id":"2","legacy":{"full_text":"hello &amp; مرحبا","created_at":"Fri Oct 09 12:00:00 +0000 2026","extended_entities":{"media":[{"type":"video","media_url_https":"https://pbs.twimg.com/a.jpg","original_info":{"width":720,"height":1280},"video_info":{"variants":[{"content_type":"video/mp4","bitrate":2000,"url":"https://video.twimg.com/720x1280/a.mp4"},{"content_type":"video/mp4","bitrate":1000,"url":"https://video.twimg.com/360x640/a.mp4"}]}}]}},"core":{"user_results":{"result":author}}});
        let data=json!({"data":{"home":{"instructions":[{"entries":[{"content":{"itemContent":{"tweet_results":{"result":tweet}}}},{"content":{"cursorType":"Bottom","value":"next"}}]}]}}});
        let page=parse_page(&data).unwrap(); assert_eq!(page.posts.len(),1); assert_eq!(page.cursor.as_deref(),Some("next"));
        assert_eq!(page.posts[0].text,"hello & مرحبا"); assert_eq!(page.posts[0].media[0].variants.len(),2); assert_eq!(page.posts[0].media[0].variants[0].label,"720p");
    }
}

#[cfg(test)]
mod conversation_tests {
    use super::*;
    fn row(id:&str,parent:Option<&str>)->Value {
        json!({"itemContent":{"tweet_results":{"result":{"rest_id":id,"legacy":{"full_text":format!("Post {id}"),"created_at":"Fri Oct 09 12:00:00 +0000 2026","in_reply_to_status_id_str":parent},"core":{"user_results":{"result":{"rest_id":"42","core":{"screen_name":"reader","name":"Reader"}}}}}}}})
    }
    #[test] fn comments_exclude_ancestors_recommendations_duplicates_and_nested_cursors() {
        let rows=json!({"data":{"threaded_conversation_with_injections_v2":{"instructions":[{"entries":[
            {"content":row("123",None)},
            {"content":{"items":[{"item":row("124",Some("123"))},{"item":row("124",Some("123"))},{"item":row("125",Some("124"))},{"item":row("999",None)},{"cursorType":"Bottom","value":"nested-do-not-follow"}]}},
            {"content":{"cursorType":"Bottom","value":"outer-page"}}
        ]}]}}});
        let page=parse_replies(&rows,"123",true).unwrap();assert_eq!(page.posts.len(),1);assert_eq!(page.posts[0].id,"124");assert_eq!(page.cursor.as_deref(),Some("outer-page"));
        let mut focal=row("123",None)["itemContent"]["tweet_results"]["result"].clone();
        focal["timeline"]=json!({"instructions":[{"entries":[{"content":row("124",Some("123"))}]}]});
        let alternate=json!({"data":{"tweetResult":{"result":focal}}});
        assert_eq!(parse_replies(&alternate,"123",true).unwrap().posts[0].id,"124");
    }
    #[test] fn missing_or_deleted_original_is_not_a_successful_empty_first_page() {
        assert!(parse_replies(&json!({}),"123",true).is_err());
        let empty=json!({"data":{"threaded_conversation_with_injections":{"instructions":[{"entries":[]}]}}});
        assert!(parse_replies(&empty,"123",true).is_err());
        assert!(parse_replies(&empty,"123",false).unwrap().posts.is_empty());
    }
}
