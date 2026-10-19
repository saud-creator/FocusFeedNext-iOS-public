//! Secure credential storage for the X session.
//!
//! Design rules, all enforced here rather than by convention:
//!
//!   * On Windows, the two X secrets (`auth_token`, `ct0`) are written to
//!     **Windows Credential Manager**. The standalone iOS provider saves the
//!     primary pair and supporting browser cookies in one versioned **Keychain**
//!     record. Legacy entries are read and migrate after a successful check.
//!   * Nothing in this module ever returns a secret value to the frontend.
//!     `CredentialStore::load` is called only by the provider, immediately
//!     before a desktop CLI invocation or the private native iOS request call.
//!   * There is no "reveal" path by design. The UI can learn *whether*
//!     credentials exist (`has`), never what they are.
//!   * Secrets are wiped from our heap when dropped. This is best-effort
//!     hygiene against casual memory inspection, not a guarantee — see
//!     SECURITY.md.

use crate::models::{AppError, AppResult, ErrorCode};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Service name used by Windows Credential Manager and iOS Keychain.
pub const SERVICE: &str = "com.focusfeed.next";
const KEY_AUTH_TOKEN: &str = "x-auth-token";
const KEY_CT0: &str = "x-ct0";
const KEY_SESSION: &str = "x-session";

/// A pair of X session cookies.
///
/// `Zeroize` is derived so the buffers are overwritten when the value is
/// dropped rather than left in freed heap memory.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct XCredentials {
    pub auth_token: String,
    pub ct0: String,
}

impl XCredentials {
    /// Normalise and validate a user-pasted pair.
    ///
    /// People copy these out of browser devtools in several shapes:
    /// `auth_token=abc123`, `"abc123"`, `abc123;`, or with stray whitespace.
    /// Accepting only the bare value would produce a confusing "invalid
    /// credentials" failure, so normalise first and validate afterwards.
    pub fn parse(auth_token: &str, ct0: &str) -> AppResult<Self> {
        let auth_token = normalize(auth_token, "auth_token");
        let ct0 = normalize(ct0, "ct0");
        validate_field("auth_token", &auth_token)?;
        validate_field("ct0", &ct0)?;
        Ok(Self { auth_token, ct0 })
    }
}

impl std::fmt::Debug for XCredentials {
    /// Deliberately opaque: a stray `{:?}` in a log line must not leak a token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("XCredentials { auth_token: <redacted>, ct0: <redacted> }")
    }
}

/// Strip the decorations people paste along with the value.
fn normalize(raw: &str, key: &str) -> String {
    let mut s = raw.trim();
    // "auth_token=abc" / "ct0: abc"
    for prefix in [
        format!("{key}="),
        format!("{key}:"),
        format!("{key} ="),
        format!("{key} :"),
    ] {
        if s.len() > prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(&prefix) {
            s = s[prefix.len()..].trim();
            break;
        }
    }
    s.trim_matches(|c: char| c == '"' || c == '\'' || c == ';' || c.is_whitespace())
        .to_string()
}

/// Character set and length check.
///
/// This is not an authenticity check — only the live `status` call can tell us
/// whether a token actually works. It rejects input that is obviously not a
/// cookie value (an entire `Cookie:` header, a password, an empty box) so the
/// user gets a precise message instead of an opaque provider failure, and so
/// nothing shell-ish or newline-bearing can reach a child environment block.
fn validate_field(name: &str, value: &str) -> AppResult<()> {
    if value.is_empty() {
        return Err(
            AppError::new(ErrorCode::NotAuthenticated, format!("{name} is empty"))
                .with_repair("Paste the cookie value from your browser's developer tools."),
        );
    }
    if value.len() < 16 || value.len() > 256 {
        return Err(AppError::new(
            ErrorCode::NotAuthenticated,
            format!("{name} is not a plausible length"),
        )
        .with_repair("Copy the whole cookie value, without the surrounding quotes."));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '%')
    {
        return Err(AppError::new(
            ErrorCode::NotAuthenticated,
            format!("{name} contains characters that are not part of a cookie value"),
        )
        .with_repair(
            "Paste only the value itself — not the whole Cookie header, and not a password.",
        ));
    }
    Ok(())
}

/// Where credentials are kept. Abstracted so tests never touch the real
/// Windows Credential Manager.
pub trait CredentialStore: Send + Sync {
    fn save(&self, creds: &XCredentials) -> AppResult<()>;
    fn load(&self) -> AppResult<Option<XCredentials>>;
    fn delete(&self) -> AppResult<()>;
    fn has(&self) -> bool {
        matches!(self.load(), Ok(Some(_)))
    }
}

