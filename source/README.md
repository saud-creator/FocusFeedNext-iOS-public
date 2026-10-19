# Focus Feed Next

A standalone desktop reader for X, built for focus and long reading sessions.

Focus Feed Next is **not** a browser wrapper, a WebView showing x.com with restyled
CSS, or an extension. It retrieves structured post data through a controlled
backend and renders it with its own React components.

The repository now also contains a functional **iPhone companion target** built
from the same React and Rust code. Because iOS cannot launch the desktop
`twitter-cli` process, live data is supplied by an explicitly started,
read-only bridge in the Windows app while both devices are on the same private
Wi-Fi. See [IPHONE_BUILD.md](IPHONE_BUILD.md) for the architecture, Apple setup,
cloud IPA build, TestFlight upload, security boundary, and remaining device
gates.

- **Tauri 2 + Rust** backend — process management, SQLite, provider abstraction
- **React + TypeScript + Vite** frontend — original design system, no X markup
- **twitter-cli, pinned to an exact commit** for data — no paid X API
- **Read-focused toward X** — account-changing actions are disabled by default.
  Posting, replying, liking, reposting, muting and deleting are blocked in the
  Rust layer, not merely hidden in the UI. Removing an existing X bookmark is
  available only from the Bookmarks page after explicit confirmation. Follow
  and Unfollow are the other gated exceptions; both require the Settings opt-in,
  are single-flight, and are serialized with connection changes
- **Local by default** — no analytics, telemetry, remote logging or cloud sync
- **No exits** — nothing in the interface opens a browser. A legal post URL can
  be copied from the three-dot menu, and only the current post's self-link is
  hidden from its text; article links and links to other posts remain visible.
  The `opener` capability is not granted to the window at all
- **No engagement figures** — no like, repost, reply, quote or view count is
  shown anywhere, and there is no setting to bring them back

---

## Current status

**Version 0.5.7.** This release hardens resource ownership and session cleanup:
fetched posts stay in an in-memory database, every desktop run gets a private
throwaway WebView2 profile, and post media is streamed through the bounded
loopback proxy without a disk cache. There is no mock fallback in a release
build: with no usable session the app says so and shows a connect screen,
rather than showing invented posts that look real. The current source and
portable release still need a real Credential Manager session for live-X
verification; this machine currently has none.

0.5.0 is mostly a subtraction. Search, the local library, every engagement
count, all reply handling and every route out to x.com were removed rather than
hidden, down to the Rust commands and the Tauri capability that made them
possible. Two things were added: **Originals**, which is the following timeline
with reposts taken out and quote posts kept, and a **People you follow** page
whose rows open the account.

| Area                                       | State                                                      |
| ------------------------------------------ | ---------------------------------------------------------- |
| Seven pages, navigation, internal profiles | Working                                                    |
| Startup preload of Bookmarks and Following | Working — follows the provider to the terminal bookmark cursor |
| Bookmarks in X's own order                 | Working — no application-side bookmark count ceiling          |
| Local topic Lists with real merged timelines | Working                                                  |
| Originals — the timeline minus reposts     | Working; per account too, on the profile page              |
| People you follow → their latest posts     | Working — pressing a row opens that account                |
| Video, fullscreen, genuine quality ladders | Working — 96 live media items carried real variants        |
| Long-feed scrolling                        | Measured: 500 posts render 11 cards, not 500               |
| Mute / Block                               | **Not available** — twitter-cli 0.8.6 has no such command  |
| Search                                     | **Removed** in 0.5.0 — see below                           |
| Local library                              | **Removed** in 0.5.0 — X Bookmarks is the saved list       |
| Engagement counts, replies, opening x.com  | **Removed** in 0.5.0 — see below                           |

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for the full capability list with how
each was established, [TEST_REPORT.md](TEST_REPORT.md) for verification
evidence, and [perf/README.md](perf/README.md) for the scroll measurements.

---

## Requirements

- Windows 10/11 with the **WebView2 runtime** (present on current Windows 11)
- For development: Node.js 20+, Rust 1.77+ (MSVC toolchain), MSVC build tools
- For live data: Python 3, Agent Reach, twitter-cli (see below)

## Running from source

```bash
npm install
npm run tauri dev
```

Portable single-EXE release and shortcut:

```bash
npm.cmd run portable
```

