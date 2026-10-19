import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, Link2, MapPin } from "lucide-react";
import { api, defaultFilters, type Author, type Post } from "@/lib/api";
import { useI18n, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/primitives";
import { PageHeader } from "@/components/layout/PageHeader";
import { FeedList } from "@/components/feed/FeedList";
import { usePostActions, useReadIds } from "@/hooks/useFeed";
import { useAppStore, scrollKey } from "@/stores/useAppStore";
import { Avatar, accountLabel, cleanHandle } from "@/components/account/Avatar";
import {
  AccountIdentity,
  useOpenProfile,
} from "@/components/account/AccountIdentity";
import { FollowButton } from "@/components/account/FollowButton";
import { CreatorSubscription } from '@/components/account/CreatorSubscription';
import { messageOf } from "@/components/account/accountActions";
import { useRememberedScroll } from "@/components/account/useRememberedScroll";

/** How many of an account's posts to ask for per step. */
const PAGE = 30;

// ---------------------------------------------------------------------------
// Pure helpers — exported so the rules can be tested without a backend
// ---------------------------------------------------------------------------

/**
 * Which of an account's posts the reader is looking at.
 *
 * - `posts` — everything this app shows for the account.
 * - `originals` — what they wrote themselves. Reposts are excluded; **quote
 *   posts are not**, because a quote carries the account's own words. The same
 *   rule backs the timeline-wide Originals page, so "original" means one thing
 *   in this app rather than two.
 * - `media` — posts carrying an image, video or GIF.
 */
export type ProfileTab = "posts" | "originals" | "media";

export const PROFILE_TABS = ["posts", "originals", "media"] as const;

export interface ProfilePostFilters {
  tab: ProfileTab;
  videosOnly: boolean;
  photosOnly: boolean;
  latestFirst: boolean;
}

export const noProfileFilters: ProfilePostFilters = {
  tab: "posts",
  videosOnly: false,
  photosOnly: false,
  latestFirst: true,
};

/**
 * Merge a newly fetched batch into what is already on screen.
 *
 * Source order is kept and ids are never repeated. The backend has no cursor
 * for a user's posts, so "load more" re-asks for a longer list; without this
 * the reader would watch the same posts appear a second time.
 */
export function mergePosts(existing: Post[], incoming: Post[]): Post[] {
  const seen = new Set(existing.map((p) => p.id));
  const merged = [...existing];
  for (const post of incoming) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    merged.push(post);
  }
  return merged;
}

const hasVideo = (p: Post) =>
  p.media.some((m) => m.kind === "video" || m.kind === "gif");
const hasPhoto = (p: Post) => p.media.some((m) => m.kind === "image");

/**
 * Apply the profile's tab and its refinements.
 *
 * Replies are dropped unconditionally, on every tab. A reply is half of a
 * conversation, and this app never fetches the other half — showing one on its
 * own gives the reader an answer with no question.
 */
