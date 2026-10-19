# Focus Feed Next — Project Handoff

Written 2026-07-24, immediately before conversation compaction. Every fact below
was verified against the working tree and the built artifacts at the time of
writing — nothing here is recalled from memory.

---

## 1. Current stable commit

```
c3f5deb  Focus Feed Next 0.1.0: standalone Tauri desktop reader for X
```

- Repository: `C:\Users\Developer\Documents\FocusFeedNext`
- Branch: `master`
- Tracked files: **104**
- **Working tree: CLEAN** (`git status --short` returned nothing at the moment
  of verification, before this handoff file was added).
- No remote is configured. Nothing has been pushed anywhere.

## 2. Current release

**Focus Feed Next 0.1.0** (`package.json` is still `0.0.0`; the authoritative
version is `src-tauri/Cargo.toml` + `tauri.conf.json`, both `0.1.0`).

Bundle identifier: `com.focusfeed.next`

## 3. Current test status

| Suite                     | Result                                                           |
| ------------------------- | ---------------------------------------------------------------- |
| Rust (`cargo test`)       | **61 passed, 0 failed**                                          |
| TypeScript (`vitest run`) | **53 passed, 0 failed**                                          |
| `tsc -b`                  | clean, exit 0                                                    |
| `cargo fmt`               | clean                                                            |
| `cargo clippy`            | no errors; style warnings only (mostly `needless_question_mark`) |
| `oxlint`                  | 2 warnings (`only-export-components` fast-refresh hints)         |

Total automated tests: **114**.

Commands:

```bash
npm test
```

```bash
cd src-tauri && cargo test
```

## 4. Exact artifact paths

All three verified to exist on disk:

| Artifact       | Path                                                                                                                    | Size     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| **Executable** | `C:\Users\Developer\Documents\FocusFeedNext\src-tauri\target\release\focus-feed-next.exe`                             | 11.54 MB |
| **MSI**        | `C:\Users\Developer\Documents\FocusFeedNext\src-tauri\target\release\bundle\msi\Focus Feed Next_0.1.0_x64_en-US.msi`  | 4.24 MB  |
| **NSIS setup** | `C:\Users\Developer\Documents\FocusFeedNext\src-tauri\target\release\bundle\nsis\Focus Feed Next_0.1.0_x64-setup.exe` | 2.96 MB  |

Rebuild with:

```bash
npm run tauri build
```

Note: `src-tauri/target/` is gitignored, so these artifacts are **not** in the
commit. They must be rebuilt after a fresh clone.

## 5. Architecture and provider boundaries

Three responsibilities, kept strictly separate:

- **Focus Feed Next** owns the UI, local database, filters, read state, local
  search, pinned accounts, groups, local library, media presentation, settings
  and diagnostics.
- **Agent Reach** is used _only_ for installation, health checks, backend
  discovery and repair guidance. It is **never** invoked on the feed path.
- **twitter-cli** is the primary backend for structured X data.

```
React (TypeScript)
  src/pages/          12 pages
  src/components/     PostCard, AuthorHeader, PostText, MediaGallery,
                      VideoPlayer, QuotedPostCard, EngagementSummary,
                      PostActions, ReadStateIndicator, Lightbox, FeedList,
                      FilterBar, Sidebar, PageHeader
  src/hooks/useFeed   cache-first feed engine, held-back new posts, single-flight
  src/lib/api.ts      typed invoke() wrappers — the ONLY backend entry point
        │  Tauri IPC — 38 explicit commands, no arbitrary-command path
Rust (src-tauri/src/)
  commands.rs         38 registered commands
  providers/mod.rs    XDataProvider trait + select_provider() fallback
  providers/mock.rs   MockXProvider      (offline fixture)
  providers/twitter_cli.rs  TwitterCliProvider (live, process-managed)
  agent_reach.rs      AgentReachManager — doctor --json, parsed + cached
  database.rs         SQLite, 14 tables, migrations, corrupt-DB recovery
  security.rs         command allowlist + secret sanitisation
  models.rs           stable internal models
```

**Provider boundary rule:** the frontend never learns which provider answered.
Each provider converts its own raw output into `models.rs` types, so a
twitter-cli schema change is absorbed in `twitter_cli.rs` and never reaches a
React component. If the payload becomes unrecognisable the adapter returns
`schema_changed` rather than silently producing an empty feed. `ok: true` is
never treated as success on its own.

`select_provider(prefer_live)` picks `TwitterCliProvider` when it is installed
**and** authenticated, otherwise falls back to `MockXProvider`.

Data locations:

