import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  KeyRound,
  Link2Off,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api, toAppError, type SessionSnapshot } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/primitives";
import {
  SessionBadge,
  sessionReasonKey,
} from "@/components/session/SessionDot";
import { useI18n } from "@/i18n";
import { resetFeedSessionState } from "@/hooks/useFeed";
import {
  acceptConnectedSession,
  acceptSessionSnapshot,
} from "@/hooks/useStartupSequence";
import {
  useAccountActionStore,
  useAnyAccountActionBusy,
} from "@/components/account/accountActions";

type Outcome = { kind: "ok" | "error"; text: string } | null;

/**
 * Settings → X connection.
 *
 * The security-relevant behaviour lives here, so it is worth stating plainly:
 *
 * - Both fields start empty and are **never** prefilled from storage. There is
 *   no code path that can read a stored credential back, in this component or
 *   anywhere else in the frontend.
 * - They are `type="password"` with no reveal control, and `autoComplete` is
 *   off so the browser's own credential store never sees them either.
 * - The pair travels in a single `connect` call and both fields are cleared
 *   the moment it is dispatched, so the values live in React state for the
 *   duration of one submit and no longer.
 * - Nothing here logs, and the response is a `SessionSnapshot`, which has no
 *   field capable of carrying a secret back.
 */
