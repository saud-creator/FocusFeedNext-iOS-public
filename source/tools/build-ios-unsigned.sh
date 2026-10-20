#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
[[ "${FFN_UI_TEST:-0}" != 1 ]] || { echo 'Simulator fixtures cannot be packaged in a device IPA.' >&2; exit 1; }
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'An iOS device build requires macOS and Xcode. This environment cannot compile an iPhone executable.' >&2
  exit 1
fi
xcrun --sdk iphoneos --show-sdk-path >/dev/null
node tools/build-ios-native.mjs
bash tools/test-ios-native.sh
build_number="${1:-1}"
[[ "$build_number" =~ ^[0-9]+$ ]] || { echo 'Build number must be numeric.' >&2; exit 1; }
output="$PWD/dist-ios"
mkdir -p "$output"
cat "$output/native-tests/results.txt" > "$output/build.log"
if find src-tauri/gen/apple/build -name '*.xcarchive' -print -quit 2>/dev/null | grep -q .; then
  echo 'Existing Xcode archive found. Use a fresh checkout to avoid packaging an old build.' >&2
  exit 1
fi
unset APPLE_DEVELOPMENT_TEAM APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
rustup target add aarch64-apple-ios
# Generate the bundled, isolated WebKit request engine before Swift packaging.
node tools/build-ios-native.mjs
npm run tauri -- ios init --ci
# This CLI version does not forward its trailing arguments to xcodebuild.
# Set signing off in every generated Xcode build configuration instead.
python3 - <<'PY'
from pathlib import Path
for project in Path('src-tauri/gen/apple').glob('*.xcodeproj/project.pbxproj'):
    text = project.read_text()
    text = text.replace('buildSettings = {', 'buildSettings = {\nCODE_SIGNING_ALLOWED = NO;\nCODE_SIGNING_REQUIRED = NO;')
    project.write_text(text)
PY
npm run tauri -- icon src-tauri/icons/icon-ios-1024.png --ios-color '#0a0b10'

# The pinned CLI exports a signed IPA after archiving. Disable signing at the
# Xcode archive stage and package the resulting device .app ourselves instead.
set +e
npm run tauri -- ios build --ci --target aarch64 --build-number "$build_number" \
  2>&1 | tee -a "$output/build.log"
build_status=${PIPESTATUS[0]}
set -e
app="$(find src-tauri/gen/apple/build -path '*.xcarchive/Products/Applications/*.app' -type d -print -quit)"
if [[ -z "$app" ]]; then
  echo "No device application archive was produced (CLI exit $build_status)." >&2
  exit 1
fi
if [[ "$build_status" != 0 ]] && ! grep -q '\*\* ARCHIVE SUCCEEDED \*\*' "$output/build.log" && \
   ! { grep -q 'exportArchive No Team Found in Archive' "$output/build.log" && \
       grep -q 'failed to export iOS app' "$output/build.log"; }; then
  echo 'Archive did not succeed; refusing to package an incomplete application.' >&2
  exit 1
fi
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/Payload"
ditto "$app" "$staging/Payload/$(basename "$app")"
packaged_app="$staging/Payload/$(basename "$app")"
version_prefix=$(node -p "require('./package.json').version.split('.').map(Number).join('')")
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version_prefix.$build_number" "$packaged_app/Info.plist"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$packaged_app/Info.plist")
lipo "$packaged_app/$executable" -verify_arch arm64
/usr/libexec/PlistBuddy -c 'Print :CFBundleSupportedPlatforms' "$packaged_app/Info.plist" | grep -q iPhoneOS
if find "$packaged_app" \( -name _CodeSignature -o -name embedded.mobileprovision \) -print -quit | grep -q .; then
  echo 'Unexpected signature or provisioning profile in unsigned app.' >&2
  exit 1
fi
if codesign -dv "$packaged_app" >/dev/null 2>&1; then
  echo 'Application has a code signature; refusing to label it unsigned.' >&2
  exit 1
fi
ipa="$output/FocusFeedNext-unsigned.ipa"
if [[ -e "$ipa" ]]; then
  echo 'Output already exists; move it aside before rebuilding.' >&2
  exit 1
fi
(cd "$staging" && zip -qry "$ipa" Payload)
unzip -tq "$ipa"
shasum -a 256 "$ipa" > "$ipa.sha256"
echo "Unsigned IPA: $ipa"