- Database: `%APPDATA%\FocusFeedNext\focusfeed.db`
- Logs: `%LOCALAPPDATA%\com.focusfeed.next\logs`

## 6. Security and command allowlist

Enforced in `src-tauri/src/security.rs`, applied in `TwitterCliProvider::run_op`
_before_ any process is spawned.

**ALLOWED_OPS (13, read-only):**
`feed`, `search`, `tweet`, `thread`, `article`, `user`, `user-posts`,
`following`, `followers`, `bookmarks`, `list`, `status`, `whoami`

**BLOCKED_OPS (14, hard-blocked):**
`post`, `reply`, `quote`, `delete`, `like`, `unlike`, `retweet`, `unretweet`,
`follow`, `unfollow`, `bookmark`, `unbookmark`, `favorite`, `unfavorite`

Anything not on the allowlist is rejected. Every invocation is built from an
**argument array** — no shell string is ever constructed. Each call has a
timeout, kills the child on expiry, and drains stdout/stderr on separate threads
so a full pipe cannot deadlock.

**Secret handling.** Credentials are read only by twitter-cli itself, from
environment variables; this process never reads their values. `security::sanitize`
scrubs `auth_token`, `ct0`, `Cookie`, `Authorization`, `Bearer <token>`,
`set-cookie`, `x-csrf-token`, `password` and env-style assignments from logs,
stored health records and the copyable diagnostic report. `set_setting` rejects
credential-shaped keys so nothing token-like can reach SQLite. Diagnostics shows
credential **presence only** (`set` / `not set`), never values.

> Ordering matters: `Bearer` must be redacted **before** the key/value pass. The
> other order let the `authorization` rule consume the word "Bearer" and leave
> the real token exposed. This is covered by a test — do not reorder.

`open_external` accepts only `http(s)` URLs, so a malformed post cannot launch a
local file or custom protocol handler.

## 7. Known limitation: no live X session has been verified

**This is the single most important caveat in the project.**

No burner X session has ever been supplied. `TWITTER_AUTH_TOKEN` and
`TWITTER_CT0` were confirmed **not set** at handoff time. Therefore:

- Every screenshot in `screenshots/` shows the **mock provider**, not real data.
- `TwitterCliProvider` is unit-tested against hand-written fixture JSON but has
  **never parsed a real X response**. Its field mapping is an informed guess at
  twitter-cli's actual schema and should be expected to need correction on the
  first live run.
- `twitter-cli` 0.8.5 exposes **no `--cursor` flag** on `feed`, so live cursor
  pagination is unavailable. The app requests a larger page and sets the cursor
  to `None` rather than faking it. Mock pagination works and is tested.
- Browser cookie auto-extract fails on this machine (Windows DPAPI /
  app-bound Chrome cookie encryption), so manual token entry is the reliable
  path — which is exactly what 0.2.0 must build.

Backends installed and working on this machine:

- `twitter-cli 0.8.5` → `C:\Users\Developer\.local\bin\twitter.exe`
  (that directory is **not** on PATH; the Rust locator falls back to
  `~/.local/bin`)
- `Agent Reach v1.5.0` → `C:\Users\Developer\.agent-reach-venv\Scripts\agent-reach.exe`

## 8. Mock/demo provider must be removed from production behaviour in 0.2.0

`MockXProvider` currently backs the entire shipped UI whenever live auth is
unavailable, and `select_provider()` falls back to it silently.

**For 0.2.0 this must stop.** The mock provider must no longer be reachable in a
production build. When there is no valid session the app must say so and show an
empty/connect state — it must never present synthetic posts as if they were real
content. The mock may survive only as a test/development fixture (behind
`#[cfg(test)]` or a dev-only flag), never as a runtime fallback.

Concretely, the following currently exist purely to serve mock content and must
be reviewed or removed: the `ProviderKind::Mock` fallback branch in
`providers/mod.rs::select_provider`, the seeding call in `lib.rs::seed_if_empty`,
and the "Sample data" / "Sample account" badges in the UI.

## 9. Next target release

**0.2.0**

## 10. Complete next-update requirements (0.2.0)

1. **Manual `auth_token` / `ct0` connection in Settings.** A dedicated in-app
   connect flow. Values must go straight to the OS credential store (Windows
   Credential Manager or DPAPI) and be injected into the twitter-cli child
   process environment at call time. Never write them to SQLite, `settings.json`,
   logs, command-line arguments, screenshots, diagnostics or git. Never request
   the account password.
2. **Live Following feed** — real data through `TwitterCliProvider`, replacing
   the mock path as the default experience.
