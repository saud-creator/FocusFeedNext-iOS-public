import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import {
  makeAuthor,
  makeImage,
  makePost,
  makeQuoted,
  makeVideo,
  renderWithProviders,
} from "@/test/factories";
import { useAppStore } from "@/stores/useAppStore";
import { useAccountActionStore } from "@/components/account/accountActions";
import {
  ProfilePage,
  filterProfilePosts,
  mergePosts,
  noProfileFilters,
  safeWebsite,
} from "./Profile";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      userProfile: vi.fn(),
      refreshFeed: vi.fn(),
      followingSnapshot: vi.fn(),
      unfollowAllowed: vi.fn(),
      providerCapabilities: vi.fn(),
      setRead: vi.fn(),
      readIds: vi.fn(),
    },
  };
});

const userProfile = vi.mocked(api.userProfile);
const refreshFeed = vi.mocked(api.refreshFeed);
const followingSnapshot = vi.mocked(api.followingSnapshot);
const readIds = vi.mocked(api.readIds);
const unfollowAllowed = vi.mocked(api.unfollowAllowed);
const providerCapabilities = vi.mocked(api.providerCapabilities);

const REEM = makeAuthor({
  id: "a1",
  username: "reem_codes",
  displayName: "Reem",
  bio: "Rust, Arabic typography, long walks.",
  location: "Riyadh",
  website: "reem.dev",
  joinedAt: "2019-04-02T00:00:00Z",
  followersCount: 12400,
  followingCount: 310,
});

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function feedOf(posts: ReturnType<typeof makePost>[]) {
  return {
    posts,
    fromCache: false,
    provider: "twitter-cli",
    readIds: [],
    totalCached: posts.length,
  };
}

function openProfileRoute(username = "reem_codes") {
  useAppStore.setState({
    route: "following",
    profileUsername: null,
    history: [],
  });
  useAppStore.getState().openProfile(username);
}

beforeEach(() => {
  vi.clearAllMocks();
  useAccountActionStore.getState().reset();
  openProfileRoute();
  userProfile.mockResolvedValue(REEM);
  refreshFeed.mockResolvedValue(feedOf([]));
  followingSnapshot.mockResolvedValue({
    accounts: [],
    complete: true,
    syncing: false,
  });
  readIds.mockResolvedValue([]);
  unfollowAllowed.mockResolvedValue(false);
  providerCapabilities.mockRejectedValue({ message: "not needed" });
});

// ---------------------------------------------------------------------------

