/**
 * Appearance: themes, custom colours, and the contrast checks that keep a
 * hand-picked palette readable.
 *
 * Two rules shape this file.
 *
 * 1. **No raw string ever reaches CSS.** Every colour is parsed to three
 *    channels and re-emitted as `#rrggbb` before it is written to a custom
 *    property. `coerceColor` in the store rejects anything that is not a hex
 *    triple on the way in; this file re-checks on the way out, so a preferences
 *    file edited by hand cannot smuggle a value into a style declaration.
 * 2. **The draft paints, the saved value persists.** `applyAppearance` is a
 *    pure function of whatever preference object it is handed, so the Settings
 *    page can paint the in-progress draft and put the saved one back on Cancel
 *    without a special preview code path.
 */
import {
  coerceColor,
  defaultPreferences,
  type Preferences,
  type ShadowIntensity,
  type ThemeId,
} from "@/stores/useAppStore";

/** A theme that names actual colours. `system` resolves to one of these. */
export type ResolvedTheme = "dark" | "oled" | "light";

export const RESOLVED_THEMES = ["dark", "oled", "light"] as const;

/**
 * The colours each built-in theme starts from.
 *
 * This mirrors the `:root` / `[data-theme=…]` blocks in `index.css`. The
 * duplication is deliberate: CSS paints, and this copy is what the contrast
 * checker reasons about, because a stylesheet cannot be asked whether it is
 * readable.
 */
export interface ThemeTokens {
  background: string;
  surface: string;
  elevated: string;
  border: string;
  accent: string;
  text: string;
  textDim: string;
  mediaBackground: string;
}

export const THEME_TOKENS: Record<ResolvedTheme, ThemeTokens> = {
  dark: {
    background: "#0a0b10",
    surface: "#161a26",
    elevated: "#1e2333",
    // Lifted from #232838, which measured 1.18 against the card it outlines —
    // a border nobody could see on a laptop panel in daylight.
    border: "#262c40",
    accent: "#6d72f6",
    text: "#e9ebf4",
    textDim: "#a6adc4",
    mediaBackground: "#05060a",
  },
  // Near-black, not black. The panels stay a step above the background so a
  // card still reads as a card; an OLED theme that paints every surface
  // #000000 saves power by deleting the layout.
  oled: {
    background: "#050507",
    surface: "#151824",
    elevated: "#202434",
    border: "#2c3044",
    accent: "#8186ff",
    text: "#f1f3fa",
    textDim: "#aab1c7",
    mediaBackground: "#000000",
  },
  light: {
    background: "#f6f7fb",
    surface: "#ffffff",
    elevated: "#eef0f7",
    border: "#dfe3ee",
    accent: "#4f46e5",
    text: "#14161f",
    textDim: "#4b5164",
    mediaBackground: "#e6e9f2",
  },
};

/** Whether a resolved theme paints light text on dark surfaces. */
export function isDarkTheme(theme: ResolvedTheme): boolean {
  return theme !== "light";
}

/**
 * Turn the stored theme id into one that names colours.
 *
 * `system` asks the OS. Everything else is already an answer.
 */
export function resolveTheme(theme: ThemeId, prefersDark = true): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/** Does the OS ask for a dark interface? Defaults to yes off-browser. */
export function prefersDarkScheme(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return !window.matchMedia("(prefers-color-scheme: light)").matches;
}

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

/** Parse `#rgb` / `#rrggbb`. Anything else — including `""` — is `null`. */
export function hexToRgb(hex: string): Rgb | null {
  if (coerceColor(hex) !== hex || hex === "") return null;
  const body = hex.slice(1);
  const full =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => clampChannel(c).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear blend: `amount` 0 keeps `a`, 1 becomes `b`. */
export function mixHex(a: string, b: string, amount: number): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  if (!from || !to) return a;
  const k = Math.max(0, Math.min(1, amount));
  return rgbToHex([
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k,
    from[2] + (to[2] - from[2]) * k,
  ]);
}

/** WCAG relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio, 1 (identical) to 21 (black on white).
 *
 * Returns 1 for an unparseable pair rather than throwing: a colour this file
 * cannot read is a colour it never wrote, and a caller checking readability
 * should not crash the Settings page over it.
 */
