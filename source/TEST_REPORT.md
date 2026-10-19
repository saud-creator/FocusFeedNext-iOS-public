# Test Report — Focus Feed Next

> The summary is the current 0.5.7 shared Windows/iPhone source audit. Detailed live-session measurements
> farther down were collected under 0.4.1 and remain historical evidence only.

Date: 2026-08-22 · Version **0.5.7** · Windows 11 (x64)

## Summary

| Suite | Result |
| --- | --- |
| Rust (`cargo test`) | **369 passed, 0 failed** (plus 0 binary/doc tests) |
| TypeScript (`vitest run`) | **548 passed across 34 files, 0 failed** |
| iPhone companion protocol | Pair + authenticated provider fetch passed through a real local socket and mock provider |
| `cargo check` | **PASS** |
| `cargo fmt --check` | Not a clean gate: the preserved mixed worktree contains existing rustfmt drift; no blanket formatting was applied |
| `cargo clippy --all-targets -- -D warnings` | Not rerun for this release slice |
| TypeScript compile | Clean (`tsc -b`, exit 0) |
| `oxlint` | 0 errors; existing Fast Refresh advisories remain warnings |
| Production frontend build | Success |
| iOS structure verifier | **PASS**: bundle identifier, iOS 16 metadata, plist, workflow, platform/provider wiring and 1024×1024 opaque icon |
| iPhone browser QA | 390×844 portrait and 844×390 landscape; no horizontal overflow, five tabs, pairing/settings and More sheet inspected |

Total automated tests in the current source suites: **917**. The companion and media-proxy integration tests
use real local sockets but never contact X or another external service.

The exact frontend files changed for the iPhone target pass Prettier. The
repository-wide Prettier check still names 53 older files in the pre-existing
mixed worktree, so that unrelated formatting was not presented as a new green
gate.

The Rust iOS standard-library target was installed and a Windows cross-check was
attempted. It stops in an Apple Objective-C helper before this app crate because
Windows has no `xcrun`, Apple Clang, iOS SDK or signing toolchain. That is the
expected platform boundary, not iOS compile evidence. The checked-in macOS
workflow must still generate the Xcode project, compile/sign the device archive,
validate the IPA with App Store Connect and run on a physical iPhone.

## v0.5.7 resource, privacy and bookmark verification

- `Db::in_memory()` is used by the desktop setup; the Rust unit suite includes
  the no-`content.db` session contract and the bounded bookmark-slice navigation
  test.
- The desktop setup refuses to start without a private per-run WebView2 profile,
  uses `incognito(true)`, holds a cleanup lock, and purges only stale locked
  temp fallback profiles. The media proxy is loopback-only, no-store, bounded
  to 128 MiB per response and four concurrent transfers.
- `npm.cmd run build` passed after the version bump; `npm.cmd run lint` passed
  with the repository's existing Fast Refresh advisories only. The current
  source-level results above are not live X/provider evidence.
- The installed profile was checked read-only before packaging: no
  Credential Manager entries matching `com.focusfeed.next` were present, so
  no provider fetch or real account mutation was attempted. The live-X release
  gate remains pending until a deliberate user-supplied Credential Manager
  session is available.

## v0.5.7 packaged Windows evidence

- The full portable lane passed `npm.cmd run portable`: frontend check, Tauri
  release build, copy into `dist-portable`, SHA-256 generation and shortcut
  validation. The promoted executable is
  `dist-portable\FocusFeedNext-v0.5.7\FocusFeedNext.exe`, 14,641,664 bytes,
  SHA-256
  `7fa187ea8ff5072501c9cab046ac0d6a425b4fef5a5e3cec385bcde863c8b113`.
- The package-local shortcut, Desktop shortcut and existing taskbar shortcut
  were replaced with link bytes containing the full real packaged EXE path;
  none contains the `CodexSandboxOffline` alias, and each contains the real
  working directory. This managed validation host reports
  `[Environment]::GetFolderPath('UserProfile')` as
  `C:\Users\CodexSandboxOffline` even though `USERPROFILE` and the files are
  under `C:\Users\Developer`; its WScript reader therefore resolves the
  embedded Shell PIDL to the alias. That host-specific Shell resolution is
  not claimed as a successful normal-Explorer launch gate. The packaging
  script writes the full real path, forwards all switches when relaunching
  from Windows PowerShell 5.1 to PowerShell 7, and verifies the persisted raw
  link target rather than accepting the virtual alias.
