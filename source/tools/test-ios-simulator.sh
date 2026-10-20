#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
origin="$PWD"
work="$origin/dist-ios/simulator-source"
mkdir -p "$work"
# An isolated copy keeps simulator archives and test configuration out of the
# unsigned device build. This also tests a clean generated Xcode project.
rsync -a --exclude node_modules --exclude dist --exclude dist-ios --exclude target --exclude gen ./ "$work/"
ln -s "$origin/node_modules" "$work/node_modules"
cd "$work"
device=$(python3 tools/select-ios-simulator.py "$origin/dist-ios/simulator-runtime.json")
rustup target add aarch64-apple-ios-sim
npm run tauri -- ios init --ci
python3 - <<'PY'
from pathlib import Path
for project in Path('src-tauri/gen/apple').glob('*.xcodeproj/project.pbxproj'):
    text=project.read_text().replace('buildSettings = {','buildSettings = {\nCODE_SIGNING_ALLOWED = NO;\nCODE_SIGNING_REQUIRED = NO;')
    project.write_text(text)
PY
set +e
export SDKROOT="$(xcrun --sdk iphonesimulator --show-sdk-path)"
export IPHONEOS_DEPLOYMENT_TARGET=16.0
FFN_UI_TEST=1 npm run tauri -- ios build --debug --ci --target aarch64-sim --features dev-mock > "$origin/dist-ios/simulator-build.log" 2>&1
status=$?
set -e
if ! find src-tauri/gen/apple -type d -name '*.app' -print -quit | grep -q .; then
  cat "$origin/dist-ios/simulator-build.log"
  echo "No simulator application was produced (exit $status)" >&2; exit 1
fi
ruby tools/configure-ios-uitests.rb
xcrun simctl boot "$device" || true
xcrun simctl bootstatus "$device" -b
project=$(find src-tauri/gen/apple -maxdepth 1 -name '*.xcodeproj' -print -quit)
python3 tools/ios-native-tests/server.py &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
set +e
xcodebuild test -project "$project" -scheme FocusFeedUITests -destination "platform=iOS Simulator,id=$device" -collect-test-diagnostics never -resultBundlePath "$origin/dist-ios/SimulatorTests.xcresult" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO | tee "$origin/dist-ios/simulator-tests.log"
test_status=${PIPESTATUS[0]}
set -e
mkdir -p "$origin/dist-ios/simulator-screenshots"
xcrun xcresulttool export attachments --path "$origin/dist-ios/SimulatorTests.xcresult" --output-path "$origin/dist-ios/simulator-screenshots" || true
xcrun xcresulttool get test-results summary --path "$origin/dist-ios/SimulatorTests.xcresult" > "$origin/dist-ios/simulator-summary.json" || true
xcrun simctl spawn "$device" log show --last 5m --style compact --predicate 'process == "Focus Feed Next"' > "$origin/dist-ios/simulator-console.log" || true
exit "$test_status"
