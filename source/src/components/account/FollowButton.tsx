import { useState, type ReactNode } from "react";
import { Loader2, UserMinus, UserPlus } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, accountLabel, cleanHandle, type AccountRef } from "./Avatar";
import {
  useAccountAction,
  useAccountActionGate,
  useAccountActionStore,
  useRelationship,
} from "./accountActions";

/**
 * Follow or Unfollow one account — whichever the relationship actually is.
 *
 * Never both at once, and never a guess: while the following list is still
 * being read the control says so instead of picking the likelier answer.
 */
export function FollowButton({
  account,
  size = "sm",
  showFailure = true,
  className,
}: {
  account: AccountRef;
  size?: "sm" | "md";
  /** Off for compact rows that surface the failure somewhere else. */
  showFailure?: boolean;
  className?: string;
}) {
  const t = useT();
  const gate = useAccountActionGate();
  const relationship = useRelationship(account.username,gate.ready && (gate.canFollow || gate.canUnfollow));
  const run = useAccountAction();
  const clearFailure = useAccountActionStore((s) => s.clearFailure);
  const [confirming, setConfirming] = useState(false);

  const handle = cleanHandle(account.username);
  const at = `@${handle}`;

  // Nothing renders until both gates have answered. A control that appears and
  // then vanishes reads as a bug, and one the backend would refuse should not
  // look available for even a frame.
  if (!gate.ready || !handle) return null;
  if (!gate.canFollow && !gate.canUnfollow) return null;

  const failure = relationship.failure;
  const failureText =
    failure &&
    t(
      failure.action === "follow"
        ? "account.follow.failed"
        : "account.unfollow.failed",
      { handle: at },
    );

  // While the dialog is open it carries the failure itself; showing it in both
  // places at once is the same sentence twice.
  const alert =
    showFailure && failure && !confirming ? (
      <span className="flex flex-col text-[12px] leading-snug" role="alert">
        <span className="text-bad">{failureText}</span>
        {failure.detail ? (
          <span className="text-ink-dim" dir="auto">
            {failure.detail}
          </span>
        ) : null}
        <span className="text-ink-mute">{t("account.noAutoRetry")}</span>
      </span>
    ) : null;

  const wrap = (control: ReactNode) => (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {control}
      {alert}
    </span>
  );

  if (relationship.state === 'pending') {
    return wrap(<Button variant="secondary" size={size} disabled>{t('account.follow.pending')}</Button>);
  }
  if (relationship.state === "checking") {
    return wrap(
      <Button
        variant="secondary"
        size={size}
        disabled
        aria-busy
        aria-label={t("account.checking.aria", { handle: at })}
      >
        <Loader2 className="animate-spin" />
        {t("account.checking")}
      </Button>,
    );
  }

  if (relationship.state === "unknown") {
    // The following list could not be read, so the honest answer is "we do not
    // know" plus a way to ask again — not a Follow button that might be wrong.
    return wrap(
      <Button
        variant="ghost"
        size={size}
        onClick={() => relationship.recheck()}
        aria-label={t("account.recheck.aria", { handle: at })}
        title={t("account.unknown")}
      >
        {t("account.recheck")}
      </Button>,
    );
  }

  const busyLabel = relationship.isWorking ? t("account.working") : null;
  const disabled = relationship.isLocked;
  const lockedTitle = disabled && !relationship.isWorking
    ? t("account.busy")
    : undefined;

  if (relationship.state === "following") {
    if (!gate.canUnfollow) return null;
    return (
      <>
        {wrap(
          <Button
            variant="secondary"
            size={size}
            disabled={disabled}
            title={lockedTitle}
            aria-label={t("account.unfollow.aria", { handle: at })}
            onClick={(e) => {
              e.stopPropagation();
              clearFailure(handle);
              setConfirming(true);
            }}
          >
            {relationship.isWorking ? (
              <Loader2 className="animate-spin" />
            ) : (
              <UserMinus />
            )}
            {busyLabel ?? t("account.unfollow")}
          </Button>,
        )}
        {confirming ? (
          <ConfirmUnfollowDialog
            account={account}
            onCancel={() => setConfirming(false)}
            onConfirm={async () => {
              const ok = await run("unfollow", handle);
              if (ok) setConfirming(false);
            }}
          />
        ) : null}
      </>
    );
  }

  if (!gate.canFollow) return null;
  return wrap(
    // Follow needs no dialog: it is one deliberate click, and it is undone by
    // the Unfollow button that replaces it.
    <Button
      variant="primary"
      size={size}
      disabled={disabled}
      title={lockedTitle}
      aria-label={t("account.follow.aria", { handle: at })}
      onClick={(e) => {
        e.stopPropagation();
        void run("follow", handle);
      }}
    >
      {relationship.isWorking ? (
        <Loader2 className="animate-spin" />
      ) : (
        <UserPlus />
      )}
      {busyLabel ?? t("account.follow")}
    </Button>,
  );
}

/**
 * The confirmation an unfollow has to pass.
 *
 * Shows the picture, the display name and the exact handle, so the dialog
 * cannot be confirmed against the wrong row, and says plainly what it changes.
 */
export function ConfirmUnfollowDialog({
  account,
  onCancel,
  onConfirm,
}: {
  account: AccountRef;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const t = useT();
  const relationship = useRelationship(account.username);
  const handle = cleanHandle(account.username);
  const at = `@${handle}`;
  const failure = relationship.failure;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ffn-unfollow-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !relationship.isWorking) onCancel();
      }}
    >
      <div className="surface-card w-full max-w-[440px] p-5">
        <h2
          id="ffn-unfollow-title"
          className="text-[15px] font-semibold text-ink"
        >
          {t("account.unfollow.confirm.title")}
        </h2>

        <div className="mt-3 flex items-center gap-3">
          <Avatar author={account} size={44} />
          <div className="min-w-0">
            <div className="text-[14px] text-ink truncate" dir="auto">
              {accountLabel(account)}
            </div>
            {/* The handle is the identifier the decision hangs on, so it stays
                left-to-right even in an Arabic interface. */}
            <div className="text-[12.5px] text-ink-mute truncate" dir="ltr">
              {at}
            </div>
          </div>
        </div>

        <p className="mt-3 text-[12.5px] text-warn">
          {t("account.unfollow.confirm.body")}
        </p>

        {failure ? (
          <div className="mt-3 text-[12.5px]" role="alert">
            <p className="text-bad">
              {t("account.unfollow.failed", { handle: at })}
            </p>
            {failure.detail ? (
              <p className="text-ink-dim mt-0.5" dir="auto">
                {failure.detail}
              </p>
            ) : null}
            <p className="text-ink-mute mt-0.5">{t("account.noAutoRetry")}</p>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={relationship.isWorking}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={relationship.isLocked}
            aria-label={t("account.unfollow.confirm.action", { handle: at })}
            onClick={() => void onConfirm()}
          >
            {relationship.isWorking
              ? t("account.working")
              : t("account.unfollow.confirm.action", { handle: at })}
          </Button>
        </div>
      </div>
    </div>
  );
}
