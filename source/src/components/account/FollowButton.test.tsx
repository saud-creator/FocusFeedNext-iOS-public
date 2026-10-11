import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { makeAuthor, makeSnapshot, renderWithProviders } from "@/test/factories";
import { PlatformProvider } from "@/lib/platform";
import { FollowButton } from "./FollowButton";
import { useAccountActionStore } from "./accountActions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      followingSnapshot: vi.fn(),
      unfollowAllowed: vi.fn(),
      providerCapabilities: vi.fn(),
      followAccount: vi.fn(),
      unfollowAccount: vi.fn(),
      sessionStatus: vi.fn(),
      accountRelationship: vi.fn(),
    },
  };
});

describe("iPhone targeted relationships", () => {
  it("uses a targeted read and reconciles a private-account follow as pending", async () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    vi.mocked(api.sessionStatus).mockResolvedValue(makeSnapshot({state:'connected', account:REEM}));
    vi.mocked(api.accountRelationship).mockResolvedValueOnce('notFollowing').mockResolvedValue('pending');
    try {
      const user = userEvent.setup();
      renderWithProviders(<PlatformProvider><FollowButton account={OMAR} /></PlatformProvider>);
      await user.click(await screen.findByLabelText('Follow @omar_dev'));
      expect(await screen.findByText('Follow request pending')).toBeDisabled();
      expect(api.accountRelationship).toHaveBeenCalledWith('omar_dev');
      expect(followingSnapshot).not.toHaveBeenCalled();
      expect(followAccount).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(window.navigator, 'userAgent', original);
      else Reflect.deleteProperty(window.navigator, 'userAgent');
    }
  });
});

const followingSnapshot = vi.mocked(api.followingSnapshot);
const unfollowAllowed = vi.mocked(api.unfollowAllowed);
const providerCapabilities = vi.mocked(api.providerCapabilities);
const followAccount = vi.mocked(api.followAccount);
const unfollowAccount = vi.mocked(api.unfollowAccount);

const REEM = makeAuthor({
  id: "a1",
  username: "reem_codes",
  displayName: "Reem",
});
const OMAR = makeAuthor({
  id: "a2",
  username: "omar_dev",
  displayName: "Omar",
});

const CAPABILITIES = {
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
};

