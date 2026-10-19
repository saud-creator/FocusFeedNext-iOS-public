import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  toAppError,
  type FeedFilters,
  type FeedResponse,
  type Post,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Read-state overlay
// ---------------------------------------------------------------------------

/**
 * Read marks made during this run, held in module scope and nowhere else.
 *
 * ## The stutter this exists to remove
 *
 * Automatic mark-as-read used to go straight through the mutation path: every
 * post that finished its dwell called `api.setRead` and then invalidated the
 * `feed`, `dashboard` and `saved` queries. Scrolling down a screenful marks six
 * or seven posts, so a normal scroll fired six or seven backend round trips,
 * each of which refetched all eighty posts and replaced the entire visible
 * array. Scrolling *back up* was the worst case by a wide margin: the posts
 * passed on the way down were now marked, so the way up re-armed the dwell
 * timers of everything that had not quite finished, and the refetches landed in
 * a burst while the compositor was already busy.
 *
 * The overlay breaks that loop. A mark is applied here synchronously — the dot
 * turns into a check on the same frame — the backend write goes out without
 * anything waiting on it, and the feed query is left alone. The counter in the
 * sidebar is the only thing that genuinely needs refreshing, and it is
 * coalesced rather than fired per post.
 *
 * Session-scoped on purpose, like `mediaSession`: the backend owns the durable
 * copy, this is only the optimistic view of it for the current run.
 */
const readOverlay = new Map<string, boolean>();
const overlayListeners = new Set<() => void>();

/** Bumped on every change so `useSyncExternalStore` sees a new snapshot. */
let overlayVersion = 0;

function overlaySnapshot(): number {
  return overlayVersion;
}

function subscribeOverlay(fn: () => void): () => void {
  overlayListeners.add(fn);
  return () => overlayListeners.delete(fn);
}

function setOverlayRead(id: string, read: boolean): void {
  if (readOverlay.get(id) === read) return;
  readOverlay.set(id, read);
  overlayVersion += 1;
  for (const fn of overlayListeners) fn();
}

/** Test seam, and the reset point when the account changes. */
export function resetReadOverlay(): void {
  if (readOverlay.size === 0) return;
  readOverlay.clear();
  overlayVersion += 1;
  for (const fn of overlayListeners) fn();
}

/**
 * The backend's read set with this run's marks laid over it.
 *
 * A mark made here wins over the server's copy until the next refetch carries
 * it, which is what lets the feed query stay untouched while scrolling.
 */
function applyOverlay(serverIds: readonly string[]): Set<string> {
  const out = new Set(serverIds);
  for (const [id, read] of readOverlay) {
    if (read) out.add(id);
    else out.delete(id);
  }
  return out;
}

/** Share the same backend + optimistic read set outside the main feed pages. */
export function useReadIds(serverIds: readonly string[]): Set<string> {
  const overlayAt = useSyncExternalStore(
    subscribeOverlay,
    overlaySnapshot,
    overlaySnapshot,
  );
  // overlayAt is deliberately a dependency: the map itself keeps its identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => applyOverlay(serverIds), [serverIds, overlayAt]);
}

// ---------------------------------------------------------------------------
// Refresh claims
// ---------------------------------------------------------------------------

/**
 * The ready-token each feed *source* was last refreshed for.
 *
 * Three pages now read the `following` source — the Following feed, Originals
 * and Focus Feed — and they differ only in the filters they view it through.
 * The guard that stops a page refreshing twice used to be a `useRef` inside
 * `FeedScreen`, which is per component instance: opening two of those pages in
 * one run meant two `refresh_feed` calls, two `twitter.exe` processes and two
 * traversals of the same timeline, for one set of posts.
 *
 * Keying on the source name rather than on the page collapses that to one. The
 * value is the ready token, so a reconnect (which increments it) still earns a
 * fresh pull, while a monitoring tick that merely confirms the session does not.
 *
 * Module scope and session-only, like `readOverlay` above: nothing here is
 * written to storage.
 */
