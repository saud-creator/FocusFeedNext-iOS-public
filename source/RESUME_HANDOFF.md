# Resume handoff — Focus Feed Next 0.4.1

Written 2026-07-26. Every fact below was verified against the working tree, the
running application or its session database at the time of writing. Nothing here
is recalled from memory.

Read with `PROJECT_STATUS.md` (what works and how each claim was established),
`ARCHITECTURE.md`, `SECURITY.md` and `PRIVACY.md`.

---

## 1. Where the work stands

|              |                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Repository   | `C:\Users\Developer\Documents\FocusFeedNext`                                                                                          |
| Branch       | `master` (no remote; nothing has been pushed anywhere)                                                                                  |
| Working tree | clean                                                                                                                                   |
| Version      | **0.4.1** in `Cargo.toml`, `tauri.conf.json` and `package.json`                                                                         |
| Tests        | 362 Rust + 548 TypeScript = **910**                                                                                                     |
| Installed    | `%LOCALAPPDATA%\Focus Feed Next\focus-feed-next.exe`, byte-identical to the build except Tauri's 3-byte `__TAURI_BUNDLE_TYPE_VAR` stamp |

### The most recent stretch

```
3c81836  Stop telling the reader to put their session in an environment variable
77ca24a  Release 0.4.1, and say what is actually known about each feature
6a2aa94  Measure the scroll work instead of asserting it improved
e2b822a  Name a video quality by its shorter side, not its height
e5d905f  Catch the lockfile up to the version bump
67a9df8  Integrate the fullscreen player wiring and its tests
5e9a86d  Integrate the agent's Search wiring and its outside-in tests
03ae029  Make the twitter-cli media patch reproducible
```

**Why 0.4.1 and not 0.4.0.** A 0.4.0 installer already exists in
`src-tauri/target/release/bundle/`, built from source that predates the quality
label fix, the scroll measurement and three merged agent commits. Reusing the
number would have made two different products indistinguishable.

### What to be careful of next time

- **`Set-Content -Encoding utf8` writes a BOM on Windows PowerShell 5.1**, and
  `Get-Content -Raw` reads UTF-8 as ANSI. Bumping the version that way put a BOM
  on `tauri.conf.json` (which then failed to parse) and turned every em-dash in
  `Cargo.toml` into mojibake. Use the editing tools, not shell rewrites, on any
  file with non-ASCII in it.
- **The preview/dev-server tooling is rooted at the WPF repository**, not this
  one. Starting a dev server through it would write into the repository that must
  stay untouched. Start Vite directly and attach by URL instead.

```
47b292d            Integrate feed pagination, and bind the continuation command
dde0ad3            Integrate account actions, and register what the agent could not
3ade5b8            Integrate the media UX work
0ffbde4            Integrate the startup lifecycle, and allowlist its preference
8f6a081            Correct the read-only claims now that Follow and Unfollow exist
b3cffbf            Report backend capabilities in Diagnostics
dc4539c            Make promoted exclusion unconditional and unify the startup probe
b5b1167            Add the shared strings and stage vocabulary for the sprint
690cad0            Add the top-bar connection area and real latency
685d7cb            Wire optional Unfollow, open on the feed, and document
346855b            Adopt twitter-cli 0.8.6 and route video through a loopback proxy
f0f5a54            Phase 2.1: find the root causes behind the live-data defects
d666a34            Record the runtime verification results in the handoff
959ceef            Quiet the credential-store logging, verify the release build
2886a45            Add the X connection screen, session health, active account
29259a6            Make fetched content session-only
3cec2fd            Secure X credential backend and real twitter-cli schema parser
c3f5deb            Focus Feed Next 0.1.0
```

The old WPF project at `C:\Users\Developer\Documents\FocusFeed` is a separate
repository and **has not been touched**: `8931398` on `v2-custom-reader`, clean
tree, verified at the time of writing.

## 2. Verification status

