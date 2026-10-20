# Tao 0.35.3: iOS scene ownership backport

Source: https://static.crates.io/crates/tao/tao-0.35.3.crate

Archive SHA-256: `d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`, matching the original Cargo lock entry. The complete published crate, including licenses and examples, is retained.

The only source change is the upstream fix from https://github.com/tauri-apps/tao/pull/1245 (commit `f2163508104413ef0609178dcebdd5803b496211`): return `Retained::autorelease_ptr(config)` from `configurationForConnectingSceneSession` rather than returning a pointer whose local owner is immediately dropped.

iOS 27 requires the scene lifecycle. `Info.ios.plist` declares Tao's existing scene delegate so the application can launch with Xcode 27.1. Enabling that path also requires this ownership correction, especially in optimized device builds. The pinned Tauri 2.11 dependency requires Tao 0.35, so a broad runtime upgrade is avoided. Remove this backport when upgrading to a Tauri release that includes the upstream correction.
