# Security

Focus Feed Next 0.5.7. Everything below describes what the code does today, not
what is intended for a later release. Where a protection is partial, it says so.

---

## 1. Credentials

On Windows, `auth_token` and `ct0` live in **Windows Credential Manager** and
nowhere else.

They are never written to SQLite, JSON, a log, a command line, or any frontend
storage. They reach twitter-cli through the **child process environment block
only** (`TWITTER_AUTH_TOKEN`, `TWITTER_CT0`), written immediately before spawn.
The global process environment and the Windows user environment are untouched.

Command lines are visible to any other process on the machine; environment
blocks of a child are not. That is why the values never appear as arguments.

The frontend can never read a credential back. The connect command returns a
presence boolean and safe account metadata (handle, display name, avatar) —
there is no command that returns a stored secret.

The iPhone never receives those X cookies. It stores a random companion bearer
token and the paired private Windows address in **iOS Keychain** through the
`apple-native` keyring backend. Those values are likewise never returned to the
frontend after pairing.

`security::sanitize` redacts `auth_token`, `ct0`, `Cookie`, `Authorization`,
`Bearer` and related keys from anything heading for a log, an error message or
a diagnostic report. `Bearer` is redacted **before** the key/value pass; the
other order leaks the token, and a test covers exactly that ordering.

When no session is stored, inherited `TWITTER_*` variables are actively stripped
from the child environment, so a leftover `setx` from an earlier experiment
cannot make a disconnected app quietly appear to work.

**Not claimed:** in-memory secrets are wiped best-effort with `zeroize`. This is
not a guarantee. Copies may persist in freed heap pages, the page file or a
crash dump, and nothing here can erase them.

## 2. Process execution

Every twitter-cli invocation is built from a validated operation plus an
**argument array**. No shell string is ever constructed, so there is no shell to
inject into. The remaining risk is _argument_ injection — a value beginning with
`-` being read as a flag — and every value that reaches an argument array passes
a guard first:

| Guard               | Accepts                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `clean_screen_name` | 1–15 chars of `[A-Za-z0-9_]`, optional leading `@`                    |
| `clean_numeric_id`  | decimal digits, ≤25                                                   |
| `clean_query`       | free text, control characters stripped, no leading `-`, capped at 200 |
| `clean_cursor`      | base64-ish, ≤512, no leading `-`                                      |

`clean_cursor` exists because a pagination cursor **round-trips through the
frontend**. By the time we see one again it is untrusted input, regardless of
where it came from originally.

Two doors reach the CLI, and they are separate on purpose:

- **`run_op`** — reads only. Checks `ALLOWED_OPS` and `BLOCKED_OPS`.
- **`run_write_op`** — the single account-changing path. Checks
  `GATED_WRITE_OPS` and requires a `WritePermit`.

`unfollow` is in `BLOCKED_OPS` **as well**, so the read path cannot reach it no
matter what is passed.

Every call has a 120s timeout and kills the child on expiry. stdout and stderr
are drained on separate threads, so a chatty process cannot deadlock on a full
pipe.

## 3. The two Windows write operations

Follow and Unfollow are the only things this release can change on an X account. Four gates,
all on the Rust side of the IPC boundary:

1. `confirmed: true` must be passed. A caller that skipped the dialog fails.
2. The durable preference `actions.allowUnfollow` must be exactly `"true"`.
   **While it is off no child process is started at all** — the refusal happens
   before any argument is built.
3. A `security::WritePermit` must be constructible. It is a type, not a
   boolean: it cannot exist unless gate 2 held, and the provider method will
   not compile without one. "Did anybody check?" is answered by the type
   system rather than by review.
4. Nothing else may be in flight (`compare_exchange`, so two dialogs confirmed
   in the same instant cannot both pass).

The preference is re-read inside the worker, because it could be switched off
between the check and the call.

**There is no retry.** A failure might mean "it worked and the response was
lost", and re-sending could repeat a real account change. There is no bulk action and no
queue: a second request is refused, not deferred.

Still blocked, and tested to stay blocked: post, reply, quote, delete, like,
unlike, retweet, unretweet, bookmark, unbookmark, favorite, unfavorite,
mute, block.

The iPhone companion exposes **no write operation**, including Follow and
Unfollow. Mobile capabilities force every write flag to false even when the
paired Windows provider can perform a gated write.

## 4. The loopback media proxy

WebView2 refuses X's video CDN URLs directly. The bytes are fine — a Range
request returns 206, `video/mp4`, H.264 — but a request from `tauri.localhost`
is cross-site and the CDN does not serve it. So video is streamed through a
local HTTP server.

**No credential is involved.** This is a transport, not an authenticated
bridge, and no part of `media_proxy.rs` touches the credential store.

Bound to `127.0.0.1` with the port chosen by the OS. Never `0.0.0.0`, never a
LAN interface, never the IPv6 wildcard, never a fixed port. Non-loopback peers
are refused at accept time even though the socket cannot receive them.

