//! Standalone iOS provider. Network requests execute in an isolated native
//! WKWebView on x.com, using its cookie store and WebKit transport. No CLI
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
        let mut deadline = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 75000;
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
    fn name(&self) -> &'static str { "ios-direct" }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities { feed_cursor: true, list_cursor: true, following_cursor: false,
            user_posts_cursor: true, promoted_flag: true, follow: true, unfollow: true,
            unbookmark: true, mute: false, block: false }
    }
    fn get_following_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> { self.page("HomeLatestTimeline", max, cursor, json!({})) }
    fn get_for_you_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> { self.page("HomeTimeline", max, cursor, json!({})) }
    fn get_user_profile(&self, username: &str) -> AppResult<Author> { self.profile(username) }
    fn get_account_relationship(&self, username: &str) -> AppResult<AccountRelationship> {
        validate_username(username)?;
        let data = self.request("UserByScreenName", json!({"screen_name":username,"withSafetyModeUserFields":true}))?;
        Ok(parse_relationship(&data["data"]["user"]["result"]))
    }
    fn get_user_posts(&self, username: &str, max: u32) -> AppResult<FeedPage> {
        self.get_user_posts_page(username, max, None)
    }
    fn get_user_posts_page(&self, username: &str, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
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
fn identity_id(user: &Value) -> Option<String> {
    ["user_id","id_str","rest_id","id"].iter().find_map(|key| user[*key].as_str().map(str::to_owned).or_else(|| user[*key].as_u64().map(|id| id.to_string())))
}
fn parse_relationship(user: &Value) -> AccountRelationship {
    if user.pointer("/relationship_perspectives/follow_request_sent").or_else(||user.pointer("/legacy/follow_request_sent")).and_then(Value::as_bool) == Some(true) { return AccountRelationship::Pending; }
    match user.pointer("/relationship_perspectives/following").or_else(||user.pointer("/legacy/following")).and_then(Value::as_bool) {
        Some(true) => AccountRelationship::Following,
        Some(false) => AccountRelationship::NotFollowing,
        _ => AccountRelationship::Unknown,
    }
}
fn select_identity(me: &Value) -> AppResult<&Value> {
    let missing = || AppError::new(ErrorCode::NotAuthenticated,"Twitter did not identify one active account. Complete sign-in with the intended account.");
    // verify_credentials returns the authenticated user directly. Match the
    // captured active-account cookie whenever it is available.
    if me.get("users").is_none() && me["screen_name"].is_string() {
        if let Some(id) = me["activeUserId"].as_str() {
            if identity_id(me).as_deref() != Some(id) { return Err(missing()); }
        }
        return Ok(me);
    }
    let rows = me.get("users").and_then(Value::as_array).or_else(|| me.as_array()).ok_or_else(missing)?;
    let users: Vec<&Value> = rows.iter().map(|row| row.get("user").unwrap_or(row)).collect();
    if let Some(id) = me["activeUserId"].as_str().or_else(|| me["active_user_id"].as_str()) {
        let matched: Vec<_> = users.iter().filter(|user| identity_id(user).as_deref() == Some(id)).collect();
        return if matched.len() == 1 { Ok(*matched[0]) } else { Err(missing()) };
    }
    let active: Vec<_> = users.iter().filter(|user| user["is_active"].as_bool() == Some(true)).collect();
    if active.len() == 1 { return Ok(*active[0]); }
    if users.len() == 1 { return Ok(users[0]); }
    Err(missing())
}
fn authenticated_identity(me: &Value) -> AppResult<Author> {
    let missing = || connection_fault(tauri_plugin_ios_reader::NativeConnectionFault {
        code:"unsupported_response".into(),stage:"identity".into(),request_id:None,retryable:false,http_status:Some(200),
        ..tauri_plugin_ios_reader::NativeConnectionFault::bridge()
    });
    let user = select_identity(me).map_err(|_| missing())?;
    let id = identity_id(user).filter(|id| !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())).ok_or_else(missing)?;
    let username = user["screen_name"].as_str().ok_or_else(missing)?;
    validate_username(username).map_err(|_| missing())?;
    // The authenticated endpoint already establishes the account. A separate
    // GraphQL profile request is optional enrichment, not a sign-in gate.
    Ok(Author { id, username:username.into(),display_name:string(user,"name").unwrap_or_else(||username.into()),
        avatar_url:string(user,"profile_image_url_https"),verified:user["verified"].as_bool().unwrap_or(false),
        bio:string(user,"description"),followers_count:user["followers_count"].as_u64(),following_count:user["friends_count"].as_u64(),
        ..Author::default() })
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
fn string(value: &Value, key: &str) -> Option<String> { value[key].as_str().map(str::to_owned) }
fn validate_username(username: &str) -> AppResult<()> {
    if username.is_empty() || username.len() > 15 || !username.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err(AppError::new(ErrorCode::BlockedOperation, "Invalid Twitter handle."));
    }
    Ok(())
}
fn date(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    chrono::DateTime::parse_from_str(value, "%a %b %d %H:%M:%S %z %Y").ok().map(|d| d.to_rfc3339())
        .or_else(|| chrono::DateTime::parse_from_rfc3339(value).ok().map(|d| d.to_rfc3339()))
}
fn parse_author(raw: &Value) -> AppResult<Author> {
    let legacy = &raw["legacy"];
    let core = &raw["core"];
    let username = string(core, "screen_name").or_else(|| string(legacy, "screen_name")).ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable, "Profile data was incomplete."))?;
    let id = string(raw, "rest_id").or_else(|| string(legacy, "id_str")).ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable, "Profile ID was missing."))?;
    Ok(Author { id, username, display_name: string(core, "name").or_else(|| string(legacy, "name")).unwrap_or_default(),
        avatar_url: string(&raw["avatar"], "image_url").or_else(|| string(legacy, "profile_image_url_https")),
        banner_url: string(legacy, "profile_banner_url"), verified: raw["is_blue_verified"].as_bool().unwrap_or(false) || legacy["verified"].as_bool().unwrap_or(false),
        bio: string(legacy, "description"), followers_count: legacy["followers_count"].as_u64(), following_count: legacy["friends_count"].as_u64(),
        location: string(&raw["location"], "location").or_else(|| string(legacy, "location")),
        website: legacy.pointer("/entities/url/urls/0/expanded_url").and_then(Value::as_str).map(str::to_owned),
        joined_at: date(&core["created_at"]).or_else(|| date(&legacy["created_at"])), posts_count: legacy["statuses_count"].as_u64() })
}
fn media(raw: &Value) -> Vec<PostMedia> {
    let Some(rows) = raw.pointer("/legacy/extended_entities/media").and_then(Value::as_array) else { return Vec::new() };
    rows.iter().filter_map(|item| {
        let kind = match item["type"].as_str()? { "photo" => MediaKind::Image, "video" => MediaKind::Video, "animated_gif" => MediaKind::Gif, _ => return None };
        let width = item.pointer("/original_info/width").and_then(Value::as_u64).map(|v| v as u32);
        let height = item.pointer("/original_info/height").and_then(Value::as_u64).map(|v| v as u32);
        let mut variants: Vec<MediaVariant> = item.pointer("/video_info/variants").and_then(Value::as_array).into_iter().flatten().filter_map(|v| {
            if v["content_type"] != "video/mp4" { return None }
            let url = v["url"].as_str()?.to_string();
            let dimensions = url.split('/').find_map(|s| { let (w,h) = s.split_once('x')?; Some((w.parse::<u32>().ok()?,h.parse::<u32>().ok()?)) });
            let (w,h) = dimensions.map(|(w,h)|(Some(w),Some(h))).unwrap_or((None,None));
            let bitrate = v["bitrate"].as_u64();
            Some(MediaVariant { label: MediaVariant::label_for(w,h,bitrate).unwrap_or_else(|| "Original".into()), url, width: w, height: h, bitrate })
        }).collect();
        variants.sort_by_key(|v| std::cmp::Reverse(v.bitrate.unwrap_or(0)));
        let image = string(item, "media_url_https");
        let url = if kind == MediaKind::Image { image.clone()? } else { variants.first()?.url.clone() };
        Some(PostMedia { kind, url, preview_url: image, width, height, alt: string(item, "ext_alt_text"),
            duration_ms: item.pointer("/video_info/duration_millis").and_then(Value::as_u64), variants })
    }).collect()
}
fn parse_post(raw: &Value, promoted: bool) -> Option<Post> {
    let raw = raw.get("tweet").unwrap_or(raw);
    let repost = raw.pointer("/legacy/retweeted_status_result/result");
    let original = repost.unwrap_or(raw);
    let original = original.get("tweet").unwrap_or(original);
    let legacy = &original["legacy"];
    let author = parse_author(original.pointer("/core/user_results/result")?).ok()?;
    let id = string(original, "rest_id").or_else(|| string(legacy, "id_str"))?;
    let created_at = date(&legacy["created_at"])?;
    let text = original.pointer("/note_tweet/note_tweet_results/result/text").and_then(Value::as_str)
        .or_else(|| legacy["full_text"].as_str())?.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">");
    let quoted = original.pointer("/quoted_status_result/result").and_then(|q| {
        let q = q.get("tweet").unwrap_or(q);
        Some(Box::new(QuotedPost { id: string(q,"rest_id")?, text: string(&q["legacy"],"full_text")?,
            author: parse_author(q.pointer("/core/user_results/result")?).ok()?, created_at: date(&q["legacy"]["created_at"]), media: media(q), url: None }))
    });
    Some(Post { url: Some(format!("https://x.com/{}/status/{id}", author.username)), id, text, author, created_at,
        lang: string(legacy,"lang"), is_repost: repost.is_some(), reposted_by: if repost.is_some() { raw.pointer("/core/user_results/result").and_then(|v|parse_author(v).ok()) } else { None },
        is_promoted: promoted, quoted,
        metrics: PostMetrics { quotes: legacy["quote_count"].as_u64().unwrap_or(0), replies: legacy["reply_count"].as_u64().unwrap_or(0), reposts: legacy["retweet_count"].as_u64().unwrap_or(0), likes: legacy["favorite_count"].as_u64().unwrap_or(0),
            bookmarks: legacy["bookmark_count"].as_u64().unwrap_or(0), views: original.pointer("/views/count").and_then(|v|v.as_str().and_then(|s|s.parse().ok()).or_else(||v.as_u64())).unwrap_or(0) },
        media: media(original), is_article: original.get("article").is_some(), article_title: original.pointer("/article/article_results/result/title").and_then(Value::as_str).map(str::to_owned),
        in_reply_to: string(legacy,"in_reply_to_status_id_str"), provider: "ios-direct".into() })
}
fn walk(value: &Value, visitor: &mut impl FnMut(&Value)) {
    visitor(value);
    match value { Value::Object(values) => { for (key, value) in values { if key != "quoted_status_result" && key != "retweeted_status_result" { walk(value, visitor); } } }, Value::Array(values) => { for value in values { walk(value, visitor); } }, _ => {} }
}
fn parse_page(data: &Value) -> AppResult<FeedPage> {
    let mut posts = Vec::new(); let mut cursor = None; let mut seen = HashSet::new(); let mut has_instructions = false;
    walk(data, &mut |node| {
        if node.get("instructions").is_some() { has_instructions = true; }
        if node["cursorType"] == "Bottom" { cursor = node["value"].as_str().map(str::to_owned); }
        if let Some(result) = node.pointer("/itemContent/tweet_results/result") {
            let promoted = node.get("promotedMetadata").is_some() || node["itemContent"].get("promotedMetadata").is_some();
            if let Some(post) = parse_post(result, promoted) { if seen.insert(post.id.clone()) { posts.push(post); } }
        }
    });
    if !has_instructions { return Err(AppError::new(ErrorCode::ProviderUnavailable, "Twitter's timeline format changed. Update or reconnect the app.")); }
    Ok(FeedPage { posts, cursor, fetched_at: chrono::Utc::now().to_rfc3339(), provider: "ios-direct".into(), from_cache: false })
}

