import { create } from "zustand";
import { api, defaultFilters, isTauri, type FeedFilters } from "@/lib/api";
import type { LanguagePref } from "@/i18n";
import { defaultMobileTabs, validMobileTabs, type MobileTabId } from '@/lib/navigation';

export type RouteId =
  | "home"
  | "following"
  | "focus"
  | "search"
  | "pinned"
  | "groups"
  | "lists"
  | "bookmarks"
  | "library"
  | "accounts"
  | "originals"
  | "profile"
  | "diagnostics"
  | "settings";

/** The routes a page-open behaviour can be set for individually. */
export const OVERRIDABLE_ROUTES = [
  "following",
  "bookmarks",
  "accounts",
  "groups",
  "profile",
] as const;

export type OverridableRoute = (typeof OVERRIDABLE_ROUTES)[number];

/**
 * What happens when a page is opened.
 *
 * - `off` — show what is already loaded and ask X for nothing.
 * - `refresh` — show it, then quietly refresh behind it.
 * - `reset` — discard this page's session data, reset its cursors, load again.
 *
 * `reset` clears *page data*. It does not touch credentials and does not end
 * the X session; the naming matters, because "reset" next to a connection
 * indicator reads as "sign out" if the wording is careless.
 */
export type PageOpenBehavior = "off" | "refresh" | "reset";

export type ThemeId = "dark" | "oled" | "light" | "system";

export type ShadowIntensity = "none" | "soft" | "strong";

/** `best` resolves to the highest genuine variant at play time. */
export type VideoQualityPref = "auto" | "best" | "1080" | "720" | "480" | "360";

export interface Preferences {
  performanceMode: 'balanced' | 'fast' | 'battery' | 'ultra';
  readingSize: number;
  haptics: boolean;
  autoplay: 'off' | 'wifi' | 'any';
  mobileTabs: MobileTabId[];
  // -- appearance ------------------------------------------------------------
  theme: ThemeId;
  density: "comfortable" | "compact";
  /** Corner radius in px, applied as a CSS custom property. */
  radius: number;
  shadow: ShadowIntensity;
  /** Hex colours. Empty string means "use the theme's own value". */
  accent: string;
  background: string;
  surface: string;
  elevated: string;
  border: string;
  mediaBackground: string;
  /** 0–100. Raises body-text contrast against the background. */
  textContrast: number;
  timestampStyle: "relative" | "absolute";
  collapseLongPosts: boolean;
  /** "system" follows the OS locale and is resolved at render time. */
  language: LanguagePref;

  // -- connection ------------------------------------------------------------
  /**
   * Whether the app re-checks the connection on its own while its window is
   * visible. Durable, because it is a standing decision about whether the app
   * may talk to X unprompted.
   */
  autoCheckConnection: boolean;
  /** Minutes between unattended checks. Clamped to [MIN, MAX]_MONITOR_MINUTES. */
  monitorIntervalMinutes: number;
  /** What every page does on open, unless it has its own override. */
  pageOpenBehavior: PageOpenBehavior;
  /** Per-route overrides. A missing entry means "use the global default". */
  pageOpenOverrides: Partial<Record<OverridableRoute, PageOpenBehavior>>;

  // -- startup ---------------------------------------------------------------
  preloadBookmarks: boolean;
  preloadFollowing: boolean;

  // -- content ---------------------------------------------------------------
  //
  // No `showReplies`. Replies are not fetched and not rendered anywhere: a
  // reply is half of a conversation, and this is a reader.
  hideRepostsDefault: boolean;
  unreadOnlyDefault: boolean;
  /** How long a post must stay on screen before it counts as read. */
  readDwellMs: number;
  autoRefreshMinutes: number;

  // -- account actions -------------------------------------------------------
  /**
   * Unlocks Mute/Block-style operations *in the interface*. Rust refuses them
   * regardless of this value unless the provider genuinely supports them, so
   * this hides controls rather than granting permission.
   */
  advancedAccountActions: boolean;

  // -- video -----------------------------------------------------------------
  videoLoop: boolean;
  videoClickToggle: boolean;
  gifAutoplay: boolean;
  /** Release decoder resources for players scrolled out of view. */
  videoOffscreenCleanup: boolean;
  videoQuality: VideoQualityPref;
  defaultSpeed: number;
}

