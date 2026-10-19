import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Inbox } from "lucide-react";
import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { Post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/primitives";
import { PostCard } from "@/components/post/PostCard";
import { useAppStore } from "@/stores/useAppStore";
import { useI18n } from "@/i18n";
import { feedWindow } from './feedWindow';
import { useEffectivePolicy } from '@/lib/runtime';

/**
 * Below this many posts the list renders whole.
 *
 * Windowing is not free — a scroll listener, a resize observer, an absolutely
 * positioned layer and a measurement pass per card — and under a couple of
 * screenfuls it costs more than the DOM it saves. It also keeps short lists
 * (a small group, a thin search result) on the simplest possible code path.
 */
const WINDOW_THRESHOLD = 24;

/** Vertical gap between cards, in px. Matches the `space-y-3` it replaces. */
const CARD_GAP = 12;

/**
 * First-guess card height, in px.
 *
 * Only used until a card has been measured once. Deliberately near the real
 * median of a text-plus-avatar post rather than optimistically small: an
 * estimate that is too low makes the scrollbar lurch as measurements arrive.
 */
const ESTIMATED_CARD = 232;

/** Cards kept mounted ahead of the direction of travel. */

/** Cards kept mounted behind it. */

/** Start the next live page before the reader reaches the end of the feed. */

/** Request another cursor page before the virtual window reaches its tail. */

export function FeedSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="surface-card p-4">
          <div className="flex gap-3">
            <Skeleton className="size-10 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-44" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-36 w-full rounded-xl mt-2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The nearest ancestor that actually scrolls.
 *
 * The feed does not own its scroll container — the app shell does, and the list
 * sits under a page header and a filter bar inside it. Rather than reaching for
 * a specific element by id, which would bind this component to one layout, the
 * scroller is found by walking up and asking the computed style.
 */
export function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    // The nearest overflow ancestor is the scroll contract even during its
    // first layout pass, when its content has not contributed to scrollHeight
    // yet. Waiting for scrollHeight > 0 can select documentElement instead of
    // the app's <main>; the visible main scrollbar then moves without the
    // virtualizer receiving the offset, leaving blank space where cards should
    // be.
    if (/(auto|scroll|overlay)/.test(overflowY)) {
      return node;
    }
    node = node.parentElement;
  }
  // Nothing in between scrolls, so the document itself is the scroller.
  const root = document.scrollingElement ?? document.documentElement;
  return root instanceof HTMLElement ? root : null;
}

/**
 * The same posts, with any duplicate id dropped.
 *
 * A duplicate id is a React key collision, and a key collision is a remount
 * storm: React tears down and rebuilds every card after the clash on each
 * render. The merge in `useFeed` already dedupes, so this is a backstop — but
 * it is a cheap one, and the failure it prevents looks exactly like the scroll
 * stutter this component was rewritten to remove.
 */
function useStablePosts(posts: Post[]): Post[] {
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Post[] = [];
    for (const post of posts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      out.push(post);
    }
    return out;
  }, [posts]);
}

