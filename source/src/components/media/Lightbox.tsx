import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Expand,
  Maximize2,
  Minus,
  Plus,
  X,
} from "lucide-react";
import type { PostMedia } from "@/lib/api";
import { useNativeOverlay } from '@/lib/nativeOverlay';
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import {
  DOUBLE_CLICK_ZOOM,
  MIN_ZOOM,
  NO_OFFSET,
  WHEEL_FACTOR,
  ZOOM_STEP,
  actualSizeZoom,
  clampPan,
  clampZoom,
  panBounds,
  type Offset,
  type Size,
} from "./zoom";

/**
 * Above every other layer the app stacks. Radix dialogs, dropdowns and tooltips
 * all sit at 50; the viewer is the one surface that must cover them all,
 * including a dropdown left open in the card behind it.
 */
const OVERLAY_Z = 200;

/** Pointer travel, in px, past which a click counts as a drag and not a click. */
const DRAG_SLOP = 4;

/**
 * Full-screen image viewer.
 *
 * ## Why this is a portal
 *
 * The gallery that opens it lives deep inside the feed's scroll container, and
 * `<main>` carries an entrance animation. An element running a transform
 * animation becomes the containing block for its fixed-position descendants, so
 * `position: fixed` stopped meaning "the viewport" and started meaning "the top
 * of the scrolled feed" — opening an image from the bottom of a long feed drew
 * it somewhere far above the reader. Rendering into `document.body` removes the
 * question entirely: there is no ancestor left to be relative to, and none to
 * clip the overlay either.
 */
