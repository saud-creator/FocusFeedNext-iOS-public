# Native 0.10.0 acceptance record

This record distinguishes implemented source from executed checks. It must not
be used to assert physical acceptance without the associated device report.

## Local checkpoint

- Baseline: public `129c47847bbbd336edd69f05db6780ed19379e56`.
- Branch: `codex/native-ios-quality`.
- Core: 155 unit tests, 14 integration tests and 1 FFI test passed on
  Windows/MSVC. These include cancellation during action preparation, retained
  ownership after dispatch, and late-cancelled account-transition acknowledgements.
  List regressions also cover per-member provider cursors, members no longer
  followed, and ordered navigation after post-body eviction.
- Shared desktop: lint/build completed and 652 tests in 51 files passed. Existing
  lint warnings remain; the native target does not package that renderer.
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