const refreshedFor = new Map<string, number>();
/** The live cursor for a source, shared by its filtered views in this run. */
const sourceCursors = new Map<string, string | null>();
const INITIAL_CACHE_LIMIT = 80;
/** A continuation is larger than the first page so rapid scrolling has runway. */
const CONTINUATION_PAGE_SIZE = 60;

/** Generic feed hydration is always bounded. Bookmarks use `useBookmarkFeed`
 * and its keyset page command instead of this timeline hook. */
export function cacheLimitForFeed(_feed: string): number {
  return INITIAL_CACHE_LIMIT;
}
let feedSessionVersion = 0;
const feedSessionListeners = new Set<() => void>();

function subscribeFeedSession(listener: () => void): () => void {
  feedSessionListeners.add(listener);
  return () => feedSessionListeners.delete(listener);
}

function feedSessionSnapshot(): number {
  return feedSessionVersion;
}

/**
 * Take the right to refresh `feed` at this ready token, if nobody else has.
 *
 * Returns true exactly once per (feed, token) pair. Token 0 means the startup
 * check has not answered yet, and never claims: refreshing against a session
 * that has not been confirmed is the request that used to be spent proving the
 * credentials were missing.
 */
export function claimRefresh(feed: string, readyToken: number): boolean {
  if (readyToken === 0) return false;
  if (refreshedFor.get(feed) === readyToken) return false;
  refreshedFor.set(feed, readyToken);
  return true;
}

/** Test seam, and the reset point when the account changes. */
export function resetRefreshClaims(): void {
  refreshedFor.clear();
}

/** Release a failed automatic refresh so another view can retry this session. */
export function releaseRefreshClaim(feed: string, readyToken: number): void {
  if (refreshedFor.get(feed) === readyToken) refreshedFor.delete(feed);
}

/** Clear every module-scoped value that belongs to one connected account. */
export function resetFeedSessionState(): void {
  resetReadOverlay();
  resetRefreshClaims();
  sourceCursors.clear();
  feedSessionVersion += 1;
  for (const listener of feedSessionListeners) listener();
}

/**
 * Compare provider data without allocating a serialized copy.
 *
 * `twitter-cli` returns fresh objects for every refresh, including posts that
 * have not changed. Keeping the old object for those rows lets `PostCard`'s
 * shallow memoization do its job. The payloads are JSON data, so an object
 * graph walk is both safe and cheaper than stringifying media/quote trees on
 * every refresh.
 */
function sameData(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => sameData(value, b[index], depth + 1));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // Engagement counts are not rendered by the feed card. Providers commonly
  // update them on every refresh, so treating them as identity-bearing would
  // rebuild every card and its media subtree while the reader is scrolling.
  // Only ignore this field at the Post root; nested objects remain exact.
  const keys = Object.keys(left).filter(
    (key) => !(depth === 0 && key === "metrics"),
  );
  const rightKeys = Object.keys(right).filter(
    (key) => !(depth === 0 && key === "metrics"),
  );
  if (keys.length !== rightKeys.length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameData(left[key], right[key], depth + 1),
  );
}

function sharedPost(current: Post | undefined, next: Post): Post {
  return current && current.id === next.id && sameData(current, next)
    ? current
    : next;
}

export function sharePosts(
  next: readonly Post[],
  current: readonly Post[],
): Post[] {
  if (next.length === 0) return [];
  const previous = new Map(current.map((post) => [post.id, post]));
  return next.map((post) => sharedPost(previous.get(post.id), post));
}

/**
 * Merge a continuation response into the in-memory query without making the
 * native side send the older rows again. The provider may overlap a cursor
 * page, so existing ids are updated in place and only genuinely new ids are
 * appended in source order.
 */
export function appendFeedResponse(
  previous: FeedResponse | undefined,
  next: FeedResponse,
): FeedResponse {
  if (!previous) return next;

  const updates = new Map(next.posts.map((post) => [post.id, post]));
  const known = new Set(previous.posts.map((post) => post.id));
  const posts = previous.posts.map((post) => {
    const update = updates.get(post.id);
    return update ? sharedPost(post, update) : post;
  });
  posts.push(...next.posts.filter((post) => !known.has(post.id)));

  return {
    ...next,
    posts,
    readIds: [...new Set([...previous.readIds, ...next.readIds])],
  };
}