export function contrastRatio(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 1;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Effective palette
// ---------------------------------------------------------------------------

/**
 * The colours a preference set actually produces: the theme's own, with each
 * custom colour applied where the reader set one.
 *
 * An empty string means "this theme decides", which is why every field is read
 * through `pick` rather than spread.
 */
export function effectiveTokens(
  prefs: Preferences,
  theme: ResolvedTheme,
): ThemeTokens {
  const base = THEME_TOKENS[theme];
  const pick = (value: string, fallback: string): string => {
    const safe = coerceColor(value);
    return safe ? safe : fallback;
  };
  const background = pick(prefs.background, base.background);
  const text = applyTextContrast(
    pick("", base.text),
    background,
    prefs.textContrast,
    isDarkTheme(theme),
  );
  return {
    background,
    surface: pick(prefs.surface, base.surface),
    elevated: pick(prefs.elevated, base.elevated),
    border: pick(prefs.border, base.border),
    accent: pick(prefs.accent, base.accent),
    text,
    textDim: mixHex(text, background, 0.34),
    mediaBackground: pick(prefs.mediaBackground, base.mediaBackground),
  };
}

/**
 * Bend body text toward or away from the background.
 *
 * 50 is the theme as designed. Above it the text walks toward white (or black,
 * on a light theme); below it, toward the background. The scale is deliberately
 * not symmetric in effect — losing contrast is capped well short of invisible,
 * because the slider is a comfort control, not a way to erase the interface.
 */
export function applyTextContrast(
  text: string,
  background: string,
  contrast: number,
  dark: boolean,
): string {
  const value = Math.max(0, Math.min(100, contrast));
  if (value === 50) return text;
  if (value > 50) {
    return mixHex(text, dark ? "#ffffff" : "#000000", (value - 50) / 50);
  }
  return mixHex(text, background, ((50 - value) / 50) * 0.55);
}

// ---------------------------------------------------------------------------
// CSS custom properties
// ---------------------------------------------------------------------------

const SHADOWS: Record<ShadowIntensity, string> = {
  none: "none",
  soft: "0 1px 2px rgba(0,0,0,0.28), 0 8px 24px -12px rgba(0,0,0,0.45)",
  strong: "0 2px 6px rgba(0,0,0,0.4), 0 18px 40px -16px rgba(0,0,0,0.65)",
};

/**
 * Every custom property an appearance produces, as plain strings.
 *
 * Split out from `applyAppearance` so a test can assert the values without a
 * DOM, and so the Settings preview swatches can render the same palette the
 * document will get.
 */
export function appearanceVariables(
  prefs: Preferences,
  theme: ResolvedTheme,
): Record<string, string> {
  const tokens = effectiveTokens(prefs, theme);
  const dark = isDarkTheme(theme);
  const lift = (base: string, amount: number) =>
    mixHex(base, dark ? "#ffffff" : "#000000", amount);

  const radius = Math.max(0, Math.min(24, Math.round(prefs.radius)));

  return {
    "--surface-0": tokens.background,
    "--surface-1": mixHex(tokens.background, tokens.surface, 0.6),
    "--surface-2": tokens.surface,
    "--surface-3": tokens.elevated,
    "--surface-4": lift(tokens.elevated, 0.06),
    "--border-subtle": tokens.border,
    "--border-strong": lift(tokens.border, 0.18),
    "--accent": tokens.accent,
    "--accent-hover": lift(tokens.accent, 0.16),
    "--accent-soft": mixHex(tokens.background, tokens.accent, dark ? 0.2 : 0.12),
    "--text-primary": tokens.text,
    "--text-secondary": tokens.textDim,
    "--text-muted": mixHex(tokens.text, tokens.background, 0.55),
    "--media-bg": tokens.mediaBackground,
    "--radius": `${radius}px`,
    "--radius-card": `${radius + 2}px`,
    "--shadow-card": SHADOWS[prefs.shadow] ?? SHADOWS.soft,
  };
}

/**
 * Paint a preference set onto an element — in practice `<html>`.
 *
 * Called with the draft while Settings is being edited and with the saved
 * preferences otherwise, which is the whole of the live-preview mechanism:
 * there is no separate preview state to get out of step.
 */
export function applyAppearance(
  root: HTMLElement,
  prefs: Preferences,
  prefersDark = prefersDarkScheme(),
): ResolvedTheme {
  const theme = resolveTheme(prefs.theme, prefersDark);
  root.dataset.theme = theme;
  root.dataset.density = prefs.density;
  root.dataset.shadow = prefs.shadow;
  for (const [name, value] of Object.entries(
    appearanceVariables(prefs, theme),
  )) {
    root.style.setProperty(name, value);
  }
  return theme;
}

// ---------------------------------------------------------------------------
// Readability
// ---------------------------------------------------------------------------

/** One thing wrong with a palette, as a key the caller localizes. */
export interface ContrastWarning {
  /** i18n key under `appearance.warn.*`. */
  id:
    | "textOnBackground"
    | "textOnSurface"
    | "borderInvisible"
    | "surfaceFlat"
    | "accentUnreadable";
  /** The measured ratio, for display alongside the sentence. */
  ratio: number;
}

/** Body text must clear WCAG AA at normal weight. */
const TEXT_MIN = 4.5;
/** A border that cannot be seen is not a border. */
const BORDER_MIN = 1.2;
/**
 * A card must read as a card.
 *
 * Measured as the *better* of two cues — the surface stepping away from the
 * page, or the border outlining it — because those are genuinely alternative
 * designs. A white card on an off-white page separates by its edge, and
 * failing it for a flat fill would be wrong.
 */
const SEPARATION_MIN = 1.15;
/** An accent carries buttons and links: large-text AA at minimum. */
const ACCENT_MIN = 3;

/**
 * Everything unreadable about a palette, worst first.
 *
 * These are warnings, never a block: a reader who wants a low-contrast theme
 * is allowed to have one, and is told plainly what it costs.
 */
export function contrastWarnings(
  prefs: Preferences,
  theme: ResolvedTheme,
): ContrastWarning[] {
  const t = effectiveTokens(prefs, theme);
  const checks: ContrastWarning[] = [
    { id: "textOnBackground", ratio: contrastRatio(t.text, t.background) },
    { id: "textOnSurface", ratio: contrastRatio(t.text, t.surface) },
    { id: "borderInvisible", ratio: contrastRatio(t.border, t.surface) },
    {
      id: "surfaceFlat",
      ratio: Math.max(
        contrastRatio(t.surface, t.background),
        contrastRatio(t.border, t.background),
      ),
    },
    { id: "accentUnreadable", ratio: contrastRatio(t.accent, t.surface) },
  ];
  const limit: Record<ContrastWarning["id"], number> = {
    textOnBackground: TEXT_MIN,
    textOnSurface: TEXT_MIN,
    borderInvisible: BORDER_MIN,
    surfaceFlat: SEPARATION_MIN,
    accentUnreadable: ACCENT_MIN,
  };
  return checks
    .filter((c) => c.ratio < limit[c.id])
    .sort((a, b) => a.ratio - b.ratio);
}

/** Contrast rounded the way the interface prints it: "4.7". */
export function formatRatio(ratio: number): string {
  return (Math.round(ratio * 10) / 10).toFixed(1);
}

// ---------------------------------------------------------------------------
// Document-wide application
// ---------------------------------------------------------------------------

/**
 * Keep `<html>` in step with the store, forever, exactly once.
 *
 * Module-scoped for the same reason the startup sequence is: this must not be
 * a component's responsibility. The subscription paints `draft ?? prefs`, so
 * the Settings page previewing an unsaved palette and the app obeying the
 * saved one are the same code path, and Cancel restores the saved appearance
 * by clearing the draft rather than by remembering what to undo.
 */
let appearanceStop: (() => void) | null = null;

export function startAppearanceSync(
  store: {
    getState: () => { prefs: Preferences; draft: Preferences | null };
    subscribe: (fn: () => void) => () => void;
  },
  root: HTMLElement | null = typeof document === "undefined"
    ? null
    : document.documentElement,
): void {
  if (appearanceStop || !root) return;

  const paint = () => {
    const { prefs, draft } = store.getState();
    applyAppearance(root, draft ?? prefs);
  };

  paint();
  const unsubscribe = store.subscribe(paint);

  // The OS theme moving under a `system` preference has to repaint too.
  const media =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: light)")
      : null;
  media?.addEventListener?.("change", paint);

  appearanceStop = () => {
    unsubscribe();
    media?.removeEventListener?.("change", paint);
  };
}

/** Test-only: drop the subscription so the next test starts clean. */
export function stopAppearanceSyncForTests(): void {
  appearanceStop?.();
  appearanceStop = null;
}

/** The appearance the app falls back to — used by Reset to defaults. */
export const defaultAppearance: Preferences = defaultPreferences;
