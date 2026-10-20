# Validation record — 20 October 2026

The editable 0.8.5 import is published on upstream main with its original history. Local source now contains the 0.8.7 repair candidate, incorporating the previous 0.8.6 repairs; candidate changes require their own Mac gates before release. Results below distinguish those states.

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

Candidate simulator fixtures use real PostCard, navigation, welcome and account components, plus actual image/video bytes through the native media proxy. Only opt-in debug simulator builds register loopback fixtures. Device packaging rejects fixture mode, and IPA verification checks version, iOS 16 minimum, scene delegate, architecture, unsigned state and fixture exclusion.

The candidate declares an HTTP exception only for the in-process media proxy at 127.0.0.1. Apple's current ATS documentation requires explicit IP exceptions from iOS 17 onward. IPA verification checks that this exception survives packaging and that global, web-content and AVFoundation arbitrary-load exceptions remain disabled. Actual simulator photo/video decoding remains the delivery gate. See [Apple's IP exception rules](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains).

## Remaining acceptance

The candidate must pass shared Rust tests, native Swift/WebKit fixtures and iOS 27 UI tests before producing a verified IPA. Native photo decoding, paging, zoom, safe-area controls, AVKit dismissal/rotation, authentication retry/cancellation/backgrounding, failed account recovery, English/Arabic, large text and reduced motion/transparency are included in the simulator gates. The controlled first-page paint limit is 250 ms after fixture content returns.

A physical iOS 27 device and the current account are still required for the 20-minute reading/resource session and live authentication/network acceptance. A follow action must be deliberately selected by the user; the original follow complaint remains unconfirmed. No arbitrary live follow/unfollow action has been performed. New convenience features remain after the repair gates.
