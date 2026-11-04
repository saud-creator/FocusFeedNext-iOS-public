# Native 0.10.0 acceptance record

This record distinguishes implemented source from executed checks. It must not
be used to assert physical acceptance without the associated device report.

## Local checkpoint

- Baseline: public `129c47847bbbd336edd69f05db6780ed19379e56`.
- Branch: `codex/native-ios-quality`.
- Core: 159 unit tests, 14 integration tests and 1 FFI test passed on
  Windows/MSVC. These include cancellation during action preparation, retained
  ownership after dispatch, and late-cancelled account-transition acknowledgements.
  List regressions also cover per-member provider cursors, members no longer
  followed, and ordered navigation after post-body eviction.
- The 3 November continuation passed 159 core unit tests and 14 integration
  tests after adding anchored bookmark rehydration and migration rollback/WAL
  backup regressions. The separate FFI test also passed before that core-only
  batch. The final backup-cleanup refinement passed its focused regression.
- Shared desktop: lint/build completed and 652 tests in 51 files passed. Existing
  lint warnings remain; the native target does not package that renderer.
- The existing desktop Rust library also passed all 419 tests locally on
  3 November after the shared storage changes.
- FFI: compiled successfully with UniFFI exactly 0.32.1; generated Swift API
  inspected. The interface includes explicit request cancellation.
- Python archive/provenance validation: 16 structural fixture tests passed,
  including optimized-interpreter rejection checks. These synthetic packages
  do not execute the native app. Native Info.plist retains narrow loopback-only
  ATS exceptions.
- macOS Foundation harness: 429 assertions and 100 simulated interruption
  cycles passed in run `41100182402`. The generated Swift boundary built from
  UniFFI 0.32.1 and reached UIKit type checking. That run found a missing
  `override` on the Settings initializer; the source has been corrected.
  Run `41180221128` passed core, desktop and privacy checks, then found an
  explicit-`self` capture error in the article photo callback. That source is
  corrected in the next batch. Its Foundation harness also passed 429 assertions.
  Run `41181456868` passed 435 Foundation assertions, including the typed failure
  origin checks, and the shared core/desktop/privacy checks. UIKit type checking
  then identified explicit member captures in filter-preset tasks; those are
  corrected in the following batch. Linked UIKit tests and IPA creation remain
  unqualified until their own stages pass.
- Run `41182223815` passed 435 Foundation assertions and reached UIKit type
  checking. It found inherited UIKit/AVKit name collisions in the photo tile,
  profile tab and native playback rate, plus explicit capture errors in inline
  playback callbacks. The continuation corrects these and adds test-module
  type checking before optimized Rust slice builds. That source still requires
  its own successful cloud run; the failed run produced no IPA.
- Run `41646501709` passed the application/UniFFI UIKit type check and module
  emission after those fixes. The added test preflight then exposed an XCTest
  Swift-overlay search-path issue (the compiler saw only C assertion macros).
  The next batch includes the platform's Developer/usr/lib Swift-module path.
  Passing type checking is distinct from linked tests and a device archive.
- Run `41648249854` passed 460 Foundation assertions and 100 simulated
  interruption cycles, the app/bridge preflight, and the core/desktop/privacy
  jobs. XCTest overlay resolution passed; a heterogeneous test fixture exceeded
  Swift's expression type-checking budget. The following checkpoint splits
  that fixture into explicitly typed values without changing its test content.
- Full UIKit compilation, linked Swift/bridge/UI tests and the Xcode archive:
  pending a successful macOS workflow. The previous failed run produced no IPA.
- Signed upgrade, live-provider recovery and measured device performance:
  not performed by local checks.

The core's 100 registration/invalidation cycles are not 100 physical network
transitions. Swift policy tests include a deterministic 100-cycle interruption
model; those checks are distinct from the required live device session.

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
5. Measure the same old/new workload: returned-data-to-content p95 <=250 ms,
   cached route p95 <=150 ms, input-to-response p95 <=100 ms, >=95% frame
   deadlines met. Record device/OS/source/network/sample count separately.
6. Compare three equal 30-minute energy workloads and check settled memory
   after repeated equivalent viewer/scroll cycles. Do not infer improvement from
   framework choice or simulator timing alone.

Keep the known-good artifact and protected database backup until this checklist
passes. No production publication is authorized by a CI success alone.
