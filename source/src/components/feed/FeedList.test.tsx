import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeedList, FeedSkeleton, scrollParentOf } from "./FeedList";
import { makePost, renderWithProviders } from "@/test/factories";

const posts = [
  makePost({ id: "a", text: "first post" }),
  makePost({ id: "b", text: "second post" }),
  makePost({ id: "c", text: "third post" }),
];

describe("FeedList", () => {
  it("keeps the real overflow ancestor when it is empty during first layout", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const content = document.createElement("div");
    scroller.appendChild(content);
    document.body.appendChild(scroller);

    // A freshly mounted app shell can report no scrollable content until the
    // first card/window measurement has committed. That must not make the
    // virtualizer attach to documentElement instead.
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 0,
    });

    try {
      expect(scrollParentOf(content)).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("renders one card per post", () => {
    renderWithProviders(
      <FeedList posts={posts} readIds={new Set()} />,
    );
    expect(screen.getAllByTestId("post-card")).toHaveLength(3);
  });

  it("shows a loading skeleton before any posts arrive", () => {
    renderWithProviders(
      <FeedList posts={[]} readIds={new Set()} loading />,
    );
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("shows an empty state when there is nothing to read", () => {
    renderWithProviders(
      <FeedList
        posts={[]}
        readIds={new Set()}
        emptyTitle="No posts match your filters"
        emptyHint="Try turning off a filter"
      />,
    );
    expect(screen.getByText("No posts match your filters")).toBeInTheDocument();
    expect(screen.getByText("Try turning off a filter")).toBeInTheDocument();
  });

  it("does not insert new posts above the reader — it offers a pill instead", async () => {
    const onShowPending = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FeedList
        posts={posts}
        readIds={new Set()}
        pendingCount={4}
        onShowPending={onShowPending}
      />,
    );

    // The three original posts are still the only ones rendered.
    expect(screen.getAllByTestId("post-card")).toHaveLength(3);

    const pill = screen.getByRole("button", { name: /Show 4 new posts/ });
    await user.click(pill);
    expect(onShowPending).toHaveBeenCalled();
  });

  it("uses the singular form for a single new post", () => {
    renderWithProviders(
      <FeedList
        posts={posts}
        readIds={new Set()}
        pendingCount={1}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Show 1 new post$/ }),
    ).toBeInTheDocument();
  });

  it("hides the pill when nothing is pending", () => {
    renderWithProviders(
      <FeedList
        posts={posts}
        readIds={new Set()}
        pendingCount={0}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Show .* new/ }),
    ).not.toBeInTheDocument();
  });

  it("reflects per-post read state", () => {
    renderWithProviders(
      <FeedList posts={posts} readIds={new Set(["a"])} />,
    );
    const states = screen
      .getAllByRole("status")
      .map((n) => n.getAttribute("aria-label"));
    expect(states).toEqual(["Read", "Unread", "Unread"]);
  });

  it("exposes a prefetch sentinel when a live page has older posts", () => {
    const onLoadMore = vi.fn();
    renderWithProviders(
      <FeedList
        posts={posts}
        readIds={new Set()}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getByTestId("feed-load-more-sentinel")).toBeInTheDocument();
    expect(screen.queryByText(/loading more/i)).not.toBeInTheDocument();
  });

  it("requests the next page when the prefetch sentinel enters the runway", () => {
    const OriginalObserver = window.IntersectionObserver;
    const observers: Array<{
      callback: IntersectionObserverCallback;
      target: Element | null;
    }> = [];
    class TestObserver {
      private readonly record: (typeof observers)[number];

      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, target: null };
        observers.push(this.record);
      }

      observe(target: Element) {
        this.record.target = target;
      }

      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    window.IntersectionObserver = TestObserver as unknown as typeof IntersectionObserver;

    try {
      const onLoadMore = vi.fn();
      renderWithProviders(
        <FeedList
          posts={posts}
          readIds={new Set()}
          hasMore
          onLoadMore={onLoadMore}
        />,
      );

      const sentinel = screen.getByTestId("feed-load-more-sentinel");
      const observer = observers.find((entry) => entry.target === sentinel);
      expect(observer).toBeDefined();

      act(() => {
        observer?.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
        observer?.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(onLoadMore).toHaveBeenCalledTimes(1);
    } finally {
      window.IntersectionObserver = OriginalObserver;
    }
  });

  it("waits for the sentinel to leave the runway before prefetching again", () => {
    const OriginalObserver = window.IntersectionObserver;
    const observers: Array<{
      callback: IntersectionObserverCallback;
      target: Element | null;
    }> = [];
    class TestObserver {
      private readonly record: (typeof observers)[number];

      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, target: null };
        observers.push(this.record);
      }

      observe(target: Element) {
        this.record.target = target;
      }

      disconnect() {}
    }
    window.IntersectionObserver = TestObserver as unknown as typeof IntersectionObserver;

    try {
      const onLoadMore = vi.fn();
      const { rerender } = renderWithProviders(
        <FeedList
          posts={posts}
          readIds={new Set()}
          hasMore
          onLoadMore={onLoadMore}
        />,
      );

      const sentinel = screen.getByTestId("feed-load-more-sentinel");
      const first = observers.find((entry) => entry.target === sentinel);
      expect(first).toBeDefined();

      act(() => {
        first?.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(onLoadMore).toHaveBeenCalledTimes(1);

      // React recreates the observer around the request, but the sentinel is
      // still in the same runway. A completed request must not cascade.
      rerender(
        <FeedList
          posts={posts}
          readIds={new Set()}
          hasMore
          onLoadMore={onLoadMore}
          loadingMore
        />,
      );
      rerender(
        <FeedList
          posts={posts}
          readIds={new Set()}
          hasMore
          onLoadMore={onLoadMore}
        />,
      );
      const latest = observers[observers.length - 1];
      act(() => {
        latest.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(onLoadMore).toHaveBeenCalledTimes(1);

      // Leaving and re-entering the runway is the next legitimate prefetch.
      act(() => {
        latest.callback(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
        latest.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(onLoadMore).toHaveBeenCalledTimes(2);
    } finally {
      window.IntersectionObserver = OriginalObserver;
    }
  });

  it("opens the author profile from the card avatar", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FeedList
        posts={posts}
        readIds={new Set()}
        onOpenProfile={onOpenProfile}
      />,
    );

    await user.click(
      screen.getAllByRole("button", { name: "Open Rust Daily's profile" })[0],
    );
    expect(onOpenProfile).toHaveBeenCalledWith("rustlang_daily");
  });

  it("renders a standalone skeleton component", () => {
    renderWithProviders(<FeedSkeleton />);
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });
});
