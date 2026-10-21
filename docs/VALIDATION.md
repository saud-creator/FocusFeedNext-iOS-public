# Validation record — 21 October 2026

The editable 0.8.5 import is published on upstream main with its original history. The 0.8.8 repair build (088.27), incorporating the previous repairs, passed all automated release gates and independent IPA verification. Physical-device acceptance remains open. Historical results below distinguish each candidate from the verified release.

## Published baseline and runner

| Check | Observed result |
| --- | --- |
| Original main and stability archives | Checksums, Git blob IDs and ZIP CRCs match pinned upstream sources; see SOURCE_IMPORT.json |
| Source import | 215 unchanged files, 44 modified, 20 added, zero removed; imported 0.8.5 bytes matched before app repairs |
| Main history | 8115405 descends from original 466a1e3; subsequent publications use expected-head leases, without force pushes |
| Main webhook | Automatic Codemagic builds #4 through #11 observed |
| Toolchain | M2 runner, Node 24, Xcode 27.1; iOS 27 simulator available |
| Frontend, shared Rust, Swift/WebKit, Mac browser gates | Passed on builds #5 and #6; the native simulator then exposed a launch failure |
| Simulator compilation | Fixed by the pinned swift-rs cross-compilation correction in 404f708 |
| iOS 27 launch | Build #6 crash report identifies UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption, before reader rendering |
| Launch correction | 2b88b56 declares the scene manifest and backports upstream Tao #1245; build #7 reached the welcome screen; build #8 confirmed rendered welcome content but live accessibility queries timed out; build #9 exposed an incompatible simulator profile; build #10 selects a supported iPhone from the pinned iOS 27.1 runtime |
| Simulator logging | Build #10 confirms the compatible iOS 27.1 device but still times out. Its console shows recursively nested `[stderr]` messages, and its spindump shows blocked pipe writes during UIKit startup. Tauri 2.11.5 redirects stderr into os_log; XCTest echoes os_log to stderr. Commit 1cc17dd sets OS_ACTIVITY_DT_MODE=NO for test app launches, retaining unified logging and every UI assertion |
| Baseline simulator gate | Build #11 passed welcome controls, hidden reader navigation and portrait/landscape rotation on iOS 27.1: one test, zero failures, 27.245 seconds. Frontend, Rust, Swift/WebKit and Mac browser gates also passed |
| Packaging discipline | Failed simulator gates stopped device IPA packaging |
| Retained verified baseline | Build #11, version 0.8.5 build 085.11; 4,329,184 bytes; SHA-256 06c9b5ec930ee2aefd041cd81e0aa8e956c00c4fe32108c64d6cff9cf6a62150. iPhoneOS 27.1 SDK, arm64, iOS 16 minimum, archive CRC passed, zero signatures/provisioning profiles. Downloaded artifact checksum matches. This is not the 0.8.6 repair candidate |

The Tao 0.35.3 archive SHA-256 matches the original lock entry. The vendored crate is byte-identical except for the upstream one-line scene ownership correction. Licenses and provenance are retained. See vendor/tao-0.35.3/FOCUSFEED-PATCH.md and vendor/swift-rs-1.0.7/FOCUSFEED-PATCH.md under source/.

## Local 0.8.6 repair candidate