This produces `dist-portable\FocusFeedNext-v<version>\FocusFeedNext.exe` and
an adjacent `FocusFeedNext.lnk`. Each portable build removes older versioned
release folders from `dist-portable`, so the current release is the only
packaged copy left there. It also refreshes the Desktop shortcut and the
Focus Feed Next taskbar pin. The release does not create a durable
`%APPDATA%` or `%LOCALAPPDATA%` application profile. Allowlisted preferences,
account identity and local List definitions are stored in
`.focusfeed-next\preferences.db` beside the executable. Fetched posts stay in
RAM; the per-run directory contains only the cleanup lock and private WebView2
profile, and the bounded loopback media proxy holds media bytes and URL
registrations in RAM. Logs go to the process stream, not an application log
file. The per-run directory is deleted on exit, with lock-checked fallback
cleanup for interrupted WebView2 shutdowns. The version is always visible
beside the Focus Feed name in the sidebar, and Settings → About shows the same
release value. Pass `-SkipChecks` only when the v<version> native
release executable has already been verified and you intentionally want to
repackage it.

The regular Tauri build is still available when MSI/NSIS installers are needed:

```bash
npm.cmd run tauri build
```

## Tests

```bash
npm test
```

```bash
cd src-tauri && cargo test
```

---

## Connecting live X data

Without this step the app shows a connect screen. It does **not** fall back to
sample data — a release build has no mock provider, because posts that look real
and are not are worse than an empty page.

Focus Feed Next never asks for your X password and never transmits your session
anywhere.

> **Use a dedicated burner account.** The upstream tooling warns that this style
> of access can get accounts suspended.

1. Install the provider once, at the pin (see below):

   ```bash
   pwsh tools/twitter-cli/install-focusfeed-twitter-cli.ps1
   ```

2. Sign in to x.com **on the burner account**, then copy the values of the
   `auth_token` and `ct0` cookies (Cookie-Editor extension, or DevTools →
   Application → Cookies).

3. Open Focus Feed Next and paste them into the connect screen, in the
   application itself.

They go straight into **Windows Credential Manager** and are read from there on
every launch. They are not written to a file, not placed in an environment
variable, and not passed on a command line — an environment variable is readable
by every process you run and survives in your user profile until you remove it,
which is why the earlier `setx` instructions are gone.

Nothing in the interface ever displays a stored credential. `XCredentials` has a
hand-written `Debug` that prints `<redacted>`, so neither value can reach a log
line by accident, and a test asserts `ct0` never appears in any payload sent to
the frontend. Diagnostics reports only whether each is _present_.

### The twitter-cli pin

twitter-cli is pinned to an exact commit rather than tracking `main`. It is the
app's entire view of X and its output contract has already changed under us
once, so a moving dependency there is a moving parser here.

```bash
pipx install --force "git+https://github.com/public-clis/twitter-cli.git@7c634e0d396b1e7af9f63315b414925fe4f29ae7"
```

That is **0.8.6**. Diagnostics reports the version on disk, the pinned commit
and the resolved executable path, so a drift is visible rather than mysterious.

### What the backend can and cannot do

Checked against the pinned build's own `--help` and its real responses:

| Capability                                    | State                           |
| --------------------------------------------- | ------------------------------- |
| Cursor pagination — `feed`, `list`            | Yes                             |
| Cursor pagination — `following`, `user-posts` | **No.** They take `--max` alone |
| Real promoted flag                            | Yes                             |
| Remove an X bookmark — `unbookmark`           | Yes — Bookmarks page + confirmation |

The interface asks the backend for this rather than assuming it. Controls that
the backend cannot serve are not shown.

Search is absent from this table on purpose. The CLI can still do it; **this app
has no way to ask** — `XDataProvider` has no free-text method, `search` is not in
`ALLOWED_OPS`, and what the interface needs to know is what it can offer rather
than what the backend could in principle.

---

## Documentation

- [IPHONE_BUILD.md](IPHONE_BUILD.md) — iPhone target, signed IPA workflow, and
  TestFlight handoff
- [ARCHITECTURE.md](ARCHITECTURE.md) — layers, provider abstraction, data flow
- [PROJECT_STATUS.md](PROJECT_STATUS.md) — what works, and how each claim was
  established
- [TEST_REPORT.md](TEST_REPORT.md) — test results and live verification
- [perf/README.md](perf/README.md) — the scroll measurement rig and its numbers
- [SECURITY.md](SECURITY.md) · [PRIVACY.md](PRIVACY.md) — what is stored, where,
  and for how long
- [UPDATE_GUIDE.md](UPDATE_GUIDE.md) — updating the app and the provider
- [tools/twitter-cli/README.md](tools/twitter-cli/README.md) — the provider pin
  and the media-variant patch

## Licence

MIT.