#[cfg(test)]
mod tests {
    use super::*;
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
    #[test] fn unknown_schema_is_not_an_empty_success() { assert!(parse_page(&json!({"data": {}})).is_err()); }
    #[test] fn parses_cursor_post_and_video_variants_without_quote_duplicates() {
        let author=json!({"rest_id":"1","legacy":{"screen_name":"reader","name":"Reader"}});
        let tweet=json!({"rest_id":"2","legacy":{"full_text":"hello &amp; مرحبا","created_at":"Fri Oct 09 12:00:00 +0000 2026","extended_entities":{"media":[{"type":"video","media_url_https":"https://pbs.twimg.com/a.jpg","original_info":{"width":720,"height":1280},"video_info":{"variants":[{"content_type":"video/mp4","bitrate":2000,"url":"https://video.twimg.com/720x1280/a.mp4"},{"content_type":"video/mp4","bitrate":1000,"url":"https://video.twimg.com/360x640/a.mp4"}]}}]}},"core":{"user_results":{"result":author}}});
        let data=json!({"data":{"home":{"instructions":[{"entries":[{"content":{"itemContent":{"tweet_results":{"result":tweet}}}},{"content":{"cursorType":"Bottom","value":"next"}}]}]}}});
        let page=parse_page(&data).unwrap(); assert_eq!(page.posts.len(),1); assert_eq!(page.cursor.as_deref(),Some("next"));
        assert_eq!(page.posts[0].text,"hello & مرحبا"); assert_eq!(page.posts[0].media[0].variants.len(),2); assert_eq!(page.posts[0].media[0].variants[0].label,"720p");
    }
}
