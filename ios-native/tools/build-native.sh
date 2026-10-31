#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
mode=${1:-check}
case "$mode" in check|archive) ;; *) echo 'Usage: build-native.sh [check|archive]' >&2; exit 2;; esac
command -v xcodegen >/dev/null || { echo 'Install XcodeGen before building.' >&2; exit 1; }
bash ios-native/tools/build-core.sh
python3 ios-native/tools/write-provenance.py
cd ios-native
xcodegen generate --spec project.yml
if [[ "$mode" == check ]]; then
  destination=$(python3 tools/select-simulator.py)
  test_result=".build/Tests-$(date +%s).xcresult"
  xcodebuild -project FocusFeedNextNative.xcodeproj -scheme FocusFeedNextNative \
    -destination "$destination" -derivedDataPath .build/DerivedData \
    -resultBundlePath "$test_result" CODE_SIGNING_ALLOWED=NO test
  python3 tools/write-provenance.py --record-tests "$test_result"
else
  build_number=${NATIVE_BUILD_NUMBER:-100.1}
  xcodebuild -project FocusFeedNextNative.xcodeproj -scheme FocusFeedNextNative \
    -destination 'generic/platform=iOS' -archivePath .build/FocusFeedNext.xcarchive \
    -derivedDataPath .build/DerivedData CODE_SIGNING_ALLOWED=NO \
    CURRENT_PROJECT_VERSION="$build_number" archive
  python3 tools/package-native.py
  python3 tools/verify-native-ipa.py dist/FocusFeedNext-unsigned.ipa \
    --manifest Resources/BuildProvenance.json --output dist/ipa-verification.json
fi
