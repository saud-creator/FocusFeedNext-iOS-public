# Native 0.10.0 acceptance record

**Build 100.41 passed automated qualification and unsigned IPA verification.**
The signed upgrade, live X recovery, and physical iPhone measurements are
pending. Runtime testing on iOS 16 is pending where a compatible device or
simulator is available.

The broker-restart follow-up in the working branch is not included in build
100.41. It adds a bounded fresh-handle continuation after same-account broker
rotation and captures inline playback state before the old item is released.
Its real-loopback stress test passed 100 restarts with four active video
transfers and one queued connection per cycle; 160 core unit tests and 14
engine integration tests passed locally. A replacement IPA requires a fresh
linked native qualification run and independent package verification.

| Item | Verified result |
|---|---|
| Packaged source | `3b5e07092c93274b212e83cdbe4d22e6cdb104de` on `codex/native-ios-quality`, based on public commit `129c47847bbbd336edd69f05db6780ed19379e56` |
| Package | FocusFeedNext 0.10.0 build 100.41, unsigned arm64, `com.focusfeed.next`, iOS 16.0 minimum |
| IPA SHA-256 | `9c263242b6953dc8b1993a34f369e6af5c645a96db62dbbff2dc7c3a33131579` |
| Xcode and simulator | Xcode 26.3 (17C529), iPhone SE (3rd generation) simulator, iOS 26.2 (23C54), Apple Silicon host |
| Linked native tests | 88 passed, 0 failed, 0 skipped. Includes 100 controlled recovery interruptions, fullscreen seek and Retry, People, Arabic accessibility text, rotation, and Settings. |
| Returned data to first visible post | p95 76.72 ms and maximum 84.37 ms across 20 fresh feed presentations, with a 250 ms simulator limit. |
| Rust and desktop | Shared Rust workspace, native verifier and evidence fixtures, and desktop checks passed. |
| Publication privacy | Exact packaged source passed. |

The [qualification run](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41864533403)
retains the IPA, checksum, source and toolchain manifest, verification report,
XCTest results, and screenshots. Independent verification matched all 119 tracked
build inputs, the downloaded result bundle, and the IPA checksum. The verifier
checked the native scene, required linked frameworks, loopback policy, unsigned
state, and exclusion of legacy reader and test resources. The
[privacy run](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41869400295)
used the same packaged commit.

Earlier runs exposed timing misses, simulator Keychain configuration, native
collection initialization, and async XCTest issues. The
[last completed Intel simulator test](https://github.com/saud-creator/FocusFeedNext-iOS-public/actions/runs/41851757490)
passed 87 of 88 tests. The subsequent simulator gate measures the plan's p95
over 20 observations and keeps the same timing boundary and 250 ms limit.
The release app is optimized. The service test target compiles without the
optimizer to avoid the Swift async XCTest crash.

The comparison installation is **0.9.0 build 31** (`090.31` in the bundle),
source `65CC631F`. The retained public 0.9.1 rollback input is unsigned, with
SHA-256 `9fac858d1f6e0980f010613cb1f3ce7ef3f00a7e28db0fcb58fcc4264d4e858b`.
Retain the owner's known-good signed installation or signed artifact for the
upgrade check. The unsigned 0.9.1 archive is a separate rollback input.

## Required device qualification

Use the affected iPhone running the recorded 0.9.0/090.31 build as comparison.
Record the comparison results before installing. Sign build 100.41 with the
same bundle ID, signing team, and Keychain access identity, then install it
over build 31. If the installation requires deleting the existing app, stop
before proceeding. In Settings → About, verify version 0.10.0, build 100.41,
and source beginning with `3b5e070`.

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
