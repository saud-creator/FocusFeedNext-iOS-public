import { describe, expect, it } from "vitest";
import {
  classifyMediaError,
  isLikelyPlayable,
  isVideoLike,
  playableSources,
  posterFor,
  rankVariants,
  videoErrorKey,
} from "./media";
import { makeImage, makeVideo } from "@/test/factories";

/** The shape twitter-cli 0.8.5 actually returns: one MP4 url, no variants. */
function liveVideo(
  url = "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1280x720/abc.mp4?tag=12",
) {
  return makeVideo({
    url,
    previewUrl: null,
    variants: [],
    durationMs: null,
    width: 1280,
    height: 720,
  });
}

describe("playableSources", () => {
  it("uses the single live URL even though there are no variants", () => {
    // The 0.1.0 player was written against fixtures that had an empty `url`
    // and a populated `variants`. Live data is the exact opposite, which is
    // why every real video failed.
    expect(playableSources(liveVideo())).toEqual([
      "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1280x720/abc.mp4?tag=12",
    ]);
  });

  it("returns nothing when there is no decodable source", () => {
    expect(playableSources(makeVideo({ url: "", variants: [] }))).toEqual([]);
  });

  it("skips an HLS playlist, which WebView2 cannot play natively", () => {
    const m = makeVideo({
      url: "https://video.twimg.com/x/playlist.m3u8",
      variants: [
        {
          label: "720p",
          url: "https://video.twimg.com/x/720.mp4",
          bitrate: 2000000,
        },
      ],
    });
    expect(playableSources(m)).toEqual(["https://video.twimg.com/x/720.mp4"]);
  });

  it("never offers an image as a video source", () => {
    const m = makeVideo({
      url: "https://pbs.twimg.com/media/thumb.jpg",
      variants: [],
    });
    expect(playableSources(m)).toEqual([]);
  });

  it("refuses a non-https source", () => {
    expect(isLikelyPlayable("http://video.twimg.com/a.mp4")).toBe(false);
    expect(isLikelyPlayable("file:///C:/a.mp4")).toBe(false);
    expect(isLikelyPlayable("javascript:alert(1)")).toBe(false);
  });

  it("does not repeat a url that appears twice", () => {
    const url = "https://video.twimg.com/a.mp4";
    const m = makeVideo({ url, variants: [{ label: "hi", url, bitrate: 1 }] });
    expect(playableSources(m)).toEqual([url]);
  });
});

describe("rankVariants", () => {
  const v = (label: string, bitrate: number) => ({
    label,
    url: `https://video.twimg.com/${label}.mp4`,
    bitrate,
  });

  it("prefers the highest bitrate that is not extreme", () => {
    const ranked = rankVariants([
      v("low", 300_000),
      v("high", 2_500_000),
      v("mid", 900_000),
    ]);
    expect(ranked.map((r) => r.label)).toEqual(["high", "mid", "low"]);
  });

  it("puts an unreasonably large variant last rather than first", () => {
    // A 12 Mbps source in a reading column stalls for no visible gain.
    const ranked = rankVariants([v("huge", 12_000_000), v("good", 2_000_000)]);
    expect(ranked[0].label).toBe("good");
    expect(ranked[1].label).toBe("huge");
  });

  it("ignores variants with no url", () => {
    expect(rankVariants([{ label: "broken", url: "", bitrate: 9 }])).toEqual(
      [],
    );
  });

  it("handles a missing bitrate without throwing", () => {
    const ranked = rankVariants([
      { label: "a", url: "https://x.test/a.mp4" },
      v("b", 500_000),
    ]);
    expect(ranked.map((r) => r.label)).toEqual(["b", "a"]);
  });
});

describe("classifyMediaError", () => {
  it("maps every DOM MediaError code to a distinct explanation", () => {
    expect(classifyMediaError(1)).toBe("aborted");
    expect(classifyMediaError(2)).toBe("network");
    expect(classifyMediaError(3)).toBe("decode");
    expect(classifyMediaError(4)).toBe("unsupported");
    expect(classifyMediaError(undefined)).toBe("unknown");
  });

  it("produces a distinct i18n key per kind", () => {
    const keys = [1, 2, 3, 4, undefined].map((c) =>
      videoErrorKey(classifyMediaError(c)),
    );
    expect(new Set(keys).size).toBe(5);
  });
});

describe("posterFor", () => {
  it('accepts a registered local image thumbnail without treating the clip as its poster',()=>{
    const url='http://127.0.0.1:9876/media/'+ 'a'.repeat(32)+'/'+ 'b'.repeat(32);
    expect(posterFor(makeVideo({previewUrl:url}))).toBe(url);
    expect(posterFor(makeVideo({url,previewUrl:url}))).toBeUndefined();
    expect(posterFor(makeVideo({previewUrl:'http://evil.test/photo.jpg'}))).toBeUndefined();
  });
  it("returns a real image poster", () => {
    const m = makeVideo({ previewUrl: "https://pbs.twimg.com/x.jpg" });
    expect(posterFor(m)).toBe("https://pbs.twimg.com/x.jpg");
  });

  it("returns nothing for live video, which carries no thumbnail", () => {
    expect(posterFor(liveVideo())).toBeUndefined();
  });

  it("never uses the video itself as its own poster", () => {
    const m = makeVideo({ previewUrl: "https://video.twimg.com/a.mp4" });
    expect(posterFor(m)).toBeUndefined();
  });
});

describe("isVideoLike", () => {
  it("routes gifs to the video player, because X serves them as MP4", () => {
    // Pointing an <img> at an MP4 renders nothing at all.
    expect(isVideoLike(makeVideo({ kind: "gif" }))).toBe(true);
    expect(isVideoLike(makeVideo({ kind: "video" }))).toBe(true);
    expect(isVideoLike(makeImage())).toBe(false);
  });
});
