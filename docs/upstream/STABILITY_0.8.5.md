# FocusFeedNext iOS 0.8.5 stability update

The source is ready. A new IPA has **not** been compiled: the current workspace
is Linux with no Apple iOS SDK, Xcode or device linker. GitHub macOS workflows
are removed from this update branch. The user's alternative build environment
is required for the device build.

## Changes

- Account pictures and banners now use the same local, bounded image proxy as
  post media. This fixes direct CDN image requests being blocked by the app CSP.
  Feed authors, quoted/reposted authors, profiles, following lists, group
  candidates and session snapshots are covered. Stored identities keep their
  upstream URLs; only copies returned over IPC receive local URLs.
- Failed account images show readable initials. A changed source starts a fresh
  image element, avoiding an old request's failure hiding a new image.
- Phone cards give text and media the full reading width, retain a separate
  avatar/header row, use 16px reading text, disable browser text inflation and
  bound portrait/grid media to the available screen.
- iPhone fullscreen uses WebKit's native video player when supported and ready.
  OS start/end events keep app navigation and fullscreen state synchronized.
  The fallback has a safe-area-aware exit even during playback errors or when
  transport controls fade. A first touch reveals controls without pausing.
- Phone inline controls have a portal-based settings menu for playback speed,
  quality and looping. iPhone fullscreen uses hardware volume controls instead
  of presenting an unsupported programmatic volume slider.
- Source changes preserve the playhead and attempt to resume playback. Play
  permission refusals remain a paused state. Seeks, stale error probes, background
  transitions and late fullscreen completions are guarded.
- Image registration lookup is indexed and capped at 4096 entries. Recently used
  registrations, including active video range requests, survive image churn.
  Account switches still invalidate every old registration.
- Browser output targets Safari 16 and Chrome 109 rather than unrestricted
  ESNext. Apple/Windows credential backends retain their target configuration;
  Linux tests use a test-only mock keyring dependency.

## Validation

- Frontend lint, build, TypeScript and **610 tests** passed locally.
- **392 shared Rust tests** passed in a local Linux Docker container.
- Browser checks passed at 320×568, 390×844 and 430×932 using actual H.264 MP4
  fixtures: no horizontal overflow, full-width media, correct reading size,
  successful playback, quality changes resuming and a working exit after a
  media error. Screenshots and results are in `release/0.8.5/`.
- Native WebKit video API behavior is covered by unit fixtures, including OS
  dismissal and background cleanup. These are not a physical iPhone/AVKit test.

## Build handoff

`FocusFeedNext-source.zip` and `source/` contain the same source bytes. The old
0.8.4 IPA is unchanged and does not contain these fixes. Tauri embeds frontend
assets in its native executable, so replacing an IPA's loose assets is not a
valid substitute for rebuilding this update.

On the alternative Apple build machine, use a clean extraction of the ZIP:

```sh
npm ci
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
bash tools/build-ios-unsigned.sh 1
python3 tools/verify-ipa.py dist-ios/FocusFeedNext-unsigned.ipa --version 0.8.5
```

The build creates an unsigned iPhoneOS arm64 IPA, version 0.8.5 / build 805.1;
installation requires the user's signing method. It does not invoke GitHub
Actions. The script runs Apple/WebKit fixture checks before compiling.

For local browser verification, run `npm run dev -- --host 127.0.0.1`, install
the Playwright Chromium browser, then run `node tools/check-iphone-layout.mjs`.
The browser fixture page is a development test entry and is not a production
application entry point.

After the device build: check real account pictures on Following, quotes and
Profiles; open portrait and landscape videos; test native fullscreen Done,
quality/speed changes, background/resume, and an unavailable video's exit.
