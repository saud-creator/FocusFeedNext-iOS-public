import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { canonicalPostUrl, PostCard } from "./PostCard";
import {
  makeAuthor,
  makeImage,
  makePost,
  makeQuoted,
  makeVideo,
  renderWithProviders,
} from "@/test/factories";
import { resetPlayback } from "@/lib/mediaSession";

describe("PostCard", () => {
  beforeEach(() => resetPlayback());
  afterEach(() => resetPlayback());

  it("builds a strict X permalink when the provider omits it", () => {
    expect(
      canonicalPostUrl(
        makePost({
          id: "1234567890",
          author: makeAuthor({ username: "alice" }),
          url: null,
        }),
      ),
    ).toBe("https://x.com/alice/status/1234567890");
  });

  it("does not trust a mismatched provider URL", () => {
    expect(
      canonicalPostUrl(
        makePost({
          id: "1234567890",
          author: makeAuthor({ username: "alice" }),
          url: "https://x.com/other/status/999",
        }),
      ),
    ).toBe("https://x.com/alice/status/1234567890");
  });

  it("renders author, handle and body text", () => {
    renderWithProviders(<PostCard post={makePost()} read={false} />);
    expect(screen.getByText("Rust Daily")).toBeInTheDocument();
    expect(screen.getByText("@rustlang_daily")).toBeInTheDocument();
    expect(screen.getByText(/p99 latency/)).toBeInTheDocument();
  });

  it("updates changed content when a refresh keeps the same post id", () => {
    const view = renderWithProviders(
      <PostCard
        post={makePost({ id: "same", text: "Before refresh" })}
        read={false}
      />,
    );
    view.rerender(
      <PostCard
        post={makePost({ id: "same", text: "After refresh" })}
        read={false}
      />,
    );
    expect(screen.getByText("After refresh")).toBeInTheDocument();
    expect(screen.queryByText("Before refresh")).toBeNull();
  });

  it("renders English text left-to-right", () => {
    const { container } = renderWithProviders(
      <PostCard post={makePost()} read={false} />,
    );
    expect(container.querySelector("p.post-text")).toHaveAttribute(
      "dir",
      "ltr",
    );
  });

  it("renders Arabic text right-to-left", () => {
    const post = makePost({
      text: "أفضل تحسين أجريته هذا الشهر لم يكن في الكود، بل في إغلاق الإشعارات.",
      lang: "ar",
    });
    const { container } = renderWithProviders(
      <PostCard post={post} read={false} />,
    );
    expect(container.querySelector("p.post-text")).toHaveAttribute(
      "dir",
      "rtl",
    );
    expect(screen.getByText(/أفضل تحسين/)).toBeInTheDocument();
  });

  it("shows a repost attribution line", () => {
    const post = makePost({
      isRepost: true,
      repostedBy: makeAuthor({
        id: "u_9",
        displayName: "Tech Wire",
        username: "tech_wire",
      }),
    });
    renderWithProviders(<PostCard post={post} read={false} />);
    expect(screen.getByText(/Tech Wire reposted/)).toBeInTheDocument();
  });

  it("labels promoted posts", () => {
    renderWithProviders(
      <PostCard post={makePost({ isPromoted: true })} read={false} />,
    );
    expect(screen.getByText("Promoted")).toBeInTheDocument();
  });

  it("renders a quoted post as a nested card", () => {
    renderWithProviders(
      <PostCard post={makePost({ quoted: makeQuoted() })} read={false} />,
    );
    expect(screen.getByText("ML Papers")).toBeInTheDocument();
    expect(
      screen.getByText(/original thread being referenced/),
    ).toBeInTheDocument();
  });

  it("renders every image in a multi-image post", () => {
    const post = makePost({
      media: [
        makeImage({ alt: "Before" }),
        makeImage({ alt: "After" }),
        makeImage({ alt: "Third" }),
      ],
    });
    renderWithProviders(<PostCard post={post} read={false} />);
    expect(screen.getAllByRole("button", { name: /Open image/ })).toHaveLength(
      3,
    );
  });

  it("lazy loads images in a bounded feed runway", () => {
    const post = makePost({ media: [makeImage({ alt: "Chart" })] });
    const { container } = renderWithProviders(
      <PostCard post={post} read={false} />,
    );
    const img = container.querySelector('img[alt="Chart"]');
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("keeps the avatar pinned to the top of the card", () => {
    // Without self-start the button stretches to full card height and Chromium
    // centres its content, so the avatar floats beside the media instead of
    // sitting next to the author name.
    const post = makePost({ media: [makeImage(), makeImage()] });
    const { container } = renderWithProviders(
      <PostCard post={post} read={false} />,
    );
    const avatarBtn = container.querySelector(
      'button[aria-label="Open Rust Daily\'s profile"]',
    );
    expect(avatarBtn).not.toBeNull();
    expect(avatarBtn?.className).toContain("self-start");
  });

  it("blames the local service, not the post, when the source was stripped", () => {
    // An empty url on a video now has one specific meaning: the Rust side
    // cleared it because the loopback media proxy is not running. Saying
    // "preview only" there would blame the post for a local failure — and
    // would leave the reader with no idea that restarting fixes it.
    const post = makePost({ media: [makeVideo()] });
    renderWithProviders(<PostCard post={post} read={false} />);
    expect(
      screen.getByText("Video is unavailable this session."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/local video service could not start/i),
    ).toBeInTheDocument();
  });

  it("still says preview only when the source exists but cannot be decoded", () => {
    // An HLS playlist is a real, non-empty source that WebView2 cannot play
    // without a JavaScript player this app does not ship. That is a genuine
    // "preview only", and it must stay distinguishable from the case above.
    const post = makePost({
      media: [
        makeVideo({
          url: "https://video.twimg.com/hls/playlist.m3u8",
          variants: [],
        }),
      ],
    });
    renderWithProviders(<PostCard post={post} read={false} />);
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getByText(/no playable video stream/i)).toBeInTheDocument();
  });

  it("routes a proxied video URL into a real player", () => {
    // The production shape after the Rust rewrite: loopback, opaque id, and
    // no trace of the CDN.
    const post = makePost({
      media: [
        makeVideo({
          url: "http://127.0.0.1:51234/media/abcdef012345/9876543210abcdef",
          variants: [],
          previewUrl: null,
        }),
      ],
    });
    const { container } = renderWithProviders(
      <PostCard post={post} read={false} />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("preload")).toBe("auto");
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(container.innerHTML).not.toContain("twimg.com");
  });

  it("plays a real video, which carries a url and no variants at all", () => {
    // The live shape. 0.1.0 rendered "Preview only" for every one of these
    // because it required a variant list that live data never contains.
    const post = makePost({
      media: [
        makeVideo({
          url: "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1280x720/a.mp4?tag=12",
          variants: [],
          previewUrl: null,
        }),
      ],
    });
    const { container } = renderWithProviders(
      <PostCard post={post} read={false} />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toContain("video.twimg.com");
    // The one-player budget may give this card the active slot (auto) or leave
    // it as a cheap nearby candidate while another card owns playback
    // (metadata). It must never eagerly fetch an unbounded feed of videos.
    expect(["auto", "metadata"]).toContain(video?.getAttribute("preload"));
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(screen.queryByText("Preview only")).not.toBeInTheDocument();
  });

  it("routes an animated GIF to the video player, because X serves MP4", () => {
    const post = makePost({
      media: [
        makeVideo({
          kind: "gif",
          url: "https://video.twimg.com/tweet_video/abc.mp4",
          variants: [],
        }),
      ],
    });
    const { container } = renderWithProviders(
      <PostCard post={post} read={false} />,
    );
    expect(container.querySelector("video")).not.toBeNull();
    // An <img> pointed at an MP4 renders nothing at all.
    expect(container.querySelector('img[src$=".mp4"]')).toBeNull();
  });

  it("shows an article header for long-form posts", () => {
    const post = makePost({
      isArticle: true,
      articleTitle: "Rewriting our storage layer",
    });
    renderWithProviders(<PostCard post={post} read={false} />);
    expect(screen.getByText("Rewriting our storage layer")).toBeInTheDocument();
    expect(screen.getByText("Article")).toBeInTheDocument();
  });

  it("exposes unread and read state", () => {
    const { rerender } = renderWithProviders(
      <PostCard post={makePost()} read={false} />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Unread");
    rerender(<PostCard post={makePost()} read />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Read");
  });

  it("toggles read state from the action bar", async () => {
    const onMarkRead = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PostCard
        post={makePost()}
        read={false}
        readDwellMs={0}
        onMarkRead={onMarkRead}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mark as read" }));
    expect(onMarkRead).toHaveBeenCalledWith("p_1", true);
  });

  it("offers no Save control, because there is no local library", () => {
    // Bookmarks on X remain the reader's saved list. A second, private one
    // that only this machine could see was a question the app kept asking:
    // "did I save this here, or there?"
    renderWithProviders(<PostCard post={makePost()} read={false} />);
    expect(screen.queryByRole("button", { name: /library/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("never renders a like, repost, reply or follow control", () => {
    const { container } = renderWithProviders(
      <PostCard post={makePost()} read={false} />,
    );
    const labels = [...container.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent ?? "",
    );
    for (const forbidden of ["Like", "Repost", "Reply", "Follow", "Retweet"]) {
      expect(
        labels.some((l) => l.toLowerCase().includes(forbidden.toLowerCase())),
      ).toBe(false);
    }
  });

  it("shows no engagement figure at all", () => {
    // Not a preference any more. The factory post carries 240 likes, 12
    // reposts, 4 replies, 2 quotes and 9,800 views; none of them, in any
    // formatting, may reach the card.
    const { container } = renderWithProviders(
      <PostCard post={makePost()} read={false} />,
    );
    const text = container.textContent ?? "";
    for (const figure of ["240", "12", "9,800", "9.8K", "9800"]) {
      expect(text).not.toContain(figure);
    }
    expect(
      screen.queryByTitle(/likes|reposts|replies|views|quotes/),
    ).toBeNull();
  });

  it("renders absolute timestamps when configured", () => {
    const card = renderWithProviders(
      <PostCard post={makePost()} read={false} timestampStyle="absolute" />,
    );
    const time = card.container.querySelector("time");
    // Relative style would be "10m"; absolute contains a year.
    expect(time?.textContent).toMatch(/\d{4}/);
  });
});

describe("PostCard media gallery", () => {
  it("opens the lightbox when an image is clicked", async () => {
    const user = userEvent.setup();
    const post = makePost({ media: [makeImage({ alt: "Chart" })] });
    renderWithProviders(<PostCard post={post} read={false} />);

    expect(screen.queryByTestId("lightbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Open image/ }));

    const lightbox = screen.getByTestId("lightbox");
    expect(lightbox).toBeInTheDocument();
    expect(
      within(lightbox).getByRole("button", { name: "Zoom in" }),
    ).toBeInTheDocument();
  });
});
