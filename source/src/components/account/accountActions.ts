import { create } from "zustand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Author, type SessionSnapshot } from "@/lib/api";
import { usePlatform } from '@/lib/platform';
import { handleKey } from "./Avatar";

/**
 * What the app knows about whether this session follows an account.
 *
 * `checking` is a real state, not a placeholder. The relationship is only
 * known once the following list has been read; inferring it from "this author
 * appeared in the feed cache" would show Unfollow for accounts that were
 * merely reposted by somebody else.
 */
export type Relationship =
  "checking" | "following" | "notFollowing" | "pending" | "unknown";

/** The two operations that genuinely change the connected X account. */
export type AccountAction = "follow" | "unfollow";

/**
 * A failed attempt.
 *
 * The backend's own sentence is kept apart from the localized headline so the
 * interface never has to concatenate two languages into one string.
 */
export interface AccountFailure {
  action: AccountAction;
  detail: string;
}

// ---------------------------------------------------------------------------
// The in-flight operation and its optimistic result
// ---------------------------------------------------------------------------

interface AccountActionState {
  /**
   * The account currently being changed, as a handle key. Exactly one at a
   * time: two follow calls racing on the same session is a way to end up
   * unsure which one won.
   */
  busy: string | null;
  /**
   * Optimistic relationship per handle key, laid over the fetched list.
   *
   * Shared rather than per-component, which is what makes every visible copy
   * of an account — a feed author, a search row, the open profile — change
   * together instead of only the one that was clicked.
   */
  overrides: Record<string, boolean>;
  /** The last failure per handle key. Never auto-cleared by a retry timer. */
  failures: Record<string, AccountFailure>;
  /** Claim the single slot. Returns false when something else holds it. */
  begin: (username: string, next: boolean) => boolean;
  /** The change went through: keep the optimistic value, release the slot. */
  succeed: (username: string) => void;
  /** It did not: drop the optimistic value and record why. No retry. */
  fail: (username: string, failure: AccountFailure) => void;
  clearFailure: (username: string) => void;
  /** Test seam. Never called by the interface. */
  reset: () => void;
}

const withoutKey = <T>(
  map: Record<string, T>,
  key: string,
): Record<string, T> => {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
};

export const useAccountActionStore = create<AccountActionState>((set, get) => ({
  busy: null,
  overrides: {},
  failures: {},

  begin: (username, next) => {
    if (get().busy !== null) return false;
    const key = handleKey(username);
    if (!key) return false;
    set((s) => ({
      busy: key,
      overrides: { ...s.overrides, [key]: next },
      failures: withoutKey(s.failures, key),
    }));
    return true;
  },

  succeed: (username) => {
    const key = handleKey(username);
    set((s) => (s.busy === key ? { busy: null } : s));
  },

  fail: (username, failure) => {
    const key = handleKey(username);
    set((s) => ({
      busy: s.busy === key ? null : s.busy,
      // Rollback is a deletion, not a second guess: with the override gone the
      // fetched list shows through again, which is the only value we know.
      overrides: withoutKey(s.overrides, key),
      failures: { ...s.failures, [key]: failure },
    }));
  },

  clearFailure: (username) =>
    set((s) => ({ failures: withoutKey(s.failures, handleKey(username)) })),

  reset: () => set({ busy: null, overrides: {}, failures: {} }),
}));

/** True while any account-changing request is in flight, anywhere. */
export function useAnyAccountActionBusy(): boolean {
  return useAccountActionStore((s) => s.busy !== null);
}

// ---------------------------------------------------------------------------
// Whether the interface may offer these actions at all
// ---------------------------------------------------------------------------

export interface AccountActionGate {
  /** Both answers are in. Until then the controls do not render at all. */
  ready: boolean;
  canFollow: boolean;
  canUnfollow: boolean;
}

/**
 * The two gates, combined.
 *
 * A preference the reader set, and a capability the pinned backend genuinely
 * has. Both must say yes; neither alone is enough, and a slow answer renders
 * nothing rather than briefly showing a control the app would refuse.
 */
export function useAccountActionGate(): AccountActionGate {
  const allowed = useQuery({
    queryKey: ["unfollowAllowed"],
    queryFn: api.unfollowAllowed,
    staleTime: 60_000,
  });
  const caps = useQuery({
    queryKey: ["providerCapabilities"],
    queryFn: api.providerCapabilities,
    staleTime: 5 * 60_000,
  });

  const ready = allowed.isSuccess && caps.isSuccess;
  const on = allowed.data === true;
  return {
    ready,
    canFollow: ready && on && caps.data?.follow === true,
    canUnfollow: ready && on && caps.data?.unfollow === true,
  };
}

