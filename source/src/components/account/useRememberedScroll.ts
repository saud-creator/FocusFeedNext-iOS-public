import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/useAppStore";

/**
 * The nearest ancestor that actually scrolls.
 *
 * The app scrolls a `<main>` element rather than the document, and that
 * element is keyed on the route so it remounts at the top on every navigation.
 * Finding it from inside a page means a page can restore its own offset
 * without the shell having to know about it.
 */
export function scrollParent(from: Element | null): HTMLElement | null {
  let node = from?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    const overflow = `${style.overflowY} ${style.overflow}`;
    if (/(auto|scroll|overlay)/.test(overflow) && node.scrollHeight > 0) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Remember where a page was scrolled to, and put the reader back there.
 *
 * `ready` exists because a page whose content arrives asynchronously has
 * nothing to scroll *to* on the first frame: restoring before the list has
 * height silently lands at zero.
 */
export function useRememberedScroll(key: string, ready = true) {
  const anchor = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);

  // Deliberately reads and writes the store imperatively. Subscribing to the
  // offset would re-render the whole page on every scroll event.
  useEffect(() => {
    const el = scrollParent(anchor.current);
    if (!el) return;
    const save = () =>
      useAppStore.getState().rememberScroll(key, el.scrollTop);
    let frame: number | null = null;
    const scheduleSave = () => {
      if (frame !== null) return;
      if (typeof window.requestAnimationFrame === "function") {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          save();
        });
      } else {
        frame = window.setTimeout(() => {
          frame = null;
          save();
        }, 0);
      }
    };
    const cancelScheduledSave = () => {
      if (frame === null) return;
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      } else {
        window.clearTimeout(frame);
      }
      frame = null;
    };

    el.addEventListener("scroll", scheduleSave, { passive: true });
    return () => {
      cancelScheduledSave();
      save();
      el.removeEventListener("scroll", scheduleSave);
    };
  }, [key]);

  useEffect(() => {
    if (!ready || restored.current) return;
    const el = scrollParent(anchor.current);
    if (!el) return;
    const y = useAppStore.getState().scrollPositions[key] ?? 0;
    restored.current = true;
    if (y > 0) el.scrollTop = y;
  }, [key, ready]);

  return anchor;
}
