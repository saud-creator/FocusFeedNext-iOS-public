import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAppStore } from "@/stores/useAppStore";
import { makeAuthor, makeQuoted, renderWithProviders } from "@/test/factories";
import {
  AccountIdentity,
  cleanHandle,
  handleKey,
} from "./AccountIdentity";
import { AuthorHeader } from "@/components/post/AuthorHeader";
import { QuotedPostCard } from "@/components/post/QuotedPostCard";

const REEM = makeAuthor({
  id: "a1",
  username: "reem_codes",
  displayName: "Reem",
  verified: false,
});

function resetStore() {
  useAppStore.setState({ route: "following", profileUsername: null, history: [] });
}

beforeEach(resetStore);

describe("handle helpers", () => {
  it("strips a leading @ and surrounding space", () => {
    expect(cleanHandle("  @Reem_Codes ")).toBe("Reem_Codes");
    expect(cleanHandle("reem")).toBe("reem");
    expect(cleanHandle("@@reem")).toBe("reem");
  });

  it("compares handles case-insensitively without the @", () => {
    expect(handleKey("@Reem_Codes")).toBe("reem_codes");
    expect(handleKey("reem_codes")).toBe(handleKey("@REEM_CODES"));
  });
});

describe("AccountIdentity", () => {
  it("makes the avatar, the display name and the handle all clickable", () => {
    renderWithProviders(<AccountIdentity account={REEM} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    // Every one of them must announce itself as something.
    for (const b of buttons) {
      const name = b.getAttribute("aria-label") ?? b.textContent ?? "";
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it("opens the internal profile from the display name", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AccountIdentity account={REEM} onOpenProfile={onOpenProfile} />,
    );
    await user.click(screen.getByText("Reem"));
    expect(onOpenProfile).toHaveBeenCalledWith("reem_codes");
  });

  it("opens the internal profile from the handle", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AccountIdentity account={REEM} onOpenProfile={onOpenProfile} />,
    );
    await user.click(screen.getByText("@reem_codes"));
    expect(onOpenProfile).toHaveBeenCalledWith("reem_codes");
  });

  it("opens the internal profile from the avatar", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AccountIdentity account={REEM} onOpenProfile={onOpenProfile} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Open the profile of Reem" }),
    );
    expect(onOpenProfile).toHaveBeenCalledWith("reem_codes");
  });

  it("responds to Enter and to Space, not only to a mouse", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AccountIdentity account={REEM} onOpenProfile={onOpenProfile} />,
    );
    const name = screen.getByText("Reem");
    name.focus();
    await user.keyboard("{Enter}");
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onOpenProfile).toHaveBeenCalledTimes(2);
  });

  it("reaches every trigger by keyboard", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AccountIdentity account={REEM} />);
    const buttons = screen.getAllByRole("button");
    for (const button of buttons) {
      await user.tab();
      expect(button).toHaveFocus();
    }
  });

  it("never triggers the surrounding card's action", async () => {
    // The whole point of stopPropagation: opening a profile from inside a post
    // must not also run whatever the card does when clicked.
    const cardClick = vi.fn();
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <div onClick={cardClick}>
        <AccountIdentity account={REEM} onOpenProfile={onOpenProfile} />
      </div>,
    );
    await user.click(screen.getByText("Reem"));
    await user.click(screen.getByText("@reem_codes"));
    expect(onOpenProfile).toHaveBeenCalledTimes(2);
    expect(cardClick).not.toHaveBeenCalled();
  });

  it("nests no interactive element inside another", () => {
    // Invalid HTML, and it makes the inner control unreachable by keyboard.
    const { container } = renderWithProviders(
      <AccountIdentity account={REEM} />,
    );
    expect(container.querySelectorAll("button button")).toHaveLength(0);
    expect(container.querySelectorAll("a button")).toHaveLength(0);
    expect(container.querySelectorAll("button a")).toHaveLength(0);
  });

  it("routes through the store when no handler is supplied", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AccountIdentity account={REEM} />);
    await user.click(screen.getByText("Reem"));
    expect(useAppStore.getState().route).toBe("profile");
    expect(useAppStore.getState().profileUsername).toBe("reem_codes");
    expect(useAppStore.getState().canGoBack()).toBe(true);
  });

  it("normalises a handle that already carries an @", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AccountIdentity
        account={{ username: "@reem_codes", displayName: "Reem" }}
        onOpenProfile={onOpenProfile}
      />,
    );
    // Rendered once, not "@@reem_codes".
    expect(screen.getByText("@reem_codes")).toBeInTheDocument();
    await user.click(screen.getByText("@reem_codes"));
    expect(onOpenProfile).toHaveBeenCalledWith("reem_codes");
  });

  it("does not navigate for an empty handle", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AccountIdentity account={{ username: "@", displayName: "Nobody" }} />,
    );
    await user.click(screen.getByText("Nobody"));
    expect(useAppStore.getState().route).toBe("following");
  });

  it("keeps the handle left-to-right and lets the name follow its own script", () => {
    renderWithProviders(
      <AccountIdentity
        account={{ username: "reem_codes", displayName: "ريم" }}
      />,
    );
    expect(screen.getByText("@reem_codes")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("ريم")).toHaveAttribute("dir", "auto");
  });

  it("falls back to the handle when an account has no display name", () => {
    renderWithProviders(<AccountIdentity account={{ username: "reem_codes" }} />);
    expect(
      screen.getByRole("button", { name: "Open the profile of reem_codes" }),
    ).toBeInTheDocument();
  });

  it("marks a verified account without making the check a control", () => {
    renderWithProviders(
      <AccountIdentity account={{ ...REEM, verified: true }} />,
    );
    const mark = screen.getByLabelText("Verified account");
    expect(mark).toBeInTheDocument();
    expect(mark.tagName).not.toBe("BUTTON");
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("renders plain text when the row itself is the control", async () => {
    // A search suggestion row is one big button; a button inside it would be
    // invalid HTML.
    const rowClick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <button type="button" onClick={rowClick}>
        <AccountIdentity account={REEM} interactive={false} />
      </button>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByText("Reem"));
    expect(rowClick).toHaveBeenCalledTimes(1);
  });

  it("can hide the avatar for headers that render their own", () => {
    const { container } = renderWithProviders(
      <AccountIdentity account={REEM} showAvatar={false} />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});

describe("AuthorHeader adoption", () => {
  it("opens the profile from the author name and handle", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AuthorHeader
        author={REEM}
        createdAt={new Date().toISOString()}
        onOpenProfile={onOpenProfile}
      />,
    );
    await user.click(screen.getByText("Reem"));
    await user.click(screen.getByText("@reem_codes"));
    expect(onOpenProfile).toHaveBeenCalledTimes(2);
    expect(onOpenProfile).toHaveBeenCalledWith("reem_codes");
  });

  it("renders no second avatar of its own", () => {
    const { container } = renderWithProviders(
      <AuthorHeader author={REEM} createdAt={new Date().toISOString()} />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("QuotedPostCard adoption", () => {
  it("opens the quoted author's profile from all three triggers", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    const quoted = makeQuoted();
    renderWithProviders(
      <QuotedPostCard quoted={quoted} onOpenProfile={onOpenProfile} />,
    );
    await user.click(screen.getByText("ML Papers"));
    await user.click(screen.getByText("@ml_papers"));
    await user.click(
      screen.getByRole("button", { name: "Open the profile of ML Papers" }),
    );
    expect(onOpenProfile).toHaveBeenCalledTimes(3);
    for (const call of onOpenProfile.mock.calls) {
      expect(call[0]).toBe("ml_papers");
    }
  });
});
