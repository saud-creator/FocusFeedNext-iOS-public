import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { PostMedia } from "@/lib/api";
import { Lightbox } from "@/components/media/Lightbox";
import { isVideoLike } from "@/lib/media";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { VideoPlayer } from "./VideoPlayer";
import { usePlatform } from '@/lib/platform';
import { useEffectivePolicy } from '@/lib/runtime';

/**
 * The tallest a single image may render.
 *
 * A phone screenshot is roughly 1:2, so an uncapped portrait photo pushes the
 * text of the next post a full screen away. Expressed in `vh` so the cap tracks
 * the window rather than a laptop-sized guess, with a pixel term to stop it
 * becoming absurd on a very tall monitor.
 */
const SINGLE_MAX_HEIGHT = "min(65svh, 560px)";

/** A predictable first measurement when the provider omitted media bounds. */
const DEFAULT_MEDIA_RATIO = 16 / 9;

/** Row height for a multi-image grid, in px. Two rows is the deepest layout. */
const GRID_ROW_HEIGHT = 200;

/**
 * Images are requested only when their frame is roughly one screen-runway
 * away. Native `loading="lazy"` remains as a browser hint, while this
 * observer gives WebView2 a predictable 350px boundary instead of its own
 * much larger document heuristic.
 */
function LazyFeedImage({
  media,
  style,
}: {
  media: PostMedia;
  style: CSSProperties;
}) {
  const frame = useRef<HTMLImageElement>(null);
  const [nearby, setNearby] = useState(false);
  const { isIphone } = usePlatform();
  const policy = useEffectivePolicy(isIphone);

  useEffect(() => {
    const image = frame.current;
    if (!image) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearby(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setNearby(true);
          observer.disconnect();
        }
      },
      { rootMargin: `${policy.imageMargin}px 0px` },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [policy.imageMargin]);

  return (
    <img
      ref={frame}
      src={nearby ? media.url : undefined}
      alt={media.alt ?? ""}
      loading="lazy"
      decoding="async"
      draggable={false}
      style={style}
      data-media-lazy="true"
    />
  );
}

/**
 * Post media, at the proportions it was actually taken in.
 *
 * ## Why nothing is cropped
 *
 * The gallery used to give every image in a multi-image post a squarish cell
 * and `object-fit: cover`, which is how X itself does it. On a feed of charts,
 * screenshots and code that is the wrong trade: the interesting part of a
 * benchmark plot is its axes, and cover removes whichever edge does not fit.
 * Every image here is `contain` instead — the frame stays tidy, the picture
 * keeps its own shape, and whatever space is left over is a neutral letterbox
 * rather than a stretched or silently clipped photograph.
 */
export function MediaGallery({
  media,
  defaultSpeed,
}: {
  media: PostMedia[];
  defaultSpeed?: number;
}) {
  const { t } = useI18n();
  const { isIphone } = usePlatform();
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);

  if (!media || media.length === 0) return null;

  // GIFs belong with the videos: X serves animated GIFs as MP4, so pointing an
  // <img> at one renders nothing at all. `isVideoLike` is the single place that
  // decision is made.
  const videos = media.filter(isVideoLike);
  const images = media.filter((m) => !isVideoLike(m));

  const single = images.length === 1;
  // Two images sit side by side in one row; three or four stack into two.
  const rows = images.length <= 2 ? 1 : 2;

  return (
    <div className="mt-3 space-y-2">
      {videos.map((v, i) => (
        <VideoPlayer key={`v-${i}`} media={v} defaultSpeed={defaultSpeed} />
      ))}

      {images.length > 0 ? (
        <div
          data-testid="media-grid"
          className={cn(
            "grid gap-1.5 rounded-xl overflow-hidden",
            single ? "grid-cols-1" : "grid-cols-2",
          )}
          // A grid gets fixed rows so the cells stay aligned; the images inside
          // them do not, which is what keeps the tidiness from costing shape.
          style={
            single
              ? undefined
              : { gridTemplateRows: `repeat(${rows}, ${isIphone ? 'clamp(120px, 35vw, 180px)' : `${GRID_ROW_HEIGHT}px`})` }
          }
        >
          {images.map((m, i) => {
            const ratio =
              m.width && m.height ? m.width / m.height : DEFAULT_MEDIA_RATIO;
            // With three images the first takes the full-height column, the
            // one asymmetry that still reads as a deliberate layout.
            const spanFull = images.length === 3 && i === 0;
            return (
              <button
                key={`i-${i}`}
                type="button"
                onClick={() => setLightboxAt(i)}
                className={cn(
                  "relative block w-full overflow-hidden bg-surface-3 cursor-zoom-in",
                  "border border-edge rounded-lg",
                  spanFull && "row-span-2",
                )}
                style={
                  single
                    ? {
                        // Keep the card's first virtual measurement stable
                        // even when the image has not decoded yet. The frame
                        // uses the provider ratio when available and a modest
                        // landscape fallback when it is not.
                        aspectRatio: String(ratio),
                        maxHeight: SINGLE_MAX_HEIGHT,
                      }
                    : undefined
                }
                aria-label={
                  m.alt
                    ? t("post.media.openImageAlt", { alt: m.alt })
                    : t("post.media.openImage")
                }
              >
                <LazyFeedImage
                  media={m}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                  }}
                />
              </button>
            );
          })}
        </div>
      ) : null}

      {lightboxAt !== null ? (
        <Lightbox
          media={images}
          index={lightboxAt}
          onClose={() => setLightboxAt(null)}
        />
      ) : null}
    </div>
  );
}