```
GET|HEAD /media/{per-process-secret}/{opaque-media-id}
```

- The **secret** is 24 random bytes from the OS entropy source, regenerated
  every launch, never written to disk or a log, compared in constant time.
- The **media id** is 16 random bytes and means nothing on its own. It is a key
  into an in-memory map that only Rust can populate, from URLs the provider
  itself parsed out of an X payload.

That is what stops this being an open SSRF proxy: **React cannot supply a URL.**
It can only name an id that Rust already minted.

Upstream fetches are constrained to:

- HTTPS only, exact host match against `video.twimg.com` / `pbs.twimg.com` —
  no suffix rule, so `video.twimg.com.evil.test` is refused
- no userinfo (`https://video.twimg.com@evil.test/` resolves to evil.test)
- no port, no loopback, no private or link-local address
- every redirect hop re-validated, with a hop limit

Headers are allowlisted in both directions. `Range`, `If-Range`, `If-None-Match`,
`If-Modified-Since` and `Accept` go up — `Cookie`, `Authorization`,
`Proxy-Authorization` and `Origin` do not. Coming back, only the seven headers
playback needs are copied, so `Set-Cookie` and server identification are dropped
by **absence from an exhaustive allowlist** rather than by name.

CORS names the app's production origins (`https://tauri.localhost` for the
desktop WebView and `tauri://localhost` for the iOS WebView). Never `*` — this
server is reachable by anything running as this user, and the secret is the only
thing between them and the media.

The registry is generation-stamped. A disconnect, an account switch or exit
bumps the generation, and every id already handed out stops resolving
immediately — before the map is even cleared.

Bodies are streamed, never buffered whole and never written to disk. A response
is capped at 128 MiB, at most four upstream transfers may run concurrently,
and the request has a 90-second total timeout. Response caching is disabled
with `no-store` headers. The renderer receives the same loopback transport for
post images, posters, videos and GIFs, so signed CDN URLs do not reach the
WebView.

## 5. Opening links

The 0.5.7 interface has no link-opening command and the window receives no
opener capability. Post URLs and website values can be displayed as text, but
neither the frontend nor an IPC caller can ask Rust to launch them.

## 6. Content Security Policy

Previously `null`. Now:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' data: blob: http://127.0.0.1:*;
media-src 'self' blob: http://127.0.0.1:*;
connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*;
object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'
```

The only wildcard is the **port** of the loopback media origin, which is
unavoidable when the port is chosen at runtime. Host and scheme are still
pinned. WebView2 security is not disabled and no browser flags are passed.

`style-src 'unsafe-inline'` is required by the styling approach in use and is a
genuine weakening; it is recorded here rather than hidden.

## 7. iPhone companion bridge

The Windows listener is a separate service from the loopback media proxy. It is
stopped by default, must be started explicitly from Settings, binds to the one
detected private-network interface on an OS-selected port, and is stopped on
request or process shutdown. It never binds `0.0.0.0` and its status response
never includes the bearer token.

Pairing and provider traffic have these gates:

- an eight-digit, one-use pairing code generated from OS randomness;
- five failed pairing attempts trigger a 30-second block;
- a random 32-byte bearer token compared in constant time;
- POST only, exactly `/v1/pair` and `/v1/provider`, with 64 KiB request limits;
- a closed read-operation match in Rust, not a forwarded command name;
- no redirects in the iPhone HTTP client;
- iPhone addresses limited to loopback, link-local, or private IP literals;
- no X cookies, passwords, shell commands, or signed media URLs in the pairing
  response.

**Important limitation:** this first TestFlight bridge uses authenticated plain
HTTP. It does not provision a certificate trusted by both devices, so the
bearer token and returned feed data are not confidential against another device
that can monitor the LAN. It must be used only on a trusted private Wi-Fi
network. Pinned TLS or another authenticated encrypted transport is required
before treating this as a broadly distributable production service.

## 8. Dependency pinning

twitter-cli is pinned to commit `7c634e0d396b1e7af9f63315b414925fe4f29ae7`
(0.8.6), not to a branch. It is the app's entire view of X and its output
contract has already changed under us once. A moving dependency there is a
moving parser here.

## 9. Known limitations

- Installers are **unsigned**. SmartScreen will warn, and that warning is
  correct — nothing verifies these binaries came from anywhere in particular.
- The updater is not configured.
- Secret erasure from memory is best-effort (§1).
- The desktop setup refuses to launch rather than selecting WebView2's default
  AppData profile. It uses a locked per-run profile beside the portable session
  lock, or a locked temp fallback when the portable folder is read-only; stale
  fallback profiles are removed only after their lock can be released.
- The media proxy is reachable by any process running as the same user that
  guesses both the port and a 48-character hex secret within the session.
- The iPhone companion transport is authenticated but unencrypted on the local
  network, as detailed in §7.

## Reporting

This is a personal project with no security contact. Open an issue on the
repository.