/// The real store: Windows Credential Manager via the `keyring` crate.
pub struct KeyringStore {
    service: String,
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyringStore {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_string(),
        }
    }

    fn entry(&self, key: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(&self.service, key).map_err(map_keyring_error)
    }
}

fn map_keyring_error(e: keyring::Error) -> AppError {
    // The error Display can echo the entry name but never the secret; sanitize
    // anyway so this stays true if the crate changes.
    let repair = if cfg!(mobile) {
        "iPhone Keychain could not be reached. Restart the app and sign in again."
    } else {
        "Windows Credential Manager could not be reached. Sign out and back in, or check group policy."
    };
    AppError::new(
        ErrorCode::ProviderUnavailable,
        format!("credential store unavailable: {e}"),
    )
    .with_repair(repair)
}

fn decode_session_bundle(bundle: &str) -> AppResult<XCredentials> {
    if bundle.starts_with('{') {
        #[derive(serde::Deserialize,Zeroize,ZeroizeOnDrop)]
        #[serde(rename_all="camelCase")]
        struct Envelope { version: u32, auth_token: String, ct0: String }
        let envelope = serde_json::from_str::<Envelope>(bundle).map_err(|_| AppError::new(ErrorCode::ProviderUnavailable,"Stored session is invalid."))?;
        if envelope.version != 1 { return Err(AppError::new(ErrorCode::ProviderUnavailable,"Stored session version is unsupported.")); }
        XCredentials::parse(&envelope.auth_token,&envelope.ct0)
    } else {
        let (token,csrf) = bundle.split_once('\n').ok_or_else(||AppError::new(ErrorCode::ProviderUnavailable,"Stored session is invalid."))?;
        XCredentials::parse(token,csrf)
    }
}

impl CredentialStore for KeyringStore {
    fn save(&self, creds: &XCredentials) -> AppResult<()> {
        #[cfg(target_os = "ios")]
        {
            // The native login commit owns the single envelope containing the
            // pair and supporting cookies; never overwrite it with a pair alone.
            let saved = self.load()?.ok_or_else(|| AppError::new(ErrorCode::ProviderUnavailable,"Native session was not committed."))?;
            return if saved.auth_token == creds.auth_token && saved.ct0 == creds.ct0 { Ok(()) }
                else { Err(AppError::new(ErrorCode::ProviderUnavailable,"Native session commit did not match.")) };
        }
        #[cfg(not(target_os = "ios"))]
        {
        // One Credential Manager entry is the transaction boundary. Writing
        // two entries independently could leave new auth_token + old ct0 if
        // the second write failed.
        let mut bundle = format!("{}\n{}", creds.auth_token, creds.ct0);
        let saved = self
            .entry(KEY_SESSION)?
            .set_password(&bundle)
            .map_err(map_keyring_error);
        bundle.zeroize();
        saved?;
        // Migration cleanup is best-effort and happens only after the new
        // authoritative entry exists.
        for key in [KEY_AUTH_TOKEN, KEY_CT0] {
            let _ = self.entry(key)?.delete_credential();
        }
        Ok(())
        }
    }

    fn load(&self) -> AppResult<Option<XCredentials>> {
        match self.entry(KEY_SESSION)?.get_password() {
            Ok(mut bundle) => {
                let parsed = decode_session_bundle(&bundle);
                bundle.zeroize();
                return parsed.map(Some);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(map_keyring_error(e)),
        }
        // Backward-compatible read for installations created before the pair
        // moved into one atomic entry. The next successful save migrates it.
        let auth_token = match self.entry(KEY_AUTH_TOKEN)?.get_password() {
            Ok(v) => v,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => return Err(map_keyring_error(e)),
        };
        let ct0 = match self.entry(KEY_CT0)?.get_password() {
            Ok(v) => v,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => return Err(map_keyring_error(e)),
        };
        Ok(Some(XCredentials { auth_token, ct0 }))
    }

    fn delete(&self) -> AppResult<()> {
        // Delete legacy entries first. If one fails, the authoritative bundle
        // remains usable; only after cleanup succeeds do we remove it.
        for key in [KEY_AUTH_TOKEN, KEY_CT0] {
            match self.entry(key)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(map_keyring_error(e)),
            }
        }
        match self.entry(KEY_SESSION)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(map_keyring_error(e)),
        }
        Ok(())
    }
}

