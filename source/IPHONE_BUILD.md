# Focus Feed Next for iPhone

## What this project now contains

The iPhone version is a real Tauri 2 mobile target built from the same React interface, Rust models, database, filters, local Lists, reading state, media pipeline, Arabic catalog, and preference system as the Windows app. It is not a browser wrapper and it does not contain demo feed data.

The one part that cannot move directly to iOS is the current X provider. The Windows app launches `twitter-cli`, which is a Python command-line process with desktop networking dependencies. An App Store iOS app cannot launch that child process. The implemented design therefore has two cooperating pieces:

1. The Windows app retains the X cookies in Windows Credential Manager and runs `twitter-cli` exactly as it does today.
2. The iPhone app pairs with an explicitly started, read-only provider bridge in the Windows app over the private local network.
3. Only stable feed/profile models cross the bridge. `auth_token`, `ct0`, and the X password never reach the iPhone.
4. The iPhone stores its random companion token and local Windows address in iOS Keychain.

This provides a functional iPhone reader from the existing Windows product without pretending that an impossible child-process port is standalone.

## Current iPhone behavior

The shared iPhone build includes:

- Following, Focus Feed, Originals, Bookmarks, People You Follow, Lists, Profiles, and Settings.
- The existing filters, read/unread tracking, muted words, video quality and playback preferences, English, and Arabic RTL support.
- A five-item iPhone bottom tab bar and a native-style bottom sheet for secondary pages.
- Safe-area handling for the status bar, home indicator, and on-screen keyboard.
- A dedicated Windows companion pairing screen. It never asks for X cookies.
- Session-only post storage and durable user preferences in the iOS app sandbox.
- Read-only X access on iPhone. Follow, Unfollow, Mute, and Block are deliberately unavailable through the companion.

The live feed currently requires the Windows app to be open and both devices to be on the same private Wi-Fi network. iOS background suspension also means the app does not promise background refresh or push notifications.

## Security boundary for the TestFlight build

- The Windows listener is stopped by default. It starts only after **Start iPhone companion** is pressed and stops when requested or when the Windows app exits.
- The listener binds only the single detected private-network adapter on an OS-selected port; it does not listen on every Windows interface. The iPhone client also bypasses configured HTTP proxies so the local bearer token is sent only to the entered private address.
- Pairing uses an eight-digit, one-use code. Five failed attempts temporarily block new attempts.
- A random 256-bit bearer token authorizes subsequent requests. The token is never returned to the React UI.
- The companion endpoint exposes only named read operations and limits request bodies to 64 KiB. It has no arbitrary command or write-operation route.
- X cookies remain in Windows Credential Manager. The iPhone stores only the companion token and private address in Keychain.
- The first TestFlight version uses authenticated plain HTTP on the local network because the devices do not share a trusted TLS certificate. Use it only on a trusted private Wi-Fi network; feed responses and the companion token are not protected against a hostile device actively monitoring that LAN. A future production-hardening phase should add a pinned TLS or password-authenticated encrypted transport before a broad public release.

That final limitation is intentionally stated rather than hidden. It is acceptable for controlled internal TestFlight testing, but it should be resolved before treating the app as safe on hotel, university, office, or public Wi-Fi.

## Files that make up the iPhone target

- `src-tauri/tauri.ios.conf.json` — iPhone window and iOS 16 deployment configuration.
- `src-tauri/Info.ios.plist` — local-network privacy purpose, local networking ATS allowance, and export-compliance declaration.
- `src-tauri/src/companion.rs` — Windows pairing host and the iPhone `RemoteProvider` implementation.
- `src/components/settings/IphoneCompanion.tsx` — Windows host controls and iPhone pairing UI.
- `src/components/layout/MobileNavigation.tsx` — iPhone tab bar and More sheet.
- `src/lib/platform.tsx` — selects the iPhone or desktop shell at runtime.
- `src-tauri/icons/icon-ios-1024.png` — verified 1024×1024 opaque App Store icon.
- `.github/workflows/ios.yml` — macOS build, signing, validation, artifact, and optional TestFlight upload.
- `tools/verify-ios-project.ps1` — Windows-side structural and full shared-code verification.

## Unsigned IPA for signing yourself