| Check                        | Result                                 |
| ---------------------------- | -------------------------------------- |
| `cargo fmt --check`          | clean                                  |
| `cargo clippy --all-targets` | 0 warnings, 0 errors                   |
| `cargo test`                 | **362 passed**                         |
| `npx tsc -b`                 | exit 0                                 |
| `npx vitest run`             | **548 passed** (30 files)              |
| `npx oxlint`                 | 0 errors                               |
| `npm run tauri build`        | EXE + MSI + NSIS produced at `3c81836` |

**910 automated tests.** No test touches the network — the proxy tests run
against a fixture upstream served over a real socket.

### Verified in the running release binary, not only in tests

- **Exactly one `twitter.exe`** for the startup probe; **two** thereafter, which
  is the Following and Bookmark preload workers holding independent slots by
  design, not a duplicate.
- Media proxy bound to `127.0.0.1` on a random port, one listening socket, no
  secret in the log.
- The top bar renders `[● state] [Test Connection] [Refresh]` on every page.
- "Promoted posts blocked" renders as a badge and is absent from the
  interactive accessibility tree.
- On exit: 0 app processes, 0 `twitter.exe`, 0 Python workers, 0 session
  directories, the proxy port released, and the log records the bytes freed.

### Verified by reading the session database, not the interface

Screen control was unavailable in the 0.4.1 session, so the live checks were
made against the application's own log, its SQLite session database, process
sampling and socket state. Counts and ordering only; no handle, post text or
media URL was printed. Full results in `PROJECT_STATUS.md`. The headline
figures: **190** followed accounts with no gaps, **200** bookmarks with the
cursor exhausted, **59** portrait video renditions all correctly named by their
shorter side, **0** signed URLs anywhere in stored media.

### Still unproven

- **Follow and Unfollow against a real account.** Every layer is tested against
  a mocked provider; confirming them needs a real mutation the reader must
  authorise for a named account. Not requested, so not done.
- **OLED and the appearance editor on screen.** They render in tests. Nobody has
  confirmed the near-black surfaces are distinguishable from each other.
- **One account lost in a 0.4.0 session.** See `PROJECT_STATUS.md`; recorded as
  an open question rather than explained away.

## 2a. The parallel sprint, and what it taught

Four agents worked in worktrees (`startup-lifecycle`, `media-ux`,
`account-identity`, `feed-pagination`). All four were interrupted before
committing; their work was recovered from the worktrees, verified, and
committed before integration. `feed-pagination` did not compile — a test call
site had not been updated when `build_response` gained its cursor parameter —
and was finished rather than discarded.

**Three shared changes had to be applied centrally**, because agents cannot
touch shared files, and each would have been a silent failure:

1. `monitoring.autoCheck` was written by the frontend but missing from
   `DURABLE_PREFERENCES`, so the backend rejected it and the toggle forgot
   itself on restart.
2. `follow_account` was defined but never registered — it would have failed at
   the IPC boundary.
3. `load_feed_page` likewise, plus it had no API binding at all.

**The lesson worth keeping:** a passing suite proved none of these. All three
were found by grepping declared commands against registered ones, and the two
biggest defects of the whole sprint were found by _rendering the interface_:
"No promoted" was an interactive toggle with an off position that the Rust
filter honoured, and the startup probe ran twice because `lib.rs` called the
provider directly instead of going through the single-flight flag. Read the
running app, not just the tests.

## 2b. Connection health, top bar

`PageHeader` now renders `ConnectionControls` on every page: status chip, Test
Connection, then the page's own actions. The chip pairs a dot with the state as
text and the last measured latency; `aria-label` carries all three.

**Latency** times the real `status` health request end to end — before the
provider call until the structured result is parsed. `<1000 ms` renders as
`842 ms`, otherwise `2.7 s`. `SessionSnapshot.latency_ms` is `None` until
something completes; a failure never overwrites the last good figure with the
time it took to fail, and an auth failure or a credential clear drops it along
with the identity.

