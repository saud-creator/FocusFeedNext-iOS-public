# Focus Feed Next: screenshot repair and improvement plan

Approved scope: retain the shared reader, native iOS navigation and media, the
iOS 16 deployment minimum, complete pictures, authored paragraph breaks, and
English/Arabic. Prioritize iOS 27. Publish ordinary corrective commits directly
to upstream main without replacing history.

## Repair sequence and gates

1. **Editable baseline:** import pinned 0.8.5 source as a descendant of upstream
   main; build tracked source; expose version, build and source commit in Settings.
2. **Mac runner:** M2, Node 24, Xcode 27.1, iOS 27 simulator; main-only push
   webhook and cancellation of superseded runs. Frontend, Rust, Swift/WebKit,
   Chromium/WebKit and simulator tests precede device packaging. Export reports,
   logs, screenshots, xcresult, IPA verification and checksums. Fixtures require
   the opt-in debug feature and a separate simulator renderer build; device
   packaging refuses fixture mode.
3. **Authentication/welcome:** settle failure, cancellation and retry; preserve
   account transactions across background/resume; ignore obsolete callbacks;
   keep technical details in diagnostics. Hide reader tabs on welcome/sign-out.
4. **Account loading:** authoritative state, progress time and safe terminal
   error; store state before events; first 30 accounts then cursor pages of 60;
   preserve completed pages; reconcile mount/foreground and missed events;
   loading only while a worker owns the slot; explicit retry after failure.
5. **Progressive feeds/profiles:** first 20 posts, cursor continuations of 40,
   one continuation at a time, independent avatars/profile enrichment,
   prefetch near the visible batch, foreground priority and 30-second read
   budgets, slow feedback at eight seconds, preserve posts on failed refresh,
   reject obsolete route/account results. Retain the desktop CLI fallback.
6. **Media transport:** validated registrations bound to account generation,
   range/expired/source/interruption/refusal fixtures, loaded/loading/failed
   images, initials for failed avatars and compact media retry, bounded reads
   and decoding. Reconcile explicit server relationships after follow writes;
   never replay an uncertain write automatically. The reported follow bug
   remains unconfirmed until deliberately reproduced.
7. **Layout:** one UITabBar, measured occupied height, one bottom reservation,
   avatar beside identity only, full card width for content, 44-point primary
   targets, wrapping subtitles, localized relative time. Reject delayed
   navigation updates after a newer hide.
8. **Native presentation:** restrained inline video with secondary options in
   one menu; AVPlayerViewController fullscreen preserving time/state; native
   paged photos with pinch/double-tap zoom, swipe and close inside safe areas;
   rotation, interruption/background handling, one playback owner and bounded
   image memory; uncropped adaptive feed images.
9. **After repair gates:** native pull-to-refresh, robust reading-position
   restoration, selected-tab tap to top, optional data-saving preloading, and
   consistent English/Arabic recovery feedback. Re-test each addition.

## Screenshot acceptance

- Welcome and privacy content reachable with no reader tabs (1).
- Uncropped adaptive images and full-width content (2, 4, 7, 10).
- Compact inline controls and native fullscreen (3, 9).
- Account results or settled error with retry, never permanent skeletons (5).
- Photo controls below the status bar (6).
- Recoverable unavailable media, no finished broken-image glyph (8, 11, 12).
- Avatars or initials, readable identity rows/subtitles; localized updated time.

Letterboxing around a complete fullscreen image is permitted. Do not stretch
pictures, crop useful content, or strip authored blank lines from posts.

## Release discipline

Reproduce -> regression -> fix -> local checks -> leased main commit ->
Codemagic gates -> verified IPA. Failed checks stop packaging and the next
milestone. Keep the prior artifact and recover through ordinary corrective or
revert commits.

Exercise portrait/landscape, English/Arabic, large text, reduced motion and
transparency, actual image/video failures and fullscreen dismissal. Controlled
simulator first-page paint must be within 250 ms after content is returned.

Final live acceptance requires the user's iOS 27 device and account: a
20-minute mixed-media reading session, sign-in/retry/background/network changes,
resource observation, and a follow action deliberately chosen by the user.
Simulator and unit results do not substitute for that physical-device gate.

See VALIDATION.md for observed results and remaining gates, rather than treating
this plan as a claim that all testing has passed.