Use **Actions → Build unsigned iPhone IPA → Run workflow** in a private GitHub
repository containing the current project. This separate workflow needs no Apple
secrets, developer membership, or provisioning profile. Download the
**FocusFeedNext-unsigned-iPhone** artifact when the build succeeds; it contains
`FocusFeedNext-unsigned.ipa` and its SHA-256 checksum. Sign the IPA with your own
tool before installing it on an iPhone.

On a Mac with Xcode, Node.js, Rust, and CocoaPods installed:

```bash
npm ci
bash tools/build-ios-unsigned.sh 1
```

The output is `dist-ios/FocusFeedNext-unsigned.ipa`. The script disables Xcode
signing, packages the archived arm64 device app under `Payload/`, and checks the
device platform, architecture, absence of a signature/profile, and ZIP integrity.
The pinned Tauri CLI may fail its subsequent signed export; the script accepts
that only when Xcode reported a successful archive, or the exporter specifically
rejected the archive because it has no signing team, and produced the device app.
Use a fresh checkout for each build to avoid stale archives.

The unsigned path completed successfully on a GitHub macOS runner on October 9,
2026. Native device compilation, archiving, unsigned packaging, arm64/platform
checks, signature/profile absence checks, and ZIP verification all passed.
The successful run is https://github.com/saud-creator/FocusFeedNext-iOS/actions/runs/37970486600.
Download the IPA and checksum artifact at
https://github.com/saud-creator/FocusFeedNext-iOS/actions/runs/37970486600/artifacts/11634719222
(retained for 14 days). Physical iPhone installation and live pairing still need
device verification. The private build repository is
https://github.com/saud-creator/FocusFeedNext-iOS. Because shell network access was
unavailable, that repository uses an isolated source ZIP plus the latest build
script and a workflow based on `tools/ios-source-workflow.yml`. The iPhone feed
still requires the Windows companion on the same private Wi-Fi network.

## Why the IPA cannot be produced locally on this Windows PC

Tauri's iOS commands are compiled only on macOS, and an iPhone archive requires Apple's Xcode toolchain, iOS SDK, code-signing system, and provisioning. Installing the Rust iOS standard library on Windows is useful but does not provide Apple's `xcrun`, SDK, linker, or signing tools. The included GitHub Actions workflow supplies that required macOS environment without requiring you to own a Mac.

## One-time Apple setup

An ordinary Apple ID is not enough for TestFlight distribution. The account must be enrolled in the Apple Developer Program and have access to App Store Connect.

1. In Apple Developer Certificates, Identifiers & Profiles, register the explicit Bundle ID:

   `com.focusfeed.next`

2. In App Store Connect, create an iOS app record that uses that exact Bundle ID. The SKU can be any private unique value, for example `focusfeednext-ios`.
3. In App Store Connect → Users and Access → Integrations, create a team API key with **Admin** access. Tauri's automatic iOS signing flow requires that role. Download its `.p8` file immediately; Apple offers that download once.
4. Record these four values:

   - Apple Developer Team ID — ten-character team identifier.
   - App Store Connect API Issuer ID — UUID.
   - App Store Connect API Key ID.
   - Complete text of the downloaded `.p8` private key.

If `com.focusfeed.next` is already owned by another Apple team, choose a unique reverse-domain identifier and change `identifier` in `src-tauri/tauri.conf.json` before creating the App Store Connect record. The project and Apple record must match exactly.

## Put the project on GitHub

The repository currently has no configured remote, so no source or secret was uploaded automatically. Create a private GitHub repository, commit the intended project state, and push it. Preserve the existing mixed worktree carefully; do not use `git reset`, `git clean`, or a blanket replacement commit.

In the private repository, open **Settings → Secrets and variables → Actions** and add these repository secrets:

| Secret                   | Value                                        |
| ------------------------ | -------------------------------------------- |
| `APPLE_DEVELOPMENT_TEAM` | Apple Team ID                                |
| `APPLE_API_ISSUER`       | App Store Connect issuer UUID                |
| `APPLE_API_KEY`          | App Store Connect key ID                     |
| `APPLE_API_KEY_P8`       | Entire `.p8` file, including BEGIN/END lines |

The private key is exposed only to the signing, validation, and upload steps. It is written into GitHub's ephemeral macOS runner and removed in the final step.

