import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  BOOKMARKS_PROGRESS_EVENT,
  toAppError,
  type BookmarkDirection,
  type FeedFilters,
  type PreloadProgress,
} from "@/lib/api";
import { useReadIds } from "@/hooks/useFeed";

const BOOKMARK_PAGE_SIZE = 60;

interface BookmarkView {
  direction: BookmarkDirection;
  anchorPosition?: number;
}

/**
 * Bookmarks are a complete collection with a bounded viewport, not a feed
 * whose whole history should be copied into one React Query value. Navigation
 * replaces the current keyset page; `gcTime: 0` lets TanStack Query discard a
 * page as soon as it is no longer observed instead of accumulating every page
 * visited in a long reading session.
 */
export function useBookmarkFeed(filters: FeedFilters) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<BookmarkView>({ direction: "newest" });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);

  const query = useQuery({
    queryKey: [
      "bookmarkSlice",
      filters,
      view.direction,
      view.anchorPosition ?? null,
    ],
    queryFn: () =>
      api.bookmarkSlice(
        {
          direction: view.direction,
          ...(view.anchorPosition === undefined
            ? {}
            : { anchorPosition: view.anchorPosition }),
          limit: BOOKMARK_PAGE_SIZE,
        },
        filters,
      ),
    staleTime: 15_000,
    gcTime: 0,
  });

  // Tauri events are not replayed. Invalidating the current bounded page is
  // enough: the next query asks the backend for the same position against the
  // now-complete in-memory order, without copying every bookmark into JS.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listen<PreloadProgress>(BOOKMARKS_PROGRESS_EVENT, (event) => {
      if (event.payload.stage !== "complete") return;
      void queryClient.invalidateQueries({ queryKey: ["bookmarkSlice"] });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);

  const refreshMutation = useMutation({
    mutationFn: () =>
      api.refreshFeed(
        "bookmarks",
        filters,
        BOOKMARK_PAGE_SIZE,
        BOOKMARK_PAGE_SIZE,
      ),
    onMutate: () => setRefreshError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bookmarkSlice"] });
    },
    onError: (error) => setRefreshError(toAppError(error).message),
  });

  const refresh = useCallback(async (): Promise<boolean> => {
    if (refreshInFlight.current) return false;
    refreshInFlight.current = true;
    try {
      await refreshMutation.mutateAsync();
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight.current = false;
    }
  }, [refreshMutation]);

  const goOlder = useCallback(() => {
    const anchor = query.data?.firstPosition;
    if (!query.data?.hasOlder || anchor == null) return;
    setView({ direction: "older", anchorPosition: anchor });
  }, [query.data]);

  const goNewer = useCallback(() => {
    const anchor = query.data?.lastPosition;
    if (!query.data?.hasNewer || anchor == null) return;
    setView({ direction: "newer", anchorPosition: anchor });
  }, [query.data]);

  const goOldest = useCallback(() => {
    setView({ direction: "oldest" });
  }, []);

  const goNewest = useCallback(() => {
    setView({ direction: "newest" });
  }, []);

  const readIds = useReadIds(query.data?.readIds ?? []);

  return {
    posts: query.data?.posts ?? [],
    readIds,
    totalDiscovered: query.data?.totalDiscovered ?? 0,
    syncComplete: query.data?.syncComplete ?? false,
    firstPosition: query.data?.firstPosition ?? null,
    lastPosition: query.data?.lastPosition ?? null,
    hasOlder: query.data?.hasOlder ?? false,
    hasNewer: query.data?.hasNewer ?? false,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isRefreshing: refreshMutation.isPending,
    refreshError,
    error: query.error ? toAppError(query.error).message : null,
    retry: query.refetch,
    refresh,
    goOlder,
    goNewer,
    goOldest,
    goNewest,
  };
}
