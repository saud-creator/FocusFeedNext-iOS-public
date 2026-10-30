#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
export IPHONEOS_DEPLOYMENT_TARGET=16.0
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cargo build --locked --release -p focusfeed-ffi --features bindgen
mkdir -p ios-native/Generated ios-native/Frameworks ios-native/.build/Headers ios-native/.build/simulator
cargo run --locked --release -p focusfeed-ffi --features bindgen --bin focusfeed-bindgen -- \
  generate target/release/libfocusfeed_ffi.dylib --language swift \
  --out-dir ios-native/Generated
cp ios-native/Generated/*.h ios-native/.build/Headers/
cp ios-native/Generated/*.modulemap ios-native/.build/Headers/module.modulemap
SDKROOT=$(xcrun --sdk iphoneos --show-sdk-path) cargo build --locked --release -p focusfeed-ffi --target aarch64-apple-ios
SDKROOT=$(xcrun --sdk iphonesimulator --show-sdk-path) cargo build --locked --release -p focusfeed-ffi --target aarch64-apple-ios-sim
SDKROOT=$(xcrun --sdk iphonesimulator --show-sdk-path) cargo build --locked --release -p focusfeed-ffi --target x86_64-apple-ios
lipo -create target/aarch64-apple-ios-sim/release/libfocusfeed_ffi.a \
  target/x86_64-apple-ios/release/libfocusfeed_ffi.a \
  -output ios-native/.build/simulator/libfocusfeed_ffi.a
# xcodebuild refuses an existing output. Only the generated framework is replaced.
python3 - <<'PY'
from pathlib import Path
import shutil
root=Path('ios-native/Frameworks').resolve()
target=root/'FocusFeedCore.xcframework'
assert target.parent==root and target.name=='FocusFeedCore.xcframework'
if target.exists(): shutil.rmtree(target)
PY
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libfocusfeed_ffi.a -headers ios-native/.build/Headers \
  -library ios-native/.build/simulator/libfocusfeed_ffi.a -headers ios-native/.build/Headers \
  -output ios-native/Frameworks/FocusFeedCore.xcframework
