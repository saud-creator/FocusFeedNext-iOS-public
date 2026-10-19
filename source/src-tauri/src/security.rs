//! Process-security layer.
//!
//! Two jobs:
//!   1. A fixed allowlist of read-only backend operations. The frontend can
//!      never ask for an arbitrary command; it names an operation and the Rust
//!      side builds the argument array itself.
//!   2. Secret scrubbing. Nothing that reaches a log, a diagnostic report, or
//!      an error message may contain auth_token / ct0 / cookies / bearer tokens.

/// Read-only operations this release is permitted to run.
///
/// Narrowed for 0.2.0 to the nine operations the interface actually needs.
/// `tweet`, `thread`, `article` and `followers` were removed along with reply
/// threads and the followers view: an operation nothing calls is attack surface
/// with no upside.
pub const ALLOWED_OPS: &[&str] = &[
    "status",     // session check
    "whoami",     // active account identity
    "feed",       // Following feed
    "bookmarks",  // Bookmarks page
    "following",  // People You Are Following
    "user",       // internal profile header
    "user-posts", // internal profile timeline
    // No "search". The Search page is gone and `XDataProvider` has no
    // free-text method left, so nothing can reach this operation — and an
    // operation nothing calls is attack surface with no upside.
    "list", // Lists page
];

/// Hosts an "open on X" action is permitted to reach.
///
/// Deliberately exact — no suffix matching. `x.com.evil.test` ends with
/// `x.com` under a naive check and must not pass.
const X_HOSTS: &[&str] = &["x.com", "www.x.com", "twitter.com", "www.twitter.com"];

