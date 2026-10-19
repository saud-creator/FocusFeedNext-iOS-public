# Architecture

## Responsibility split

The project keeps three concerns strictly separate.

**Focus Feed Next** owns the interface, session storage, filters, read state,
pinned accounts, groups, media presentation, settings and diagnostics.

**Agent Reach** is used only for installation, health checks, backend discovery
and repair guidance. It is _never_ invoked on the path that loads posts.

**twitter-cli** is the primary backend for retrieving structured X data.

```
┌──────────────────────────── React (TypeScript) ────────────────────────────┐
│  pages/          Following · Originals · Focus · Accounts · Groups ·        │
│                  Bookmarks · Profile · Diagnostics · Settings               │
│  components/     PostCard · AuthorHeader · PostText · MediaGallery ·        │
│                  VideoPlayer · QuotedPostCard · PostActions ·               │
│                  ReadStateIndicator · Lightbox                              │
│  hooks/          useFeed (cache-first, held-back new posts, single-flight)  │
│  lib/api.ts      typed invoke() wrappers — the ONLY backend entry point     │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ Tauri IPC (fixed command list)
┌───────────────────────────────┴────────────────────────────────────────────┐
│  commands.rs     52 explicit commands. No "run arbitrary command" exists.   │
│  providers/      XDataProvider trait                                        │
│                    └── TwitterCliProvider   (live, process-managed)         │
│                    (MockXProvider is #[cfg(test)] / dev-mock only)          │
│  agent_reach.rs  AgentReachManager — doctor --json, parsed + cached         │
│  database.rs     IN-MEMORY SESSION SQLite: posts, authors, feed_entries,    │
│                  bookmark_order, read_states, hidden_posts, groups,        │
│                  muted words, sync state and reading activity               │
│  durable.rs      DURABLE SQLite: preferences (allowlisted), account identity│
│  ephemeral.rs    per-run session directory, lock file, startup purge        │
│  credentials.rs  Windows Credential Manager (auth_token / ct0)              │
│  session.rs      session-health state machine (green/yellow/red/grey)       │
│  security.rs     command allowlist + secret sanitisation                    │
│  models.rs       stable internal models                                     │
└────────────────────────────────────────────────────────────────────────────┘
```

## Storage model

The Windows portable release has one OS credential store, one small durable
metadata store beside the EXE, and one in-memory session store. The debug
compatibility mode may use the old preferences path. The iOS target uses the
same storage abstractions against its app sandbox and Keychain.

| Store                      | Location                                                               | Holds                                                                       | Lifetime            |
| -------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| Windows Credential Manager | OS-managed                                                             | `auth_token`, `ct0`                                                         | until disconnected  |
| Preferences (`durable.rs`) | portable: `.focusfeed-next\preferences.db` beside the EXE; debug compatibility: `%APPDATA%\FocusFeedNext\preferences.db` | allowlisted preferences, account identity and account-scoped local Lists | until deleted      |
| Session (`database.rs`)    | SQLite connection in RAM                                                 | fetched content, bookmark order, read state, filters and media registrations | dropped on exit |
| WebView2 profile           | `session-*/webview` beside the EXE, or locked `%TEMP%\FocusFeedNext\webview\run-*` fallback | private browser state needed for this run | **deleted on exit** |
| iOS Keychain               | OS-managed app access group                                            | companion bearer token and private Windows address                          | until disconnected |
| iOS preferences            | app-sandbox Application Support                                        | allowlisted preferences and safe account identity                           | until app data is deleted |
| iOS session                | app-sandbox Cache directory                                            | fetched content, read state, groups, pins and media registrations           | deleted on app shutdown; purgeable by iOS |

Nothing fetched from X is durable. Posts, bookmarks, following lists, profiles,
avatars, read state and scroll position belong to the in-memory run that fetched
them. Portable Windows releases do open the small durable metadata database:
allowlisted preferences, account identity and user-authored account-scoped List
definitions survive a restart, while content and read state do not. On iOS,
`is_portable()` is deliberately false because there is no writable location
beside the executable; preferences live in the sandbox while fetched content
uses the same in-memory session lifecycle.