/** A promise that never settles, for asserting an in-flight state. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  useAccountActionStore.getState().reset();
  unfollowAllowed.mockResolvedValue(true);
  providerCapabilities.mockResolvedValue({ ...CAPABILITIES });
  followingSnapshot.mockResolvedValue({
    accounts: [REEM],
    complete: true,
    syncing: false,
  });
  followAccount.mockResolvedValue(undefined);
  unfollowAccount.mockResolvedValue(undefined);
});

describe("FollowButton — what it offers at all", () => {
  it("renders nothing while the gates are still answering", () => {
    unfollowAllowed.mockReturnValue(pending<boolean>());
    const { container } = renderWithProviders(<FollowButton account={REEM} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing when the reader has not switched account actions on", async () => {
    unfollowAllowed.mockResolvedValue(false);
    const { container } = renderWithProviders(<FollowButton account={REEM} />);
    await waitFor(() => expect(unfollowAllowed).toHaveBeenCalled());
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing when the backend cannot follow or unfollow", async () => {
    providerCapabilities.mockResolvedValue({
      ...CAPABILITIES,
      follow: false,
      unfollow: false,
    });
    const { container } = renderWithProviders(<FollowButton account={REEM} />);
    await waitFor(() => expect(providerCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
  });

  it("hides Unfollow when only Follow is supported", async () => {
    providerCapabilities.mockResolvedValue({
      ...CAPABILITIES,
      unfollow: false,
    });
    renderWithProviders(<FollowButton account={REEM} />);
    await waitFor(() => expect(followingSnapshot).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByLabelText("Unfollow @reem_codes")).toBeNull(),
    );
  });
});

describe("FollowButton — the relationship", () => {
  it("says it is checking rather than guessing", async () => {
    followingSnapshot.mockReturnValue(pending());
    renderWithProviders(<FollowButton account={REEM} />);
    expect(
      await screen.findByLabelText("Checking whether you follow @reem_codes"),
    ).toBeDisabled();
    expect(screen.queryByLabelText("Follow @reem_codes")).toBeNull();
    expect(screen.queryByLabelText("Unfollow @reem_codes")).toBeNull();
  });

  it("shows Unfollow, and never Follow, for an account that is followed", async () => {
    renderWithProviders(<FollowButton account={REEM} />);
    expect(
      await screen.findByLabelText("Unfollow @reem_codes"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Follow @reem_codes")).toBeNull();
  });

  it("shows Follow, and never Unfollow, for an account that is not", async () => {
    // OMAR is a perfectly well-known author — he is simply not followed. The
    // control must come from the following list, not from cache presence.
    renderWithProviders(<FollowButton account={OMAR} />);
    expect(
      await screen.findByLabelText("Follow @omar_dev"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Unfollow @omar_dev")).toBeNull();
  });

  it("compares handles without an @ and without regard to case", async () => {
    followingSnapshot.mockResolvedValue({
      accounts: [
        makeAuthor({ id: "a1", username: "Reem_Codes", displayName: "Reem" }),
      ],
      complete: true,
      syncing: false,
    });
    renderWithProviders(<FollowButton account={{ username: "@reem_codes" }} />);
    expect(
      await screen.findByLabelText("Unfollow @reem_codes"),
    ).toBeInTheDocument();
  });

  it("offers a re-check instead of a guess when the list cannot be read", async () => {
    followingSnapshot.mockRejectedValue({ message: "X did not answer." });
    renderWithProviders(<FollowButton account={REEM} />);
    expect(
      await screen.findByLabelText(
        "Check again whether you follow @reem_codes",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Follow @reem_codes")).toBeNull();
    expect(screen.queryByLabelText("Unfollow @reem_codes")).toBeNull();
  });
});

describe("FollowButton — unfollowing", () => {
  it("asks first, naming the picture, the display name and the exact handle", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FollowButton account={REEM} />);
    await user.click(await screen.findByLabelText("Unfollow @reem_codes"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Reem");
    expect(dialog).toHaveTextContent("@reem_codes");
    expect(dialog).toHaveTextContent(/changes your real X account/i);
    // The picture is decorative next to the name it belongs to, so it carries
    // an empty alt rather than a second copy of the display name.
    expect(dialog.querySelector("img")).not.toBeNull();
    expect(unfollowAccount).not.toHaveBeenCalled();
  });

  it("does nothing when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FollowButton account={REEM} />);
    await user.click(await screen.findByLabelText("Unfollow @reem_codes"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(unfollowAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Unfollow @reem_codes")).toBeInTheDocument();
  });

  it("acts once on confirmation and flips to Follow straight away", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FollowButton account={REEM} />);
    await user.click(await screen.findByLabelText("Unfollow @reem_codes"));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unfollow @reem_codes",
      }),
    );

    await waitFor(() =>
      expect(unfollowAccount).toHaveBeenCalledWith("reem_codes"),
    );
    expect(unfollowAccount).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByLabelText("Follow @reem_codes"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Unfollow @reem_codes")).toBeNull();
  });

  it("rolls back, explains, and does not retry when it fails", async () => {
    unfollowAccount.mockRejectedValue({
      message: "X is rate limiting this account.",
    });
    const user = userEvent.setup();
    renderWithProviders(<FollowButton account={REEM} />);
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
    expect(screen.getByText(/Nothing was retried/)).toBeInTheDocument();
    // The dialog stays open: the app must not read as if it succeeded.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // The optimistic flip is undone: the account is followed again.
    expect(screen.getByLabelText("Unfollow @reem_codes")).toBeInTheDocument();
    expect(screen.queryByLabelText("Follow @reem_codes")).toBeNull();
  });
});

describe("FollowButton — following", () => {
  it("follows on one deliberate click, with no dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FollowButton account={OMAR} />);
    await user.click(await screen.findByLabelText("Follow @omar_dev"));
    await waitFor(() => expect(followAccount).toHaveBeenCalledWith("omar_dev"));
    expect(followAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByLabelText("Unfollow @omar_dev"),
    ).toBeInTheDocument();
  });

  it("disables itself while the request is in flight", async () => {
    followAccount.mockReturnValue(pending<void>());
    const user = userEvent.setup();
    renderWithProviders(<FollowButton account={OMAR} />);
    await user.click(await screen.findByLabelText("Follow @omar_dev"));
    // Optimistically followed, so the control is now Unfollow — and inert
    // until the request settles.
    const control = await screen.findByLabelText("Unfollow @omar_dev");
    expect(control).toBeDisabled();
  });

  it("rolls back to Follow when the request fails", async () => {
    followAccount.mockRejectedValue({ message: "That did not go through." });
    const user = userEvent.setup();
    renderWithProviders(<FollowButton account={OMAR} />);
    await user.click(await screen.findByLabelText("Follow @omar_dev"));
    expect(
      await screen.findByText("That did not go through."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Follow @omar_dev")).toBeInTheDocument();
    expect(followAccount).toHaveBeenCalledTimes(1);
  });
});

describe("FollowButton — one operation at a time", () => {
  it("updates every visible copy of the same account", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <FollowButton account={OMAR} />
        <FollowButton account={OMAR} showFailure={false} />
      </>,
    );
    const buttons = await screen.findAllByLabelText("Follow @omar_dev");
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    await waitFor(() =>
      expect(screen.getAllByLabelText("Unfollow @omar_dev")).toHaveLength(2),
    );
  });

  it("locks out a second account while one change is running", async () => {
    followAccount.mockReturnValue(pending<void>());
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <FollowButton account={OMAR} />
        <FollowButton account={{ username: "sara_x", displayName: "Sara" }} />
      </>,
    );
    await user.click(await screen.findByLabelText("Follow @omar_dev"));
    const other = await screen.findByLabelText("Follow @sara_x");
    expect(other).toBeDisabled();
    await user.click(other);
    expect(followAccount).toHaveBeenCalledTimes(1);
  });
});
