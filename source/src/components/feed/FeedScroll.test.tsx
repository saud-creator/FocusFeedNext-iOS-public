import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { FeedList } from "./FeedList";
import { makeImage, makePost, renderWithProviders } from "@/test/factories";
import { PlatformProvider } from '@/lib/platform';

/**
 * Scroll-performance invariants.
 *
 * These do not time anything — jsdom has no compositor and any millisecond
 * figure it produced would be fiction. They assert the *structural* properties
 * that made the real feed stutter, each of which is observable without a frame
 * clock: a card that survives a refresh is a card that was not rebuilt, and a
 * long list that mounts a bounded number of cards is a list that is not holding
 * the whole feed in the DOM.
 *
 * The sharpest of them is identity. If the keys were ever changed back to array
 * indices, or a card stopped being memoised, the DOM nodes below would be
 * replaced and every one of these fails.
 */

/** Live DOM nodes keyed by the post they are showing. */
function nodesById(): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const node of screen.queryAllByTestId("post-card")) {
    const id = node.getAttribute("data-post-id");
    if (id) map.set(id, node as HTMLElement);
  }
  return map;
}

function feedOf(count: number, prefix = "p"): ReturnType<typeof makePost>[] {
  return Array.from({ length: count }, (_, i) =>
    makePost({ id: `${prefix}${i}`, text: `post number ${i}` }),
  );
}

describe("feed keeps card identity", () => {
  it("reuses every card when a refresh delivers the same posts again", () => {
    const posts = feedOf(6);
    const { rerender } = renderWithProviders(
      <FeedList posts={posts} readIds={new Set()} />,
    );
    const before = nodesById();

    // A refresh hands back structurally equal posts in brand-new objects,
    // which is exactly what `useFeed` does on every successful poll.
    rerender(
      <FeedList posts={feedOf(6)} readIds={new Set()} />,
    );
    const after = nodesById();

    expect(after.size).toBe(before.size);
    for (const [id, node] of before) {
      // Same element object, not merely an equal one: React reused the subtree
      // rather than unmounting and rebuilding it.
      expect(after.get(id)).toBe(node);
    }
  });

  it("keeps existing cards on their own nodes when posts are prepended", () => {
    // The failure mode this catches is index keys. With `key={i}` the node that
    // was showing p0 would be handed p_new, every card below it would shift by
    // one, and the whole visible list would re-render and re-decode its images.
    const posts = feedOf(5);
    const { rerender } = renderWithProviders(
      <FeedList posts={posts} readIds={new Set()} />,
    );
    const before = nodesById();

    rerender(
      <FeedList
        posts={[makePost({ id: "fresh", text: "just arrived" }), ...posts]}
        readIds={new Set()}
      />,
    );
    const after = nodesById();

    expect(after.size).toBe(before.size + 1);
    for (const [id, node] of before) {
      expect(after.get(id)).toBe(node);
    }
  });

  it("keeps card identity when the order changes", () => {
    const posts = feedOf(5);
    const { rerender } = renderWithProviders(
      <FeedList posts={posts} readIds={new Set()} />,
    );
    const before = nodesById();

    rerender(
      <FeedList
        posts={[...posts].reverse()}
        readIds={new Set()}
      />,
    );
    const after = nodesById();
    for (const [id, node] of before) {
      expect(after.get(id)).toBe(node);
    }
  });

  it("does not rebuild a card when it becomes read", () => {
    // Marking read on scroll is the most frequent state change in the app. If
    // it remounted the card it would also remount its video and re-request it.
    const posts = feedOf(4);
    const { rerender } = renderWithProviders(
      <FeedList posts={posts} readIds={new Set()} />,
    );
    const before = nodesById();

    rerender(
      <FeedList
        posts={posts}
        readIds={new Set(["p1", "p2"])}
      />,
    );
    const after = nodesById();
    for (const [id, node] of before) {
      expect(after.get(id)).toBe(node);
    }
    expect(after.get("p1")).toHaveAttribute("data-read", "true");
    expect(after.get("p0")).toHaveAttribute("data-read", "false");
  });

  it("drops a duplicated post rather than colliding two cards on one key", () => {
    // A duplicate id is a React key collision, and a key collision unmounts and
    // rebuilds everything after the clash on every single render.
    const dup = makePost({ id: "same", text: "delivered twice" });
    renderWithProviders(
      <FeedList
        posts={[dup, makePost({ id: "other" }), { ...dup }]}
        readIds={new Set()}
      />,
    );
    expect(screen.getAllByTestId("post-card")).toHaveLength(2);
    expect(
      screen.getAllByTestId("post-card").map((n) =>
        n.getAttribute("data-post-id"),
      ),
    ).toEqual(["same", "other"]);
  });
});

