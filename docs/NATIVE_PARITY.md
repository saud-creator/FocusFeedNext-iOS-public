# Candidate-to-native parity checklist

Comparison source: public commit `129c47847bbbd336edd69f05db6780ed19379e56`.
The installed 0.9.0 build 31/source `65CC631F` is the upgrade and physical-device
comparison, not the source baseline. This checklist maps implementation; each row
still requires a successful native build and its relevant device/provider checks.

| Existing behavior | Candidate source under `source/src` | Native implementation | Qualification |
|---|---|---|---|
| Following, editable Focus, Originals without reposts | `pages/FeedScreen.tsx`, `Following.tsx`, `FocusFeed.tsx`, `Originals.tsx`, `hooks/useFeed.ts` | `FeedViewController`, `TimelineRepository`, `FiltersViewController`, Rust feed filtering | Core ordering/filter tests pass; native fixtures and live pages pending |
| Ordered, uncapped bookmarks and cursor traversal | `pages/Bookmarks.tsx`, feed/provider commands | Shared Rust ordered IDs/cursors, native feed | Core index/eviction tests pass; complete live traversal pending |
| Bookmark comments and articles | `components/post/BookmarkComments.tsx`, `ArticleReader.tsx` | `CommentsViewController`, `ArticleViewController`, core normalized parsing | Parser tests pass; native/provider qualification pending |
| People progress, search, pins and allowed relationships | `pages/FollowingManager.tsx` | `PeopleViewController`, typed adapter and action phases | Core permission/action tests pass; native/live outcomes pending |
| Account-scoped local Lists, members and merged timelines | `pages/Groups.tsx`, durable List storage | `ListsViewController`, core durable Lists and group feed | Durable/migration tests pass; merged live pagination and partial-failure qualification pending |
| Independent profile identity and posts | `pages/Profile.tsx` | `ProfileViewController`, separate profile/feed jobs | Source mapping complete; provider identity/count/link checks pending |
| Cached text search | `pages/LocalSearch.tsx` | `SearchViewController`, core search, author/date/media refinement | Shared parser/search regressions pass; native pagination/read-state checks pending |
| Full post text, quotes, attribution, mentions and read/hide | `components/post/PostCard.tsx`, `PostText.tsx` | `PostCell`, TextKit, core read/hide | Unicode/model fixtures authored; Arabic and VoiceOver device checks pending |
| Photo/avatar/GIF/inline/fullscreen media | `MediaGallery.tsx`, `VideoPlayer.tsx`, public 0.9.1 repairs | `PhotoTile`, `InlinePlayerView`, `NativeMediaService`, `NativeMediaPresenter`, shared Rust broker | Transfer/security regressions pass; native decoding and interruption matrix pending |
| Private X login and transaction engine | `pages/IosConnection.tsx`, native provider plugin | `NativeHostService`, `NativeHostAdapter`, isolated WebKit | Foundation transaction tests pass; signed Keychain/provider acceptance pending |
| Existing durable preferences and version-1 portable bundle | `pages/Settings.tsx`, preference/durable modules | One `SettingsDraft`, native settings subpages, same validated keys | Shared preference/migration tests pass; signed upgrade and native import/export checks pending |
| Diagnostics without credentials or signed media URLs | `pages/Diagnostics.tsx`, connection/media reports | Native diagnostics, bounded `ConnectionJournal`, typed broker provenance | Redaction/proxy regressions pass; native exported report review pending |

The native-only additions are pull-to-refresh with retained content on failure,
tab re-tap and temporary Return to place, named filter presets, native member
pickers and optional reading resume. Presets and reading markers use separate
account-scoped metadata and do not enter the version-1 portable preference bundle.

Release qualification is recorded in NATIVE_ACCEPTANCE.md. Source presence does
not establish UI parity, measured performance, a verified IPA or device acceptance.