export function XConnection() {
  const { t, formatDateTime } = useI18n();
  const qc = useQueryClient();
  const [authToken, setAuthToken] = useState("");
  const [ct0, setCt0] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);
  const accountActionBusy = useAnyAccountActionBusy();

  const session = useQuery({
    queryKey: ["sessionStatus"],
    queryFn: api.sessionStatus,
  });

  const snapshot = session.data;
  const connected = snapshot?.account != null;

  // Reset, rather than merely mark stale: account A's data must disappear
  // synchronously while account B's empty/new cache is being read.
  const resetAccountQueries = () => {
    void qc.resetQueries({
      predicate: (query) => query.queryKey[0] !== "sessionStatus",
    });
  };

  const clearFields = () => {
    setAuthToken("");
    setCt0("");
  };

  const connect = useMutation({
    mutationFn: async () => {
      const pair = { authToken: authToken.trim(), ct0: ct0.trim() };
      // Cleared before the await, not after: the values are already on their
      // way to secure storage and have no further business in this component.
      clearFields();
      return api.connect(pair.authToken, pair.ct0);
    },
    onSuccess: (snap: SessionSnapshot) => {
      resetFeedSessionState();
      resetAccountQueries();
      useAccountActionStore.getState().reset();
      acceptConnectedSession(snap);
      qc.setQueryData(["sessionStatus"], snap);
      setOutcome({
        kind: "ok",
        text: snap.account
          ? t("connect.testSuccess", { username: snap.account.username })
          : t("connect.success"),
      });
    },
    onError: (e) => setOutcome({ kind: "error", text: toAppError(e).message }),
  });

  const recheck = useMutation({
    mutationFn: () => api.checkSession(true),
    onSuccess: (snap: SessionSnapshot) => {
      acceptSessionSnapshot(snap);
      qc.setQueryData(["sessionStatus"], snap);
      setOutcome(
        snap.state === "connected"
          ? { kind: "ok", text: t("session.status.connected.desc") }
          : { kind: "error", text: t(sessionReasonKey(snap.reason)) },
      );
    },
    onError: (e) => setOutcome({ kind: "error", text: toAppError(e).message }),
  });

  const disconnect = useMutation({
    mutationFn: api.disconnect,
    onSuccess: (snap: SessionSnapshot) => {
      resetFeedSessionState();
      resetAccountQueries();
      useAccountActionStore.getState().reset();
      acceptSessionSnapshot(snap);
      qc.setQueryData(["sessionStatus"], snap);
      clearFields();
      setOutcome({ kind: "ok", text: t("connect.disconnected") });
    },
    onError: (e) => setOutcome({ kind: "error", text: toAppError(e).message }),
  });

  const busy =
    connect.isPending ||
    recheck.isPending ||
    disconnect.isPending ||
    accountActionBusy;
  const canSubmit = authToken.trim() !== "" && ct0.trim() !== "" && !busy;

  // Clearing the outcome when the user starts typing again keeps a stale
  // "X rejected this session" from sitting above a fresh attempt.
  useEffect(() => {
    if (authToken || ct0) setOutcome(null);
  }, [authToken, ct0]);

  return (
    <Card>
      <CardHeader
        title={t("connect.title")}
        icon={<KeyRound className="size-4" />}
      />
      <CardBody className="space-y-4">
        <p className="text-[13px] text-ink-dim">{t("connect.explanation")}</p>

        {/* -- current connection ------------------------------------------ */}
        <div className="rounded-xl border border-edge bg-surface-1 p-3.5 space-y-2.5">
          <div className="flex items-center gap-3">
            {snapshot?.account?.avatarUrl ? (
              <img
                src={snapshot.account.avatarUrl}
                alt=""
                width={40}
                height={40}
                className="size-10 rounded-full border border-edge object-cover"
              />
            ) : (
              <div className="size-10 rounded-full border border-edge bg-surface-3" />
            )}
            <div className="min-w-0 flex-1">
              {connected ? (
                <>
                  <div className="text-sm text-ink truncate">
                    {snapshot?.account?.displayName}
                  </div>
                  {/* A handle is an identifier, not prose: it stays LTR even
                      when the surrounding interface is Arabic. */}
                  <div
                    className="text-[12.5px] text-ink-mute truncate"
                    dir="ltr"
                  >
                    @{snapshot?.account?.username}
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-ink-dim">
                  {t("connect.notConnected")}
                </div>
              )}
            </div>
            {snapshot ? <SessionBadge snapshot={snapshot} /> : null}
          </div>

          {snapshot ? (
            <p className="text-[12.5px] text-ink-mute">
              {t(sessionReasonKey(snapshot.reason))}
            </p>
          ) : null}

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
            <dt className="text-ink-mute">{t("connect.credentials")}</dt>
            <dd className="text-ink-dim">
              {snapshot?.hasCredentials
                ? t("connect.credentials.stored")
                : t("connect.credentials.none")}
            </dd>
            <dt className="text-ink-mute">{t("connect.provider")}</dt>
            <dd className="text-ink-dim" dir="ltr">
              twitter-cli
            </dd>
            <dt className="text-ink-mute">{t("connect.lastValidated")}</dt>
            <dd className="text-ink-dim">
              {snapshot?.checkedAt
                ? formatDateTime(snapshot.checkedAt)
                : t("connect.never")}
            </dd>
            <dt className="text-ink-mute">{t("connect.lastSuccess")}</dt>
            <dd className="text-ink-dim">
              {snapshot?.lastSuccessAt
                ? formatDateTime(snapshot.lastSuccessAt)
                : t("connect.never")}
            </dd>
          </dl>
        </div>

        {/* -- credential entry -------------------------------------------- */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="ffn-auth-token"
              className="text-[12.5px] text-ink-dim"
              dir="ltr"
            >
              {t("connect.authToken")}
            </label>
            <Input
              id="ffn-auth-token"
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder={t("connect.authToken.placeholder")}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
            />
            <p className="text-[12px] text-ink-mute">
              {t("connect.authToken.help")}
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="ffn-ct0"
              className="text-[12.5px] text-ink-dim"
              dir="ltr"
            >
              {t("connect.ct0")}
            </label>
            <Input
              id="ffn-ct0"
              type="password"
              value={ct0}
              onChange={(e) => setCt0(e.target.value)}
              placeholder={t("connect.ct0.placeholder")}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
            />
            <p className="text-[12px] text-ink-mute">{t("connect.ct0.help")}</p>
          </div>

          {connected ? (
            <p className="text-[12px] text-ink-mute">
              {t("connect.replaceHint")}
            </p>
          ) : null}
        </div>

        {/* -- actions ------------------------------------------------------ */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="md"
            disabled={!canSubmit}
            onClick={() => connect.mutate()}
          >
            {connect.isPending
              ? t("connect.saving")
              : connected
                ? t("connect.replace")
                : t("connect.save")}
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy || !snapshot?.hasCredentials}
            onClick={() => recheck.mutate()}
          >
            <RefreshCw />
            {recheck.isPending ? t("connect.testing") : t("connect.test")}
          </Button>
          <Button
            variant="ghost"
            size="md"
            disabled={busy || !snapshot?.hasCredentials}
            onClick={() => disconnect.mutate()}
          >
            <Link2Off />
            {t("connect.disconnect")}
          </Button>
        </div>

        {outcome ? (
          <p
            role="status"
            className={
              outcome.kind === "ok"
                ? "text-[13px] text-good"
                : "text-[13px] text-bad"
            }
          >
            {outcome.text}
          </p>
        ) : null}

        {/* -- standing advice ---------------------------------------------- */}
        <div className="space-y-2 border-t border-edge pt-3">
          <p className="text-[12.5px] text-ink-mute flex gap-2">
            <ShieldCheck className="size-4 shrink-0 mt-px" />
            <span>{t("connect.storageWarning")}</span>
          </p>
          <p className="text-[12.5px] text-ink-mute flex gap-2">
            <AlertTriangle className="size-4 shrink-0 mt-px" />
            <span>{t("connect.neverPassword")}</span>
          </p>
          <p className="text-[12.5px] text-ink-mute flex gap-2">
            <AlertTriangle className="size-4 shrink-0 mt-px" />
            <span>{t("connect.burnerAdvice")}</span>
          </p>
        </div>

        <details className="text-[12.5px] text-ink-mute">
          <summary className="cursor-pointer text-ink-dim">
            {t("connect.howTo.title")}
          </summary>
          <ol className="mt-2 space-y-1 list-decimal ms-5">
            <li>{t("connect.howTo.step1")}</li>
            <li>{t("connect.howTo.step2")}</li>
            <li>{t("connect.howTo.step3")}</li>
            <li>{t("connect.howTo.step4")}</li>
          </ol>
        </details>
      </CardBody>
    </Card>
  );
}