describe("mergePosts", () => {
  it("keeps source order and never repeats an id", () => {
    const a = makePost({ id: "1" });
    const b = makePost({ id: "2" });
    const c = makePost({ id: "3" });
    expect(mergePosts([a, b], [b, c]).map((p) => p.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("adds nothing when the batch is entirely known", () => {
    const a = makePost({ id: "1" });
    const merged = mergePosts([a], [a, a]);
    expect(merged).toHaveLength(1);
  });
});

describe("safeWebsite", () => {
  it("accepts a bare host and gives it https", () => {
    expect(safeWebsite("reem.dev")).toBe("https://reem.dev/");
  });

  it("keeps an explicit scheme", () => {
    expect(safeWebsite("http://reem.dev/x")).toBe("http://reem.dev/x");
  });

  it("refuses anything that is not a web address", () => {
    expect(safeWebsite("javascript:alert(1)")).toBeNull();
    expect(safeWebsite("  ")).toBeNull();
    expect(safeWebsite(null)).toBeNull();
  });
});

describe("filterProfilePosts", () => {
  const original = makePost({ id: "o", createdAt: "2026-01-03T00:00:00Z" });
  const repost = makePost({
    id: "r",
    isRepost: true,
    createdAt: "2026-01-02T00:00:00Z",
  });
  const reply = makePost({
    id: "y",
    inReplyTo: "o",
    createdAt: "2026-01-04T00:00:00Z",
  });
  const photo = makePost({
    id: "p",
    media: [makeImage()],
    createdAt: "2026-01-01T00:00:00Z",
  });
  const video = makePost({
    id: "v",
    media: [makeVideo()],
    createdAt: "2026-01-05T00:00:00Z",
  });
  const all = [original, repost, reply, photo, video];

  const ids = (f: Partial<typeof noProfileFilters>) =>
    filterProfilePosts(all, { ...noProfileFilters, ...f }).map((p) => p.id);

  it("drops replies on every tab, unconditionally", () => {
    for (const tab of ["posts", "originals", "media"] as const) {
      expect(ids({ tab })).not.toContain("y");
    }
  });

  it("keeps reposts on the Posts tab and drops them on Originals", () => {
    expect(ids({ tab: "posts" })).toContain("r");
    expect(ids({ tab: "originals" })).not.toContain("r");
  });

  it("counts a quote post as an original", () => {
    // The account wrote the words around the quote. Only pressing repost
    // makes a post somebody else's.
    const quote = makePost({ id: "q", quoted: makeQuoted() });
    const kept = filterProfilePosts([quote], {
      ...noProfileFilters,
      tab: "originals",
    });
    expect(kept.map((p) => p.id)).toEqual(["q"]);
  });

  it("keeps only posts with media on the Media tab", () => {
    expect(ids({ tab: "media" }).sort()).toEqual(["p", "v"]);
  });

  it("splits photos from videos within whichever tab is open", () => {
    expect(ids({ photosOnly: true })).toEqual(["p"]);
    expect(ids({ videosOnly: true })).toEqual(["v"]);
  });

  it("sorts newest first when asked, and leaves order alone otherwise", () => {
    expect(ids({ latestFirst: true })).toEqual(["v", "o", "r", "p"]);
    expect(ids({ latestFirst: false })).toEqual(["o", "r", "p", "v"]);
  });
});

// ---------------------------------------------------------------------------

describe("ProfilePage — the identity shell", () => {
  it("shows the handle before anything at all has loaded", () => {
    userProfile.mockReturnValue(pending<typeof REEM>());
    renderWithProviders(<ProfilePage />);
    expect(screen.getAllByText("@reem_codes").length).toBeGreaterThan(0);
  });

  it("renders the identity without waiting for a single post", async () => {
    // The posts call never settles. Everything about the account must still
    // be on screen.
    refreshFeed.mockReturnValue(pending());
    renderWithProviders(<ProfilePage />);

    expect((await screen.findAllByText("Reem")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Rust, Arabic typography, long walks."),
    ).toBeInTheDocument();
    expect(screen.getByText("Riyadh")).toBeInTheDocument();
    expect(screen.getByText("https://reem.dev/")).toBeInTheDocument();
    expect(screen.getByText(/Joined/)).toBeInTheDocument();
    expect(screen.getByText("Followers")).toBeInTheDocument();
    expect(screen.getByText("Following")).toBeInTheDocument();
  });

  it("explains itself and offers a retry when the profile cannot be read", async () => {
    userProfile.mockRejectedValue({ message: "That account is protected." });
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    expect(
      await screen.findByText("That account is protected."),
    ).toBeInTheDocument();
    userProfile.mockResolvedValue(REEM);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByText("Reem")).length).toBeGreaterThan(0);
  });

  it("offers no way out to x.com", async () => {
    renderWithProviders(<ProfilePage />);
    await screen.findAllByText("Reem");
    expect(screen.queryByRole("button", { name: /Open on X/ })).toBeNull();
    // The website is shown, but as text: it is not a control.
    expect(screen.getByText("https://reem.dev/")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reem\.dev/ })).toBeNull();
  });

  it("offers Back when there is somewhere to go back to", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    await screen.findAllByText("Reem");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(useAppStore.getState().route).toBe("following");
    expect(useAppStore.getState().profileUsername).toBeNull();
  });
});

