import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import {
  IphoneCompanionConnection,
  WindowsIphoneCompanion,
} from "./IphoneCompanion";
import {
  makeAuthor,
  makeSnapshot,
  renderWithProviders,
} from "@/test/factories";
import { resetStartupSequenceForTests } from "@/hooks/useStartupSequence";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    isTauri: () => true,
    api: {
      ...actual.api,
      sessionStatus: vi.fn(),
      iphoneCompanionStatus: vi.fn(),
      startIphoneCompanion: vi.fn(),
      stopIphoneCompanion: vi.fn(),
      connectIphoneCompanion: vi.fn(),
      checkSession: vi.fn(),
      disconnect: vi.fn(),
    },
  };
});

const sessionStatus = vi.mocked(api.sessionStatus);
const companionStatus = vi.mocked(api.iphoneCompanionStatus);
const startCompanion = vi.mocked(api.startIphoneCompanion);
const connectCompanion = vi.mocked(api.connectIphoneCompanion);

const running = {
  running: true,
  address: "http://192.168.1.25:49152",
  port: 49152,
  pairingCode: "12345678",
  pairedOnce: false,
};

describe("WindowsIphoneCompanion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companionStatus.mockResolvedValue({
      running: false,
      address: null,
      port: null,
      pairingCode: null,
      pairedOnce: false,
    });
    startCompanion.mockResolvedValue(running);
  });

  it("never opens a LAN listener until the user explicitly starts it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WindowsIphoneCompanion />);

    expect(await screen.findByText("Not running")).toBeInTheDocument();
    expect(startCompanion).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Start iPhone companion" }),
    );

    expect(startCompanion).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("http://192.168.1.25:49152"),
    ).toBeInTheDocument();
    expect(screen.getByText("12345678")).toBeInTheDocument();
  });
});

describe("IphoneCompanionConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStartupSequenceForTests();
    sessionStatus.mockResolvedValue(makeSnapshot());
    connectCompanion.mockResolvedValue(
      makeSnapshot({
        state: "connected",
        reason: "ok",
        hasCredentials: true,
        account: makeAuthor({ username: "reader", displayName: "A Reader" }),
      }),
    );
  });

  it("pairs with the shown address and an eight-digit one-use code", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IphoneCompanionConnection />);

    await user.type(
      screen.getByLabelText("Windows address"),
      "http://192.168.1.25:49152",
    );
    const code = screen.getByLabelText("Pairing code") as HTMLInputElement;
    await user.type(code, "12ab3456789");
    expect(code.value).toBe("12345678");
    await user.click(screen.getByRole("button", { name: "Pair with Windows" }));

    await waitFor(() =>
      expect(connectCompanion).toHaveBeenCalledWith(
        "http://192.168.1.25:49152",
        "12345678",
      ),
    );
    expect(code.value).toBe("");
    expect(await screen.findByText("@reader")).toHaveAttribute("dir", "ltr");
  });

  it("never asks the iPhone for X cookies or a password", () => {
    renderWithProviders(<IphoneCompanionConnection />);

    expect(screen.queryByLabelText("auth_token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("ct0")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Companion access is read-only/),
    ).toBeInTheDocument();
  });
});
