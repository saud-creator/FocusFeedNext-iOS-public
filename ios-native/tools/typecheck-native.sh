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

# Validate test sources against the real application module before compiling
# three optimized Rust slices. Syntax-only checks cannot catch UIKit collisions,
# changed protocol signatures or incorrect XCTest usage in these sources.
module_dir="$repo/ios-native/.build/Typecheck"
mkdir -p "$module_dir"
xcrun swiftc -emit-module -enable-testing -parse-as-library -swift-version 5 \
  -module-name FocusFeedNextNative -emit-module-path "$module_dir/FocusFeedNextNative.swiftmodule" \
  -sdk "$sdk" -target arm64-apple-ios16.0-simulator \
  -I ios-native/Generated -Xcc "-fmodule-map-file=$modulemap" \
  ios-native/Generated/*.swift ios-native/App/*.swift \
  ios-native/Integration/*.swift ios-native/NativeServices/*.swift
test_frameworks="$(xcode-select -p)/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks"
test_swift_modules="$(xcode-select -p)/Platforms/iPhoneSimulator.platform/Developer/usr/lib"
for target in Services UI; do
  xcrun swiftc -typecheck -continue-building-after-errors -parse-as-library -swift-version 5 \
    -module-name "FocusFeedNext${target}Preflight" -sdk "$sdk" -target arm64-apple-ios16.0-simulator \
    -I "$module_dir" -I ios-native/Generated -I "$test_swift_modules" -F "$test_frameworks" \
    -Xcc "-fmodule-map-file=$modulemap" "ios-native/Tests/$target/"*.swift
done
