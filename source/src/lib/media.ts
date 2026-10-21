import type { MediaVariant, PostMedia } from "@/lib/api";

/**
 * Which of a media item's sources to actually put in a `<video>` element.
 *
 * ## What the real payload looks like
 *
 * twitter-cli 0.8.5 serialises media as exactly four keys — `type`, `url`,
 * `width`, `height`. There is no variant list, no bitrate, no content type and
 * no poster image. Its parser already sorts X's `video_info.variants` by
 * bitrate descending, keeps only `content_type == "video/mp4"`, and emits the
 * single best MP4. So on live data there is nothing left to choose: `url` is
 * already the highest-quality MP4 X offered.
 *
 * The native iOS provider supplies real MP4 variants and proxied thumbnails.
 * Desktop CLI payloads can still carry only one source, so the player must
 * never require a variant list or invent an unavailable rendition.
 */
export type VideoErrorKind =
  | "network"
  | "decode"
  | "unsupported"
  | "aborted"
  /** The media id is no longer registered — usually an account switch. */
  | "expired"
  /** The local proxy never started, so there is no source to play. */
  | "proxyUnavailable"
  /** The proxy is up but the CDN refused, so the bytes never arrived. */
  | "upstream"
  | "unknown";

/** Ordered candidates for a media item, best first. */
export function playableSources(media: PostMedia): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    const url = (u ?? "").trim();
    if (!url || seen.has(url)) return;
    // A poster is an image; it is never a video source.
    if (!isLikelyPlayable(url)) return;
    seen.add(url);
    out.push(url);
  };

  // `url` first: on live data it is already X's best MP4.
  push(media.url);
  for (const v of rankVariants(media.variants)) push(v.url);
  return out;
}

/**
 * Highest bitrate first, but never an unreasonable one.
 *
 * A 10 Mbps source in a 500px-wide reading column wastes bandwidth and stalls
 * on a slow connection for no visible gain, so anything above the cap is only
 * used when there is nothing else.
 */
const BITRATE_CAP = 5_000_000;

export function rankVariants(variants: MediaVariant[]): MediaVariant[] {
  const withUrl = (variants ?? []).filter(
    (v) => v && typeof v.url === "string" && v.url.trim() !== "",
  );
  const rate = (v: MediaVariant) => v.bitrate ?? 0;
  const sensible = withUrl
    .filter((v) => rate(v) <= BITRATE_CAP)
    .sort((a, b) => rate(b) - rate(a));
  const oversized = withUrl
    .filter((v) => rate(v) > BITRATE_CAP)
    .sort((a, b) => rate(a) - rate(b));
  return [...sensible, ...oversized];
}

/**
 * A loopback media-proxy URL, the only shape video arrives in now.
 *
 * The Rust side rewrites every video and animated-GIF source to
 * `http://127.0.0.1:<random port>/media/<secret>/<opaque id>` before the post
 * reaches this layer, because WebView2 refuses X's CDN URLs directly. Matching
 * the loopback address exactly — rather than allowing plain http generally —
 * keeps that an allowance for one known local origin.
 */
export function isProxiedMedia(url: string): boolean {
  return /^http:\/\/127\.0\.0\.1:\d+\/media\/[0-9a-f]+\/[0-9a-f]+$/i.test(
    url.trim(),
  );
}

/**
 * Whether a URL is a format WebView2 can decode natively.
 *
 * WebView2 is Chromium without proprietary HLS support: an `.m3u8` playlist
 * needs Media Source Extensions and a JavaScript player, which this app does
 * not ship. Treating a playlist as playable would produce exactly the silent
 * failure this module exists to prevent.
 */
export function isLikelyPlayable(url: string): boolean {
  // The proxy carries no file extension — the id is opaque by design — so it
  // is recognised by shape and the extension rules below do not apply to it.
  if (isProxiedMedia(url)) return true;
  if (!/^https:\/\//i.test(url)) return false;
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return false;
  // Images are never video sources, even when they arrive in a video item.
  if (/\.(jpe?g|png|webp|gif)$/.test(path)) return false;
  return true;
}

/** Map a DOM `MediaError.code` onto something the interface can explain. */
export function classifyMediaError(code: number | undefined): VideoErrorKind {
  switch (code) {
    case 1:
      return "aborted"; // MEDIA_ERR_ABORTED
    case 2:
      return "network"; // MEDIA_ERR_NETWORK
    case 3:
      return "decode"; // MEDIA_ERR_DECODE
    case 4:
      return "unsupported"; // MEDIA_ERR_SRC_NOT_SUPPORTED
    default:
      return "unknown";
  }
}

export function videoErrorKey(kind: VideoErrorKind): string {
  return `post.video.error.${kind}`;
}

/**
 * Turn a proxy status code into a specific cause.
 *
 * The `<video>` element reports every one of these as the same opaque
 * `MEDIA_ERR_SRC_NOT_SUPPORTED`, which is what made the original failure so
 * hard to read. A single HEAD against the same URL after a failure tells us
 * which of them it actually was, so the message can name the real problem.
 */
export function classifyProxyFailure(status: number): VideoErrorKind {
  // The proxy answers 404 for an unknown *or superseded* id, which after a
  // successful first load means the registration was invalidated.
  if (status === 404 || status === 410) return "expired";
  if ([500,502,503,504].includes(status)) return "upstream";
  if (status === 403) return "upstream";
  if ([408,416,429].includes(status)) return "network";
  return "unknown";
}

/**
 * A poster for a video, when one genuinely exists.
 *
 * Live X video media carries no thumbnail, so this is usually null and the
 * player must not pretend otherwise by falling back to the video URL itself.
 */
export function posterFor(media: PostMedia): string | undefined {
  const p = (media.previewUrl ?? "").trim();
  if(isProxiedMedia(p) && p!==media.url) return p;
  if (!p || !/^https:\/\//i.test(p)) return undefined;
  return /\.(jpe?g|png|webp)$/i.test(p.split("?")[0]) ? p : undefined;
}

/**
 * Whether this item should be shown with the video player.
 *
 * X serves animated GIFs as MP4, so `gif` belongs here and not in an `<img>` —
 * pointing an image tag at an MP4 renders nothing at all.
 */
export function isVideoLike(media: PostMedia): boolean {
  return media.kind === "video" || media.kind === "gif";
}
