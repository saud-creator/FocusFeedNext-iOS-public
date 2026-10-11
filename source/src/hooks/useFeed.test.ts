import { describe, expect, it } from "vitest";
import { makePost } from "@/test/factories";
import {
  appendFeedResponse,
  cacheLimitForFeed,
  sharePosts,
} from "./useFeed";

describe("bounded feed hydration", () => {
  it("keeps the generic hook bounded for every feed", () => {
    expect(cacheLimitForFeed("bookmarks")).toBe(80);
    expect(cacheLimitForFeed("following")).toBe(80);
  });
});

describe("feed post structural sharing", () => {
  it("keeps the existing object when only engagement counts changed", () => {
    const current = makePost();
    const next = JSON.parse(JSON.stringify(current)) as typeof current;
    next.metrics.likes += 1;

    expect(sharePosts([next], [current])).toEqual([current]);
    expect(sharePosts([next], [current])[0]).toBe(current);
  });

  it("replaces the object when feed-visible content changed", () => {
    const current = makePost();
    const next = JSON.parse(JSON.stringify(current)) as typeof current;
    next.text = "A newer version of the post";

    expect(sharePosts([next], [current])[0]).toBe(next);
  });

  it("appends a continuation delta without duplicating the accumulated page", () => {
    const first = makePost({ id: "first" });
    const older = makePost({ id: "older" });
    const updatedFirst = { ...first, text: "corrected" };
    const previous = {
      posts: [first],
      fromCache: false,
      provider: "twitter-cli",
      readIds: [first.id],
      totalCached: 1,
      nextCursor: "cursor-1",
    };
    const next = {
      posts: [updatedFirst, older],
      fromCache: false,
      provider: "twitter-cli",
      readIds: [older.id],
      totalCached: 2,
      nextCursor: null,
    };

    const merged = appendFeedResponse(previous, next);

    expect(merged.posts.map((post) => post.id)).toEqual(["first", "older"]);
    expect(merged.posts[0]).toBe(updatedFirst);
    expect(merged.readIds).toEqual([first.id, older.id]);
  });
});
