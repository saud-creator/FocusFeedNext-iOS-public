import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostActions } from "./PostActions";
import { renderWithProviders } from "@/test/factories";

describe("PostActions", () => {
  it("copies the legal post URL from the three-dot menu without opening it", async () => {
    const user = userEvent.setup();
    const copyLink = vi.fn();
    renderWithProviders(
      <PostActions
        read={false}
        onToggleRead={vi.fn()}
        onHide={vi.fn()}
        onCopyText={vi.fn()}
        postUrl="https://x.com/alice/status/123"
        onCopyLink={copyLink}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy post link" }));
    expect(copyLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("requires confirmation before removing a bookmark", async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <PostActions
        read={false}
        onToggleRead={vi.fn()}
        onHide={vi.fn()}
        onCopyText={vi.fn()}
        isBookmark
        onRemoveBookmark={remove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from bookmarks" }),
    );
    expect(remove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Remove this bookmark from X?" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove from X bookmarks" }),
    );
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("keeps the removal dialog open and shows the backend repair on failure", async () => {
    const user = userEvent.setup();
    const remove = vi
      .fn()
      .mockRejectedValue({
        code: "provider_unavailable",
        message: "X refused the bookmark change.",
        repair: "Reconnect the X session and try again.",
      });
    renderWithProviders(
      <PostActions
        read={false}
        onToggleRead={vi.fn()}
        onHide={vi.fn()}
        onCopyText={vi.fn()}
        isBookmark
        onRemoveBookmark={remove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from bookmarks" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove from X bookmarks" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Reconnect the X session and try again/,
    );
    expect(
      screen.getByRole("heading", { name: "Remove this bookmark from X?" }),
    ).toBeInTheDocument();
  });
});