describe("ProfilePage — posts", () => {
  it("loads posts after the shell and reports how many arrived", async () => {
    refreshFeed.mockResolvedValue(
      feedOf([makePost({ id: "p1" }), makePost({ id: "p2" })]),
    );
    renderWithProviders(<ProfilePage />);
    expect(await screen.findByText("2 posts loaded")).toBeInTheDocument();
    expect(refreshFeed).toHaveBeenCalledWith(
      "user:reem_codes",
      expect.any(Object),
      30,
      30,
    );
  });

  it("asks for a longer list on Load more, and does not repeat what it has", async () => {
    const first = [makePost({ id: "p1" }), makePost({ id: "p2" })];
    refreshFeed.mockResolvedValueOnce(
      feedOf(Array.from({ length: 30 }, (_, i) => makePost({ id: `p${i}` }))),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    await screen.findByText("30 posts loaded");

    refreshFeed.mockResolvedValueOnce(
      feedOf([...first, makePost({ id: "p99" })]),
    );
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(refreshFeed).toHaveBeenLastCalledWith(
        "user:reem_codes",
        expect.any(Object),
        60,
        60,
      ),
    );
    // 30 already held plus exactly one new id.
    expect(await screen.findByText("31 posts loaded")).toBeInTheDocument();
  });

  it("says there is no more when a short answer comes back", async () => {
    refreshFeed.mockResolvedValue(feedOf([makePost({ id: "p1" })]));
    renderWithProviders(<ProfilePage />);
    expect(
      await screen.findByText("That is everything loaded for this account."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("lets loading be stopped, and keeps what already arrived", async () => {
    refreshFeed.mockReturnValue(pending());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    const stop = await screen.findByRole("button", { name: "Stop loading" });
    await user.click(stop);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop loading" })).toBeNull(),
    );
    // English selects the `other` form for zero; the `zero` form is Arabic.
    expect(screen.getByText("0 posts loaded")).toBeInTheDocument();
  });

  it("explains a post failure and retries only when asked", async () => {
    refreshFeed.mockRejectedValue({ message: "X did not answer." });
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    expect(await screen.findByText("X did not answer.")).toBeInTheDocument();
    expect(refreshFeed).toHaveBeenCalledTimes(1);

    refreshFeed.mockResolvedValue(feedOf([makePost({ id: "p1" })]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1 post loaded")).toBeInTheDocument();
  });

  it("never shows a reply, on any tab", async () => {
    refreshFeed.mockResolvedValue(
      feedOf([
        makePost({ id: "p1", text: "A plain post." }),
        makePost({ id: "p2", text: "A reply to something.", inReplyTo: "p1" }),
      ]),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    expect(await screen.findByText("A plain post.")).toBeInTheDocument();
    expect(screen.queryByText("A reply to something.")).toBeNull();

    // There is no control that brings them back — not a tab, not a switch.
    expect(screen.queryByRole("tab", { name: "Replies" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Originals" }));
    expect(screen.queryByText("A reply to something.")).toBeNull();
  });

  it("switches to Originals without refetching a thing", async () => {
    refreshFeed.mockResolvedValue(
      feedOf([
        makePost({ id: "p1", text: "An original." }),
        makePost({ id: "p2", text: "A repost.", isRepost: true }),
      ]),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    await screen.findByText("A repost.");

    await user.click(screen.getByRole("tab", { name: "Originals" }));
    expect(screen.queryByText("A repost.")).toBeNull();
    expect(screen.getByText("An original.")).toBeInTheDocument();
    // The whole point: the tab is a view of what is already held.
    expect(refreshFeed).toHaveBeenCalledTimes(1);
  });
});

describe("ProfilePage — account actions", () => {
  it("offers no follow control while account actions are switched off", async () => {
    renderWithProviders(<ProfilePage />);
    await screen.findAllByText("Reem");
    expect(screen.queryByLabelText(/^Follow @/)).toBeNull();
    expect(screen.queryByLabelText(/^Unfollow @/)).toBeNull();
  });

  it("shows Unfollow for an account this session follows", async () => {
    unfollowAllowed.mockResolvedValue(true);
    providerCapabilities.mockResolvedValue({
      feedCursor: true,
      listCursor: true,
      followingCursor: false,
      userPostsCursor: false,
      promotedFlag: true,
      unfollow: true,
      follow: true,
      mute: false,
      block: false,
      unbookmark: false,
    });
    followingSnapshot.mockResolvedValue({
      accounts: [REEM],
      complete: true,
      syncing: false,
    });
    renderWithProviders(<ProfilePage />);
    expect(
      await screen.findByLabelText("Unfollow @reem_codes"),
    ).toBeInTheDocument();
  });
});
