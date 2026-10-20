/**
 * Typed bridge to the Rust backend.
 *
 * These types mirror the stable internal models in `src-tauri/src/models.rs`.
 * Components import from here and never learn which provider served the data.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RuntimeSnapshot } from './runtime';
let chromeRevision=Date.now()*1000;
const nextChromeRevision=()=>chromeRevision=Math.max(chromeRevision+1,Date.now()*1000);
let mediaRevision=Date.now()*1000;
const nextMediaRevision=()=>mediaRevision=Math.max(mediaRevision+1,Date.now()*1000);

export type MediaKind = "image" | "video" | "gif";

export interface MediaVariant {
  label: string;
  url: string;
  bitrate?: number | null;
}

export interface PostMedia {
  kind: MediaKind;
  url: string;
  previewUrl?: string | null;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  durationMs?: number | null;
  variants: MediaVariant[];
}

export interface Author {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  /** twitter-cli 0.8.5 publishes no banner, so this is null on live data. */
  bannerUrl?: string | null;
  verified: boolean;
  bio?: string | null;
  followersCount?: number | null;
  followingCount?: number | null;
  location?: string | null;
  /** The account's own website, not a link to its profile. */
  website?: string | null;
  /** RFC3339. Rendered as "Joined ...". */
  joinedAt?: string | null;
  postsCount?: number | null;
}

export interface PostMetrics {
  replies: number;
  reposts: number;
  likes: number;
  quotes: number;
  views: number;
  bookmarks: number;
}

/**
 * A quoted post.
 *
 * Deliberately shallow: twitter-cli serialises a quote as only id, text and an
 * author carrying just a handle and display name. There is no timestamp, no
 * metrics and no media, so `createdAt` is optional and the card omits it rather
 * than showing a value that was never sent.
 */
export interface QuotedPost {
  id: string;
  author: Author;
  text: string;
  createdAt?: string | null;
  media: PostMedia[];
  url?: string | null;
}

export interface Post {
  id: string;
  text: string;
  author: Author;
  createdAt: string;
  lang?: string | null;
  isRepost: boolean;
  repostedBy?: Author | null;
  isPromoted: boolean;
  quoted?: QuotedPost | null;
  metrics: PostMetrics;
  media: PostMedia[];
  url?: string | null;
  isArticle: boolean;
  articleTitle?: string | null;
  inReplyTo?: string | null;
  provider: string;
}

export interface PostContent {post:Post;article:{title:string;blocks:{kind:string;text:string}[]}|null}

export interface FeedFilters {
  hidePromoted: boolean;
  hideReposts: boolean;
  hideRead: boolean;
  unreadOnly: boolean;
  imagesOnly: boolean;
  videosOnly: boolean;
  textOnly: boolean;
  maxAgeHours: number;
  mutedWords: string[];
  languages: string[];
}

export const defaultFilters: FeedFilters = {
  hidePromoted: true,
  hideReposts: false,
  hideRead: false,
  unreadOnly: false,
  imagesOnly: false,
  videosOnly: false,
  textOnly: false,
  maxAgeHours: 0,
  mutedWords: [],
  languages: [],
};

export interface FeedResponse {
  posts: Post[];
  fromCache: boolean;
  provider: string;
  lastSync?: string | null;
  readIds: string[];
  totalCached: number;
  /** Cursor for the next live page; absent on cached/non-pageable answers. */
  nextCursor?: string | null;
}

export type BookmarkDirection = "older" | "newer" | "oldest" | "newest";

export interface BookmarkSliceRequest {
  anchorPosition?: number;
  direction: BookmarkDirection;
  limit: number;
}

export interface BookmarkSlice {
  posts: Post[];
  firstPosition: number | null;
  lastPosition: number | null;
  totalDiscovered: number;
  syncComplete: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  readIds: string[];
}

export interface DashboardStats {
  totalPosts: number;
  unreadCount: number;
  newCount: number;
  pinnedCount: number;
  groupCount: number;
  hiddenCount: number;
  readToday: number;
  lastSync?: string | null;
  cacheBytes: number;
}

export interface ProviderStatus {
  activeProvider: string;
  liveAvailable: boolean;
  authenticated: boolean;
  twitterCliVersion?: string | null;
  agentReachVersion?: string | null;
  agentReachInstalled: boolean;
  activeBackend?: string | null;
  message: string;
  usingMock: boolean;
}

export type RuntimePlatform = "windows" | "ios" | "macos" | "android" | string;

