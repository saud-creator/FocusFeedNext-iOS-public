# Focus Feed Next — iOS project

This workspace combines the pinned main snapshot of
[saud-creator/FocusFeedNext-iOS](https://github.com/saud-creator/FocusFeedNext-iOS)
with its newer **0.8.5 stability source**, followed by the **0.8.6 repair candidate**. The editable application is in
`source/`: React/TypeScript, a shared Rust/Tauri backend, and an iOS
Swift/WebKit plugin.

## Start here

- [App improvement plan](docs/IMPROVEMENT_PLAN.md)
- [Physical-device acceptance session](docs/DEVICE_ACCEPTANCE.md)
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
python3 tools/verify-ipa.py dist-ios/FocusFeedNext-unsigned.ipa --version 0.8.6 --output dist-ios/ipa-verification.json
```

The root `bash build-ios-unsigned.sh 1` command delegates to the same source
script. Codemagic uses the M2 runner, Node 24 and Xcode 27.1. Pushes to upstream
main run frontend, shared Rust, native Swift/WebKit, browser and iOS 27 simulator
tests before packaging an unsigned device IPA. Superseded main runs are cancelled.
Reports and screenshots accompany the artifact. Signing and device installation
are separate steps. See [validation status](docs/VALIDATION.md) for actual results.

## Source ownership

- `source/` is authoritative for development and builds.
- `FocusFeedNext-source.zip` is the original **main** archive, preserved
  byte for byte for comparison. It is historical and is not used by the updated
  build workflows.
- `docs/upstream/` retains the newer branch's recovery and stability notes.
- `.import/` contains ignored local comparison files and dependency caches.

Upstream main retains its original history: the editable-source import is a
descendant of its former head. The unrelated local snapshot history is never
pushed. Reviewed changes are published with an expected-head lease through the
GitHub connection; no force push is used. See the import record for provenance.

The older documents inside `source/` describe several desktop, companion and
standalone releases. Use this README and the import record for the current
workspace layout and version.
