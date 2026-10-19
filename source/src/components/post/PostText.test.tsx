import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostText, tokenize } from "./PostText";

const LONG = "x".repeat(500);

describe("tokenize", () => {
  it("splits urls, mentions and hashtags out of plain text", () => {
    const segs = tokenize("hello @alice see https://example.com/a #rust done");
    expect(segs.find((s) => s.kind === "mention")?.value).toBe("@alice");
    expect(segs.find((s) => s.kind === "url")?.value).toBe(
      "https://example.com/a",
    );
    expect(segs.find((s) => s.kind === "tag")?.value).toBe("#rust");
  });

  it("round-trips the original text exactly", () => {
    const input = "a @b c #d e https://f.example g";
    expect(
      tokenize(input)
        .map((s) => s.value)
        .join(""),
    ).toBe(input);
  });

  it("handles text with no entities", () => {
    const segs = tokenize("just words");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("text");
  });
});

describe("PostText", () => {
  it("collapses long posts behind Show more without losing text", async () => {
    const user = userEvent.setup();
    render(<PostText text={LONG} />);

    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    expect(
      screen.getByRole("button", { name: "Show less" }),
    ).toBeInTheDocument();
    // Full text is present once expanded.
    expect(screen.getByText(new RegExp(LONG.slice(0, 60)))).toBeInTheDocument();
  });

  it("does not collapse short posts", () => {
    render(<PostText text="short one" />);
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
  });

  it("respects collapsible=false", () => {
    render(<PostText text={LONG} collapsible={false} />);
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
  });

  it("shows a URL as text, and never as something to click", () => {
    render(<PostText text="see https://example.com/post" />);

    // Still readable — the address is not hidden, it just does not go
    // anywhere. Nothing in the app opens a browser.
    expect(screen.getByText("example.com/post")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "example.com/post" }),
    ).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("hides only the current post's self permalink", () => {
    render(
      <PostText
        text="Read this https://x.com/alice/status/1234567890 and https://example.com/story plus https://x.com/bob/status/9"
        postUrl="https://twitter.com/alice/status/1234567890?s=20"
      />,
    );
    expect(screen.queryByText("x.com/alice/status/1234567890")).toBeNull();
    expect(screen.getByText("example.com/story")).toBeInTheDocument();
    expect(screen.getByText("x.com/bob/status/9")).toBeInTheDocument();
  });

  it("keeps punctuation after a hidden self permalink", () => {
    const { container } = render(
      <PostText
        text="Read https://x.com/alice/status/1234567890, then continue."
        postUrl="https://x.com/alice/status/1234567890"
      />,
    );
    expect(screen.queryByText("x.com/alice/status/1234567890")).toBeNull();
    expect(container.querySelector("p")).toHaveTextContent(
      "Read, then continue.",
    );
  });

  it("opens profiles from mentions", async () => {
    const onOpenProfile = vi.fn();
    const user = userEvent.setup();
    render(
      <PostText text="ping @ml_papers now" onOpenProfile={onOpenProfile} />,
    );

    await user.click(screen.getByRole("button", { name: "@ml_papers" }));
    expect(onOpenProfile).toHaveBeenCalledWith("ml_papers");
  });

  it("marks Arabic text as rtl", () => {
    // `dir` lives on the paragraph; getByText would return the inner span.
    const { container } = render(<PostText text="مرحبا بالعالم" />);
    expect(container.querySelector("p")).toHaveAttribute("dir", "rtl");
  });

  it("marks Latin text as ltr", () => {
    const { container } = render(<PostText text="hello world" />);
    expect(container.querySelector("p")).toHaveAttribute("dir", "ltr");
  });
});