/** Unattended checks may not be more frequent than this, whatever is stored. */
export const MIN_MONITOR_MINUTES = 1;
export const MAX_MONITOR_MINUTES = 60;

export const defaultPreferences: Preferences = {
  performanceMode: 'balanced', readingSize: 100, haptics: true,
  autoplay: /iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? '') ? 'wifi' : 'any',
  mobileTabs: defaultMobileTabs,
  theme: "dark",
  density: "comfortable",
  radius: 12,
  shadow: "soft",
  accent: "",
  background: "",
  surface: "",
  elevated: "",
  border: "",
  mediaBackground: "",
  textContrast: 50,
  timestampStyle: "relative",
  collapseLongPosts: true,
  // Follow Windows unless the user says otherwise: an Arabic system should not
  // have to be told twice.
  language: "system",

  // On by default: a reader who leaves the window open should be told the
  // session has lapsed rather than discovering it from a failed refresh.
  autoCheckConnection: true,
  monitorIntervalMinutes: 5,
  // Off by default. Opening a page should show what is there, immediately;
  // a reader who wants fresh data has a Refresh button an inch away.
  pageOpenBehavior: "off",
  pageOpenOverrides: {},

  preloadBookmarks: true,
  preloadFollowing: true,

  hideRepostsDefault: false,
  unreadOnlyDefault: false,
  readDwellMs: 1000,
  autoRefreshMinutes: 0,

  advancedAccountActions: false,

  videoLoop: true,
  videoClickToggle: true,
  gifAutoplay: true,
  videoOffscreenCleanup: true,
  // Data-saving default. Readers can deliberately choose Best available or a
  // specific genuine variant in Settings; an existing stored choice is kept.
  videoQuality: "720",
  defaultSpeed: 1,
};

/**
 * The only preferences written to durable storage, mapped to the key the
 * backend files them under.
 *
 * The keys of this map must stay in step with `DURABLE_PREFERENCES` in
 * `src-tauri/src/durable.rs`, which is the enforcing side: the backend rejects
 * anything else outright, so a key added here alone changes nothing. A test in
 * `useAppStore.test.ts` and one in `durable.rs` guard the two ends.
 *
 * Names differ where the stored key is namespaced (`monitoring.*`, `video.*`)
 * while the preference field is not — a dot is not a legal identifier, and
 * inventing one would be worse than keeping a map.
 */
export const durableStorageKeys = {
  performanceMode: 'performance.mode', readingSize: 'reading.size', haptics: 'appearance.haptics',
  autoplay: 'video.autoplay', mobileTabs: 'navigation.tabs',
  language: "language",
  theme: "theme",
  density: "density",
  radius: "appearance.radius",
  shadow: "appearance.shadow",
  accent: "appearance.accent",
  background: "appearance.background",
  surface: "appearance.surface",
  elevated: "appearance.elevated",
  border: "appearance.border",
  mediaBackground: "appearance.mediaBackground",
  textContrast: "appearance.textContrast",
  timestampStyle: "appearance.timestampStyle",
  collapseLongPosts: "appearance.collapseLongPosts",

  autoCheckConnection: "monitoring.autoCheck",
  monitorIntervalMinutes: "monitoring.intervalMinutes",
  pageOpenBehavior: "pages.openBehavior",

  preloadBookmarks: "startup.preloadBookmarks",
  preloadFollowing: "startup.preloadFollowing",

  hideRepostsDefault: "content.hideReposts",
  unreadOnlyDefault: "content.unreadOnly",
  readDwellMs: "content.readDelayMs",
  autoRefreshMinutes: "content.autoRefreshMinutes",

  advancedAccountActions: "actions.advanced",

  videoLoop: "video.loop",
  videoClickToggle: "video.clickToggle",
  gifAutoplay: "video.gifAutoplay",
  videoOffscreenCleanup: "video.offscreenCleanup",
  videoQuality: "video.quality",
  defaultSpeed: "video.defaultSpeed",
} as const satisfies Partial<Record<keyof Preferences, string>>;

export type DurablePrefKey = keyof typeof durableStorageKeys;

