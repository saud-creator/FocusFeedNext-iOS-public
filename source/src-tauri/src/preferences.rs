//! Validation shared by atomic saves and portable preference imports.
use crate::models::{AppError, AppResult, ErrorCode};
use std::collections::HashSet;
pub fn validate(entries: &[(String, String)], portable: bool) -> AppResult<()> {
    if entries.len() > 80 { return Err(invalid()); }
    let mut seen = HashSet::new();
    for (key, value) in entries {
        if !seen.insert(key) || value.len() > 4096 || !crate::durable::is_durable_preference(key) { return Err(invalid()); }
        if portable && (key.starts_with("migration.") || key.starts_with("actions.") || key.starts_with("window.") || key.starts_with("updates.") || key.starts_with("startup.")) { return Err(invalid()); }
        let v = value.as_str();
        let valid = match key.as_str() {
            "migration.iosVideoQuality080" => v == "true",
            "language" => ["system", "en", "ar"].contains(&v),
            "theme" => ["system", "dark", "oled", "light"].contains(&v),
            "density" => ["comfortable", "compact"].contains(&v),
            "performance.mode" => ["balanced", "fast", "battery", "ultra"].contains(&v),
            "video.autoplay" => ["off", "wifi", "any"].contains(&v),
            "appearance.shadow" => ["none", "soft", "strong"].contains(&v),
            "appearance.timestampStyle" => ["relative", "absolute"].contains(&v),
            "video.quality" => ["auto", "best", "1080", "720", "480", "360"].contains(&v),
            "appearance.radius" => number(v, 0., 24.),
            "appearance.textContrast" => number(v, 0., 100.),
            "reading.size" => number(v, 80., 160.),
            "monitoring.intervalMinutes" => number(v, 1., 60.) && v.parse::<u32>().is_ok(),
            "content.readDelayMs" => number(v, 0., 10000.),
            "content.autoRefreshMinutes" => number(v, 0., 240.),
            "video.defaultSpeed" => number(v, 0.25, 4.),
            "navigation.tabs" => serde_json::from_str::<Vec<String>>(v).ok().is_some_and(|tabs| {
                let allowed = ["following", "focus", "bookmarks", "accounts", "originals", "groups", "search"];
                tabs.len() == 4 && tabs.iter().collect::<HashSet<_>>().len() == 4 && tabs.iter().all(|t| allowed.contains(&t.as_str()))
            }),
            "appearance.accent" | "appearance.background" | "appearance.surface" | "appearance.elevated" | "appearance.border" | "appearance.mediaBackground" => v.is_empty() || ((v.len() == 4 || v.len() == 7) && v.starts_with('#') && v[1..].bytes().all(|c| c.is_ascii_hexdigit())),
            k if k.starts_with("pages.openBehavior") => ["", "off", "refresh", "reset"].contains(&v),
            "appearance.haptics" | "appearance.collapseLongPosts" | "monitoring.autoCheck" | "startup.preloadBookmarks" | "startup.preloadFollowing" | "content.hideReposts" | "content.unreadOnly" | "actions.advanced" | "actions.allowUnfollow" | "video.loop" | "video.clickToggle" | "video.gifAutoplay" | "video.offscreenCleanup" => ["true", "false"].contains(&v),
            _ => false,
        };
        if !valid { return Err(invalid()); }
    }
    Ok(())
}
fn number(v: &str, min: f64, max: f64) -> bool { v.parse::<f64>().ok().is_some_and(|n| n.is_finite() && n >= min && n <= max) }
fn invalid() -> AppError { AppError::new(ErrorCode::BlockedOperation, "Invalid preference bundle. No settings were changed.") }

#[cfg(test)] mod tests {
    use super::*;
    fn row(k: &str, v: &str) -> (String, String) { (k.into(), v.into()) }
    #[test] fn imports_cannot_grant_permissions_or_store_secrets() {
        for key in ["auth_token", "actions.advanced", "actions.allowUnfollow", "startup.preloadBookmarks"] { assert!(validate(&[row(key, "true")], true).is_err()); }
    }
    #[test] fn validates_whole_batch_and_unique_navigation() {
        assert!(validate(&[row("performance.mode", "balanced"), row("reading.size", "NaN")], false).is_err());
        assert!(validate(&[row("navigation.tabs", r#"["following","focus","bookmarks","search"]"#)], false).is_ok());
        assert!(validate(&[row("navigation.tabs", r#"["following","following","bookmarks","search"]"#)], false).is_err());
        assert!(validate(&[row("theme", "dark"), row("theme", "light")], false).is_err());
    }
}
