import { useAppStore } from "@/stores/useAppStore";
import { useI18n } from "@/i18n";
import { FeedScreen } from "./FeedScreen";

export function FollowingPage() {
  const { t } = useI18n();
  const filters = useAppStore((s) => s.filters);
  const setFilters = useAppStore((s) => s.setFilters);
  const resetFilters = useAppStore((s) => s.resetFilters);

  return (
    <FeedScreen
      feed="following"
      title={t("following.title")}
      subtitle={t("following.subtitle")}
      filters={filters}
      onFiltersChange={setFilters}
      onReset={resetFilters}
      emptyTitle={t("following.empty.title")}
      emptyHint={t("following.empty.hint")}
    />
  );
}
