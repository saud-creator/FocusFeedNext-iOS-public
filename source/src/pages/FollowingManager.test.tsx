import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { FollowingManagerPage } from "./FollowingManager";
import { useAppStore } from "@/stores/useAppStore";
import { makeAuthor, renderWithProviders } from "@/test/factories";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      followingSnapshot: vi.fn(),
      followingAccounts: vi.fn(),
      startFollowingSync: vi.fn(),
      pinnedAccounts: vi.fn(),
      groups: vi.fn(),
      unfollowAllowed: vi.fn(),
      providerCapabilities: vi.fn(),
      setSetting: vi.fn(),
      unfollowAccount: vi.fn(),
    },
  };
});

vi.mock("@/hooks/useStartupSequence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useStartupSequence")>();
  return {
    ...actual,
    useSessionReady: () => ({
      phase: "ready",
      snapshot: null,
      readyToken: 1,
    }),
  };
});

const followingSnapshot = vi.mocked(api.followingSnapshot);
const followingAccounts = vi.mocked(api.followingAccounts);
const startFollowingSync = vi.mocked(api.startFollowingSync);
const pinnedAccounts = vi.mocked(api.pinnedAccounts);
const groups = vi.mocked(api.groups);
const unfollowAllowed = vi.mocked(api.unfollowAllowed);
const providerCapabilities = vi.mocked(api.providerCapabilities);
const setSetting = vi.mocked(api.setSetting);
const unfollowAccount = vi.mocked(api.unfollowAccount);

const REEM = makeAuthor({
  id: "a1",
  username: "reem_codes",
  displayName: "Reem",
});

beforeEach(() => {
  vi.clearAllMocks();
  followingSnapshot.mockResolvedValue({
    accounts: [REEM],
    complete: true,
    syncing: false,
  });
  startFollowingSync.mockResolvedValue(false);
  pinnedAccounts.mockResolvedValue([]);
  groups.mockResolvedValue([]);
  // Fresh installs enable the durable Unfollow preference. Individual tests
  // that exercise the read-only path set an explicit false below.
  unfollowAllowed.mockResolvedValue(true);
  providerCapabilities.mockResolvedValue({
    feedCursor: true,
    listCursor: true,
    followingCursor: true,
    userPostsCursor: false,
    promotedFlag: true,
    unfollow: true,
    follow: true,
    mute: false,
    block: false,
    unbookmark: false,
  });
  setSetting.mockResolvedValue(undefined);
  unfollowAccount.mockResolvedValue(undefined);
});

