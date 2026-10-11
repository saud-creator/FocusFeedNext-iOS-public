import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { APP_VERSION } from "@/lib/appVersion";
import { Sidebar } from "./Sidebar";
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
      groups: vi.fn(),
      createGroup: vi.fn(),
    },
  };
});

const sessionStatus = vi.mocked(api.sessionStatus);
const groups = vi.mocked(api.groups);
const createGroup = vi.mocked(api.createGroup);

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatus.mockResolvedValue(makeSnapshot());
    groups.mockResolvedValue([]);
    createGroup.mockResolvedValue(undefined);
  });

  it("groups the feed and the accounts behind it under Following", () => {
    renderWithProviders(<Sidebar unread={0} />);
    expect(screen.getByText("Following")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Following feed/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /People you follow/ }),
    ).toBeInTheDocument();
  });

  it("shows the release version in the persistent shell", () => {
    renderWithProviders(<Sidebar unread={0} />);
    expect(screen.getByTestId("app-version")).toHaveTextContent(
      `v${APP_VERSION}`,
    );
  });

  it("shows the connected account and its session state", async () => {
    sessionStatus.mockResolvedValue(
      makeSnapshot({
        state: "connected",
        reason: "ok",
        hasCredentials: true,
        account: makeAuthor({ username: "reader", displayName: "A Reader" }),
      }),
    );
    renderWithProviders(<Sidebar unread={0} />);

    expect(await screen.findByText("A Reader")).toBeInTheDocument();
    expect(screen.getByText("@reader")).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Connected",
    );
  });

  it("says plainly when no account is connected", async () => {
    renderWithProviders(<Sidebar unread={0} />);
    expect(
      await screen.findByText("No session is stored on this machine yet."),
    ).toBeInTheDocument();
  });

  it("does not claim there is no session while one is being checked", async () => {
    // Credentials are stored and posts may already be loading; claiming
    // nothing is stored contradicts what is on screen.
    sessionStatus.mockResolvedValue(
      makeSnapshot({
        state: "degraded",
        reason: "not_checked",
        hasCredentials: true,
        account: null,
      }),
    );
    renderWithProviders(<Sidebar unread={0} />);
    expect(
      await screen.findByText("Checking the session…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No session is stored on this machine yet."),
    ).not.toBeInTheDocument();
  });

  it("never advertises sample or demo data", async () => {
    // 0.1.0 showed a "Sample" badge here whenever the mock provider served the
    // page. Nothing in a production build may suggest content is real when it
    // is not, or the reverse.
    renderWithProviders(<Sidebar unread={0} />);
    await screen.findByText("No session is stored on this machine yet.");
    expect(screen.queryByText(/sample/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mock/i)).not.toBeInTheDocument();
  });

  it("renders the whole navigation in Arabic", () => {
    renderWithProviders(<Sidebar unread={0} />, {
      locale: "ar",
    });
    expect(screen.getByText("موجز المتابَعين")).toBeInTheDocument();
    expect(screen.getByText("الإعدادات")).toBeInTheDocument();
    // A missing key would leave the raw "nav.*" string on screen.
    expect(screen.queryByText(/^nav\./)).not.toBeInTheDocument();
  });

  it("has no Home entry, and leads with the feed", () => {
    // The dashboard was a page about the app rather than about the feed. A
    // reader should open on something to read.
    renderWithProviders(<Sidebar unread={0} />);
    expect(screen.queryByRole("button", { name: /^Home/ })).toBeNull();

    const labels = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    const feed = labels.findIndex((l) => l.includes("Following feed"));
    expect(feed).toBe(0);
  });

  it("offers no Search entry", () => {
    // It was the only screen that reached X while the reader was typing.
    renderWithProviders(<Sidebar unread={0} />);
    expect(screen.queryByRole("button", { name: /Search/ })).toBeNull();
  });

  it("shows an empty My lists section and lets the reader create a list", async () => {
    const user = userEvent.setup();
    sessionStatus.mockResolvedValue(
      makeSnapshot({
        state: "connected",
        reason: "ok",
        hasCredentials: true,
        account: makeAuthor({ username: "reader" }),
      }),
    );
    renderWithProviders(<Sidebar unread={0} />);

    expect(await screen.findByText("My lists")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New list" }));
    await user.type(screen.getByLabelText("List name"), "AI");
    await user.click(screen.getByRole("button", { name: "Create list" }));
    expect(createGroup).toHaveBeenCalledWith(
      expect.stringMatching(/^g_/),
      "AI",
      "#6366f1",
    );
  });

  it("renders dynamic lists and marks the selected list active", async () => {
    const user = userEvent.setup();
    sessionStatus.mockResolvedValue(
      makeSnapshot({
        state: "connected",
        reason: "ok",
        hasCredentials: true,
        account: makeAuthor({ username: "reader" }),
      }),
    );
    groups.mockResolvedValue([
      { id: "g_ai", name: "AI", color: "#6366f1", memberCount: 3 },
      { id: "g_news", name: "News", color: "#10b981", memberCount: 1 },
    ]);
    renderWithProviders(<Sidebar unread={0} />);

    const ai = await screen.findByRole("button", { name: /AI\s*3/ });
    expect(
      screen.getByRole("button", { name: /News\s*1/ }),
    ).toBeInTheDocument();
    await user.click(ai);
    expect(ai).toHaveAttribute("aria-current", "page");
  });

  it("offers no Pinned accounts entry", () => {
    // Its own empty state sent the reader to a screen that no longer exists
    // under that name, and pinning had no working destination.
    renderWithProviders(<Sidebar unread={0} />);
    expect(screen.queryByRole("button", { name: /pinned/i })).toBeNull();
  });

  it("formats the unread badge in the locale's digits", () => {
    renderWithProviders(<Sidebar unread={12} />, {
      locale: "ar",
    });
    // Arabic-Indic digits, not "12".
    expect(screen.getByText("١٢")).toBeInTheDocument();
  });
});
