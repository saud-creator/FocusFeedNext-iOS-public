import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Pin, PinOff, Search, UserMinus, Users } from "lucide-react";
import {
  api,
  isTauri,
  FOLLOWING_PROGRESS_EVENT,
  type Author,
  type PreloadProgress,
  toAppError,
} from "@/lib/api";
import { useI18n, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { matchAccounts } from "@/lib/matching";
import { Button } from "@/components/ui/button";
import {
  Badge,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Switch,
} from "@/components/ui/primitives";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  AccountIdentity,
  useOpenProfile,
} from "@/components/account/AccountIdentity";
import { useSessionReady } from "@/hooks/useStartupSequence";
import {useRuntimeStore} from '@/lib/runtime';

/**
 * People you follow, and the local organisation around them.
 *
 * ## Pressing a row opens that account
 *
 * Every avatar, display name and @handle here is a profile trigger, through the
 * same `AccountIdentity` the feed and the profile page use. Until now this page
 * rendered its own avatar and its own name markup, so the one screen listing
 * every account you follow was the one screen where you could not open any of
 * them.
 *
 * ## It costs X nothing to open
 *
 * The list is read from this session's store (`followingSnapshot`), not fetched.
 * The startup preload worker has usually already filled it, in which case this
 * page renders instantly and makes no request at all. A traversal is started
 * only when the snapshot says it is genuinely incomplete, and progress arrives
 * on `following:progress` rather than by polling.
 *
 * The previous version called `followingAccounts`, a live provider call, on
 * every single mount — about two seconds and a spawned `twitter.exe` each time
 * the reader glanced at this page.
 *
 * ## What changes the account, and what does not
 *
 * Pins and group membership are local. Unfollow genuinely changes the X
 * account, so the page offers an explicit permission switch and only shows the
 * action behind a dialog that names the exact handle. It is the sole
 * account-changing action on this page.
 */
