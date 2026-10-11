# FocusFeedNext 0.7.0

Standalone iPhone reader with on-device Twitter transport and session-only fetched content. The bundle identity remains `com.focusfeed.next`. Existing 0.6.0 source and IPA are retained under `dist-ios` for rollback.

## Connection and storage

Login uses a temporary web view. The private transport uses a different nonpersistent web view with content rules blocking page scripts, images, media, fonts and styles. Explicit engine fetches remain available. Supporting cookies and the credential pair commit in one versioned Keychain record after successful identity validation; failed replacement retains the previous record. Legacy sessions migrate after a successful health check. Cookie installation is serialized and account changes clear the transient transport store.

The native engine schedules one provider operation at a time, with priority, read coalescing, deadlines covering queue time, generation cancellation and the existing 700 ms request spacing. Writes already sent are never automatically replayed. Account epochs reject late data before storage commits. Transport navigation failures and WebKit termination invalidate work and require a fresh transport on the next read.

## Reader controls

Balanced is the default performance mode. Fast and Battery Saver alter bounded row buffers, nearby image loading and continuation distance. OS events provide foreground state, network constraints, Low Power Mode, heat and accessibility settings. Backgrounding stops monitoring, refresh timers and playback; pressure clears inactive query caches. Auto quality chooses available variants around 720p on Wi-Fi, 480p on expensive connections, or 360p during power saving. Manual quality remains available.

Choose and order four navigation tabs; More retains other destinations and Settings. Search loaded posts locally without a provider request. Customize reading size, haptics and autoplay (Wi-Fi only by default on a new iOS installation). Preferences use serialized atomic saves; failures retain the draft for retry. Versioned import/export excludes credentials, fetched posts, action permissions and account Lists.

English and Arabic share these controls. Native navigation follows appearance, accent, direction, fullscreen state and accessibility notifications. iOS 26 uses Liquid Glass with material fallback on earlier versions and opaque chrome under Reduce Transparency.

## Validation boundaries

Frontend and Rust regression suites, production build, scoped lint, browser fixtures at iPhone sizes, comparative scroll measurements, native session fault injection, real macOS WebKit integration fixtures and unsigned arm64 device compilation are recorded in the release verification report. Automated account changes use fixtures only.

Signed physical-iPhone profiling remains required for live-session, cellular transition, memory, accessibility, decoder and battery acceptance. Synthetic Windows-browser measurements isolate app rendering; they do not measure Twitter latency or prove iPhone energy use. An unsigned IPA must be signed by its owner before normal device installation.
