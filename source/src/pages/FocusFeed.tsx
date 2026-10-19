import { useState } from "react";
import type { FeedFilters } from "@/lib/api";
import { focusFilters } from "@/stores/useAppStore";
import { useI18n } from "@/i18n";
import { FeedScreen } from "./FeedScreen";

/**
 * Focus Feed is the Following source viewed through a deliberately strict rule
 * set: no reposts and unread only. Those rules are editable like any other
 * filter. Promoted posts are not among them — they are excluded
 * unconditionally, everywhere, with no switch that turns them back on.
 *
 * There is no engagement floor any more. It filtered on like and repost counts,
 * and this app shows neither.
 */
export function FocusFeedPage() {
  const { t } = useI18n();
  const [filters, setFilters] = useState<FeedFilters>(focusFilters);

  return (
    <FeedScreen
      feed="following"
      title={t("focus.title")}
      subtitle={t("focus.subtitle")}
      filters={filters}
      onFiltersChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
      onReset={() => setFilters(focusFilters)}
      emptyTitle={t("focus.empty.title")}
      emptyHint={t("focus.empty.hint")}
    />
  );
}
