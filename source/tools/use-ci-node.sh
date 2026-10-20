#!/usr/bin/env bash
# Source in each runner shell: its default PATH can override environment.node.
set -euo pipefail
ffn_node_version=24.22.0
if [[ "$(node --version 2>/dev/null || true)" != "v$ffn_node_version" ]]; then
  if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    echo 'This release runner requires Apple Silicon macOS and Node 24.22.0.' >&2
    return 1
  fi
  ffn_node_cache="$HOME/.cache/focusfeed-node"
  ffn_node_name="node-v$ffn_node_version-darwin-arm64"
  ffn_node_root="$ffn_node_cache/$ffn_node_name"
  if [[ ! -x "$ffn_node_root/bin/node" ]]; then
    mkdir -p "$ffn_node_cache"
    ffn_node_archive="$ffn_node_cache/$ffn_node_name.tar.gz"
    curl --proto '=https' --tlsv1.2 -fsSL --retry 2 \
      "https://nodejs.org/dist/v$ffn_node_version/$ffn_node_name.tar.gz" -o "$ffn_node_archive"
    # Official https://nodejs.org/dist/v24.22.0/SHASUMS256.txt.
    printf '%s  %s\n' '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5' "$ffn_node_archive" | shasum -a 256 -c -
    tar -xzf "$ffn_node_archive" -C "$ffn_node_cache"
  fi
  export PATH="$ffn_node_root/bin:$PATH"
  hash -r
fi
node -e "if (process.versions.node !== '24.22.0') throw new Error('Node 24.22.0 is required')"
node --version