export function FeedList({
  posts,
  readIds,
  loading,
  pendingCount,
  onShowPending,
  onScrollStateChange,
  onMarkRead,
  onHide,
  onRemoveBookmark,
  bookmarkMode = false,
  onOpenProfile,
  onLoadMore,
  loadingMore,
  hasMore,
  loadMoreError,
  emptyTitle,
  emptyHint,
}: {
  posts: Post[];
  readIds: Set<string>;
  loading?: boolean;
  pendingCount?: number;
  onShowPending?: () => void;
  onScrollStateChange?: (atTop: boolean) => void;
  onMarkRead?: (id: string, read: boolean) => void;
  onHide?: (id: string) => void;
  bookmarkMode?: boolean;
  onRemoveBookmark?: (id: string) => Promise<void>;
  onOpenProfile?: (username: string) => void;
  /** Fetch the next live page while the reader is still approaching the end. */
  onLoadMore?: () => void;
  loadingMore?: boolean;
  hasMore?: boolean;
  loadMoreError?: string | null;
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const { t, plural } = useI18n();
  const prefs = useAppStore((s) => s.prefs);
  const policy = useEffectivePolicy();
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  const loadMoreRequested = useRef(false);

  useEffect(() => {
    loadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  // Pagination used to be a button below the feed. That made the reader hit
  // the end of the current page, stop, and wait for a click before any older
  // posts could exist. Keep the button as a fallback, but ask for the next
  // page while it is still well below the viewport. The ref guard matters
  // because an intersection observer can deliver several entries in one
  // frame before React has committed `loadingMore`.
  useEffect(() => {
    if (!hasMore) loadMoreRequested.current = false;
  }, [hasMore, loadingMore]);

  useEffect(() => {
    const sentinel = bottomSentinel.current;
    if (
      !sentinel ||
      !hasMore ||
      !onLoadMore ||
      loadingMore ||
      loadMoreError ||
      !policy.foreground ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const parent = scrollParentOf(sentinel);
    const root =
      parent &&
      parent !== document.scrollingElement &&
      parent !== document.documentElement
        ? parent
        : null;
    const observer = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries.some((entry) => entry.isIntersecting);
        // Keep the request claim while the sentinel remains in the runway.
        // Resetting it when the request finishes lets a short/filtered feed
        // recursively prefetch every page without any further reader motion.
        // A real exit from the runway is the boundary that earns another
        // request, which keeps background loading useful but bounded.
        if (!isIntersecting) {
          loadMoreRequested.current = false;
          return;
        }
        if (!loadMoreRequested.current && !loadingMore) {
          loadMoreRequested.current = true;
          loadMoreRef.current?.();
        }
      },
      { root, rootMargin: `${Math.max(1,window.innerHeight) * (policy.speculative ? policy.screensAhead : 0)}px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loadMoreError, onLoadMore, policy.foreground, policy.speculative, policy.screensAhead]);

  const items = useStablePosts(posts);
  const windowed = items.length >= WINDOW_THRESHOLD;

  // Track whether the reader is at the top, so refreshes never shift the page.
  useEffect(() => {
    const el = topSentinel.current;
    if (
      !el ||
      !onScrollStateChange ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const io = new IntersectionObserver((entries) => {
      onScrollStateChange(entries[0]?.isIntersecting ?? true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [onScrollStateChange]);

  // One definition of a card for both paths. The key lives here — on the post
  // id and never on an array index — so a card keeps its identity through a
  // refresh, a prepend and a filter change, and React reuses the element it
  // already has instead of rebuilding the subtree.
  const renderCard = (post: Post) => (
    <PostCard
      key={post.id}
      post={post}
      read={readIds.has(post.id)}
      timestampStyle={prefs.timestampStyle}
      collapseLongPosts={prefs.collapseLongPosts}
      defaultSpeed={prefs.defaultSpeed}
      readDwellMs={prefs.readDwellMs}
      onMarkRead={onMarkRead}
      onHide={onHide}
      isBookmark={bookmarkMode}
      onRemoveBookmark={
        onRemoveBookmark ? () => onRemoveBookmark(post.id) : undefined
      }
      onOpenProfile={onOpenProfile}
    />
  );

  if (loading && items.length === 0) return <FeedSkeleton />;

  if (!loading && items.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="size-8" />}
        title={emptyTitle ?? t("feed.empty.title")}
        hint={emptyHint ?? t("feed.empty.hint")}
      />
    );
  }

  return (
    <div className="relative">
      <div ref={topSentinel} className="h-px" />

      {pendingCount && pendingCount > 0 ? (
        <div className="sticky top-2 z-10 flex justify-center mb-3">
          <Button
            variant="primary"
            size="sm"
            onClick={onShowPending}
            className="shadow-lg ffn-rise"
          >
            <ArrowUp />
            {plural("feed.newPosts", pendingCount)}
          </Button>
        </div>
      ) : null}

      <div>
        {windowed ? (
          <WindowedCards
            items={items}
            renderCard={renderCard}
            onLoadMore={onLoadMore}
            loadingMore={loadingMore}
            hasMore={hasMore}
            loadMoreError={loadMoreError}
          />
        ) : (
          <div className="space-y-3">{items.map(renderCard)}</div>
        )}
      </div>

      {hasMore && onLoadMore ? (
        <div
          ref={bottomSentinel}
          data-testid="feed-load-more-sentinel"
          className="h-px"
          aria-hidden="true"
        />
      ) : null}

      {loadingMore ? (
        <p role="status" className="mt-3 text-center text-[12px] text-ink-mute">
          {t("feed.loadingMore")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The windowed body of a long feed.
 *
 * ## What was actually slow
 *
 * Every post in the list held a live card: an `<article>`, an avatar, a text
 * block, a media grid, an IntersectionObserver for the read dwell and — for a
 * video post — a mounted `<video>` with its own observer. Eighty of those is
 * several thousand elements and a hundred and sixty observers, all of which
 * Chromium re-lays-out whenever anything in the subtree changes size. Nothing
 * was ever released, so the cost only grew as the reader went further down.
 *
 * ## Why upward was the worst
 *
 * Scrolling back up is the direction with no runway. Going down, a card enters
 * from the bottom edge and the reader spends a moment on the one above it;
 * going up quickly, several cards cross the edge in a single frame and each one
 * needs layout, an image decode and an observer registration before it can be
 * painted. So the window is asymmetric: it always keeps more cards mounted
 * *ahead* of the direction of travel than behind it, and it flips as soon as
 * the reader reverses.
 *
 * Measurements are cached by post id rather than by index, so the heights
 * learned on the way down are still there on the way up, and prepending new
 * posts does not invalidate a single one.
 */
function WindowedCards({
  items,
  renderCard,
  onLoadMore,
  loadingMore,
  hasMore,
  loadMoreError,
}: {
  items: Post[];
  renderCard: (post: Post) => React.ReactNode;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  hasMore?: boolean;
  loadMoreError?: string | null;
}) {
  const policy = useEffectivePolicy();
  const windowRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [fallbackScrollTop, setFallbackScrollTop] = useState(0);
  const direction = useRef<"up" | "down">("down");
  const lastTop = useRef(0);
  const velocity = useRef(0);
  const lastScrollAt = useRef(0);

  // Resolved once the list is in the document. Held in state rather than a ref
  // so the virtualizer is rebuilt when it becomes available.
  useLayoutEffect(() => {
    setScroller(scrollParentOf(windowRef.current));
  }, []);

  // WebView2 can mount a route while the flex shell still reports a zero
  // viewport. TanStack quite correctly returns no virtual items for that
  // measurement, but it may not receive a resize notification when the shell
  // becomes visible again (especially during a restored route transition).
  // Track the usable height and retry a few frames so a settled route cannot
  // remain attached to an empty virtual range.
  useLayoutEffect(() => {
    if (!scroller) return;
    let frame = 0;
    let attempts = 0;
    let disposed = false;

    const update = () => {
      if (disposed) return;
      const height = Math.max(scroller.clientHeight, scroller.offsetHeight);
      setViewportHeight((previous) => (previous === height ? previous : height));
      if (height === 0 && attempts < 30) {
        attempts += 1;
        frame = window.requestAnimationFrame(update);
      }
    };

    update();
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(scroller);
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      ro?.disconnect();
    };
  }, [scroller]);

  /**
   * How far the list starts below the top of the scrolling content.
   *
   * The virtualizer positions items in the scroller's coordinate space, and the
   * list sits under a header and a filter bar. Getting this wrong does not
   * merely offset the cards — it makes the visible range wrong, so the reader
   * scrolls into blank space.
   */
  useLayoutEffect(() => {
    const list = windowRef.current;
    if (!list || !scroller) return;
    const update = () => {
      setScrollMargin(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    // Observe the list and every layout ancestor up to the scroller. The
    // filter bar and refresh-error banner live above the list, so their height
    // changes can move the list without changing the scroller's border box.
    const ro = new ResizeObserver(update);
    let node: HTMLElement | null = list;
    while (node) {
      ro.observe(node);
      if (node === scroller) break;
      node = node.parentElement;
    }
    return () => ro.disconnect();
  }, [scroller]);

  // A single passive listener, only to know which way the reader is going.
  // Deliberately not state: direction changes on almost every scroll event, and
  // re-rendering the feed at scroll frequency is the problem, not the fix.
  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (top !== lastTop.current) {
        const now = performance.now();
        velocity.current = Math.abs(top - lastTop.current) / Math.max(16, now - (lastScrollAt.current || now - 16));
        lastScrollAt.current = now;
        direction.current = top > lastTop.current ? "down" : "up";
        lastTop.current = top;
      }
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scroller]);

  const rangeExtractor = useCallback((range: Range) => {
    return feedWindow(range.startIndex, range.endIndex, range.count, direction.current === 'up', velocity.current, policy.mode);
  }, [policy.mode]);

  // Keep this function stable for the lifetime of the window. TanStack uses
  // callback identity as part of its measurement options; tying it to the
  // whole `items` array makes a refresh rebuild positions for the entire feed
  // even when the reader is still looking at the same range.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const getItemKey = useCallback(
    (index: number) => itemsRef.current[index]?.id ?? index,
    [],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => ESTIMATED_CARD + CARD_GAP,
    // Keyed by post id, which is what makes a measurement survive the list
    // being refreshed, reordered or prepended to.
    getItemKey,
    rangeExtractor,
    scrollMargin,
    // The asymmetric window above replaces this; tanstack still wants a number.
    overscan: 0,
    // Let TanStack move mounted rows directly during a scroll instead of
    // scheduling a React render for every wheel/touch event. Position mode is
    // intentional: transform-based positioning creates a containing block for
    // descendants, which would trap the player's CSS fullscreen fallback
    // inside one virtualized row in the embedded shell.
    directDomUpdates: true,
    directDomUpdatesMode: "position",
  });

  const setWindowRef = useCallback(
    (node: HTMLDivElement | null) => {
      windowRef.current = node;
      virtualizer.containerRef(node);
    },
    [virtualizer],
  );

  useLayoutEffect(() => {
    if (!scroller || viewportHeight <= 0) return;
    // Force a fresh rect/range after a delayed nonzero layout. This is cheap in
    // the normal case and prevents a spacer-only frame after WebView2 restores
    // a previously scrolled route.
    virtualizer.measure();
  }, [scroller, viewportHeight, virtualizer]);

  // This listener exists only while the virtualizer has no range. It lets the
  // defensive fallback below follow a deep restored scroll position without
  // adding React state work to the healthy, already-windowed path.
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    if (!scroller || viewportHeight <= 0 || virtualItems.length > 0) return;
    const update = () => setFallbackScrollTop(scroller.scrollTop);
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [scroller, viewportHeight, virtualItems.length]);

  const fallbackItems = useMemo(() => {
    if (
      virtualItems.length > 0 ||
      !scroller ||
      viewportHeight <= 0 ||
      items.length === 0
    ) {
      return [];
    }
    const estimate = ESTIMATED_CARD + CARD_GAP;
    const first = Math.min(
      items.length - 1,
      Math.max(0, Math.floor(Math.max(0, fallbackScrollTop - scrollMargin) / estimate)),
    );
    const count = Math.min(
      items.length - first,
      Math.max(1, Math.ceil(viewportHeight / estimate) + 1),
    );
    return Array.from({ length: count }, (_, offset) => ({
      index: first + offset,
      start: (first + offset) * estimate,
    }));
  }, [
    fallbackScrollTop,
    items.length,
    scroller,
    scrollMargin,
    viewportHeight,
    virtualItems.length,
  ]);

  // The sentinel is measured in pixels and is excellent for short feeds, but
  // a very tall post can make a reader reach the end of the current cursor
  // page before that sentinel gets a chance to enter the runway. The virtual
  // range knows the real item index, so start the next request while there are
  // still several cards left to paint. This is single-flight and resets after
  // a response, allowing a filtered/short page to advance again if needed.
  const loadAheadRequested = useRef(false);
  const loadAheadItems = policy.speculative ? Math.max(1,Math.ceil(viewportHeight / (ESTIMATED_CARD + CARD_GAP)) * policy.screensAhead) : 1;
  // Overscan is for rendering, not permission to fetch earlier than policy.
  const visibleOffset = virtualizer.scrollOffset ?? fallbackScrollTop;
  const lastRenderedIndex = Math.max(-1, ...[...virtualItems,...fallbackItems].filter(row => {
    const start = row.start + ('size' in row ? 0 : scrollMargin);
    return start < visibleOffset + viewportHeight && start + ('size' in row && typeof row.size === 'number' ? row.size : ESTIMATED_CARD + CARD_GAP) > visibleOffset;
  }).map(row => row.index));
  useEffect(() => {
    if (loadingMore) {
      loadAheadRequested.current = false;
      return;
    }
    if (
      !policy.foreground ||
      !hasMore ||
      !onLoadMore ||
      loadMoreError ||
      items.length === 0 ||
      lastRenderedIndex < items.length - loadAheadItems ||
      loadAheadRequested.current
    ) {
      if (lastRenderedIndex < items.length - loadAheadItems) {
        loadAheadRequested.current = false;
      }
      return;
    }
    loadAheadRequested.current = true;
    onLoadMore();
  }, [
    hasMore,
    items.length,
    lastRenderedIndex,
    loadMoreError,
    loadingMore,
    onLoadMore,
    policy.foreground,
    loadAheadItems,
  ]);

  /**
   * Keep the reader's place when posts are added above them.
   *
   * "Show N new posts" splices the newest batch onto the front of the list.
   * Without this the content under the cursor jumps down by the height of
   * whatever was inserted — the single most disorienting thing a feed can do.
   */
  const previousFirst = useRef<string | null>(null);
  const previousIds = useRef<string[]>([]);
  useLayoutEffect(() => {
    const firstId = items[0]?.id ?? null;
    const wasFirst = previousFirst.current;
    const wasIds = previousIds.current;
    previousFirst.current = firstId;
    const currentIds = items.map((post) => post.id);
    previousIds.current = currentIds;
    if (!scroller || !wasFirst || firstId === wasFirst) return;
    const insertedBefore = items.findIndex((p) => p.id === wasFirst);
    // Not a prepend: the list was replaced, filtered or reordered. Leave the
    // scroll position to the browser rather than guessing at a correction.
    const oldListIsIntact =
      insertedBefore > 0 &&
      currentIds.length >= insertedBefore + wasIds.length &&
      wasIds.every((id, index) => currentIds[insertedBefore + index] === id);
    if (!oldListIsIntact || scroller.scrollTop === 0) return;
    let added = 0;
    for (let i = 0; i < insertedBefore; i++) {
      // A brand-new post has never been measured, so its estimate is all there
      // is. That is exactly what the virtualizer will lay it out at, so the
      // correction matches the shift it is compensating for.
      added += ESTIMATED_CARD + CARD_GAP;
    }
    scroller.scrollTop += added;
    lastTop.current = scroller.scrollTop;
  }, [items, scroller]);

  return (
    <div
      ref={setWindowRef}
      data-testid="feed-window"
      style={{ position: "relative" }}
    >
      {virtualItems.map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-testid="feed-window-item"
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            // Logical insets rather than a width, so the layer mirrors with the
            // rest of the interface in Arabic instead of hanging off the edge.
            insetInlineStart: 0,
            insetInlineEnd: 0,
            paddingBottom: CARD_GAP,
          }}
        >
          {renderCard(items[item.index])}
        </div>
      ))}
      {fallbackItems.map((item) => (
      <div
          key={`fallback-${items[item.index]?.id ?? item.index}`}
          data-index={item.index}
          data-testid="feed-window-fallback"
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            insetInlineStart: 0,
            insetInlineEnd: 0,
            paddingBottom: CARD_GAP,
            transform: `translateY(${item.start - scrollMargin}px)`,
          }}
        >
          {renderCard(items[item.index])}
        </div>
      ))}
    </div>
  );
}
