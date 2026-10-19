import { useCallback, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { BadgeCheck } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/useAppStore";
import {
  Avatar,
  accountLabel,
  cleanHandle,
  type AccountRef,
} from "./Avatar";

export type { AccountRef } from "./Avatar";
export { accountInitials, accountLabel, cleanHandle, handleKey } from "./Avatar";

/**
 * Open an account's profile inside the app.
 *
 * The single entry point for the gesture. Every avatar, display name and
 * @handle in the interface routes through here, which is what turns three
 * things that merely *looked* clickable into three that genuinely are.
 *
 * A blank or "@"-only handle resolves to nothing and is dropped rather than
 * navigating to a profile page for an empty username.
 */
export function useOpenProfile(): (username: string) => void {
  const openProfile = useAppStore((s) => s.openProfile);
  return useCallback(
    (username: string) => {
      const handle = cleanHandle(username);
      if (handle) openProfile(handle);
    },
    [openProfile],
  );
}

/**
 * Shared behaviour for the three triggers.
 *
 * `stopPropagation` is the important part: these sit inside cards and list
 * rows that have their own click handlers, and opening a profile must never
 * also mark a post read or run the row's action. Enter and Space are handled
 * natively by `<button>`; the keydown handler only stops the event travelling
 * further, for the same reason.
 */
function useProfileTrigger(
  account: AccountRef,
  onOpenProfile?: (username: string) => void,
) {
  const fallback = useOpenProfile();
  const open = onOpenProfile ?? fallback;
  const handle = cleanHandle(account.username);

  const onClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (handle) open(handle);
    },
    [handle, open],
  );

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }, []);

  return { type: "button" as const, onClick, onKeyDown, "data-handle": handle };
}

/**
 * The focus treatment every trigger shares.
 *
 * `index.css` already gives `:focus-visible` a 2px accent outline; this adds
 * the offset room and the rounding so the ring traces the avatar circle or the
 * text rather than cutting through it.
 */
const TRIGGER = "cursor-pointer rounded-md focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-accent";

// ---------------------------------------------------------------------------
// The three triggers
// ---------------------------------------------------------------------------

export function AccountAvatarButton({
  account,
  size = 40,
  className,
  onOpenProfile,
}: {
  account: AccountRef;
  size?: number;
  className?: string;
  onOpenProfile?: (username: string) => void;
}) {
  const t = useT();
  const trigger = useProfileTrigger(account, onOpenProfile);
  return (
    <button
      {...trigger}
      // self-start keeps the avatar level with the first line of text: as a
      // flex child a button otherwise stretches to the row height and centres
      // its content vertically.
      className={cn(TRIGGER, "shrink-0 self-start rounded-full", className)}
      aria-label={t("post.openProfile", { name: accountLabel(account) })}
    >
      <Avatar author={account} size={size} />
    </button>
  );
}

export function AccountNameButton({
  account,
  className,
  onOpenProfile,
}: {
  account: AccountRef;
  className?: string;
  onOpenProfile?: (username: string) => void;
}) {
  const t = useT();
  const trigger = useProfileTrigger(account, onOpenProfile);
  const name = accountLabel(account);
  return (
    <button
      {...trigger}
      // The accessible name is the display name itself; the title says what
      // activating it does without repeating the name to a screen reader.
      title={t("post.openProfile", { name })}
      // Display names are user content and may be Arabic inside an English
      // interface, or the reverse.
      dir="auto"
      className={cn(
        TRIGGER,
        "font-semibold text-ink text-[14.5px] hover:underline truncate max-w-[220px]",
        className,
      )}
    >
      {name}
    </button>
  );
}

export function AccountHandleButton({
  account,
  className,
  onOpenProfile,
}: {
  account: AccountRef;
  className?: string;
  onOpenProfile?: (username: string) => void;
}) {
  const t = useT();
  const trigger = useProfileTrigger(account, onOpenProfile);
  const handle = cleanHandle(account.username);
  return (
    <button
      {...trigger}
      title={t("post.openProfile", { name: accountLabel(account) })}
      // A handle is an identifier, not prose: it stays left-to-right and keeps
      // its "@" on the left even in an Arabic interface.
      dir="ltr"
      className={cn(
        TRIGGER,
        "text-ink-mute text-[13.5px] hover:underline truncate max-w-[220px]",
        className,
      )}
    >
      @{handle}
    </button>
  );
}