- A no-credential packaged smoke launch with `FFN_PAGE=diagnostics` started
  the release process and Microsoft Edge WebView2. While running, the
  portable directory contained only durable `preferences.db` plus the
  per-run lock/private WebView2 profile; no application `content.db`, WAL or
  SHM file was created. The exact smoke session was removed after the process
  was stopped, leaving the session directory empty. This is startup/runtime
  evidence, not live-X/provider evidence.
- After explicit approval, the four identified obsolete generated paths were
  removed: the old X profile, the old `com.focusfeed.next` WebView2 profile,
  one abandoned legacy session, and `src-tauri\target`. They totaled
  8,351,354,730 bytes across 15,260 files, and all four paths were verified
  absent afterward. The Rust target is intentionally removed only after the
  packaged artifact is verified; a future native rebuild will recreate it.
  No FocusFeedNext process was running during cleanup or the final check.

## Historical 0.4.1 evidence

## What the automated suite could not tell us

Two defects shipped in 0.4.0 with the whole suite green, and both were found by
reading the live session database instead:

- **Portrait video quality labels were inflated.** Eight variant tests passed.
  All eight used landscape fixtures, where the height and the shorter side are
  the same number — so no fixture could disagree with the bug. Live data held
  72 portrait renditions, every one mislabelled. Fixed in `e2b822a`, with the
  exact live ladder (1080×1920 → 720×1280 → 480×852 → 320×568) as a regression
  fixture, plus square and single-dimension cases.
- **Three comments described the promoted-content defence backwards.** A live
  following page arrived 20 ads in 45 posts _despite_ being requested with
  `--no-include-promoted`. No reader ever saw one — the filter is
  unconditional — but the code claimed the upstream flag was doing the work.

The lesson is recorded in `SPRINT_STATUS.md`: a fixture can only disagree with
the code about things the fixture's author already thought of.

## Measurements, as distinct from assertions

`perf/README.md` carries the scroll numbers. They were taken in Chromium with
the real `FeedList`, at the commit before the windowing change and at HEAD,
served on two ports simultaneously.

|                           | before | after   |
| ------------------------- | ------ | ------- |
| cards mounted (500 posts) | 500    | **11**  |
| DOM elements              | 25,818 | **595** |
| upward, median ms/step    | 10.2   | **4.9** |
| upward, p95               | 12.0   | **6.1** |
| upward, worst step        | 13.4   | **6.2** |

## Live verification, 0.4.0 installed build

Established from the application's own log, its session database, process
sampling and socket state. Screen control was not available in this session, so
nothing below rests on having looked at a rendered page.

| Check                    | Result                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| startup probe            | one, then `startup preload: following=true bookmarks=true`                                      |
| concurrent `twitter.exe` | max 2 — the two independent preload workers, by design                                          |
| Following list           | **189** accounts, all distinct, `following.syncComplete = 1`                                    |
| Bookmarks                | **200**, `seq` 0–199, no duplicates, cursor **null** (true end of traversal)                    |
| Bookmark order           | 15/200 positions coincide with publication order; position 4 holds the 105th-newest post        |
| media variants           | 228 media items, 96 carrying real ladders of 1–5 renditions                                     |
| promoted                 | 20 stored from a 45-post page, 0 reachable by the reader                                        |
| signed URLs              | none — the only query parameter anywhere is X's `tag`                                           |
| media proxy              | `127.0.0.1:55399`, single listener, secret never logged                                         |
| exit                     | 0 app processes, 0 `twitter.exe`, 0 workers, 0 session dirs, port released, 716,800 bytes freed |

## v0.5.6 bookmark-cap regression coverage (historical)

The v0.5.6 source and portable build removed the app-side 400-row bookmark
depth. The native preload passes an unlimited request to the patched provider,
and the bookmark-only provider path follows its terminal cursor instead of the
generic timeline count ceiling. The React cache read also requests every local
bookmark row after the first screen paints.

The pinned provider environment is not installed on this machine, so the
provider installer was verified by its rewriter test and PowerShell parse check
but was not run against a live X account. The 200-bookmark row above is
historical 0.4.0 live-session evidence, not a v0.5.6 account total or a
v0.5.7 live-account result.

## Phase 2.1 additions

