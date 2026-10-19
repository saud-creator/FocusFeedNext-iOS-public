/**
 * The shared state components.
 *
 * Every screen in the app ends up needing the same eleven answers to "why is
 * there nothing here?", and 0.2.x answered them eleven different ways — some
 * of which blanked a page full of perfectly good posts in order to announce
 * that a refresh had failed. These are the one set.
 *
 * The rules they all follow, which is the reason to use them rather than write
 * another one:
 *
 * - **Honest.** Nothing claims a cause it does not know. A component that has
 *   not been told what failed says so.
 * - **Additive, not destructive.** `PartialFailure` and `RetryBanner` sit
 *   *above* content that is still valid. Losing a refresh never costs the
 *   reader what they were already reading.
 * - **No dead controls.** Every action is optional and is only rendered when a
 *   handler was supplied. There is no disabled "Retry" that means "we have no
 *   retry".
 * - **Localized and announced.** Every string comes from the catalog, and
 *   waiting states are `role="status"`, failures `role="alert"`.
 *
 * ## API
 *
 * | Component | Use it when |
 * | --- | --- |
 * | `LoadingState` | A first load with nothing to show yet. |
 * | `ProgressiveLoading` | A load with genuine stages, counts and elapsed time. |
 * | `EmptyState` | The request worked and the answer is "nothing". |
 * | `ErrorState` | The request failed and there is nothing valid on screen. |
 * | `PartialFailure` | Some of it worked. Renders above the part that did. |
 * | `RetryBanner` | A refresh failed over content that is still good. |
 * | `OfflineState` | No network at all. |
 * | `AuthExpiredState` | X rejected the session; the fix is in Settings. |
 * | `RateLimitedState` | X is throttling; the fix is time. |
 * | `UnsupportedCapability` | The backend genuinely cannot do this. Never has an action. |
 *
 * `RetryAction` and `CancelAction` are the buttons the above use, exported for
 * a screen that needs one on its own.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  Clock,
  Inbox,
  Loader2,
  RotateCw,
  ShieldAlert,
  WifiOff,
  X,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Elapsed time
// ---------------------------------------------------------------------------

/** After this long, a load is described as slower than usual. */
export const SLOW_AFTER_MS = 5_000;

/**
 * Whole seconds since `startedAt`, ticking once a second.
 *
 * Exported because a page with its own progress furniture still wants the
 * same clock, and two clocks disagreeing by a second reads as a bug.
 */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actionClass =
  "inline-flex items-center gap-1.5 rounded-[10px] border border-edge bg-surface-3 px-2.5 py-1.5 " +
  "text-[12.5px] text-ink hover:border-edge-strong focus-visible:outline-2 focus-visible:outline-accent " +
  "disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer";

export function RetryAction({
  onRetry,
  busy = false,
  label,
}: {
  onRetry: () => void;
  busy?: boolean;
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={onRetry} disabled={busy} className={actionClass}>
      <RotateCw className={cn("size-3.5", busy && "motion-safe:animate-spin")} />
      {label ?? t("state.retry")}
    </button>
  );
}

export function CancelAction({
  onCancel,
  label,
}: {
  onCancel: () => void;
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={onCancel} className={actionClass}>
      <X className="size-3.5" />
      {label ?? t("progress.cancel")}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export function LoadingState({
  label,
  hint,
  className,
}: {
  label?: string;
  hint?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-12 px-6 text-center",
        className,
      )}
    >
      <Loader2 className="size-5 text-ink-mute motion-safe:animate-spin" />
      <p className="text-sm text-ink-dim">{label ?? t("state.loading")}</p>
      {hint ? <p className="text-[12.5px] text-ink-mute">{hint}</p> : null}
    </div>
  );
}

/**
 * A load that can say where it has got to.
 *
 * `stage` is an i18n key under `progress.stage.*` — a real provider stage, not
 * a percentage, because the backend cannot report progress and an invented bar
 * would be a lie about what is known. `loaded` is omitted rather than shown as
 * zero when nothing has arrived yet.
 */
