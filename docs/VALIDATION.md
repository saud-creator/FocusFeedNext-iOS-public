# Workspace validation — 19 October 2026

| Check | Result |
| --- | --- |
| Main archive Git blob ID and SHA-256 | Passed; matches pinned upstream blob |
| 0.8.5 archive Git blob ID and SHA-256 | Passed; matches upstream blob and published SHA-256 |
| Both ZIP CRC checks | Passed |
| Archive comparison | 215 unchanged files, 44 modified, 20 added, zero removed |
| Active source after local production build | All 279 archive files still match byte for byte |
| Locked dependency install | Passed with npm ci |
| Frontend lint | Passed with existing warnings |
| TypeScript and Vite production build | Passed |
| Frontend tests | 46 files, 610 tests passed |
| CI configuration | Reviewed: uses tracked source, runs frontend checks, verifies IPA and retains report |
| Shared Rust tests | Not run: Cargo is not installed on this host |
| Swift/WebKit fixtures and iPhone compilation | Not run: this Windows host has no Swift/Xcode/iOS SDK |
| Browser visual checks and physical iPhone tests | Not run in this import |
| GitHub Actions / Codemagic builds | Not triggered |

The first test attempt failed before executing tests because the Windows
sandbox blocked temporary-file renames. The same suite passed when rerun outside
that sandbox. No application code was changed to bypass the failure.

Lint warnings include existing Fast Refresh export warnings, Hook dependency
warnings and warnings on the generated Reader.js bundle. They were not treated
as newly introduced defects or silently changed during import.

The active application source is the pinned upstream 0.8.5 source. This work
changes repository/build integration and documentation; importing the newer
version brings its app fixes into this workspace. It does not claim new device
verification or a new IPA.