## Build the first signed IPA

1. In GitHub, open **Actions → Build iPhone IPA → Run workflow**.
2. Set `build_number` to `1` for the first archive. Every later App Store Connect upload must use a higher number.
3. Leave `upload_to_testflight` set to `false` for the first run.
4. Run the workflow.

The workflow performs all of the following on `macos-15`:

1. Installs the exact locked JavaScript dependencies and Rust iOS targets.
2. Runs the full frontend and desktop Rust test suites.
3. Runs `tauri ios init --ci` to generate the native Xcode project.
4. Generates the Apple icon set from the opaque 1024×1024 source.
5. Builds an App Store Connect archive with automatic signing.
6. Confirms that the IPA is a valid ZIP archive.
7. Sends the archive through App Store Connect validation.
8. Uploads the signed IPA as a private GitHub Actions artifact for 14 days.

Download **FocusFeedNext-iPhone-1** from the completed workflow's Artifacts section. It contains the signed `.ipa`.

## Upload to TestFlight

After the first build validates successfully, run the same workflow again with:

- A higher `build_number`, such as `2`.
- `upload_to_testflight` set to `true`.

The workflow uses Apple's `altool` with the API key to upload the exact validated IPA. App Store Connect then processes the build. In the TestFlight tab:

1. Complete any export-compliance question. The project declares that it does not implement non-exempt encryption.
2. Add internal testers first. Internal TestFlight testing does not require Beta App Review.
3. Add testing notes explaining that the app needs Focus Feed Next 0.5.7 or later running on Windows on the same private Wi-Fi.
4. Install the build from the TestFlight app on the iPhone.

External testers require Apple's Beta App Review, contact information, testing notes, and the normal App Store privacy/support metadata.

## Pair the two apps

1. On Windows, open Focus Feed Next and confirm that the X connection works.
2. Open **Settings → iPhone companion**.
3. Press **Start iPhone companion**.
4. If Windows Firewall prompts, allow access only on **Private networks**.
5. Keep the Windows app open. Note the displayed address and eight-digit code.
6. On iPhone, open Focus Feed Next → **More → Settings → Windows companion**.
7. Enter the address and code exactly as shown, then press **Pair with Windows**.
8. Accept iOS's local-network permission prompt. The connected X account should appear on the iPhone.

If pairing fails, confirm that both devices use the same Wi-Fi, client isolation is disabled on the router, the Windows network profile is Private, the companion is still running, and the current one-use code is being used.

## Windows-side verification

Run the complete shared-code and project gate from PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-ios-project.ps1
```

For a fast structural check that skips the test suites:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-ios-project.ps1 -SkipTests
```

Windows can validate the shared frontend, companion protocol, configuration, plist keys, workflow gates, and icon. Only the included macOS workflow can honestly validate the generated Xcode project, device archive, signing profile, App Store Connect acceptance, and physical iPhone behavior.

## Manual Mac fallback

If you later gain temporary access to a Mac with Xcode, Node.js, Rust, and CocoaPods, the equivalent commands are:

```bash
npm ci
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --all
export APPLE_DEVELOPMENT_TEAM="YOUR_TEAM_ID"
npm run tauri -- ios init --ci
npm run tauri -- icon src-tauri/icons/icon-ios-1024.png --ios-color "#0a0b10"
npm run tauri -- ios build --ci --export-method app-store-connect --build-number 1
```

The signed IPA is produced under `src-tauri/gen/apple/build/`. Do not commit `src-tauri/gen/apple`, provisioning profiles, certificates, `.p8` keys, or an exported IPA.

## Remaining release evidence

The project is implementation-complete and Windows-verified, but the following evidence cannot exist until the Apple secrets and macOS workflow are used:

- A generated Xcode project and successful iOS device compilation.
- A signed `.ipa` accepted by App Store Connect validation.
- TestFlight processing and installation on a physical iPhone.
- Visible pairing, feed loading, scrolling, video playback, Arabic RTL, suspend/resume, and reconnect testing on that iPhone.
- App Store screenshots, support URL, privacy-policy URL, age rating, privacy nutrition labels, and external Beta App Review if external testers are invited.

Those are explicit final gates, not hidden work. The workflow is the executable handoff that completes the IPA once the Apple account values are supplied.
