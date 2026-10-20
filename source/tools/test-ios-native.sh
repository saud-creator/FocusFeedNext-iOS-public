#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist-ios/native-tests
fingerprint=$(python3 tools/native-test-fingerprint.py)
receipt=dist-ios/native-tests/input.sha256
if [[ "${1:-}" == --reuse-verified && -f "$receipt" && "$(cat "$receipt")" == "$fingerprint" ]] &&
   grep -q '^Native session and WebKit checks passed:' dist-ios/native-tests/results.txt; then
  echo 'Reusing native fixtures passed for identical inputs and toolchain in this build.'
  exit 0
fi
rm -f "$receipt"
python3 tools/ios-native-tests/server.py &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
for attempt in {1..20}; do
  if curl --noproxy '*' -fsS http://127.0.0.1:8769/explicit-fetch >/dev/null; then break; fi
  sleep 0.1
done
swiftc src-tauri/plugins/ios-reader/ios/Sources/SessionTransaction.swift \
  src-tauri/plugins/ios-reader/ios/Sources/ReaderChrome.swift \
  src-tauri/plugins/ios-reader/ios/Sources/TransportRules.swift \
  src-tauri/plugins/ios-reader/ios/Sources/TransportDocument.swift \
  src-tauri/plugins/ios-reader/ios/Sources/LoginCookies.swift \
  src-tauri/plugins/ios-reader/ios/Sources/LoginHandoff.swift \
  src-tauri/plugins/ios-reader/ios/Sources/ConnectionFault.swift \
  src-tauri/plugins/ios-reader/ios/Sources/IdentityTransport.swift \
  src-tauri/plugins/ios-reader/ios/Sources/ProviderHTTPTransport.swift \
  src-tauri/plugins/ios-reader/ios/Sources/ConnectionJournal.swift \
  src-tauri/plugins/ios-reader/ios/Sources/ReaderScript.swift \
  tools/ios-native-tests/main.swift -o dist-ios/native-tests/verify-webkit
dist-ios/native-tests/verify-webkit | tee dist-ios/native-tests/results.txt
printf '%s\n' "$fingerprint" > "$receipt"
