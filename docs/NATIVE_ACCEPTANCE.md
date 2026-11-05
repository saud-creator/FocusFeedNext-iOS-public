# Native 0.10.0 acceptance record

**Build 100.49 passed automated qualification and independent unsigned IPA verification.**
Signed upgrade preservation, live X recovery, physical iPhone performance/energy,
and runtime testing on iOS 16 remain pending where suitable hardware is available.

| Item | Verified result |
|---|---|
| Packaged checkout | `c10f1e9a9dee0bf0baebd905e657066c9f9590d3`, the tested public PR merge checkout |
| Implementation source | `8a8076b482bc7b9d700c5c25c288f7729dffcba6` on `codex/native-ios-quality`; all 119 recorded build inputs match this tree |
| Original source baseline | Public candidate `129c47847bbbd336edd69f05db6780ed19379e56`; private repository history and the older working folder remain separate |
| Package | FocusFeedNext 0.10.0 build 100.49, unsigned arm64, `com.focusfeed.next`, iOS 16.0 minimum |
| IPA SHA-256 | `6b305581eceead468d943c7e82a0b7c5b554e632e6269e51794553183f0127fe` |
| Toolchain | Xcode 26.3 (17C529), iOS SDK 26.2, Rust 1.96.0, UniFFI 0.32.1, Swift 5 language mode, Apple Silicon host |
| Linked native tests | 98 passed, 0 failed, 0 skipped, including broker rotation, read-state playback preservation, prefetch cancellation, People, Arabic accessibility text, rotation and Settings |
| Returned data to first visible post | p95 57.67 ms; maximum 61.16 ms across 20 fresh feed presentations; simulator limit remains 250 ms |
| Broker socket stress | 100 real loopback restarts, each with four held active video responses and one queued connection; old client/upstream sockets settle, old handles expire, replacement capacity is available |
| Rust and desktop | 160 core unit tests, 14 engine integration tests and 1 FFI test passed; desktop lint/build and regressions passed |
| Package/evidence tooling | 16 archive/provenance fixtures and 7 evidence-export fixtures passed |
| Publication privacy | Passed on the exact packaged checkout |

The [qualification run](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41968616996)
retains the IPA, checksum, source/toolchain manifest, package report, XCTest
bundle and five screenshots. Independent verification matched the IPA checksum,
all 119 tracked build inputs, the cloud package report, exported test counts and
the downloaded result bundle against the receipt embedded in the app. The
verifier checked the native scene, UIKit/WebKit/AVKit linkage, loopback-only
transport policy, unsigned state and exclusion of legacy reader/test resources.
The [timing inspection](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41970632918)
reads those stored test activities; it does not execute or separately qualify an
app. The [privacy run](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41968617009)
checked the same `c10f1e9a` checkout.

This checkpoint fixes cancellation of a visible repair when that repair restarts
the broker. Surviving same-account work resolves a fresh handle once; account
changes and caller cancellation do not retry. Inline video captures its advanced
playhead and pause/settings before the old item is cleared. Read-state,
highlight and appearance-only cell updates retain unchanged media and its player.
New validation guards prevent a transfer/decoder starting after backgrounding.

The 100 socket restarts are transport/runtime evidence. The separate 100
controlled native recovery interruptions exercise ownership and cancellation.
Neither is a substitute for physical network transitions, AVKit/live-CDN
acceptance or the signed upgrade. The release app is optimized; service fixtures
compile without optimization to avoid the Swift async XCTest optimizer crash.

The comparison installation is **0.9.0 build 31** (`090.31`), source `65CC631F`.
The earlier qualified native 100.41 owner bundle remains retained. The public
0.9.1 rollback input is also retained unsigned, with SHA-256
`9fac858d1f6e0980f010613cb1f3ce7ef3f00a7e28db0fcb58fcc4264d4e858b`.
Retain the owner's known-good signed installation/artifact and the protected
original database backup until device acceptance passes.

## Required device qualification

Use the affected iPhone running the recorded 0.9.0/090.31 build as comparison.
Record the comparison results before installing. Sign build 100.49 with the
same bundle ID, signing team, and Keychain access identity, then install it
over build 31. If the installation requires deleting the existing app, stop
before proceeding. In Settings → About, verify version 0.10.0, build 100.49,
and source beginning with `c10f1e9a`.

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

Record the iPhone model, iOS version, old and new builds, signing identity
match, and pass/fail result for each step. For each interruption, record the
trigger, media type, recovery time, and whether it recovered automatically,
after Retry, or after a force quit.

If media stays stuck, open Settings → Privacy and diagnostics → Connection
report. Refresh and share the report before force quitting. Keep post links,
credentials, and private media URLs out of the acceptance record. If sign-in,
preferences, or Lists fail to carry over, record which failed before changing
accounts or importing settings. Preserve the known-good artifact and protected
database backup until upgrade acceptance passes.

Use [the blank device report](NATIVE_DEVICE_REPORT_TEMPLATE.md) to record each result.
