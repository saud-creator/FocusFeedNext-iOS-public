# FocusFeedNext iOS 0.8.4

Signing in could successfully verify the account through URLSession while the
Following feed, bookmarks and account lists still depended on WebKit fetch.
Version 0.8.4 connects the isolated reader engine to native URLSession HTTP for
homepage metadata, public client bundles and authenticated API requests.

- Native requests use the current private cookie store and CSRF cookie. Response
  cookie changes are installed before the next request. Credentials never go to
  the metadata CDN; redirects are rejected; responses and deadlines are bounded.
- Current persisted query IDs and required feature arguments are parsed from
  X's client metadata before the first feed request. Downloaded scripts are
  treated only as text. Following account queries use GET.
- Reads can retry a temporary network/server failure once. Sent account writes
  are not automatically replayed. Rate limits and authentication refusals retain
  their real HTTP status and diagnostic stage.
- Google sign-in no longer raises the unsupported-browser alert. X email and
  username sign-in remains available, with automatic capture after sign-in and
  Continue as a manual fallback. Reload and diagnostic sharing are in the menu.
- An initial feed failure does not claim cached posts exist or blame filters.
  Cached posts remain visible after a subsequent refresh fails. iPhone feed
  failures expose the failed stage/status and diagnostic sharing directly.

The exact editable source is in `source/` and `FocusFeedNext-source.zip`; CI
checks their bytes agree. Build evidence and the unsigned device IPA are saved
under `release/0.8.4/`. The IPA needs the user's own iOS signing to install.

Verification includes the frontend suite, shared Rust suite, and the actual
compiled reader running in WebKit through the production native HTTP bridge to
a loopback fixture server. Browser fetch is disabled for these content tests.
Fixtures cover timeline posts, bookmarks, profiles, following accounts, current
query IDs, new feature arguments and rotated CSRF, plus transport restrictions.
These tests do not constitute a live X account or physical iPhone acceptance test.

On the device: install the updated signed build, open Following and refresh,
then check Saved and Accounts. If a live request fails, use **Share diagnostic
file** on the feed screen and send the JSON report. It contains fixed operation
names, status, stage and safe numeric errors; no tokens, passwords or post text.