/**
 * Feed engine.
 *
 * Cached posts render immediately; a refresh runs in the background. New posts
 * are never spliced in above someone who is reading — they are held until the
 * reader asks for them (or is already at the top).
 */
export function useFeed(feed: string, filters: FeedFilters) {
  // Hydrate a first screen-sized slice. Bookmarks have their own bounded
  // keyset-page hook and do not use this timeline cache.
  const initialCacheLimit = cacheLimitForFeed(feed);
  const qc = useQueryClient();
  const [pending, setPending] = useState<Post[]>([]);
  const [visible, setVisible] = useState<Post[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshFailure, setRefreshFailure] = useState<unknown>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const atTopRef = useRef(true);
  const inFlight = useRef(false);
  const pendingRef = useRef<Post[]>([]);
  const cacheLimitRef = useRef(initialCacheLimit);
  const sentCursorsRef = useRef(new Set<string>());
  const operationEpoch = useRef(0);
  const sessionAt = useSyncExternalStore(
    subscribeFeedSession,
    feedSessionSnapshot,
    feedSessionSnapshot,
  );
  // A mutation applies its response deliberately below. Do not immediately
  // apply the same object again through React Query's cache observer: doing so
  // used to erase the held-new-posts banner while the reader was mid-scroll.
  const skipNextCacheSync = useRef(false);

  const key = useMemo(() => ["feed", feed, filters] as const, [feed, filters]);

  const cached = useQuery({
    queryKey: key,
    queryFn: () => api.cachedFeed(feed, filters, cacheLimitRef.current),
    staleTime: 15_000,
  });

  useEffect(() => {
    operationEpoch.current += 1;
    setVisible([]);
    pendingRef.current = [];
    setPending([]);
    cacheLimitRef.current = initialCacheLimit;
    sentCursorsRef.current.clear();
    setNextCursor(sourceCursors.get(feed) ?? null);
  }, [feed, filters, initialCacheLimit, sessionAt]);

  // Seed the visible list from the cache the first time it arrives, and keep it
  // in sync when filters change (a filter change is not "new posts").
  useEffect(() => {
    if (cached.data) {
      if (skipNextCacheSync.current) {
        skipNextCacheSync.current = false;
        return;
      }
      const held = new Set(pendingRef.current.map((post) => post.id));
      const next = cached.data.posts.filter((post) => !held.has(post.id));
      setVisible((current) => sharePosts(next, current));
    }
  }, [cached.data]);

  const applyResponse = useCallback((res: FeedResponse) => {
    setVisible((current) => {
      if (current.length === 0 || atTopRef.current) {
        pendingRef.current = [];
        setPending([]);
        return sharePosts(res.posts, current);
      }
      const known = new Set(current.map((p) => p.id));
      const fresh = res.posts.filter((p) => !known.has(p.id));
      if (fresh.length > 0) {
        pendingRef.current = fresh;
        setPending(fresh);
      }
      // Keep positions stable, but do apply corrected text/media/author fields
      // for posts already on screen.
      const updated = new Map(res.posts.map((post) => [post.id, post]));
      return current.map((post) => {
        const next = updated.get(post.id);
        return next ? sharedPost(post, next) : post;
      });
    });
  }, []);

  const refresh = useMutation({
    mutationFn: () => api.refreshFeed(feed, filters, 30, cacheLimitRef.current),
    onMutate: () => {
      setRefreshError(null);
      setRefreshFailure(null);
      return operationEpoch.current;
    },
    onSuccess: (res, _variables, startedAt) => {
      if (startedAt !== operationEpoch.current) return;
      applyResponse(res);
      sentCursorsRef.current.clear();
      const cursor = res.nextCursor ?? null;
      sourceCursors.set(feed, cursor);
      setNextCursor(cursor);
      skipNextCacheSync.current = true;
      qc.setQueryData(key, res);
    },
    onError: (e, _variables, startedAt) => {
      if (startedAt === operationEpoch.current) {
        setRefreshError(toAppError(e).message);
        setRefreshFailure(e);
      }
    },
  });

  const loadMore = useMutation({
    mutationFn: ({ cursor, limit }: { cursor: string; limit: number }) =>
      api.loadFeedPage(feed, cursor, filters, CONTINUATION_PAGE_SIZE, limit),
    onMutate: () => {
      setLoadMoreError(null);
      return operationEpoch.current;
    },
    onSuccess: (res, request, startedAt) => {
      if (startedAt !== operationEpoch.current) return;
      // Continuation returns only the newly fetched page. It is older content,
      // not a refresh to hold above the current viewport. Keep any new posts
      // deliberately held in the banner out of this merge.
      const held = new Set(pendingRef.current.map((post) => post.id));
      setVisible((current) => {
        const known = new Set(current.map((post) => post.id));
        const older = res.posts.filter(
          (post) => !known.has(post.id) && !held.has(post.id),
        );
        return [...current, ...older];
      });
      cacheLimitRef.current = request.limit;
      const candidate = res.nextCursor ?? null;
      sourceCursors.set(feed, candidate);
      setNextCursor(
        candidate && !sentCursorsRef.current.has(candidate) ? candidate : null,
      );
      skipNextCacheSync.current = true;
      qc.setQueryData(key, (previous: FeedResponse | undefined) =>
        appendFeedResponse(previous, res),
      );
    },
    onError: (e, request, startedAt) => {
      sentCursorsRef.current.delete(request.cursor);
      if (startedAt === operationEpoch.current) {
        setLoadMoreError(toAppError(e).message);
      }
    },
  });

  const showPending = useCallback(() => {
    setVisible((current) => {
      const known = new Set(current.map((p) => p.id));
      return [...pending.filter((p) => !known.has(p.id)), ...current];
    });
    pendingRef.current = [];
    setPending([]);
  }, [pending]);

  const setAtTop = useCallback((v: boolean) => {
    atTopRef.current = v;
  }, []);

  // Single-flight guard: never run two refreshes for the same feed at once.
  const safeRefresh = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    try {
      await refresh.mutateAsync();
      return true;
    } catch {
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [refresh]);

  const safeLoadMore = useCallback(() => {
    if (!nextCursor || loadMore.isPending) return;
    if (sentCursorsRef.current.has(nextCursor)) {
      setNextCursor(null);
      return;
    }
    sentCursorsRef.current.add(nextCursor);
    loadMore.mutate({
      cursor: nextCursor,
      limit: cacheLimitRef.current + CONTINUATION_PAGE_SIZE,
    });
  }, [loadMore, nextCursor]);

  // Re-reads only when a mark actually changes something, so a scroll that
  // marks nothing costs nothing.
  const overlayAt = useSyncExternalStore(
    subscribeOverlay,
    overlaySnapshot,
    overlaySnapshot,
  );

  // React Query can already have the cache when this hook mounts. Use it for
  // the first render instead of waiting for the passive cache-sync effect to
  // run; otherwise a cached feed briefly renders its empty state during route
  // changes. Once local state has posts, it remains authoritative for pending
  // new-posts and pagination behavior.
  const displayedPosts =
    visible.length === 0 && pendingRef.current.length === 0
      ? (cached.data?.posts ?? visible)
      : visible;
  const isInitialLoading =
    displayedPosts.length === 0 && (cached.isLoading || refresh.isPending);

  return {
    posts: displayedPosts,
    readIds: useMemo(
      () => applyOverlay(cached.data?.readIds ?? []),
      // `overlayAt` is the version counter; it is the dependency, not a value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [cached.data, overlayAt],
    ),
    lastSync: cached.data?.lastSync ?? null,
    provider: cached.data?.provider ?? "unknown",
    fromCache: cached.data?.fromCache ?? true,
    isLoading: isInitialLoading,
    isRefreshing: refresh.isPending,
    refreshError,
    refreshFailure,
    isLoadingMore: loadMore.isPending,
    loadMoreError,
    hasMore: nextCursor !== null,
    loadMore: safeLoadMore,
    pendingCount: pending.length,
    showPending,
    refresh: safeRefresh,
    setAtTop,
    invalidate: () => void qc.invalidateQueries({ queryKey: ["feed"] }),
  };
}

