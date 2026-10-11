import { afterEach, describe, expect, it } from "vitest";
import { defaultPreferences, type Preferences } from "@/stores/useAppStore";
import {
  THEME_TOKENS,
  appearanceVariables,
  applyAppearance,
  applyTextContrast,
  contrastRatio,
  contrastWarnings,
  effectiveTokens,
  formatRatio,
  hexToRgb,
  isDarkTheme,
  mixHex,
  resolveTheme,
  rgbToHex,
  startAppearanceSync,
  stopAppearanceSyncForTests,
} from "./theme";

const prefs = (over: Partial<Preferences> = {}): Preferences => ({
  ...defaultPreferences,
  ...over,
});

afterEach(() => {
  stopAppearanceSyncForTests();
});

describe("colour parsing", () => {
  it("accepts both hex forms and rejects everything else", () => {
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#0a0b10")).toEqual([10, 11, 16]);
    // The store's guarantee, re-checked on the way out to CSS.
    expect(hexToRgb("red")).toBeNull();
    expect(hexToRgb("")).toBeNull();
    expect(hexToRgb("#fff; background: url(x)")).toBeNull();
    expect(hexToRgb("var(--accent)")).toBeNull();
  });

  it("round-trips through rgb", () => {
    expect(rgbToHex([10, 11, 16])).toBe("#0a0b10");
    expect(rgbToHex([300, -4, 7])).toBe("#ff0007");
  });

  it("mixes toward the target and clamps the amount", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 5)).toBe("#ffffff");
    // An unparseable operand yields the original rather than garbage.
    expect(mixHex("#000000", "rgb(1,2,3)", 0.5)).toBe("#000000");
  });
});

describe("contrast", () => {
  it("matches the WCAG extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
  });

  it("returns a neutral 1 for an unreadable operand instead of throwing", () => {
    expect(contrastRatio("#000000", "not a colour")).toBe(1);
  });

  it("prints one decimal", () => {
    expect(formatRatio(4.44)).toBe("4.4");
    expect(formatRatio(21)).toBe("21.0");
  });
});

