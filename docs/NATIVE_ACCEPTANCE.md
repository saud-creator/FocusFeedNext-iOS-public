# Native 0.10.0 acceptance record

This record distinguishes implemented source from executed checks. It must not
be used to assert physical acceptance without the associated device report.

## Qualification record

The implementation starts at public commit `129c47847bbbd336edd69f05db6780ed19379e56`
on `codex/native-ios-quality`. The previous public 0.9.1 unsigned IPA is
retained with SHA-256
`9fac858d1f6e0980f010613cb1f3ce7ef3f00a7e28db0fcb58fcc4264d4e858b`.
The reference installation for upgrade acceptance is 0.9.0 build 31
(`090.31` in the bundle), source `65CC631F`.

| Check | Evidence |
|---|---|
| Rust core and UniFFI 0.32.1 | 159 unit tests, 14 engine integration tests and 1 FFI test passed. Coverage includes protected SQLite migration and rollback, bookmark and List navigation after eviction, cancellation, and account action ownership. |
| Existing desktop | 652 frontend tests and the lint/build completed. The 419-test desktop Rust library suite passed locally after the shared storage changes. |
| Media policy | The macOS Foundation harness passed 460 assertions, including 100 simulated interruption cycles. |
| Archive and evidence tooling | 16 structural archive/provenance fixtures and 7 simulator evidence export fixtures passed. |
| Native app and tests | [Run 41775783710](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41775783710) compiled and linked the application. Its test results exposed missing simulator Keychain entitlements, a first-page timing miss and an incorrect short-hex color fixture. [Run 41783284787](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41783284787) passed 69 service, bridge, and collection tests, including simulator Keychain access and the first-page timing fixture. The native welcome UI test passed. Two UI tests exposed large-text welcome reachability and Settings action-sheet selection issues; [run 41787969454](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41787969454) passed all three UI tests after those changes, plus 70 of 71 service tests including downsampling and 100 in-flight recovery interruptions. The first-page timing fixture missed its unchanged 250 ms limit (479 ms). The next run checks reduced feed layout/formatting work and removes fake main-thread image rendering from the fixture. |
| Unsigned device archive | Requires passing linked simulator tests, a matching result receipt and package verification. |
| Signed upgrade, live provider and physical performance | Require the device qualification below. |

Run [41792587556](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41792587556)
stopped in Release compilation: Swift's ownership verifier failed while optimizing
the reading-resume ceiling test. It did not execute the updated timing fixture
or produce a new IPA. The continuation makes that task-local test explicitly
asynchronous and adds optimized Swift preflight before Rust slice compilation.
The 250 ms threshold and Release test configuration remain in place.

The continuation also enforces reading resume's three-read cap at native HTTP
dispatch, including retries inside the retained provider engine. Cached-body,
profile and List-member reads share that allowance; bootstrap resources and
manual navigation are outside it. These changes require their own successful
linked test run before archive qualification.

Simulator screenshots from run `41787969454` were exported and visually reviewed
for the welcome screen, grouped appearance settings, Arabic accessibility text,
and rotation. They establish those fixture layouts only, not signed-device,
VoiceOver, live-provider or performance acceptance.

Run [41821511419](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41821511419)
passed optimized Swift preflight and 80 of 81 linked tests. All three UI smoke
tests and the reading-resume/Search regressions passed. The sole failure was
the unchanged first-page timing limit: 284.31 ms versus 250 ms. It produced no
IPA. Further rendering optimization must meet the existing measurement boundary
and limit. Inspection run [41826225007](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41826225007)
attributed 283.73 ms to snapshot application and 0.58 ms to subsequent layout
and visibility. The next check keeps the same timing boundary and limit,
defers speculative cells until the first viewport is displayed, and reuses
native action controls across post revisions.

The next source checkpoint adds a reusable diffable People collection,
coalesced following-progress updates, opaque media overlays for Reduce
Transparency/high contrast, and stronger custom text under Increase Contrast.
Run [41844964641](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41844964641)
passed the first-page timing fixture at 187.98 ms, all three UI tests and the
media transparency and contrast checks. The People fixtures uncovered a missing
initial section while the first account load was pending. A fullscreen seek
fixture also timed out. The next run tests an initial empty People section and
waits for the controlled seek callback and Retry states separately. Crash reports
also show an async XCTest runtime abort. The service test target uses unoptimized
compilation, while the app under test stays optimized. The timing limit and
production recovery deadlines are unchanged.

Run [41851757490](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41851757490)
passed 87 of 88 linked tests, including the corrected People and fullscreen
fixtures and all three UI tests. Its single first-page observation was 306.43 ms.
The simulator gate now uses the plan's nearest-rank p95 over 20 fresh feed
presentations, reports every observation and the maximum, and retains the same
250 ms limit and returned-data-to-visible-post boundary. This measures the
declared simulator fixture; repeat the performance matrix on the affected iPhone.

## Required device qualification

Use the affected iPhone running the recorded 0.9.0/090.31 build as comparison.
Install with the same bundle ID, signing team and Keychain access identity.

1. Verify session, language/theme, media settings, action permissions, local List
   names/colors/members, and account boundaries after the upgrade.
2. Repeat inline photo, avatar, quoted media, inline/fullscreen video, article,
   comment, profile and List operations with both English and Arabic.
3. Interrupt with Wi-Fi/cellular changes, airplane mode, lock/unlock, and
   background intervals of 1, 5 and 30 minutes. Require reachable Retry/Close,
   preserved explicit pause and playhead, and no stale-account media.
4. Complete a 60-minute mixed-media session and 20 foreground/network
   transitions without a force-quit-required recovery.
5. Measure the same old/new workload. Record device, OS, source SHA, network,
   workload and sample count. Require controlled recovery p95 <=5 seconds
   after the endpoint becomes available, returned-data-to-content p95 <=250 ms,
   cached route p95 <=150 ms, input-to-response p95 <=100 ms, and at least 95%
   of frame deadlines met at the device's actual refresh cadence.
6. Compare three equal 30-minute energy workloads and check settled memory
   after repeated equivalent viewer/scroll cycles. Do not infer improvement from
   framework choice or simulator timing alone.

Keep the known-good artifact and protected database backup until this checklist
passes. No production publication is authorized by a CI success alone.
