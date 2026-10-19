import { useEffect } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import type { FeedFilters } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, ErrorState } from "@/components/ui/primitives";
import { PageHeader } from "@/components/layout/PageHeader";
import { FilterBar } from "@/components/feed/FilterBar";
import { FeedList } from "@/components/feed/FeedList";
import {
  claimRefresh,
  releaseRefreshClaim,
  useFeed,
  usePostActions,
} from "@/hooks/useFeed";
import { useSessionReady } from "@/hooks/useStartupSequence";
import { useI18n } from "@/i18n";
import { useOpenProfile } from "@/components/account/AccountIdentity";
import { useAppStore } from '@/stores/useAppStore';
import { useEffectivePolicy } from '@/lib/runtime';
import { usePlatform } from '@/lib/platform';
import { ConnectionError, ConnectionReport } from '@/components/settings/IosConnection';

/**
 * Shared feed screen used by Following, Focus Feed, Bookmarks and Lists.
 * Cached posts appear immediately; the refresh happens behind them.
 */
export function FeedScreen({
  feed,
  title,
  subtitle,
  filters,
  onFiltersChange,
  onReset,
  showFilters = true,
  emptyTitle,
  emptyHint,
  refreshOnMount = true,
}: {
  feed: string;
  title: string;
  subtitle?: string;
  filters: FeedFilters;
  onFiltersChange?: (patch: Partial<FeedFilters>) => void;
  onReset?: () => void;
  showFilters?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  refreshOnMount?: boolean;
}) {
  const f = useFeed(feed, filters);
  const actions = usePostActions();
  const openProfile = useOpenProfile();
  const { t } = useI18n();
  const { phase, readyToken } = useSessionReady();
  const interval = useAppStore(s => s.prefs.autoRefreshMinutes);
  const policy = useEffectivePolicy();
  const { isIphone } = usePlatform();
  useEffect(() => {
    if (interval <= 0 || phase !== 'ready' || !policy.foreground || !policy.speculative) return;
    const timer = window.setInterval(() => { if (!f.isRefreshing && !f.isLoadingMore) void f.refresh(); }, interval * 60_000);
    return () => window.clearInterval(timer);
  }, [interval,phase,policy.foreground,policy.speculative,f.refresh,f.isRefreshing,f.isLoadingMore]);

  // Refresh once when the screen opens onto a session that is known to work —
  // not on a timer loop, and not before the launch check has answered.
  //
  // 0.2.x fired this from a plain mount effect, so a launch with no credentials
  // still spent a `twitter.exe` on a request the backend was always going to
  // refuse, and raced the startup check on every other launch. `readyToken`
  // counts working sessions, so a reconnect earns a refresh and a five-minute
  // monitoring tick that merely confirms the session does not.
  //
  // The claim is held per feed *source*, in module scope — see `claimRefresh`.
  // Following, Originals and Focus are three views of one timeline, and between
  // them they must cost X one request, not three.
  useEffect(() => {
    if (!refreshOnMount) return;
    if (!claimRefresh(feed, readyToken)) return;
    void f.refresh().then((ok) => {
      if (!ok) releaseRefreshClaim(feed, readyToken);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, refreshOnMount, readyToken]);

  return (
    <>
      <PageHeader
        title={title}
        subtitle={
          <span className="flex items-center gap-2">
            {subtitle ? <span>{subtitle}</span> : null}
            {f.lastSync ? (
              <span>· updated {relativeTime(f.lastSync)} ago</span>
            ) : null}
            {f.fromCache && f.posts.length > 0 ? (
              <Badge tone="neutral">
                <CloudOff className="size-3" />
                {t('feed.cached')}
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void f.refresh()}
            disabled={f.isRefreshing}
          >
            <RefreshCw
              className={f.isRefreshing ? "animate-spin" : undefined}
            />
            {f.isRefreshing
              ? t("connection.refreshing")
              : t("connection.refresh")}
          </Button>
        }
      />

      <div className="px-3 sm:px-6 py-4 sm:py-5 max-w-[720px] mx-auto w-full">
        {showFilters && onFiltersChange && onReset ? (
          <FilterBar
            filters={filters}
            onChange={onFiltersChange}
            onReset={onReset}
          />
        ) : null}

        {f.refreshError ? (
          <div className="mb-4">
            <ErrorState
              title={t('feed.error.title')}
              message={f.refreshError}
              repair={t(f.posts.length > 0 ? 'feed.error.repair' : 'feed.error.noCache')}
              onRetry={f.refresh}
            />
            {isIphone && <div className="mt-3 rounded-xl border border-edge p-3 space-y-3">
              {Boolean(f.refreshFailure) && <ConnectionError error={f.refreshFailure} />}
              <ConnectionReport busy={f.isRefreshing} />
            </div>}
          </div>
        ) : null}

        {!(f.refreshError && f.posts.length === 0) && <FeedList
          posts={f.posts}
          readIds={f.readIds}
          // An empty local snapshot is not an empty feed while the one launch
          // session check is still running. Showing the skeleton here avoids
          // the misleading empty state captured in the slow-start screenshot;
          // once the check answers, the normal cached/live loading state takes
          // over immediately.
          loading={
            f.isLoading || (phase === "checking" && f.posts.length === 0)
          }
          pendingCount={f.pendingCount}
          onShowPending={f.showPending}
          onScrollStateChange={f.setAtTop}
          onMarkRead={actions.markRead}
          onHide={actions.hide}
          bookmarkMode={feed === "bookmarks"}
          onRemoveBookmark={
            feed === "bookmarks" ? actions.removeBookmark : undefined
          }
          onOpenProfile={openProfile}
          onLoadMore={f.loadMore}
          loadingMore={f.isLoadingMore}
          hasMore={f.hasMore}
          loadMoreError={f.loadMoreError}
          emptyTitle={emptyTitle}
          emptyHint={emptyHint}
        />}

        {f.loadMoreError ? (
          <div className="mt-4">
            <ErrorState
              title={t("feed.loadMoreFailed")}
              message={f.loadMoreError}
              onRetry={f.loadMore}
            />
          </div>
        ) : null}

        {f.hasMore ? (
          <div className="mt-5 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              onClick={f.loadMore}
              disabled={f.isLoadingMore}
            >
              {f.isLoadingMore
                ? t("connection.refreshing")
                : t("progress.loadMore")}
            </Button>
          </div>
        ) : null}

        {/* 0.1.0 printed a "Sample data" footnote here whenever the mock
            provider had served the page. There is no mock provider in a
            production build any more, so posts on screen are always real and
            the footnote could only ever be wrong. */}
      </div>
    </>
  );
}
