import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { api, type SessionSnapshot } from "@/lib/api";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { runConnectionTest, useStartupSequence } from "@/hooks/useStartupSequence";
import { sessionReasonKey, sessionStateKey } from "./SessionDot";

/**
 * Format a measured latency.
 *
 * Under a second in whole milliseconds, a second or more in seconds to one
 * decimal — "2.7 s" is easier to judge at a glance than "2683 ms", and the
 * extra precision below a second is what tells a fast connection from a
 * merely acceptable one.
 */
export function formatLatency(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const TONE: Record<string, string> = {
  connected: "bg-good",
  degraded: "bg-warn",
  expired: "bg-bad",
  disconnected: "bg-ink-mute",
};

/**
 * The always-visible connection area: status chip, Test Connection, and
 * whatever the page supplies as its own actions.
 *
 * The chip is deliberately small. Diagnostics is a page; a top bar that grows
 * into one is a top bar nobody can read past.
 */
export function ConnectionControls() {
  const { t, formatNumber } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // This component is on every page header, which makes it the natural place to
  // start the launch sequence. Starting it more than once is impossible; see
  // `useStartupSequence`.
  const startup = useStartupSequence();

  const session = useQuery({
    queryKey: ["sessionStatus"],
    queryFn: api.sessionStatus,
  });
  const snapshot: SessionSnapshot | undefined = session.data;

  // The lifecycle is the one that talks to the provider; this query is how the
  // sidebar dot and the Settings screen see the same answer without a second
  // probe, so its cache is where the result goes.
  useEffect(() => {
    if (startup.snapshot) qc.setQueryData(["sessionStatus"], startup.snapshot);
  }, [startup.snapshot, qc]);

  // The lifecycle holds the single-flight promise, so a double click, a
  // re-mount and a monitoring tick cannot between them start two `twitter.exe`
  // processes. The local flag is only about this button's own label.
  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const snap = await runConnectionTest();
      if (snap) qc.setQueryData(["sessionStatus"], snap);
    } finally {
      setTesting(false);
    }
  };

  // Close the popover on Escape or an outside click. Both, because a popover
  // that can only be dismissed one way traps keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const checking = startup.phase === "checking" || snapshot?.checking || testing;
  const state = snapshot?.state ?? "disconnected";
  const latency = formatLatency(snapshot?.latencyMs);

  // A latency describes the last request that worked. Beside a green chip that
  // is the connection the reader has; beside a yellow, red or grey one it
  // describes a connection they no longer have, and printing it there is how a
  // dead session comes to look responsive. The figure is not thrown away —
  // the popover shows it, labelled for what it is.
  const currentLatency = state === "connected" && !checking ? latency : null;

  // While a check is running the chip says so rather than showing a stale
  // verdict as if it were current.
  const label = checking
    ? t("session.checking")
    : t(sessionStateKey(state));

  // The accessible name carries everything the colour conveys, plus the
  // latency — a screen reader gets the same information the dot does.
  const ariaLabel = [
    t("connection.status"),
    label,
    currentLatency ? `${t("connection.latency")} ${currentLatency}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex items-center gap-2 relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface-2 ps-2 pe-2.5 py-1 text-[12px] text-ink-dim hover:border-edge-strong focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-2 rounded-full shrink-0",
            TONE[state],
            checking && "motion-safe:animate-pulse",
          )}
        />
        {/* Colour is never the only cue: the state is spelled out here. */}
        <span className="whitespace-nowrap">{label}</span>
        {currentLatency ? (
          <>
            <span aria-hidden="true" className="text-ink-mute">
              ·
            </span>
            {/* A measurement is a number with a unit: it reads left-to-right
                even in Arabic, where the surrounding text does not. */}
            <span dir="ltr" className="tabular-nums text-ink-mute">
              {currentLatency}
            </span>
          </>
        ) : null}
      </button>

      <button
        type="button"
        onClick={() => void runTest()}
        disabled={testing}
        className="inline-flex items-center gap-1.5 rounded-[10px] border border-edge bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-dim hover:border-edge-strong disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
      >
        <Activity
          className={cn("size-3.5", testing && "motion-safe:animate-pulse")}
        />
        {testing ? t("connection.testing") : t("connection.test")}
      </button>

      {open && snapshot ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("connection.details")}
          className="absolute top-full end-0 mt-2 w-[280px] surface-card p-3 z-30 text-[12px]"
        >
          <dl className="space-y-1.5">
            <Row
              label={t("connection.account")}
              value={
                snapshot.account ? (
                  <span dir="ltr">@{snapshot.account.username}</span>
                ) : (
                  "—"
                )
              }
            />
            <Row label={t("connection.provider")} value="twitter-cli" />
            <Row
              label={t("connection.statusLabel")}
              value={t(sessionStateKey(snapshot.state))}
            />
            {/* The popover is where a figure from an earlier session belongs,
                because there is room to say that is what it is. */}
            <Row
              label={t(
                currentLatency ? "connection.latency" : "connection.lastLatency",
              )}
              value={latency ?? "—"}
            />
            <Row
              label={t("connection.lastChecked")}
              value={shortTime(snapshot.checkedAt)}
            />
            <Row
              label={t("connection.lastSuccess")}
              value={shortTime(snapshot.lastSuccessAt)}
            />
            <Row
              label={t("connection.lastFailure")}
              // The localized reason category, never the raw provider text.
              value={
                snapshot.reason === "ok"
                  ? "—"
                  : t(sessionReasonKey(snapshot.reason))
              }
            />
          </dl>
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing}
            className="mt-3 w-full rounded-[10px] border border-edge bg-surface-3 py-1.5 text-[12.5px] text-ink hover:border-edge-strong disabled:opacity-60 cursor-pointer"
          >
            {testing ? t("connection.testing") : t("connection.testAgain")}
          </button>
          {/* formatNumber keeps the locale's digits consistent with the rest
              of the interface when a count ever appears here. */}
          <span className="sr-only">{formatNumber(0)}</span>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-mute shrink-0">{label}</dt>
      <dd className="text-ink-dim truncate text-end">{value}</dd>
    </div>
  );
}

/** Local clock time, or an em dash when nothing has happened yet. */
function shortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
