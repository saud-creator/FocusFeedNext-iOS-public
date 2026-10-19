import { ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import type { FeedFilters } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge, Select, ToggleRow } from "@/components/ui/primitives";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

// `hidePromoted` is deliberately absent. Advertising is excluded when the
// timeline is requested and filtered again in Rust regardless of this value,
// so a chip here would be a control that does nothing — and one whose "off"
// state would imply ads could come back. It is shown as a protection badge
// instead; see `PromotedBadge` below.
const QUICK: { key: keyof FeedFilters; label: string }[] = [
  { key: "hideReposts", label: "No reposts" },
  { key: "unreadOnly", label: "Unread only" },
  { key: "imagesOnly", label: "Images" },
  { key: "videosOnly", label: "Videos" },
  { key: "textOnly", label: "Text only" },
];

/**
 * Always-on indicator that advertising is excluded.
 *
 * Rendered as a `<span>`, not a button: there is no off state to offer. Ads are
 * excluded when the timeline is requested (`--no-include-promoted`) and
 * filtered again in Rust regardless of any stored filter value, so this
 * reports a property of the application rather than a preference.
 */
export function PromotedBadge({
  withDescription = false,
}: {
  withDescription?: boolean;
}) {
  const { t } = useI18n();
  return (
    <span className={withDescription ? "block py-2.5" : undefined}>
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-good/30 bg-good/10 px-3 py-1 text-[12.5px] text-good"
        // Not `role="status"`: nothing here changes, and a live region would
        // announce it on every render for no reason.
      >
        <ShieldCheck aria-hidden="true" className="size-3.5" />
        {t("feed.promotedBlocked")}
      </span>
      {withDescription ? (
        <span className="mt-1 block text-[12px] text-ink-mute">
          {t("feed.promotedBlocked.desc")}
        </span>
      ) : null}
    </span>
  );
}

export function FilterBar({
  filters,
  onChange,
  onReset,
}: {
  filters: FeedFilters;
  onChange: (patch: Partial<FeedFilters>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);

  const activeCount = [
    filters.hideReposts,
    filters.unreadOnly,
    filters.hideRead,
    filters.imagesOnly,
    filters.videosOnly,
    filters.textOnly,
    filters.maxAgeHours > 0,
  ].filter(Boolean).length;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 flex-wrap">
        <PromotedBadge />
        {QUICK.map(({ key, label }) => {
          const on = Boolean(filters[key]);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange({ [key]: !on } as Partial<FeedFilters>)}
              className={cn(
                "rounded-full border px-3 py-1 text-[12.5px] transition-colors cursor-pointer",
                on
                  ? "bg-accent-soft border-accent/40 text-accent"
                  : "bg-surface-2 border-edge text-ink-dim hover:border-edge-strong hover:text-ink",
              )}
            >
              {label}
            </button>
          );
        })}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          className="ml-auto"
          aria-expanded={open}
        >
          <SlidersHorizontal />
          More
          {activeCount > 0 ? <Badge tone="accent">{activeCount}</Badge> : null}
        </Button>
      </div>

      {open ? (
        <div className="surface-card mt-3 p-4 ffn-rise">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-medium text-ink">
              Advanced filters
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              aria-label="Close filters"
            >
              <X />
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 divide-y divide-edge md:divide-y-0">
            <div>
              <ToggleRow
                label="Hide posts I've read"
                checked={filters.hideRead}
                onCheckedChange={(v) => onChange({ hideRead: v })}
              />
              {/* Not a ToggleRow: this is a statement about what the app
                  does, not a choice. Rendering it as a switch — even one
                  pinned on — would suggest an off position exists. */}
              <PromotedBadge withDescription />
            </div>

            {/* No "minimum engagement" control. It filtered on like and repost
                counts, and those numbers are no longer shown anywhere in the
                app — a threshold against a quantity the reader cannot see is a
                filter they cannot reason about. */}
            <div className="space-y-3 pt-3 md:pt-0">
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink">Maximum age</span>
                <Select
                  value={String(filters.maxAgeHours)}
                  onChange={(e) =>
                    onChange({ maxAgeHours: Number(e.target.value) })
                  }
                >
                  <option value="0">Any time</option>
                  <option value="6">6 hours</option>
                  <option value="24">24 hours</option>
                  <option value="72">3 days</option>
                  <option value="168">1 week</option>
                </Select>
              </label>
            </div>
          </div>

          <div className="flex justify-end mt-3">
            <Button variant="ghost" size="sm" onClick={onReset}>
              Reset all filters
            </Button>
          </div>
        </div>
      ) : null}

      <p className="text-[11.5px] text-ink-mute mt-2">
        Filters only change what is shown. Nothing is deleted — turning a filter
        off brings posts straight back.
      </p>
    </div>
  );
}
