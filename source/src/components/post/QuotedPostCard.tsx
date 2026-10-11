import type { QuotedPost } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { AccountIdentity } from "@/components/account/AccountIdentity";
import { PostText } from "./PostText";
import { canonicalPostUrl } from "./PostCard";

/** A quoted post rendered as its own nested card — never a raw embed. */
export function QuotedPostCard({
  quoted,
  onOpenProfile,
}: {
  quoted: QuotedPost;
  onOpenProfile?: (username: string) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-edge bg-surface-1 p-3">
      <div className="flex items-center gap-2 mb-1.5">
        {/* The quoted author is an account like any other: its avatar, name
            and handle all open the same internal profile. */}
        <AccountIdentity
          account={quoted.author}
          size={20}
          onOpenProfile={onOpenProfile}
          nameClassName="text-[13px] font-medium max-w-[160px]"
          handleClassName="text-[12.5px] max-w-[160px]"
        />
        {/* A quote carries no timestamp in the provider payload, so the
            separator and time are omitted rather than filled with "now". */}
        {quoted.createdAt ? (
          <>
            <span className="text-ink-mute text-[12px]" aria-hidden>
              ·
            </span>
            <time
              className="text-[12px] text-ink-mute"
              dateTime={quoted.createdAt}
            >
              {relativeTime(quoted.createdAt)}
            </time>
          </>
        ) : null}
      </div>
      <PostText
        text={quoted.text}
        collapsible={false}
        onOpenProfile={onOpenProfile}
        postUrl={canonicalPostUrl(quoted)}
        className="[&_p]:text-[13.5px]"
      />
      {quoted.media.length > 0 ? (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {quoted.media.slice(0, 2).map((m, i) => (
            <img
              key={i}
              src={m.url || m.previewUrl || ""}
              alt={m.alt ?? ""}
              loading="lazy"
              decoding="async"
              className="rounded-lg border border-edge object-cover w-full aspect-video"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