describe("built-in themes", () => {
  it("keeps body text at AA on every theme's background and surface", () => {
    for (const theme of ["dark", "oled", "light"] as const) {
      const t = THEME_TOKENS[theme];
      expect(
        contrastRatio(t.text, t.background),
        `${theme}: text on background`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(t.text, t.surface),
        `${theme}: text on surface`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("ships no theme that a reader could not read", () => {
    for (const theme of ["dark", "oled", "light"] as const) {
      expect(contrastWarnings(prefs(), theme), theme).toEqual([]);
    }
  });

  it("keeps OLED surfaces visibly separate from a near-black background", () => {
    const t = THEME_TOKENS.oled;
    // Near-black, not black: the page is almost off but the cards are still
    // cards. Both halves of that sentence are asserted.
    expect(contrastRatio(t.background, "#000000")).toBeLessThan(1.2);
    expect(t.background).not.toBe(t.surface);
    expect(contrastRatio(t.surface, t.background)).toBeGreaterThan(1.12);
    expect(contrastRatio(t.elevated, t.surface)).toBeGreaterThan(1.1);
    expect(contrastRatio(t.border, t.surface)).toBeGreaterThan(1.25);
    expect(t.mediaBackground).toBe("#000000");
  });

  it("resolves system against the OS and leaves the rest alone", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("oled", false)).toBe("oled");
    expect(resolveTheme("light", true)).toBe("light");
    expect(isDarkTheme("oled")).toBe(true);
    expect(isDarkTheme("light")).toBe(false);
  });
});

describe("custom colours", () => {
  it("uses the theme value when a colour is unset", () => {
    const t = effectiveTokens(prefs(), "dark");
    expect(t.background).toBe(THEME_TOKENS.dark.background);
    expect(t.accent).toBe(THEME_TOKENS.dark.accent);
  });

  it("applies a valid custom colour", () => {
    const t = effectiveTokens(prefs({ background: "#123456" }), "dark");
    expect(t.background).toBe("#123456");
  });

  it("ignores a colour that is not a hex triple", () => {
    // The one thing this file must never do is hand a raw string to CSS.
    const hostile = "#fff; background-image: url(https://x/track.png)";
    const t = effectiveTokens(prefs({ background: hostile }), "dark");
    expect(t.background).toBe(THEME_TOKENS.dark.background);

    const vars = appearanceVariables(prefs({ accent: hostile }), "dark");
    for (const value of Object.values(vars)) {
      expect(value).not.toContain("url(");
      expect(value).not.toContain(";");
    }
  });

  it("emits every colour variable as a hex triple", () => {
    const vars = appearanceVariables(
      prefs({ background: "#101010", surface: "#202020", accent: "#3b82f6" }),
      "dark",
    );
    for (const [name, value] of Object.entries(vars)) {
      if (!name.startsWith("--surface") && !name.startsWith("--text")) continue;
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("moves text toward white above the midpoint and toward the page below it", () => {
    const base = THEME_TOKENS.dark.text;
    const bg = THEME_TOKENS.dark.background;
    expect(applyTextContrast(base, bg, 50, true)).toBe(base);
    expect(
      contrastRatio(applyTextContrast(base, bg, 100, true), bg),
    ).toBeGreaterThan(contrastRatio(base, bg));
    expect(
      contrastRatio(applyTextContrast(base, bg, 0, true), bg),
    ).toBeLessThan(contrastRatio(base, bg));
  });

  it("warns about an unreadable combination without refusing it", () => {
    const warnings = contrastWarnings(
      prefs({ background: "#101219", surface: "#121319", border: "#121319" }),
      "dark",
    );
    const ids = warnings.map((w) => w.id);
    expect(ids).toContain("surfaceFlat");
    expect(ids).toContain("borderInvisible");
    // Worst first, so the sentence at the top is the one that matters most.
    expect(warnings[0].ratio).toBeLessThanOrEqual(warnings[1].ratio);
  });

  it("flags text the reader has faded into the background", () => {
    const ids = contrastWarnings(prefs({ textContrast: 0 }), "dark").map(
      (w) => w.id,
    );
    expect(ids).toContain("textOnBackground");
  });
});

describe("applyAppearance", () => {
  it("paints the resolved theme, density and every variable", () => {
    const root = document.createElement("div");
    const resolved = applyAppearance(
      root,
      prefs({ theme: "system", density: "compact", radius: 4, shadow: "none" }),
      false,
    );
    expect(resolved).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.shadow).toBe("none");
    expect(root.style.getPropertyValue("--radius")).toBe("4px");
    expect(root.style.getPropertyValue("--shadow-card")).toBe("none");
    expect(root.style.getPropertyValue("--surface-0")).toBe(
      THEME_TOKENS.light.background,
    );
  });

  it("clamps a radius from a hand-edited preferences file", () => {
    const root = document.createElement("div");
    applyAppearance(root, prefs({ radius: 9999 }), true);
    expect(root.style.getPropertyValue("--radius")).toBe("24px");
    applyAppearance(root, prefs({ radius: -8 }), true);
    expect(root.style.getPropertyValue("--radius")).toBe("0px");
  });
});

describe("startAppearanceSync", () => {
  /** A minimal stand-in for the store: same shape, no zustand. */
  function fakeStore(initial: { prefs: Preferences; draft: Preferences | null }) {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
      getState: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      set(next: Partial<typeof state>) {
        state = { ...state, ...next };
        for (const l of listeners) l();
      },
    };
  }

  it("paints the draft while editing and the saved value after cancel", () => {
    const root = document.createElement("div");
    const store = fakeStore({ prefs: prefs(), draft: null });
    startAppearanceSync(store, root);
    expect(root.style.getPropertyValue("--surface-0")).toBe(
      THEME_TOKENS.dark.background,
    );

    // Live preview: an unsaved draft repaints immediately.
    store.set({ draft: prefs({ background: "#222244" }) });
    expect(root.style.getPropertyValue("--surface-0")).toBe("#222244");

    // Cancel drops the draft, and the saved appearance comes back with no
    // separate "restore" path to get out of step.
    store.set({ draft: null });
    expect(root.style.getPropertyValue("--surface-0")).toBe(
      THEME_TOKENS.dark.background,
    );
  });

  it("subscribes exactly once however many callers start it", () => {
    const root = document.createElement("div");
    const store = fakeStore({ prefs: prefs(), draft: null });
    startAppearanceSync(store, root);
    startAppearanceSync(store, root);
    startAppearanceSync(store, root);

    store.set({ prefs: prefs({ theme: "oled" }) });
    expect(root.dataset.theme).toBe("oled");
    expect(root.style.getPropertyValue("--surface-0")).toBe(
      THEME_TOKENS.oled.background,
    );
  });
});