/// In-process store used by tests. Never compiled into a release binary path
/// that the app can select.
#[derive(Default)]
pub struct MemoryStore {
    inner: std::sync::Mutex<Option<XCredentials>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CredentialStore for MemoryStore {
    fn save(&self, creds: &XCredentials) -> AppResult<()> {
        *self.inner.lock().unwrap() = Some(creds.clone());
        Ok(())
    }
    fn load(&self) -> AppResult<Option<XCredentials>> {
        Ok(self.inner.lock().unwrap().clone())
    }
    fn delete(&self) -> AppResult<()> {
        *self.inner.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD_TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const GOOD_CT0: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

    #[test]
    fn legacy_pair_and_versioned_native_record_load_without_exposing_cookies() {
        let legacy=decode_session_bundle(&format!("{GOOD_TOKEN}\n{GOOD_CT0}")).unwrap();
        let record=serde_json::json!({"version":1,"authToken":GOOD_TOKEN,"ct0":GOOD_CT0,"cookies":[{"name":"support","value":"fixture-only"}]}).to_string();
        let current=decode_session_bundle(&record).unwrap();
        assert_eq!(legacy.auth_token,current.auth_token);assert_eq!(legacy.ct0,current.ct0);
        assert!(!format!("{:?}",current).contains(GOOD_TOKEN));
        assert!(decode_session_bundle(&record.replace("\"version\":1","\"version\":2")).is_err());
        assert!(decode_session_bundle("bad\npair").is_err());
    }

    #[test]
    fn accepts_a_plain_pair() {
        let c = XCredentials::parse(GOOD_TOKEN, GOOD_CT0).unwrap();
        assert_eq!(c.auth_token, GOOD_TOKEN);
        assert_eq!(c.ct0, GOOD_CT0);
    }

    #[test]
    fn strips_the_decorations_people_paste() {
        let c = XCredentials::parse(
            &format!("  auth_token={GOOD_TOKEN};  "),
            &format!("\"{GOOD_CT0}\""),
        )
        .unwrap();
        assert_eq!(c.auth_token, GOOD_TOKEN);
        assert_eq!(c.ct0, GOOD_CT0);
    }

    #[test]
    fn strips_a_colon_separated_prefix_case_insensitively() {
        let c = XCredentials::parse(&format!("AUTH_TOKEN: {GOOD_TOKEN}"), GOOD_CT0).unwrap();
        assert_eq!(c.auth_token, GOOD_TOKEN);
    }

    #[test]
    fn rejects_empty_values() {
        let err = XCredentials::parse("", GOOD_CT0).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAuthenticated);
        assert!(XCredentials::parse(GOOD_TOKEN, "   ").is_err());
    }

    #[test]
    fn rejects_a_whole_cookie_header() {
        // The semicolon-joined header is a common mis-paste; it must not be
        // accepted and smuggled into the child environment.
        let header = format!("auth_token={GOOD_TOKEN}; ct0={GOOD_CT0}; guest_id=v1%3A1");
        assert!(XCredentials::parse(&header, GOOD_CT0).is_err());
    }

    #[test]
    fn rejects_values_with_newlines_or_spaces() {
        assert!(XCredentials::parse(&format!("{GOOD_TOKEN}\nevil"), GOOD_CT0).is_err());
        assert!(XCredentials::parse(&format!("{GOOD_TOKEN} extra"), GOOD_CT0).is_err());
    }

    #[test]
    fn rejects_implausible_lengths() {
        assert!(XCredentials::parse("short", GOOD_CT0).is_err());
        assert!(XCredentials::parse(&"a".repeat(300), GOOD_CT0).is_err());
    }

    #[test]
    fn debug_never_prints_a_secret() {
        let c = XCredentials::parse(GOOD_TOKEN, GOOD_CT0).unwrap();
        let printed = format!("{c:?}");
        assert!(!printed.contains(GOOD_TOKEN), "{printed}");
        assert!(!printed.contains(GOOD_CT0), "{printed}");
        assert!(printed.contains("redacted"));
    }

    #[test]
    fn memory_store_round_trips_and_deletes() {
        let store = MemoryStore::new();
        assert!(!store.has());
        assert!(store.load().unwrap().is_none());

        let c = XCredentials::parse(GOOD_TOKEN, GOOD_CT0).unwrap();
        store.save(&c).unwrap();
        assert!(store.has());
        let back = store.load().unwrap().unwrap();
        assert_eq!(back.auth_token, GOOD_TOKEN);

        store.delete().unwrap();
        assert!(!store.has());
        // Deleting twice is not an error: the end state is what matters.
        store.delete().unwrap();
    }

    #[test]
    fn sanitize_scrubs_a_stored_token_from_any_message() {
        // Belt and braces: even if a token reached an error string it must not
        // survive the sanitiser used by AppError::new.
        let msg = format!("failed with auth_token={GOOD_TOKEN}");
        let out = crate::security::sanitize(&msg);
        assert!(!out.contains(GOOD_TOKEN), "{out}");
    }
}
