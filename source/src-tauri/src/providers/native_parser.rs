//! Shared native provider normalization. No network, secrets, or Tauri runtime.
use crate::models::*;
use serde_json::{Value,json};
use std::collections::HashSet;
pub fn string(value: &Value, key: &str) -> Option<String> { value[key].as_str().map(str::to_owned) }
pub fn count(value:&Value)->Option<u64> {value.as_u64().or_else(||value.as_str()?.replace(',',"").parse().ok())}
pub fn validate_username(username: &str) -> AppResult<()> {
    if username.is_empty() || username.len() > 15 || !username.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err(AppError::new(ErrorCode::BlockedOperation, "Invalid Twitter handle."));
    }
    Ok(())
}
pub fn date(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    chrono::DateTime::parse_from_str(value, "%a %b %d %H:%M:%S %z %Y").ok().map(|d| d.to_rfc3339())
        .or_else(|| chrono::DateTime::parse_from_rfc3339(value).ok().map(|d| d.to_rfc3339()))
}
pub fn parse_author(raw: &Value) -> AppResult<Author> {
    let legacy = &raw["legacy"];
    let core = &raw["core"];
    let username = string(core, "screen_name").or_else(|| string(legacy, "screen_name")).ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable, "Profile data was incomplete."))?;
    let id = string(raw, "rest_id").or_else(|| string(legacy, "id_str")).ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable, "Profile ID was missing."))?;
    Ok(Author { id, username, display_name: string(core, "name").or_else(|| string(legacy, "name")).unwrap_or_default(),
        avatar_url: string(&raw["avatar"], "image_url").or_else(|| string(legacy, "profile_image_url_https")),
        banner_url: string(legacy, "profile_banner_url"), verified: raw["is_blue_verified"].as_bool().unwrap_or(false) || legacy["verified"].as_bool().unwrap_or(false) || raw.pointer("/verification/verified").and_then(Value::as_bool).unwrap_or(false),
        bio: string(&raw["profile_bio"], "description").filter(|s|!s.trim().is_empty()).or_else(||string(legacy,"description")).or_else(||string(&raw["profile_bio"],"description")), followers_count: count(raw.pointer("/relationship_counts/followers").unwrap_or(&legacy["followers_count"])), following_count: count(raw.pointer("/relationship_counts/following").unwrap_or(&legacy["friends_count"])),
        location: string(&raw["location"], "location").or_else(|| string(legacy, "location")),
        website: legacy.pointer("/entities/url/urls/0/expanded_url").and_then(Value::as_str).map(str::to_owned),
        joined_at: date(&core["created_at"]).or_else(|| date(&legacy["created_at"])), posts_count: count(raw.pointer("/tweet_counts/tweets").unwrap_or(&legacy["statuses_count"])) })
}
pub fn media(raw: &Value) -> Vec<PostMedia> {
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
pub fn parse_post(raw: &Value, promoted: bool) -> Option<Post> {
    let raw = raw.get("tweet").unwrap_or(raw);
    let repost = raw.pointer("/legacy/retweeted_status_result/result");
    let original = repost.unwrap_or(raw);
    let original = original.get("tweet").unwrap_or(original);
    let legacy = &original["legacy"];
    let author = parse_author(original.pointer("/core/user_results/result")?).ok()?;
    let id = string(original, "rest_id").or_else(|| string(legacy, "id_str"))?;
    let created_at = date(&legacy["created_at"])?;
    let text = original.pointer("/note_tweet/note_tweet_results/result/text").and_then(Value::as_str)
        .or_else(|| legacy["full_text"].as_str()).or_else(||original.pointer("/article/article_results/result/title").and_then(Value::as_str).map(|_|""))?.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">");
    let text=super::content::text(original,&text);
    let quoted = original.pointer("/quoted_status_result/result").and_then(|q| {
        let q = q.get("tweet").unwrap_or(q);
        Some(Box::new(QuotedPost { id: string(q,"rest_id")?, text: super::content::text(q,&string(&q["legacy"],"full_text")?),
            author: parse_author(q.pointer("/core/user_results/result")?).ok()?, created_at: date(&q["legacy"]["created_at"]), media: media(q), url: None }))
    });
    Some(Post { url: Some(format!("https://x.com/{}/status/{id}", author.username)), id, text, author, created_at,
        lang: string(legacy,"lang"), is_repost: repost.is_some(), reposted_by: if repost.is_some() { raw.pointer("/core/user_results/result").and_then(|v|parse_author(v).ok()) } else { None },
        is_promoted: promoted, quoted,
        metrics: PostMetrics { quotes: legacy["quote_count"].as_u64().unwrap_or(0), replies: legacy["reply_count"].as_u64().unwrap_or(0), reposts: legacy["retweet_count"].as_u64().unwrap_or(0), likes: legacy["favorite_count"].as_u64().unwrap_or(0),
            bookmarks: legacy["bookmark_count"].as_u64().unwrap_or(0), views: original.pointer("/views/count").and_then(|v|v.as_str().and_then(|s|s.parse().ok()).or_else(||v.as_u64())).unwrap_or(0) },
        media: media(original), is_article: original.pointer("/article/article_results/result/title").and_then(Value::as_str).is_some(), article_title: original.pointer("/article/article_results/result/title").and_then(Value::as_str).map(str::to_owned),
        in_reply_to: string(legacy,"in_reply_to_status_id_str"), provider: "ios-direct".into() })
}
pub fn walk(value: &Value, visitor: &mut impl FnMut(&Value)) {
    visitor(value);
    match value { Value::Object(values) => { for (key, value) in values { if key != "quoted_status_result" && key != "retweeted_status_result" { walk(value, visitor); } } }, Value::Array(values) => { for value in values { walk(value, visitor); } }, _ => {} }
}
pub fn parse_page(data: &Value) -> AppResult<FeedPage> {
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

/// Conversation cursors belong to the outer timeline, never a nested reply module.
pub fn parse_replies(data:&Value,id:&str,first:bool)->AppResult<FeedPage> {
    let instructions=data.pointer("/data/threaded_conversation_with_injections_v2/instructions")
        .or_else(||data.pointer("/data/threaded_conversation_with_injections/instructions"))
        .or_else(||data.pointer("/data/tweetResult/result/timeline/instructions"))
        .filter(|v|v.is_array()).ok_or_else(||AppError::new(ErrorCode::SchemaChanged,"Comments could not be read. Try again later."))?;
    let mut page=parse_page(&json!({"instructions":instructions}))?;
    let focal=data.pointer("/data/tweetResult/result").and_then(|v|parse_post(v,false)).is_some_and(|p|p.id==id);
    if first && !focal && !page.posts.iter().any(|post|post.id==id) {return Err(AppError::new(ErrorCode::ProviderUnavailable,"The original post is unavailable. Comments could not be loaded."));}
    page.posts.retain(|post|post.in_reply_to.as_deref()==Some(id) && !post.is_promoted && !post.is_repost);
    page.posts.truncate(20);
    page.cursor=None;
    for instruction in instructions.as_array().unwrap() {
        for entry in instruction["entries"].as_array().into_iter().flatten().chain(instruction.get("entry")) {
            let content=&entry["content"];
            if matches!(content["cursorType"].as_str(),Some("Bottom"|"ShowMoreThreads")) {
                page.cursor=content["value"].as_str().filter(|s|!s.is_empty() && s.len()<=4096).map(str::to_owned);
            }
        }
    }
    Ok(page)
}

pub fn identity_id(user: &Value) -> Option<String> {
    ["user_id","id_str","rest_id","id"].iter().find_map(|key| user[*key].as_str().map(str::to_owned).or_else(|| user[*key].as_u64().map(|id| id.to_string())))
}
pub fn select_identity(me: &Value) -> AppResult<&Value> {
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
pub fn authenticated_identity(me: &Value) -> AppResult<Author> {
    let missing = || {
        let fault=tauri_plugin_ios_reader::NativeConnectionFault {code:"unsupported_response".into(),stage:"identity".into(),request_id:None,retryable:false,http_status:Some(200),..tauri_plugin_ios_reader::NativeConnectionFault::bridge()};
        let mut error=AppError::new(ErrorCode::SchemaChanged,fault.message());error.native_connection_fault=Some(fault);error
    };
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