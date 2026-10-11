# Privacy

Focus Feed Next 0.5.7. This describes what the application actually does with
data on your machine.

---

## Network activity and third parties

There is no telemetry, no analytics, no crash reporting, no update ping, and no
remote logging. The Windows app makes two kinds of Internet connection:

1. **twitter-cli → X**, to fetch what you asked for.
2. **The local media proxy → `video.twimg.com` or `pbs.twimg.com`**, to stream
   post video, GIF, poster and still-image bytes that the reader is displaying.
   The renderer receives only loopback proxy URLs.

The optional iPhone target adds one local-network path: the iPhone sends
authenticated read requests to the paired Windows app on the same private
Wi-Fi, and Windows returns feed/profile models. This is direct between your two
devices; it is not a relay or cloud service. X cookies and your X password never
leave Windows.

There is no analytics or relay third party. However, the first TestFlight bridge
uses plain HTTP on the LAN. Another device capable of monitoring that network
could observe the companion bearer token and returned feed data. Use the iPhone
build only on a trusted private Wi-Fi network until an encrypted transport is
implemented.

## Three stores, and what is in each

| Store                      | Location                                                               | Contents                                   | Lifetime             |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ | -------------------- |
| Windows Credential Manager | OS-managed                                                             | `auth_token`, `ct0`                        | Until you disconnect |
| Preferences                | Portable: `.focusfeed-next\preferences.db` beside the EXE; debug compatibility: `%APPDATA%\FocusFeedNext\preferences.db` | Allowlisted preferences, account identity and account-scoped local Lists | Until deleted |
| Session content            | In-memory SQLite for the run                                                   | Fetched posts, authors, cursors, read state and media registrations | Dropped on exit |
| WebView2 profile           | Per-run `webview` child beside the portable EXE, or locked temp fallback     | Browser profile/cache needed by this run only | **Deleted on exit** |

On iPhone, the companion token and private Windows address live in iOS
Keychain. Allowlisted preferences and safe account identity live in the app's
sandboxed Application Support area. Fetched content uses a per-run database in
the sandboxed Cache area and is removed during a clean app shutdown; iOS may
also purge cache data. Deleting the app removes its sandbox, while Disconnect
deletes the Keychain companion credentials through the app.

### Fetched content is session-only

Every post, author, timeline, bookmark and list feed you load lives in the
in-memory session database and is **dropped when the app closes**. Reading
history, hidden posts, muted words, groups, pinned handles and unread state are
session-scoped: they do not survive a restart, by design. The per-run
filesystem directory holds only `session.lock` and the private WebView2
profile; it is deleted when the app closes.

Verified on the real build: closing the window logs `session storage cleared:
<n> bytes freed` and the directory is gone.

Persistence is enforced by an **allowlist**, not a denylist. A preference key
added anywhere in the app is ephemeral until somebody deliberately adds it to
`DURABLE_PREFERENCES`. Durability cannot be acquired by accident.

### What actually persists

In a debug/non-portable run, only these keys may persist:

`language`, `theme`, `density`, `window.width`, `window.height`, `window.x`,
`window.y`, `window.maximized`, `updates.autoCheck`, `updates.channel`,
`actions.allowUnfollow`

Plus the connected account's id, handle, display name and avatar URL, and
account-scoped local List definitions and memberships. Portable releases keep
those allowlisted values in `.focusfeed-next\preferences.db`; no bio, no
counts, no posts or read state are durable. Debug compatibility uses the
`%APPDATA%\FocusFeedNext\preferences.db` path shown above.

### The web layer stores nothing at all

No browser storage API is used anywhere in `src/`. This is enforced by a
source-tree scan (`src/checks/persistence.test.ts`) that fails the build if one
appears — it has caught genuine additions during development, including a
variable name and a comment.

Video volume and mute are remembered **in memory for the session only** and are
lost when the window closes.

## The media proxy holds nothing

Post images, posters, videos and animated GIFs are streamed through an
app-local server on `127.0.0.1`. It writes **no cache to disk** — bytes pass
from X to the image/video element and are not stored. The map from opaque id to
media URL exists only in process memory, so "cleared on exit" is a property of
the process rather than a cleanup step that could fail. Each response is
limited to 128 MiB, no more than four upstream transfers run at once, and the
upstream request has a 90-second total timeout. Response caching is disabled.

Signed media URLs never reach the interface. The frontend only ever sees
`http://127.0.0.1:<port>/media/<secret>/<id>`.

## Logs

On Windows, the desktop release writes diagnostic messages to its process
stream only; it does not create an application log file under AppData. An iOS
build keeps its application logs inside Apple's app container and device
logging system.

Our own messages log at Info; everything else is silenced at Warn. The
`keyring` crate previously logged at Debug on every credential-store operation,
naming the entry each token lives in — 48 of 51 lines in a short run. No value
was ever included, but a log recording every read of the credential store is
more detail on disk than this app has reason to keep, so it is off.

Never logged: credentials, cookie headers, child-process environments, the
media proxy secret, or full signed media URLs. A media fetch failure logs the
post id and a one-word cause.

## Diagnostics

The diagnostics report is sanitized before it is produced. It can contain
whether credentials are present, never a value. Safe to paste.

## What the app does to your X account

By default: **nothing.** It reads.

There is one exception, and it is off unless you switch it on: **Allow Unfollow
actions** in Settings → Actions. When on, an Unfollow control appears in People
you follow. Each unfollow names the exact account and asks for confirmation,
happens one at a time, and is never retried automatically. There is no bulk
unfollow.

While the setting is off the backend refuses the request without starting any
process at all.

No other account-changing operation exists in this release: no posting,
replying, quoting, liking, reposting, following, bookmarking, muting or
blocking.

The iPhone companion is stricter: every account-changing capability is disabled
and the bridge accepts read operations only.

## Deleting everything

1. Settings → X Connection → Disconnect. Removes the credentials from Windows
   Credential Manager, clears the session content, drops the stored identity,
   and invalidates every media registration.
2. For a portable release, delete the adjacent `.focusfeed-next\` directory
   after the app has exited if you also want to remove allowlisted preferences
   and local List definitions. For a debug/non-portable run, delete
   `%APPDATA%\FocusFeedNext\` instead.
3. Session content is already gone — it is held in memory and dropped every
   time the app exits; the private WebView2 run directory is deleted as well.
4. On iPhone, use Disconnect to remove the companion credential, then delete the
   app if you also want iOS to remove its complete sandbox.

## An honest limitation

Deletion is **best-effort filesystem deletion**. On an SSD, unlinking a file
does not physically erase the blocks it occupied; wear levelling and the
controller's own remapping mean the data may remain recoverable by forensic
means until those blocks are reused. No application-level code can change this,
and this document does not claim otherwise.

The desktop setup refuses to launch if it cannot create a private per-run
WebView2 profile, so it does not silently fall back to WebView2's permanent
AppData profile. A crash can leave a locked run directory briefly; the next
startup and a bounded same-EXE cleanup attempt remove it after WebView2 releases
its files. The iPhone uses WKWebView inside Apple's per-app sandbox instead.
