import { useMemo, useState } from "react";
import { cn, isRtlText } from "@/lib/utils";

const URL_RE = /(https?:\/\/[^\s]+)/g;
const MENTION_RE = /(^|\s)(@[A-Za-z0-9_]{1,20})/g;
const TAG_RE = /(^|\s)(#[\p{L}0-9_]+)/gu;

interface Segment {
  kind: "text" | "url" | "mention" | "tag";
  value: string;
}

/** Return the identity of a legal X post URL, ignoring host aliases/query strings. */
function postUrlIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim().replace(/[.,!?;:)}\]]+$/g, ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "x.com" && host !== "twitter.com") return null;
    const match = url.pathname.match(
      /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/,
    );
    return match ? `${match[1].toLowerCase()}/${match[2]}` : null;
  } catch {
    return null;
  }
}

/** Split raw post text into renderable segments without using dangerouslySetInnerHTML. */
export function tokenize(text: string): Segment[] {
  const marks: {
    start: number;
    end: number;
    kind: Segment["kind"];
    value: string;
  }[] = [];

  for (const m of text.matchAll(URL_RE)) {
    marks.push({
      start: m.index!,
      end: m.index! + m[0].length,
      kind: "url",
      value: m[0],
    });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const offset = m.index! + m[1].length;
    marks.push({
      start: offset,
      end: offset + m[2].length,
      kind: "mention",
      value: m[2],
    });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const offset = m.index! + m[1].length;
    marks.push({
      start: offset,
      end: offset + m[2].length,
      kind: "tag",
      value: m[2],
    });
  }

  marks.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue; // overlapping match, skip
    if (mark.start > cursor) {
      out.push({ kind: "text", value: text.slice(cursor, mark.start) });
    }
    out.push({ kind: mark.kind, value: mark.value });
    cursor = mark.end;
  }
  if (cursor < text.length)
    out.push({ kind: "text", value: text.slice(cursor) });
  return out;
}

const COLLAPSE_AT = 420;

export function PostText({
  text,
  collapsible = true,
  onOpenProfile,
  postUrl,
  className,
}: {
  text: string;
  collapsible?: boolean;
  onOpenProfile?: (username: string) => void;
  /** The current post's legal X permalink, if available. */
  postUrl?: string | null;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const rtl = useMemo(() => isRtlText(text), [text]);
  const isLong = collapsible && text.length > COLLAPSE_AT;
  // Text is never truncated destructively — collapsing only limits what is shown.
  const shown =
    isLong && !expanded ? `${text.slice(0, COLLAPSE_AT).trimEnd()}…` : text;
  const selfIdentity = useMemo(() => postUrlIdentity(postUrl), [postUrl]);
  const segments = useMemo(() => {
    const raw = tokenize(shown);
    if (!selfIdentity) return raw;
    const out: Segment[] = [];
    for (const seg of raw) {
      if (seg.kind === "url") {
        const bare = seg.value.replace(/[.,!?;:)}\]]+$/g, "");
        if (postUrlIdentity(bare) === selfIdentity) {
          // URL_RE includes sentence punctuation. Keep that punctuation, but
          // remove whitespace immediately before the hidden link as well so
          // the surrounding prose does not acquire a visible gap.
          const previous = out[out.length - 1];
          if (previous?.kind === "text") {
            previous.value = previous.value.replace(/\s+$/g, "");
          }
          const trailing = seg.value.slice(bare.length);
          if (trailing) out.push({ kind: "text", value: trailing });
          continue;
        }
      }
      out.push(seg);
    }
    return out;
  }, [selfIdentity, shown]);

  return (
    <div className={className}>
      <p
        className={cn("post-text text-[14.5px] leading-[1.62] text-ink")}
        dir={rtl ? "rtl" : "ltr"}
        style={{ textAlign: rtl ? "right" : "left" }}
      >
        {segments.map((seg, i) => {
          if (seg.kind === "url") {
            // Shown, not clickable. Nothing in this app opens a browser any
            // more, and a link that looks like a link and does nothing is
            // worse than plain text. It is still tokenised so the address
            // stays visible and selectable — the reader can copy it if they
            // genuinely want to leave.
            return (
              <span
                key={i}
                className="text-ink-dim break-all underline decoration-edge-strong decoration-dotted underline-offset-2"
              >
                {seg.value.replace(/^https?:\/\//, "")}
              </span>
            );
          }
          if (seg.kind === "mention") {
            return (
              <button
                key={i}
                type="button"
                onClick={() => onOpenProfile?.(seg.value.slice(1))}
                className="text-accent hover:underline cursor-pointer"
              >
                {seg.value}
              </button>
            );
          }
          if (seg.kind === "tag") {
            return (
              <span key={i} className="text-accent">
                {seg.value}
              </span>
            );
          }
          return <span key={i}>{seg.value}</span>;
        })}
      </p>

      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[13px] text-accent hover:underline cursor-pointer"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
