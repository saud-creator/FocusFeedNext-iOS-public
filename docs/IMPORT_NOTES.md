# Import record — 19 October 2026

Publication note (22 October 2026): the current root ZIP and source documents
have since been sanitized to remove personal machine paths and two screenshots
containing those paths. The original hashes and byte-preservation statements
below describe the historical import, not the sanitized files now on disk.

## Sources

Repository: [saud-creator/FocusFeedNext-iOS](https://github.com/saud-creator/FocusFeedNext-iOS).

| Source | Pinned upstream commit | Role |
| --- | --- | --- |
| main | `466a1e30ad59c96c480cd6f39865ea8a2bdad152` | Original root archive, GitHub workflow, build script and Codemagic configuration |
| codex/ios-0.8.5-stability | `8ea9e1b5de404ce52909a9533fbbd51d12179a10` | Active editable 0.8.5 application and upstream recovery notes |

The connected account exposes this Focus repository. Other available branches
were 0.8.1 sign-in, 0.8.2 transport, 0.8.3 login recovery and 0.8.4 feed recovery.
The 0.8.5 archive contains their recovery changes; its source was compared
directly with main's archive. Every file in main's source archive is retained in
the newer source. The JSON comparison lists additions and byte changes.

GitHub's comparison reported the stability branch **24 commits ahead and 3
behind main**, with merge base
`e651543602879ed292e0d5516a26ab54dc372044`. This import does not claim that the
branches were merged through Git. Root configuration from main was retained
and deliberately adapted to the newer editable source.

## Import method and local history

The starting project contained only an empty Git repository, with no app files,
commits or remote. There was no pre-existing local app version to merge.

The GitHub plugin could read the private repository. Local HTTPS Git had no
working credentials and could not fetch it. Pinned archives and text files were
therefore downloaded through the authorized connector.

The local `main` root commit is a snapshot of the four upstream main files.
Its commit identity differs from upstream. The improvement branch starts from
that local snapshot. `origin` points to the original GitHub repository; there
are no remote-tracking branches because fetching history did not succeed.
No GitHub branch, pull request, release or workflow run was created.

When local Git authentication is available, fetch origin, create a fresh branch
from `origin/main`, and replay the reviewed integration there. Do not push the
snapshot branch over upstream main or force unrelated histories together.

## Integration choices

1. Preserve the original main ZIP unchanged. Its SHA-256 and Git blob ID are
   checked in `SOURCE_IMPORT.json`.
2. Extract the pinned 0.8.5 archive into `source/`, preserving its shared
   application, native plugin, tests, fixtures, assets, dependency locks and
   license/provenance files. The archive's SHA-256 matches the checksum
   published on the stability branch.
3. Retain main's GitHub Actions and Codemagic build options. Both now require
   the tracked source instead of unzipping an obsolete archive over it.
4. Replace the root build-script duplicate with a delegating entry point.
   This avoids overwriting the 0.8.5 build script with main's old build number.
5. Run frontend checks before CI device builds and verify the packaged IPA
   version, architecture, identity and unsigned state afterward.
6. Add LF line-ending rules and ignore local import/dependency caches.
7. Add a current project entry point and a staged app improvement plan.

## Verification boundary

See `VALIDATION.md` for checks run in this workspace. The upstream 0.8.5 note
reports earlier frontend, Rust and browser checks; those are historical results
and are not substituted for local evidence.

Windows cannot compile the Apple native target. The newer branch did not
contain a newly built 0.8.5 IPA. Real iPhone login, cellular loading, native
fullscreen and lifecycle behavior remain device acceptance gates.

## Main publication update, 19 October 2026

The user authorized direct-main publication. Commit 8115405 imported the
editable 0.8.5 tree with the original upstream main head 466a1e3 as parent.
Follow-up build corrections are ordinary descendants (49d4030, 404f708).
No unrelated local snapshot commits were pushed and no force update was used.
Codemagic main push builds and the webhook are now active. The earlier manual
import notes above remain a historical record of the initial workspace state.

## iOS 27 runner corrections, 20 October 2026

Build #6 exported the native launch crash and screenshots. The app terminated in UIKit scene lifecycle validation before rendering. Commit 2b88b56 adds the static Tao scene manifest and the upstream Tao #1245 ownership fix, with crate provenance retained. This is separate from the 0.8.6 app repair candidate. Both the simulator and final IPA checks retain the iOS 16 deployment minimum.
