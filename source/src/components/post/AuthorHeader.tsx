import { Megaphone, Repeat2 } from "lucide-react";
import type { Author } from "@/lib/api";
import { useI18n } from "@/i18n";
import {usePlatform} from '@/lib/platform';
import { Tip } from "@/components/ui/primitives";
import {
  AccountIdentity,
  accountLabel,
} from "@/components/account/AccountIdentity";

// The avatar lives in the account module now, so `AccountIdentity` can render
// one without importing from a post component and creating a cycle. It is
// re-exported here because several pages already import it from this path.
export { Avatar } from "@/components/account/Avatar";

export function AuthorHeader({
  author,
  createdAt,
  timestampStyle = "relative",
  isRepost,
  repostedBy,
  isPromoted,
  onOpenProfile,
}: {
  author: Author;
  createdAt: string;
  timestampStyle?: "relative" | "absolute";
  isRepost?: boolean;
  repostedBy?: Author | null;
  isPromoted?: boolean;
  onOpenProfile?: (username: string) => void;
}) {
  const {t,formatRelative,formatDateTime} = useI18n();
  const {isIphone}=usePlatform();
  return (
    <div className="min-w-0 flex-1">
      {isRepost && repostedBy ? (
        <div className="flex items-center gap-1.5 text-[12.5px] text-ink-mute mb-1.5">
          <Repeat2 className="size-3.5" />
          <span className="truncate" dir="auto">
            {t("post.repostedBy", { name: accountLabel(repostedBy) })}
          </span>
        </div>
      ) : null}

      <div className={isIphone ? 'flex items-center gap-1.5 min-w-0' : 'flex items-center gap-1.5 flex-wrap'}>
        {/* No avatar here: the card renders one beside this block, and two
            would be two tab stops onto the same profile. */}
        <AccountIdentity
          account={author}
          showAvatar={false}
          layout={isIphone ? 'stacked':'inline'}
          className={isIphone ? 'flex-1' : undefined}
          onOpenProfile={onOpenProfile}
        />
        {!isIphone && <span className="text-ink-mute text-[13px]" aria-hidden>
          ·
        </span>}
        <Tip label={formatDateTime(createdAt)}>
          <time
            className="text-ink-mute text-[13px] shrink-0"
            dateTime={createdAt}
          >
            {timestampStyle === "absolute"
              ? formatDateTime(createdAt)
              : formatRelative(createdAt)}
          </time>
        </Tip>
        {isPromoted ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-warn border border-warn/30 bg-warn/10 rounded-full px-1.5 py-0.5">
            <Megaphone className="size-3" />
            {t("post.promoted")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