**Single-flight lives in Rust**, not React: `AppState::health_in_flight` is a
`compare_exchange` flag, so Strict Mode double-mounts, resume events, route
changes and repeated clicks cannot start two `twitter.exe` processes. The
second caller gets the current snapshot back. `check_session(force)` is the
only health path and runs the narrowest operation there is — `status`, plus
`whoami` the first time only. It never touches a feed, bookmarks, followed
accounts, or `agent-reach doctor`.

Refresh was already per-page and already disabled itself while its own request
was in flight; that behaviour is unchanged.

**A caution for whoever edits `session.rs` next:** do not round-trip a Rust
source file through PowerShell `Get-Content -Raw` + `Set-Content`. It decodes as
ANSI and re-encodes as UTF-8, turning every em dash into mojibake across the
whole file. That happened once here and was reverted; use the editing tools.

## 2c. The correction sprint — foundation

`SPRINT_STATUS.md` is the live tracker; this section records only what a
resuming session must not re-derive.

The foundation landed centrally before any agent started, because it is
everything four parallel workers would otherwise collide on:

- **A full preference schema** in `useAppStore.ts`, with saved values separated
  from a `draft`. Nothing reaches the backend until Save. Every key is
  allowlisted in `durable.rs`, so it genuinely survives a restart.
- **Navigation history** — `navigate`, `openProfile`, `goBack`, per-route
  scroll memory — so a profile opened from Search returns to the same query and
  offset. `lists` and `pinned` survive as ids but resolve away; deleting the
  ids would turn a stored preference into a crash.
- **`ipc_contract.rs`**, described in `SPRINT_STATUS.md`. Read that before
  adding a command or a preference.

**The whole first agent wave died on the session usage limit before writing a
file.** All four worktrees were verified clean at the foundation commit, with
no untracked files, and nothing was lost. The lesson recorded for the next
wave: agents must commit their first coherent slice early rather than holding
hundreds of uncommitted lines, and the main agent must poll worktrees rather
than wait for completion messages.

## 2d. The correction sprint — outcome

Version is **0.3.0**, deliberately distinguishable from the 0.2.0 binaries that
were installed while this work was in progress. Installed build lives at
`%LOCALAPPDATA%\Focus Feed Nextocus-feed-next.exe`.

Two agent waves. The first died on the usage limit before writing a file; the
second produced ten commits across four branches plus uncommitted work, all of
which was salvaged, tested and committed before integration. `SPRINT_STATUS.md`
has the per-requirement state — read that rather than assuming.

**The recurring failure mode, now with a countermeasure for each instance.**
Three times a feature was complete in code, green in tests, and absent from the
product:

| What                                       | How it was found       | What now catches it          |
| ------------------------------------------ | ---------------------- | ---------------------------- |
| `get_user_profile` registered, never bound | by hand                | `ipc_contract` binding check |
| two group commands never registered        | `ipc_contract`         | already caught               |
| Settings never rewired to its own sections | opening the page       | nothing — still only looking |
| 28 message keys in neither catalog         | the key-existence test | that test                    |

The last row is the one to keep in mind: there is still no automated way to
notice that a finished component is not rendered anywhere. Open the pages.

**Known not done**, and not to be reported otherwise: fullscreen video UI,
search account suggestions, the twitter-cli media-variant patch and therefore
real quality selection. Scroll performance was changed but **not measured** —
no before/after numbers exist, so do not quote any.

**Mute and block are unsupported**, not unimplemented: twitter-cli 0.8.6 has no
such subcommand, and `ProviderCapabilities` reports `false` rather than
offering a control that would always fail.

## 3. twitter-cli is pinned to 0.8.6

```bash
pipx install --force "git+https://github.com/public-clis/twitter-cli.git@7c634e0d396b1e7af9f63315b414925fe4f29ae7"
```

