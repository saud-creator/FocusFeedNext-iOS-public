# Updating Focus Feed Next

Two things can be updated independently: the application, and the provider it
reads X through. They fail in different ways, so they are separated here.

## The application

There is no signed in-app auto-updater yet. The current release identifies
itself in Settings → About and in the diagnostic report, so an installed copy
can be compared with a new portable release without guessing which binary is
running. Builds are produced locally and packaged by hand:

```powershell
npm.cmd run portable
```

The portable workflow writes a versioned folder under `dist-portable\`:

| Artifact       | Path |
| -------------- | ---- |
| Executable     | `dist-portable\FocusFeedNext-v<version>\FocusFeedNext.exe` |
| Shortcut       | `dist-portable\FocusFeedNext-v<version>\FocusFeedNext.lnk` |
| Hash           | `dist-portable\FocusFeedNext-v<version>\SHA256.txt` |

The packaging step removes older versioned `FocusFeedNext-v*` folders directly
under `dist-portable`, then refreshes the Desktop shortcut and the existing
Focus Feed Next taskbar pin to the new absolute executable path. This keeps one
portable release and one launch target in normal use.

The Tauri build also writes its normal native artifacts under
`src-tauri\target\release\`:

| Artifact       | Path                                                          |
| -------------- | ------------------------------------------------------------- |
| Executable     | `release\focus-feed-next.exe`                                 |
| MSI            | `release\bundle\msi\Focus Feed Next_<version>_x64_en-US.msi`  |
| NSIS installer | `release\bundle\nsis\Focus Feed Next_<version>_x64-setup.exe` |

**Bump the version before building** — `package.json`, `package-lock.json`,
`src-tauri\Cargo.toml`, `src-tauri\Cargo.lock` and `src-tauri\tauri.conf.json`.
A build that shares a version with
the one already installed is a build nobody can tell apart from it, and that
has already caused a session of verifying stale binaries and concluding
features were missing when they were merely not installed.

The portable EXE is the app artifact: it carries the frontend resources and
does not install under `%LOCALAPPDATA%`. Allowlisted preferences, account
identity and account-scoped local List definitions live in
`.focusfeed-next\preferences.db` beside the EXE. The fetched-content database
is in memory; the per-run directory contains only the cleanup lock and private
WebView2 profile, while the bounded media proxy keeps bytes and registrations in
memory and sends logs to the process stream. All of that run state is dropped
or deleted on exit. The auth cookies remain in Windows Credential Manager by
design; putting them in a portable file would make the release less safe, not
more portable.

The adjacent shortcut points to the exact versioned EXE and uses its folder as
the working directory. If the portable folder is moved, run the packaging
script again so Windows receives the new absolute target for the Desktop and
taskbar shortcuts.

## The provider

Focus Feed Next reads X through `twitter-cli`, pinned to one commit and carrying
the project provider patches. Both are managed by a single script:

```powershell
.\tools\twitter-cli\install-focusfeed-twitter-cli.ps1
```

Read `tools\twitter-cli\README.md` before changing anything there. The two rules
that matter:

1. **Install through pipx, into the environment the app already resolves.** The
   app finds the provider via `FFN_TWITTER_CLI`, then `PATH`, then
   `~\.local\bin`. Two installations means the app keeps using whichever the
   PATH finds first, and a patch applied to the other one looks as though it
   did nothing.
2. **Never hand-edit `site-packages`.** An edit nobody can repeat is an edit
   that vanishes the next time the provider is reinstalled, taking video
   quality selection with it.

To go back to unpatched upstream:

```powershell
.\tools\twitter-cli\install-focusfeed-twitter-cli.ps1 -Rollback
```

Video keeps playing after a rollback; the quality menu collapses to the single
honest entry. Bookmarks still use the app's bounded keyset viewport, but a
provider that cannot perform the exhaustive bookmark traversal cannot prove a
complete total. That is the pre-patch provider limitation.

## Changing the pin

1. Update `tools\twitter-cli\PINNED_UPSTREAM_COMMIT.txt`.
2. Update `PINNED_COMMIT` and `PINNED_VERSION` in
   `src-tauri\src\providers\twitter_cli.rs`.
3. Run the installer. It refuses if the upstream source no longer contains the
   context the patch depends on — **re-derive the patch rather than forcing
   it.** A half-applied patch produces a build that imports and parses wrongly,
   which is worse than one that would not install.
4. Rebuild the app so the expected patch hash in Diagnostics matches.

## Verifying an update

The one lesson this project keeps relearning: a passing test suite is not
evidence that a feature reached the product. Three separate times a feature was
complete in code, green in tests, and absent from the running application —
once because a command was never registered, once because a page was never
wired to the components built for it, once because a background worker was
never started.

So after installing, open the application and confirm:

- the connection chip resolves out of "Checking"
- exactly one `twitter.exe` during startup
- a feed loads
- after the probe finishes, background work continues briefly — that is the
  preload; if the process count drops to zero and stays there, it did not start
- video plays, and offers more than one quality if the provider patches are installed
- Bookmarks continue loading in the background until the provider reports no
  more rows; navigation reads bounded older/newer keyset slices rather than
  copying the complete order into one frontend cache value
- Diagnostics reports the expected pin and provider patch hashes
- closing the app leaves no process, no `twitter.exe`, and no session directory
