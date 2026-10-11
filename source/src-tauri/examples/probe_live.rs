//! Development probe: inspect real twitter-cli output **shape** without ever
//! surfacing a credential or a signed URL.
//!
//! This exists because two 0.2.0 defects could not be diagnosed from fixtures:
//! search failing with `not_found`, and no video ever playing. Both needed to
//! be looked at against a real authenticated session. Search is gone from the
//! app entirely now, so only the modes below remain.
//!
//! ## What it will not do
//!
//! It never prints `auth_token`, `ct0`, a Cookie header, a child-process
//! environment, or a full media URL. Media URLs are reduced to host + path
//! shape + which query parameters exist **by name only**, because a signed X
//! media URL carries its authorisation in the query string. Every line printed
//! also goes through `security::sanitize` as a backstop.
//!
//! Run with:
//!
//! ```text
//! cargo run --example probe_live -- following
//! cargo run --example probe_live -- videos
//! ```

use app_lib::credentials::{CredentialStore, KeyringStore};
use app_lib::providers::twitter_cli::TwitterCliProvider;
use app_lib::providers::XDataProvider;
use app_lib::security;
use std::sync::Arc;

/// Print a line, sanitised. Every output path goes through here.
fn say(line: impl AsRef<str>) {
    println!("{}", security::sanitize(line.as_ref()));
}

/// Describe a URL without disclosing it.
///
/// X media URLs are signed: the query string *is* the credential. So we report
/// the host, the extension, and the names of the query parameters, never a
/// value and never the full path.
fn describe_url(url: &str) -> String {
    let (before_q, query) = match url.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (url, None),
    };
    let host = before_q
        .split("//")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .unwrap_or("?");
    let ext = before_q.rsplit('.').next().unwrap_or("?");
    let segments = before_q.matches('/').count();
    let params: Vec<&str> = query
        .map(|q| q.split('&').filter_map(|p| p.split('=').next()).collect())
        .unwrap_or_default();
    format!(
        "host={host} ext={ext} segments={segments} query_params={:?} signed={}",
        params,
        query.is_some()
    )
}

/// Keys whose values are structural rather than personal, and so are safe to
/// print in full. Everything else is reported as a type name only.
const SAFE_VALUE_KEYS: &[&str] = &["ok", "schema_version", "type", "code", "hasMore"];