| Area                     | Tests | What they pin down                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| twitter-cli 0.8.6        | 10    | `pagination.nextCursor` read from the envelope root; a command without pagination reports no cursor; an empty cursor is treated as absent; the real `isPromoted`; capabilities do not claim a People tab or unsupported cursors; hostile cursors never reach an argument array                                                                                                                                        |
| Media proxy — SSRF       | 8     | Lookalike hosts, embedded credentials, non-HTTPS schemes, ports on trusted hosts, whitespace smuggling, loopback and private addresses, cloud metadata                                                                                                                                                                                                                                                                |
| Media proxy — registry   | 8     | Only validated URLs register; ids reveal nothing; stable re-registration; account switch invalidates every id; a generation bump beats a surviving map entry; bounded size                                                                                                                                                                                                                                            |
| Media proxy — end to end | 15    | Loopback-only bind on a random port; fresh secret per launch; 200/206/304/416 passthrough; `Content-Range` and `Content-Length` preserved; two offsets return two slices; `Set-Cookie` and `server` stripped; HEAD has no body; POST/PUT/DELETE/PATCH rejected; wrong secret and unknown id refused; no route but `/media`; CORS answers only the app origin; body arrives in multiple chunks; shutdown stops service |
| Unfollow                 | 15    | Off on a fresh install; only the exact string `"true"` enables it; the preference is durable; a permit cannot be built while off; all 15 other writes stay blocked; the read path still refuses `unfollow`; no control by default; confirmation names the exact account; cancel does nothing; success removes the row; failure keeps it and does not retry; no bulk unfollow                                          |
| Video rendering          | 3     | An empty source blames the local service, not the post; a real but undecodable source still says "preview only"; a proxied URL renders a `<video>` with bounded `metadata`/active playback preload, no autoplay attribute, and no CDN host anywhere in the DOM                                                                                                                                                                                        |
| Navigation               | 1     | No Home entry, and the feed comes before Search                                                                                                                                                                                                                                                                                                                                                                       |

---

## Historical Rust test breakdown (61 tests in the earlier report)

Covering the areas the project plan requires:

- **Security (10)** — read-only allowlist; all 14 write operations blocked;
  unknown/injected operations rejected; case-insensitivity; redaction of
  `auth_token`, `ct0`, `Cookie`, `Authorization: Bearer`, env assignments;
  ordinary text untouched; near-miss identifiers not redacted; non-ASCII input
  does not panic.
- **twitter-cli provider (17)** — valid structured output; reposts; promoted
  posts; quoted posts; images; video variants; missing optional fields; empty
  output vs empty array; invalid JSON; `ok:false` never treated as success;
  unrecognised envelope reported as `schema_changed`; leading log noise;
  classification of `not_authenticated` and rate limiting; write operations
  refused before spawning; missing tool; classic timestamp normalisation;
  nested `data` envelope.
- **Mock provider (11)** — count, determinism, cursor pagination without
  repeats, fixture covers every shape (repost/promoted/quote/article/image/
  video/GIF/multi-image/RTL), self-contained media, honest video metadata,
  search filtering, thread structure, lists/profiles, never claims auth.
- **Database (13)** — migrations and idempotency; save/load; **deduplication on
  post ID**; read-state round trip; hidden posts filtered but not deleted;
  promoted/repost filters; muted words; saved/pinned; group membership; stats;
  health messages sanitised before storage; local search.
- **Agent Reach (4)** — doctor report parsing; message sanitisation; missing
  binary; cache reuse.
- **Integration (4)** — mock provider → database round trip with filters and
  read state; second page merges without duplicates; seeding populates groups
  and pins; seeding is idempotent.

## Historical TypeScript test breakdown (53 tests in the earlier report)

- **PostCard (17)** — author/handle/body; LTR and RTL direction; repost
  attribution; promoted label; quoted card; multi-image; lazy loading; honest
  video state; article header; read/unread; read toggle; local save;
  **assertion that no like/repost/reply/follow control is ever rendered**;
  metric hiding; absolute timestamps; avatar top-alignment; lightbox opening.
- **PostText (9)** — tokenising URLs/mentions/hashtags; exact round-trip; no
  entities; collapse/expand without losing text; `collapsible=false`; link and
  profile handlers; RTL and LTR paragraphs.
- **FeedList (8)** — one card per post; loading skeleton; empty state; **new
  posts held behind a pill rather than inserted above the reader**; singular
  wording; pill hidden when nothing pending; per-post read state; paging
  indicator.
- **FilterBar (5)** — toggle on/off; non-destructive wording; advanced panel and
  reset; engagement threshold.
- **utils (14)** — compact numbers; relative/absolute time; RTL detection;
  byte formatting.

## Defects found and fixed during verification

