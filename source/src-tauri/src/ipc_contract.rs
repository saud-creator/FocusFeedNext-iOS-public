//! The IPC contract, checked against the source that defines it.
//!
//! Four lists have to agree and nothing at compile time makes them:
//!
//! 1. the functions marked `#[tauri::command]` in `commands.rs`,
//! 2. the names inside `generate_handler![…]` in `lib.rs`,
//! 3. the command names the frontend passes to `invoke` in `src/lib/api.ts`,
//! 4. the preference keys the frontend writes, against [`crate::durable`]'s
//!    allowlist.
//!
//! Every one of these has failed silently in this project already:
//!
//! - `follow_account` and `load_feed_page` were defined, tested and *not*
//!   registered. Both compiled. Both passed every unit test. Both would have
//!   failed at the IPC boundary the first time a user clicked the control.
//! - `get_user_profile` was registered for three releases with nothing bound to
//!   it, which is why avatars looked clickable and opened nothing.
//! - `monitoring.autoCheck` was written by the frontend and missing from the
//!   backend allowlist, so `set_setting` refused it, the promise was swallowed,
//!   and the toggle forgot itself on every restart.
//!
//! None of those was caught by a test. All were found by hand.
//!
//! ## Why this parses source text
//!
//! There is no runtime registry to interrogate: `generate_handler!` expands to
//! a match arm and offers no way to enumerate what it accepted, and the
//! frontend is not Rust at all. A canonical inventory that all three sides
//! import would be better, but Tauri's macro does not take one — it takes a
//! literal path list, so a shared constant could not feed it. Given that, the
//! choice is between reading the real sources and maintaining a fourth list
//! that can itself drift. Reading the sources is the one that cannot lie.
//!
//! The parsers are line-structured rather than regex: they recognise the
//! specific syntactic forms this codebase uses, and [`tests::the_parsers_find_something_at_all`]
//! fails loudly if a refactor makes them stop matching, so a broken parser
//! cannot degrade into a silently passing test.

use std::collections::BTreeSet;

const COMMANDS_RS: &str = include_str!("commands.rs");
const LIB_RS: &str = include_str!("lib.rs");
const API_TS: &str = include_str!("../../src/lib/api.ts");
const STORE_TS: &str = include_str!("../../src/stores/useAppStore.ts");

/// Commands that are deliberately registered with no frontend binding.
///
/// This list is the whole reason the "registered but unused" check can exist:
/// without it the check would either be absent, or would have to be silenced
/// the first time it fired. Each entry needs a reason, and a reason that has
/// expired is a reason to delete the command.
const INTENTIONALLY_UNBOUND: &[(&str, &str)] = &[
    (
        "add_list",
        "X Lists are being withdrawn from the visible product: twitter-cli has \
         no command that enumerates an account's Lists, so the app can only \
         ever show ones the user typed an id for. Kept registered while the \
         removal lands; delete both list commands once it has.",
    ),
    (
        "remove_list",
        "The other half of the Lists withdrawal. See `add_list`.",
    ),
];

/// A command name and where it went missing.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Gap {
    pub command: String,
    pub layer: &'static str,
    pub file: &'static str,
    pub remedy: &'static str,
}

impl std::fmt::Display for Gap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "\n  `{}` — missing from {} ({})\n      fix: {}",
            self.command, self.layer, self.file, self.remedy
        )
    }
}

fn report(gaps: &[Gap]) -> String {
    gaps.iter().map(Gap::to_string).collect()
}

/// Every function in `commands.rs` carrying `#[tauri::command]`.
pub fn declared_commands(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut marked = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed == "#[tauri::command]" {
            marked = true;
            continue;
        }
        if !marked {
            continue;
        }
        // Other attributes may sit between the marker and the signature.
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some(name) = function_name(trimmed) {
            out.push(name);
        }
        marked = false;
    }
    out
}

