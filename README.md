# Focus Feed Next — iOS project

This workspace combines the pinned main snapshot of
[saud-creator/FocusFeedNext-iOS](https://github.com/saud-creator/FocusFeedNext-iOS)
with its newer **0.8.5 stability source**. The editable application is in
`source/`: React/TypeScript, a shared Rust/Tauri backend, and an iOS
Swift/WebKit plugin.

## Start here

- [App improvement plan](docs/IMPROVEMENT_PLAN.md)
- [Import record and branch decisions](docs/IMPORT_NOTES.md)
- [File comparison and archive checksums](docs/SOURCE_IMPORT.json)
- [Upstream 0.8.5 changes and limitations](docs/upstream/STABILITY_0.8.5.md)

## Run and check

With Node.js 24 and npm installed:

```sh
cd source
npm ci
npm run dev
# In a separate terminal:
npm run check
```

The browser preview verifies the shared interface. Native sign-in and live iOS
data require the native application; release mode does not invent feed content.

For a native desktop build, install Rust and the platform prerequisites, then
run `npm run tauri -- dev` from `source/`.

## Build for iPhone

On macOS with Xcode and the iPhoneOS SDK, Rust, Node/npm and CocoaPods:

```sh
cd source
npm ci
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
bash tools/build-ios-unsigned.sh 1
python3 tools/verify-ipa.py dist-ios/FocusFeedNext-unsigned.ipa --version 0.8.5 --output dist-ios/ipa-verification.json
```

The root `bash build-ios-unsigned.sh 1` command delegates to the same source
script. GitHub Actions and Codemagic retain manual build entry points, check the
frontend, and verify the unsigned IPA. Neither service was triggered by this
import. Signing and device installation are separate release steps.

## Source ownership

- `source/` is authoritative for development and builds.
- `FocusFeedNext-source.zip` is the original **main** archive, preserved
  byte for byte for comparison. It is historical and is not used by the updated
  build workflows.
- `docs/upstream/` retains the newer branch's recovery and stability notes.
- `.import/` contains ignored local comparison files and dependency caches.

The local `main` branch is a snapshot import, not a clone of upstream history.
Work continues on `codex/ios-import-improvement-plan`; the remote is configured
as `origin`. See the import record before reconnecting Git history.

The older documents inside `source/` describe several desktop, companion and
standalone releases. Use this README and the import record for the current
workspace layout and version.
