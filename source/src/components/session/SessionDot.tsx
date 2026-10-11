import type { SessionReason, SessionSnapshot, SessionState } from "@/lib/api";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Colour is never the only cue.
 *
 * Every use of this component pairs the dot with the localized state text, and
 * the dot itself carries an `aria-label` naming the state, so the indicator
 * works for a screen reader and for a colour-blind reader alike.
 */
const TONE: Record<SessionState, string> = {
  connected: "bg-good",
  degraded: "bg-warn",
  expired: "bg-bad",
  disconnected: "bg-ink-mute",
};

const STATE_KEY: Record<SessionState, string> = {
  connected: "session.status.connected",
  degraded: "session.status.degraded",
  expired: "session.status.expired",
  disconnected: "session.status.disconnected",
};

/**
 * The reason is the useful half: "Degraded" alone does not tell somebody
 * whether to wait or to go and paste a new cookie.
 */
const REASON_KEY: Record<SessionReason, string> = {
  ok: "session.status.connected.desc",
  no_credentials: "session.status.disconnected.desc",
  not_checked: "session.reason.notChecked",
  checking: "session.checking",
  request_failed: "session.reason.requestFailed",
  rate_limited: "session.reason.rateLimited",
  offline: "session.reason.offline",
  stale: "session.reason.stale",
  auth_failed: "session.status.expired.desc",
  tool_missing: "session.reason.toolMissing",
};

export function sessionStateKey(state: SessionState): string {
  return STATE_KEY[state];
}

export function sessionReasonKey(reason: SessionReason): string {
  return REASON_KEY[reason];
}

export function SessionDot({
  snapshot,
  size = 8,
}: {
  snapshot: SessionSnapshot;
  size?: number;
}) {
  const { t } = useI18n();
  const label = t(STATE_KEY[snapshot.state]);
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cn(
        "inline-block rounded-full shrink-0",
        TONE[snapshot.state],
        // A pulse only while a check is genuinely in flight, so movement
        // always means something is happening.
        snapshot.checking && "motion-safe:animate-pulse",
      )}
    />
  );
}

/** The dot plus its localized label — the form every screen should prefer. */
export function SessionBadge({
  snapshot,
  className,
}: {
  snapshot: SessionSnapshot;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <SessionDot snapshot={snapshot} />
      <span className="text-[12.5px] text-ink-dim">
        {snapshot.checking
          ? t("session.checking")
          : t(STATE_KEY[snapshot.state])}
      </span>
    </span>
  );
}
