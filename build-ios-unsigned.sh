#!/usr/bin/env bash
set -euo pipefail

# The tracked source is authoritative. The root ZIP is the frozen main snapshot.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$root/source/package-lock.json" || ! -f "$root/source/tools/build-ios-unsigned.sh" ]]; then
  echo 'The editable source/ checkout is incomplete. Restore it before building.' >&2
  exit 1
fi
exec bash "$root/source/tools/build-ios-unsigned.sh" "$@"

