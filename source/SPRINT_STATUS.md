# Sprint status — product correction, provider expansion, performance, release

Started from `afc2be3` (clean tree, 289 Rust + 205 TS = 494 tests).
Old WPF repository at `C:\Users\Developer\Documents\FocusFeed` verified clean
at `8931398` and out of scope for every worker in this sprint.

Verification vocabulary, used in the tables below:

| Mark      | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| **live**  | seen working in the running application                                         |
| **test**  | implemented, covered by automated tests, not yet seen running                   |
| **await** | implemented, but proving it needs a real account mutation the user must approve |
| **todo**  | not started                                                                     |
| **defer** | consciously not in this sprint, with a reason                                   |

---

## Ownership

Agents work in isolated worktrees off the sprint HEAD. **Only agent A touches
`src-tauri/`** — that removes the whole class of Rust merge conflicts, and the
command registration that was silently wrong twice is checked by a test now
(`src-tauri/src/ipc_contract.rs`) rather than by remembering.

| Worker | Owns                                                                                                 | Must not touch                                     |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| main   | `useAppStore.ts`, `api.ts`, i18n catalogs, `App.tsx`, integration, release                           | —                                                  |
| A      | all of `src-tauri/`, `tools/twitter-cli/`                                                            | anything under `src/`                              |
| B      | `src/components/account/`, `AuthorHeader`, `QuotedPostCard`, `Search`, `Profile`, `FollowingManager` | `src-tauri/`, `PostCard`, `Settings`, `Sidebar`    |
| C      | `src/components/media/`, `MediaGallery`, `VideoPlayer`, `PostCard`, `FeedList`, `lib/media*`         | `src-tauri/`, `Search`, `Settings`, `AuthorHeader` |
| D      | `Settings`, `Sidebar`, theme CSS, dead-UI removal, shared state components                           | `src-tauri/`, `PostCard`, `Search`, media          |

Shared files any agent may append to, in a marked region at the end, with the
main agent resolving on merge: `src/i18n/en.ts`, `src/i18n/ar.ts`.

---

## What reading the running interface caught that the tests did not

Three times now, and each one is the same shape — the code existed, the tests
passed, and the feature was not there:

1. **`get_user_profile`** was registered and working for three releases with
   nothing bound to it. That is why every avatar looked clickable and opened
   nothing. Now caught by `ipc_contract`'s fourth check.
2. **Two group-timeline commands** were written and never registered. Caught by
   `ipc_contract` within seconds of the first test run after the merge.
3. **The Settings page** was never rewired to the sections built for it. The
   section wrapper and appearance editor were both complete and both tested;
   the shipped page was still the old instant-persist one. Found by opening the
   page. Nothing but opening it could have found this.

And underneath (3), a fourth: those components used 28 message keys present in
neither catalog, so they would have rendered `appearance.colors` on screen. The
catalog test compares English and Arabic _to each other_ — and they agreed
perfectly, both missing the same 28. There is now a test that extracts every
`t()`/`plural()` key from the source and fails when the catalog has no value
for it.

5. **The startup preload never ran.** Found by sampling `twitter.exe` while the
   installed binary was running: the probe fired, and then nothing, for thirty
   seconds. `preload.rs` was complete and tested, and `spawn_following_sync`
   even documented itself as "shared by the command and by the startup
   preload" — with no startup preload in existence to share it with. There was
   no bookmark worker at all, and `set_event_sink` was never called, so every
   progress event went to a sink that discards them.
6. **The fullscreen and search modules were built and not connected.** Both
   agents produced complete, tested modules — `fullscreen.ts`, `quality.ts`,
   `useAutoHideControls.ts`, `matching.ts`, `useSearchSuggestions.ts` — and
   neither `VideoPlayer.tsx` nor `Search.tsx` imported any of them. 95 passing
   tests, two features absent.

Six occurrences, one shape. The countermeasures that exist catch a command or a
message key; **nothing yet catches a finished component that nothing renders.**
That check is still a person opening the page.

### And a seventh, of a different kind

7. **Two things were wrong in a way no test could have caught, because every
   test agreed with them.** Reading the live session database — 245 posts, 200
   bookmarks, 329 video renditions the account had actually fetched — turned up
   both at once:

   - Every portrait video was labelled by its height, so a 1080×1920 phone clip
     offered _"1920p / 1280p / 852p / 568p"_. Eight variant tests passed. All
     eight used landscape fixtures, where height and shorter side are the same
     number, so the bug was invisible to the entire suite by construction.
   - Three comments stated that advertising was excluded at source and that the
     local filter was a backstop. A live following page was 20 ads in 45 posts,
     requested with `--no-include-promoted`. The filter was never the backstop;
     it was the whole defence. Nothing reaching a reader was ever wrong — but
     the reason it was right was documented backwards.

   The first six were caught by opening the application. This one needed reading
   what the application had _stored_. A fixture can only disagree with the code
   about things whoever wrote the fixture already thought of; production data
   disagrees about the rest.

