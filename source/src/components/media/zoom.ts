/**
 * Zoom and pan geometry for the image viewer.
 *
 * Kept as pure functions outside the component because this is the part that
 * decides whether a zoomed image can be dragged somewhere the reader cannot get
 * it back from. That rule has to be checkable directly: jsdom performs no
 * layout, so a test driving the component alone would measure every box as zero
 * and agree with any arithmetic at all.
 */

/** Zoom 1 is "fit to screen" — the whole image contained, never enlarged. */
export const MIN_ZOOM = 1;

/** Past this a photograph is mostly interpolation and the pan turns unusable. */
export const MAX_ZOOM = 8;

/** One press of the zoom buttons, or one arrow key. */
export const ZOOM_STEP = 0.25;

/** One wheel notch. Multiplicative, so deep zoom does not crawl. */
export const WHEEL_FACTOR = 1.15;

/** Zoom a double-click jumps to from the fitted view. */
export const DOUBLE_CLICK_ZOOM = 2;

export interface Size {
  width: number;
  height: number;
}

export interface Offset {
  x: number;
  y: number;
}

export const NO_OFFSET: Offset = { x: 0, y: 0 };

/** A box we can divide by — an unloaded image reports zero for both sides. */
function measurable(size: Size): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The factor the browser itself applies at zoom 1.
 *
 * Mirrors `object-fit: contain` under `max-width/height: 100%`: the image is
 * shrunk until it fits, and — because a max-* constraint can only ever shrink —
 * a picture smaller than the viewport is left at its own size rather than blown
 * up into a blur. Every figure below is derived from this one, so the numbers
 * the viewer reasons about and the pixels CSS actually draws cannot drift apart.
 */
export function containScale(natural: Size, viewport: Size): number {
  if (!measurable(natural) || !measurable(viewport)) return 1;
  return Math.min(
    viewport.width / natural.width,
    viewport.height / natural.height,
    1,
  );
}

/** On-screen size of the image at zoom 1. */
export function fittedSize(natural: Size, viewport: Size): Size {
  const scale = containScale(natural, viewport);
  return { width: natural.width * scale, height: natural.height * scale };
}

/**
 * The zoom at which one image pixel covers one CSS pixel.
 *
 * This is what "Actual size" means, and it is simply the reciprocal of the
 * contain factor: an image shrunk to a third to fit needs 3× to be itself again.
 */
export function actualSizeZoom(natural: Size, viewport: Size): number {
  const scale = containScale(natural, viewport);
  return scale > 0 ? clampZoom(1 / scale) : MIN_ZOOM;
}

/**
 * How far the image may travel from centre before its own edge crosses into
 * view.
 *
 * Zero on any axis the image does not overflow, which is the rule that stops a
 * fitted image from being flung into a corner and left there.
 */
export function panBounds(
  natural: Size,
  viewport: Size,
  zoom: number,
): Offset {
  if (!measurable(natural) || !measurable(viewport)) return NO_OFFSET;
  const fitted = fittedSize(natural, viewport);
  const z = clampZoom(zoom);
  return {
    x: Math.max(0, (fitted.width * z - viewport.width) / 2),
    y: Math.max(0, (fitted.height * z - viewport.height) / 2),
  };
}

/** Hold a pan offset inside `panBounds`, so no part of the image is unreachable. */
export function clampPan(
  offset: Offset,
  natural: Size,
  viewport: Size,
  zoom: number,
): Offset {
  const bounds = panBounds(natural, viewport, zoom);
  const axis = (value: number, limit: number) =>
    Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : 0;
  return { x: axis(offset.x, bounds.x), y: axis(offset.y, bounds.y) };
}