/** The preference fields that survive a restart, in declaration order. */
export const durablePrefKeys = Object.keys(
  durableStorageKeys,
) as readonly DurablePrefKey[];

/** Per-route page-open overrides are stored one key per route. */
export function pageOpenOverrideKey(route: OverridableRoute): string {
  return `pages.openBehavior.${route}`;
}

function isDurable(key: keyof Preferences): key is DurablePrefKey {
  return Object.prototype.hasOwnProperty.call(durableStorageKeys, key);
}

/** Narrow a stored string back to a known value; ignore anything unexpected. */
function coerce<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((a) => a === value);
}

/**
 * Narrow a stored boolean.
 *
 * Only the two strings the app writes are honoured. Anything else — a missing
 * row, a hand-edited file, a value from a future build — falls through to
 * `undefined` so the caller's default applies.
 */
function coerceBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Narrow a stored number, clamped to a range. Rejects NaN and infinities. */
function coerceNumber(
  value: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Narrow a stored colour.
 *
 * Only `#rgb`/`#rrggbb` is accepted, and the empty string — which means "this
 * theme decides". Anything else is dropped rather than handed to CSS, so a
 * hand-edited preferences file cannot inject a value into a style property.
 */
export function coerceColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") return "";
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : undefined;
}

export const THEME_IDS = ["dark", "oled", "light", "system"] as const;
const SHADOWS = ["none", "soft", "strong"] as const;
const BEHAVIORS = ["off", "refresh", "reset"] as const;
const QUALITIES = ["auto", "best", "1080", "720", "480", "360"] as const;

const COLOR_KEYS = [
  "accent",
  "background",
  "surface",
  "elevated",
  "border",
  "mediaBackground",
] as const satisfies readonly (keyof Preferences)[];

/**
 * Rebuild a preference set from stored strings.
 *
 * Exported so the hydration rules can be tested without a backend. Every field
 * falls back to its default independently: one unreadable row must not discard
 * the rest.
 */
export function preferencesFromStored(
  stored: Record<string, string>,
): Preferences {
  const get = (k: DurablePrefKey) => stored[durableStorageKeys[k]];
  const out: Preferences = { ...defaultPreferences };

  const assign = <K extends keyof Preferences>(
    key: K,
    value: Preferences[K] | undefined,
  ) => {
    if (value !== undefined) out[key] = value;
  };
  assign('performanceMode', coerce(get('performanceMode'), ['balanced', 'fast', 'battery', 'ultra']));
  assign('readingSize', coerceNumber(get('readingSize'), 80, 160));
  assign('haptics', coerceBool(get('haptics')));
  assign('autoplay', coerce(get('autoplay'), ['off', 'wifi', 'any']));
  try { const tabs: unknown = JSON.parse(get('mobileTabs') ?? 'null'); if (validMobileTabs(tabs)) out.mobileTabs = tabs; } catch { /* Preserve safe defaults. */ }

  assign("language", coerce(get("language"), ["system", "en", "ar"] as const));
  assign("theme", coerce(get("theme"), THEME_IDS));
  assign("density", coerce(get("density"), ["comfortable", "compact"] as const));
  assign("radius", coerceNumber(get("radius"), 0, 24));
  assign("shadow", coerce(get("shadow"), SHADOWS));
  for (const key of COLOR_KEYS) assign(key, coerceColor(get(key)));
  assign("textContrast", coerceNumber(get("textContrast"), 0, 100));
  assign(
    "timestampStyle",
    coerce(get("timestampStyle"), ["relative", "absolute"] as const),
  );
  assign("collapseLongPosts", coerceBool(get("collapseLongPosts")));

  assign("autoCheckConnection", coerceBool(get("autoCheckConnection")));
  assign(
    "monitorIntervalMinutes",
    coerceNumber(
      get("monitorIntervalMinutes"),
      MIN_MONITOR_MINUTES,
      MAX_MONITOR_MINUTES,
    ),
  );
  assign("pageOpenBehavior", coerce(get("pageOpenBehavior"), BEHAVIORS));

  const overrides: Preferences["pageOpenOverrides"] = {};
  for (const route of OVERRIDABLE_ROUTES) {
    const value = coerce(stored[pageOpenOverrideKey(route)], BEHAVIORS);
    if (value) overrides[route] = value;
  }
  out.pageOpenOverrides = overrides;

  assign("preloadBookmarks", coerceBool(get("preloadBookmarks")));
  assign("preloadFollowing", coerceBool(get("preloadFollowing")));

  assign("hideRepostsDefault", coerceBool(get("hideRepostsDefault")));
  assign("unreadOnlyDefault", coerceBool(get("unreadOnlyDefault")));
  assign("readDwellMs", coerceNumber(get("readDwellMs"), 0, 10_000));
  assign("autoRefreshMinutes", coerceNumber(get("autoRefreshMinutes"), 0, 240));

  assign("advancedAccountActions", coerceBool(get("advancedAccountActions")));

  assign("videoLoop", coerceBool(get("videoLoop")));
  assign("videoClickToggle", coerceBool(get("videoClickToggle")));
  assign("gifAutoplay", coerceBool(get("gifAutoplay")));
  assign("videoOffscreenCleanup", coerceBool(get("videoOffscreenCleanup")));
  assign("videoQuality", coerce(get("videoQuality"), QUALITIES));
  assign("defaultSpeed", coerceNumber(get("defaultSpeed"), 0.25, 4));

  return out;
}