3. **Bookmarks** — live, from the authenticated account.
4. **People You Are Following** — live following list.
5. **Clean internal account profiles** — in-app profile views (header, bio,
   counts, posts), rendered with native components; no x.com embedding.
6. **Complete Arabic and English support** — full interface translation, not
   just per-post text direction. Currently only post bodies flip RTL; all
   interface strings are English.
7. **Automatic session health status** — continuous, cheap detection of
   authenticated / expired / rate-limited, surfaced in the UI with a repair
   action. Must not run `agent-reach doctor` on a hot path.
8. **Ephemeral session-only content storage** — post content held for the
   session and cleared on exit, rather than persisted indefinitely. Note this
   directly conflicts with today's SQLite post cache and with offline reading;
   the schema and the feed engine both need rework, and the distinction between
   _transient content_ and _durable user data_ (saved posts, groups, pins, read
   state) must be made explicit.
9. **Aggressive idle/minimize optimization** — suspend timers, polling, media
   and background work when the window is minimised or idle; measure the effect.
10. **No fake fallback content** — see item 8 above. Empty and error states must
    be honest; never substitute synthetic posts for real ones.
11. **One-click application updates** — in-app updater (Tauri updater plugin),
    with signing keys and an update endpoint. Note the current installers are
    **unsigned**, so SmartScreen warns; signing should be resolved alongside this.

### Carry-over items already documented in PROJECT_STATUS.md

- Per-account repost rules and local mutes are held in component state only and
  are not persisted to `account_preferences` or applied in `load_feed`.
- Interface preferences (theme, density, timestamp style, …) live in the Zustand
  store and reset on restart; only muted words persist.
- The auto-refresh interval is a stored preference with no timer wired to it.
- No onboarding wizard (Diagnostics covers the same ground).
- Installers have never been tested on a clean Windows image.
- No performance measurements (cold start, memory, frame rate) were taken.

## 11. The old WPF FocusFeed project must remain untouched

`C:\Users\Developer\Documents\FocusFeed` is a **separate repository** and must
not be modified.

Verified at handoff time:

- HEAD: `8931398  v2.0.0: replace Focus Mode with the in-app custom reader`
- Branch: `v2-custom-reader`
- **Working tree: CLEAN** — `git status --short` returned nothing.

It shares no code with Focus Feed Next. Do not migrate, refactor, delete or
"tidy" it as part of 0.2.0 work.

---

## Hard-won knowledge worth not rediscovering

Four defects were found only by launching the built app and looking at it. All
are fixed and test-covered; the reasoning is worth keeping:

1. **`Bearer` token leak** — redaction order in `security::sanitize`. See §6.
2. **Raw `#` truncates `data:` URIs.** Mock SVGs reference gradients as
   `url(#g)`; a literal `#` ends the URI at the fragment marker and every image
   silently breaks. It must survive encoding as `%23`. Regression test asserts
   no data URI contains a raw `#`.
3. **Never call `agent-reach doctor` on a UI hot path.** It probes many channels
   over the network and takes up to a minute; it left the Home dashboard stuck
   on "Checking…". Use `AgentReachManager::cached_health()`; run the full check
   only from Diagnostics.
4. **Chromium vertically centres a `<button>`'s content.** The post avatar
   button stretched to full card height and floated mid-card. Fixed with
   `self-start`.

**Screenshot procedure** (needed again for 0.2.0 verification):

- Select the page with the `FFN_PAGE` env var or `--page <route>` argument,
  which the `initial_route` command reads. Valid routes: `home`, `following`,
  `focus`, `search`, `pinned`, `groups`, `lists`, `bookmarks`, `library`,
  `accounts`, `diagnostics`, `settings`.
- **Never use SendKeys** — it injects keystrokes globally and they land in
  whatever window has focus.
- Call `SetProcessDPIAware()` first; this is a 4K display and window rects are
  otherwise wrong, which produces offset captures of the wrong screen region.
- **Verify `GetForegroundWindow() == hwnd` immediately before copying pixels**
  and refuse to save otherwise. `SetForegroundWindow` frequently fails silently
  and will otherwise photograph a different application.

In-app keyboard shortcuts: `Ctrl+1..9` for the first nine pages, `Ctrl+0`
Following Manager, `Ctrl+D` Diagnostics, `Ctrl+,` Settings.

## Documentation index

- `README.md` — overview, setup, live-data connection instructions
- `ARCHITECTURE.md` — layers, provider abstraction, data flow, error model
- `PROJECT_STATUS.md` — full capability list and limitations
- `TEST_REPORT.md` — test results, defects found, visual verification method
- `screenshots/` — 12 pages captured at 2404×1604 (all mock data)
