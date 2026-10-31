#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
swiftc -swift-version 5 -D NATIVE_POLICY_HARNESS -parse-as-library \
  "$root/NativeServices/RuntimePolicy.swift" \
  "$root/NativeServices/MediaFailureProvenance.swift" \
  "$root/NativeServices/RecoveryCoordinator.swift" \
  "$root/NativeServices/SessionTransaction.swift" \
  "$root/NativeServices/LoginHandoff.swift" \
  "$root/Tests/Services/NativePolicyTests.swift" \
  -o "$out/native-policy-tests"
"$out/native-policy-tests"
