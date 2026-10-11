import { useMemo } from "react";
import { defaultFilters } from "@/lib/api";
import { useI18n } from "@/i18n";
import { FeedScreen } from "./FeedScreen";

/**
 * What the accounts you follow actually wrote.
 *
 * The same timeline as the Following feed with reposts taken out — nothing an
 * account merely passed along. **Quote posts stay**: the account wrote the words
 * around the quote, and dropping them would hide somebody's own commentary
 * because of what it happened to be commenting on. `ProfileTab` in
 * `Profile.tsx` uses that same rule for one account, so "original" means one
 * thing in this app rather than two.
 *
 * This costs X nothing extra. It is a filtered view of a timeline the app has
 * already fetched: the same `following` source, so `claimRefresh` in
 * `useFeed.ts` lets whichever of these pages opens first do the one request and
 * the others read what it brought back.
 *
 * The filter bar is deliberately absent. Its first chip is "No reposts", which
 * on this page is not a preference — it is what the page *is* — and a control
 * pinned on is a control that lies about having an off position.
 */
export function OriginalsPage() {
  const { t } = useI18n();
  const filters = useMemo(
    () => ({ ...defaultFilters, hideReposts: true }),
    [],
  );

  return (
    <FeedScreen
      feed="following"
      title={t("originals.title")}
      subtitle={t("originals.subtitle")}
      filters={filters}
      showFilters={false}
      emptyTitle={t("originals.empty.title")}
      emptyHint={t("originals.empty.hint")}
    />
  );
}