/** The blue check. Never a button — it is a statement, not an action. */
export function VerifiedMark({ className }: { className?: string }) {
  const t = useT();
  return (
    <span
      role="img"
      aria-label={t("post.verified")}
      title={t("post.verified")}
      className="shrink-0 inline-flex"
    >
      <BadgeCheck className={cn("size-4 text-info", className)} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The composed identity
// ---------------------------------------------------------------------------

export interface AccountIdentityProps {
  account: AccountRef;
  /** Avatar diameter in px. Ignored when `showAvatar` is false. */
  size?: number;
  /** `inline` puts name and handle on one line; `stacked` puts handle below. */
  layout?: "inline" | "stacked";
  showAvatar?: boolean;
  showVerified?: boolean;
  showHandle?: boolean;
  /**
   * Render plain text instead of buttons.
   *
   * For the one case where the identity sits inside a control that is itself
   * the profile trigger — a search suggestion row. Nesting buttons is invalid
   * HTML and breaks keyboard navigation, so the row opts out rather than
   * stacking one inside the other.
   */
  interactive?: boolean;
  /** Overrides the store navigation. Mostly for tests and for embedded views. */
  onOpenProfile?: (username: string) => void;
  className?: string;
  nameClassName?: string;
  handleClassName?: string;
  /** Rendered after the handle on the same line (a timestamp, a badge). */
  trailing?: ReactNode;
  /** Rendered under the handle in `stacked` layout (a bio, a follower count). */
  secondary?: ReactNode;
}

/**
 * Avatar, display name and @handle — all three opening the same profile.
 *
 * Every one of them is its own sibling button. None is nested inside another,
 * so keyboard users get three ordinary tab stops instead of an unreachable
 * control inside a control, and each carries an accessible name.
 */
export function AccountIdentity({
  account,
  size = 40,
  layout = "inline",
  showAvatar = true,
  showVerified = true,
  showHandle = true,
  interactive = true,
  onOpenProfile,
  className,
  nameClassName,
  handleClassName,
  trailing,
  secondary,
}: AccountIdentityProps) {
  const name = accountLabel(account);
  const handle = cleanHandle(account.username);

  const avatar = showAvatar ? (
    interactive ? (
      <AccountAvatarButton
        account={account}
        size={size}
        onOpenProfile={onOpenProfile}
      />
    ) : (
      <Avatar author={account} size={size} />
    )
  ) : null;

  const nameNode = interactive ? (
    <AccountNameButton
      account={account}
      className={nameClassName}
      onOpenProfile={onOpenProfile}
    />
  ) : (
    <span
      dir="auto"
      className={cn(
        "font-semibold text-ink text-[14.5px] truncate max-w-[220px]",
        nameClassName,
      )}
    >
      {name}
    </span>
  );

  const handleNode = !showHandle ? null : interactive ? (
    <AccountHandleButton
      account={account}
      className={handleClassName}
      onOpenProfile={onOpenProfile}
    />
  ) : (
    <span
      dir="ltr"
      className={cn("text-ink-mute text-[13.5px] truncate", handleClassName)}
    >
      @{handle}
    </span>
  );

  const verified = showVerified && account.verified ? <VerifiedMark /> : null;

  if (layout === "stacked") {
    return (
      <div
        className={cn("flex items-start gap-3 min-w-0", className)}
        data-testid="account-identity"
      >
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {nameNode}
            {verified}
            {trailing}
          </div>
          {handleNode ? (
            <div className="flex items-center gap-1.5 min-w-0">
              {handleNode}
            </div>
          ) : null}
          {secondary}
        </div>
      </div>
    );
  }

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 min-w-0", className)}
      data-testid="account-identity"
      // Keeps every copy of one account findable in the DOM, which is what
      // makes "all of them update together" checkable.
      data-handle={handle}
    >
      {avatar}
      {nameNode}
      {verified}
      {handleNode}
      {trailing}
    </span>
  );
}
