# Focus Feed Next iOS improvement plan

Prepared 19 October 2026 against the imported 0.8.5 source.

## Product direction

Make the iPhone app a dependable, calm reader: sign in once, reach a useful feed,
read comfortably, and resume without losing context. Keep Following, Originals,
Focus Feed, Bookmarks, profiles and local organization coherent. Retain English
and Arabic, the absence of engagement counters, local privacy, and the existing
confirmation boundary around account-changing actions.

The current architecture already shares a React reader and Rust backend across
platforms, with Swift/WebKit for iOS transport and native navigation. Improve
these boundaries incrementally. A complete native UI rewrite would add delivery
risk before the current release has physical-device acceptance.

## Findings that drive the order

| Finding | Evidence | Implication |
| --- | --- | --- |
| Main packages source as a ZIP; newer source lives on a diverged branch | Root main tree and pinned archive comparison | Establish one editable source and reproducible builds first |
| Original CI extracts the old ZIP and replaces the build script | Main workflow and Codemagic configuration | Builds could silently omit newer fixes; corrected in this import |
| 0.8.5 addresses login handoff, feed failures, account images and video state | Archive changes and upstream recovery/stability notes | Preserve these fixes and verify them on a device before adding features |
| Versioned source documentation still describes older desktop/companion releases | source/README.md, IOS_STANDALONE.md, PROJECT_STATUS.md | Add a current entry point and consolidate release instructions |
| Session and feed logic already share refresh claims, reset state and error handling | source/src/hooks/useFeed.ts and pages/FeedScreen.tsx | Extend existing mechanisms and guard their account boundaries |
| Native iPhone and live-account behavior is not proven by browser/unit results | Upstream 0.8.5 validation boundary | Device checks determine release readiness |

## Delivery sequence

Effort ranges below are planning estimates for implementation and review, not
calendar commitments. Apple build access and device/account availability are
dependencies. Complete each exit gate before proceeding to a public release.

### 0. Establish the baseline — implemented in this import

- Import main's snapshot and the newer iOS source with pinned commit IDs and
  checksums; keep the main archive for comparison.
- Make source/ authoritative in both CI paths and the root build entry point.
- Keep build services manual and attach package verification to their output.
- Record local checks separately from historical upstream evidence.

Exit gate: reproducible local frontend checks, a reviewed source comparison,
and an Apple build that packages this source. The Apple/device portion remains
pending; the workspace import itself is complete.

### 1. Connection and feed reliability — first implementation milestone

Estimated effort: 3–5 engineering days, then device verification.

- Exercise sign-in cancellation, interrupted verification, expired sessions,
  invalid identity responses, rate limits, query metadata changes and offline
  recovery. Use bounded retries and honor provider cooldowns.
- Review account switching during pending feed, image and video requests.
  Old results must not enter the new account's queries, read state or media
  registry; extend tests at each actual boundary.
- Preserve readable posts during a refresh failure. Distinguish loading,
  empty filters, end of pagination, disconnected state and provider errors.
  Retry should appear beside the failed action.
- Verify cursor progress, duplicate pages and source sharing across Following,
  Originals and Focus Feed. Navigation must not issue redundant refreshes.
- Keep diagnostic reports redacted and user initiated in Settings or failure
  recovery; do not introduce background telemetry.

Primary files: src/hooks/useFeed.ts, src/hooks/useStartupSequence.ts,
src/pages/FeedScreen.tsx, src/components/settings/IosConnection.tsx,
src-tauri/src/providers/native_ios.rs and the ios-reader Swift transport.

Exit gate: deterministic failure-path tests and physical-device checks for
sign-in, airplane-mode recovery, Wi-Fi/cellular transitions, logout and account
switch. No old-account content appears after a switch.

### 2. Comfortable reading and accessible navigation

Estimated effort: 3–4 engineering days.

- Audit 320, 390 and 430 CSS-pixel widths, portrait/landscape, display zoom,
  large text, safe areas, keyboard overlap and long Arabic/English content.
- Check VoiceOver names, focus order, selected tabs, modal focus return,
  contrast, reduced motion and reduced transparency.
- Restore reading position when returning from a profile or changing feed
  views. Reuse the existing scroll-state mechanisms; avoid unexpected jumps
  when a refresh completes or posts become read.
- Review filter discoverability and reset behavior without adding a dashboard
  or engagement features.
