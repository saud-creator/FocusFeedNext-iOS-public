import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * The minimum an account has to carry to be shown and opened.
 *
 * Deliberately narrower than `Author`: a quoted post's author arrives with
 * only a handle and a display name, and a suggestion row built from a search
 * result has no counts either. Anything that can be identified by a handle can
 * be rendered here.
 */
export interface AccountRef {
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  verified?: boolean | null;
}

/** Strip a leading "@" and surrounding whitespace. Case is preserved. */
export function cleanHandle(username: string): string {
  return username.trim().replace(/^@+/, "");
}

/**
 * The form two handles are compared in: no "@", locale-lowercased.
 *
 * `toLocaleLowerCase` rather than `toLowerCase` because display names are
 * matched with the same helper and may be Arabic or Turkish, where the two
 * disagree.
 */
export function handleKey(username: string): string {
  return cleanHandle(username).toLocaleLowerCase();
}

/** What to show when there is no avatar image: the first two characters. */
export function accountInitials(account: AccountRef): string {
  const source = account.displayName?.trim() || cleanHandle(account.username);
  return source.slice(0, 2).toLocaleUpperCase() || "?";
}

/** The name to address an account by, falling back to its handle. */
export function accountLabel(account: AccountRef): string {
  const name = account.displayName?.trim();
  return name || cleanHandle(account.username);
}

/**
 * An account's picture, or its initials when it has none.
 *
 * Purely presentational and never interactive — the clickable wrapper lives in
 * `AccountIdentity`, so an avatar can also appear inside a row that is itself
 * a button without nesting one interactive element inside another.
 */
export function Avatar({
  author,
  size = 40,
  className,
  style,
}: {
  author: AccountRef;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return author.avatarUrl ? (
    <img
      src={author.avatarUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn(
        "rounded-full object-cover shrink-0 bg-surface-3",
        className,
      )}
      style={{ width: size, height: size, ...style }}
    />
  ) : (
    <div
      aria-hidden
      className={cn(
        "rounded-full shrink-0 bg-surface-4 text-ink-dim grid place-items-center font-semibold",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.36, ...style }}
    >
      {accountInitials(author)}
    </div>
  );
}