## Standing constraints

- No real Follow, Unfollow, Bookmark, Unbookmark, Mute or Block without the
  user approving the exact target first. Nothing unattended, ever.
- Never print, log, commit or screenshot `auth_token`, `ct0`, cookies, the child
  environment, signed media URLs, the proxy secret, or private payloads.
- No mock or demo data in a production path, and no fallback to it after an
  error.
- Promoted content stays blocked, with no toggle that enables it.
- Automated tests are not proof that a user-facing feature exists. Every P0
  requirement has to be seen in the running application before it is called
  done.

## Where each requirement stands

**In [PROJECT_STATUS.md](PROJECT_STATUS.md), and only there.**

This document used to carry its own copy of the requirement table. Two tables
tracking one reality is the same drift that produced every defect recorded
above — the copy here was still calling fullscreen video, search suggestions and
media variants "not done" after all three had shipped. It is gone rather than
refreshed.

## Log

| When        | What                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start       | `afc2be3` verified: clean tree, no worktrees, WPF clean at `8931398`, `twitter.exe` 0.8.6 resolving to the single pipx shim at `~\.local\bin\`                                                                                         |
| `7b317f5`   | Foundation: preference schema, navigation history, durable allowlist, first IPC contract test                                                                                                                                          |
| —           | Four worktrees created, four agents launched, **all four hit the session usage limit before writing a single file**. Every worktree verified clean at `7b317f5` with no untracked files. Nothing to salvage.                           |
| `03ae029`   | Provider media patch made reproducible: pinned base, anchored rewriter, hash, installer, rollback                                                                                                                                      |
| `5e9a86d`   | Search suggestions integrated — after the agent's modules were found to be unimported by `Search.tsx`                                                                                                                                  |
| `67a9df8`   | Fullscreen player integrated — same shape of miss, same fix                                                                                                                                                                            |
| `e5d905f`   | Remaining agent commits merged, worktrees empty, lockfile caught up                                                                                                                                                                    |
| `e2b822a`   | **Live data read for the first time.** Portrait video quality labels were inflated by using height; fixed and regression-tested. Three comments claiming ads were excluded at source were corrected — a live page was 44% advertising. |
| `6a2aa94`   | Scroll performance **measured** rather than asserted: 500 → 11 cards, 25,818 → 595 DOM nodes, upward p95 12.0 → 6.1 ms                                                                                                                 |
| `<release>` | 0.4.1: version bumped past the 0.4.0 artifact built from different source, rebuilt, installed, verified                                                                                                                                |

## The IPC contract guard

`src-tauri/src/ipc_contract.rs` reads four sources and checks they agree:
`commands.rs`, the `generate_handler!` list in `lib.rs`, `src/lib/api.ts`, and
`durableStorageKeys` in `useAppStore.ts`.

| Check                                                 | Catches                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `every_declared_command_is_registered`                | a command defined and never handed to `generate_handler!` — compiles, tests green, fails at the IPC boundary on first click |
| `every_registered_command_exists`                     | a stale registration left behind by a rename                                                                                |
| `every_frontend_binding_reaches_a_real_command`       | a typo or a rename on the TypeScript side                                                                                   |
| `every_registered_command_is_bound_or_explained`      | a working command nothing calls, unless it is on `INTENTIONALLY_UNBOUND` with a reason                                      |
| `every_preference_the_frontend_writes_is_allowlisted` | a setting the backend refuses, which the frontend swallows and then forgets on restart                                      |

Four fixtures reproduce the defects that actually shipped and prove the
matching check would have caught each: `follow_account` (defined, never
registered), `load_feed_page` (registered, never bound), a mistyped binding,
and `monitoring.autoCheck` (written, not allowlisted).

**Why source text and not a shared inventory.** `generate_handler!` takes a
literal path list — a shared constant cannot feed it — and there is no runtime
registry to interrogate. A fourth hand-maintained list could drift like the
other three. Reading the real sources is the only version that cannot lie.
`the_parsers_find_something_at_all` fails loudly if a refactor stops the
parsers matching, so a broken parser cannot decay into a vacuously passing
test.

**Known limitation.** The guard sees only `src/lib/api.ts`. A component calling
`invoke` directly is invisible to it. That is deliberate — the single-bridge
convention is what makes the check possible — but it means the convention is
now load-bearing.
