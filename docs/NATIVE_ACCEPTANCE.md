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
