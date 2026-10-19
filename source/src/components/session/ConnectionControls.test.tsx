import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, type SessionSnapshot } from "@/lib/api";
import { ConnectionControls, formatLatency } from "./ConnectionControls";
import { resetStartupSequenceForTests } from "@/hooks/useStartupSequence";
import { makeAuthor, makeSnapshot, renderWithProviders } from "@/test/factories";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      sessionStatus: vi.fn(),
      checkSession: vi.fn(),
    },
  };
});

const sessionStatus = vi.mocked(api.sessionStatus);
const checkSession = vi.mocked(api.checkSession);

const connected = (over = {}) =>
  makeSnapshot({
    state: "connected",
    reason: "ok",
    hasCredentials: true,
    account: makeAuthor({ username: "reader" }),
    latencyMs: 842,
    checkedAt: "2026-07-25T10:00:00Z",
    lastSuccessAt: "2026-07-25T10:00:00Z",
    ...over,
  });

describe("formatLatency", () => {
  it("uses milliseconds below a second and seconds above", () => {
    expect(formatLatency(842)).toBe("842 ms");
    expect(formatLatency(999)).toBe("999 ms");
    expect(formatLatency(1000)).toBe("1.0 s");
    expect(formatLatency(2683)).toBe("2.7 s");
  });

  it("never invents a latency", () => {
    // A request that has not completed has no duration. Showing 0 ms would
    // read as an impossibly fast connection.
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(undefined)).toBeNull();
    expect(formatLatency(Number.NaN)).toBeNull();
    expect(formatLatency(-5)).toBeNull();
  });
});

describe("ConnectionControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStartupSequenceForTests();
    sessionStatus.mockResolvedValue(connected());
    checkSession.mockResolvedValue(connected());
  });

  it("shows the state as text and the latency, not colour alone", async () => {
    renderWithProviders(<ConnectionControls />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("842 ms")).toBeInTheDocument();
  });

  it("puts the state and latency in the accessible name", async () => {
    renderWithProviders(<ConnectionControls />);
    await waitFor(() =>
      expect(
        screen.getByLabelText(/Connection status, Connected, Latency 842 ms/),
      ).toBeInTheDocument(),
    );
  });

  it("keeps the latency reading left-to-right", async () => {
    // A measurement is a number with a unit; it does not mirror in Arabic.
    renderWithProviders(<ConnectionControls />);
    expect(await screen.findByText("842 ms")).toHaveAttribute("dir", "ltr");
  });

  it("renders before any health check has finished", async () => {
    // The shell must never wait on twitter-cli to paint.
    sessionStatus.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<ConnectionControls />);
    expect(
      screen.getByRole("button", { name: "Test Connection" }),
    ).toBeInTheDocument();
  });

  it("says it is checking rather than showing a stale verdict", async () => {
    sessionStatus.mockResolvedValue(connected({ checking: true }));
    renderWithProviders(<ConnectionControls />);
    expect(await screen.findByText("Checking the session…")).toBeInTheDocument();
  });

  it("runs one check and disables itself while it is in flight", async () => {
    let release: (v: SessionSnapshot) => void = () => {};
    checkSession.mockImplementation(
      () =>
        new Promise<SessionSnapshot>((r) => {
          release = r;
        }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ConnectionControls />);

    const button = await screen.findByRole("button", { name: "Test Connection" });
    await user.click(button);

    const testing = await screen.findByRole("button", { name: /Testing/ });
    expect(testing).toBeDisabled();

    // A second click while it is running must not start another process.
    await user.click(testing).catch(() => {});
    expect(checkSession).toHaveBeenCalledTimes(1);

    release(connected());
  });

  it("forces the check rather than reusing a cached verdict", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectionControls />);
    await user.click(
      await screen.findByRole("button", { name: "Test Connection" }),
    );
    await waitFor(() => expect(checkSession).toHaveBeenCalledWith(true));
  });

  it("updates the latency from the completed check", async () => {
    checkSession.mockResolvedValue(connected({ latencyMs: 1200 }));
    const user = userEvent.setup();
    renderWithProviders(<ConnectionControls />);
    await user.click(
      await screen.findByRole("button", { name: "Test Connection" }),
    );
    expect(await screen.findByText("1.2 s")).toBeInTheDocument();
  });

  it("shows no latency at all when nothing has completed", async () => {
    sessionStatus.mockResolvedValue(
      makeSnapshot({ hasCredentials: true, latencyMs: null }),
    );
    renderWithProviders(<ConnectionControls />);
    await screen.findByRole("button", { name: /Connection status/ });
    expect(screen.queryByText(/ms$/)).toBeNull();
    expect(screen.queryByText(/ s$/)).toBeNull();
  });

  it("reports rate limiting as degraded, not connected", async () => {
    const degraded = connected({ state: "degraded", reason: "rate_limited" });
    sessionStatus.mockResolvedValue(degraded);
    checkSession.mockResolvedValue(degraded);
    renderWithProviders(<ConnectionControls />);
    expect(await screen.findByText("Degraded")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("reports an expired session as expired", async () => {
    sessionStatus.mockResolvedValue(
      makeSnapshot({
        state: "expired",
        reason: "auth_failed",
        hasCredentials: true,
        latencyMs: null,
      }),
    );
    renderWithProviders(<ConnectionControls />);
    expect(await screen.findByText("Expired")).toBeInTheDocument();
  });

  it("goes grey with no latency once credentials are gone", async () => {
    // Credentials removed out of band must not leave a green chip behind.
    const disconnected = makeSnapshot({
      state: "disconnected",
      reason: "no_credentials",
      hasCredentials: false,
      account: null,
      latencyMs: null,
    });
    sessionStatus.mockResolvedValue(disconnected);
    checkSession.mockResolvedValue(disconnected);
    renderWithProviders(<ConnectionControls />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("842 ms")).toBeNull();
  });

  it("opens a popover of safe diagnostics, with no secrets", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectionControls />);
    await user.click(
      await screen.findByRole("button", { name: /Connection status/ }),
    );

    const popover = screen.getByRole("dialog");
    expect(popover).toHaveTextContent("@reader");
    expect(popover).toHaveTextContent("twitter-cli");
    expect(popover).toHaveTextContent("Latency");

    const html = popover.innerHTML;
    for (const secret of ["auth_token", "ct0", "Cookie", "Bearer", "twimg.com"]) {
      expect(html).not.toContain(secret);
    }
  });

  it("closes the popover on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectionControls />);
    await user.click(
      await screen.findByRole("button", { name: /Connection status/ }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("labels everything in Arabic", async () => {
    renderWithProviders(<ConnectionControls />, { locale: "ar" });
    expect(
      await screen.findByRole("button", { name: "اختبار الاتصال" }),
    ).toBeInTheDocument();
    // A missing key would leave the raw "connection.*" string on screen.
    expect(screen.queryByText(/^connection\./)).toBeNull();
  });

  it("keeps the latency LTR in Arabic too", async () => {
    renderWithProviders(<ConnectionControls />, { locale: "ar" });
    expect(await screen.findByText("842 ms")).toHaveAttribute("dir", "ltr");
  });
});