Four real defects were found by running and looking at the built application —
not by reading the code:

1. **`Bearer` token leak in the sanitiser.** `Authorization:` was redacted
   before `Bearer`, so the `authorization` rule consumed the word "Bearer" and
   left the actual token in the output. Caught by a unit test.
   Fixed by redacting `Bearer <token>` first; ordering is now covered by a test.

2. **Every mock image was broken.** Gradient references were written as `!g` and
   string-replaced back to `#g` _after_ percent-encoding, injecting a raw `#`
   into the `data:` URI and truncating it at the fragment marker. Avatars and
   post media rendered as broken-image glyphs.
   Fixed by encoding `#` properly; a regression test now asserts no data URI
   contains a raw `#`.

3. **Home dashboard stuck on "Checking…".** `get_provider_status` ran a full
   `agent-reach doctor`, which probes many channels over the network, so the
   provider card never resolved and reported twitter-cli as "not found" despite
   it being installed. Fixed by reading only cached health on that path; the
   full check now runs explicitly from Diagnostics.

4. **Avatar floated in the middle of post cards.** As a flex child the avatar
   button stretched to full card height, and Chromium vertically centres a
   button's content. Fixed with `self-start`; covered by a test.

Additionally, multi-image grids were unbounded in height on a 4K window (fixed
with a fixed 380 px media frame), and the Groups and Lists pages rendered an
empty body until something was selected (both now auto-select the first entry).

## Visual verification

The release build was launched and every page photographed at native 4K
(2404×1604 window). Screenshots are in [`screenshots/`](screenshots/).

Method: each page was opened by launching the app with `FFN_PAGE=<route>`, and
only the application window's own rectangle was captured. **No synthetic
keyboard or mouse input was used.** The capture script verifies that the app is
the foreground window immediately before copying pixels and refuses to save an
image otherwise — an earlier run correctly refused rather than saving a
screenshot of a different window.

| Page              | Verified                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Home              | Account summary, provider status, six counters, pinned accounts, groups, recently saved, reading activity, last sync, quick actions |
| Following         | Filter chips, post cards, media, engagement, read dots, actions, cached badge                                                       |
| Focus Feed        | Stricter rule set applied                                                                                                           |
| Search            | Query box, live/local scope switch, informative empty state                                                                         |
| Pinned Accounts   | Account cards with unpin, posts from those accounts                                                                                 |
| Groups            | Group chips, member editor (12 accounts), group posts                                                                               |
| Lists             | List cards with member counts, selected list timeline                                                                               |
| Bookmarks         | Bookmark timeline                                                                                                                   |
| Local Library     | Search, empty state with guidance                                                                                                   |
| Following Manager | 12 accounts, repost rule, add-to-group, mute, pin, read-only notice                                                                 |
| Diagnostics       | Provider path, storage, **credential presence only**, parsed Agent Reach channel table, sanitised report                            |
| Settings          | Appearance, post display, reading, video, muted words, sync, language, privacy, about                                               |

Confirmed in the running application:

- Avatars and post media render (SVG data URIs resolve).
- Provider status resolves immediately and correctly reports
  **twitter-cli 0.8.6** (pinned to `7c634e0d`) and **Agent Reach v1.5.0**.
- `agent-reach doctor --json` genuinely ran and was parsed into the channel
  table (bilibili `ok`, github `warn`, X `warn` = installed but not
  authenticated).
- Credentials panel shows `not set` for all four variables — never a value.
- Arabic account names and Arabic post bodies render right-to-left.
- No like / repost / reply / follow control exists anywhere.

## Not verified

- **Live X data.** No burner session was supplied, so every screenshot is the
  `MockXProvider`. `TwitterCliProvider` is unit-tested against fixture JSON but
  has never parsed a real X response; its field mapping is an informed guess at
  twitter-cli's schema and should be expected to need correction on first live
  run.
- **Video playback.** Mock fixtures have a poster but no decodable stream, so
  the player shows an explicit "preview only" state by design.
- **Installer on a clean machine.** The MSI and NSIS packages build, but were
  not installed on a fresh Windows image. The app was run from the built
  executable.
- **Performance measurements** (cold start, memory, frame rate) were not
  instrumented.

## Static analysis

- `cargo fmt` — clean.
- `cargo clippy` — no errors; style warnings remain (mostly
  `needless_question_mark` in the command layer).
- `oxlint` — 2 warnings, both `only-export-components` fast-refresh hints.
- `prettier` — applied across `src/`.
