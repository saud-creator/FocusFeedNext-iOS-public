import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/factories";
import {
  AuthExpiredState,
  EmptyState,
  ErrorState,
  LoadingState,
  OfflineState,
  PartialFailure,
  ProgressiveLoading,
  RateLimitedState,
  RetryBanner,
  UnsupportedCapability,
} from "./index";

describe("waiting states", () => {
  it("announces a plain load without claiming a cause", () => {
    renderWithProviders(<LoadingState />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading…");
  });

  describe("progressive loading", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("names the stage, counts what arrived and ticks the clock", () => {
      const started = Date.now();
      renderWithProviders(
        <ProgressiveLoading
          stage="progress.stage.paging"
          loaded={42}
          startedAt={started}
        />,
      );

      expect(screen.getByText("X is paging through results")).toBeInTheDocument();
      expect(screen.getByText("42 loaded")).toBeInTheDocument();
      expect(screen.getByText("0s")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByText("3s")).toBeInTheDocument();
    });

    it("says it is slow only after five seconds, and says it in Arabic too", () => {
      renderWithProviders(
        <ProgressiveLoading stage="progress.stage.requesting" startedAt={Date.now()} />,
      );
      expect(
        screen.queryByText("X is taking longer than usual."),
      ).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5100);
      });
      expect(
        screen.getByText("X is taking longer than usual."),
      ).toBeInTheDocument();
    });

    it("omits a loaded count rather than printing a hopeful zero", () => {
      renderWithProviders(<ProgressiveLoading startedAt={Date.now()} loaded={0} />);
      expect(screen.queryByText(/loaded/)).not.toBeInTheDocument();
    });

    it("offers Cancel only when there is something to cancel", async () => {
      const onCancel = vi.fn();
      const { unmount } = renderWithProviders(
        <ProgressiveLoading startedAt={Date.now()} />,
      );
      expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
      unmount();

      renderWithProviders(
        <ProgressiveLoading startedAt={Date.now()} onCancel={onCancel} />,
      );
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onCancel).toHaveBeenCalledOnce();
    });
  });
});

describe("failure states", () => {
  it("never renders a retry control with nothing behind it", () => {
    renderWithProviders(<ErrorState message="The request failed." />);
    expect(screen.getByRole("alert")).toHaveTextContent("The request failed.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("retries when it can", async () => {
    const onRetry = vi.fn();
    renderWithProviders(<ErrorState message="Failed." onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps the content that did load when part of a request fails", () => {
    // The whole reason this component exists: a page must not empty itself in
    // order to announce that a refresh went wrong.
    renderWithProviders(
      <PartialFailure onRetry={vi.fn()}>
        <p>A post that loaded fine</p>
      </PartialFailure>,
    );
    expect(screen.getByText("A post that loaded fine")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some of this could not be loaded",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Nothing already loaded has been discarded.",
    );
  });

  it("says plainly that a failed refresh cost the reader nothing", () => {
    renderWithProviders(<RetryBanner onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "What is on screen is what loaded earlier. It has not been thrown away.",
    );
  });

  it("sends an expired session to Settings rather than retrying a refusal", async () => {
    const onOpenSettings = vi.fn();
    renderWithProviders(<AuthExpiredState onOpenSettings={onOpenSettings} />);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows a rate-limit deadline only when one was actually reported", () => {
    const { unmount } = renderWithProviders(<RateLimitedState />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "X is rate limiting this session",
    );
    expect(screen.queryByText(/Rate limited until/)).toBeNull();
    unmount();

    renderWithProviders(<RateLimitedState retryAt="2026-07-26T10:30:00Z" />);
    expect(screen.getByText(/Rate limited until/)).toBeInTheDocument();
  });

  it("offers nothing at all when the backend simply cannot do it", () => {
    renderWithProviders(<UnsupportedCapability />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This is not something the backend can do",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a retry when offline, because the network can come back", async () => {
    const onRetry = vi.fn();
    renderWithProviders(<OfflineState onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("empty state", () => {
  it("falls back to a localized sentence rather than a blank panel", () => {
    renderWithProviders(<EmptyState />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("renders in Arabic with no untranslated key on screen", () => {
    renderWithProviders(<PartialFailure onRetry={vi.fn()} />, { locale: "ar" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("تعذّر تحميل جزء من هذا");
    expect(alert.textContent ?? "").not.toMatch(/state\./);
  });
});
