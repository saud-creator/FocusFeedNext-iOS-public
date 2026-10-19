import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clipboard,
  Link2Off,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
} from "lucide-react";
import {
  api,
  isTauri,
  toAppError,
  type CompanionHostStatus,
  type SessionSnapshot,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/primitives";
import {
  SessionBadge,
  sessionReasonKey,
} from "@/components/session/SessionDot";
import { resetFeedSessionState } from "@/hooks/useFeed";
import {
  acceptConnectedSession,
  acceptSessionSnapshot,
} from "@/hooks/useStartupSequence";
import { useAccountActionStore } from "@/components/account/accountActions";
import { useI18n } from "@/i18n";

type Outcome = { kind: "ok" | "error"; text: string } | null;

/**
 * The explicit Windows side of the iPhone companion.
 *
 * Nothing listens on the LAN until the user presses Start.  JavaScript sees
 * the short, one-use pairing code but never receives the bearer token or the X
 * cookies held by the Windows credential store.
 */
export function WindowsIphoneCompanion() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [copied, setCopied] = useState<"address" | "code" | null>(null);

  const status = useQuery({
    queryKey: ["iphoneCompanionStatus"],
    queryFn: api.iphoneCompanionStatus,
    enabled: isTauri(),
    refetchInterval: (query) =>
      (query.state.data as CompanionHostStatus | undefined)?.running
        ? 5_000
        : false,
  });

  const start = useMutation({
    mutationFn: api.startIphoneCompanion,
    onSuccess: (value) => {
      queryClient.setQueryData(["iphoneCompanionStatus"], value);
      setOutcome({ kind: "ok", text: t("companion.windows.started") });
    },
    onError: (error) =>
      setOutcome({ kind: "error", text: toAppError(error).message }),
  });
  const stop = useMutation({
    mutationFn: api.stopIphoneCompanion,
    onSuccess: (value) => {
      queryClient.setQueryData(["iphoneCompanionStatus"], value);
      setOutcome({ kind: "ok", text: t("companion.windows.stopped") });
    },
    onError: (error) =>
      setOutcome({ kind: "error", text: toAppError(error).message }),
  });

  const copy = async (kind: "address" | "code", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      setOutcome({ kind: "error", text: t("companion.copyFailed") });
    }
  };

  const current = status.data;
  const busy = start.isPending || stop.isPending;

  return (
    <Card>
      <CardHeader
        title={t("companion.windows.title")}
        subtitle={t("companion.windows.subtitle")}
        icon={<MonitorSmartphone className="size-4" />}
      />
      <CardBody className="space-y-4">
        <p className="text-[13px] text-ink-dim">
          {t("companion.windows.explanation")}
        </p>

        <div className="rounded-xl border border-edge bg-surface-1 p-3.5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] text-ink-dim">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${current?.running ? "bg-good" : "bg-ink-mute"}`}
              />
              {current?.running
                ? t("companion.windows.running")
                : t("companion.windows.notRunning")}
            </div>
            {current?.pairedOnce ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-good">
                <Check className="size-3.5" />
                {t("companion.windows.paired")}
              </span>
            ) : null}
          </div>

          {current?.running ? (
            <dl className="space-y-2.5">
              <CompanionValue
                label={t("companion.address")}
                value={current.address ?? t("companion.addressUnavailable")}
                copied={copied === "address"}
                onCopy={
                  current.address
                    ? () => void copy("address", current.address as string)
                    : undefined
                }
              />
              <CompanionValue
                label={t("companion.code")}
                value={current.pairingCode ?? "—"}
                code
                copied={copied === "code"}
                onCopy={
                  current.pairingCode
                    ? () => void copy("code", current.pairingCode as string)
                    : undefined
                }
              />
            </dl>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {current?.running ? (
            <Button
              variant="danger"
              size="md"
              disabled={busy}
              onClick={() => stop.mutate()}
            >
              <Square />
              {stop.isPending
                ? t("companion.windows.stopping")
                : t("companion.windows.stop")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              disabled={busy || !isTauri()}
              onClick={() => start.mutate()}
            >
              <Wifi />
              {start.isPending
                ? t("companion.windows.starting")
                : t("companion.windows.start")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="md"
            disabled={!isTauri() || status.isFetching}
            onClick={() => void status.refetch()}
          >
            <RefreshCw />
            {t("companion.refresh")}
          </Button>
        </div>

        {outcome ? <OutcomeMessage outcome={outcome} /> : null}

        <div className="space-y-2 border-t border-edge pt-3 text-[12.5px] text-ink-mute">
          <p>{t("companion.windows.instructions")}</p>
          <p className="flex gap-2">
            <ShieldCheck className="size-4 shrink-0 mt-px" />
            <span>{t("companion.windows.security")}</span>
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

/** iPhone side: exchanges the one-use code and stores only its bridge token. */
export function IphoneCompanionConnection() {
  const { t, formatDateTime } = useI18n();
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);

  const session = useQuery({
    queryKey: ["sessionStatus"],
    queryFn: api.sessionStatus,
  });
  const snapshot = session.data;
  const connected = snapshot?.account != null;

  const resetAccountQueries = () => {
    void qc.resetQueries({
      predicate: (query) => query.queryKey[0] !== "sessionStatus",
    });
  };
  const acceptConnection = (value: SessionSnapshot) => {
    resetFeedSessionState();
    resetAccountQueries();
    useAccountActionStore.getState().reset();
    acceptConnectedSession(value);
    qc.setQueryData(["sessionStatus"], value);
  };

  const connect = useMutation({
    mutationFn: () => {
      const attempt = { address: address.trim(), code: code.trim() };
      // The one-use code has no purpose in React state after dispatch.
      setCode("");
      return api.connectIphoneCompanion(attempt.address, attempt.code);
    },
    onSuccess: (value: SessionSnapshot) => {
      acceptConnection(value);
      setOutcome({
        kind: "ok",
        text: value.account
          ? t("companion.iphone.connectedAs", {
              username: value.account.username,
            })
          : t("companion.iphone.connected"),
      });
    },
    onError: (error) =>
      setOutcome({ kind: "error", text: toAppError(error).message }),
  });

  const recheck = useMutation({
    mutationFn: () => api.checkSession(true),
    onSuccess: (value: SessionSnapshot) => {
      acceptSessionSnapshot(value);
      qc.setQueryData(["sessionStatus"], value);
      setOutcome(
        value.state === "connected"
          ? { kind: "ok", text: t("session.status.connected.desc") }
          : { kind: "error", text: t(sessionReasonKey(value.reason)) },
      );
    },
    onError: (error) =>
      setOutcome({ kind: "error", text: toAppError(error).message }),
  });

  const disconnect = useMutation({
    mutationFn: api.disconnect,
    onSuccess: (value: SessionSnapshot) => {
      resetFeedSessionState();
      resetAccountQueries();
      useAccountActionStore.getState().reset();
      acceptSessionSnapshot(value);
      qc.setQueryData(["sessionStatus"], value);
      setOutcome({ kind: "ok", text: t("companion.iphone.disconnected") });
    },
    onError: (error) =>
      setOutcome({ kind: "error", text: toAppError(error).message }),
  });

  useEffect(() => {
    if (address || code) setOutcome(null);
  }, [address, code]);

  const busy = connect.isPending || recheck.isPending || disconnect.isPending;
  const canConnect =
    address.trim() !== "" && /^\d{8}$/.test(code.trim()) && !busy;

  return (
    <Card>
      <CardHeader
        title={t("companion.iphone.title")}
        subtitle={t("companion.iphone.subtitle")}
        icon={<Smartphone className="size-4" />}
      />
      <CardBody className="space-y-4">
        <p className="text-[13px] text-ink-dim">
          {t("companion.iphone.explanation")}
        </p>

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
              <div className="grid size-10 place-items-center rounded-full border border-edge bg-surface-3 text-ink-mute">
                <MonitorSmartphone className="size-5" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {connected ? (
                <>
                  <div className="text-sm text-ink truncate">
                    {snapshot.account?.displayName}
                  </div>
                  <div
                    className="text-[12.5px] text-ink-mute truncate"
                    dir="ltr"
                  >
                    @{snapshot.account?.username}
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-ink-dim">
                  {t("companion.iphone.notConnected")}
                </div>
              )}
            </div>
            {snapshot ? <SessionBadge snapshot={snapshot} /> : null}
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
            <dt className="text-ink-mute">{t("connect.credentials")}</dt>
            <dd className="text-ink-dim">
              {snapshot?.hasCredentials
                ? t("companion.iphone.keychainStored")
                : t("connect.credentials.none")}
            </dd>
            <dt className="text-ink-mute">{t("connect.provider")}</dt>
            <dd className="text-ink-dim" dir="ltr">
              iphone-companion
            </dd>
            <dt className="text-ink-mute">{t("connect.lastValidated")}</dt>
            <dd className="text-ink-dim">
              {snapshot?.checkedAt
                ? formatDateTime(snapshot.checkedAt)
                : t("connect.never")}
            </dd>
          </dl>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="ffn-companion-address"
              className="text-[12.5px] text-ink-dim"
            >
              {t("companion.address")}
            </label>
            <Input
              id="ffn-companion-address"
              type="url"
              inputMode="url"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="http://192.168.1.25:49152"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="ffn-companion-code"
              className="text-[12.5px] text-ink-dim"
            >
              {t("companion.code")}
            </label>
            <Input
              id="ffn-companion-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, "").slice(0, 8))
              }
              placeholder="12345678"
              autoComplete="one-time-code"
              dir="ltr"
              className="tracking-[0.22em] tabular-nums"
            />
          </div>
          <p className="text-[12px] text-ink-mute">
            {t("companion.iphone.whereToFind")}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="md"
            disabled={!canConnect}
            onClick={() => connect.mutate()}
          >
            <Wifi />
            {connect.isPending
              ? t("companion.iphone.pairing")
              : connected
                ? t("companion.iphone.pairAgain")
                : t("companion.iphone.pair")}
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

        {outcome ? <OutcomeMessage outcome={outcome} /> : null}

        <p className="flex gap-2 border-t border-edge pt-3 text-[12.5px] text-ink-mute">
          <ShieldCheck className="size-4 shrink-0 mt-px" />
          <span>{t("companion.iphone.security")}</span>
        </p>
      </CardBody>
    </Card>
  );
}

function CompanionValue({
  label,
  value,
  copied,
  code = false,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  code?: boolean;
  onCopy?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <div className="min-w-0">
        <dt className="text-[11.5px] text-ink-mute">{label}</dt>
        <dd
          className={
            code
              ? "text-xl font-semibold tracking-[0.2em] tabular-nums text-ink"
              : "truncate text-[13px] tabular-nums text-ink-dim"
          }
          dir="ltr"
        >
          {value}
        </dd>
      </div>
      {onCopy ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("companion.copy", { label })}
          onClick={onCopy}
        >
          {copied ? <Check /> : <Clipboard />}
        </Button>
      ) : null}
    </div>
  );
}

function OutcomeMessage({ outcome }: { outcome: NonNullable<Outcome> }) {
  return (
    <p
      role="status"
      className={
        outcome.kind === "ok" ? "text-[13px] text-good" : "text-[13px] text-bad"
      }
    >
      {outcome.text}
    </p>
  );
}