/// Validate a URL that claims to point at a post or profile on X.
///
/// Returns the trimmed URL when it is safe to hand to the operating system.
/// Everything else — `javascript:`, `file:`, `data:`, a custom scheme, plain
/// http, an embedded credential, or any host that is not X — is refused.
///
/// This is deliberately stricter than [`is_safe_external_url`]: a link found
/// inside a post can legitimately point anywhere, but "Open original post"
/// has exactly one correct destination.
pub fn validate_x_url(url: &str) -> Option<&str> {
    let trimmed = url.trim();
    let rest = trimmed.strip_prefix("https://")?;
    // A userinfo section (`https://user:pass@host/`) would let a crafted link
    // display one host while resolving to another.
    if rest.split('/').next()?.contains('@') {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if !X_HOSTS.contains(&host.as_str()) {
        return None;
    }
    // Control characters and whitespace inside a URL are a smuggling vector.
    if trimmed.chars().any(|c| c.is_control() || c == ' ') {
        return None;
    }
    Some(trimmed)
}

/// Validate an arbitrary outbound link, such as one found in a post's text.
///
/// These can point anywhere, so the rule is only that the scheme cannot launch
/// a local file or a custom protocol handler.
pub fn is_safe_external_url(url: &str) -> bool {
    let t = url.trim();
    if t.chars().any(|c| c.is_control()) {
        return false;
    }
    t.starts_with("https://") || t.starts_with("http://")
}

/// Build the canonical URL of a post from parts we always have.
///
/// twitter-cli publishes no permalink field, so every "open original" action
/// depends on this. The handle and id are validated first: a malformed payload
/// must not be able to steer the resulting URL.
pub fn post_permalink(username: &str, post_id: &str) -> Option<String> {
    let user = clean_screen_name(username)?;
    let id = clean_numeric_id(post_id)?;
    Some(format!("https://x.com/{user}/status/{id}"))
}

/// Build the canonical URL of a profile.
pub fn profile_permalink(username: &str) -> Option<String> {
    let user = clean_screen_name(username)?;
    Some(format!("https://x.com/{user}"))
}

/// Write operations that are hard-blocked on the read path. twitter-cli
/// supports most of these; Focus Feed Next deliberately exposes none of them
/// through [`is_allowed`].
///
/// `follow` and `unfollow` stay on this list even though the app can now run
/// them. That is the point of the two-door design: the ordinary read path
/// refuses both regardless of any preference, and the only other way in is a
/// [`WritePermit`], which cannot be constructed without permission.
///
/// `repost`, `unrepost`, `mute` and `block` are not commands in twitter-cli
/// 0.8.6 at all — see [`UNAVAILABLE_OPS`]. They are listed anyway so that a
/// future upstream release cannot quietly become reachable: the allowlist would
/// reject them regardless, and this list makes the intent explicit and testable.
pub const BLOCKED_OPS: &[&str] = &[
    "post",
    "reply",
    "quote",
    "delete",
    "like",
    "unlike",
    "retweet",
    "unretweet",
    "repost",
    "unrepost",
    "follow",
    "unfollow",
    "bookmark",
    "unbookmark",
    "favorite",
    "unfavorite",
    "mute",
    "unmute",
    "block",
    "unblock",
];

/// The only account-changing operations this release can perform at all.
///
/// Two entries, and they are inverses of one another: an app that can unfollow
/// but cannot put the follow back has made the reader's mistake permanent.
/// Both stay in [`BLOCKED_OPS`] as well, so the ordinary read path can never
/// reach either one; the only way in is [`WritePermit`], which cannot be
/// constructed without the durable preference being on.
pub const GATED_WRITE_OPS: &[&str] = &["follow", "unfollow"];

/// The only additional write operation exposed by the reader. It is kept out
/// of the account-action preference because removing a bookmark is a
/// post-specific action guarded by an explicit confirmation dialog.
pub const BOOKMARK_WRITE_OP: &str = "unbookmark";

/// Proof that the user confirmed removal of one X bookmark. This is separate
/// from `WritePermit`: list/bookmark editing must never inherit the account
/// follow preference by accident.
#[derive(Debug)]
pub struct BookmarkPermit;

impl BookmarkPermit {
    pub fn confirmed(confirmed: bool) -> Option<Self> {
        confirmed.then_some(Self)
    }
}

/// Account-changing operations twitter-cli 0.8.6 does not have.
///
/// Checked against the pinned build's own `--help`: there is no `mute` and no
/// `block` subcommand, and no `repost`/`unrepost` either. This is recorded as
/// data rather than left implicit so the interface can *say* "not available
/// through this backend" instead of offering a control that would fail, and so
/// a test can hold that claim to the same standard as the rest of the app.
///
/// An entry here is a statement about upstream, not a policy. Policy lives in
/// [`BLOCKED_OPS`] and [`GATED_WRITE_OPS`], which is why every name below also
/// appears in the blocklist: if a future twitter-cli grows one of these, it is
/// still refused until somebody deliberately says otherwise.
pub const UNAVAILABLE_OPS: &[&str] = &["mute", "unmute", "block", "unblock", "repost", "unrepost"];

/// True when the pinned backend has no such command at all.
pub fn is_unavailable(op: &str) -> bool {
    let op = op.trim().to_ascii_lowercase();
    UNAVAILABLE_OPS.iter().any(|u| *u == op)
}

/// Proof that a write was authorised before it was attempted.
///
/// This is a type rather than a boolean argument on purpose. A boolean can be
/// passed `true` by a caller that never consulted anything; a `WritePermit` can
/// only exist if one of its constructors was handed the value of the durable
/// "Allow account actions" preference and that value was `true`. The provider
/// methods require one, so "did anybody check?" is answered by the type system
/// instead of by review.
#[derive(Debug)]
pub struct WritePermit {
    op: &'static str,
}

impl WritePermit {
    /// `allowed` must come from `Durable::allow_unfollow`.
    pub fn unfollow(allowed: bool) -> Option<Self> {
        allowed.then_some(Self { op: "unfollow" })
    }

    /// `allowed` must come from `Durable::allow_unfollow` as well.
    ///
    /// One preference governs both directions deliberately. The question it
    /// asks is "may this app change who you follow?", and answering yes to
    /// unfollow while answering no to follow would leave the reader able to
    /// undo a follow but not a mistaken unfollow — the strictly worse half.
    /// The stored key keeps its original `actions.allowUnfollow` name so an
    /// existing install's answer is not silently reset by the rename.
    pub fn follow(allowed: bool) -> Option<Self> {
        allowed.then_some(Self { op: "follow" })
    }

    pub fn op(&self) -> &'static str {
        self.op
    }
}