/** Safe pairing details shown by Windows. The bearer token never reaches JS. */
export interface CompanionHostStatus {
  running: boolean;
  address?: string | null;
  port?: number | null;
  pairingCode?: string | null;
  pairedOnce: boolean;
}

export interface ChannelHealth {
  key: string;
  name: string;
  status: string;
  message: string;
  tier: number;
  backends: string[];
  activeBackend?: string | null;
}

export interface HealthReport {
  agentReachInstalled: boolean;
  agentReachVersion?: string | null;
  channels: ChannelHealth[];
  twitterStatus?: string | null;
  checkedAt: string;
  error?: string | null;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  memberCount: number;
}

export interface AccountList {
  id: string;
  accountId: string;
  name: string;
  color: string;
  memberIds: string[];
}

/** One group member that could not be read on this pass. */
export interface AccountFailure {
  username: string;
  code: string;
  /** Already sanitised by the backend. Safe to show. */
  message: string;
}

/**
 * One slice of a group refresh.
 *
 * Extends the ordinary feed response with what went wrong and where to
 * continue, so a group of twenty accounts can render after the first few
 * rather than after all of them.
 */
export interface GroupFeedResponse extends FeedResponse {
  failures: AccountFailure[];
  /** Where the next call starts, or null when every member has been read. */
  nextOffset?: number | null;
  memberCount: number;
  loadedAccounts: number;
}

/** One row of the group member picker. */
export interface GroupCandidate {
  author: Author;
  /** True when the account is in the connected user's real Following list. */
  following: boolean;
  /** True when the account is already a member of the group asked about. */
  member: boolean;
}

/** What the app knows about the Following list right now. */
export interface FollowingSnapshot {
  /** Everything obtained so far, in X's own order. */
  accounts: Author[];
  /**
   * True only when a traversal reached the end of the list. A partial first
   * batch, a cancelled run and a run stopped by the request ceiling all leave
   * this false: "we have some of them" must not render as "this is who you
   * follow".
   */
  complete: boolean;
  /** True while a traversal is running. */
  syncing: boolean;
  state?: 'idle' | 'loading' | 'complete' | 'failed' | 'cancelled';
  lastError?: string | null;
  lastProgressAt?: string | null;
}

/**
 * A background progress event.
 *
 * Emitted on `following:progress` and `bookmarks:progress`. `total` is absent
 * unless the account's own profile stated a follow count — a progress bar with
 * an invented denominator is a progress bar that lies.
 */
export interface PreloadProgress {
  loaded: number;
  done: boolean;
  stage: "starting" | "batch" | "complete" | "cancelled" | "failed";
  total?: number;
  /** Sanitised. Present on `failed` only. */
  message?: string;
}

export const FOLLOWING_PROGRESS_EVENT = "following:progress";
export const BOOKMARKS_PROGRESS_EVENT = "bookmarks:progress";

export interface XList {
  id: string;
  name: string;
  description?: string | null;
  memberCount?: number | null;
}

export interface AppError {
  code: string;
  message: string;
  repair?: string | null;
  nativeConnectionFault?: { code: string; stage: string; requestId?: string | null; retryable: boolean; httpStatus?: number | null; nativeErrorCode?: number | null; nativeErrorDomain?: string | null };
}
export interface ConnectionTiming { requestId:string; queueMs:number; bootstrapMs:number; providerMs:number; parseMs:number; totalMs:number; nativeMs:number }

/** Green / yellow / red / grey. Colour is never the only cue in the UI. */
export type SessionState =
  "connected" | "degraded" | "expired" | "disconnected";

/** Why we are in that state. Maps 1:1 onto an i18n key. */
export type SessionReason =
  | "no_credentials"
  | "not_checked"
  | "checking"
  | "ok"
  | "request_failed"
  | "rate_limited"
  | "offline"
  | "stale"
  | "auth_failed"
  | "tool_missing";

/**
 * Everything the interface knows about the connection.
 *
 * Note what is absent: there is no field that could carry `auth_token` or
 * `ct0`. Credential state reaches the frontend as the boolean
 * `hasCredentials` and nothing more, and a backend test serialises this type
 * to prove no token can appear in it.
 */