export function FollowingManagerPage() {
  const qc = useQueryClient();
  const t = useT();
  const { plural, formatCompact } = useI18n();
  const openProfile = useOpenProfile();

  const [query, setQuery] = useState("");
  /** The account awaiting confirmation. `null` while no dialog is open. */
  const [confirming, setConfirming] = useState<Author | null>(null);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [settingWorking, setSettingWorking] = useState(false);
  const [settingFailure, setSettingFailure] = useState<string | null>(null);
  const [syncStartError,setSyncStartError]=useState<string|null>(null);
  const foreground=useRuntimeStore(s=>s.snapshot.foreground);
  /** Handles removed this session, so the list updates without a refetch. */
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  // Enabled by default in the durable store. Until this resolves, keep the
  // account-changing control out of the rows so a slow answer can never briefly
  // show an Unfollow button that the backend would refuse.
  const unfollowAllowed = useQuery({
    queryKey: ["unfollowAllowed"],
    queryFn: api.unfollowAllowed,
  });
  const capabilities = useQuery({
    queryKey: ["providerCapabilities"],
    queryFn: api.providerCapabilities,
    staleTime: 5 * 60_000,
  });
  const providerSupportsUnfollow = capabilities.data?.unfollow === true;
  const canUnfollow = unfollowAllowed.data === true && providerSupportsUnfollow;

  const setAllowUnfollow = async (on: boolean) => {
    if (settingWorking) return;
    setSettingWorking(true);
    setSettingFailure(null);
    try {
      await api.setSetting("actions.allowUnfollow", on ? "true" : "false");
      await qc.invalidateQueries({ queryKey: ["unfollowAllowed"] });
    } catch (e) {
      setSettingFailure(
        e instanceof Error
          ? e.message
          : String((e as { message?: string })?.message ?? e),
      );
    } finally {
      setSettingWorking(false);
    }
  };

  // Reads this run's store. No network, so opening the page is free.
  const snapshot = useQuery({
    queryKey: ["followingSnapshot"],
    queryFn: api.followingSnapshot,
    refetchOnWindowFocus: 'always',
    refetchInterval: query => query.state.data?.syncing ? 1000 : false,
  });
  useEffect(()=>{if(foreground) void qc.invalidateQueries({queryKey:['followingSnapshot']});},[foreground,qc]);

  const accounts = useMemo(
    () => snapshot.data?.accounts ?? [],
    [snapshot.data],
  );
  const complete = snapshot.data?.complete ?? false;
  const syncing = snapshot.data?.syncing ?? false;
  const syncState = snapshot.data?.state ?? (syncing ? 'loading' : complete ? 'complete' : 'idle');
  // One automatic attempt per authenticated account generation. A boolean here
  // strands the next account if the reader switches sessions in one window.
  const autoAttemptedFor = useRef<number | null>(null);
  const { phase, readyToken } = useSessionReady();
  const retrySync=async()=>{
    autoAttemptedFor.current=readyToken;setSyncStartError(null);
    try {await api.startFollowingSync();await snapshot.refetch();}
    catch(error) {setSyncStartError(toAppError(error).message);}
  };

  // Progress is pushed, not polled: the worker emits on every batch it files.
  // Start registering this effect before the automatic start below. React runs
  // effects in declaration order; the post-command refetch and terminal retry
  // below also close the small async gap before Tauri finishes installing the
  // listener.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    let refreshTimer: number | null = null;
    let terminalRefreshTimer: number | null = null;

    const invalidate = () => {
      void qc.invalidateQueries({ queryKey: ["followingSnapshot"] });
    };

    void listen<PreloadProgress>(FOLLOWING_PROGRESS_EVENT, (event) => {
      // Use a trailing debounce so a batch burst costs one refetch, but never
      // discard a terminal event behind an already-pending timer.
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        invalidate();
      }, 200);

      if (
        event.payload.stage === "complete" ||
        event.payload.stage === "failed" ||
        event.payload.stage === "cancelled"
      ) {
        if (terminalRefreshTimer !== null) {
          window.clearTimeout(terminalRefreshTimer);
        }
        // The worker publishes progress immediately around its final database
        // write. A second, bounded refetch closes that commit/event race.
        terminalRefreshTimer = window.setTimeout(() => {
          terminalRefreshTimer = null;
          invalidate();
        }, 500);
      }
    }).then((un) => {
      if (cancelled) un();
      else stop = un;
    });

    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (terminalRefreshTimer !== null) {
        window.clearTimeout(terminalRefreshTimer);
      }
      stop?.();
    };
  }, [qc]);

  // Ask for the rest only when the store genuinely does not have it. A partial
  // snapshot is the normal state during startup preload, and `startFollowingSync`
  // answers false rather than starting a second traversal if one is running.
  useEffect(() => {
    if (
      !snapshot.data ||
      syncState === 'failed' || syncState === 'cancelled' ||
      complete ||
      syncing ||
      autoAttemptedFor.current === readyToken ||
      phase !== "ready" ||
      readyToken === 0
    ) {
      return;
    }
    autoAttemptedFor.current = readyToken;
    void api
      .startFollowingSync()
      .then(() => {
        // A false answer means another worker already owns the traversal. In
        // either case, read the authoritative snapshot once after the command
        // returns instead of relying solely on an event arriving in time.
        void qc.invalidateQueries({ queryKey: ["followingSnapshot"] });
      })
      .catch((error:unknown) => {
        // A failed start settles visibly. Only a deliberate retry or a new
        // account generation may start again; refetching must not create a loop.
        setSyncStartError(toAppError(error).message);
        void qc.invalidateQueries({ queryKey: ["followingSnapshot"] });
      });
  }, [snapshot.data, complete, syncing, syncState, phase, readyToken, qc]);

  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const pinned = useQuery({
    queryKey: ["pinned"],
    queryFn: api.pinnedAccounts,
  });

  const pinnedSet = useMemo(
    () => new Set((pinned.data ?? []).map((a) => a.id)),
    [pinned.data],
  );

  const present = useMemo(
    () => accounts.filter((a) => !removed.has(a.id)),
    [accounts, removed],
  );

  // `matchAccounts` folds diacritics and the Arabic alef/ya variants, so a
  // search typed without them still finds the account. A plain `includes` on a
  // lowercased string does not, which matters on a list this long.
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return present;
    return matchAccounts(present, q, present.length);
  }, [present, query]);

  // An empty, incomplete snapshot means "the traversal has not delivered its
  // first batch yet", not "this account follows nobody". Keeping the empty
  // state hidden here prevents the misleading loading-plus-empty combination
  // seen on the native People page.
  const awaitingAccounts =
    Boolean(snapshot.data) && present.length === 0 && syncState === 'loading';
  const snapshotError = snapshot.error
    ? snapshot.error instanceof Error
      ? snapshot.error.message
      : String(snapshot.error)
    : null;

  /**
   * Perform the unfollow the dialog just confirmed.
   *
   * One attempt. If it fails the account stays on screen and the error is
   * shown as-is: retrying automatically could unfollow twice, and "it may have
   * already worked" is not a state to guess about on somebody's behalf.
   */
  const confirmUnfollow = async () => {
    if (!confirming || working) return;
    setWorking(true);
    setFailure(null);
    try {
      await api.unfollowAccount(confirming.username);
      setRemoved((s) => new Set(s).add(confirming.id));
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["followingSnapshot"] });
      void qc.invalidateQueries({ queryKey: ["sessionStatus"] });
    } catch (e) {
      setFailure(
        e instanceof Error
          ? e.message
          : String((e as { message?: string })?.message ?? e),
      );
    } finally {
      setWorking(false);
    }
  };

  const togglePin = async (a: Author) => {
    await api.pinAccount(a.id, !pinnedSet.has(a.id));
    void qc.invalidateQueries({ queryKey: ["pinned"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const addToGroup = async (authorId: string, groupId: string) => {
    if (!groupId) return;
    await api.setGroupMember(groupId, authorId, true);
    void qc.invalidateQueries({ queryKey: ["groups"] });
  };

  return (
    <>
      <PageHeader
        title={t("people.title")}
        subtitle={
          query
            ? t("people.showing", {
                shown: String(filtered.length),
                total: String(present.length),
              })
            : plural("people.count", present.length)
        }
      />

      <div className="px-3 sm:px-6 py-4 sm:py-5 max-w-[900px] mx-auto w-full">
        <div className="relative mb-4">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-ink-mute pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("people.search")}
            className="ps-9"
            aria-label={t("people.search.aria")}
          />
        </div>

        <div className="surface-card mb-4 flex items-center justify-between gap-4 p-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">
              {t("people.unfollowToggle")}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-mute">
              {providerSupportsUnfollow
                ? t("people.unfollowToggle.desc")
                : t("people.unfollowUnavailable")}
            </p>
          </div>
          <Switch
            checked={unfollowAllowed.data === true}
            disabled={
              settingWorking ||
              !unfollowAllowed.isSuccess ||
              !capabilities.isSuccess ||
              !providerSupportsUnfollow
            }
            onCheckedChange={(on) => void setAllowUnfollow(on)}
            aria-label={t("people.unfollowToggle")}
          />
        </div>

        {settingFailure ? (
          <p className="mb-3 text-[12.5px] text-bad" role="alert">
            {settingFailure}
          </p>
        ) : null}

        {/* The wording has to match what the app can actually do. Claiming
            "read-only" while an Unfollow button is on screen would be the
            worse of the two possible inaccuracies. */}
        <p className="text-[12px] text-ink-mute mb-4">
          {canUnfollow
            ? t("people.unfollowOn")
            : !providerSupportsUnfollow && capabilities.isSuccess
              ? t("people.unfollowUnavailable")
              : t("people.readOnlyNote")}
        </p>

        {/* Only while a traversal is genuinely running, and only as a line of
            text: the accounts already obtained are on screen underneath it. */}
        {awaitingAccounts || (syncing && !complete) ? (
          <p role="status" className="text-[12px] text-ink-mute mb-3">
            {t("people.loading")}
          </p>
        ) : null}

        {(syncStartError || snapshot.data?.lastError) && <div className="mb-3"><ErrorState message={syncStartError || snapshot.data!.lastError!} onRetry={retrySync} busy={syncing}/></div>}
        {snapshot.isError ? (
          <ErrorState
            message={snapshotError}
            onRetry={() => void snapshot.refetch()}
            busy={snapshot.isFetching}
          />
        ) : snapshot.isLoading || awaitingAccounts ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <ul className="space-y-2">
            {filtered.map((a) => {
              const isPinned = pinnedSet.has(a.id);
              return (
                <li
                  key={a.id}
                  className="surface-card p-3 flex items-center gap-3"
                >
                  {/* Avatar, name and handle are each their own button, and
                      each opens this account's posts inside the app. */}
                  <AccountIdentity
                    account={a}
                    size={40}
                    layout="stacked"
                    className="flex-1"
                    onOpenProfile={openProfile}
                    trailing={
                      <>
                        {isPinned ? (
                          <Badge tone="accent">{t("people.pinned")}</Badge>
                        ) : null}
                      </>
                    }
                    secondary={
                      a.followersCount != null ? (
                        <p className="text-[11.5px] text-ink-mute mt-0.5">
                          {plural("profile.followers", a.followersCount, {
                            count: formatCompact(a.followersCount),
                          })}
                        </p>
                      ) : null
                    }
                  />

                  {groups.data && groups.data.length > 0 ? (
                    <Select
                      defaultValue=""
                      onChange={(e) => void addToGroup(a.id, e.target.value)}
                      aria-label={t("people.addToGroup.aria", {
                        name: a.username,
                      })}
                      className="h-8 text-[12px]"
                    >
                      <option value="">{t("people.addToGroup")}</option>
                      {groups.data.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                  ) : null}

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void togglePin(a)}
                    aria-label={
                      isPinned
                        ? t("people.unpin", { name: a.username })
                        : t("people.pin", { name: a.username })
                    }
                    className={cn(isPinned && "text-accent")}
                  >
                    {isPinned ? <PinOff /> : <Pin />}
                  </Button>

                  {/* Rendered only when genuinely permitted. There is no
                      disabled-but-visible state: an action the app will refuse
                      should not look available. */}
                  {canUnfollow ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        setFailure(null);
                        setConfirming(a);
                      }}
                      aria-label={t("account.unfollow.aria", {
                        handle: `@${a.username}`,
                      })}
                      className="text-ink-mute hover:text-bad"
                    >
                      <UserMinus />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          syncState === 'failed' || syncState === 'cancelled' ? null : !complete && accounts.length===0 ? <div className="space-y-3 text-sm text-ink-mute"><p>{t('people.notLoaded')}</p><Button onClick={()=>void retrySync()}>{t('common.retry')}</Button></div> : <EmptyState
            icon={<Users className="size-8" />}
            title={query ? t("people.noMatch.title") : t("people.empty.title")}
            hint={query ? t("people.noMatch.hint") : t("people.empty.hint")}
          />
        )}
      </div>

      {confirming ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unfollow-title"
        >
          <div className="surface-card w-full max-w-[420px] p-5">
            <h2
              id="unfollow-title"
              className="text-[15px] font-semibold text-ink"
            >
              {t("account.unfollow.confirm.title")}
            </h2>
            {/* Display name and exact handle, so the dialog cannot be
                confirmed against the wrong row. The handle is an identifier,
                so it stays LTR even in Arabic. */}
            <p className="mt-2 text-[13px] text-ink-dim">
              {confirming.displayName}{" "}
              <span dir="ltr" className="text-ink-mute">
                @{confirming.username}
              </span>
            </p>
            <p className="mt-3 text-[12.5px] text-warn">
              {t("account.unfollow.confirm.body")}
            </p>

            {failure ? (
              <p className="mt-3 text-[12.5px] text-bad" role="alert">
                {failure}
              </p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(null);
                  setFailure(null);
                }}
                disabled={working}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => void confirmUnfollow()}
                disabled={working}
              >
                {working
                  ? t("account.working")
                  : t("account.unfollow.confirm.action", {
                      handle: `@${confirming.username}`,
                    })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
