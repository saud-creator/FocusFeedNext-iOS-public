#!/usr/bin/env bash
# Validate UIKit/Swift contracts before paying for three optimized Rust slices.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
if [[ "${NATIVE_HOST_BRIDGE_CACHED:-false}" != true || ! -f target/debug/libfocusfeed_ffi.dylib || ! -x target/debug/focusfeed-bindgen ]]; then
  cargo build --locked -p focusfeed-ffi --features bindgen
fi
mkdir -p ios-native/Generated
target/debug/focusfeed-bindgen generate target/debug/libfocusfeed_ffi.dylib \
  --language swift --out-dir ios-native/Generated
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
modulemap="$repo/ios-native/Generated/FocusFeedNativeFFI.modulemap"
xcrun swiftc -typecheck -continue-building-after-errors -parse-as-library -swift-version 5 \
  -module-name FocusFeedNextNative -sdk "$sdk" -target arm64-apple-ios16.0-simulator \
  -I ios-native/Generated -Xcc "-fmodule-map-file=$modulemap" \
  ios-native/Generated/*.swift ios-native/App/*.swift \
  ios-native/Integration/*.swift ios-native/NativeServices/*.swift