export function filterProfilePosts(
  posts: Post[],
  filters: ProfilePostFilters,
): Post[] {
  const out = posts.filter((p) => {
    if (p.inReplyTo) return false;
    if (filters.tab === "originals" && p.isRepost) return false;
    if (filters.tab === "media" && p.media.length === 0) return false;
    if (filters.videosOnly && !hasVideo(p)) return false;
    if (filters.photosOnly && !hasPhoto(p)) return false;
    return true;
  });

  if (!filters.latestFirst) return out;
  return [...out].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

/** A website value only becomes a link when it is genuinely one. */
export function safeWebsite(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function ProfilePage() {
  const t = useT();
  const { plural, formatCompact, formatDate } = useI18n();
  const username = useAppStore((s) => s.profileUsername) ?? "";
  const handle = cleanHandle(username);
  const goBack = useAppStore((s) => s.goBack);
  const canGoBack = useAppStore((s) => s.canGoBack());
  const openProfile = useOpenProfile();
  const actions = usePostActions();
  const readState = useQuery({ queryKey: ["readIds"], queryFn: api.readIds });
  const readIds = useReadIds(readState.data ?? []);

  const [filters, setFilters] = useState<ProfilePostFilters>(noProfileFilters);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  /** Bumped by every request and by Cancel, so a stale answer never lands. */
  const seq = useRef(0);
  /** One profile request at a time, including the first observer callback. */
  const postsInFlight = useRef<number | null>(null);
  const wanted = useRef(PAGE);
  const hide = useCallback(
    async (id: string) => {
      await actions.hide(id);
      // Profile posts are held in local state rather than the feed query. The
      // backend hide is durable for this session, so keep this view truthful
      // immediately instead of waiting for the next profile request.
      setPosts((current) => current.filter((post) => post.id !== id));
    },
    [actions],
  );

  // The identity shell never waits on posts. This is the whole point: the
  // avatar, the name and the bio are one cheap call and appear on their own.
  const profile = useQuery({
    queryKey: ["userProfile", handle],
    queryFn: () => api.userProfile(handle),
    enabled: handle.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const account: Author | undefined = profile.data;
  const anchor = useRememberedScroll(
    scrollKey("profile", handle),
    Boolean(account),
  );

  const load = useCallback(
    async (want: number) => {
      if (postsInFlight.current !== null) return;
      const mine = ++seq.current;
      postsInFlight.current = mine;
      wanted.current = want;
      setLoadingPosts(true);
      setPostsError(null);
      try {
        const response = await api.refreshFeed(
          `user:${handle}`,
          defaultFilters,
          want,
          want,
        );
        const batch = response.posts;
        if (mine !== seq.current) return; // cancelled, or a newer request won
        setPosts((prev) => mergePosts(prev, batch));
        // No cursor exists for a user's posts, so "there is no more" is read
        // off a short answer rather than off a missing next page.
        setExhausted(batch.length < want);
        setLoadingPosts(false);
      } catch (e) {
        if (mine !== seq.current) return;
        setPostsError(messageOf(e));
        setLoadingPosts(false);
      } finally {
        if (postsInFlight.current === mine) postsInFlight.current = null;
      }
    },
    [handle],
  );

  // Posts start loading as soon as the account id is known — after the shell
  // has already painted, never before it.
  useEffect(() => {
    setPosts([]);
    setExhausted(false);
    setPostsError(null);
    wanted.current = PAGE;
    seq.current++;
    postsInFlight.current = null;
    if (account?.id) void load(PAGE);
  }, [account?.id, load]);

  const cancel = () => {
    seq.current++; // anything in flight is now ignored
    postsInFlight.current = null;
    setLoadingPosts(false);
  };

  // Profile endpoints do not expose a cursor, so each continuation asks for a
  // longer prefix. Trigger that continuation before the reader reaches the
  // end of the virtualized window; the visible button below remains the
  // explicit fallback for readers who prefer manual loading.
  const loadNextPage = useCallback(() => {
    if (!account?.id || loadingPosts || exhausted) return;
    void load(wanted.current + PAGE);
  }, [account?.id, exhausted, load, loadingPosts]);

  const visible = useMemo(
    () => filterProfilePosts(posts, filters),
    [posts, filters],
  );

  const website = safeWebsite(account?.website);
  const at = `@${handle}`;
  const name = account ? accountLabel(account) : handle;

  return (
    <>
      <PageHeader
        title={name || t("profile.title")}
        subtitle={at}
        actions={
          canGoBack ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goBack()}
              aria-label={t("profile.back")}
            >
              <ArrowLeft />
              {t("profile.back")}
            </Button>
          ) : null
        }
      />

      <div
        ref={anchor}
        className="px-3 sm:px-6 py-4 sm:py-5 max-w-[760px] mx-auto w-full"
      >
        {/* -- identity shell -------------------------------------------- */}
        {account?.bannerUrl ? (
          <img
            src={account.bannerUrl}
            alt=""
            className="mb-4 h-32 w-full rounded-xl object-cover border border-edge"
          />
        ) : null}

        <div className="surface-card p-4">
          <div className="flex items-start gap-4">
            {account ? (
              <Avatar author={account} size={72} />
            ) : (
              <Skeleton className="size-[72px] rounded-full shrink-0" />
            )}

            <div className="min-w-0 flex-1">
              {account ? (
                <AccountIdentity
                  account={account}
                  layout="stacked"
                  showAvatar={false}
                  nameClassName="text-[19px] max-w-none"
                  handleClassName="text-[13.5px] max-w-none"
                />
              ) : (
                <>
                  {/* The handle is known from the route, so it is shown
                      immediately rather than as a grey box. */}
                  <Skeleton className="h-5 w-40" />
                  <div className="text-ink-mute text-[13.5px] mt-1.5" dir="ltr">
                    {at}
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-col items-end gap-2 shrink-0">
              {account ? <FollowButton account={account} size="sm" /> : null}
            </div>
          </div>

          {account ? <div className="mt-3"><CreatorSubscription username={account.username} /></div> : null}

          {account ? (
            <>
              <p className="mt-3 text-[13.5px] text-ink-dim" dir="auto">
                {account.bio?.trim() || t("profile.noBio")}
              </p>

              <div className="mt-3 flex items-center gap-4 flex-wrap text-[12.5px] text-ink-mute">
                {account.location ? (
                  <span className="inline-flex items-center gap-1" dir="auto">
                    <MapPin className="size-3.5" />
                    {account.location}
                  </span>
                ) : null}
                {/* Shown, not clickable — `safeWebsite` still validates it, so
                    junk never renders as though it were an address. */}
                {website ? (
                  <span className="inline-flex items-center gap-1" dir="ltr">
                    <Link2 className="size-3.5" />
                    {website}
                  </span>
                ) : null}
                {account.joinedAt ? (
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="size-3.5" />
                    {t("profile.joined", {
                      date: formatDate(account.joinedAt),
                    })}
                  </span>
                ) : null}
              </div>

              <div className="mt-3 flex items-center gap-4 text-[13px] text-ink-dim">
                <span
                  title={plural(
                    "profile.followers",
                    account.followersCount ?? 0,
                  )}
                >
                  <strong className="text-ink">
                    {formatCompact(account.followersCount ?? 0)}
                  </strong>{" "}
                  {t("profile.followers.label")}
                </span>
                <span
                  title={plural(
                    "profile.following",
                    account.followingCount ?? 0,
                  )}
                >
                  <strong className="text-ink">
                    {formatCompact(account.followingCount ?? 0)}
                  </strong>{" "}
                  {t("profile.following.label")}
                </span>
                {account.postsCount != null ? (
                  <span>
                    <strong className="text-ink">
                      {formatCompact(account.postsCount)}
                    </strong>{" "}
                    {t("profile.posts.label")}
                  </span>
                ) : null}
              </div>
            </>
          ) : profile.isError ? (
            <div className="mt-3">
              <ErrorState
                title={t("profile.unavailable.title")}
                message={
                  messageOf(profile.error) || t("profile.unavailable.hint")
                }
                repair={t("profile.unavailable.hint")}
                onRetry={() => void profile.refetch()}
              />
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-2/5" />
            </div>
          )}
        </div>

        {/* -- tabs -------------------------------------------------------- */}
        {/* Originals is a tab rather than one chip among seven because it is
            the question a reader actually arrives with — "what does this
            account write?" — and a chip row makes that a setting to find. */}
        <div
          role="tablist"
          aria-label={t("profile.tabs.aria")}
          className="mt-4 flex items-center gap-1 border-b border-edge"
        >
          {PROFILE_TABS.map((tab) => {
            const selected = filters.tab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setFilters((f) => ({ ...f, tab }))}
                className={cn(
                  "-mb-px border-b-2 px-3.5 py-2 text-[13.5px] cursor-pointer transition-colors",
                  selected
                    ? "border-accent text-accent font-medium"
                    : "border-transparent text-ink-dim hover:text-ink",
                )}
              >
                {t(`profile.tab.${tab}`)}
              </button>
            );
          })}
        </div>

        {/* Refinements that apply within whichever tab is open. */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {(
            [
              ["photosOnly", "profile.filter.photos"],
              ["videosOnly", "profile.filter.videos"],
              ["latestFirst", "profile.filter.latest"],
            ] as const
          ).map(([key, label]) => {
            const on = filters[key];
            return (
              <button
                key={key}
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => setFilters((f) => ({ ...f, [key]: !f[key] }))}
                className={cn(
                  "rounded-full border px-3 py-1 text-[12.5px] cursor-pointer transition-colors",
                  on
                    ? "bg-accent-soft border-accent/40 text-accent"
                    : "bg-surface-2 border-edge text-ink-dim hover:text-ink",
                )}
              >
                {t(label)}
              </button>
            );
          })}
        </div>

        {/* -- posts ------------------------------------------------------ */}
        <div className="mt-4 flex items-center gap-3 text-[12.5px] text-ink-mute">
          <span>{plural("profile.loaded", posts.length)}</span>
          {loadingPosts ? (
            <>
              <span>{t("profile.loadingPosts")}</span>
              <button
                type="button"
                onClick={cancel}
                className="text-accent hover:underline cursor-pointer"
              >
                {t("profile.stopLoading")}
              </button>
            </>
          ) : null}
        </div>

        {postsError ? (
          <div className="mt-3">
            <ErrorState
              title={t("profile.postsFailed")}
              message={postsError}
              onRetry={() =>
                account?.id ? void load(wanted.current) : undefined
              }
            />
          </div>
        ) : null}

        <div className="mt-3">
          <FeedList
            posts={visible}
            readIds={readIds}
            // The account request and the posts request are separate. Keep the
            // list in a loading state for both so the profile never says
            // “nothing cached” while its identity is still on the wire.
            loading={profile.isPending || (loadingPosts && posts.length === 0)}
            onMarkRead={actions.markRead}
            onHide={hide}
            onOpenProfile={openProfile}
            onLoadMore={loadNextPage}
            loadingMore={loadingPosts}
            hasMore={!exhausted}
            loadMoreError={postsError}
            emptyTitle={t("profile.empty.title")}
            emptyHint={t("profile.empty.hint")}
          />
        </div>

        {posts.length > 0 ? (
          <div className="mt-4 flex justify-center">
            {exhausted ? (
              <p className="text-[12.5px] text-ink-mute">
                {t("profile.noMore")}
              </p>
            ) : (
              <Button
                variant="secondary"
                disabled={loadingPosts}
                onClick={() =>
                  account?.id ? void load(wanted.current + PAGE) : undefined
                }
              >
                {loadingPosts
                  ? t("profile.loadingPosts")
                  : t("profile.loadMore")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

export default ProfilePage;
