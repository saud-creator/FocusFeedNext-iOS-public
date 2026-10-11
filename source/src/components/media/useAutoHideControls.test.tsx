import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { CONTROLS_IDLE_MS, useAutoHideControls } from "./useAutoHideControls";

describe("useAutoHideControls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the controls up while inactive, however long nothing happens", () => {
    const { result } = renderHook(() => useAutoHideControls(false));
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS * 10);
    });
    expect(result.current.visible).toBe(true);
  });

  it("hides after the idle period once active", () => {
    const { result } = renderHook(() => useAutoHideControls(true));
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS - 1);
    });
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(false);
  });

  it("comes back on a wake and starts the clock again", () => {
    const { result } = renderHook(() => useAutoHideControls(true));
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS);
    });
    expect(result.current.visible).toBe(false);

    act(() => result.current.wake());
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS - 1);
    });
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(false);
  });

  it("restores the controls when fullscreen ends mid-hide", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useAutoHideControls(active),
      { initialProps: { active: true } },
    );
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS);
    });
    expect(result.current.visible).toBe(false);

    rerender({ active: false });
    expect(result.current.visible).toBe(true);
  });

  it("drops its timer on unmount", () => {
    const { result, unmount } = renderHook(() => useAutoHideControls(true));
    unmount();
    // Nothing to assert beyond it not throwing: a setState after unmount is
    // what this guards, and React logs that rather than failing.
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS * 2);
    });
  });
});