/** Which behaviour applies to a route: its own override, else the global one. */
export function behaviorFor(
  prefs: Preferences,
  route: RouteId,
): PageOpenBehavior {
  const overridable = (OVERRIDABLE_ROUTES as readonly string[]).includes(route);
  if (overridable) {
    const own = prefs.pageOpenOverrides[route as OverridableRoute];
    if (own) return own;
  }
  return prefs.pageOpenBehavior;
}

/**
 * Focus Feed uses a stricter filter set than the plain Following feed.
 *
 * It used to add `minEngagement: 20` — "and popular" — on top of these. That
 * threshold went when the engagement figures did: the app no longer shows a
 * like or repost count anywhere, so a reader could not have predicted which
 * posts it was keeping out. Focus is now "unread, written, not advertising".
 */
export const focusFilters: FeedFilters = {
  ...defaultFilters,
  hidePromoted: true,
  hideReposts: true,
  unreadOnly: true,
};

/** One step of history: enough to put the reader back where they were. */
export interface NavEntry {
  route: RouteId;
  profileUsername: string | null;
  scrollY: number;
}

interface AppState {
  route: RouteId;
  /** Whose profile the `profile` route is showing. */
  profileUsername: string | null;
  /** Where the reader came from, innermost last. */
  history: NavEntry[];
  navigate: (route: RouteId, opts?: { username?: string }) => void;
  /** Open an internal profile, remembering where we were. */
  openProfile: (username: string) => void;
  goBack: () => boolean;
  canGoBack: () => boolean;
  setRoute: (r: RouteId) => void;

  /** Last known scroll offset per route key, restored on return. */
  scrollPositions: Record<string, number>;
  rememberScroll: (key: string, y: number) => void;

  filters: FeedFilters;
  setFilters: (f: Partial<FeedFilters>) => void;
  resetFilters: () => void;

  /**
   * The saved settings — what the backend holds and what the app obeys.
   *
   * Settings are edited through `draft`, and nothing here changes until Save.
   * A half-typed colour must not repaint the window, and a toggle flipped while
   * the reader is still deciding must not reach X.
   */
  prefs: Preferences;
  /**
   * Write one preference immediately, outside the draft workflow.
   *
   * For controls that are not part of the Settings page — the language switch
   * in the header, a filter default flipped from a feed — where an explicit
   * Save would be theatre. Everything the Settings page owns goes through
   * `draft` instead, so a half-typed colour never repaints the window.
   */
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  /** The in-progress edit, or `null` when Settings is not being edited. */
  draft: Preferences | null;
  beginEdit: () => void;
  setDraft: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  setOverride: (
    route: OverridableRoute,
    value: PageOpenBehavior | undefined,
  ) => void;
  isDirty: () => boolean;
  saveDraft: () => Promise<void>;
  cancelDraft: () => void;
  resetDraftToDefaults: () => void;
  /** Load durable preferences from the backend. Called once, at startup. */
  hydratePrefs: () => Promise<void>;