describe("People you follow — the list", () => {
  it('settles a failed worker start and retries only when requested',async()=>{
    followingSnapshot.mockResolvedValue({accounts:[],complete:false,syncing:false,state:'idle'});
    startFollowingSync.mockRejectedValue({code:'network_unavailable',message:'Connection interrupted'});
    const user=userEvent.setup();
    renderWithProviders(<FollowingManagerPage/>);
    expect(await screen.findByText('Connection interrupted')).toBeInTheDocument();
    await waitFor(()=>expect(followingSnapshot.mock.calls.length).toBeGreaterThan(1));
    expect(startFollowingSync).toHaveBeenCalledTimes(1);
    await user.click(screen.getAllByRole('button',{name:'Retry'})[0]);
    await waitFor(()=>expect(startFollowingSync).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Loading the people you follow…')).not.toBeInTheDocument();
  });
  it('offers recovery without claiming an unstarted empty list is complete',async()=>{
    followingSnapshot.mockResolvedValue({accounts:[],complete:false,syncing:false,state:'idle'});
    renderWithProviders(<FollowingManagerPage/>);
    expect(await screen.findByText('Accounts have not loaded yet.')).toBeInTheDocument();
    expect(screen.queryByText('No accounts found')).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Retry'})).toBeEnabled();
  });
  it('ends the skeleton when the worker failed before its first page', async () => {
    followingSnapshot.mockResolvedValue(Object.assign({accounts: [], complete:false, syncing:false}, {state:'failed' as const,lastError:'Twitter request timed out',lastProgressAt:null}));
    renderWithProviders(<FollowingManagerPage />);
    expect(await screen.findByText('Twitter request timed out')).toBeInTheDocument();
    expect(screen.queryByText(/Loading the people you follow/)).not.toBeInTheDocument();
    expect(startFollowingSync).not.toHaveBeenCalled();
  });
  it('keeps a partial account list and exposes the later page failure', async () => {
    followingSnapshot.mockResolvedValue(Object.assign({accounts:[REEM],complete:false,syncing:false},{state:'failed' as const,lastError:'Connection interrupted',lastProgressAt:null}));
    renderWithProviders(<FollowingManagerPage />);
    expect(await screen.findByText('Connection interrupted')).toBeInTheDocument();
    expect(screen.getByText('Reem')).toBeInTheDocument();
    expect(screen.queryByText(/Loading the people you follow/)).not.toBeInTheDocument();
  });
  it("does not call an incomplete empty snapshot empty while it is syncing", async () => {
    followingSnapshot.mockResolvedValue({
      accounts: [],
      complete: false,
      syncing: true,
    });

    renderWithProviders(<FollowingManagerPage />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      /Loading the people you follow/i,
    );
    expect(screen.queryByText("No accounts found")).toBeNull();
  });

  it("shows the snapshot failure instead of disguising it as an empty list", async () => {
    followingSnapshot.mockRejectedValue(new Error("session unavailable"));

    renderWithProviders(<FollowingManagerPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "session unavailable",
    );
    expect(screen.queryByText("No accounts found")).toBeNull();
  });

  it("renders from this session's store, without asking X for anything", async () => {
    // The startup preload has already filled the store. Opening the page must
    // not spend a provider call — the old version did, on every mount.
    renderWithProviders(<FollowingManagerPage />);
    expect(await screen.findByText("Reem")).toBeInTheDocument();
    expect(followingAccounts).not.toHaveBeenCalled();
    await waitFor(() => expect(startFollowingSync).not.toHaveBeenCalled());
  });

  it("opens the account when its name is pressed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FollowingManagerPage />);
    await user.click(await screen.findByRole("button", { name: "Reem" }));
    expect(useAppStore.getState().route).toBe("profile");
    expect(useAppStore.getState().profileUsername).toBe("reem_codes");
  });

  it("opens the account from its handle too", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FollowingManagerPage />);
    await user.click(
      await screen.findByRole("button", { name: "@reem_codes" }),
    );
    expect(useAppStore.getState().profileUsername).toBe("reem_codes");
  });

  it("asks for the rest of the list only when the store is short of it", async () => {
    followingSnapshot.mockResolvedValue({
      accounts: [REEM],
      complete: false,
      syncing: false,
    });
    renderWithProviders(<FollowingManagerPage />);
    await screen.findByText("Reem");
    await waitFor(() => expect(startFollowingSync).toHaveBeenCalledTimes(1));
  });

  it("does not start a second traversal while one is running", async () => {
    followingSnapshot.mockResolvedValue({
      accounts: [REEM],
      complete: false,
      syncing: true,
    });
    renderWithProviders(<FollowingManagerPage />);
    await screen.findByText("Reem");
    await waitFor(() => expect(startFollowingSync).not.toHaveBeenCalled());
  });
});