/// `pub fn foo(` / `pub async fn foo(` → `foo`.
fn function_name(line: &str) -> Option<String> {
    let rest = line.strip_prefix("pub ")?;
    let rest = rest.strip_prefix("async ").unwrap_or(rest);
    let rest = rest.strip_prefix("fn ")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// Every `commands::name` inside the `generate_handler!` list.
pub fn registered_commands(source: &str) -> Vec<String> {
    let Some(start) = source.find("generate_handler![") else {
        return Vec::new();
    };
    let body = &source[start..];
    let end = body.find("])").unwrap_or(body.len());
    body[..end]
        .lines()
        .filter_map(|line| {
            let t = line.trim().trim_end_matches(',');
            t.strip_prefix("commands::").map(str::to_string)
        })
        .filter(|name| !name.is_empty())
        .collect()
}

/// Every command name the frontend passes to `invoke`.
pub fn invoked_commands(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = source;
    while let Some(i) = rest.find("invoke<") {
        rest = &rest[i + "invoke<".len()..];
        // The name is the first string literal after the type argument.
        let Some(open) = rest.find('"') else { break };
        let after = &rest[open + 1..];
        let Some(close) = after.find('"') else { break };
        out.push(after[..close].to_string());
        rest = &after[close..];
    }
    out
}

/// The preference keys the frontend writes, read out of `durableStorageKeys`
/// and the per-route override helper in `useAppStore.ts`.
pub fn frontend_preference_keys(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(start) = source.find("export const durableStorageKeys = {") {
        let body = &source[start..];
        let end = body.find("} as const").unwrap_or(body.len());
        for line in body[..end].lines() {
            let Some((_, value)) = line.trim().split_once(": \"") else {
                continue;
            };
            if let Some(key) = value.split('"').next() {
                out.push(key.to_string());
            }
        }
    }
    // The per-route overrides are built by string concatenation, so the routes
    // are read from the exported tuple and the prefix applied here.
    if let Some(start) = source.find("export const OVERRIDABLE_ROUTES = [") {
        let body = &source[start..];
        let end = body.find(']').unwrap_or(body.len());
        for part in body[..end].split('"').skip(1).step_by(2) {
            out.push(format!("pages.openBehavior.{part}"));
        }
    }
    out
}

// --- the four checks, as functions so they can be tested on fixtures --------

fn set(v: Vec<String>) -> BTreeSet<String> {
    v.into_iter().collect()
}

/// Defined with the attribute but never handed to `generate_handler!`.
pub fn unregistered(commands_rs: &str, lib_rs: &str) -> Vec<Gap> {
    let registered = set(registered_commands(lib_rs));
    set(declared_commands(commands_rs))
        .into_iter()
        .filter(|c| !registered.contains(c))
        .map(|command| Gap {
            command,
            layer: "the generate_handler! list",
            file: "src-tauri/src/lib.rs",
            remedy: "add `commands::<name>,` to generate_handler!; without it \
                     the call fails at the IPC boundary at runtime, and nothing \
                     before that point will tell you",
        })
        .collect()
}

/// Handed to `generate_handler!` but not defined in `commands.rs`.
pub fn unknown_registrations(commands_rs: &str, lib_rs: &str) -> Vec<Gap> {
    let declared = set(declared_commands(commands_rs));
    set(registered_commands(lib_rs))
        .into_iter()
        .filter(|c| !declared.contains(c))
        .map(|command| Gap {
            command,
            layer: "the #[tauri::command] definitions",
            file: "src-tauri/src/commands.rs",
            remedy: "define the command, or remove the stale entry from \
                     generate_handler!",
        })
        .collect()
}

/// Invoked by the frontend but not registered.
pub fn dangling_bindings(lib_rs: &str, api_ts: &str) -> Vec<Gap> {
    let registered = set(registered_commands(lib_rs));
    set(invoked_commands(api_ts))
        .into_iter()
        .filter(|c| !registered.contains(c))
        .map(|command| Gap {
            command,
            layer: "the backend command list",
            file: "src-tauri/src/lib.rs and src-tauri/src/commands.rs",
            remedy: "define and register the command, or correct the name in \
                     src/lib/api.ts — a typo here throws only when the control \
                     is clicked",
        })
        .collect()
}

/// Registered, but nothing in `api.ts` calls it and it is not on the
/// [`INTENTIONALLY_UNBOUND`] list.
///
/// The weakest of the four — an unused command is dead weight, not a broken
/// feature — but it is the one that would have caught `get_user_profile`, a
/// working command with no binding while the interface it was written for
/// silently did nothing.
pub fn unbound_registrations(lib_rs: &str, api_ts: &str, exempt: &[(&str, &str)]) -> Vec<Gap> {
    let invoked = set(invoked_commands(api_ts));
    let exempt: BTreeSet<&str> = exempt.iter().map(|(name, _)| *name).collect();
    set(registered_commands(lib_rs))
        .into_iter()
        .filter(|c| !invoked.contains(c) && !exempt.contains(c.as_str()))
        .map(|command| Gap {
            command,
            layer: "the frontend bindings",
            file: "src/lib/api.ts",
            remedy: "add a binding, delete the command, or add it to \
                     INTENTIONALLY_UNBOUND in ipc_contract.rs with a reason",
        })
        .collect()
}

/// Preference keys the frontend writes that the backend allowlist refuses.
pub fn rejected_preferences(store_ts: &str) -> Vec<Gap> {
    frontend_preference_keys(store_ts)
        .into_iter()
        .filter(|k| !crate::durable::is_durable_preference(k))
        .map(|command| Gap {
            command,
            layer: "DURABLE_PREFERENCES",
            file: "src-tauri/src/durable.rs",
            remedy: "add the key to DURABLE_PREFERENCES; set_setting refuses \
                     anything else, the frontend swallows the rejection, and \
                     the setting forgets itself on the next restart",
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parsers_find_something_at_all() {
        // Guards the whole file: a refactor that moved `generate_handler!` or
        // renamed the attribute would otherwise turn every assertion below into
        // "empty equals empty" and silently stop protecting anything.
        assert!(
            declared_commands(COMMANDS_RS).len() > 40,
            "no #[tauri::command] functions found — the parser is broken, and \
             every other check in this file is now vacuous"
        );
        assert!(
            registered_commands(LIB_RS).len() > 40,
            "no registered commands found — the parser is broken"
        );
        assert!(
            invoked_commands(API_TS).len() > 40,
            "no invoke() calls found — the parser is broken"
        );
        assert!(
            frontend_preference_keys(STORE_TS).len() > 20,
            "no preference keys found — the parser is broken"
        );
    }

    // --- the live contract -------------------------------------------------

    #[test]
    fn every_declared_command_is_registered() {
        let gaps = unregistered(COMMANDS_RS, LIB_RS);
        assert!(gaps.is_empty(), "unreachable commands:{}", report(&gaps));
    }

    #[test]
    fn every_registered_command_exists() {
        let gaps = unknown_registrations(COMMANDS_RS, LIB_RS);
        assert!(gaps.is_empty(), "stale registrations:{}", report(&gaps));
    }

    #[test]
    fn every_frontend_binding_reaches_a_real_command() {
        let gaps = dangling_bindings(LIB_RS, API_TS);
        assert!(gaps.is_empty(), "dangling bindings:{}", report(&gaps));
    }

    #[test]
    fn every_registered_command_is_bound_or_explained() {
        let gaps = unbound_registrations(LIB_RS, API_TS, INTENTIONALLY_UNBOUND);
        assert!(
            gaps.is_empty(),
            "registered with nothing calling them:{}",
            report(&gaps)
        );
    }

    #[test]
    fn every_exemption_names_a_command_that_still_exists() {
        // An exemption outliving its command is how this list turns into a
        // place where names go to be forgotten.
        let registered = set(registered_commands(LIB_RS));
        for (name, reason) in INTENTIONALLY_UNBOUND {
            assert!(
                registered.contains(*name),
                "`{name}` is exempted from the binding check but is no longer \
                 registered — delete the exemption"
            );
            assert!(
                reason.len() > 40,
                "`{name}` is exempted without a real reason"
            );
        }
    }

    #[test]
    fn every_preference_the_frontend_writes_is_allowlisted() {
        let gaps = rejected_preferences(STORE_TS);
        assert!(
            gaps.is_empty(),
            "preferences that will not survive a restart:{}",
            report(&gaps)
        );
    }

    #[test]
    fn no_command_is_registered_twice() {
        let registered = registered_commands(LIB_RS);
        let unique = set(registered.clone());
        assert_eq!(
            registered.len(),
            unique.len(),
            "a command appears more than once in generate_handler!"
        );
    }

    // --- regression fixtures ------------------------------------------------
    //
    // Each reproduces a defect that actually shipped, in miniature, and proves
    // the corresponding check would have caught it. Without these the checks
    // above are only ever exercised in their passing direction.

    /// `follow_account`: defined, tested, never registered.
    #[test]
    fn catches_a_command_that_was_never_registered() {
        let commands = "\
#[tauri::command]
pub async fn unfollow_account(state: Sh<'_>) -> Result<(), AppError> { Ok(()) }

#[tauri::command]
pub async fn follow_account(state: Sh<'_>) -> Result<(), AppError> { Ok(()) }
";
        let lib = "\
        .invoke_handler(tauri::generate_handler![
            commands::unfollow_account,
        ])
";
        let gaps = unregistered(commands, lib);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].command, "follow_account");
        assert!(gaps[0].to_string().contains("generate_handler!"));
        assert!(gaps[0].to_string().contains("src-tauri/src/lib.rs"));
    }

    /// `load_feed_page`: registered late, and with no binding at all — so it
    /// failed both the registration check and the binding check.
    #[test]
    fn catches_a_command_with_no_frontend_binding() {
        let commands = "\
#[tauri::command]
pub async fn refresh_feed(state: Sh<'_>) -> Result<(), AppError> { Ok(()) }

#[tauri::command]
pub async fn load_feed_page(state: Sh<'_>) -> Result<(), AppError> { Ok(()) }
";
        let lib = "\
        .invoke_handler(tauri::generate_handler![
            commands::refresh_feed,
            commands::load_feed_page,
        ])
";
        let api = r#"refreshFeed: () => invoke<FeedResponse>("refresh_feed"),"#;

        assert!(unregistered(commands, lib).is_empty());
        let gaps = unbound_registrations(lib, api, &[]);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].command, "load_feed_page");
        assert!(gaps[0].to_string().contains("src/lib/api.ts"));
    }

    #[test]
    fn an_exempted_command_does_not_fail_the_binding_check() {
        let lib = "\
        .invoke_handler(tauri::generate_handler![
            commands::add_list,
        ])