  selectedListId: string | null;
  setSelectedListId: (id: string | null) => void;
}

/**
 * The startup page.
 *
 * This is a reader, so it opens on what there is to read. 0.2.0 opened on a
 * Home dashboard of counts and status tiles, which is a page about the app
 * rather than about the feed — a screen to click past before anything useful
 * appeared.
 */
export const START_ROUTE: RouteId = "following";

/**
 * Where a request for an unreachable route actually lands.
 *
 * `home`, `lists`, `pinned` and `search` are kept as ids so an old window
 * preference, a `--page` argument or a stale caller resolves somewhere sensible
 * instead of failing. None of the four is reachable from the navigation: Lists
 * cannot be enumerated by this backend, Pinned accounts was a workflow with no
 * working destination, and Search is gone. Removing the ids outright would turn
 * a stored value into a crash.
 */
export function resolveRoute(r: RouteId): RouteId {
  if (r === "home" || r === "lists") return START_ROUTE;
  if (r === "pinned") return "accounts";
  // The local library is gone. Its nearest equivalent is the reader's real
  // bookmark list on X, which is where a stored `--page library` now lands.
  if (r === "library") return "bookmarks";
  return r;
}

/** Longest history we keep. Deep enough to walk back out of a profile chain. */
const MAX_HISTORY = 20;
let preferenceSaveQueue: Promise<unknown> = Promise.resolve();
export function serializePreference(value: unknown): string { return typeof value === 'object' ? JSON.stringify(value) : String(value); }
export function preferenceEntries(prefs: Preferences, previous?: Preferences): [string, string][] {
  const entries: [string, string][] = durablePrefKeys.filter(key => !previous || serializePreference(prefs[key]) !== serializePreference(previous[key]))
    .map(key => [durableStorageKeys[key], serializePreference(prefs[key])]);
  for (const route of OVERRIDABLE_ROUTES) {
    if (!previous || previous.pageOpenOverrides[route] !== prefs.pageOpenOverrides[route])
      entries.push([pageOpenOverrideKey(route), prefs.pageOpenOverrides[route] ?? '']);
  }
  return entries;
}