// ---------------------------------------------------------------------------
// The relationship itself
// ---------------------------------------------------------------------------

export interface RelationshipResult {
  state: Relationship;
  /** Re-read the following list. The only way out of `unknown`. */
  recheck: () => void;
  /** This particular account is the one being changed right now. */
  isWorking: boolean;
  /** Some account is being changed, so every control is inert. */
  isLocked: boolean;
  failure: AccountFailure | null;
}

/**
 * Whether this session follows `username`.
 *
 * The following list is the source of truth. An optimistic override sits on
 * top of it so a click reads as done immediately, and disappears again if the
 * request comes back a failure.
 */
export function useRelationship(username: string, enabled = true): RelationshipResult {
  const key = handleKey(username);
  const { isIphone } = usePlatform();
  const session = useQuery({ queryKey:['sessionStatus'], queryFn:api.sessionStatus, enabled:isIphone, staleTime:60_000 });
  const accountId = session.data?.account?.id;
  const targeted = useQuery({
    queryKey:['accountRelationship',accountId,key], queryFn:()=>api.accountRelationship(key),
    enabled:isIphone && enabled && Boolean(accountId), staleTime:60_000, retry:false,
  });
  const following = useQuery({
    queryKey: ["followingSnapshot"],
    queryFn: api.followingSnapshot,
    staleTime: 60_000,
    enabled: !isIphone && enabled,
  });
  const override = useAccountActionStore((s) => s.overrides[key]);
  const busy = useAccountActionStore((s) => s.busy);
  const failure = useAccountActionStore((s) => s.failures[key] ?? null);

  let state: Relationship;
  if (override !== undefined) {
    state = override ? "following" : "notFollowing";
  } else if (isIphone) {
    state = targeted.isSuccess ? targeted.data : targeted.isError || !accountId ? 'unknown' : 'checking';
  } else if (following.isSuccess) {
    const list = following.data?.accounts ?? [];
    if (list.some((a: Author) => handleKey(a.username) === key)) {
      state = "following";
    } else {
      // Absence is only evidence once the background traversal proved it saw
      // the complete list. A 30-account prefix must not make account 31 look
      // unfollowed.
      state = following.data?.complete ? "notFollowing" : "unknown";
    }
  } else if (following.isError) {
    state = "unknown";
  } else {
    state = "checking";
  }

  return {
    state,
    recheck: () => { if (isIphone) void targeted.refetch(); else void following.refetch(); },
    isWorking: busy === key,
    isLocked: busy !== null,
    failure,
  };
}

// ---------------------------------------------------------------------------
// Running the change
// ---------------------------------------------------------------------------

/**
 * Perform one follow or unfollow.
 *
 * One attempt, ever. A failed follow may well have succeeded on X with the
 * response lost on the way back, and repeating it is not a safe guess to make
 * on somebody's behalf.
 */
export function useAccountAction(): (
  action: AccountAction,
  username: string,
) => Promise<boolean> {
  const qc = useQueryClient();
  const begin = useAccountActionStore((s) => s.begin);
  const { isIphone } = usePlatform();
  const succeed = useAccountActionStore((s) => s.succeed);
  const fail = useAccountActionStore((s) => s.fail);

  return async (action, username) => {
    const accountId = qc.getQueryData<SessionSnapshot>(['sessionStatus'])?.account?.id;
    const sameAccount = () => accountId === qc.getQueryData<SessionSnapshot>(['sessionStatus'])?.account?.id;
    const next = action === "follow";
    if (!begin(username, next)) return false;
    try {
      if (next) await api.followAccount(username);
      else await api.unfollowAccount(username);
      if (!sameAccount()) return false;
      if (isIphone) {
        const relationship = await api.accountRelationship(username).catch(() => 'unknown' as const);
        if (!sameAccount()) return false;
        qc.setQueryData(['accountRelationship',accountId,handleKey(username)],relationship);
        useAccountActionStore.setState(state => ({ overrides: withoutKey(state.overrides,handleKey(username)) }));
      }
      succeed(username);
      void qc.invalidateQueries({ queryKey: ["followingAccounts"] });
      void qc.invalidateQueries({ queryKey: ["followingSnapshot"] });
      void qc.invalidateQueries({ queryKey:['userProfile',username] });
      return true;
    } catch (e) {
      if (!sameAccount()) return false;
      fail(username, { action, detail: messageOf(e) });
      return false;
    }
  };
}

/** Pull a readable line out of whatever the bridge threw. */
export function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return "";
}
