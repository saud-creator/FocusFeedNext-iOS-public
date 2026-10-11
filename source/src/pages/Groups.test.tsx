import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { GroupsPage } from "./Groups";
import { makeAuthor, renderWithProviders } from "@/test/factories";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      groups: vi.fn(),
      groupMembers: vi.fn(),
      groupCandidates: vi.fn(),
      groupFeed: vi.fn(),
      refreshGroupFeed: vi.fn(),
      followingAccounts: vi.fn(),
      knownAccounts: vi.fn(),
      setGroupMember: vi.fn(),
      createGroup: vi.fn(),
      updateGroup: vi.fn(),
      deleteGroup: vi.fn(),
      postsByAuthors: vi.fn(),
    },
  };
});

const groups = vi.mocked(api.groups);
const groupMembers = vi.mocked(api.groupMembers);
const groupCandidates = vi.mocked(api.groupCandidates);
const groupFeed = vi.mocked(api.groupFeed);
const refreshGroupFeed = vi.mocked(api.refreshGroupFeed);
const knownAccounts = vi.mocked(api.knownAccounts);
const setGroupMember = vi.mocked(api.setGroupMember);
const deleteGroup = vi.mocked(api.deleteGroup);
const updateGroup = vi.mocked(api.updateGroup);
const postsByAuthors = vi.mocked(api.postsByAuthors);

const REEM = makeAuthor({ id: "a1", username: "reem_codes", displayName: "Reem" });
const OMAR = makeAuthor({ id: "a2", username: "omar_dev", displayName: "Omar" });
/** Followed by nobody: the shape of an author who reached the local database
 *  through a feed or a bookmark rather than through the follow graph. */
const STRANGER = makeAuthor({
  id: "a9",
  username: "a_stranger",
  displayName: "Stranger",
});

function emptyFeed() {
  return {
    posts: [],
    fromCache: true,
    provider: "twitter-cli",
    readIds: [],
    totalCached: 0,
  };
}