export function Lightbox({
  media,
  index,
  onClose,
}: {
  media: PostMedia[];
  index: number;
  onClose: () => void;
}) {
  const { t, formatNumber } = useI18n();
  useNativeOverlay(true);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [current, setCurrent] = useState(index);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>(NO_OFFSET);
  const [dragging, setDragging] = useState(false);
  /** The image's own pixel size, once it has actually loaded. */
  const [loadedSize, setLoadedSize] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>(() => currentViewport());

  const item = media[current];

  /**
   * The post already carries width and height, so zoom and pan are correct on
   * the very first frame rather than only after the bytes arrive; `onLoad`
   * then replaces the metadata with what the file really is.
   */
  const natural = useMemo<Size>(
    () =>
      loadedSize ?? {
        width: item?.width ?? 0,
        height: item?.height ?? 0,
      },
    [loadedSize, item],
  );

  const bounds = panBounds(natural, viewport, zoom);
  const pannable = bounds.x > 0 || bounds.y > 0;

  const setView = useCallback(
    (nextZoom: number, nextOffset: Offset = NO_OFFSET) => {
      const z = clampZoom(nextZoom);
      setZoom(z);
      setOffset(clampPan(nextOffset, natural, viewport, z));
    },
    [natural, viewport],
  );

  /** Back to the default view: whole image, centred. */
  const fitToScreen = useCallback(() => setView(MIN_ZOOM), [setView]);

  const zoomBy = useCallback(
    (factor: number) => setView(zoom * factor, offset),
    [offset, setView, zoom],
  );

  const zoomStep = useCallback(
    (delta: number) => setView(zoom + delta, offset),
    [offset, setView, zoom],
  );

  const go = useCallback(
    (delta: number) => {
      if (media.length < 2) return;
      setCurrent((c) => (c + delta + media.length) % media.length);
      // A new picture is a new subject; carrying the previous zoom over lands
      // the reader in the middle of a crop they never asked for.
      setLoadedSize(null);
      setZoom(MIN_ZOOM);
      setOffset(NO_OFFSET);
    },
    [media.length],
  );

  // The viewport is the stage: the overlay is inset-0 on the window, so the
  // window's own size is the area the image is fitted into. No measurement of
  // an element in between can disagree with it.
  useEffect(() => {
    const onResize = () => setViewport(currentViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Resizing the window, or an image loading at a different size than its
  // metadata claimed, both move the boundary. Re-clamp so nothing is left
  // parked outside it.
  useEffect(() => {
    setOffset((o) => {
      const held = clampPan(o, natural, viewport, zoom);
      return held.x === o.x && held.y === o.y ? o : held;
    });
  }, [natural, viewport, zoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowRight":
          go(1);
          break;
        case "ArrowLeft":
          go(-1);
          break;
        case "+":
        case "=":
          zoomStep(ZOOM_STEP);
          break;
        case "-":
          zoomStep(-ZOOM_STEP);
          break;
        case "0":
          fitToScreen();
          break;
        case "1":
          setView(actualSizeZoom(natural, viewport));
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitToScreen, go, natural, onClose, setView, viewport, zoomStep]);

  // The overlay covers the page but the document behind it still takes the
  // wheel, so the feed would scroll away underneath. Restore whatever was
  // there rather than assuming it was empty — this opens and closes many times
  // in a session, and a lock that forgets its previous value leaves the app
  // permanently unscrollable after the first cycle.
  useEffect(() => {
    const targets = [document.body, document.documentElement];
    const previous = targets.map((el) => el.style.overflow);
    for (const el of targets) el.style.overflow = "hidden";
    return () => {
      targets.forEach((el, i) => {
        el.style.overflow = previous[i];
      });
    };
  }, []);

  // Focus moves onto the viewer so the reader is not typing into a feed hidden
  // behind an aria-modal overlay, and goes back to the thumbnail on close so
  // they keep their place instead of being dropped at the top of the document.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus();
    return () => returnTo?.focus?.();
  }, []);

  /**
   * Keep Tab inside the viewer.
   *
   * `aria-modal` tells a screen reader the rest of the document is inert; it
   * does nothing at all to the tab order. Without this, Tab walks straight out
   * of the overlay and into the feed behind it — the reader is then operating
   * controls they cannot see, on a card hidden under a full-screen backdrop,
   * and the next Enter does something unrelated to the picture in front of them.
   */
  const onTrapKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === overlay);

    // Nothing to cycle between: hold focus on the overlay rather than letting
    // it escape to the document.
    if (focusable.length === 0) {
      e.preventDefault();
      overlay.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && (active === first || active === overlay)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (!overlay.contains(active)) {
      // Focus had already drifted out — pull it back to a known place.
      e.preventDefault();
      first.focus();
    }
  }, []);

  const drag = useRef<{
    startX: number;
    startY: number;
    origin: Offset;
    moved: boolean;
  } | null>(null);

  // Tracked on the window rather than the stage: a quick drag outruns the
  // pointer, and a listener bound to the element would drop the gesture the
  // moment the cursor crossed the edge, leaving the image stuck mid-pan.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) d.moved = true;
      setOffset(
        clampPan(
          { x: d.origin.x + dx, y: d.origin.y + dy },
          natural,
          viewport,
          zoom,
        ),
      );
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, natural, viewport, zoom]);

  if (!item) return null;

  const src = item.url || item.previewUrl || "";
  const total = media.length;
  const counter = t("a11y.imageCounter", {
    index: formatNumber(current + 1),
    total: formatNumber(total),
  });

  const onStageMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      origin: offset,
      moved: false,
    };
    if (pannable) setDragging(true);
  };

  const onStageClick = (e: ReactMouseEvent) => {
    const wasDrag = drag.current?.moved ?? false;
    drag.current = null;
    // Only bare backdrop closes: a click that landed on the picture is aimed at
    // the picture, and the release at the end of a pan is not a click at all.
    if (wasDrag || e.target !== e.currentTarget) return;
    onClose();
  };

  return createPortal(
    <div
      ref={overlayRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t("a11y.imageViewer")}
      data-testid="lightbox"
      onKeyDown={onTrapKeyDown}
      className="bg-black/92 backdrop-blur-sm outline-none overscroll-contain"
      // Set inline, not through a utility class, and side by side rather than
      // as `inset`. Escaping the feed is the whole reason this component
      // exists: it must not depend on a stylesheet having reached the document
      // the portal renders into, nor on a shorthand every engine expands.
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: OVERLAY_Z,
      }}
    >
      <div
        data-testid="lightbox-stage"
        className="absolute inset-0 grid place-items-center overflow-hidden select-none"
        style={{
          cursor: dragging ? "grabbing" : pannable ? "grab" : "zoom-in",
        }}
        onMouseDown={onStageMouseDown}
        onClick={onStageClick}
        onDoubleClick={() =>
          zoom > MIN_ZOOM ? fitToScreen() : setView(DOUBLE_CLICK_ZOOM)
        }
        // No preventDefault: React registers wheel passively, and with the body
        // already locked there is nothing left underneath to scroll anyway.
        onWheel={(e) =>
          zoomBy(e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR)
        }
      >
        <img
          src={src}
          alt={item.alt ?? t("post.media.alt")}
          draggable={false}
          data-testid="lightbox-image"
          onLoad={(e) =>
            setLoadedSize({
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
          }
          className="max-h-full max-w-full"
          style={{
            objectFit: "contain",
            // translate before scale, so a drag of n screen pixels moves the
            // image by exactly n screen pixels at every zoom level.
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragging ? "none" : "transform 150ms ease-out",
          }}
        />
      </div>

      <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent text-white/90" style={{paddingTop:'max(12px, env(safe-area-inset-top))',paddingLeft:'max(12px, env(safe-area-inset-left))',paddingRight:'max(12px, env(safe-area-inset-right))',paddingBottom:12}}>
        <div className="min-w-0 text-[13px]">
          {total > 1 ? (
            <span aria-label={counter} dir="ltr" className="tabular-nums">
              {formatNumber(current + 1)} / {formatNumber(total)}
            </span>
          ) : null}
          {item.alt ? (
            <span className="ms-3 text-white/50 truncate">{item.alt}</span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => zoomStep(-ZOOM_STEP)}
            aria-label={t("a11y.zoomOut")}
            className="text-white/80 hover:bg-white/10"
          >
            <Minus />
          </Button>
          <span
            className="w-11 text-center text-[12px] tabular-nums"
            dir="ltr"
            aria-label={t("a11y.zoomLevel")}
          >
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => zoomStep(ZOOM_STEP)}
            aria-label={t("a11y.zoomIn")}
            className="text-white/80 hover:bg-white/10"
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={fitToScreen}
            aria-label={t("a11y.fitToScreen")}
            className="text-white/80 hover:bg-white/10"
          >
            <Maximize2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setView(actualSizeZoom(natural, viewport))}
            aria-label={t("a11y.actualSize")}
            className="text-white/80 hover:bg-white/10"
          >
            <Expand />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("a11y.closeDialog")}
            className="text-white/80 hover:bg-white/10"
          >
            <X />
          </Button>
        </div>
      </div>

      {total > 1 ? (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label={t("a11y.previousImage")}
            className="absolute start-3 top-1/2 -translate-y-1/2 cursor-pointer rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label={t("a11y.nextImage")}
            className="absolute end-3 top-1/2 -translate-y-1/2 cursor-pointer rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20"
          >
            <ChevronRight className="size-5" />
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}

function currentViewport(): Size {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}