**pipx, not uv.** The existing install was pipx-managed, so the replacement used
the same mechanism and landed on the same shim — there is exactly one
`twitter.exe` at `~\.local\bin\`, not two. `locate_binary` resolves
`FFN_TWITTER_CLI` → `PATH` → `~/.local/bin`.

The pin is a commit, not a branch, and `PINNED_COMMIT` in
`providers/twitter_cli.rs` records it.

### What 0.8.6 actually changed — do not re-derive

Read off real responses with `cargo run --example probe_live -- shape <op>`,
which prints key paths and value types and never a value.

1. **`pagination.nextCursor` is a sibling of `data`**, not a field inside it.
   Reading it from the wrong level silently disables Load More.
2. **`--cursor` exists on `feed` and `list` only.** `following`, `user-posts`,
   `search` and `bookmarks` take `--max` alone and emit no `pagination` key.
   The parser reports whatever the envelope carried, so capability is detected
   rather than asserted from a table.
3. **`isPromoted` is real now.** 0.8.5 had none and it was hardcoded `false`.
   Feeds are also fetched `--no-include-promoted`.
4. **`isSubscriberOnly` and `urls[]` are new** and currently unused.
5. **Search has no People tab.** `-t` accepts `top|latest|photos|videos` and
   nothing else. Do not build a People tab against this backend.
6. **The user-profile field moves upstream (core/avatar/location) are internal
   to the CLI.** Its JSON contract is unchanged, so `map_author` needed no
   edit. The obvious assumption was the opposite.

### Still true from 0.8.5

`text` not `full_text`; `author` not `user`; always pass `--json`; never pass
`-c/--compact`; branch on `ok`, never on the presence of `data`; no permalink
field, so derive `x.com/{handle}/status/{id}`; reposts describe the **original**
post with the reposter as a bare handle in `retweetedBy`; `PYTHONIOENCODING=utf-8`
is mandatory or the tool dies on emoji and Arabic; `following`/`followers` take
a positional handle; a single command can block ~35s through internal retries.

Two UI facts worth keeping: never call `agent-reach doctor` on a hot path, and
`security::sanitize` must redact `Bearer` **before** the key/value pass.

## 4. Live verification performed

Against the real authenticated session, on the release build:

- **Keyword search works.** `"rust"` → 5 real posts in 4.0s. Broken upstream in
  0.8.5, fixed in 0.8.6.
- **Feed cursor continuation is real.** Page 2 returned 10 posts, all 10 new,
  cursor advanced.
- **`following` is healthy.** 30 accounts in 2.34s, all enriched.
- **The media proxy serves real X video.** Three live videos of 3 MB, 21 MB and
  57 MB: status 206, `video/mp4`, correct `Content-Range`, `Accept-Ranges:
bytes`, CORS scoped to `http://tauri.localhost`, no `Set-Cookie` forwarded,
  exactly 65536 bytes returned from the 57 MB file.
- **The running release binary** bound `127.0.0.1:57291` and **nothing else**
  (checked with `Get-NetTCPConnection`), logged the bind without the secret,
  and on close logged `media proxy stopped` then `session storage cleared`. The
  port was released and the process fully terminated.

### The one thing not verified

**Video has not been watched playing inside the WebView2 window.** The
transport is proven at the Rust boundary with exactly the headers WebView2
needs, but confirming the element actually decodes it needs the running UI, and
the app is not installed in the Start menu so screenshot tooling could not
resolve it. Install the MSI, or launch
`src-tauri\target\release\focus-feed-next.exe` and look.

If it still fails, the evidence to gather is in that order: the browser request
to loopback (does it arrive?), the CSP report, the request `Origin`, the `Range`
header, and the response status. Do **not** go back to bitrate experiments —
that path is closed and documented below.

## 5. Root causes, settled

**Video — solved at the transport layer.** The bytes were never the problem: a
Range request from Rust has always returned 206 / `video/mp4` / H.264. The
_origin_ was — a request from `tauri.localhost` is cross-site and the CDN does
not serve it. **No authentication is involved anywhere**; the
authenticated-bridge hypothesis is disproved and must not be revisited.

