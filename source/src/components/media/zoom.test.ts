import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  actualSizeZoom,
  clampPan,
  clampZoom,
  containScale,
  fittedSize,
  panBounds,
} from "./zoom";

/** A landscape window, so the two axes cannot be confused for one another. */
const VIEWPORT = { width: 1000, height: 800 };

describe("containScale", () => {
  it("shrinks an oversized image until it fits", () => {
    // Width is the binding constraint here: 2000 → 1000 is a harder squeeze
    // than 1000 → 800.
    expect(containScale({ width: 2000, height: 1000 }, VIEWPORT)).toBe(0.5);
  });

  it("takes whichever axis runs out first", () => {
    expect(containScale({ width: 1000, height: 3200 }, VIEWPORT)).toBe(0.25);
  });

  it("leaves a small image at its own size rather than blowing it up", () => {
    expect(containScale({ width: 200, height: 100 }, VIEWPORT)).toBe(1);
  });

  it("falls back to 1 before the image has a size", () => {
    expect(containScale({ width: 0, height: 0 }, VIEWPORT)).toBe(1);
    expect(containScale({ width: 800, height: 600 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("fittedSize", () => {
  it("keeps the original proportions", () => {
    expect(fittedSize({ width: 2000, height: 1000 }, VIEWPORT)).toEqual({
      width: 1000,
      height: 500,
    });
  });
});

describe("clampZoom", () => {
  it("holds the range", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it("survives a non-number", () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });
});

describe("actualSizeZoom", () => {
  it("undoes exactly the shrink that fitting applied", () => {
    expect(actualSizeZoom({ width: 2000, height: 1000 }, VIEWPORT)).toBe(2);
  });

  it("stays at fit for an image that was never shrunk", () => {
    // Blowing a 200px thumbnail up to "actual size" would be a no-op that
    // pretended to do something.
    expect(actualSizeZoom({ width: 200, height: 100 }, VIEWPORT)).toBe(MIN_ZOOM);
  });
});

describe("panBounds", () => {
  const natural = { width: 2000, height: 1000 }; // fits at 1000×500

  it("is zero while the whole image is on screen", () => {
    expect(panBounds(natural, VIEWPORT, 1)).toEqual({ x: 0, y: 0 });
  });

  it("only opens up on the axis that actually overflows", () => {
    // At 1.5× the image is 1500×750: wider than the window, still shorter.
    expect(panBounds(natural, VIEWPORT, 1.5)).toEqual({ x: 250, y: 0 });
  });

  it("grows with the zoom", () => {
    expect(panBounds(natural, VIEWPORT, 2)).toEqual({ x: 500, y: 100 });
  });

  it("is zero before the image has a size", () => {
    expect(panBounds({ width: 0, height: 0 }, VIEWPORT, 4)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("clampPan", () => {
  const natural = { width: 2000, height: 1000 };

  it("passes an offset that is already in range through untouched", () => {
    expect(clampPan({ x: 100, y: 40 }, natural, VIEWPORT, 2)).toEqual({
      x: 100,
      y: 40,
    });
  });

  it("stops a drag at the edge in both directions", () => {
    expect(clampPan({ x: 9999, y: 9999 }, natural, VIEWPORT, 2)).toEqual({
      x: 500,
      y: 100,
    });
    expect(clampPan({ x: -9999, y: -9999 }, natural, VIEWPORT, 2)).toEqual({
      x: -500,
      y: -100,
    });
  });

  it("pulls a fitted image back to centre, so it can never be lost", () => {
    // The failure this exists to prevent: an image dragged off screen at a
    // zoom level that offers nothing to pan to, with no way to bring it back.
    expect(clampPan({ x: 400, y: 300 }, natural, VIEWPORT, 1)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("re-centres what a zoom-out has just put out of reach", () => {
    const panned = clampPan({ x: 500, y: 100 }, natural, VIEWPORT, 2);
    expect(clampPan(panned, natural, VIEWPORT, 1.5)).toEqual({ x: 250, y: 0 });
  });

  it("treats a non-number as centred", () => {
    expect(clampPan({ x: Number.NaN, y: 0 }, natural, VIEWPORT, 2).x).toBe(0);
  });
});
