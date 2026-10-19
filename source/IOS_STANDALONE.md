# Focus Feed Next 0.6.0 for iPhone

This build selects `ios-direct`, an on-device provider. It does not invoke
Python, require a Windows companion, or relay account requests through a server.
The existing shared reader, filters, local Lists, reading state, profiles,
settings, English and Arabic UI remain in the app.

## Sign-in and session boundary

The sign-in button opens Twitter's own HTTPS login page in a separate native
WKWebView. It has no Tauri IPC bridge or reader scripts. Password entry and any
account verification occur on Twitter's page. After login, native cookie-store
access sends session cookies to Rust's plugin handle, never to React. A real
identity probe precedes committing the session. The primary pair and supporting
browser cookies are saved in iPhone Keychain. Browser network state is otherwise
nonpersistent. Logout clears both Keychain entries and the native web data store.

Provider requests run in a named, isolated WebKit content world on x.com. The
bundled engine uses same-origin fetch with cookies, bounded timeouts, a shared
serial request queue, transaction headers, and a cooldown after rate limiting.
Downloaded X bundles are parsed only for query IDs; they are not installed as
application code. Native commands accept a fixed set of operations. Rust retains
the existing permits for follow/unfollow and bookmark removal. Mute and block
remain unavailable because the provider has no implemented operation for them.

The upstream request shapes were reviewed from public-clis/twitter-cli 0.8.6.
The transaction algorithm is vendored from Lqm1/x-client-transaction-id under
MIT, with browser primitives replacing server-only dependencies and a timeout
added to the ondemand fetch. Licenses and provenance live beside the sources.

## Interface and rendering

The native floating navigation uses UIGlassEffect when built with the iOS 26 SDK
and run on iOS 26, with system-material fallback on earlier versions. Reduce
Transparency, dynamic light/dark appearance, native selection haptics, English
and Arabic labels are supported. The web navigation remains the recovery path
when native chrome cannot initialize. This is native glass navigation around the
shared React reader; it is not a claim that every screen is rewritten in SwiftUI.

The virtual feed keeps visible rows plus six ahead and three behind during normal
scrolling. Fast swipes expand the buffer to twelve ahead and four behind, with
direction-aware bounds and stable post keys. Continuation requests remain
single-flight and start before the mounted tail reaches the end. Nearby images
have a bounded 700px iPhone loading runway. Background full-account preloads are
disabled on iPhone, and bookmarks/profile feeds use cursor pages. A view-level
error boundary keeps navigation usable after a render error.

## Validation boundary

Source tests and an unsigned native archive can verify compilation, model
parsing, cursor handling, UI state, and package structure. They cannot prove X
accepts an iPhone WebKit session or that a physical device sustains a particular
frame rate. Device acceptance requires sign-in, account verification, feed and
bookmark pagination, fast scrolling, media playback, background/resume, logout,
and account switch with Windows off and the iPhone using cellular data.

Build with `bash tools/build-ios-unsigned.sh 2` on macOS. The existing private
GitHub macOS runner remains the build path. Sign the resulting IPA yourself.
Keep the 0.5.7 companion IPA as a rollback artifact until device acceptance.

## Built artifact: 2026-10-10

Private macOS build [run 6](https://github.com/saud-creator/FocusFeedNext-iOS/actions/runs/38024280720)
succeeded from source commit `08e1ad97bc1485fbb19bf91029b3ccabb382ee51`.
The device archive used Xcode 26.3 and the iOS 26.2 SDK. Swift compiles the bundled
request engine as a static string; it has no external SwiftPM resource bundle
that must be copied at installation time.

- App version: 0.6.0; build: 0.6.0.2; identifier: com.focusfeed.next.
- Device target: arm64 iPhoneOS; minimum iOS 16.0.
- IPA: 4,168,754 bytes; unsigned, without a provisioning profile.
- SHA-256: `fc6b491f21ed28d68e10ddf2b2880d9dbd5a206cf310fab3d6d565a205c7ed10`.
- Automated checks: 551 frontend tests and 372 Rust tests passed.
- Package checks: ZIP integrity, matching macOS checksum, iPhoneOS platform,
  arm64 executable, no LC_CODE_SIGNATURE, no _CodeSignature or provisioning
  file, and native transport/glass references in the device executable.
- English and Arabic welcome components inspected at 390x844 in a browser
  preview. This checks the shared layout, not the iPhone's native login or glass.

The delivered IPA and verification report are in `dist-ios/standalone-0.6.0`.
Sign and install the IPA before physical-device acceptance. Live X sign-in,
cellular feed loading, fast-scroll frame times, account switch and lifecycle
recovery remain unverified on a physical iPhone.
