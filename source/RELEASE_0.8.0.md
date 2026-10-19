# FocusFeedNext 0.8.0

Standalone iPhone reader, bundle `com.focusfeed.next`, minimum iOS 16. This release repairs native login handoff, adds safe staged connection errors, validates the selected identity, and recovers transient reads within their original deadline. Sent writes are never replayed automatically. Existing sessions are retained when replacement fails.

The iPhone navigation uses UIKit tab items with short localized labels and full accessibility names. The cyan/yellow icon has cleaner geometry. Ultra mode adds bounded 16/6 directional rows, 900 px nearby images, and single-flight continuation within three screens; power, heat and network restrictions still apply.

iPhone video quality migrates once to the highest actual available variant and preserves later choices. Playback adds accessible ten-second seeking, speed preservation across quality changes, and explicit lower-quality recovery. Targeted follow/unfollow controls reconcile the provider relationship; paid creator subscriptions open the official X profile and are managed there.

Credentials remain native and are excluded from diagnostics, exports, source snapshots and timings. Timings are bounded and split app queue/bootstrap/parsing work from provider response time. Automated account operations use fixtures.

Validation and delivery evidence is recorded beside the unsigned IPA in `dist-ios/standalone-0.8.0-build*/verification-report.md`. Native compilation, WebKit fixture results, source hash and IPA structure must be verified before delivery. The retained 0.7.0 source and IPA remain available for rollback.

A signed physical iPhone is still required to verify fresh live Twitter login, relaunch restoration, network transitions, VoiceOver/native layout, video decoding, ProMotion frame pacing, memory and energy. Automated fixture results cannot establish these outcomes or guarantee continuous 120 FPS or elimination of every bug.
