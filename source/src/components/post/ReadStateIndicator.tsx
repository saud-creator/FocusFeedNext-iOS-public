import { Check } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Whether a post has been read — as a mark, never as a mood.
 *
 * ## Why the card is not dimmed
 *
 * 0.2.0 expressed "read" by dropping the whole card to 72% opacity. That reads
 * as *disabled*: the same treatment the interface uses for a control you cannot
 * operate, applied to a post that is perfectly operable. Worse, it collided
 * with every other state — a hovered read card and a pressed unread card landed
 * on indistinguishable shades, and low-contrast body text became genuinely hard
 * to read at 72% against a dark surface.
 *
 * Read is a *fact about the reader*, not a property of the content, so it is
 * shown the way a mail client shows it: a small mark that appears, and nothing
 * else changes. Hover, pressed, selected and focus stay free to mean their own
 * thing, and "unread only" filters on the logical flag rather than on how dark
 * anything looks.
 */
export function ReadStateIndicator({
  read,
  /** Suppresses the word beside the mark, for tight rows like a quoted post. */
  compact = false,
}: {
  read: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const label = read ? t("post.read") : t("post.unread");

  if (!read) {
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        data-read="false"
        data-testid="read-state"
        className="inline-block size-2 rounded-full bg-accent shrink-0"
      />
    );
  }

  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-read="true"
      data-testid="read-state"
      className={cn(
        "inline-flex items-center gap-1 shrink-0 text-ink-mute",
        // A plain foreground mark. No background fill, no border, nothing that
        // could be mistaken for a disabled or pressed surface.
        compact ? "" : "text-[11px] leading-none",
      )}
    >
      <Check className="size-3" aria-hidden="true" />
      {compact ? null : <span>{label}</span>}
    </span>
  );
}
