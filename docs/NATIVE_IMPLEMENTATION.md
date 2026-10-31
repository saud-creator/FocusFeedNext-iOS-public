# Native iOS implementation

Implementation branch: `codex/native-ios-quality`, based on public commit
`129c47847bbbd336edd69f05db6780ed19379e56`. The older working folder and private
repository history are preserved. This is one native quality update, version
0.10.0. Source implementation, successful compilation, verified unsigned IPA,
signed upgrade, live-provider behavior and physical-device acceptance are
separate evidence gates.

The standalone UIKit application lives in `ios-native`. The extracted Rust core
and pinned UniFFI interface live in `crates`. The original desktop application
remains in `source` and is not replaced by this native target.

Use `ios-native/tools/build-native.sh` on macOS/Xcode to build the Rust slices,
generate matching Swift bindings, generate the Xcode project, run native tests,
and package a verified unsigned IPA. Windows can run shared Rust tests and
inspect package/project configuration but cannot compile UIKit or Xcode targets.

Production sign-in uses the extracted hardened private WebKit transaction
engine. Production builds do not provide invented feed data or a demo login.
Use the existing application/signing identity for upgrade preservation; signing
is intentionally separate from unsigned archive generation.

Physical acceptance requires the affected iPhone: install over build 090.31,
verify session/settings/Lists preservation, repeat background/network/media
interruptions, then complete a 60-minute mixed-media session. A successful CI
archive is not evidence that these checks passed.
