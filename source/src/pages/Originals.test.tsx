import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { OriginalsPage } from "./Originals";
import { FollowingPage } from "./Following";
import { claimRefresh, resetRefreshClaims } from "@/hooks/useFeed";
import { makePost, renderWithProviders } from "@/test/factories";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      cachedFeed: vi.fn(),
      refreshFeed: vi.fn(),
      loadFeedPage: vi.fn(),
      setRead: vi.fn(),
    },
  };
});

// The startup sequence is what publishes the ready token; the feed screen
// refuses to refresh until it is non-zero. Only that one hook is replaced —
// the rest of the module is left alone.
vi.mock("@/hooks/useStartupSequence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useStartupSequence")>();
  return {
    ...actual,
    useSessionReady: () => ({ ...actual.useSessionReady(), readyToken: 1 }),
  };
});

const cachedFeed = vi.mocked(api.cachedFeed);
const refreshFeed = vi.mocked(api.refreshFeed);
const loadFeedPage = vi.mocked(api.loadFeedPage);

function feedOf(
  posts: ReturnType<typeof makePost>[],
  nextCursor?: string | null,
) {
  return {
    posts,
    fromCache: true,
    provider: "twitter-cli",
    readIds: [],
    totalCached: posts.length,
    nextCursor,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRefreshClaims();
  cachedFeed.mockResolvedValue(feedOf([]));
  refreshFeed.mockResolvedValue(feedOf([]));
  loadFeedPage.mockResolvedValue(feedOf([]));
});

describe("Originals", () => {
  it("asks the backend for the following timeline with reposts excluded", async () => {
    renderWithProviders(<OriginalsPage />);
    await waitFor(() => expect(cachedFeed).toHaveBeenCalled());

    const [feed, filters] = cachedFeed.mock.calls[0];
    expect(feed).toBe("following");
    expect(filters.hideReposts).toBe(true);
  });

  it("offers no filter bar, because 'no reposts' is not a preference here", async () => {
    renderWithProviders(<OriginalsPage />);
    await waitFor(() => expect(cachedFeed).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "No reposts" })).toBeNull();
  });

  it("shows a quote post: the account wrote those words", async () => {
    const quote = makePost({
      id: "q",
      text: "Worth reading.",
      isRepost: false,
    });
    cachedFeed.mockResolvedValue(feedOf([quote]));
    refreshFeed.mockResolvedValue(feedOf([quote]));
    renderWithProviders(<OriginalsPage />);
    expect(await screen.findByText("Worth reading.")).toBeInTheDocument();
  });
});

describe("claimRefresh", () => {
  it("lets one caller through per feed and ready token", () => {
    expect(claimRefresh("following", 1)).toBe(true);
    expect(claimRefresh("following", 1)).toBe(false);
    expect(claimRefresh("following", 1)).toBe(false);
  });

  it("never claims before the startup check has answered", () => {
    expect(claimRefresh("following", 0)).toBe(false);
    // And having refused, it has not consumed the claim.
    expect(claimRefresh("following", 1)).toBe(true);
  });

  it("gives a reconnect a fresh pull", () => {
    expect(claimRefresh("following", 1)).toBe(true);
    expect(claimRefresh("following", 2)).toBe(true);
  });

  it("tracks feeds independently", () => {
    expect(claimRefresh("following", 1)).toBe(true);
    expect(claimRefresh("bookmarks", 1)).toBe(true);
  });
});

describe("the shared following source", () => {
  it("costs X one refresh however many of its views are opened", async () => {
    // Following, Originals and Focus are three filtered views of one timeline.
    // Before the claim moved to module scope this was one `refresh_feed` — and
    // one spawned twitter.exe — per page.
    renderWithProviders(<FollowingPage />);
    await waitFor(() => expect(refreshFeed).toHaveBeenCalledTimes(1));

    renderWithProviders(<OriginalsPage />);
    await waitFor(() => expect(cachedFeed).toHaveBeenCalledTimes(2));
    expect(refreshFeed).toHaveBeenCalledTimes(1);
  });

  it("continues from the backend cursor and renders older posts", async () => {
    const newest = makePost({ id: "new", text: "Newest page" });
    const older = makePost({ id: "old", text: "Older page" });
    refreshFeed.mockResolvedValue(feedOf([newest], "cursor-1"));
    loadFeedPage.mockResolvedValue(feedOf([newest, older], null));
    const user = userEvent.setup();

    renderWithProviders(<FollowingPage />);
    await screen.findByText("Newest page");
    await user.click(await screen.findByRole("button", { name: "Load more" }));

    expect(loadFeedPage).toHaveBeenCalledWith(
      "following",
      "cursor-1",
      expect.any(Object),
      40,
      120,
    );
    expect(await screen.findByText("Older page")).toBeInTheDocument();
  });
});
