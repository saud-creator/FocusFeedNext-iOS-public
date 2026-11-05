# Candidate-to-native parity checklist

Comparison source: public commit `129c47847bbbd336edd69f05db6780ed19379e56`.
The installed 0.9.0 build 31/source `65CC631F` is the upgrade and physical-device
comparison, not the source baseline. Native build **100.49** compiled and passed
**98 linked tests** plus independent unsigned IPA verification. The rows below
distinguish those automated checks from pending signed-upgrade, live-provider
and physical-device acceptance; they do not assert complete device parity.

| Existing behavior | Candidate source under `source/src` | Native implementation | Qualification |
|---|---|---|---|
| Following, editable Focus, Originals without reposts | `pages/FeedScreen.tsx`, `Following.tsx`, `FocusFeed.tsx`, `Originals.tsx`, `hooks/useFeed.ts` | `FeedViewController`, `TimelineRepository`, `FiltersViewController`, Rust feed filtering | Core ordering/filter and native feed/filter/refresh fixtures pass; live pages and device reading remain pending |
| Ordered, uncapped bookmarks and cursor traversal | `pages/Bookmarks.tsx`, feed/provider commands | Shared Rust ordered IDs/cursors, native feed | Core index/cursor/eviction and native window rehydration fixtures pass; complete live traversal remains pending |
| Bookmark comments and articles | `components/post/BookmarkComments.tsx`, `ArticleReader.tsx` | `CommentsViewController`, `ArticleViewController`, core normalized parsing | Parser/model regressions and native compilation pass; provider content, pagination and on-device reading remain pending |
| People progress, search, pins and allowed relationships | `pages/FollowingManager.tsx` | `PeopleViewController`, typed adapter and action phases | Core permission/action and native 400-account collection/search/progress fixtures pass; live relationship outcomes remain pending |
| Account-scoped local Lists, members and merged timelines | `pages/Groups.tsx`, durable List storage | `ListsViewController`, core durable Lists and group feed | Durable/migration, core pagination and native List-window/member-progress fixtures pass; merged live pagination and partial-failure acceptance remain pending |
| Independent profile identity and posts | `pages/Profile.tsx` | `ProfileViewController`, separate profile/feed jobs | Native compilation and profile navigation fixtures pass; provider identity/count/link and independent-loading acceptance remain pending |
| Cached text search | `pages/LocalSearch.tsx` | `SearchViewController`, core search, author/date/media refinement | Core search and native pagination, stable Return to place and stale query/account-result regressions pass; device filter usability remains pending |
| Full post text, quotes, attribution, mentions and read/hide | `components/post/PostCard.tsx`, `PostText.tsx` | `PostCell`, TextKit, core read/hide | Unicode/collapse/link-boundary, Arabic large-text layout and read-state media-preservation fixtures pass; physical mixed-direction reading and VoiceOver remain pending |
| Photo/avatar/GIF/inline/fullscreen media | `MediaGallery.tsx`, `VideoPlayer.tsx`, public 0.9.1 repairs | `PhotoTile`, `InlinePlayerView`, `NativeMediaService`, `NativeMediaPresenter`, shared Rust broker | Image decoding, retry/ownership/broker-rotation fixtures and 100 real loopback socket restarts pass; physical AVKit/live-CDN interruption acceptance remains pending |
| Private X login and transaction engine | `pages/IosConnection.tsx`, native provider plugin | `NativeHostService`, `NativeHostAdapter`, isolated WebKit | Transaction, generated-bridge and simulator Keychain checks pass; signed identity/upgrade and live X sign-in remain pending |
| Existing durable preferences and version-1 portable bundle | `pages/Settings.tsx`, preference/durable modules | One `SettingsDraft`, native settings subpages, same validated keys | Core preferences/migration, native import-validation and Settings draft-cancel fixtures pass; signed preservation and on-device import/export remain pending |
| Diagnostics without credentials or signed media URLs | `pages/Diagnostics.tsx`, connection/media reports | Native diagnostics, bounded `ConnectionJournal`, typed broker provenance | Redaction, bounded-journal and failure-provenance regressions pass; owner-exported device report review remains pending |

The native-only additions are pull-to-refresh with retained content on failure,
tab re-tap and temporary Return to place, named filter presets, native member
pickers and optional reading resume. Presets and reading markers use separate
account-scoped metadata and do not enter the version-1 portable preference bundle.

See [the acceptance record](NATIVE_ACCEPTANCE.md) for the exact packaged source,
test receipt, toolchain and checksum. Automated fixture/package results do not
establish signed-upgrade preservation, live-provider behavior or physical-device
performance, energy and accessibility acceptance.