**Persistence is an allowlist, not a denylist.** `DURABLE_PREFERENCES` in
`durable.rs` names every key permitted to survive a restart, and
`Durable::set_preference` rejects anything else. A key added elsewhere in the app
is ephemeral until somebody deliberately adds it to that list, so durability
cannot be acquired by accident — the failure mode a denylist has.

The web layer persists nothing intentionally: no `localStorage`, no
`sessionStorage`, no cookies, no IndexedDB is used by the app. The WebView2 data
directory is explicitly placed inside the same disposable session directory;
it is not allowed to select Tauri's default AppData profile. The window is also
created with an incognito/private flag. If the portable session root cannot be
created, a locked temp profile is used; if no private profile can be created,
startup fails closed. This is enforced by a source-tree scan in
`src/checks/persistence.test.ts` and the native setup path rather than by
review alone.

**Crash recovery.** Each session directory holds an open handle on
`session.lock` for the life of the process. Windows refuses to delete a file
another process has open, so "can I delete this lock?" answers "is that session
dead?" exactly — no process enumeration, no dependency. Startup purges every
directory that answers yes, plus anything older than 24 hours as a backstop.

Cleanup is **best-effort filesystem deletion**. It removes the files and the
directory, which is all a userspace process can honestly promise; it does not
and cannot guarantee the blocks are unrecoverable on an SSD, where wear
levelling keeps copies out of the operating system's reach.

## Provider abstraction

`XDataProvider` (in `providers/mod.rs`) is the single interface. It is narrower
than 0.1.0's, because methods that twitter-cli 0.8.5 cannot actually serve were
removed rather than left returning empty results:

```rust
fn get_following_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage>;
fn get_user_posts(...)          fn get_user_profile(...)
fn get_bookmarks(...)           fn get_following_accounts(&self, username, max)
fn get_current_user(...)        fn get_list_timeline(...)
fn status(...)
```

Narrower again in 0.5.0: `search_posts` and `search_posts_tab` are gone with the
Search page. That removal is the whole of it — there is no free-text path into X
left anywhere in the app, and `search` is no longer in `ALLOWED_OPS` either.

`select_provider()` **always** returns the live backend. There is no mock
fallback: when there is no usable session the session layer says so and the
interface shows a connect state rather than invented posts. `MockXProvider`
survives only under `#[cfg(test)]` or the off-by-default `dev-mock` Cargo
feature, and a `dev-mock` build logs a warning that its content is fabricated.

### iPhone provider path

The iPhone is built from this same Tauri app, React tree, Rust models, database,
filter engine and media pipeline. It swaps only the platform shell and provider:

```text
iPhone React UI -> Tauri IPC -> RemoteProvider -> authenticated local HTTP
                                                   |
Windows React UI -> Tauri IPC -> CompanionHost -> TwitterCliProvider -> X
```

An App Store process cannot launch the Windows `twitter-cli` child process.
`RemoteProvider` therefore implements the existing `XDataProvider` trait and
exchanges the same stable models with `CompanionHost` in the running Windows
app. The Windows listener is stopped by default, starts only from Settings,
binds to the single detected private-network interface on an OS-selected port,
and stops with the app.

Pairing trades an eight-digit one-use code for a random 256-bit bearer token.
Five failed code attempts impose a 30-second block. The host accepts only POST
requests to `/v1/pair` and `/v1/provider`, caps bodies at 64 KiB, disables
redirects on the iPhone client and exposes an explicit read-operation allowlist.
There is no arbitrary-command route and no follow, unfollow, mute or block path.
The iPhone also rejects companion addresses that are not loopback, link-local or
private IP addresses.

The first TestFlight transport is authenticated but not encrypted: the local
endpoint is plain HTTP because no mutually trusted certificate is provisioned.
It is suitable only for a trusted private Wi-Fi network. X cookies never cross
the bridge, but a hostile device able to monitor that LAN could observe the
companion token and returned feed data. `IPHONE_BUILD.md` records this release
gate explicitly.