describe("feed bounds the DOM it retains", () => {
  // jsdom reports every box as zero-sized, and a virtualiser given a viewport
  // of zero height correctly concludes that nothing is visible. Give it a
  // window-shaped rectangle so the windowing logic has something to window.
  const VIEWPORT = 800;
  const CARD = 240;
  const realRect = Element.prototype.getBoundingClientRect;
  const realOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );

  const heightOf = (el: Element) =>
    el.hasAttribute("data-index") ? CARD : VIEWPORT;

  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const height = heightOf(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 720,
        bottom: height,
        width: 720,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    };
    // The virtualiser sizes its viewport from `offsetHeight`, which jsdom
    // reports as zero for everything, so it concludes nothing is on screen.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return heightOf(this);
      },
    });
  });

  afterAll(() => {
    Element.prototype.getBoundingClientRect = realRect;
    if (realOffsetHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetHeight",
        realOffsetHeight,
      );
    }
  });

  it("renders every card in a short list, because windowing would cost more", () => {
    renderWithProviders(
      <FeedList posts={feedOf(8)} readIds={new Set()} />,
    );
    expect(screen.getAllByTestId("post-card")).toHaveLength(8);
    expect(screen.queryByTestId("feed-window")).toBeNull();
  });

  it("windows a long list instead of mounting all of it", () => {
    const posts = feedOf(80);
    renderWithProviders(
      <FeedList posts={posts} readIds={new Set()} />,
    );
    expect(screen.getByTestId("feed-window")).toBeInTheDocument();

    const mounted = screen.getAllByTestId("post-card");
    expect(mounted.length).toBeGreaterThan(0);
    // The exact window depends on measured heights, which jsdom does not
    // produce. What matters is that it is a window at all.
    expect(mounted.length).toBeLessThan(posts.length);
  });

  it("bounds the initial 20-post iPhone page while keeping its first post visible", () => {
    const agent=vi.spyOn(navigator,'userAgent','get').mockReturnValue('iPhone');
    try {
      renderWithProviders(<PlatformProvider><FeedList posts={feedOf(20)} readIds={new Set()}/></PlatformProvider>);
      expect(screen.getByTestId('feed-window')).toBeInTheDocument();
      expect(screen.getByText('post number 0')).toBeInTheDocument();
      expect(screen.getAllByTestId('post-card').length).toBeLessThan(20);
    } finally {agent.mockRestore();}
  });

  it("moves the rendered range when a bounded feed scrolls beyond its first viewport", async () => {
    const posts = feedOf(80).map((post, index) =>
      index % 5 === 0
        ? {
            ...post,
            media: [makeImage({ alt: `media for post ${index}` })],
          }
        : post,
    );
    let reportedScrollHeight = 0;

    renderWithProviders(
      <div
        data-testid="feed-scroller"
        ref={(node) => {
          if (!node) return;
          // jsdom does not calculate scroll metrics. The ref callback runs
          // before FeedList's layout effect, so scrollHeight is still zero.
          // The resolver must nevertheless select this overflow ancestor,
          // which is the first-layout state that used to produce a blank feed.
          Object.defineProperty(node, "clientHeight", {
            configurable: true,
            value: VIEWPORT,
          });
          Object.defineProperty(node, "scrollHeight", {
            configurable: true,
            get: () => reportedScrollHeight,
          });
        }}
        style={{ height: VIEWPORT, overflowY: "auto" }}
      >
        <FeedList posts={posts} readIds={new Set()} />
      </div>,
    );

    const scroller = screen.getByTestId("feed-scroller") as HTMLElement;
    expect(getComputedStyle(scroller).overflowY).toBe("auto");
    expect(screen.getByTestId("feed-window").closest("[data-testid=feed-scroller]")).toBe(scroller);
    expect(screen.getByText("post number 0")).toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });
    reportedScrollHeight = 20_000;

    act(() => {
      scroller.scrollTop = 2_400;
      scroller.dispatchEvent(new Event("scroll"));
    });

    const renderedIds = screen
      .getAllByTestId("post-card")
      .map((card) => card.getAttribute("data-post-id"));
    expect(renderedIds).not.toContain("p0");
    // At 2400px, post 10 is in view. The initial paint intentionally defers
    // its offscreen runway, so post 15 need not be mounted yet.
    expect(renderedIds).toContain("p10");
    expect(screen.getByAltText("media for post 10")).toBeInTheDocument();
  });

  it("keeps windowed cards keyed by post id, not by slot", () => {
    const posts = feedOf(40);
    const { rerender } = renderWithProviders(
      <FeedList posts={posts} readIds={new Set()} />,
    );
    const before = nodesById();
    expect(before.size).toBeGreaterThan(0);

    rerender(
      <FeedList posts={feedOf(40)} readIds={new Set()} />,
    );
    const after = nodesById();
    for (const [id, node] of before) {
      expect(after.get(id)).toBe(node);
    }
  });

  it("gives the windowed layer a full-length spacer so the scrollbar is honest", () => {
    renderWithProviders(
      <FeedList posts={feedOf(60)} readIds={new Set()} />,
    );
    // A window that did not reserve the height of the whole list would let the
    // scrollbar jump every time a card was measured.
    const layer = screen.getByTestId("feed-window");
    expect(layer.style.height).not.toBe("");
    expect(layer.style.position).toBe("relative");
  });
});
