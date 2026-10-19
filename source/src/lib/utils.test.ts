import { describe, expect, it } from "vitest";
import {
  absoluteTime,
  compactNumber,
  formatBytes,
  isRtlText,
  relativeTime,
} from "./utils";

describe("compactNumber", () => {
  it("leaves small numbers alone", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(999)).toBe("999");
  });

  it("abbreviates thousands and millions", () => {
    expect(compactNumber(1000)).toBe("1K");
    expect(compactNumber(12_300)).toBe("12.3K");
    expect(compactNumber(1_500_000)).toBe("1.5M");
  });

  it("handles missing values", () => {
    expect(compactNumber(undefined)).toBe("0");
    expect(compactNumber(null)).toBe("0");
  });
});

describe("relativeTime", () => {
  it("describes recent times in minutes and hours", () => {
    expect(relativeTime(new Date(Date.now() - 30_000).toISOString())).toBe(
      "now",
    );
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe(
      "5m",
    );
    expect(
      relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString()),
    ).toBe("3h");
    expect(
      relativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString()),
    ).toBe("2d");
  });

  it("returns an empty string for unparseable input", () => {
    expect(relativeTime("not-a-date")).toBe("");
  });
});

describe("absoluteTime", () => {
  it("formats a real timestamp", () => {
    expect(absoluteTime("2026-07-20T10:00:00Z")).toMatch(/2026/);
  });

  it("returns an empty string for junk", () => {
    expect(absoluteTime("nope")).toBe("");
  });
});

describe("isRtlText", () => {
  it("detects Arabic", () => {
    expect(isRtlText("مرحبا")).toBe(true);
  });

  it("does not flag Latin text", () => {
    expect(isRtlText("hello world")).toBe(false);
  });

  it("flags mixed text containing Arabic", () => {
    expect(isRtlText("build مرحبا now")).toBe(true);
  });
});

describe("formatBytes", () => {
  it("formats byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});
