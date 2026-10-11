import { useEffect } from "react";
import { CloudOff, ChevronsLeft, ChevronsRight, RefreshCw } from "lucide-react";
import { defaultFilters } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge, ErrorState } from "@/components/ui/primitives";
import { PageHeader } from "@/components/layout/PageHeader";
import { FeedList } from "@/components/feed/FeedList";
import { useBookmarkFeed } from "@/hooks/useBookmarkFeed";
import {
  claimRefresh,
  releaseRefreshClaim,
  usePostActions,
} from "@/hooks/useFeed";
import { useSessionReady } from "@/hooks/useStartupSequence";
import { useI18n } from "@/i18n";
import { useOpenProfile } from "@/components/account/AccountIdentity";
import { usePlatform } from '@/lib/platform';
import { FeedScreen } from './FeedScreen';

/**
 * X bookmarks.
 *
 * Distinct from the local library, and the wording has to keep saying so: this
 * page shows what the account has bookmarked *on X*, while the library holds
 * posts saved inside this app and never leaves the machine. Conflating the two
 * is a defect the reader noticed before the code did.
 */
export function BookmarksPage() {
  const { isIphone } = usePlatform();
  const { t } = useI18n();
  if (isIphone) return <FeedScreen feed="bookmarks" title={t('nav.bookmarks')} filters={defaultFilters} showFilters={false} />;
  return <DesktopBookmarksPage />;
}
function DesktopBookmarksPage() {
  const { t } = useI18n();
  const feed = useBookmarkFeed(defaultFilters);
  const actions = usePostActions();
  const openProfile = useOpenProfile();
  const { phase, readyToken } = useSessionReady();

  useEffect(() => {
    if (!claimRefresh("bookmarks", readyToken)) return;
    void feed.refresh().then((ok) => {
      if (!ok) releaseRefreshClaim("bookmarks", readyToken);
    });
    // The refresh belongs to the session token, not to every render of the
    // page or to each bounded keyset slice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyToken]);

  return (
    <>
      <PageHeader
        title={t("bookmarks.title")}
        subtitle={
          <span className="flex items-center gap-2">
            <span>{t("bookmarks.subtitle")}</span>
            {feed.totalDiscovered > 0 ? (
              <Badge tone="neutral">
                {t("bookmarks.discovered", {
                  count: feed.totalDiscovered,
                })}
              </Badge>
            ) : null}
            {!feed.syncComplete ? (
              <Badge tone="neutral">{t("bookmarks.syncing")}</Badge>
            ) : (
              <Badge tone="neutral">{t("bookmarks.complete")}</Badge>
            )}
            {feed.error == null && feed.posts.length > 0 ? (
              <Badge tone="neutral">
                <CloudOff className="size-3" />
                {t("bookmarks.sessionOnly")}
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void feed.refresh()}
            disabled={feed.isRefreshing}
          >
            <RefreshCw
              className={feed.isRefreshing ? "animate-spin" : undefined}
            />
            {feed.isRefreshing
              ? t("connection.refreshing")
              : t("connection.refresh")}
          </Button>
        }
      />

      <div className="px-3 sm:px-6 py-4 sm:py-5 max-w-[720px] mx-auto w-full">
        {feed.refreshError ? (
          <div className="mb-4">
            <ErrorState
              title={t("bookmarks.refreshFailed")}
              message={feed.refreshError}
              onRetry={feed.refresh}
            />
          </div>
        ) : null}
        {feed.error ? (
          <div className="mb-4">
            <ErrorState
              title={t("bookmarks.loadFailed")}
              message={feed.error}
              onRetry={feed.retry}
            />
          </div>
        ) : null}

        <FeedList
          posts={feed.posts}
          readIds={feed.readIds}
          loading={
            feed.isLoading ||
            (phase === "checking" && feed.posts.length === 0)
          }
          onMarkRead={actions.markRead}
          onHide={actions.hide}
          bookmarkMode
          onRemoveBookmark={actions.removeBookmark}
          onOpenProfile={openProfile}
          hasMore={false}
          emptyTitle={t("bookmarks.empty.title")}
          emptyHint={t("bookmarks.empty.hint")}
        />

        {feed.posts.length > 0 ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={feed.goOldest}
              disabled={!feed.hasOlder || feed.isFetching}
              aria-label={t("bookmarks.navigation.oldest")}
            >
              <ChevronsLeft />
              {t("bookmarks.navigation.oldest")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={feed.goOlder}
              disabled={!feed.hasOlder || feed.isFetching}
            >
              {t("bookmarks.navigation.older")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={feed.goNewer}
              disabled={!feed.hasNewer || feed.isFetching}
            >
              {t("bookmarks.navigation.newer")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={feed.goNewest}
              disabled={!feed.hasNewer || feed.isFetching}
              aria-label={t("bookmarks.navigation.newest")}
            >
              {t("bookmarks.navigation.newest")}
              <ChevronsRight />
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
