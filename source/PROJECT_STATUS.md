# Project Status

> Historical 0.4.1 verification record. It is intentionally retained for
> provenance, but it is not the 0.5.7 capability list: Search and Local Library
> described below were removed. See README.md and TEST_REPORT.md for the current
> release surface and verification.

**Focus Feed Next** — a standalone, focus-oriented desktop reader for X.

- Version: **0.4.1**
- Last updated: **2026-07-26**
- Tests: **362 Rust + 548 TypeScript = 910**
- Provider: `twitter-cli` **0.8.6**, pinned to upstream
  `7c634e0d396b1e7af9f63315b414925fe4f29ae7`, with the project's media-variant
  patch (`ea421b97…09993`) applied.

The old WPF project at `Documents/FocusFeed` is **untouched** at `8931398`.
This is a separate repository sharing no code with it.

## v0.5.7 current resource and session hardening

The current tree moves the Windows fetched-content database to
`Db::in_memory()`. A portable run keeps only allowlisted preferences, account
identity and account-scoped local List definitions in
`.focusfeed-next\preferences.db`; its per-run directory contains the cleanup
lock and private WebView2 profile. The desktop window is created with an
explicit per-run WebView2 data directory and private/incognito mode, and it
fails closed instead of selecting WebView2's default AppData profile.

The media proxy now carries post images, posters, videos and GIFs through the
same loopback transport with no-store headers, a 128 MiB response ceiling, four
concurrent upstream transfers and a 90-second timeout. React keeps a bounded
lazy-media runway and one active video decoder. Bookmarks retain exhaustive
provider traversal but the UI reads bounded older/newer keyset slices, so a
large account is accessible without materializing its entire order in one IPC
or React Query value.

The source verification for this release is recorded in `TEST_REPORT.md`.
Live X reads and real account mutations remain separate gates: this Windows
profile currently has no Credential Manager `auth_token`/`ct0` pair, so the
provider and Unfollow/Unbookmark paths have not been exercised against a real
account here.

## v0.5.6 bookmark-cap update (historical)

The v0.5.6 source and portable release did not impose a 30, 100, 200 or
400-bookmark application limit. The native preload requests the exhaustive
bookmark read, the pinned provider patch follows the endpoint's terminal
cursor, and the React/database cache path hydrates every row available in the
current session. The older 200-bookmark measurements in this document remain
historical live-session evidence and are not a v0.5.6 account total.

## v0.5.6 iPhone target (source history)

The current tree now has a functional iPhone source target built from the same
React and Rust application rather than a separate mock or browser wrapper.

| Area | State | Evidence |
| --- | --- | --- |
| Shared iPhone UI | **implemented + visually checked** | iPhone shell, safe-area layout, bottom tabs, More sheet, responsive settings and pairing screens; checked at 390×844 portrait and 844×390 landscape with no horizontal overflow |
| Shared application logic | **implemented + tested on Windows host** | same models, SQLite layer, filters, local Lists, read state, media registry, Arabic catalog and preference system |
| Live provider | **implemented + protocol-tested** | `RemoteProvider` uses the authenticated, read-only `CompanionHost` in the Windows app; an end-to-end Rust test pairs and fetches through a real loopback socket |
| X credentials | **kept on Windows** | the phone receives only a random companion bearer token and private address, stored through the iOS Keychain backend |
| iOS metadata and icon | **implemented + structurally verified** | iOS 16 config, local-network purpose string, App Transport Security local-network allowance, export-compliance key and opaque 1024×1024 icon |
| Signed IPA | **awaiting Apple-controlled build** | the checked-in macOS GitHub Actions workflow generates, signs, validates and retains the IPA; it needs an Apple Developer team, App Store Connect app/key and repository secrets |
| Physical iPhone/TestFlight | **not yet evidenced** | requires the signed workflow run, TestFlight processing and the user's device |

The current local-network transport is authenticated but uses plain HTTP. It is
limited to trusted private Wi-Fi for this TestFlight phase; transport encryption
is a production-hardening gate. See `IPHONE_BUILD.md`, `SECURITY.md` §7, and
`PRIVACY.md`.

---

## How to read this document

Every claim below carries how it was established. The distinction matters,
because the recurring failure in this project has been a component that was
complete, tested, and _not in the product_ — six separate times.

| Mark         | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| **live**     | observed in the running application against the real account       |
| **measured** | a number was taken, and it is recorded here or in `perf/README.md` |
| **test**     | covered by automated tests; not yet seen running                   |
| **await**    | correct as far as it can be shown without a real account mutation  |
| **blocked**  | not possible on this provider; documented, no dead UI left behind  |

---

## The product