export const useAppStore = create<AppState>((set, get) => ({
  route: START_ROUTE,
  profileUsername: null,
  history: [],

  navigate: (route, opts) => {
    const target = resolveRoute(route);
    if (isTauri() && (get().route !== target || (opts?.username ?? null) !== get().profileUsername)) void api.cancelNativeReads().catch(() => {});
    set((s) => {
      if (s.route === target && (opts?.username ?? null) === s.profileUsername) {
        return s;
      }
      const entry: NavEntry = {
        route: s.route,
        profileUsername: s.profileUsername,
        scrollY: s.scrollPositions[scrollKey(s.route, s.profileUsername)] ?? 0,
      };
      return {
        route: target,
        profileUsername: opts?.username ?? null,
        history: [...s.history, entry].slice(-MAX_HISTORY),
      };
    });
  },

  openProfile: (username) => get().navigate("profile", { username }),

  canGoBack: () => get().history.length > 0,

  goBack: () => {
    const { history } = get();
    const previous = history[history.length - 1];
    if (!previous) return false;
    if (isTauri()) void api.cancelNativeReads().catch(() => {});
    set({
      route: previous.route,
      profileUsername: previous.profileUsername,
      history: history.slice(0, -1),
    });
    return true;
  },

  // Plain assignment, no history: used by the sidebar's top-level navigation
  // where "back" to the previous top-level page is not a meaningful gesture.
  setRoute: (route) => {
    if (isTauri() && get().route !== resolveRoute(route)) void api.cancelNativeReads().catch(() => {});
    set({ route: resolveRoute(route), profileUsername: null, history: [] });
  },

  scrollPositions: {},
  rememberScroll: (key, y) =>
    set((s) => ({ scrollPositions: { ...s.scrollPositions, [key]: y } })),

  filters: defaultFilters,
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  resetFilters: () => set({ filters: defaultFilters }),

  prefs: defaultPreferences,

  setPref: (key, value) => {
    if (!isDurable(key) || !isTauri()) { set((s) => ({ prefs: { ...s.prefs, [key]: value } })); return; }
    // Preserve ordering and publish only after durable storage acknowledges.
    preferenceSaveQueue = preferenceSaveQueue.catch(() => {}).then(async () => {
      await api.setPreferencesBatch([[durableStorageKeys[key], serializePreference(value)]]);
      set((s) => ({ prefs: { ...s.prefs, [key]: value } }));
    });
    void preferenceSaveQueue.catch(() => window.dispatchEvent(new Event('ffn-preference-save-failed')));
  },

  draft: null,

  beginEdit: () => set((s) => ({ draft: s.draft ?? { ...s.prefs } })),

  setDraft: (key, value) =>
    set((s) => ({ draft: { ...(s.draft ?? s.prefs), [key]: value } })),

  setOverride: (route, value) =>
    set((s) => {
      const base = s.draft ?? s.prefs;
      const next = { ...base.pageOpenOverrides };
      if (value === undefined) delete next[route];
      else next[route] = value;
      return { draft: { ...base, pageOpenOverrides: next } };
    }),

  isDirty: () => {
    const { prefs, draft } = get();
    if (!draft) return false;
    return !samePreferences(prefs, draft);
  },

  saveDraft: async () => {
    const { draft } = get();
    if (!draft) return;
    const commit = preferenceSaveQueue.catch(() => {}).then(async () => {
      if (isTauri()) await api.setPreferencesBatch(preferenceEntries(draft, get().prefs));
      set((s) => ({ prefs: draft, draft: s.draft === draft ? null : s.draft }));
    });
    preferenceSaveQueue = commit;
    await commit;
  },

  cancelDraft: () => set({ draft: null }),

  resetDraftToDefaults: () =>
    set({ draft: { ...defaultPreferences, pageOpenOverrides: {} } }),

  hydratePrefs: async () => {
    if (!isTauri()) return;
    const hydration = preferenceSaveQueue.catch(() => {}).then(async () => {
    try {
      const stored = Object.fromEntries(await api.settings());
      const prefs = preferencesFromStored(stored);
      const platform = await api.runtimePlatform().catch(() => 'web');
      if (platform === 'ios') {
        if (!stored['video.autoplay']) prefs.autoplay = 'wifi';
        if (stored['migration.iosVideoQuality080'] !== 'true') {
          const migration: [string,string][] = [['video.quality','best'],['migration.iosVideoQuality080','true']];
          if (!stored['video.autoplay']) migration.push(['video.autoplay','wifi']);
          // Publish only after the quality and migration marker commit together.
          await api.setPreferencesBatch(migration,false);
          prefs.videoQuality = 'best';
        } else if (!stored['video.quality']) prefs.videoQuality = 'best';
      }
      set({ prefs });
    } catch {
      /* no stored preferences yet, or the store is unavailable: use defaults */
    }
    });
    preferenceSaveQueue = hydration;
    await hydration;
  },

  selectedListId: null,
  setSelectedListId: (selectedListId) => set({ selectedListId }),
}));

/** The key a route's scroll offset is remembered under. */
export function scrollKey(route: RouteId, username?: string | null): string {
  return username ? `${route}:${username}` : route;
}

function samePreferences(a: Preferences, b: Preferences): boolean {
  for (const key of Object.keys(defaultPreferences) as (keyof Preferences)[]) {
    if (key === "pageOpenOverrides") continue;
    if (key === 'mobileTabs') { if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false; continue; }
    if (a[key] !== b[key]) return false;
  }
  for (const route of OVERRIDABLE_ROUTES) {
    if (a.pageOpenOverrides[route] !== b.pageOpenOverrides[route]) return false;
  }
  return true;
}

export function isDurablePreference(key: keyof Preferences): boolean {
  return isDurable(key);
}
export async function commitPortablePreferences(entries: [string,string][]): Promise<void> {
  const commit = preferenceSaveQueue.catch(() => {}).then(async () => {
    const current = useAppStore.getState().prefs;
    await api.setPreferencesBatch(entries,true);
    const merged = Object.fromEntries([...preferenceEntries(current),...entries]);
    useAppStore.setState({ prefs: preferencesFromStored(merged),draft:null });
  });
  preferenceSaveQueue = commit;
  await commit;
}
