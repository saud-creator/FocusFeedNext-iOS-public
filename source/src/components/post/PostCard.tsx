import { memo, useEffect, useRef,useState } from "react";
import {BookmarkComments} from "./BookmarkComments";
import {ArticleReader} from "./ArticleReader";
import type { Post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AuthorHeader, Avatar } from "./AuthorHeader";
import { PostText } from "./PostText";
import { MediaGallery } from "./MediaGallery";
import { QuotedPostCard } from "./QuotedPostCard";
import { PostActions } from "./PostActions";
import { ReadStateIndicator } from "./ReadStateIndicator";
import { usePlatform } from '@/lib/platform';

export interface PostCardProps {
  post: Post;
  read: boolean;
  timestampStyle?: "relative" | "absolute";
  collapseLongPosts?: boolean;
  defaultSpeed?: number;
  /** Milliseconds a post must stay visible before it counts as read. 0 disables. */
  readDwellMs?: number;
  onMarkRead?: (id: string, read: boolean) => void;
  onHide?: (id: string) => void;
  onOpenProfile?: (username: string) => void;
  onAddToGroup?: (authorId: string) => void;
  /** True when the card is rendered in the X Bookmarks feed. */
  isBookmark?: boolean;
  /** Called only after the user confirms removing this bookmark from X. */
  onRemoveBookmark?: () => Promise<void>;
}

/**
 * Construct a legal X permalink from provider data, or from the strict
 * username/id pair when the provider did not send one. Malformed legacy URLs
 * and non-numeric local fixture IDs deliberately produce no link.
 */
export function canonicalPostUrl(
  post: Pick<Post, "id" | "author" | "url">,
): string | null {
  const providerMatch = (() => {
    const raw = post.url?.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const path = url.pathname.match(
        /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/,
      );
      return (host === "x.com" || host === "twitter.com") && path
        ? { username: path[1], id: path[2] }
        : null;
    } catch {
      return null;
    }
  })();
  const fallbackUsername = post.author.username.trim();
  const fallbackId = post.id.trim();
  // A provider URL is trusted only when it describes this exact post. A
  // stale/mismatched permalink must never be exposed as the current card's
  // copy action or hidden from its text.
  const providerIsCurrent =
    providerMatch &&
    providerMatch.username.toLowerCase() === fallbackUsername.toLowerCase() &&
    providerMatch.id === fallbackId;
  const username = providerIsCurrent
    ? providerMatch.username
    : fallbackUsername;
  const id = providerIsCurrent ? providerMatch.id : fallbackId;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username) || !/^\d+$/.test(id)) {
    return null;
  }
  return `https://x.com/${username}/status/${id}`;
}

function PostCardImpl({
  post:originalPost,
  read,
  timestampStyle = "relative",
  collapseLongPosts = true,
  defaultSpeed = 1,
  readDwellMs = 1000,
  onMarkRead,
  onHide,
  onOpenProfile,
  onAddToGroup,
  isBookmark = false,
  onRemoveBookmark,
}: PostCardProps) {
  const [recovered,setRecovered]=useState<{original:Post;post:Post}|null>(null);
  const post=recovered?.original===originalPost?recovered.post:originalPost;
  const ref = useRef<HTMLElement>(null);
  const timer = useRef<number | null>(null);
  const postUrl = canonicalPostUrl(post);
  const {isIphone}=usePlatform();

  // A post becomes read after being sufficiently visible for a dwell period —
  // never merely because it was downloaded.
  useEffect(() => {
    if (read || !readDwellMs || !onMarkRead) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            if (timer.current === null) {
              timer.current = window.setTimeout(() => {
                onMarkRead(post.id, true);
                timer.current = null;
              }, readDwellMs);
            }
          } else if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
          }
        }
      },
      { threshold: [0, 0.6, 1] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [post.id, read, readDwellMs, onMarkRead]);

  return (
    <article
      ref={ref}
      data-testid="post-card"
      data-post-id={post.id}
      // `data-read` carries the logical state for tests and for anything that
      // wants to select on it. It deliberately drives no visual change here:
      // the mark in the header is the entire treatment (see ReadStateIndicator).
      data-read={read ? "true" : "false"}
      className={cn(
        "surface-card post-card p-3 sm:p-4 transition-colors",
        // Hover is the only state this element expresses, so hovering a read
        // card and hovering an unread one look identical — as they should.
        "hover:border-edge-strong",
      )}
    >
      <div className={cn('post-card-layout',isIphone ? 'grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 gap-y-2' : 'flex gap-3')}>
        <button
          type="button"
          onClick={() => onOpenProfile?.(post.author.username)}
          // self-start is required: as a flex child the button would stretch to
          // the full card height, and Chromium vertically centres a button's
          // content, leaving the avatar floating beside the media.
          className={cn("post-card-avatar shrink-0 cursor-pointer self-start",isIphone && "grid min-h-11 min-w-11 place-items-center")}
          aria-label={`Open ${post.author.displayName}'s profile`}
        >
          <Avatar author={post.author} size={40} />
        </button>

        <div className="post-card-content min-w-0 flex-1">
          <div className="post-card-header flex items-start gap-2">
            <AuthorHeader
              author={post.author}
              createdAt={post.createdAt}
              timestampStyle={timestampStyle}
              isRepost={post.isRepost}
              repostedBy={post.repostedBy}
              isPromoted={post.isPromoted}
              onOpenProfile={onOpenProfile}
            />
            <div className="pt-1.5">
              <ReadStateIndicator read={read} />
            </div>
          </div>

          {post.isArticle ? <ArticleReader post={post} onOpenProfile={onOpenProfile}/> : <PostText
            text={post.text} collapsible={collapseLongPosts} onOpenProfile={onOpenProfile}
            postUrl={postUrl} className="mt-1.5"/>}

          <MediaGallery media={post.media} defaultSpeed={defaultSpeed} postId={post.id} onPostRecovered={value=>setRecovered({original:originalPost,post:value})}/>

          {post.quoted ? (
            <QuotedPostCard
              quoted={post.quoted}
              onOpenProfile={onOpenProfile}
            />
          ) : null}

          {isBookmark && <BookmarkComments post={post} onOpenProfile={onOpenProfile}/>}

          <PostActions
          author={post.author}
            read={read}
            onToggleRead={() => onMarkRead?.(post.id, !read)}
            onHide={() => onHide?.(post.id)}
            onCopyText={() => void navigator.clipboard?.writeText(post.text)}
            postUrl={postUrl}
            onCopyLink={
              postUrl
                ? () => { if (!navigator.clipboard) return Promise.reject(new Error("Clipboard unavailable")); return navigator.clipboard.writeText(postUrl); }
                : undefined
            }
            isBookmark={isBookmark}
            onRemoveBookmark={onRemoveBookmark}
            onAddToGroup={
              onAddToGroup ? () => onAddToGroup(post.author.id) : undefined
            }
          />
        </div>
      </div>
    </article>
  );
}

/** Default shallow memoisation still skips unchanged cards, while allowing a
 * refresh that updates text, media, author data, or callbacks for the same post
 * id to render the new content. The former id-only comparator froze all of
 * those fields on screen. */
export const PostCard = memo(PostCardImpl);