Eight reachable pages. There is no Home dashboard, no Lists page, no Pinned
Accounts page and no Following Manager — the first was noise, and the other
three were workflows with no working destination on this backend.

| Page                  | What it is                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------- |
| **Following**         | The chronological timeline. Windowed list, filter bar, new-post pill, Load More.            |
| **Focus Feed**        | The same feed under a stricter rule set: no reposts, unread only, engagement floor.         |
| **Search**            | Live X search with account suggestions, Accounts and Posts sections, scope switch, history. |
| **Bookmarks**         | The X bookmark timeline, in X's own order.                                                  |
| **Lists**             | Reader-defined lists of followed accounts, each with a real merged timeline.                |
| **People you follow** | The complete Following list, loaded progressively.                                          |
| **Profile**           | An internal profile for any account, with its posts.                                        |
| **Diagnostics**       | Provider version, upstream pin, patch hash, capabilities, storage, session state.           |
| **Settings**          | Draft/Save/Cancel over the whole preference schema.                                         |

---

## Where each requirement stands

| #   | Requirement                                    | State        | Evidence                                                                                                                                         |
| --- | ---------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Avatars, names, handles open internal profiles | test         | one `AccountIdentity` used by every surface; `get_user_profile` bound                                                                            |
| 2   | Follow / Unfollow reachable                    | await        | reachable from profile, People you follow, search rows, author menus; proving it needs a real mutation                                           |
| 3   | People You Follow beyond 30                    | **live**     | **190 accounts**, positions 0–189 with no gaps, `following.syncComplete = 1`                                                                     |
| 4   | List candidates from Following only            | live+test    | picker reads `groupCandidates`, which reads `following_accounts` and nothing else                                                                |
| 5   | Group editor never stuck                       | live+test    | reading and editing are separate modes; 14 tests                                                                                                 |
| 6   | List feed is a real timeline                   | test         | `refresh_group_feed` walks members by offset; stable round-robin                                                                                  |
| 7   | Bookmarks keep X's order                       | **live**     | **200 bookmarks**; only 15/200 positions coincide with publication order, and 56 adjacent pairs put an older tweet above a newer one — see below |
| 8   | X bookmark separate from Local Library         | test         | distinct commands, state and labels at every layer                                                                                               |
| 9   | Bookmarks and Following preload at startup     | **live**     | `startup preload: following=true bookmarks=true`; both lists fully populated                                                                     |
| 10  | Long feeds scroll smoothly both ways           | **measured** | 500 posts: 500 → 11 cards, 25,818 → 595 DOM nodes, upward p95 12.0 → 6.1 ms. `perf/README.md`                                                    |
| 11  | Mark as read does not darken                   | test         | replaced with a mark                                                                                                                             |
| 12  | Settings save and survive restart              | live         | draft/Save/Cancel/Reset; every key allowlisted in Rust                                                                                           |
| 13  | Images keep aspect ratio                       | test         |                                                                                                                                                  |
| 14  | Lightbox opens in the viewport                 | test         | portal to `document.body`, fixed inset                                                                                                           |
| 15  | Fullscreen video interface                     | test         | `VideoPlayer` imports and uses the fullscreen layout; 70 tests                                                                                   |
| 16  | Video loops, click toggles                     | test         |                                                                                                                                                  |
| 17  | Page-open Off / Refresh / Reset                | live         | global setting plus per-route overrides                                                                                                          |
| 18  | Replies off by default                         | live         | setting present, default off                                                                                                                     |
| 19  | Lists removed                                  | live         | absent from navigation; route id retained so a stored value resolves                                                                             |
| 20  | Pin / Quiet View removed                       | live         | same                                                                                                                                             |
| 21  | OLED theme and appearance editor               | test         | appearance editor renders; OLED not visually confirmed                                                                                           |
| 22  | Search account suggestions                     | test         | wired into `Search.tsx`; 102 tests                                                                                                               |
| 23  | Profile shell before posts                     | test         |                                                                                                                                                  |
| 24  | Promoted blocked, badge inert                  | **live**     | **20 ads in a 45-post page**, all filtered; see below                                                                                            |
| 25  | Real video-quality variants                    | **live**     | **96 media items carrying genuine ladders**, up to 5 renditions each                                                                             |
| 26  | Mute / Unmute / Block / Unblock                | blocked      | twitter-cli 0.8.6 has no such subcommand; capability reported `false`, no button rendered                                                        |
| 27  | Progressive JSONL streaming                    | not needed   | traversal completes without it; not built rather than built and unused                                                                           |

---

## What the live session actually contained

Read out of the running 0.4.0 build's session database, 2026-07-26. Counts and
ordering only — no handle, post text or media URL was printed.