**Each provider converts its own raw output into the models in `models.rs`.** A
twitter-cli schema change is absorbed in `twitter_cli.rs` and never reaches a
React component. If the payload stops being recognisable, the adapter returns
`schema_changed` rather than silently producing an empty feed.

## Background preload

Two workers start once, from the startup probe thread, and only after the probe
came back usable — preloading against a session X has already rejected is two
guaranteed failures and two child processes for nothing.

| Worker    | Reads                                   | Preference                 |
| --------- | --------------------------------------- | -------------------------- |
| Following | the whole follow list, in batches       | `startup.preloadFollowing` |
| Bookmarks | the bookmark timeline, with the patched provider following its terminal cursor; the UI reads bounded keyset slices from the complete in-memory order and never materializes the whole collection in React/IPC | `startup.preloadBookmarks` |

Both default on. Only a literal `"false"` turns either off: they read and
nothing else, so every failure mode of reading the preference should land on
the more useful answer.

Each holds a single-slot guard, so a manual sync and the startup preload cannot
become two traversals of the same list, and the two workers hold independent
slots so neither blocks the other. `Workers::cancel_all` runs on exit, on
disconnect and on account switch — the last matters most, because a traversal
started under one account must never write rows after another is connected.

Progress reaches the interface through a `ProgressSink`. The traversal is
testable without a webview precisely because it reports through a trait;
`WebviewSink` in `lib.rs` is the only part that knows Tauri exists. **The sink
has to be installed** — the state's default is `NullSink`, which discards
everything, and a run with no sink installed looks exactly like a worker that
never started.

## Media variants and the provider patch

twitter-cli sorts a video's MP4 renditions by bitrate and keeps the largest,
discarding the rest before serialising. No consumer downstream can offer a
quality choice after that, so `tools/twitter-cli/` carries a reproducible patch
that preserves them all. See that directory's README.

The app handles both shapes. An absent or empty `variants` array yields no
variants, and the interface shows one honest quality rather than a picker with
an invented entry.

Every rendition is registered with the media proxy under its own opaque id, so
React receives loopback URLs only. A variant whose host fails validation is
dropped from the list rather than blanked: a quality the reader can select and
cannot play is worse than one that was never offered.

Renditions are deduplicated by resolution keeping the higher bitrate — X
routinely publishes two encodes of one size — and sorted largest first, so
"best available" is simply the first. A rendition X described with neither a
resolution nor a bitrate is dropped, because there is no truthful way to name
it and a vague label is one the reader would still act on.

## Process security

Every external invocation goes through `run_op`, which:

1. rejects anything in `BLOCKED_OPS` (post, reply, like, retweet, follow, …),
2. rejects anything not in `ALLOWED_OPS` (the read list). Writes take a
   separate door — `run_write_op`, gated by `GATED_WRITE_OPS` and a
   `WritePermit` that cannot be constructed unless the durable
   `actions.allowUnfollow` preference is on. See `SECURITY.md` §3,
3. builds an **argument array** — no shell string is ever constructed,
4. applies a timeout and kills the child process on expiry,
5. drains stdout and stderr on separate threads so a full pipe cannot deadlock,
6. maps recognisable failures onto structured error codes.

`ok: true` is never treated as success on its own; an `ok:false` envelope and an
unrecognisable payload are both errors.

## Secret handling

On Windows, `auth_token` and `ct0` are stored in Windows Credential Manager
(`keyring` with `windows-native`) and are handed to twitter-cli
**only** through the child process environment, at spawn time. They are never
passed as command-line arguments, never written to a file, and the global
process and Windows user environments are never modified.

On iOS, the same credential-store interface compiles with `apple-native` and
stores only the companion bearer token plus the private Windows address in
Keychain. It never stores either X cookie on the phone.

Nothing credential-shaped can reach:

- either SQLite store (`set_setting` and `Durable::set_preference` both reject
  token/cookie-like keys)
- the frontend — `connect_x_account` returns a `SessionSnapshot` carrying
  presence booleans and safe account metadata, and a test serialises it to
  prove no token appears
