# iPhone X login recovery — 0.8.3

The previous login check depended on initializing a second WebKit document. This change verifies identity with an ephemeral native HTTP transport first, retains WebKit as a compatibility fallback, and tries the authenticated verify_credentials endpoint if the multi-account endpoint is unavailable or returns an unusable shape. A 401, 429, or explicit account challenge is preserved without another endpoint request. Neither downloaded HTML nor script runs in the native identity path.

The native login screen now offers Reload and Report. Navigation failures keep the sign-in attempt open. A failed identity check offers a deliberate recheck of the captured session, Return to X for account verification, Cancel, or Close and view diagnostics. The existing Keychain transaction and previous-account rollback remain in place. Authentication must return a real account identity before credentials commit; the active account cookie must match when present.

Diagnostic reports are reachable before login, in account settings, and inside the native login screen. The bounded last 80 events survive relaunch and include stage, engine, HTTP status, safe native error code, cookie presence flags and timing. They exclude credentials, cookies, downloaded error text, account identity, post content, URLs and local paths. Sharing opens the iOS share sheet; nothing is sent automatically.

## Acceptance and practical limits

Frontend checks run locally and again on the macOS workflow. Native URLSession and WebKit fixture tests exercise identity success, endpoint fallback, CSRF rotation, one transient retry, authentication refusal, rate limits, account challenges, oversized/non-JSON responses, redirects, session rollback and journal redaction. The workflow also runs Rust unit tests and creates/verifies an unsigned arm64 IPA for iOS 16 or later.

These checks cannot prove that X will accept a particular live account on a physical iPhone. Device acceptance is: sign in with X username/email, finish any X verification, enter the feed, load bookmarks, background/resume, relaunch, sign out, then switch accounts. If a step fails, use **Share diagnostic file** and send that JSON file with the step you attempted. The app cannot remove a provider rate limit or bypass a required account verification.

## Source layout

`source/` is the reviewable source corresponding byte-for-byte to `FocusFeedNext-source.zip`. The workflow verifies this correspondence before installing dependencies. `release/0.8.3/` contains the resulting IPA, checksum, build and native-test evidence after a successful workflow.