- **190** followed accounts, positions 0–189 with no gaps, one traversal id,
  `following.syncComplete = 1`. This is the 0.4.1 reading and it is the correct
  one.

  The 0.4.0 session read **189**, with position 30 vacant and rows carrying two
  different traversal ids — a completed startup traversal, and a later partial
  one that rewrote the first thirty positions and never finished. Exactly one
  account was lost between them. **This is an open question, not a resolved
  one.** `merge_following_accounts` only prunes on a traversal that reports
  itself complete, so a partial batch should be incapable of removing anybody;
  the observed table says otherwise. It has not reproduced in a clean single
  traversal, and the conditions that produced it — a second sync starting while
  the reader had the page open — were not reconstructed. Recorded here rather
  than explained away.

- **200** bookmarks, `seq` 0–199, no duplicates, and the bookmarks cursor is
  **null** — a genuine end of traversal, not a cap.
- **Bookmark ordering is real.** Only 15 of 200 positions coincide with
  publication order. The clearest single case: the post at bookmark position 4
  is the **105th newest** of the 200. Sorting by publication time would have
  buried it, which is exactly the complaint that started this work.
- **228** media items, **96** with genuine variant ladders (1–5 renditions).
- **20** promoted posts arrived in a 45-post following page — a page requested
  with `--no-include-promoted`. They are stored and unconditionally filtered on
  read, so the reader saw 25 posts. The very next session received **zero**, so
  the rate is X's choice on the day and not a constant; what matters is that a
  page can be 44% advertising and none of it is reachable. See below.
- Every stored media URL is unsigned: the only query parameter present anywhere
  is X's `tag` cache-buster, and image URLs carry no query at all.

---

## Two things live data corrected

**Promoted content.** The code claimed in three places that ads were excluded at
source and that the local filter was a second line of defence. Live data says
the opposite: 44% of a following page was advertising despite the flag. The
filter in `database::passes` is the one that works, and the comments now say so.
Nothing reaching the reader was ever affected — the filter was always
unconditional — but the documentation was wrong about why.

**Video quality labels.** 72 of 329 stored renditions are portrait, and every
one was named by its height. An ordinary 1080×1920 phone clip offered the reader
_"1920p / 1280p / 852p / 568p"_. Labels now come from the shorter side, which is
identical for landscape and correct for the vertical video that is most of what
X serves.

Confirmed in the installed 0.4.1 against freshly fetched media: 59 portrait
renditions, every one named by its shorter side — 1080×1920 → **1080p**,
720×1280 → **720p**, 480×852 → **480p**, 320×568 → **320p**. The inflated
numbers are gone from the data, not only from the tests.

---

## Security and privacy posture

- Credentials (`auth_token`, `ct0`) live only in Windows Credential Manager.
  `XCredentials` has a hand-written `Debug` that prints `<redacted>`, and a test
  asserts `ct0` never appears in a frontend payload.
- Video and GIF URLs are rewritten to opaque loopback proxy URLs before any
  response leaves `build_response`. An untrusted host is cleared rather than
  passed through; a variant that fails validation is dropped rather than
  offered. The CDN URL stays in the session database so a retry can re-register
  it, and that database is deleted on exit.
- The media proxy binds `127.0.0.1` on a random port with a per-process secret
  that is never logged.
- Write operations are gated by a `WritePermit` that carries which operation it
  authorises, so neither Follow nor Unfollow can be reached with the other's
  arguments. No mutation happens unattended.
- Session-only: posts, bookmark content/order, following results, list feeds,
  search, profile posts, cursors, read state, the media registry, scroll state.
  Durable: preferences, theme, the account identity, provider pin metadata, and
  reader-created list definitions isolated by X account. Removing a bookmark
  from X is available only after an explicit confirmation from the Bookmarks
  page; a failed removal leaves the local row visible.

---

## Known limitations

- **Mute, Unmute, Block, Unblock** are not available. twitter-cli 0.8.6 exposes
  no such subcommand, the capability is reported `false`, and no control is
  rendered.
- **Reply threads** are not built. The setting exists and defaults to off; with
  it on there is no Post Details view yet, so no reply request is ever made.
- **Follow and Unfollow are unproven against a real account.** Every layer is
  tested against a mocked provider. Confirming them requires a real mutation on
  a real account, which is the reader's call to authorise and has not been
  requested.
- **Bookmark removal is also awaiting a live-account check.** The pinned
  provider path, confirmation gate, cache eviction and failure retention are
  covered by automated tests; the final evidence requires one deliberate
  `unbookmark` on a real X account.
- **OLED and the appearance editor have not been looked at on screen.** They
  render in tests; nobody has confirmed the near-black surfaces are actually
  distinguishable.
- The scroll measurement uses text-only posts and no backend, so it isolates the
  windowing and understates the rest. `perf/README.md` says so.
