#!/usr/bin/env bash
# Validate UIKit/Swift contracts before paying for three optimized Rust slices.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
cargo build --locked -p focusfeed-ffi --features bindgen
mkdir -p ios-native/Generated
cargo run --locked -p focusfeed-ffi --features bindgen --bin focusfeed-bindgen -- \
  generate target/debug/libfocusfeed_ffi.dylib --language swift --out-dir ios-native/Generated
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
modulemap="$repo/ios-native/Generated/FocusFeedNativeFFI.modulemap"
xcrun swiftc -typecheck -parse-as-library -swift-version 5 \
  -module-name FocusFeedNextNative -sdk "$sdk" -target arm64-apple-ios16.0-simulator \
  -I ios-native/Generated -Xcc "-fmodule-map-file=$modulemap" \
  ios-native/Generated/*.swift ios-native/App/*.swift \
  ios-native/Integration/*.swift ios-native/NativeServices/*.swift