- Frontend regression suite: all 625 tests across 48 files passed, including failed worker starts, late authentication callbacks, expired media registration recovery, intrinsic image proportions and bounded initial iPhone rendering.
- TypeScript and Vite production build passed. Ordinary release chunks exclude the simulator fixture renderer.
- Lint passed with warnings, including existing generated Reader.js and Fast Refresh warnings.
- Chromium and WebKit layout checks passed at 320×568, 390×844, 430×932 and 844×390.
- Chromium passed actual MP4 playback, quality switching with resumption, and fullscreen error dismissal at all four sizes.
- Windows WebKit returned decoder error 4 even for a plain MP4 outside the app. Its layout and recoverable failure state passed; playback is explicitly unverified on this host. Mac WebKit playback remains a required CI check.
- Browser checks verify full card reading width, no horizontal overflow, compact failed images and no final broken-image glyph. Local screenshots and machine-readable results are in ignored .import/browser-checks/.
- Build #12 passed the 624-test frontend suite, shared Rust tests, native Swift/WebKit fixtures, Mac browser checks and simulator compilation. Its two welcome tests passed. Four other simulator tests failed: cold first-page rendering exceeded 250 ms in Arabic/photo scenarios; the account test requested “Retry” instead of the observed localized “Try again”; and video controls remained under native navigation, so the fullscreen tap activated More. Packaging stopped.
- The corrective candidate windows the initial iPhone page, tests the actual FeedList, records the measured milliseconds after a visible card commits, and retains the 250 ms gate in a dedicated test so performance failures do not hide media diagnostics. The reader viewport ends above the measured native tab bar instead of relying on bottom padding. Recovery buttons receive the same 44-point minimum as other primary controls, and the video test requires AVKit to load the fixture MP4.
- Build #13 passed Arabic/large-text layout, account failure/retry and both welcome tests. Native photos decoded successfully, and AVKit loaded and displayed the actual MP4. Three checks failed: the initial shell-plus-feed render measured 385 ms; AVKit's controls had auto-hidden before dismissal was queried; and iOS 27.1 exposed the native photo close control as lowercase `close` in a separate floating chrome hierarchy.
- The next fixture request follows a painted loading shell and UIKit's measured viewport readiness, matching the normal reader's data lifecycle. It records shell startup separately and starts the unchanged 250 ms clock immediately when the page-data promise returns, before constructing/rendering cards. No posts render before that boundary. The native tests reveal AVKit's controls before dismissal and locate the photo control across UIKit's traditional and floating chrome. Photo safe-area checks verify window containment, separation from the photo viewport, and status-bar intersection when the OS exposes a status-bar element; the iPhone Duo's floating status area is also retained in screenshots for visual review. The photo close accessibility label now follows the app's English/Arabic locale.
- Windows has no Cargo, Swift or Xcode. The corrective native/UI changes require another Codemagic run; the previous candidate's compilation is not evidence that these newer changes pass.

### Combined correction after build #14

Build #14 passed six of seven simulator tests: both welcome scenarios, failed
accounts and retry, Arabic/large text, native photo decoding/paging/zoom/reopening,
and actual AVKit playback with background/resume, rotation and dismissal. The
first-page render check measured 809 ms and failed; packaging correctly stopped.

Screenshot review also exposed overlapping virtualized cards. Local browser
reproduction confirmed that calling the virtualizer's `measure()` on viewport
changes discarded measured heights without causing unchanged rows to be measured
again. Removing that reset preserves dynamic row geometry. Initial rendering now
constructs the visible range first and enables the offscreen runway during idle
time after paint. The simulator's unchanged 250 ms response-to-content gate will
measure this production path; it also checks card separation.

The combined local update passed all 625 tests, lint, fixture/production builds
and fixture exclusion. Browser coverage now uses the real FeedList with 40 mixed
posts and asserts non-overlap after delayed intrinsic image sizing, scrolling,
rotation, restoration and hiding/showing its viewport, in all eight layout/engine
combinations. Windows WebKit's MP4 decoder limitation remains explicit.