describe("Groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groups.mockResolvedValue([
      { id: "g1", name: "Rust", color: "#6366f1", memberCount: 1 },
      { id: "g2", name: "Design", color: "#10b981", memberCount: 0 },
    ]);
    groupMembers.mockResolvedValue(["a1"]);
    // The backend answers the picker from the traversed Following list and
    // flags each row. STRANGER is deliberately absent: it reached the local
    // database through a feed, and the reader does not follow it.
    groupCandidates.mockResolvedValue([
      { author: REEM, following: true, member: true },
      { author: OMAR, following: true, member: false },
    ]);
    groupFeed.mockResolvedValue(emptyFeed());
    refreshGroupFeed.mockResolvedValue({
      ...emptyFeed(),
      failures: [],
      nextOffset: null,
      memberCount: 1,
      loadedAccounts: 1,
    });
    knownAccounts.mockResolvedValue([REEM, OMAR, STRANGER]);
    setGroupMember.mockResolvedValue(undefined);
    deleteGroup.mockResolvedValue(undefined);
    updateGroup.mockResolvedValue(undefined);
    postsByAuthors.mockResolvedValue([]);
  });

  it("takes its member candidates from the accounts you follow", async () => {
    // The old picker used `knownAccounts` — every author the app had ever seen,
    // including people the reader does not follow. That is the defect: a group
    // could be filled with accounts the reader has no relationship with.
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));

    expect(await screen.findByRole("checkbox", { name: /Omar/ })).toBeInTheDocument();
    expect(screen.queryByText("Stranger")).toBeNull();
    expect(knownAccounts).not.toHaveBeenCalled();
    expect(groupCandidates).toHaveBeenCalledWith("g1");
  });

  it("reads the group as one combined timeline, not whatever was cached", async () => {
    // `postsByAuthors` returned whatever happened to be in the session
    // database, which came out as roughly one post per account — twenty
    // accounts looked like twenty single posts rather than a timeline.
    renderWithProviders(<GroupsPage />);
    await screen.findByRole("button", { name: /Edit members/ });
    expect(groupFeed).toHaveBeenCalled();
    expect(postsByAuthors).not.toHaveBeenCalled();
  });

  it("walks the member list and stops when every member has been read", async () => {
    refreshGroupFeed.mockResolvedValueOnce({
      ...emptyFeed(),
      failures: [],
      nextOffset: 5,
      memberCount: 12,
      loadedAccounts: 5,
    });
    renderWithProviders(<GroupsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Load more accounts/ }),
    );
    expect(refreshGroupFeed).toHaveBeenCalledWith(
      "g1",
      0,
      expect.anything(),
    );
    await screen.findByText(/5 of 1 members loaded/);

    // Second pass reports the end, and the control stops offering more.
    await userEvent.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /All members loaded/ }),
      ).toBeDisabled(),
    );
  });

  it("names the members it could not read, and shows the rest", async () => {
    refreshGroupFeed.mockResolvedValue({
      ...emptyFeed(),
      failures: [
        { username: "omar_dev", code: "request_failed", message: "timed out" },
      ],
      nextOffset: null,
      memberCount: 2,
      loadedAccounts: 1,
    });
    renderWithProviders(<GroupsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Load more accounts/ }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/@omar_dev/);
  });

  it("leaves edit mode when the members are saved", async () => {
    // The whole reason for the rewrite. An effect used to re-select the first
    // group whenever the selection cleared, so the editor reopened the instant
    // it was closed and there was no way out of it.
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /Omar/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save members/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Edit members/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Save members/ })).toBeNull();
    expect(setGroupMember).toHaveBeenCalledWith("g1", "a2", true);
  });

  it("saves only what changed", async () => {
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /Omar/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save members/ }));

    await waitFor(() => expect(setGroupMember).toHaveBeenCalledTimes(1));
  });

  it("restores the saved membership on cancel", async () => {
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));
    const omar = await screen.findByRole("checkbox", { name: /Omar/ });
    await userEvent.click(omar);
    expect(omar).toHaveAttribute("aria-checked", "true");

    await userEvent.click(screen.getByRole("button", { name: /Discard changes/ }));
    expect(setGroupMember).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Edit members/ })).toBeInTheDocument();
  });

  it("cannot save when nothing has changed", async () => {
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));
    expect(screen.getByRole("button", { name: /Save members/ })).toBeDisabled();
  });

  it("survives repeated edit and cancel cycles", async () => {
    renderWithProviders(<GroupsPage />);
    for (let i = 0; i < 3; i++) {
      await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));
      await userEvent.click(screen.getByRole("button", { name: /Cancel|Discard/ }));
    }
    expect(screen.getByRole("button", { name: /Edit members/ })).toBeInTheDocument();
  });

  it("keeps a member who is no longer followed, and says so", async () => {
    // X's follow graph changing must not silently edit the reader's own group.
    groupMembers.mockResolvedValue(["a1", "a9"]);
    groupCandidates.mockResolvedValue([
      { author: REEM, following: true, member: true },
      { author: OMAR, following: true, member: false },
      // Was followed when the group was made; is not any more.
      { author: STRANGER, following: false, member: true },
    ]);
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));

    const stranded = await screen.findByRole("checkbox", { name: /Not followed/ });
    expect(stranded).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the draft and reports the failure when saving fails", async () => {
    setGroupMember.mockRejectedValue(new Error("offline"));
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /Omar/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save members/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not save the member list/,
    );
    // Still editing, and the choice the reader made is still on screen.
    expect(screen.getByRole("checkbox", { name: /Omar/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("leaves edit mode when a different group is chosen", async () => {
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Edit members/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Design ·/ }));

    expect(screen.getByRole("button", { name: /Edit members/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save members/ })).toBeNull();
  });

  it("asks before deleting a group, and says nothing changes on X", async () => {
    renderWithProviders(<GroupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Rust" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Nothing changes on X/);
    expect(deleteGroup).not.toHaveBeenCalled();
  });

  it("renames a list and updates its colour from the list page", async () => {
    renderWithProviders(<GroupsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rename Rust" }),
    );
    const name = screen.getByRole("textbox", { name: "List name" });
    await userEvent.clear(name);
    await userEvent.type(name, "AI");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateGroup).toHaveBeenCalledWith("g1", "AI", "#6366f1"),
    );
  });

  it("does not show the member picker until editing starts", async () => {
    // Outside edit mode the panel is a read-only summary. The old page always
    // rendered a grid of clickable accounts, which is why it read as an editor
    // that would not close.
    renderWithProviders(<GroupsPage />);
    await screen.findByRole("button", { name: /Edit members/ });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