export function ProgressiveLoading({
  stage,
  loaded,
  startedAt,
  onCancel,
  className,
}: {
  /** i18n key, e.g. `progress.stage.requesting`. */
  stage?: string;
  loaded?: number | null;
  /** `Date.now()` when the operation began. `null` stops the clock. */
  startedAt: number | null;
  onCancel?: () => void;
  className?: string;
}) {
  const { t, formatNumber } = useI18n();
  const seconds = useElapsedSeconds(startedAt);
  const slow = startedAt !== null && seconds * 1000 >= SLOW_AFTER_MS;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-12 px-6 text-center",
        className,
      )}
    >
      <Loader2 className="size-5 text-ink-mute motion-safe:animate-spin" />
      <p className="text-sm text-ink-dim">
        {stage ? t(stage) : t("state.loading")}
      </p>

      <p className="text-[12.5px] text-ink-mute flex items-center gap-2">
        {typeof loaded === "number" && loaded > 0 ? (
          <span>{t("progress.loaded", { count: formatNumber(loaded) })}</span>
        ) : null}
        {/* Elapsed time is a measurement: it reads left to right in Arabic
            too, which is why it carries its own direction. */}
        <span dir="ltr" className="tabular-nums">
          {t("progress.elapsed", { seconds: formatNumber(seconds) })}
        </span>
      </p>

      {slow ? (
        <p className="text-[12.5px] text-warn max-w-sm">{t("progress.slow")}</p>
      ) : null}

      {onCancel ? <CancelAction onCancel={onCancel} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nothing to show
// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title?: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-14 px-6",
        className,
      )}
    >
      <div className="text-ink-mute mb-3 opacity-70" aria-hidden="true">
        {icon ?? <Inbox className="size-7" />}
      </div>
      <p className="text-ink font-medium">{title ?? t("state.empty")}</p>
      {hint ? (
        <p className="text-[13px] text-ink-mute mt-1.5 max-w-md">{hint}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * Shared shell for every failure notice, so they are one visual thing.
 *
 * `tone` picks the colour, but the icon and the sentence carry the meaning:
 * colour is never the only cue.
 */
function Notice({
  tone,
  icon,
  title,
  message,
  repair,
  actions,
  className,
}: {
  tone: "bad" | "warn" | "info";
  icon: ReactNode;
  title: string;
  message?: string | null;
  repair?: string | null;
  actions?: ReactNode;
  className?: string;
}) {
  const border = {
    bad: "border-bad/30 bg-bad/5",
    warn: "border-warn/30 bg-warn/5",
    info: "border-info/30 bg-info/5",
  }[tone];
  const text = { bad: "text-bad", warn: "text-warn", info: "text-info" }[tone];

  return (
    <div role="alert" className={cn("surface-card p-4", border, className)}>
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 shrink-0", text)} aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0">
          <p className={cn("text-sm font-medium", text)}>{title}</p>
          {message ? (
            <p className="text-[13px] text-ink-dim mt-1">{message}</p>
          ) : null}
          {repair ? (
            <p className="text-[12.5px] text-ink-mute mt-2">{repair}</p>
          ) : null}
          {actions ? (
            <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ErrorState({
  title,
  message,
  repair,
  onRetry,
  onCancel,
  busy,
  className,
}: {
  title?: string;
  message?: string | null;
  repair?: string | null;
  onRetry?: () => void;
  onCancel?: () => void;
  busy?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Notice
      tone="bad"
      icon={<AlertTriangle className="size-4" />}
      title={title ?? t("state.error")}
      message={message}
      repair={repair}
      className={className}
      actions={
        onRetry || onCancel ? (
          <>
            {onRetry ? <RetryAction onRetry={onRetry} busy={busy} /> : null}
            {onCancel ? <CancelAction onCancel={onCancel} /> : null}
          </>
        ) : null
      }
    />
  );
}

/**
 * Some of it worked.
 *
 * Render this *above* the part that did. The whole point of the component is
 * that a reader keeps what loaded: a page that empties itself to display a
 * failure has turned a partial success into a total one.
 */
export function PartialFailure({
  message,
  detail,
  onRetry,
  busy,
  className,
  children,
}: {
  message?: string;
  detail?: string | null;
  onRetry?: () => void;
  busy?: boolean;
  className?: string;
  /** The content that did load. Rendered untouched, below the notice. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <>
      <Notice
        tone="warn"
        icon={<AlertTriangle className="size-4" />}
        title={t("state.partial")}
        message={message ?? t("state.partial.desc")}
        repair={detail ?? t("state.partial.showing")}
        className={className}
        actions={onRetry ? <RetryAction onRetry={onRetry} busy={busy} /> : null}
      />
      {children}
    </>
  );
}

/** A refresh failed while what is on screen is still valid. */
export function RetryBanner({
  message,
  onRetry,
  onDismiss,
  busy,
  className,
}: {
  message?: string;
  onRetry: () => void;
  onDismiss?: () => void;
  busy?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Notice
      tone="warn"
      icon={<RotateCw className="size-4" />}
      title={t("state.refreshFailed")}
      message={message ?? t("state.refreshFailed.desc")}
      className={className}
      actions={
        <>
          <RetryAction onRetry={onRetry} busy={busy} />
          {onDismiss ? (
            <CancelAction onCancel={onDismiss} label={t("common.close")} />
          ) : null}
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Named causes
// ---------------------------------------------------------------------------

export function OfflineState({
  onRetry,
  busy,
  className,
}: {
  onRetry?: () => void;
  busy?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Notice
      tone="warn"
      icon={<WifiOff className="size-4" />}
      title={t("state.offline")}
      message={t("state.offline.desc")}
      className={className}
      actions={onRetry ? <RetryAction onRetry={onRetry} busy={busy} /> : null}
    />
  );
}

/**
 * X rejected the stored session.
 *
 * The action opens Settings, where the credentials are — an inline retry would
 * repeat a request that has already been refused, which is how an app comes to
 * look broken instead of expired.
 */
export function AuthExpiredState({
  onOpenSettings,
  className,
}: {
  onOpenSettings?: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Notice
      tone="bad"
      icon={<ShieldAlert className="size-4" />}
      title={t("state.authExpired")}
      message={t("state.authExpired.desc")}
      className={className}
      actions={
        onOpenSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className={actionClass}
          >
            {t("state.authExpired.action")}
          </button>
        ) : null
      }
    />
  );
}

/**
 * X is throttling this session.
 *
 * `retryAt` is shown only when the backend genuinely reported one. Inventing a
 * countdown would be guessing at X's internals.
 */
export function RateLimitedState({
  retryAt,
  onRetry,
  busy,
  className,
}: {
  retryAt?: string | null;
  onRetry?: () => void;
  busy?: boolean;
  className?: string;
}) {
  const { t, formatDateTime } = useI18n();
  const when = retryAt ? formatDateTime(retryAt) : null;
  return (
    <Notice
      tone="warn"
      icon={<Clock className="size-4" />}
      title={t("state.rateLimited")}
      message={t("state.rateLimited.desc")}
      repair={when ? t("session.rateLimitedUntil", { time: when }) : null}
      className={className}
      actions={onRetry ? <RetryAction onRetry={onRetry} busy={busy} /> : null}
    />
  );
}

/**
 * The backend cannot do this, and no amount of retrying will change that.
 *
 * Deliberately has no action: offering one would be the dishonesty this
 * component exists to replace.
 */
export function UnsupportedCapability({
  what,
  className,
}: {
  /** What was asked for, already localized. Optional. */
  what?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Notice
      tone="info"
      icon={<Ban className="size-4" />}
      title={t("state.unsupported")}
      message={what ?? t("state.unsupported.desc")}
      repair={what ? t("state.unsupported.desc") : null}
      className={className}
    />
  );
}
