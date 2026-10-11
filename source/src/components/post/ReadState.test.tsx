import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { PostCard } from "./PostCard";
import { ReadStateIndicator } from "./ReadStateIndicator";
import { makePost, renderWithProviders } from "@/test/factories";

/**
 * Read state must be a mark, never a mood.
 *
 * These assert the *absence* of the 0.2.0 treatment as much as the presence of
 * the new one, because "the card looks disabled once you have read it" is a
 * regression that reappears the moment somebody reaches for opacity again.
 */
describe("read state does not darken the card", () => {
  /**
   * A class token that dims unconditionally. Variant-prefixed utilities such as
   * `disabled:opacity-50` or `group-hover:opacity-100` are excluded on purpose:
   * those are a genuinely different state doing its own job, and the defect
   * being guarded here is dimming that applies simply because a post was read.
   */
  const dims = (className: string): boolean =>
    className
      .split(/\s+/)
      .filter((token) => token !== "" && !token.includes(":"))
      .some((token) => /^-?(opacity-|brightness-|grayscale|saturate-0)/.test(token));

  it("gives a read card exactly the classes an unread one has", () => {
    const { rerender } = renderWithProviders(
      <PostCard post={makePost()} read={false} readDwellMs={0} />,
    );
    const unreadClasses = screen.getByTestId("post-card").className;

    rerender(
      <PostCard post={makePost()} read readDwellMs={0} />,
    );
    expect(screen.getByTestId("post-card").className).toBe(unreadClasses);
  });

  it("never applies a dimming utility to a read card", () => {
    renderWithProviders(
      <PostCard post={makePost()} read readDwellMs={0} />,
    );
    const card = screen.getByTestId("post-card");
    expect(dims(card.className)).toBe(false);
    // Nor via an inline style, which is how a "quick fix" usually comes back.
    expect(card.style.opacity).toBe("");
    expect(card.style.filter).toBe("");
  });

  it("does not dim the media, the text or the action bar of a read card", () => {
    renderWithProviders(
      <PostCard post={makePost()} read readDwellMs={0} />,
    );
    const card = screen.getByTestId("post-card");
    // The read *mark* itself is allowed to be muted; nothing else is. Anything
    // carrying a dimming class must be inside the indicator.
    for (const node of card.querySelectorAll<HTMLElement>("*")) {
      if (node.closest('[data-testid="read-state"]')) continue;
      expect(dims(node.className.toString())).toBe(false);
      expect(node.style.opacity).toBe("");
      expect(node.style.filter).toBe("");
    }
  });

  it("renders a read card structurally identical to an unread one, mark aside", () => {
    // The sharpest form of the rule: reading a post may change the mark and
    // the action-bar label, and nothing else about how the card is painted.
    const classesOf = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<HTMLElement>("*"))
        .filter((n) => !n.closest('[data-testid="read-state"]'))
        .filter((n) => !n.closest('[data-testid="post-actions"]'))
        .map((n) => n.className.toString());

    const { rerender } = renderWithProviders(
      <PostCard post={makePost()} read={false} readDwellMs={0} />,
    );
    const unread = classesOf(screen.getByTestId("post-card"));

    rerender(<PostCard post={makePost()} read readDwellMs={0} />);
    expect(classesOf(screen.getByTestId("post-card"))).toEqual(unread);
  });

  it("carries the logical read flag as data, so filters never read pixels", () => {
    const { rerender } = renderWithProviders(
      <PostCard post={makePost()} read={false} readDwellMs={0} />,
    );
    expect(screen.getByTestId("post-card")).toHaveAttribute(
      "data-read",
      "false",
    );
    rerender(
      <PostCard post={makePost()} read readDwellMs={0} />,
    );
    expect(screen.getByTestId("post-card")).toHaveAttribute("data-read", "true");
  });

  it("marks a read card with a check rather than a dark overlay", () => {
    renderWithProviders(<ReadStateIndicator read />);
    const mark = screen.getByTestId("read-state");
    expect(mark).toHaveAttribute("aria-label", "Read");
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("marks an unread card with a dot and no label", () => {
    renderWithProviders(<ReadStateIndicator read={false} />);
    const mark = screen.getByTestId("read-state");
    expect(mark).toHaveAttribute("aria-label", "Unread");
    expect(mark.querySelector("svg")).toBeNull();
  });

  it("drops the word but keeps the mark in compact rows", () => {
    renderWithProviders(<ReadStateIndicator read compact />);
    expect(screen.getByTestId("read-state").querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
  });

  it("localises the state rather than hardcoding English", () => {
    renderWithProviders(<ReadStateIndicator read />, { locale: "ar" });
    expect(screen.getByTestId("read-state").getAttribute("aria-label")).not.toBe(
      "Read",
    );
  });
});