/// Describe a JSON document as key paths and value types.
///
/// Never prints a string value unless its key is in [`SAFE_VALUE_KEYS`]. A
/// cursor is reported as a length: its presence and rough size answer the
/// capability question, and its contents are session data we have no reason to
/// put on a console.
fn walk_shape(path: &str, v: &serde_json::Value, out: &mut Vec<String>, depth: usize) {
    use serde_json::Value;
    if depth > 6 {
        out.push(format!("{path}: …(depth capped)"));
        return;
    }
    let leaf = path.rsplit('.').next().unwrap_or("");
    match v {
        Value::Object(map) => {
            out.push(format!("{path}/ object ({} keys)", map.len()));
            for (k, child) in map {
                let next = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                walk_shape(&next, child, out, depth + 1);
            }
        }
        // Only the first element: every later one has the same shape, and
        // printing all of them would be a payload dump by another name.
        Value::Array(items) => {
            out.push(format!("{path}[] array (len {})", items.len()));
            if let Some(first) = items.first() {
                walk_shape(&format!("{path}[0]"), first, out, depth + 1);
            }
        }
        Value::String(s) => {
            if SAFE_VALUE_KEYS.contains(&leaf) {
                out.push(format!("{path}: string = {s:?}"));
            } else {
                out.push(format!("{path}: string (len {})", s.chars().count()));
            }
        }
        Value::Number(n) => out.push(format!("{path}: number = {n}")),
        Value::Bool(b) => out.push(format!("{path}: bool = {b}")),
        Value::Null => out.push(format!("{path}: null")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("videos");

    let store: Arc<dyn CredentialStore> = Arc::new(KeyringStore::new());
    match store.load() {
        Ok(Some(_)) => say("credentials: present (value never read by this probe)"),
        Ok(None) => {
            say("credentials: none stored — connect an account in the app first");
            return;
        }
        Err(e) => {
            say(format!("credentials: unreadable ({})", e.message));
            return;
        }
    }
    let provider = TwitterCliProvider::new(store);

    match mode {
        // Stage-by-stage timing of the People You Follow load, so the slow
        // part is measured rather than guessed at.
        "following" => {
            say("--- following: stage timings ---");
            let t0 = std::time::Instant::now();
            let status = provider.status();
            say(format!(
                "1. session validation (twitter status): {:?} -> {}",
                t0.elapsed(),
                match &status {
                    Ok(s) => format!("authenticated={}", s.authenticated),
                    Err(e) => format!("error {:?}", e.code),
                }
            ));

            let t1 = std::time::Instant::now();
            // A bare number means "resolve the handle, use this as max".
            let handle_arg = args
                .get(1)
                .filter(|a| !a.is_empty() && a.parse::<u32>().is_err())
                .cloned();
            let handle = match handle_arg {
                Some(h) => {
                    say("2. handle: supplied on the command line (no call made)");
                    h
                }
                _ => match provider.get_current_user() {
                    Ok(a) => {
                        say(format!("2. whoami: {:?}", t1.elapsed()));
                        a.username
                    }
                    Err(e) => {
                        say(format!("2. whoami FAILED: {:?}", e.code));
                        return;
                    }
                },
            };

            let max: u32 = args
                .iter()
                .skip(1)
                .find_map(|a| a.parse::<u32>().ok())
                .unwrap_or(200);
            say(format!("   (requesting max={max})"));
            let t2 = std::time::Instant::now();
            match provider.get_following_accounts(&handle, max) {
                Ok(list) => {
                    say(format!(
                        "3. following command + parse: {:?} -> {} accounts",
                        t2.elapsed(),
                        list.len()
                    ));
                    let with_bio = list.iter().filter(|a| a.bio.is_some()).count();
                    let with_followers =
                        list.iter().filter(|a| a.followers_count.is_some()).count();
                    let with_avatar = list.iter().filter(|a| a.avatar_url.is_some()).count();
                    say(format!(
                        "   already enriched: bio={with_bio} followers={with_followers} avatar={with_avatar} of {}",
                        list.len()
                    ));
                }
                Err(e) => say(format!(
                    "3. following FAILED after {:?}: code={:?}",
                    t2.elapsed(),
                    e.code
                )),
            }
            say(format!("TOTAL: {:?}", t0.elapsed()));
        }
        // Write the first video URL to a file so an HTTP probe can test what
        // the server actually returns. Written to disk, never to the console:
        // it stays out of any transcript while still being testable.
        "videourl" => {
            let out = args
                .get(1)
                .cloned()
                .unwrap_or_else(|| "video-url.txt".into());
            match provider.get_following_feed(60, None) {
                Err(e) => say(format!("ERR: code={:?} message={}", e.code, e.message)),
                Ok(page) => {
                    let found: Vec<String> = page
                        .posts
                        .iter()
                        .flat_map(|p| p.media.iter())
                        .filter(|m| matches!(m.kind, app_lib::models::MediaKind::Video))
                        .map(|m| m.url.clone())
                        .take(3)
                        .collect();
                    say(format!("found {} video url(s)", found.len()));
                    if let Err(e) = std::fs::write(&out, found.join("\n")) {
                        say(format!("could not write: {e}"));
                    } else {
                        say("written to the requested path (not printed)");
                    }
                }
            }
        }
        // The whole media path, end to end, against the real CDN: take a live
        // video URL, register it, start the real proxy, and pull bytes back
        // through it with a Range request. This is the check that says whether
        // the transport actually works — the unit tests use a fixture upstream.
        //
        // The URL itself is never printed, only what came back through it.
        "proxy" => {
            use app_lib::media_proxy::{MediaProxy, MediaRegistry};
            use std::sync::Arc;

            say("--- media proxy against the real CDN ---");
            let urls: Vec<String> = match provider.get_following_feed(60, None) {
                Err(e) => {
                    say(format!("feed ERR: code={:?} {}", e.code, e.message));
                    return;
                }
                Ok(page) => page
                    .posts
                    .iter()
                    .flat_map(|p| p.media.iter())
                    .filter(|m| {
                        matches!(
                            m.kind,
                            app_lib::models::MediaKind::Video | app_lib::models::MediaKind::Gif
                        )
                    })
                    .map(|m| m.url.clone())
                    .take(3)
                    .collect(),
            };
            say(format!(
                "found {} video/gif source(s) in the feed",
                urls.len()
            ));
            if urls.is_empty() {
                say("nothing to test with");
                return;
            }

            let rt = tokio::runtime::Runtime::new().expect("runtime");
            rt.block_on(async move {
                let registry = Arc::new(MediaRegistry::new());
                let proxy = match MediaProxy::start(Arc::clone(&registry)).await {
                    Ok(p) => p,
                    Err(e) => {
                        say(format!("proxy failed to start: {}", e.message));
                        return;
                    }
                };
                say(format!("proxy bound on 127.0.0.1:{}", proxy.port()));
                let client = reqwest::Client::new();

                for (i, url) in urls.iter().enumerate() {
                    let Some(id) = registry.register(url, "probe", "probe") else {
                        say(format!("video {}: REJECTED by host validation", i + 1));
                        continue;
                    };
                    let local = proxy.url_for(&id);

                    // A Range request is what the <video> element issues when
                    // it seeks, so this is the case that matters.
                    match client
                        .get(&local)
                        .header("range", "bytes=0-65535")
                        .header("origin", "http://tauri.localhost")
                        .send()
                        .await
                    {
                        Err(e) => say(format!("video {}: transport error ({e})", i + 1)),
                        Ok(res) => {
                            let status = res.status().as_u16();
                            let ctype = res
                                .headers()
                                .get("content-type")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("-")
                                .to_string();
                            let crange = res
                                .headers()
                                .get("content-range")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("-")
                                .to_string();
                            let ranges = res
                                .headers()
                                .get("accept-ranges")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("-")
                                .to_string();
                            let cors = res
                                .headers()
                                .get("access-control-allow-origin")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("-")
                                .to_string();
                            let cookie = res.headers().get("set-cookie").is_some();
                            let bytes = res.bytes().await.map(|b| b.len()).unwrap_or(0);
                            say(format!(
                                "video {}: status={status} type={ctype} range={crange} accept-ranges={ranges}",
                                i + 1
                            ));
                            say(format!(
                                "         cors={cors} set-cookie-forwarded={cookie} bytes={bytes}"
                            ));
                        }
                    }
                }
            });
        }
        // Prove continuation is real: page 2 must return posts page 1 did not.
        // A cursor that silently restarts the feed is worse than no cursor.
        "cursor" => {
            say("--- feed cursor continuation ---");
            match provider.get_following_feed(10, None) {
                Err(e) => say(format!("page 1 ERR: code={:?} {}", e.code, e.message)),
                Ok(p1) => {
                    let ids1: std::collections::HashSet<String> =
                        p1.posts.iter().map(|p| p.id.clone()).collect();
                    say(format!(
                        "page 1: {} posts, cursor present = {}",
                        p1.posts.len(),
                        p1.cursor.is_some()
                    ));
                    let Some(c) = p1.cursor.clone() else {
                        say("no cursor returned — continuation unsupported here");
                        return;
                    };
                    say(format!("cursor length = {}", c.len()));
                    match provider.get_following_feed(10, Some(c.clone())) {
                        Err(e) => say(format!("page 2 ERR: code={:?} {}", e.code, e.message)),
                        Ok(p2) => {
                            let fresh = p2.posts.iter().filter(|p| !ids1.contains(&p.id)).count();
                            say(format!(
                                "page 2: {} posts, {} of them new, cursor advanced = {}",
                                p2.posts.len(),
                                fresh,
                                p2.cursor.as_deref() != Some(c.as_str())
                            ));
                        }
                    }
                }
            }
        }
        // Dump the *structure* of a raw envelope: key paths and value types,
        // never values. This is how the 0.8.6 pagination and profile-field
        // changes were mapped without ever printing a real payload.
        "shape" => {
            let op = args.get(1).cloned().unwrap_or_else(|| "feed".into());
            let extra: Vec<String> = args.iter().skip(2).cloned().collect();
            say(format!("--- shape of `{op}` ---"));
            match provider.raw_op(&op, &extra) {
                Err(e) => say(format!("ERR: code={:?} message={}", e.code, e.message)),
                Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                    Err(e) => say(format!("not JSON: {e}")),
                    Ok(v) => {
                        let mut out = Vec::new();
                        walk_shape("", &v, &mut out, 0);
                        for line in out {
                            say(line);
                        }
                    }
                },
            }
        }
        _ => {
            // Media shape from the real home timeline.
            say("--- feed media shapes ---");
            let started = std::time::Instant::now();
            match provider.get_following_feed(60, None) {
                Err(e) => say(format!("ERR: code={:?} message={}", e.code, e.message)),
                Ok(page) => {
                    say(format!(
                        "fetched {} posts in {:?}",
                        page.posts.len(),
                        started.elapsed()
                    ));
                    let mut seen = 0;
                    for p in &page.posts {
                        for m in &p.media {
                            say(format!(
                                "post_media kind={:?} width={:?} height={:?} duration={:?} variants={}",
                                m.kind, m.width, m.height, m.duration_ms, m.variants.len()
                            ));
                            say(format!("  url:     {}", describe_url(&m.url)));
                            if let Some(pv) = &m.preview_url {
                                say(format!("  preview: {}", describe_url(pv)));
                            }
                            for v in &m.variants {
                                say(format!(
                                    "  variant label={} bitrate={:?} {}",
                                    v.label,
                                    v.bitrate,
                                    describe_url(&v.url)
                                ));
                            }
                            seen += 1;
                        }
                        if seen >= 12 {
                            break;
                        }
                    }
                    if seen == 0 {
                        say("no media in this page at all");
                    }
                }
            }
        }
    }
}