- Remove hardcoded English from reachable reading and connection surfaces.
  Use the existing catalogs and locale-aware number/time formatters.

Primary files: src/components/feed/, src/components/layout/,
src/components/post/, src/pages/FeedScreen.tsx, src/i18n/ and src/index.css.

Exit gate: no horizontal overflow at the three phone widths; readable large text;
complete core flows with VoiceOver; consistent Arabic direction and labels;
automated regressions for any confirmed UI defect.

### 3. Media, memory and battery

Estimated effort: 3–5 engineering days plus profiling.

- Profile a long mixed-media reading session on a real iPhone before tuning.
  Reuse the feed harness and bounded virtualization; capture memory, mounted
  card count, frame times and transfer counts.
- Verify one active video decoder, paused off-screen/background video, bounded
  proxy registrations and cleanup after logout.
- Verify native fullscreen Done, rotation, playback failure, speed/quality
  changes, playhead preservation, audio interruption and background/resume.
- Tune prefetch based on measured scrolling and network conditions. Preserve
  foreground and low-resource policy controls.
- Measure idle requests and prevent hidden views from polling unnecessarily.

Primary files: src/components/feed/feedWindow.ts, src/lib/runtime.ts,
src/components/post/VideoPlayer.tsx, src/components/media/,
src-tauri/src/media_proxy.rs and perf/.

Exit gate: a repeatable device profile shows bounded resources and no growing
memory trend after repeated navigation/account cycles; media failures always
leave a usable exit and navigation.

### 4. Release discipline and maintainability

Estimated effort: 2–3 engineering days after the previous gates.

- Consolidate current iOS setup, privacy, support and release notes. Mark older
  desktop/companion records as historical instead of mixing their claims.
- Add a release-version consistency check for package metadata, Tauri, Cargo,
  bundle build number and IPA verification. Prefer deriving values to keeping
  another manually maintained version.
- Establish one primary build service after comparing actual successful builds;
  keep the other documented as an intentional fallback.
- Build from a clean checkout, run frontend/Rust/native checks, verify the IPA,
  sign through the chosen distribution path and retain checksums and logs.
- Keep a known-good signed device build for rollback. Confirm installation and
  upgrade behavior before wider distribution.
- Add a small changelog and a device acceptance record tied to a source commit.

Exit gate: a clean Apple build and a signed installation pass the device matrix
below. Only then consider a release tag or distribution.

## Device acceptance matrix

| Area | Required scenarios |
| --- | --- |
| Devices/OS | Minimum supported iOS 16 where available, a current supported device/OS, and a large-screen iPhone |
| Session | First sign-in, cancellation, expired credentials, relaunch, logout, account switch |
| Network | Cellular without a companion computer, Wi-Fi, offline, reconnect, throttling/rate limit |
| Reading | Following, Originals, Focus filters, bookmarks pagination, profile return, long scroll |
| Media | Images, portrait/landscape video, failed playback, native fullscreen dismissal, quality/speed |
| Lifecycle | Lock/unlock, background/resume, interruption during login and in-flight fetch |
| Accessibility | English and Arabic, VoiceOver, large text, reduced motion/transparency, safe areas |
| Privacy | Redacted reports, no secret in frontend state, old-account media invalidation, logout cleanup |

## Proposed measurements

These are acceptance targets to evaluate after collecting the first device
baseline; they are not achieved performance claims.

- All deterministic frontend, shared Rust and native fixture checks pass.
- No account-crossing data in adversarial switch/logout tests.
- No duplicate continuation requests or retry loop during provider cooldown.
- No overflow at the three reference phone widths; all core actions have
  accessible names and remain reachable with large text.
- Native fullscreen can always be dismissed after errors or backgrounding.
- In a 20-minute mixed-media session, mounted rows and proxy registrations stay
  bounded, and repeated navigation does not produce a sustained memory increase.
- Record first usable feed time, refresh latency and scrolling frame-time
  percentiles by device/network; set numeric budgets from those measurements.

Use fixture data for repeatable performance work and explicit live-account
acceptance for provider compatibility. Retain local measurements without
collecting reading content or identifiers in remote analytics.

## Suggested next implementation slice

Start with milestone 1: create the failure/account-switch matrix, run the
existing tests, build the unsigned 0.8.5 source on the selected Apple machine,
and fix the first reproducible device failure. This gives the next feature
iteration a verified foundation.
