/**
 * What a quality menu is allowed to claim.
 *
 * twitter-cli 0.8.6 emits exactly one MP4 per video: it has already sorted X's
 * variant list by bitrate and thrown the rest away. So on live data there is
 * one genuine source, and a menu offering 1080p / 720p / 480p would be three
 * buttons pointing at the same bytes — a lie the reader can only discover by
 * being disappointed.
 *
 * Everything here therefore derives from sources that actually exist. A label
 * is only produced when the provider published one; where it did not, the
 * option is described by its bitrate or as "best available", never invented as
 * a resolution.
 */
import type { PostMedia } from "@/lib/api";
import type { VideoQualityPref } from "@/stores/useAppStore";
import { playableSources, rankVariants } from "@/lib/media";

export interface QualityOption {
  /** The playable URL, already proxied by the time it reaches this layer. */
  url: string;
  /** The provider's own words, e.g. "1280x720". Empty when it published none. */
  label: string;
  bitrate: number | null;
  /** Parsed out of the provider's label; null when it cannot be known. */
  height: number | null;
}

/**
 * How an option should be named on screen.
 *
 * Returned as a description rather than a string so the component does the
 * translating — there is no English in this module.
 */
export type QualityLabel =
  | { kind: "text"; text: string }
  | { kind: "best" }
  | { kind: "bitrate"; kbps: number };

/** Pull a vertical resolution out of "1280x720" or "720p". Never guesses. */
export function heightFromLabel(label: string): number | null {
  const dims = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(label);
  if (dims) return Number(dims[2]);
  const p = /(\d{3,4})\s*p\b/i.exec(label);
  if (p) return Number(p[1]);
  return null;
}

/**
 * Every genuine source for this item, highest quality first.
 *
 * `playableSources` is responsible for filtering and deduplicating URLs, but
 * its primary URL is only a fallback ordering. When a payload carries real
 * dimensions or bitrates, those are stronger evidence of quality and must win
 * over the position of a URL in the payload. This is what makes the default
 * `best` preference actually select the highest source available.
 */
export function qualityOptions(media: PostMedia): QualityOption[] {
  const byUrl = new Map<string, { label: string; bitrate: number | null }>();
  for (const v of rankVariants(media.variants ?? [])) {
    const url = v.url.trim();
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      label: (v.label ?? "").trim(),
      bitrate: v.bitrate ?? null,
    });
  }

  return playableSources(media)
    .map((url, order) => {
      const meta = byUrl.get(url);
      const label = meta?.label ?? "";
      const height = heightFromLabel(label);
      return {
        url,
        label,
        bitrate: meta?.bitrate ?? null,
        height,
        // The provider's media dimensions are useful for ranking the primary
        // source, but are deliberately not copied into `height`: they describe
        // the media item, not necessarily the bytes the browser decoded. The
        // player reports the actual decoded dimensions after metadata arrives.
        rankHeight:
          height ??
          (url === media.url.trim() && media.height && media.height > 0
            ? media.height
            : null),
        order,
      };
    })
    .sort((a, b) => {
      if (a.rankHeight !== null || b.rankHeight !== null) {
        if (a.rankHeight === null) return 1;
        if (b.rankHeight === null) return -1;
        if (a.rankHeight !== b.rankHeight) return b.rankHeight - a.rankHeight;
      }

      const aBitrate = a.bitrate ?? -1;
      const bBitrate = b.bitrate ?? -1;
      if (aBitrate !== bBitrate) return bBitrate - aBitrate;
      return a.order - b.order;
    })
    .map(({ rankHeight: _rankHeight, order: _order, ...option }) => option);
}

/** Whether there is genuinely something to choose between. */
export function hasQualityChoice(options: QualityOption[]): boolean {
  return options.length > 1;
}

/**
 * Which option a stored preference resolves to.
 *
 * `best` is index 0 by construction. A numeric preference is honoured only
 * when a source genuinely reports that height; otherwise the nearest one below
 * it wins, and failing that the best available — a request for 480p on a
 * source that only has one stream plays that stream rather than nothing.
 */
export function resolveQualityIndex(
  options: QualityOption[],
  pref: VideoQualityPref,
): number {
  if (options.length === 0) return 0;
  if (pref === "best") return 0;

  const target = Number(pref);
  if (!Number.isFinite(target)) return 0;

  const exact = options.findIndex((o) => o.height === target);
  if (exact >= 0) return exact;

  let best = -1;
  for (let i = 0; i < options.length; i++) {
    const h = options[i].height;
    if (h === null || h > target) continue;
    if (best < 0 || h > (options[best].height ?? 0)) best = i;
  }
  return best >= 0 ? best : 0;
}

/** How to name an option, given where it sits in the ranking. */
export function qualityLabel(
  option: QualityOption | undefined,
  index: number,
): QualityLabel {
  if (option && option.label !== "")
    return { kind: "text", text: option.label };
  if (index === 0) return { kind: "best" };
  if (option?.bitrate)
    return { kind: "bitrate", kbps: Math.round(option.bitrate / 1000) };
  // A nameless, rateless alternative source: identified by its position, which
  // is the only true thing left to say about it.
  return { kind: "text", text: `#${index + 1}` };
}

/**
 * A compact label for the small in-player indicator.
 *
 * Fullscreen menus keep the provider's exact wording. The embedded player has
 * only a few pixels, so a known height is rendered as `720p` while an unknown
 * source keeps the truthful fallback from `qualityLabel`.
 */
export function compactQualityLabel(
  option: QualityOption | undefined,
  index: number,
): QualityLabel {
  if (option?.height !== null && option?.height !== undefined) {
    return { kind: "text", text: `${option.height}p` };
  }
  return qualityLabel(option, index);
}