export interface SessionSnapshot {
  state: SessionState;
  reason: SessionReason;
  checking: boolean;
  account?: Author | null;
  checkedAt?: string | null;
  lastSuccessAt?: string | null;
  /**
   * Elapsed time of the last successful health request, in milliseconds —
   * measured from before the provider operation starts until its structured
   * result is parsed. Not an ICMP ping. `null` when nothing has completed;
   * a failure never overwrites it with the time it took to fail.
   */
  latencyMs?: number | null;
  hasCredentials: boolean;
  /** Sanitised English detail for Diagnostics only; the UI shows `reason`. */
  detail?: string | null;
}

/**
 * Where this run's content is held and how much of it there is.
 *
 * Named `StorageUsage` rather than `SessionStorage` deliberately: the latter
 * reads as the browser API, which this app is forbidden from using.
 */
/**
 * What the pinned twitter-cli build can actually do.
 *
 * Every field is a statement about the installed backend, checked against its
 * own `--help` and its real responses.
 *
 * Nothing here describes search. The CLI can still do it; this app has no way
 * to ask — `XDataProvider` has no free-text method — and what the interface
 * needs to know is what it can offer, not what the backend could in principle.
 */
export interface ProviderCapabilities {
  feedCursor: boolean;
  listCursor: boolean;
  followingCursor: boolean;
  userPostsCursor: boolean;
  promotedFlag: boolean;
  unfollow: boolean;
  follow: boolean;
  unbookmark: boolean;
  /** False on the pinned build: twitter-cli 0.8.6 has no `mute` subcommand. */
  mute: boolean;
  /** False for the same reason as `mute`. */
  block: boolean;
}

export interface StorageUsage {
  directory?: string | null;
  bytes: number;
  inMemory: boolean;
}

