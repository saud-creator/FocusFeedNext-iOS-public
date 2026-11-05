# Physical iPhone acceptance report

Copy this blank report for each qualified candidate. Record results as Pass,
Fail or Pending. Manual smoke checks do not establish instrumented performance
results. Do not mark release acceptance passed while a required gate is pending
or failed. Keep credentials, account/member/post IDs, content and URLs out of
this report; record preservation status and aggregate counts only.

## Device and build record

| Field | Record |
|---|---|
| Test date / tester | |
| Primary affected iPhone model / iOS version | |
| Actual display refresh cadence during scrolling | |
| Reference installation | 0.9.0, build 31 (`090.31`), source `65CC631F` |
| Candidate version / build / source from Settings → About | |
| Candidate IPA checksum / automated qualification reference | |
| Current supported OS device result | Pending |
| Minimum iOS 16 device/runtime result, where compatible hardware/runtime is available | Pending |
| Controlled workload label / network conditions | |

## Upgrade and data preservation

Install over the existing app using the same identity. Stop if installation
requires deleting it. Retain the known-good signed artifact and protected
original database backup until upgrade acceptance passes.

| Check | Before / after aggregate count, if relevant | Result |
|---|---|---|
| Bundle ID remains `com.focusfeed.next` | | Pending |
| Signing team and Keychain access identity match the existing installation | | Pending |
| Upgrade completes without deleting the existing app | | Pending |
| Existing account access works after upgrade | | Pending |
| Language, theme, reading, media and performance preferences survive | | Pending |
| Existing account-action permissions survive | | Pending |
| Local List count, names and colors survive | Before: / After: | Pending |
| Each List's member count and membership survive, including members no longer followed | Before: / After: | Pending |
| Known-good signed rollback artifact and protected database backup retained | | Pending |

## Mixed-media session and interruption record

Complete at least 60 minutes of mixed-media reading and all 20 transitions.
Use identical assets/tasks for old/new comparisons without recording their IDs
or URLs here. Usable time starts when the controlled endpoint becomes available.
Record Auto, Retry or Failed; record every force quit, including workarounds.

Session start / end / total minutes: __________ / __________ / __________

| # | Trigger | Media / mode | Usable seconds | Recovery result | Force quit? |
|---|---|---|---|---|---|
| 01 | Wi-Fi → cellular | Photo | | Pending | Pending |
| 02 | Cellular → Wi-Fi | Inline video | | Pending | Pending |
| 03 | Airplane mode → connection returns | Photo | | Pending | Pending |
| 04 | Airplane mode → connection returns | Fullscreen video | | Pending | Pending |
| 05 | Lock / unlock | Photo | | Pending | Pending |
| 06 | Lock / unlock | Inline video | | Pending | Pending |
| 07 | Background for 1 minute | Photo | | Pending | Pending |
| 08 | Background for 1 minute | Inline video | | Pending | Pending |
| 09 | Background for 5 minutes | Photo | | Pending | Pending |
| 10 | Background for 5 minutes | Fullscreen video | | Pending | Pending |
| 11 | Background for 30 minutes | Photo | | Pending | Pending |
| 12 | Background for 30 minutes | Inline video | | Pending | Pending |
| 13 | Wi-Fi → cellular | Playing video | | Pending | Pending |
| 14 | Cellular → Wi-Fi | Photo viewer | | Pending | Pending |
| 15 | Airplane mode → connection returns | Explicitly paused video | | Pending | Pending |
| 16 | Lock / unlock | Explicitly paused fullscreen video | | Pending | Pending |
| 17 | Background for 1 minute | Video after seeking | | Pending | Pending |
| 18 | Background for 5 minutes | Video after quality change | | Pending | Pending |
| 19 | Background for 30 minutes | Explicitly paused video | | Pending | Pending |
| 20 | Wi-Fi → cellular → Wi-Fi | Photo and video | | Pending | Pending |

Force-quit-required recoveries: ________ (required: **zero**).
Failure notes / diagnostic evidence references, without private data: __________

## Reading, playback and accessibility

| Check | Result / evidence reference |
|---|---|
| Inline ↔ fullscreen preserves playhead, speed, mute, quality and explicit pause | Pending |
| Photo zoom/paging and video seeking/quality controls remain usable | Pending |
| Explicit pause survives recovery; background time does not consume loading watchdogs | Pending |
| Retry and Close remain reachable; terminal failures settle without endless loading | Pending |
| Account switch/disconnect shows no prior-account content or media | Pending |
| Bookmarks, Lists, profiles, search, articles and comments remain usable | Pending |
| Pull-to-refresh failure retains loaded content and reading position | Pending |
| Optional resume is off initially; enabling/restoring/disabling behaves as specified | Pending |
| English, Arabic and mixed-direction content, dates and numbers display correctly | Pending |
| Largest accessibility text, 44-point controls, rotation, keyboard and sheet dismissal | Pending |
| VoiceOver labels/actions, focus order and restored focus after navigation | Pending |
| Reduce Motion, Reduce Transparency and Increase Contrast | Pending |

## Measured performance gates

Use the same phone, assets, tasks and declared measurement boundaries for both
builds. Record tools, units, warmup, sample count and evidence; an impression of
smoothness or a simulator result cannot fill these device measurements.

Tools / workload / warmup / sample count: ___________________________________

| Measure / required gate | Old result | Candidate result | Evidence / status |
|---|---|---|---|
| Controlled recovery: p95 ≤5 seconds after endpoint availability; terminal failures within deadline | | | Pending |
| Returned data → visible content: p95 ≤250 ms, excluding provider latency | | | Pending |
| Cached navigation: p95 ≤150 ms | | | Pending |
| Input → visible response: p95 ≤100 ms | | | Pending |
| Warm mixed-media scrolling: ≥95% of frame deadlines met at actual refresh cadence | | | Pending |
| Equivalent reading/viewer cycles: memory settles after warmup; no extra retained models, requests or players | | | Pending |

For energy, perform three equal 30-minute old/new comparisons in Balanced mode
with identical tasks, assets and controlled brightness/network conditions.
Record the measurement tool/units and thermal state. Require no repeatable
energy or thermal regression; do not infer energy results from elapsed time.

Energy tool / units / controlled conditions: _________________________________

| Comparison | Old energy / thermal state | Candidate energy / thermal state | Result |
|---|---|---|---|
| 1: 30 minutes per build | | | Pending |
| 2: 30 minutes per build | | | Pending |
| 3: 30 minutes per build | | | Pending |

## Acceptance decision

Required matrix completed: Pending. Upgrade preserved: Pending.
Measured performance/energy gates met: Pending. Release acceptance: **Pending**.
Outstanding failures / required retest: _____________________________________
Evidence bundle reference / reviewer / review date: __________________________

Capture a refreshed connection report before force quitting a stuck session.
Record what failed before switching accounts or importing preferences. Retain
the signed rollback artifact and protected original data until acceptance passes.
