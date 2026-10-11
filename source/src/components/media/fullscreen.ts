/**
 * The Fullscreen API, reduced to the four things a player needs.
 *
 * WebView2 is Chromium, so the unprefixed API is what actually runs; the
 * `webkit`-prefixed fallbacks exist because the same code renders under jsdom
 * and under an embedded view whose host may have disabled the standard entry
 * points. Every function here is total: it never throws, and it reports whether
 * the request was honoured so the caller can fall back to its own layout rather
 * than silently doing nothing.
 */

interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** Whichever element the browser currently has in the top layer, if any. */
export function fullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const doc = document as PrefixedDocument;
  // Embedded browser hosts are allowed to expose these as accessors rather
  // than plain fields. A broken host accessor must be treated exactly like a
  // missing API; leaking the exception out of a click handler can take down
  // the whole renderer instead of letting the player use its CSS fallback.
  try {
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  } catch {
    return null;
  }
}

/** Whether this exact element is the one the browser has made fullscreen. */
export function isNativelyFullscreen(el: Element | null): boolean {
  if (!el) return false;
  return fullscreenElement() === el;
}

/** Whether asking is worth it at all — false under jsdom and in locked views. */
export function fullscreenSupported(el: HTMLElement | null): boolean {
  if (!el) return false;
  const node = el as PrefixedElement;
  try {
    return (
      typeof node.requestFullscreen === "function" ||
      typeof node.webkitRequestFullscreen === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Ask for fullscreen; resolve with whether it was granted.
 *
 * A refusal is ordinary rather than exceptional — a fullscreen request outside
 * a user gesture is rejected by design — so this reports it as a value.
 */
export async function enterFullscreen(
  el: HTMLElement | null,
): Promise<boolean> {
  if (!el) return false;
  const node = el as PrefixedElement;
  try {
    const request = node.requestFullscreen ?? node.webkitRequestFullscreen;
    if (typeof request !== "function") return false;
    await request.call(node);
    return true;
  } catch {
    return false;
  }
}

/** Leave fullscreen if this document is in it. Safe to call when it is not. */
export async function leaveFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  if (!fullscreenElement()) return;
  const doc = document as PrefixedDocument;
  try {
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (typeof exit !== "function") return;
    await exit.call(doc);
  } catch {
    // Already out, or the view refused. Either way there is nothing to undo.
  }
}

/**
 * Subscribe to fullscreen changes, including the ones we did not initiate —
 * the browser's own Escape handling and the window leaving fullscreen both
 * arrive here and nowhere else.
 */
export function onFullscreenChange(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const events = ["fullscreenchange", "webkitfullscreenchange"];
  const registered: string[] = [];
  for (const name of events) {
    try {
      document.addEventListener(name, listener);
      registered.push(name);
    } catch {
      // A partially implemented host event surface is still a valid reason
      // to keep using the player's own fullscreen state.
    }
  }
  return () => {
    for (const name of registered) {
      try {
        document.removeEventListener(name, listener);
      } catch {
        // Cleanup must never turn a harmless unmount into a renderer error.
      }
    }
  };
}