At the user's request, remaining corrections are batched before another Mac run.
The workflow caches Playwright downloads and Swift packages alongside npm/Cargo
dependencies, caps frontend workers at four, and reuses native fixture success
only inside the same run when a SHA-256 fingerprint of all fixture/source inputs
and the Swift toolchain still matches. Changed inputs force fresh tests; no
passing test receipt is stored in the cross-build cache. Cache changes follow
[Codemagic's documented cache configuration and limits](https://docs.codemagic.io/knowledge-codemagic/caching/).
Mac caches are populated after successful runs; warm-cache savings are not yet
measured. The simulator, native and device release checks remain mandatory.

Build #15 passed frontend/Rust/native/Mac browser gates and confirmed separated
cards in the iOS hierarchy. Initial rendering improved to 563 ms but still
failed the 250 ms gate. Native photo decoding, safe areas, zoom, paging, dismissal
and reopening passed; its final inline-image assertion failed because the
correctly spaced, lazy media had not yet entered the viewport. Other simulator
scenarios passed. Packaging stopped.

The next combined correction commits the first post before constructing later
players against estimated row heights, fills the visible range after paint, then
enables its offscreen runway during idle time. Deep/restored scrolling still
renders its complete visible range, and rotation cannot regress an established
window to its initial phase. The media failure test scrolls to its lazy fixture
before expecting network failure/retry. Native timing diagnostics now separate
commit effects, first visible frame and final paint without changing the clock
boundary or the 250 ms limit. The browser fixture also measures returned-data to
first visible post in the actual FeedList: local unthrottled runs measured
56–111 ms across eight combinations. An additional local 4× CPU stress probe
measured 307–357 ms; this is not an iOS simulator measurement and does not establish
the native performance gate. The next Mac result remains required.

Build #16 passed frontend, Rust and native transport checks. An additional
desktop WebKit timing assertion measured 523 ms and stopped the run before
simulator compilation. That assertion incorrectly applied the iOS simulator's
budget to desktop browser emulation; it is replaced with recorded diagnostics,
while ReaderUITests retains the required, unchanged 250 ms simulator assertion.
The browser fixture now uses an isolated production build with an iPhone user
agent, rather than React's development runtime. Ordinary app builds still exclude
both test renderers. Browser reports retain timing stages and mounted-card counts
alongside functional geometry/media results. Local profiling also showed that
mounting an entire offscreen runway in one idle callback could block subsequent
frames; the next correction grows that runway one card per paint/idle opportunity
and suspends that work while backgrounded. It does not reset established row
measurements or change the native timing boundary.

The workflow now pins Node 24.22.0 explicitly and checks its major version before
expensive work. Build #16's browser log reported Node 26 despite the previous
major-only declaration, so the version is verified rather than inferred from
configuration. The pinned patch version is listed on
[Codemagic's Xcode 27.1 image](https://docs.codemagic.io/specs-macos/xcode-27-1/).

Build #17 passed the pinned toolchain, frontend/Rust/native gates and all eight
Mac browser layout/media combinations, including real MP4 playback. Its timing
stages distinguish content work from the next animation callback: the native
first-page case committed in 3 ms and had a visible card at 25 ms, but the second
rAF callback arrived at 603 ms. The first desktop WebKit case likewise had a
visible card at 67 ms followed by a 478 ms animation-callback gap; later cases
measured 63–80 ms overall. These are diagnostic observations, not a passed native
paint gate.

The corrected probe queues a task inside the first rAF with a committed card
intersecting the reader viewport. This runs after that rendering opportunity,
instead of waiting for a separate idle animation frame. It retains the same
returned-data start time and 250 ms limit. This follows
[Chrome's documented after-next-paint pattern](https://web.dev/codelabs/understanding-inp#requestpostanimationframe).
Detailed numeric diagnostics move below the fixture reader so they cannot push
test actions under navigation. Route changes do not restart the initial-page
clock with an old response timestamp.

Build #17 also exposed fixture interaction failures: the Accounts retry tap
changed to Following, and full-page swipes overshot a photo control by 57 points.
The next test batch reveals Retry before tapping and uses bounded measured drags
with a final hold to avoid inertia, retaining every account/photo assertion.
The readiness probe now requests the actual production fixture entry (locally
verified HTTP 200) and fails explicitly if it never starts, removing the previous
60-second loop against a root URL that returns 404. No production app source
changes are included in this test-harness correction.

Build #18 passed six of seven iOS simulator tests, including the unchanged 250 ms
first-page and non-overlap gate. Account recovery, AVKit playback and dismissal,
Arabic/large text and both welcome scenarios passed. Native photo decoding,
zoom, paging, closing and reopening also passed; the final inline-image recovery
assertion failed. Its heading was visible at y=568, but the image began at y=611,
below the reader's y=595 boundary, so revealing the heading had not revealed the
media. Packaging correctly stopped. The photo scenario recorded a 141 ms initial
render; this is separate from the dedicated performance test's passed limit.

The combined 0.8.7 correction also fixes a production preloading defect: a
document-root IntersectionObserver cannot extend the clipping of the intermediate
scrolling reader. Image and video observers now use their actual scroll viewport;
eligible images start loading within the existing bounded prefetch margin. The
browser regression requires a real SVG to load and decode below that viewport
without scrolling. The native failure test centers the heading and then verifies
that Retry is reachable above navigation. All version manifests advance together
to 0.8.7. Local checks passed all 625 tests, lint, the production build, release
manifest consistency and fixture exclusion. Chromium/WebKit passed all eight
layout combinations plus real below-viewport image preloading in both engines.
Chromium passed all four MP4 playback/quality/fullscreen combinations; the
Windows WebKit decoder limitation remains explicitly unverified locally. Mac
gates and a verified IPA are still required for this exact batch.

Build #19 passed frontend, Rust, 78 native transport assertions and every Mac
browser check. Six of seven iOS tests passed; the dedicated first-page test
recorded 50 ms with non-overlapping cards. The photo test passed actual decoding,
safe-area controls, zoom, paging, reopening and the repaired inline-image recovery
assertion. Its final welcome tap failed because the test helper placed the button
at y=7 behind the sticky 70-point header. The helper now measures that header as
well as the tab bar, uses the unobscured viewport for drags and requires actual
hittability. No photo or navigation assertion is removed.

The same corrective batch addresses a simulator runtime warning from synchronous
audio-session calls on the main thread. Audio activation/deactivation now uses a
serial worker with presentation-specific leases; playback presentation returns
to UIKit on the main queue and rejects cancelled or backgrounded owners. A late old dismissal
cannot deactivate a newer lease. The existing iOS 16 API and deployment minimum
remain; see [Apple's audio-session activation API](https://developer.apple.com/documentation/avfaudio/avaudiosession/setactive(_:options:)).
The native video test now also opens and dismisses a second actual player. This
Swift-only correction requires fresh Mac compilation and UI gates before an IPA.

Candidate simulator fixtures use real PostCard, navigation, welcome and account components, plus actual image/video bytes through the native media proxy. Only opt-in debug simulator builds register loopback fixtures. Device packaging rejects fixture mode, and IPA verification checks version, iOS 16 minimum, scene delegate, architecture, unsigned state and fixture exclusion.

The candidate declares an HTTP exception only for the in-process media proxy at 127.0.0.1. Apple's current ATS documentation requires explicit IP exceptions from iOS 17 onward. IPA verification checks that this exception survives packaging and that global, web-content and AVFoundation arbitrary-load exceptions remain disabled. Actual simulator photo/video decoding remains the delivery gate. See [Apple's IP exception rules](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains).

## Verified 0.8.7 release — build 087.21

[Codemagic build #21](https://codemagic.io/app/6ad63fe0fdc2a85dad554aca/build/6ad7a4ff064e933257c2e05f)
finished successfully on 2026-10-20 from source commit
`5a076bc01c7fa28cc35bdec86332a9fbeaae2213` on upstream main. Build #20 was
superseded while queued; the complete audio/background/header corrections were
tested together in #21. This evidence-only documentation update skips CI.

- Frontend: 625 tests passed, with lint and production build.
- Rust: 400 tests passed with the locked dependency graph.
- Native Swift/WebKit transport: 78 assertions passed.
- Mac browsers: all eight layout/media combinations passed, including real MP4
  playback and actual image preloading ahead of the clipped reader viewport.
- iOS 27.1 simulator: seven tests passed, zero failures and no runtime warnings.
  Coverage includes account failure/retry, authentication cancellation/resume,
  English/Arabic, large text, reduced motion/transparency, photo decoding/zoom/
  paging/reopening/safe areas, inline image recovery, native video background/
  rotation/dismissal/reopening, navigation lifecycle and feed card separation.
- Controlled first returned-page content: 58 ms against the unchanged 250 ms
  limit. Reader-shell initialization measured 735 ms separately; this is not a
  claim about live provider latency or a full cold launch.

The downloaded unsigned IPA was independently checked locally against the CI
report and checksum: version **0.8.7**, build **087.21**, bundle identifier
`com.focusfeed.next`, arm64/iPhoneOS 27.1 SDK, iOS 16.0 minimum, 4,398,689 bytes,
archive CRC passed, no code signatures or provisioning profiles. Fixture
exclusion, scene lifecycle and narrowly scoped loopback transport configuration
passed verification. SHA-256:

`3c323051b5da1f96e4b5b9b480c450ea827f8a7ff5940f665ebcc7134a3baf3c`

The local release and reports are retained in `.import/build-21/`; the previous
verified 0.8.5 baseline remains in `.import/build-11/`. The current unsigned IPA
requires the existing signing/installation process before physical-device use.

## Remaining acceptance

The automated repair gates passed for the exact source commit above. Future
functional changes must pass the same gates before replacing this verified IPA.

A physical iOS 27 device and the current account are still required for the 20-minute reading/resource session and live authentication/network acceptance. A follow action must be deliberately selected by the user; the original follow complaint remains unconfirmed. No arbitrary live follow/unfollow action has been performed. New convenience features remain after the repair gates.


## 0.8.8 article, profile and media repair candidate

The installed 0.8.7 screenshots exposed four remaining live-data problems. This
candidate handles them together before one Codemagic run:

- Articles load full DraftJS content on demand through the existing authenticated
  native HTTP transport. Titles wrap, paragraphs/headings/lists/code remain readable,
  images use the registered proxy, and interrupted reads expose an explicit retry.
  Link entity destinations and literal embedded text are retained without executing HTML.
- Native post parsing removes only provider-identified media/article/available-quote
  wrapper links. Ordinary authored URLs expand and unknown links remain. Arabic URL
  runs are isolated left-to-right; paragraph breaks are retained.
- Profiles read modern `profile_bio.description` with a legacy fallback and an
  explicit fresh details read. Unknown bio/counts differ from empty bio/real zero.
- Proxied video posters are accepted. Native scoped HTTP probes avoid WebKit-origin
  diagnostic failures; expired registrations renew once, decoding may try one real
  lower rendition, and deliberate retry refreshes the individual post's provider
  sources. Failure panels remain compact and repeated explicit retries stay usable.

Local results before publication: lint and production build passed; 631 frontend
regressions in 49 files and 406 Rust tests passed. Chromium/WebKit article, layout,
windowing and image-preload checks passed at four sizes each. Chromium passed real
MP4 playback, quality resumption and fullscreen error dismissal at all four sizes;
Windows WebKit's independently reproduced MP4 decoder limitation remains unverified.
Python/native JSON fixtures parse. Swift/WebKit and iOS 27.1 UI gates must run on Mac;
the latter now exercises opening, reading and closing an article as part of the
existing photo/navigation lifecycle test. No additional Codemagic build has yet been
started for this candidate. Physical-device/current-account acceptance remains open.

Provider shape references: [modern bio parser](https://github.com/anatolykoptev/go-twitter/blob/main/parsers.go),
[article request fields](https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/client.py),
[article content shape](https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/parser.py).

For live acceptance, open a known article and read beyond the preview; refresh a
media post and confirm its attachment link is absent while authored links remain;
open a profile with a known bio; and replay one previously failing clip, including
its deliberate Retry action. Record provider refusals separately from successful
playback. Fixture success cannot establish that every live Twitter asset is available.


### Build #22 correction

Build #22 passed frontend checks, all 406 Mac Rust tests and 79 native Swift/WebKit
assertions. Mac browser testing caught a late WebKit pause event replacing an error
with paused state after fullscreen failure. Device packaging and simulator testing
stopped. A local regression reproduced the disappearing Retry control before the
fix; pause/waiting events now retain terminal failure until a fresh load or explicit
retry. All 632 frontend tests and eight local browser layout/article cases pass.

Inspection also found Node 26.12.0 in the runner despite its YAML Node 24 selection.
The toolchain assertion had failed inside a shell that continued to later commands.
Each step now sources a strict shell bootstrap, selects the exact Node 24.22.0
executable (using its official checksum-verified Apple Silicon archive when needed),
and fails immediately if selection or any command fails. The small Node installation
is cached. This correction preserves all release checks and the 250 ms gate.


### Build #23 and HTTP-level media fixture correction — 21 October

Build #23 confirms actual checksum-verified Node 24.22.0 and Xcode 27.1, with
strict failure handling active. Frontend, Rust and native transport gates pass;
Mac WebKit still times out waiting for Retry after the test mutates only the
video DOM source. Simulator and device packaging remain blocked.

The browser fixture now refuses the player's actual registered HTTP media route,
including probes and fallback renditions, rather than changing the DOM behind
React's source list. It requires recovery before fullscreen dismissal, waits for
the browser's asynchronous native fullscreen exit before measuring the compact
inline panel, restores delivery, and verifies that deliberate Retry resumes real
MP4 playback. Local Chromium passed all four sizes; all eight layout/article
cases pass, with the Windows WebKit playback limitation retained. Failed recovery
now saves its media event sequence and screenshot for diagnosis. No app code or
release acceptance gate was removed by this fixture correction.


### Build #24: terminal media state across remounts

Build #24 passed frontend, Rust and native fixtures, then the HTTP-level Mac
browser check exposed a second state transition: returning to the feed can
remount a failed video element. Its passive load/metadata events replaced the
terminal failure with Loading and restored the tall frame. The captured state
shows readyState 0 and a 520-point loading panel after a previously observed error.

Terminal errors now survive passive load, pause, waiting, metadata and playing
events for that same source. Autoplay does not restart a failed clip. A declared
new source, bounded automatic recovery or deliberate retry/quality choice starts
a new attempt. Local checks pass: 633 frontend tests, production build, lint,
eight browser layout/article cases, and four Chromium real HTTP failure/replay
cases. The regression also unmounts/remounts the failed element and separately
confirms that a genuinely refreshed source can load. Windows WebKit's decoder
limitation remains explicit. macOS verification of this correction is pending.


### Build #25: deterministic renewal boundary

The strict frontend gate stopped build #25 on the new native-registration unit
fixture: it injected a second failure as soon as the renewal callback was called,
before the first replacement element had committed. The fixture now waits for that
replacement before exercising the next failure and manual retry. A new attempt's
status reset uses a layout effect, before media events can report a newer failure;
passive effect scheduling cannot overwrite that failure afterward.

Local Node is now the same official checksum-verified 24.22.0 as the runner.
With these final changes, lint, production build, all 633 frontend tests and eight
local browser cases pass. Four Chromium cases verify real HTTP interruption,
compact fullscreen dismissal and deliberate replay; Windows WebKit playback
remains explicitly unverified. Rust/Swift code is unchanged from the previous
passing gates. The next Mac run must still pass every release stage.


### Build #26: simulator fixture navigation

Build #26 passed all 633 frontend tests, 406 Rust tests, 79 native Swift/WebKit
assertions and all eight Mac browser MP4/article/layout/HTTP-recovery cases. The
iOS 27.1 Duo simulator passed six of seven tests with no runtime warnings. Its
controlled first-page measurement was 153 ms against the unchanged 250 ms gate.
Native photos, article content and article dismissal were exercised successfully.

The remaining failure was the fixture's body-level Return to welcome button:
after closing the article, its frame remained behind the sticky header at y=-17
while the test required y>=74. Packaging stopped. The fixture-only navigation
control now lives in the sticky header, at the leading side away from the Duo's
floating status region. Its test requires a 44-point target, header containment
and actual hittability before tapping; the same welcome content and zero-tab-bar
assertions remain. Shipping app code is unchanged. Local lint and production
build pass; the ordinary release still excludes the fixture renderer. The next
run must pass the complete simulator gate before producing an IPA.


## Verified 0.8.8 release — build 088.27

[Codemagic build #27](https://codemagic.io/app/6ad63fe0fdc2a85dad554aca/build/6ad7f17c064e933257c5df5e)
finished successfully in 17m 32s from source commit
`e7d6054f7989fd9e3604741c79c2f40864d96b9a` on main. M2, actual Node 24.22.0,
Xcode 27.1. The corrected fixture navigation passed without removing assertions.

- All 633 frontend tests in 49 files passed; lint and production build passed.
- All 406 Rust tests and 79 native Swift/WebKit assertions passed.
- All eight Mac Chromium/WebKit cases passed actual MP4 playback, quality
  resumption, fullscreen dismissal, controlled HTTP failure/retry, article reading,
  layout/windowing and offscreen image preloading.
- All seven iOS 27.1 Duo simulator tests passed, zero failures and runtime warnings.
  Controlled returned first-page content rendered in 23 ms (250 ms limit); reader
  shell startup was measured separately at 188 ms. The photo/article/navigation
  lifecycle, AVKit reopening, account retry and welcome scenarios passed.
- Device IPA: version 0.8.8, CFBundleVersion 088.27; arm64; iPhoneOS 27.1 SDK;
  iOS 16.0 minimum; 4,447,411 bytes. Archive CRC, scene/ATS/ProMotion and fixture
  exclusion checks passed. One native image checked; no code signature or
  provisioning profile. Delivery remains unsigned, as requested.
- Downloaded IPA independently passes the repository verifier. Local metadata,
  architecture, CRC and checksum exactly match Codemagic's verification report.
  SHA-256: `627cddf7b0fa7f0c92586739c2dc812bf887b3545f47304af3a5d601440473f3`.

The retained local IPA, checksum, independent verification report, complete test
reports/screenshots and green build proof are under ignored `.import/build-27/`.
The previous verified 0.8.7/087.21 and 0.8.5/085.11 artifacts remain available.
This evidence-only update uses [skip ci] to avoid another Mac run; shipping source
and release artifacts remain exactly those tested in build #27.

Physical-device/current-account acceptance remains pending. Use the targeted
0.8.8 cases in DEVICE_ACCEPTANCE.md to verify a real article, authored versus
attachment URLs, a known profile bio and a previously failing live video. No
follow/unfollow action was performed, and provider availability cannot be
established for every live asset by controlled fixtures.


## 0.8.9 follow-up candidate — 21 October 2026

The user reports that the supplied failures persist in installed 0.8.8/088.27.
Treat the live failures as unresolved by the earlier fixture-only results.

This batch adds a visible, localized Copy original post URL action with truthful
clipboard failure feedback. Provider normalization also handles media wrappers
from entities.media, punctuation and shortened self-permalinks while preserving
unrelated authored destinations and paragraph breaks. Article headings open the
reader, and required reader content flags override web-client experiments after
metadata resolution. The native fixture deliberately supplies false article
experiments and rejects requests that fail to request article content.

Profile parsing covers migrated relationship_counts, tweet_counts and
verification without inventing absent values, plus a populated legacy bio when
the modern bio is empty. These migrated fields are documented in the upstream
[go-twitter parser](https://github.com/anatolykoptev/go-twitter/blob/main/parsers.go).

Refused/expired video sources receive at most one automatic single-post source
refresh, independent of one registration renewal. Deliberate retries remain
available, including when no playable source was returned. Visible stalled
loads settle after 20 seconds; paused/offscreen/background media do not. Inline
failures expose AVKit directly with playhead preserved. Photo previews show
loading feedback, settle stalled loads, and retry fresh provider data. Native
photos show a progress indicator and impose a 30-second total resource deadline.

Local checks: 638 frontend tests passed, followed by 9 targeted action/iPhone
checks including the additional native-fallback regression (639 total cases in
the pending complete CI suite). Lint and production build passed, with existing
non-blocking lint warnings; 408 Rust tests passed. Eight Windows browser layouts,
articles and preload checks passed; four Chromium cases verified real MP4
playback/failure/retry/fullscreen. Four Windows WebKit MP4 cases remain explicitly
unverified because that host cannot decode the fixture; all eight must pass on
macOS. Local controlled first-content results ranged from 52 to 96 ms.

The IPA verifier now checks content-hashed production renderer asset names in
the actual Mach-O. Locally it accepted all 25 matching assets in retained build
27 and rejected that archive against the current renderer output. This catches
stale packaged UI even if the plist version is correct. Codemagic packaging is
still gated by every test stage. This candidate has not yet passed macOS/iOS
checks; one combined main push is intended to conserve runner credits.


Build #28 stopped early at the frontend gate: 638/639 passed; the existing
decoded-resolution assertion had been accidentally re-encoded from `×` to
mojibake by a Windows file-edit helper after the previous complete local run.
No Rust, Swift, simulator or packaging stage ran. Eight affected legacy lines
in that test file were restored using explicit UTF-8; every edited tracked text
file was audited against its prior Unicode content. The full local suite passed all 639 tests in 49 files before the corrective main commit. App implementation is unchanged by this
encoding-only correction; no failing assertion was removed or relaxed.


## Verified 0.8.9 follow-up release — build 089.29

[Codemagic build #29](https://codemagic.io/app/6ad63fe0fdc2a85dad554aca/build/6ad836f5064e933257c7df7f)
finished in 18m 14s on M2 from main commit
`01a82db77a57d69975f5e8605b74f817620ab239`. Xcode 27.1 and pinned Node 24.22.0.
The preceding encoding-only failed run stopped at 1m 28s, before native work.
No additional runner use is needed for this evidence-only documentation update.

- Frontend: 639/639 tests, 49 files, zero failures/errors; lint and production build
  passed (existing non-blocking lint warnings remain).
- Rust: 408/408. Native transport/Swift/WebKit: 79 assertions, fixture traffic only.
- All eight Mac Chromium/WebKit cases verified real MP4 playback, quality
  resumption, fullscreen error dismissal, actual HTTP failure/retry, articles,
  virtualized layout and image preload. Controlled first-post render: 22.2–69.2 ms.
- iOS 27.1 iPhone Duo simulator: 7/7 passed, zero skipped, failed or runtime-warning
  entries. Native photo/AVKit lifecycle, Arabic/large text/rotation, article
  reading/dismissal, accounts and sign-in recovery passed. Returned first-page
  content: 70 ms (250 ms gate); reader shell measured separately: 179 ms.
- IPA: version 0.8.9, build 089.29, 4,446,518 bytes, arm64, iPhoneOS 27.1 SDK,
  iOS 16.0 minimum. CRC/scene/ATS/ProMotion and fixture-exclusion checks pass.
  One native image checked; no code signatures or provisioning profiles.
  All 25 current content-hashed renderer asset names occur in the device executable.
- Independently downloaded IPA passes the verifier; its report exactly equals
  Codemagic's report. SHA-256:
  `9af88c689c932524cf69678d0122d5c7222dcf67d17e3c17ac3a3c6f2eb35574`.

Retained IPA, checksum, independent verification, build metadata, tests, exported
simulator screenshots and green-run proof are under ignored `.import/build-29/`.
Earlier verified artifacts are retained. Delivery remains unsigned as requested.
The article and native photo screenshots were visually inspected.

These gates verify controlled behavior and packaging, not availability of every
live Twitter asset. The user's actual account, known profile bios/articles,
previously refused videos and 20-minute physical-device reading session still
require the targeted device acceptance checks. No follow/unfollow was performed.


## 0.9.0 candidate — links, bookmark comments and photo dismissal

All requested changes are batched before a main push. Ordinary HTTP(S) links in
post text now open the default browser, using a validated native command on iOS
and an argument-based OS opener on desktop. Sentence punctuation stays outside
links; executable schemes and embedded credentials are refused. Link-open
failure is shown, while self/attachment URL cleanup and original-post copying
remain available.

Only bookmark cards expose View comments. The first page is requested on demand,
with 20 direct comments per page and at most five retained pages. Partial results
survive failures, repeated cursors stop, and the original post can be opened for
more. Replies include their media, quoted posts and articles. Native TweetDetail
transport uses the existing account generation/deadline/metadata pipeline;
backend access requires a currently loaded bookmark. Reply data never enters
ordinary feed membership or persistent storage. The desktop CLI adapter reports
comments unavailable rather than inventing a supported operation. Response and
cursor shapes follow the primary upstream
[twitter-cli client](https://github.com/public-clis/twitter-cli/blob/main/twitter_cli/client.py).

Photo swipe-down dismissal is recognized together with the native image scroll
gesture at fit scale; zoomed panning and horizontal paging remain separate. The
web fallback supports downward dismissal and fitted horizontal paging. The
simulator photo test now performs an actual swipe-down after reopening. A new
simulator case covers comment failure/retry/pagination, a clickable URL and
comment controls disappearing outside Saved. Swift fixtures cover TweetDetail.

Video retry now attempts the registered stream even when optional fresh-post
metadata fails. A refused rendition can fall back once to a real alternative;
folded numeric playback diagnostics expose no URLs or credentials. Compact
failure controls remain scrollable at large text sizes. The user's latest
answer did not supply an error or affected post URL, so the specific remaining
live video failure has not been reproduced; this release fixes the concrete
retry defect and tests controlled failures.

Local validation: 648 frontend tests, 412 Rust tests, lint and production build
passed; final affected media/comment suites passed 63 checks. Eight Windows
browser layouts/articles/recovery/preload cases passed, including four real MP4
Chromium cases. Windows WebKit MP4 remains explicitly unverified; the Mac gate
must verify all eight. Controlled local first-post rendering: 42.9–145 ms.
An accidental dependency-version replacement was caught by the local locked
Cargo check and corrected before commit; no dependency was upgraded. A Unicode
audit found no unintended re-encoding. macOS/iOS gates are pending.