/** True when running inside the Tauri shell (false in unit tests / plain web). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    return e as AppError;
  }
  return { code: "unknown", message: String(e) };
}

// --- commands --------------------------------------------------------------

export const api = {
  connectionMetrics: () => invoke<ConnectionTiming[]>("get_connection_metrics"),
  runtimeSnapshot: () => invoke<RuntimeSnapshot>("runtime_snapshot"),
  cancelNativeReads: () => invoke<void>("cancel_native_reads"),
  setPreferencesBatch: (entries: [string, string][], portable = false) => invoke<void>("set_preferences_batch", { entries, portable }),
  sharePreferences: (entries: [string,string][]) => invoke<void>("share_preferences", { entries }),
  searchCachedPosts: (query: string, offset = 0) => invoke<{ posts: Post[]; readIds: string[]; nextOffset: number | null }>("search_cached_posts", { query, offset }),
  providerStatus: () => invoke<ProviderStatus>("get_provider_status"),
  runtimePlatform: () => invoke<RuntimePlatform>("runtime_platform"),
  iphoneCompanionStatus: () =>
    invoke<CompanionHostStatus>("iphone_companion_status"),
  startIphoneCompanion: () =>
    invoke<CompanionHostStatus>("start_iphone_companion"),
  stopIphoneCompanion: () =>
    invoke<CompanionHostStatus>("stop_iphone_companion"),
  healthCheck: (force = false) =>
    invoke<HealthReport>("run_health_check", { force }),
  reconnect: () => invoke<ProviderStatus>("reconnect_provider"),

  // -- X connection ---------------------------------------------------------
  //
  // The two values travel in one call and are never returned. The backend
  // validates them against X before anything durable changes, so a failed
  // attempt leaves the previous working connection untouched.
  connect: (authToken: string, ct0: string) =>
    invoke<SessionSnapshot>("connect_x_account", { authToken, ct0 }),
  signInIos: () => invoke<SessionSnapshot>("sign_in_ios"),
  uiTestFixture: () => invoke<{scenario:string;image:string;video:string;failedImage:string}|null>("get_ui_test_fixture"),
  setIosChromeVisible: (visible: boolean) => invoke<void>("set_ios_chrome_visible", {visible,revision:nextChromeRevision()}),
  presentIosMedia: (items: {url:string;kind:'image'|'video';alt?:string|null}[], index:number, options: {position?:number;playing?:boolean;speed?:number;muted?:boolean;loopPlayback?:boolean;retryLabel?:string;locale?:string} = {}) =>
    invoke<{index:number;position:number;playing:boolean}>("present_ios_media",{items,index,...options,revision:nextMediaRevision()}),
  dismissIosMedia: () => invoke<void>("dismiss_ios_media",{revision:nextMediaRevision()}),
  shareConnectionReport: () => invoke<void>("share_connection_report"),
  configureIosChrome: (labels: string[], selected: string, dark: boolean, visible = true, routes?: string[], accent = '', haptics = true, rtl = document.documentElement.dir === 'rtl', accessibilityLabels?: string[], followSystem = false) =>
    invoke<boolean>("configure_ios_chrome", { labels, selected, dark, visible, routes, accent, haptics, rtl, accessibilityLabels,followSystem,revision:nextChromeRevision() }),
  connectIphoneCompanion: (address: string, code: string) =>
    invoke<SessionSnapshot>("connect_iphone_companion", { address, code }),
  /** `force` skips the conservative re-check interval the backend enforces. */
  checkSession: (force = false) =>
    invoke<SessionSnapshot>("check_session", { force }),
  sessionStatus: () => invoke<SessionSnapshot>("session_status"),
  disconnect: () => invoke<SessionSnapshot>("disconnect_x_account"),
  hasCredentials: () => invoke<boolean>("has_credentials"),
  storageUsage: () => invoke<StorageUsage>("session_storage"),

  cachedFeed: (feed: string, filters: FeedFilters, limit = 60) =>
    invoke<FeedResponse>("get_cached_feed", { feed, filters, limit }),
  bookmarkSlice: (
    request: BookmarkSliceRequest,
    filters: FeedFilters,
  ) => invoke<BookmarkSlice>("get_bookmark_slice", { request, filters }),
  refreshFeed: (feed: string, filters: FeedFilters, max = 30, limit = 60) =>
    invoke<FeedResponse>("refresh_feed", { feed, max, filters, limit }),
  /**
   * Continue a feed from a cursor the backend previously returned.
   *
   * Only `feed` and `list` return one — see `supportsPagination`. The cursor
   * round-trips through here, so the backend re-validates it before it can
   * reach a command line; a malformed one is refused rather than repaired,
   * because silently dropping it would re-fetch page one and read as duplicate
   * posts.
   */
  loadFeedPage: (
    feed: string,
    cursor: string,
    filters: FeedFilters,
    max = 30,
    limit = 200,
  ) =>
    invoke<FeedResponse>("load_feed_page", {
      feed,
      cursor,
      max,
      filters,
      limit,
    }),
  /// Whether the backend can fetch beyond the first batch. True since
  /// twitter-cli 0.8.6, which added `--cursor` to `feed` and `list`. Ask rather
  /// than assume: this was hardcoded `false` for 0.8.5 and had to be unwound.
  supportsPagination: () => invoke<boolean>("supports_pagination"),
  /// Everything the pinned backend can do. Drives which controls exist at all.
  providerCapabilities: () =>
    invoke<ProviderCapabilities>("provider_capabilities"),

  // No `openXUrl`, `openExternal` or permalink builders. Nothing in the
  // interface opens a browser, so the backend no longer exposes a command that
  // could — see the note above `get_data_dir` in commands.rs.
  post: (id: string) => invoke<Post | null>("get_post", { id }),
  postContent: (id:string) => invoke<PostContent>("refresh_post_content",{id}),
  probeMedia: (url:string) => invoke<number>("probe_media",{url}),
  /**
   * One account's profile, fetched live.
   *
   * Backs the internal profile page. The command has existed since 0.1.0 and
   * was registered the whole time, but nothing bound it — which is why every
   * avatar in the app looked clickable and opened nothing.
   */
  userProfile: (username: string,refresh=false) =>
    invoke<Author>("get_user_profile", { username,refresh }),
  accountRelationship: (username: string) => invoke<'following' | 'notFollowing' | 'pending' | 'unknown'>("get_account_relationship", { username }),
  openCreatorSubscription: (username: string) => invoke<void>("open_creator_subscription", { username }),
  postsByAuthors: (authorIds: string[], limit = 60) =>
    invoke<Post[]>("get_posts_by_authors", { authorIds, limit }),

  setRead: (postId: string, read: boolean) =>
    invoke<void>("set_read", { postId, read }),
  markManyRead: (postIds: string[]) =>
    invoke<void>("mark_many_read", { postIds }),
  readIds: () => invoke<string[]>("get_read_ids"),
  hidePost: (postId: string, hidden: boolean) =>
    invoke<void>("hide_post", { postId, hidden }),
  recentActivity: (limit = 8) =>
    invoke<Post[]>("get_recent_activity", { limit }),

  pinAccount: (authorId: string, pinned: boolean) =>
    invoke<void>("pin_account", { authorId, pinned }),
  pinnedAccounts: () => invoke<Author[]>("get_pinned_accounts"),
  knownAccounts: () => invoke<Author[]>("get_known_accounts"),
  /**
   * A fast first batch, fetched live.
   *
   * 30 accounts cost about 2 seconds; the whole list of a 191-follow account
   * costs 36, because `following` has no cursor and twitter-cli assembles the
   * entire batch before returning anything. Render this, then call
   * `startFollowingSync` and listen for `following:progress`.
   */
  followingAccounts: () => invoke<Author[]>("get_following_accounts"),
  /** Everything obtained so far, read from this session's store. No network. */
  followingSnapshot: () => invoke<FollowingSnapshot>("get_following_snapshot"),
  /**
   * Begin obtaining the complete Following list in the background.
   *
   * Returns false when a traversal is already running, which is a normal
   * answer rather than a failure. Progress arrives on `following:progress`.
   */
  startFollowingSync: () => invoke<boolean>("start_following_sync"),
  /**
   * Who may be added to a group.
   *
   * Backed by the real Following list, not by every author ever seen. Members
   * who are no longer followed are still returned with `following: false` —
   * dropping them would let an unfollow quietly edit the reader's group.
   */
  groupCandidates: (groupId: string) =>
    invoke<GroupCandidate[]>("get_group_candidates", { groupId }),

  createGroup: (id: string, name: string, color?: string) =>
    invoke<void>("create_group", { id, name, color }),
  deleteGroup: (id: string) => invoke<void>("delete_group", { id }),
  setGroupMember: (groupId: string, authorId: string, member: boolean) =>
    invoke<void>("set_group_member", { groupId, authorId, member }),
  updateGroup: (id: string, name: string, color: string) =>
    invoke<void>("update_group", { id, name, color }),
  groups: () => invoke<Group[]>("get_groups"),
  accountLists: () => invoke<AccountList[]>("get_account_lists"),
  groupMembers: (groupId: string) =>
    invoke<string[]>("get_group_members", { groupId }),
  /** A group's combined timeline as already held for this session. No network. */
  groupFeed: (groupId: string, filters: FeedFilters, limit = 60) =>
    invoke<FeedResponse>("get_group_feed", { groupId, filters, limit }),
  /**
   * Fetch the next slice of a group's members and merge their recent posts.
   *
   * Called repeatedly with the returned `nextOffset` until it comes back null.
   * Members that fail are reported in `failures` rather than failing the whole
   * page — one unreadable account must not empty a group.
   */
  refreshGroupFeed: (
    groupId: string,
    offset: number,
    filters: FeedFilters,
    perAccount?: number,
    limit = 200,
  ) =>
    invoke<GroupFeedResponse>("refresh_group_feed", {
      groupId,
      offset,
      perAccount,
      filters,
      limit,
    }),

  lists: () => invoke<XList[]>("get_lists"),

  dashboard: () => invoke<DashboardStats>("get_dashboard"),
  currentUser: () => invoke<Author | null>("get_current_user"),
  settings: () => invoke<[string, string][]>("get_settings"),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  /** Whether Unfollow is available. Fresh installs default to enabled. */
  unfollowAllowed: () => invoke<boolean>("unfollow_allowed"),
  /**
   * Stop following an account.
   *
   * `confirmed` is not a formality: the backend refuses without it, so a
   * caller that skipped the dialog fails instead of acting. There is no retry
   * on failure, deliberately.
   */
  unfollowAccount: (username: string) =>
    invoke<void>("unfollow_account", { username, confirmed: true }),
  /**
   * Start following an account.
   *
   * The mirror of `unfollowAccount`, gated by the same preference. An app that
   * can unfollow but cannot put the follow back makes a mis-click permanent.
   */
  followAccount: (username: string) =>
    invoke<void>("follow_account", { username, confirmed: true }),
  removeBookmark: (postId: string) =>
    invoke<void>("remove_bookmark", { postId, confirmed: true }),
  mutedWords: () => invoke<string[]>("get_muted_words"),
  setMutedWord: (word: string, muted: boolean) =>
    invoke<void>("set_muted_word", { word, muted }),
  clearCache: () => invoke<void>("clear_cache"),
  diagnosticsReport: () => invoke<string>("diagnostics_report"),
  dataDir: () => invoke<string>("get_data_dir"),
  appVersion: () => invoke<string>("get_app_version"),
  initialRoute: () => invoke<string | null>("initial_route"),
  authEnvPresent: () => invoke<[string, boolean][]>("auth_env_present"),
};
