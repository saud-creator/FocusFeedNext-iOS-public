import { describe, expect, it } from "vitest";
import type { PostMedia } from "@/lib/api";
import {
  compactQualityLabel,
  hasQualityChoice,
  heightFromLabel,
  qualityLabel,
  qualityOptions,
  resolveQualityIndex,
} from "./quality";

function media(over: Partial<PostMedia> = {}): PostMedia {
  return {
    kind: "video",
    url: "https://cdn.example.com/clip.mp4",
    previewUrl: null,
    width: 1280,
    height: 720,
    alt: null,
    durationMs: 12_000,
    variants: [],
    ...over,
  };
}

/**
 * The honesty contract.
 *
 * The provider publishes one MP4 per video and no variant list at all, so the
 * only correct menu today is one that does not pretend to be a menu.
 */
describe("quality options are only ever the sources that exist", () => {
  it("reports exactly one option for live-shaped media", () => {
    const options = qualityOptions(media());
    expect(options).toHaveLength(1);
    expect(options[0].url).toBe("https://cdn.example.com/clip.mp4");
    expect(hasQualityChoice(options)).toBe(false);
  });

  it("names that single option 'best available' rather than a resolution", () => {
    const options = qualityOptions(media());
    // Crucially not { kind: "text", text: "1080p" }: nothing in the payload
    // says what resolution this is, and the width/height of the *post media*
    // is not a claim about the stream that would be chosen.
    expect(qualityLabel(options[0], 0)).toEqual({ kind: "best" });
  });

  it("keeps a labelled variant's own words", () => {
    const options = qualityOptions(
      media({
        url: "",
        variants: [
          {
            label: "1280x720",
            url: "https://cdn.example.com/720.mp4",
            bitrate: 2_000_000,
          },
          {
            label: "640x360",
            url: "https://cdn.example.com/360.mp4",
            bitrate: 500_000,
          },
        ],
      }),
    );
    expect(options.map((o) => o.label)).toEqual(["1280x720", "640x360"]);
    expect(options.map((o) => o.height)).toEqual([720, 360]);
    expect(hasQualityChoice(options)).toBe(true);
    expect(qualityLabel(options[0], 0)).toEqual({
      kind: "text",
      text: "1280x720",
    });
  });

  it("ranks a higher-resolution variant above a lower primary URL", () => {
    const options = qualityOptions(
      media({
        url: "https://cdn.example.com/360.mp4",
        width: 640,
        height: 360,
        variants: [
          {
            label: "1920x1080",
            url: "https://cdn.example.com/1080.mp4",
            bitrate: 1_800_000,
          },
          {
            label: "640x360",
            url: "https://cdn.example.com/360-variant.mp4",
            bitrate: 500_000,
          },
        ],
      }),
    );

    expect(options[0].url).toContain("1080.mp4");
    expect(options[0].height).toBe(1080);
    expect(resolveQualityIndex(options, "best")).toBe(0);
  });

  it("falls back to a bitrate for an unlabelled alternative", () => {
    const options = qualityOptions(
      media({
        variants: [
          {
            label: "",
            url: "https://cdn.example.com/low.mp4",
            bitrate: 832_000,
          },
        ],
      }),
    );
    expect(options).toHaveLength(2);
    expect(qualityLabel(options[1], 1)).toEqual({ kind: "bitrate", kbps: 832 });
  });

  it("identifies a nameless, rateless source by position, not by invention", () => {
    const options = qualityOptions(
      media({
        variants: [
          {
            label: "",
            url: "https://cdn.example.com/other.mp4",
            bitrate: null,
          },
        ],
      }),
    );
    expect(qualityLabel(options[1], 1)).toEqual({ kind: "text", text: "#2" });
  });

  it("drops undecodable and duplicate sources before they reach the menu", () => {
    const options = qualityOptions(
      media({
        url: "https://cdn.example.com/clip.mp4",
        variants: [
          // The same stream again, a playlist the view cannot decode, and an
          // empty entry: none of them is another quality.
          {
            label: "dupe",
            url: "https://cdn.example.com/clip.mp4",
            bitrate: 1,
          },
          {
            label: "hls",
            url: "https://cdn.example.com/clip.m3u8",
            bitrate: 9,
          },
          { label: "empty", url: "", bitrate: null },
        ],
      }),
    );
    expect(options).toHaveLength(1);
    expect(hasQualityChoice(options)).toBe(false);
  });
});

describe("heightFromLabel", () => {
  it("reads the vertical size out of a dimension pair", () => {
    expect(heightFromLabel("1280x720")).toBe(720);
    expect(heightFromLabel("1920×1080")).toBe(1080);
  });

  it("reads a 720p style label", () => {
    expect(heightFromLabel("720p")).toBe(720);
  });

  it("returns null rather than guessing", () => {
    expect(heightFromLabel("")).toBeNull();
    expect(heightFromLabel("Auto")).toBeNull();
    expect(heightFromLabel("high")).toBeNull();
  });
});

describe("compactQualityLabel", () => {
  it("shortens a known dimension to a small p-style indicator", () => {
    expect(
      compactQualityLabel(
        {
          url: "https://cdn.example.com/720.mp4",
          label: "1280x720",
          bitrate: 2_000_000,
          height: 720,
        },
        0,
      ),
    ).toEqual({ kind: "text", text: "720p" });
  });

  it("keeps an unknown stream honest", () => {
    expect(compactQualityLabel(undefined, 0)).toEqual({ kind: "best" });
  });
});

describe("resolveQualityIndex", () => {
  const options = qualityOptions(
    media({
      url: "",
      variants: [
        {
          label: "1920x1080",
          url: "https://cdn.example.com/1080.mp4",
          bitrate: 4_000_000,
        },
        {
          label: "1280x720",
          url: "https://cdn.example.com/720.mp4",
          bitrate: 2_000_000,
        },
        {
          label: "640x360",
          url: "https://cdn.example.com/360.mp4",
          bitrate: 500_000,
        },
      ],
    }),
  );

  it("resolves 'best' to the highest genuine variant", () => {
    expect(resolveQualityIndex(options, "best")).toBe(0);
    expect(options[0].height).toBe(1080);
  });

  it("honours an exact stored height", () => {
    expect(resolveQualityIndex(options, "720")).toBe(1);
    expect(resolveQualityIndex(options, "360")).toBe(2);
  });

  it("steps down to the nearest available height", () => {
    expect(resolveQualityIndex(options, "480")).toBe(2);
  });

  it("plays the one stream that exists rather than nothing", () => {
    const single = qualityOptions(media());
    expect(resolveQualityIndex(single, "360")).toBe(0);
    expect(resolveQualityIndex([], "best")).toBe(0);
  });
});
