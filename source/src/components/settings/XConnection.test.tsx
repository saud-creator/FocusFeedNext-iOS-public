import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { XConnection } from "./XConnection";
import {
  makeAuthor,
  makeSnapshot,
  renderWithProviders,
} from "@/test/factories";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      sessionStatus: vi.fn(),
      connect: vi.fn(),
      checkSession: vi.fn(),
      disconnect: vi.fn(),
    },
  };
});

const sessionStatus = vi.mocked(api.sessionStatus);
const connect = vi.mocked(api.connect);
const disconnect = vi.mocked(api.disconnect);

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const CT0 = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

const connectedSnapshot = makeSnapshot({
  state: "connected",
  reason: "ok",
  hasCredentials: true,
  account: makeAuthor({ username: "reader", displayName: "A Reader" }),
  checkedAt: "2026-07-24T10:00:00Z",
  lastSuccessAt: "2026-07-24T10:00:05Z",
});

function fields() {
  return {
    authToken: screen.getByLabelText("auth_token") as HTMLInputElement,
    ct0: screen.getByLabelText("ct0") as HTMLInputElement,
  };
}

describe("XConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatus.mockResolvedValue(makeSnapshot());
  });

  it("starts with both fields empty and never prefills a stored value", async () => {
    sessionStatus.mockResolvedValue(connectedSnapshot);
    renderWithProviders(<XConnection />);
    await screen.findByText("@reader");

    // The account is connected and credentials are stored, and the fields are
    // still empty: there is no path that can read a secret back out.
    const { authToken, ct0 } = fields();
    expect(authToken.value).toBe("");
    expect(ct0.value).toBe("");
  });

  it("masks both fields and offers no way to reveal them", async () => {
    renderWithProviders(<XConnection />);
    const { authToken, ct0 } = fields();
    expect(authToken).toHaveAttribute("type", "password");
    expect(ct0).toHaveAttribute("type", "password");
    expect(authToken).toHaveAttribute("autocomplete", "off");

    // No show/reveal/eye affordance of any kind.
    expect(
      screen.queryByRole("button", { name: /show|reveal|eye/i }),
    ).not.toBeInTheDocument();
  });

  it("sends both values in a single call and clears them immediately", async () => {
    connect.mockResolvedValue(connectedSnapshot);
    const user = userEvent.setup();
    renderWithProviders(<XConnection />);

    const { authToken, ct0 } = fields();
    await user.type(authToken, TOKEN);
    await user.type(ct0, CT0);
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledWith(TOKEN, CT0);

    // Nothing is left in the DOM to be screenshotted or inspected.
    await waitFor(() => expect(fields().authToken.value).toBe(""));
    expect(fields().ct0.value).toBe("");
  });

  it("keeps the fields cleared when the connection is rejected", async () => {
    // A failed attempt must not leave the rejected pair sitting in the form.
    connect.mockRejectedValue({
      code: "not_authenticated",
      message: "X did not accept those credentials.",
    });
    const user = userEvent.setup();
    renderWithProviders(<XConnection />);

    await user.type(fields().authToken, TOKEN);
    await user.type(fields().ct0, CT0);
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(
      await screen.findByText("X did not accept those credentials."),
    ).toBeInTheDocument();
    expect(fields().authToken.value).toBe("");
    expect(fields().ct0.value).toBe("");
  });

  it("cannot submit until both values are present", async () => {
    const user = userEvent.setup();
    renderWithProviders(<XConnection />);
    const save = screen.getByRole("button", { name: "Save connection" });
    expect(save).toBeDisabled();

    await user.type(fields().authToken, TOKEN);
    expect(save).toBeDisabled();

    await user.type(fields().ct0, CT0);
    expect(save).toBeEnabled();
  });

  it("offers Replace rather than Save once an account is connected", async () => {
    sessionStatus.mockResolvedValue(connectedSnapshot);
    renderWithProviders(<XConnection />);
    expect(
      await screen.findByRole("button", { name: "Replace credentials" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save connection" }),
    ).not.toBeInTheDocument();
  });

  it("shows credential presence, never a value", async () => {
    sessionStatus.mockResolvedValue(connectedSnapshot);
    renderWithProviders(<XConnection />);
    expect(
      await screen.findByText("Stored in Windows Credential Manager"),
    ).toBeInTheDocument();
  });

  it("disables Test and Disconnect when nothing is stored", async () => {
    renderWithProviders(<XConnection />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Test connection/ }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeDisabled();
  });

  it("states the session reason in words, not only as a colour", async () => {
    sessionStatus.mockResolvedValue(
      makeSnapshot({
        state: "expired",
        reason: "auth_failed",
        hasCredentials: true,
      }),
    );
    renderWithProviders(<XConnection />);

    // The dot's accessible name and the explanatory sentence both appear.
    const dot = await screen.findByRole("status");
    expect(dot).toHaveAttribute("aria-label", "Expired");
    expect(
      screen.getByText(/X no longer accepts this session/),
    ).toBeInTheDocument();
  });

  it("disconnects and reports it", async () => {
    sessionStatus.mockResolvedValue(connectedSnapshot);
    disconnect.mockResolvedValue(makeSnapshot());
    const user = userEvent.setup();
    renderWithProviders(<XConnection />);

    await user.click(await screen.findByRole("button", { name: /Disconnect/ }));
    expect(
      await screen.findByText("Disconnected. No live data will be requested."),
    ).toBeInTheDocument();
  });

  it("renders in Arabic without falling back to key names", async () => {
    sessionStatus.mockResolvedValue(connectedSnapshot);
    renderWithProviders(<XConnection />, { locale: "ar" });
    // Wait for the account to arrive, not just for the static header.
    const handle = await screen.findByText("@reader");
    expect(screen.getAllByText("الاتصال بـ X").length).toBeGreaterThan(0);
    // A missing key would render the literal key string instead.
    expect(screen.queryByText(/^connect\./)).not.toBeInTheDocument();
    // The handle stays LTR even in an RTL interface.
    expect(handle).toHaveAttribute("dir", "ltr");
  });
});