**Search — was broken upstream.** twitter-cli derives `not_found` purely from
HTTP 404 (`exceptions.py:74`), and for `SearchTimeline` a 404 meant X had
rejected the GraphQL query id. Fixed in 0.8.6 by switching SearchTimeline to
POST with updated query ids.

**Open original — capability, not code.** `capabilities/default.json` granted
only `core:default`, so every `open_url` was denied, and `openLink` swallowed
the rejection in an empty `catch`. Both fixed.

**People You Follow — measured.** 30 → 2.06s, 60 → 5.20s, 191 → 36.34s. Linear
at ~90ms/account because twitter-cli pages internally at ~20–25 sequentially and
returns nothing until done. **No N+1** (accounts arrive enriched) and **no
redundant `status`/`whoami`**. First page is 30, so content lands in ~2s.

## 6. What is left

**Phase 2.1 remainder — genuinely not done:**

- **Search suggestions while typing.** Local matching over loaded accounts and
  post authors, 300ms debounce, stale-response protection. The classifier and
  the backend are ready; the UI still searches on submit only. Note there is no
  People search endpoint, so remote suggestions can only be an exact `user`
  lookup.
- **Staged loading feedback** on People you follow: stage name, elapsed
  seconds, the "X is taking longer than usual" message after 5s, Load Full List
  and cancellation. Currently a skeleton and then the list.
- **Load More in the feed.** The backend returns a real cursor and
  `supportsPagination` is now true, but no UI consumes it yet. Dedupe by post
  id and stop on a repeated cursor when wiring it.
- **Focus Feed** filters: "No promoted" should become a non-interactive
  always-on badge.
- **List virtualization** for long account lists.

**Already done, contrary to the earlier handoff:** Following Manager and People
You Follow were never two pages — the `accounts` route has always rendered
`FollowingManagerPage`. It is now titled "People you follow" and is the single
canonical page.

**Phase 3 — localization.** Catalogs are complete (~660 keys each, key sets
proven identical by test). Navigation, the connection card, session states and
the video player are converted. **Still hardcoded English:** `Diagnostics.tsx`,
`Settings.tsx` below the connection card, `Search.tsx`, `Groups.tsx`,
`Library.tsx`, `Lists.tsx`, `Pinned.tsx`, `FollowingManager.tsx` (including the
new Unfollow dialog), `FeedScreen.tsx`, `FilterBar.tsx`, `PostCard.tsx`.
`src/i18n/contentDirection.ts` is written and tested but not applied to
`PostText`/`QuotedPostCard`.

**Phase 4** live pages · **Phase 5** lifecycle, performance, updater ·
**Phase 6** release.

## 7. Things that would be easy to get wrong

- `Home.tsx` still exists but **nothing routes to it**. `resolveRoute` sends
  `home` to `following`, and the sidebar has no Home entry. Delete the file
  only after checking nothing imports it.
- `AppState::proxy_media` is applied at **every** command that returns posts.
  A new post-returning command must call it, or that path will hand the webview
  a CDN URL that cannot play.
- The database keeps the **original** CDN URL; only the outbound copy is
  rewritten. That is deliberate, so a retry can re-register.
- `media_proxy.rs` has a `#[cfg(test)]` upstream override so the streaming path
  can be tested against a fixture server. It does not exist in a release build.
- Adding a preference key to `DURABLE_PREFERENCES` is the _only_ way to make
  something survive a restart. That is the point.
- The persistence tree scan matches on literal words. A comment mentioning a
  browser storage API will fail the build — reword rather than disable it.

## 8. Working agreement

- Phases are strict: verify, then commit a clean checkpoint, then move on.
- Never weaken a test to make it pass.
- Never leave the tree with unverified or half-written source files.
- Do not run a real Unfollow during verification without explicit approval of
  the exact account.
