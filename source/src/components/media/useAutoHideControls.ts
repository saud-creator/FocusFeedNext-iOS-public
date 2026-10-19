import { useCallback, useEffect, useRef, useState } from "react";

/** How long the picture is left alone before the chrome gets out of the way. */
export const CONTROLS_IDLE_MS = 3000;

/**
 * Fullscreen chrome that steps aside.
 *
 * A control bar pinned over a fullscreen video is a bar over the part of the
 * picture the reader chose fullscreen to see. It hides on its own after a few
 * idle seconds and comes back on the first sign of a person — any pointer
 * movement, any key.
 *
 * `active` is the whole gate: while it is false the controls simply stay put,
 * because the embedded player is small enough that hiding them there would be
 * the opposite of helpful.
 */
export function useAutoHideControls(
  active: boolean,
  idleMs: number = CONTROLS_IDLE_MS,
): { visible: boolean; wake: () => void } {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const wake = useCallback(() => {
    setVisible(true);
    clear();
    if (!active) return;
    timer.current = setTimeout(() => setVisible(false), idleMs);
  }, [active, clear, idleMs]);

  useEffect(() => {
    // Entering fullscreen shows the controls and starts the clock; leaving it
    // restores them for good, so the compact player is never left blank.
    wake();
    if (!active) setVisible(true);
    return clear;
  }, [active, wake, clear]);

  return { visible: active ? visible : true, wake };
}