/** How long unread-count refreshes are pooled before one goes out. */
const COUNTER_COALESCE_MS = 750;

/**
 * Local state mutations shared by every page that renders posts.
 *
 * Every callback is memoised for the life of the hook. That is not tidiness:
 * `PostCard` runs an IntersectionObserver whose effect depends on `onMarkRead`,
 * so a callback rebuilt on each render tore down and re-registered an observer
 * per card per render. With eighty cards that is eighty observer registrations
 * for every keystroke in the filter bar.
 */
export function usePostActions() {
  const qc = useQueryClient();
  const counterTimer = useRef<number | null>(null);

  /**
   * Refresh the sidebar's unread badge, at most once per pool window.
   *
   * The badge is the only thing a read mark changes outside the card itself,
   * and it is a number in the corner — it does not need to be right within the
   * same frame, and it must never cost a feed refetch mid-scroll.
   */
  const refreshCounters = useCallback(() => {
    if (counterTimer.current !== null) return;
    counterTimer.current = window.setTimeout(() => {
      counterTimer.current = null;
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    }, COUNTER_COALESCE_MS);
  }, [qc]);

  useEffect(() => {
    return () => {
      if (counterTimer.current !== null)
        window.clearTimeout(counterTimer.current);
    };
  }, []);

  /** A deliberate, user-initiated change: worth refetching everything for. */
  const refetchAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["feed"] });
    void qc.invalidateQueries({ queryKey: ["groupFeed"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  }, [qc]);

  const markRead = useCallback(
    async (id: string, read: boolean) => {
      // Applied to the overlay first, so the mark lands on this frame and the
      // feed query is never invalidated by scrolling past a post.
      setOverlayRead(id, read);
      refreshCounters();
      try {
        await api.setRead(id, read);
      } catch (e) {
        // The backend refused, so the optimistic mark was a lie. Put it back
        // rather than leaving a check on a post that is still unread on disk.
        setOverlayRead(id, !read);
        throw e;
      }
    },
    [refreshCounters],
  );

  const hide = useCallback(
    async (id: string) => {
      await api.hidePost(id, true);
      // Remove the row from every currently mounted feed immediately. The
      // backend query is invalidated below as the authoritative refresh, but
      // waiting for that round trip left profile/group cards visible after the
      // user had already hidden them.
      const remove = (current: FeedResponse | undefined) =>
        current
          ? {
              ...current,
              posts: current.posts.filter((post) => post.id !== id),
            }
          : current;
      qc.setQueriesData<FeedResponse>({ queryKey: ["feed"] }, remove);
      qc.setQueriesData<FeedResponse>({ queryKey: ["groupFeed"] }, remove);
      refetchAll();
    },
    [qc, refetchAll],
  );

  /**
   * Remove a bookmark from X, then evict it only from bookmark feed caches.
   * The same post may still be present in Following, a list, or a profile, so
   * those feeds are intentionally left untouched.
   */
  const removeBookmark = useCallback(
    async (id: string) => {
      await api.removeBookmark(id);
      const remove = (current: FeedResponse | undefined) =>
        current
          ? {
              ...current,
              posts: current.posts.filter((post) => post.id !== id),
              totalCached: Math.max(0, current.totalCached - 1),
            }
          : current;
      qc.setQueriesData<FeedResponse>({ queryKey: ["feed", "bookmarks"] }, remove);
      void qc.invalidateQueries({ queryKey: ["feed", "bookmarks"] });
      void qc.invalidateQueries({ queryKey: ["bookmarkSlice"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    [qc],
  );

  return useMemo(
    () => ({ markRead, hide, removeBookmark }),
    [hide, markRead, removeBookmark],
  );
}