";
        assert!(unbound_registrations(lib, "", &[("add_list", "reason")]).is_empty());
        assert_eq!(unbound_registrations(lib, "", &[]).len(), 1);
    }

    #[test]
    fn catches_a_binding_that_points_at_nothing() {
        let lib = "\
        .invoke_handler(tauri::generate_handler![
            commands::get_groups,
        ])
";
        let api = r#"
          groups: () => invoke<Group[]>("get_groups"),
          members: (id: string) => invoke<string[]>("get_group_memebers", { id }),
        "#;
        let gaps = dangling_bindings(lib, api);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].command, "get_group_memebers");
    }

    /// `monitoring.autoCheck`: written by the frontend, absent from the Rust
    /// allowlist, rejected in silence.
    #[test]
    fn catches_a_preference_the_backend_would_refuse() {
        let store = "\
export const durableStorageKeys = {
  theme: \"theme\",
  autoCheckConnection: \"monitoring.autoCheckk\",
} as const satisfies Partial<Record<keyof Preferences, string>>;
";
        let gaps = rejected_preferences(store);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].command, "monitoring.autoCheckk");
        assert!(gaps[0].to_string().contains("DURABLE_PREFERENCES"));
    }

    #[test]
    fn the_real_monitoring_key_is_allowlisted_now() {
        // The positive half of the regression above: the key that was missing
        // is present, spelled the way the frontend spells it.
        assert!(crate::durable::is_durable_preference(
            crate::durable::AUTO_CHECK
        ));
        assert!(frontend_preference_keys(STORE_TS).contains(&"monitoring.autoCheck".to_string()));
    }

    // --- parser unit tests --------------------------------------------------

    #[test]
    fn function_names_parse() {
        assert_eq!(
            function_name("pub fn foo(state: State) {"),
            Some("foo".into())
        );
        assert_eq!(
            function_name("pub async fn bar_baz(x: u32) -> Result<()> {"),
            Some("bar_baz".into())
        );
        assert_eq!(function_name("fn private(){}"), None);
        assert_eq!(function_name("pub struct Thing {"), None);
    }

    #[test]
    fn an_attribute_between_the_marker_and_the_signature_is_skipped() {
        let src = "\
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn wide(a: u8) -> Result<(), AppError> { Ok(()) }
";
        assert_eq!(declared_commands(src), vec!["wide"]);
    }

    #[test]
    fn invoked_names_parse() {
        let src = r#"
          a: () => invoke<Foo>("one"),
          b: (x: string) => invoke<Bar[]>("two_things", { x }),
          c: () => invoke<void>(
            "three",
          ),
        "#;
        assert_eq!(invoked_commands(src), vec!["one", "two_things", "three"]);
    }

    #[test]
    fn preference_keys_parse_including_the_per_route_overrides() {
        let src = "\
export const OVERRIDABLE_ROUTES = [
  \"following\",
  \"bookmarks\",
] as const;

export const durableStorageKeys = {
  theme: \"theme\",
  videoQuality: \"video.quality\",
} as const satisfies Partial<Record<keyof Preferences, string>>;
";
        let keys = frontend_preference_keys(src);
        assert!(keys.contains(&"theme".to_string()));
        assert!(keys.contains(&"video.quality".to_string()));
        assert!(keys.contains(&"pages.openBehavior.following".to_string()));
        assert!(keys.contains(&"pages.openBehavior.bookmarks".to_string()));
    }
}