describe("People you follow — Unfollow", () => {
  it("offers the Unfollow control by default", async () => {
    // The preference ships on, so the control is present by default. The
    // confirmation dialog still stands between the row and the provider call.
    renderWithProviders(<FollowingManagerPage />);
    expect(await screen.findByText("Reem")).toBeInTheDocument();
    expect(
      await screen.findByLabelText("Unfollow @reem_codes"),
    ).toBeInTheDocument();
  });

  it("lets the reader disable the confirmation-gated action on this page", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FollowingManagerPage />);

    const toggle = await screen.findByRole("switch", {
      name: "Allow Unfollow actions",
    });
    await user.click(toggle);

    expect(setSetting).toHaveBeenCalledWith("actions.allowUnfollow", "false");
  });

  it("describes itself as read-focused while Unfollow is off", async () => {
    unfollowAllowed.mockResolvedValue(false);
    renderWithProviders(<FollowingManagerPage />);
    expect(
      await screen.findByText(
        /other account-changing actions stay disabled by default/i,
      ),
    ).toBeInTheDocument();
  });

  it("never calls the backend when the control is absent", async () => {
    unfollowAllowed.mockResolvedValue(false);
    renderWithProviders(<FollowingManagerPage />);
    await screen.findByText("Reem");
    expect(unfollowAccount).not.toHaveBeenCalled();
  });

  it("shows the control when the preference is explicitly on", async () => {
    unfollowAllowed.mockResolvedValue(true);
    renderWithProviders(<FollowingManagerPage />);
    expect(
      await screen.findByLabelText("Unfollow @reem_codes"),
    ).toBeInTheDocument();
    // And the page stops claiming actions are disabled.
    expect(
      screen.queryByText(
        /other account-changing actions stay disabled by default/i,
      ),
    ).toBeNull();
  });

  it("asks for confirmation, naming the exact account, before acting", async () => {
    unfollowAllowed.mockResolvedValue(true);
    const user = userEvent.setup();
    renderWithProviders(<FollowingManagerPage />);

    await user.click(await screen.findByLabelText("Unfollow @reem_codes"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Reem");
    expect(dialog).toHaveTextContent("@reem_codes");
    expect(dialog).toHaveTextContent(/changes your real X account/i);
    // Opening the dialog must not have done anything yet.
    expect(unfollowAccount).not.toHaveBeenCalled();
  });

  it("does nothing at all when the dialog is cancelled", async () => {
    unfollowAllowed.mockResolvedValue(true);
    const user = userEvent.setup();
    renderWithProviders(<FollowingManagerPage />);

    await user.click(await screen.findByLabelText("Unfollow @reem_codes"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(unfollowAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Reem")).toBeInTheDocument();
  });

  it("removes the account from the list once it succeeds", async () => {
    unfollowAllowed.mockResolvedValue(true);
    const user = userEvent.setup();
    renderWithProviders(<FollowingManagerPage />);

    await user.click(await screen.findByLabelText("Unfollow @reem_codes"));
    // Scoped to the dialog: the row's icon button carries the same accessible
    // name, which is correct for both of them.
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unfollow @reem_codes",
      }),
    );

    await waitFor(() =>
      expect(unfollowAccount).toHaveBeenCalledWith("reem_codes"),
    );
    await waitFor(() => expect(screen.queryByText("Reem")).toBeNull());
  });

  it("keeps the account and shows the error when it fails, without retrying", async () => {
    // Retrying could unfollow twice: a failure might mean the request worked
    // and the response was lost.
    unfollowAllowed.mockResolvedValue(true);
    unfollowAccount.mockRejectedValue({
      message: "X is rate limiting this account.",
    });
    const user = userEvent.setup();
    renderWithProviders(<FollowingManagerPage />);

    await user.click(await screen.findByLabelText("Unfollow @reem_codes"));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unfollow @reem_codes",
      }),
    );

    expect(
      await screen.findByText("X is rate limiting this account."),
    ).toBeInTheDocument();
    expect(unfollowAccount).toHaveBeenCalledTimes(1);
    // Still listed: the app must not claim success it did not get. The row's
    // own control is the unambiguous marker — the display name now appears in
    // the still-open dialog too.
    expect(screen.getByLabelText("Unfollow @reem_codes")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("offers no bulk unfollow", async () => {
    unfollowAllowed.mockResolvedValue(true);
    renderWithProviders(<FollowingManagerPage />);
    await screen.findByLabelText("Unfollow @reem_codes");
    expect(screen.queryByText(/unfollow all/i)).toBeNull();
    expect(screen.queryByText(/select all/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
