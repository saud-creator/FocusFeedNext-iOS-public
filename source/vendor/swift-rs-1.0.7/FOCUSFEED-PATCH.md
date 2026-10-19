Imported from the official crates.io swift-rs 1.0.7 archive, SHA-256
`4057c98e2e852d51fdcfca832aac7b571f6b351ad159f9eda5db1655f8d0c4d7`.
The MIT and Apache licenses are retained.

The only code change is in `src-rs/build.rs`: pass the target triple to
SwiftPM itself, select its native build system, and query its output directory.
Xcode 27's default SwiftPM backend appended macOS compiler settings after the
iOS simulator overrides, causing Tauri's WebKit import to fail. Both simulator
and device builds use the same correction and retain the iOS 16 minimum.