pub fn is_allowed(op: &str) -> bool {
    let op = op.trim().to_ascii_lowercase();
    ALLOWED_OPS.iter().any(|a| *a == op) && !is_blocked(&op)
}

pub fn is_blocked(op: &str) -> bool {
    let op = op.trim().to_ascii_lowercase();
    BLOCKED_OPS.iter().any(|b| *b == op)
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------
//
// Every invocation is an argument array, so there is no shell to inject into.
// The remaining risk is *argument* injection: a value beginning with `-` would
// be read by the CLI's own parser as a flag rather than as data. A username of
// `--output` would make twitter-cli write a file. These guards run before any
// value is placed in an argument array.

/// X handles are 1–15 characters of `[A-Za-z0-9_]`. A leading `@` is accepted
/// and stripped, since that is how handles appear everywhere in the interface.
pub fn clean_screen_name(raw: &str) -> Option<String> {
    let s = raw.trim().trim_start_matches('@');
    if s.is_empty() || s.len() > 15 {
        return None;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
        .then(|| s.to_string())
}

/// Snowflake IDs are decimal digits. Used for post and list identifiers.
pub fn clean_numeric_id(raw: &str) -> Option<String> {
    let s = raw.trim();
    (!s.is_empty() && s.len() <= 25 && s.chars().all(|c| c.is_ascii_digit())).then(|| s.to_string())
}

/// IDs for local user-authored lists. They are generated by the app, but the
/// boundary still validates caller-provided values before SQLite uses them.
pub fn clean_local_list_id(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 64 || !s.starts_with("g_") {
        return None;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        .then(|| s.to_string())
}

/// A free-text search query.
///
/// Queries legitimately contain spaces, quotes and X's own operators, so this
/// cannot use a character allowlist. It caps the length, strips control
/// characters (a newline in an argument is never meaningful and is a classic
/// smuggling vector) and refuses a leading `-` so the query can never be
/// mistaken for a flag.
pub fn clean_query(raw: &str) -> Option<String> {
    let s: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    let s = s.trim().to_string();
    (!s.is_empty() && !s.starts_with('-')).then_some(s)
}

/// A pagination cursor on its way back to the CLI.
///
/// Cursors originate in an X response, but they round-trip through the frontend
/// before being handed back to `--cursor`, so by the time we see one again it is
/// untrusted input. X emits base64-ish tokens (`0|1|2|…` separated segments plus
/// the usual base64 alphabet); anything outside that, over-long, or starting
/// with `-` is refused rather than passed to a command line.
pub fn clean_cursor(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 512 || s.starts_with('-') {
        return None;
    }
    s.chars()
        .all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-' | '|' | '.' | ':')
        })
        .then(|| s.to_string())
}

/// Keys whose values must never appear in output. `bearer` is space-separated,
/// the rest are `key=value` / `key: value`.
const SENSITIVE_KEYS: &[&str] = &[
    "twitter_auth_token",
    "twitter_ct0",
    "auth_token",
    "authorization",
    "set-cookie",
    "cookie",
    "x-csrf-token",
    "password",
    "ct0",
];

pub const REDACTED: &str = "***REDACTED***";

/// Scrub every known credential shape out of `input`.
pub fn sanitize(input: &str) -> String {
    // `bearer` MUST run first. "Authorization: Bearer <token>" would otherwise
    // have its value consumed by the `authorization` pass (which stops at the
    // first space), leaving the real token exposed after the redaction marker.
    let mut out = redact_key(input, "bearer", true);
    for key in SENSITIVE_KEYS {
        out = redact_key(&out, key, false);
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Redact the value that follows `key`. When `space_separated`, a run of spaces
/// also counts as the separator (for `Bearer <token>`).
fn redact_key(input: &str, key: &str, space_separated: bool) -> String {
    let chars: Vec<char> = input.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    let k: Vec<char> = key.chars().map(|c| c.to_ascii_lowercase()).collect();
    if k.is_empty() || chars.is_empty() {
        return input.to_string();
    }

    let mut out = String::new();
    let mut i = 0usize;

    while i < chars.len() {
        let matches_here = i + k.len() <= lower.len()
            && lower[i..i + k.len()] == k[..]
            && (i == 0 || !is_word_char(lower[i - 1]))
            && (i + k.len() >= lower.len() || !is_word_char(lower[i + k.len()]));

        if !matches_here {
            out.push(chars[i]);
            i += 1;
            continue;
        }

        // Emit the key itself, then look for a separator.
        for c in &chars[i..i + k.len()] {
            out.push(*c);
        }
        let mut j = i + k.len();
        let sep_start = j;
        while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
            j += 1;
        }

        let has_sep = if j < chars.len() && (chars[j] == '=' || chars[j] == ':') {
            j += 1;
            true
        } else {
            space_separated && j > sep_start
        };

        if !has_sep {
            // No value follows; emit whatever whitespace we consumed verbatim.
            for c in &chars[sep_start..j] {
                out.push(*c);
            }
            i = j;
            continue;
        }

        // Re-emit the separator region exactly as written.
        for c in &chars[sep_start..j] {
            out.push(*c);
        }
        // Skip quotes/space between separator and value.
        while j < chars.len() && (chars[j] == ' ' || chars[j] == '"' || chars[j] == '\'') {
            j += 1;
        }
        let value_start = j;
        while j < chars.len()
            && !matches!(
                chars[j],
                ';' | ',' | '\n' | '\r' | '"' | '\'' | ' ' | '&' | '}'
            )
        {
            j += 1;
        }
        if j > value_start {
            out.push_str(REDACTED);
        }
        i = j;
    }

    out
}

/// True when a settings key looks like it would hold a credential.
///
/// Deliberately broad: a false positive costs one rejected preference name, a
/// false negative writes a secret to disk in plaintext.
pub fn is_credential_shaped_key(key: &str) -> bool {
    let lower = key.trim().to_ascii_lowercase();
    SENSITIVE_ENV
        .iter()
        .any(|k| lower == k.to_ascii_lowercase())
        || ["token", "cookie", "secret", "password", "credential", "ct0"]
            .iter()
            .any(|needle| lower.contains(needle))
}

/// Environment variable names that must never be echoed into diagnostics.
pub const SENSITIVE_ENV: &[&str] = &["TWITTER_AUTH_TOKEN", "TWITTER_CT0", "AUTH_TOKEN", "CT0"];

/// True when the named env var currently holds a value. Used to report
/// "credentials present" without ever reading the value into a message.
pub fn env_present(name: &str) -> bool {
    std::env::var(name)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x_urls_that_should_open_do_open() {
        for url in [
            "https://x.com/rustlang/status/1234567890123456789",
            "https://twitter.com/rustlang",
            "https://www.x.com/rustlang/status/1?s=20",
            "https://x.com/",
        ] {
            assert!(validate_x_url(url).is_some(), "rejected {url}");
        }
    }

    #[test]
    fn dangerous_or_foreign_urls_never_open() {
        for url in [
            // Schemes that could run code or read the disk.
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "ms-settings:",
            // Plain http, downgraded.
            "http://x.com/rustlang",
            // Hosts that merely resemble X.
            "https://x.com.evil.test/rustlang",
            "https://notx.com/rustlang",
            "https://evil.test/x.com/rustlang",
            // Userinfo can make a link display one host and resolve to another.
            "https://x.com@evil.test/rustlang",
            "https://user:pass@evil.test/",
            // Whitespace and control characters are a smuggling vector.
            "https://x.com/rust lang",
            "https://x.com/rust\nlang",
            "",
            "   ",
        ] {
            assert!(validate_x_url(url).is_none(), "wrongly allowed {url:?}");
        }
    }

    #[test]
    fn arbitrary_post_links_allow_any_https_host_but_no_odd_schemes() {
        // A link inside a post can point anywhere; the rule is only that it
        // cannot launch a local handler.
        assert!(is_safe_external_url("https://example.test/article"));
        assert!(is_safe_external_url("http://example.test/article"));
        assert!(!is_safe_external_url("javascript:alert(1)"));
        assert!(!is_safe_external_url("file:///C:/secret.txt"));
        assert!(!is_safe_external_url("data:text/html,x"));
    }

    #[test]
    fn permalinks_are_built_from_validated_parts() {
        assert_eq!(
            post_permalink("rustlang", "1234567890123456789").unwrap(),
            "https://x.com/rustlang/status/1234567890123456789"
        );
        // A leading @ is normal in stored data and must be stripped.
        assert_eq!(
            post_permalink("@rustlang", "123").unwrap(),
            "https://x.com/rustlang/status/123"
        );
        assert_eq!(
            profile_permalink("rustlang").unwrap(),
            "https://x.com/rustlang"
        );
    }

    #[test]
    fn a_malformed_payload_cannot_steer_a_permalink() {
        // Every one of these would otherwise produce a link to somewhere else.
        assert!(post_permalink("rustlang/../evil", "123").is_none());
        assert!(post_permalink("rust lang", "123").is_none());
        assert!(post_permalink("rustlang", "123?x=1").is_none());
        assert!(post_permalink("rustlang", "abc").is_none());
        assert!(post_permalink("", "123").is_none());
        assert!(profile_permalink("evil.test/path").is_none());
    }

    #[test]
    fn every_built_permalink_passes_the_open_validator() {
        // The two halves must agree, or "open original" would refuse links the
        // app itself constructed.
        let url = post_permalink("rustlang", "1234567890123456789").unwrap();
        assert!(validate_x_url(&url).is_some());
        let profile = profile_permalink("rustlang").unwrap();
        assert!(validate_x_url(&profile).is_some());
    }

    #[test]
    fn allows_only_read_operations() {
        for op in ALLOWED_OPS {
            assert!(is_allowed(op), "{op} should be allowed");
        }
    }

    #[test]
    fn blocks_every_write_operation() {
        for op in BLOCKED_OPS {
            assert!(is_blocked(op), "{op} must be blocked");
            assert!(!is_allowed(op), "{op} must never be allowed");
        }
    }

    #[test]
    fn unknown_operations_are_rejected() {
        assert!(!is_allowed("rm -rf /"));
        assert!(!is_allowed("curl"));
        assert!(!is_allowed(""));
        assert!(!is_allowed("feed; post"));
    }

    #[test]
    fn operation_check_is_case_insensitive() {
        assert!(is_allowed("FEED"));
        assert!(is_blocked("PoSt"));
    }

    #[test]
    fn both_directions_of_the_follow_relationship_are_gated_the_same_way() {
        // An app that can unfollow but not follow back has made a misclick
        // permanent, so the two share one permission — and one gate.
        assert!(WritePermit::follow(false).is_none());
        assert!(WritePermit::unfollow(false).is_none());
        assert_eq!(WritePermit::follow(true).unwrap().op(), "follow");
        assert_eq!(WritePermit::unfollow(true).unwrap().op(), "unfollow");
        assert_eq!(GATED_WRITE_OPS, &["follow", "unfollow"]);
    }

    #[test]
    fn bookmark_removal_needs_its_own_confirmation_permit() {
        assert!(BookmarkPermit::confirmed(false).is_none());
        assert!(BookmarkPermit::confirmed(true).is_some());
        assert_eq!(BOOKMARK_WRITE_OP, "unbookmark");
    }

    #[test]
    fn a_permitted_write_is_still_refused_by_the_read_path() {
        // Two doors. Opening the write one must not open the read one.
        for op in GATED_WRITE_OPS {
            assert!(is_blocked(op), "{op} left the blocklist");
            assert!(!is_allowed(op), "{op} became readable");
        }
    }

    #[test]
    fn mute_and_block_are_reported_as_absent_rather_than_offered() {
        // The pinned twitter-cli has no such subcommand. Saying so is the whole
        // feature: a control that looks available and always fails is worse
        // than no control.
        for op in ["mute", "block", "unmute", "unblock", "repost", "unrepost"] {
            assert!(is_unavailable(op), "{op} was not reported as unavailable");
            // Unavailable upstream *and* refused here, so a future twitter-cli
            // that grows the command cannot become reachable by accident.
            assert!(is_blocked(op), "{op} is not blocked");
            assert!(!is_allowed(op), "{op} is on the read allowlist");
            assert!(
                !GATED_WRITE_OPS.contains(&op),
                "{op} became a permitted write"
            );
        }
        assert!(
            is_unavailable("BLOCK"),
            "the check must be case-insensitive"
        );
        // The operations we do run are emphatically not in this list.
        assert!(!is_unavailable("follow"));
        assert!(!is_unavailable("unfollow"));
    }

    #[test]
    fn redacts_auth_token_and_ct0() {
        let s = "auth_token=abc123deadbeef; ct0=99887766";
        let out = sanitize(s);
        assert!(!out.contains("abc123deadbeef"), "{out}");
        assert!(!out.contains("99887766"), "{out}");
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn redacts_cookie_and_bearer_headers() {
        let s = "Cookie: auth_token=zzz; Authorization: Bearer AAAA-BBBB-CCCC";
        let out = sanitize(s);
        assert!(!out.contains("zzz"), "{out}");
        assert!(!out.contains("AAAA-BBBB-CCCC"), "{out}");
    }

    #[test]
    fn redacts_env_style_assignment() {
        let out = sanitize("TWITTER_AUTH_TOKEN=supersecretvalue");
        assert!(!out.contains("supersecretvalue"), "{out}");
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        let s = "Fetched 20 posts from the following feed in 412ms";
        assert_eq!(sanitize(s), s);
    }

    #[test]
    fn does_not_redact_similar_words() {
        // "ct0" inside another identifier must not trigger redaction.
        let s = "select0 = 5";
        assert_eq!(sanitize(s), s);
    }

    #[test]
    fn write_commands_are_never_on_the_allowlist() {
        for op in BLOCKED_OPS {
            assert!(
                !ALLOWED_OPS.contains(op),
                "{op} appears on both lists — the allowlist wins and would let it run"
            );
        }
    }

    #[test]
    fn operations_removed_for_this_release_are_rejected() {
        // Reply threads and the followers view were dropped; the operations
        // that served them must no longer be reachable.
        for op in ["tweet", "thread", "article", "followers", "likes", "show"] {
            assert!(!is_allowed(op), "{op} should no longer be allowed");
        }
    }

    #[test]
    fn screen_names_reject_anything_that_could_be_read_as_a_flag() {
        assert_eq!(clean_screen_name("@reader").as_deref(), Some("reader"));
        assert_eq!(clean_screen_name("  reader  ").as_deref(), Some("reader"));
        assert_eq!(clean_screen_name("a_1").as_deref(), Some("a_1"));

        for bad in [
            "--output",
            "-o",
            "read er",
            "reader;post",
            "reader/../x",
            "",
            "@",
            "sixteencharacter",
            "réader",
            "reader\n--output",
        ] {
            assert!(clean_screen_name(bad).is_none(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn numeric_ids_must_be_digits_only() {
        assert_eq!(clean_numeric_id("1745").as_deref(), Some("1745"));
        for bad in ["-1", "12a", "", "--max", "1 2", &"9".repeat(26)] {
            assert!(clean_numeric_id(bad).is_none(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn queries_keep_their_operators_but_lose_control_characters() {
        assert_eq!(
            clean_query(" from:someone \"exact phrase\" ").as_deref(),
            Some("from:someone \"exact phrase\"")
        );
        assert_eq!(
            clean_query("hello\nworld").as_deref(),
            Some("helloworld"),
            "a newline survived into an argument"
        );
        assert!(clean_query("--output evil.json").is_none());
        assert!(clean_query("   ").is_none());
        assert_eq!(clean_query(&"x".repeat(500)).unwrap().len(), 200);
    }

    #[test]
    fn arabic_queries_are_preserved() {
        let q = "الذكاء الاصطناعي";
        assert_eq!(clean_query(q).as_deref(), Some(q));
    }

    #[test]
    fn handles_non_ascii_without_panicking() {
        let s = "twitter-cli 已安装但未认证 auth_token=秘密值; 完成";
        let out = sanitize(s);
        assert!(out.contains("已安装但未认证"));
        assert!(!out.contains("秘密值"), "{out}");
    }
}