- logs, diagnostics, or the copyable report (`security::sanitize` scrubs
  `auth_token`, `ct0`, `Cookie`, `Authorization`, `Bearer …` and env assignments)
- command-line arguments or the repository

Saved credentials are never prefilled into the interface and there is no
reveal control. The account password is never requested.

**Credential replacement is atomic.** New values are validated against X using a
throwaway in-memory store _before_ anything durable changes; if validation fails
for any reason the previous working credentials and session identity are left
exactly as they were. Only after X confirms the session does the keyring write
happen, followed by clearing the previous account's session content.

`sanitize()` deliberately redacts `Bearer <token>` **before** the key/value pass;
doing it the other way round let the `authorization` rule consume the word
"Bearer" and leave the real token exposed. That ordering is covered by a test.

## Feed engine

- Posts already fetched **this run** render immediately from the session
  database; the refresh runs behind them. A fresh run starts empty, because
  there is nothing to render until the first live request returns.
- **Post ID is the deduplication key** — refetching updates in place.
- **Pagination is per-command, and detected rather than assumed.** twitter-cli
  0.8.6 added `--cursor` to `feed` and `list`, and those two return
  `pagination.nextCursor` beside `data` in the envelope. Every other read
  command emits no pagination key at all, so `parse_feed` reports the cursor it
  actually received and `None` otherwise. The interface offers continuation only
  where a real cursor arrived — it never promises an affordance it cannot
  honour, and it does not need a hand-maintained table of which command paginates.
  A cursor round-trips through the frontend, so it is re-validated by
  `security::clean_cursor` before going back on a command line.

### Media transport

Post images, posters, video and GIF media do not load from X's CDN directly.
Video is the original WebView2 failure case, but using the same transport for
all post media also prevents the WebView from creating a disk cache for signed
URLs. The bytes are streamed; they are not stored.

`media_proxy.rs` is a hyper server on `127.0.0.1` with an OS-chosen port,
started with the app and stopped with it. `AppState::proxy_media` rewrites every
post-media source on the way out of **every** command that returns posts, so the
frontend only ever sees:

```
http://127.0.0.1:<port>/media/<per-process secret>/<opaque id>
```

The id is a key into an in-memory map that only Rust can populate, from URLs the
provider itself parsed out of an X payload. React cannot supply a URL, which is
what stops this being an open SSRF proxy. No credential is involved anywhere —
this is a transport, not an authenticated bridge.

The in-memory session database keeps the **original** CDN URL; only the outbound
copy is rewritten, so a retry can re-register. The proxy applies no-store
headers, caps each response at 128 MiB, allows four concurrent upstream
transfers and times out a transfer after 90 seconds. Nothing is cached to disk,
and the map dies with the process. One active video decoder is allowed in the
React media session; nearby players retain only bounded metadata/poster state.

Full rules, host validation and header allowlists: `SECURITY.md` §4.

- New posts are never spliced above a reader mid-scroll. They are held and
  offered through a "Show N new posts" control; if the reader is already at the
  top they are applied directly.
- A single-flight guard prevents two concurrent refreshes of the same feed.
- Filters are applied before display and **never delete rows** — relaxing a
  filter restores the posts.
- A post is marked read only after it stays sufficiently visible for a
  configurable dwell time. Downloading a post never marks it read.

## Error model

`ErrorCode` mirrors the project plan: `tool_missing`, `not_authenticated`,
`cookie_expired`, `rate_limited`, `api_error`, `schema_changed`,
`empty_response`, `process_timeout`, `process_crashed`, `invalid_json`,
`database_error`, `media_unavailable`, `network_unavailable`,
`provider_unavailable`, `agent_reach_unavailable`, `blocked_operation`.

Each carries a sanitised message and an optional repair hint. Failures surface
in the UI with cached data still shown — provider problems are never hidden.

## Deviation from the suggested layout

The plan sketched a monorepo (`apps/desktop`, `packages/*`). This build uses a
single Tauri app at the repository root, keeping the `src-tauri/src` module
split the plan asked for. One app, one frontend, no cross-package wiring — the
workspace indirection would have added build complexity with no consumer.
