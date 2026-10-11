# FocusFeedNext 0.8.1 — sign-in repair

This patch changes iPhone authentication only. It preserves the standalone provider, bundle identifier `com.focusfeed.next`, iOS 16 minimum, existing preferences, account Lists, and the retained 0.8.0 package.

## Changes

- Keep Twitter sign-in open when the app enters the background. Captured credentials wait for an active scene. Validation reads stop in the background and resume with a fresh read deadline; normal feed cancellation cannot cancel the authentication transaction. Explicit Cancel and the ten-minute uncommitted-attempt deadline remain available.
- Ignore WebKit's expected `NSURLErrorCancelled` redirects and ignore login-document teardown after cookie capture. Recover an interrupted login web process instead of calling it a user cancellation.
- Keep the native login controller visible until authenticated identity validation and verified Keychain storage complete. Show a specific safe native error if validation fails. Retain the previous session on failure.
- Validate the active account using the authenticated REST identity response. A separate GraphQL profile request and transaction metadata bootstrap are no longer mandatory sign-in gates. Retry REST identity with transaction metadata once after HTTP 403 when metadata can be initialized.
- Read the current transport cookie before requests and again at commit, including any CSRF rotation. Return the canonical committed pair only across the private native/Rust boundary and verify that the Rust store reads the same record. Credentials never enter React, diagnostics, or exports.
- Isolate candidate validation from health/feed requests belonging to the previous session so they cannot replace transport cookies during sign-in.
- Resume validation with a distinct request identity. Cancel only the obsolete native request IDs so delayed WebKit cancellation cannot cancel the resumed read or coalesce it with an aborted promise.
- Support login pop-up windows in the same temporary WebKit session. Google prohibits OAuth sign-in in embedded iOS browsers; explain this in English/Arabic and direct readers to X email/username/password sign-in. Apple login routing is implemented but requires a live iPhone check.

## Evidence boundary

Local frontend/Rust tests and fixture-only macOS WebKit integration are distinct from a live signed iPhone login. Live email login, background/return, relaunch restoration, and Apple OAuth on a physical iPhone remain unverified until exercised on that device. Google embedded OAuth is unsupported rather than claimed to work. A ten-minute timeout and iOS process termination can still end an uncommitted attempt; ordinary app switching does not intentionally cancel it.

The unsigned arm64 IPA, exact source snapshot, checksums, macOS compilation result, and test counts are recorded in the matching `dist-ios/standalone-0.8.1-build4/verification-report.md` after the build completes.
