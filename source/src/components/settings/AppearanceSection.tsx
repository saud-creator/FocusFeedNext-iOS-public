import { AlertTriangle, Palette } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/primitives";
import {
  THEME_TOKENS,
  appearanceVariables,
  contrastWarnings,
  effectiveTokens,
  formatRatio,
  prefersDarkScheme,
  resolveTheme,
} from "@/lib/theme";
import {
  THEME_IDS,
  coerceColor,
  defaultPreferences,
  useAppStore,
  type Preferences,
  type ShadowIntensity,
  type ThemeId,
} from "@/stores/useAppStore";
import { SettingRow, SettingsSection } from "./SettingsSection";

/**
 * Appearance.
 *
 * The live preview is not a widget. Editing the draft repaints the whole
 * window, because `startAppearanceSync` paints `draft ?? prefs` — so what a
 * reader is judging is the real interface, not a thumbnail of it, and Cancel
 * restores the saved look by dropping the draft rather than by remembering
 * what to undo. The panel below exists only to show the two things the
 * Settings page cannot otherwise display: the media background, and the
 * palette side by side.
 *
 * Nothing here writes a colour to CSS as a string. Every value goes through
 * `coerceColor` on the way into the draft and through the hex parser in
 * `lib/theme` on the way out to a custom property.
 */

/** The fields this section owns, for dirty-tracking and Reset. */
const APPEARANCE_KEYS = [
  "theme",
  "density",
  "radius",
  "shadow",
  "accent",
  "background",
  "surface",
  "elevated",
  "border",
  "mediaBackground",
  "textContrast",
] as const satisfies readonly (keyof Preferences)[];

/** Which preference each colour swatch edits. */
const COLOR_FIELDS = [
  "background",
  "surface",
  "elevated",
  "border",
  "accent",
  "mediaBackground",
] as const;

type ColorField = (typeof COLOR_FIELDS)[number];

export function AppearanceSection() {
  const { t, formatNumber } = useI18n();
  const prefs = useAppStore((s) => s.prefs);
  const draft = useAppStore((s) => s.draft);
  const setDraft = useAppStore((s) => s.setDraft);

  const current = draft ?? prefs;
  const resolved = resolveTheme(current.theme, prefersDarkScheme());
  const tokens = effectiveTokens(current, resolved);
  const warnings = contrastWarnings(current, resolved);
  const vars = appearanceVariables(current, resolved);

  return (
    <SettingsSection
      title={t("settings.appearance.title")}
      description={t("settings.appearance.desc")}
      icon={<Palette className="size-4" />}
      keys={APPEARANCE_KEYS}
    >
      {/* -- theme ------------------------------------------------------- */}
      <fieldset className="py-3">
        <legend className="text-sm text-ink mb-2">{t("settings.theme")}</legend>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {THEME_IDS.map((id) => (
            <ThemeChoice
              key={id}
              id={id}
              selected={current.theme === id}
              onSelect={() => setDraft("theme", id)}
            />
          ))}
        </div>
      </fieldset>

      {/* -- shape and weight -------------------------------------------- */}
      <SettingRow
        label={t("settings.density")}
        htmlFor="ffn-density"
        control={
          <Select
            id="ffn-density"
            value={current.density}
            onChange={(e) =>
              setDraft("density", e.target.value as Preferences["density"])
            }
          >
            <option value="comfortable">{t("settings.density.comfortable")}</option>
            <option value="compact">{t("settings.density.compact")}</option>
          </Select>
        }
      />

      <SettingRow
        label={t("appearance.radius")}
        description={t("appearance.radius.desc")}
        htmlFor="ffn-radius"
        control={
          <div className="flex items-center gap-2">
            <input
              id="ffn-radius"
              type="range"
              min={0}
              max={24}
              step={1}
              value={current.radius}
              onChange={(e) => setDraft("radius", Number(e.target.value))}
              className="w-[140px] accent-[var(--accent)] cursor-pointer"
            />
            <span
              dir="ltr"
              className="text-[12.5px] text-ink-mute tabular-nums w-9 text-end"
            >
              {formatNumber(current.radius)}
            </span>
          </div>
        }
      />

      <SettingRow
        label={t("appearance.shadow")}
        htmlFor="ffn-shadow"
        control={
          <Select
            id="ffn-shadow"
            value={current.shadow}
            onChange={(e) =>
              setDraft("shadow", e.target.value as ShadowIntensity)
            }
          >
            <option value="none">{t("appearance.shadow.none")}</option>
            <option value="soft">{t("appearance.shadow.soft")}</option>
            <option value="strong">{t("appearance.shadow.strong")}</option>
          </Select>
        }
      />

      <SettingRow
        label={t("appearance.textContrast")}
        description={t("appearance.textContrast.desc")}
        htmlFor="ffn-contrast"
        control={
          <div className="flex items-center gap-2">
            <input
              id="ffn-contrast"
              type="range"
              min={0}
              max={100}
              step={5}
              value={current.textContrast}
              onChange={(e) => setDraft("textContrast", Number(e.target.value))}
              className="w-[140px] accent-[var(--accent)] cursor-pointer"
            />
            <span
              dir="ltr"
              className="text-[12.5px] text-ink-mute tabular-nums w-9 text-end"
            >
              {formatNumber(current.textContrast)}
            </span>
          </div>
        }
      />

      {/* -- colours ------------------------------------------------------ */}
      <div className="py-3">
        <p className="text-sm text-ink">{t("appearance.colors")}</p>
        <p className="text-[12.5px] text-ink-mute mt-0.5">
          {t("appearance.colors.desc")}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 mt-2">
          {COLOR_FIELDS.map((field) => (
            <ColorControl
              key={field}
              field={field}
              value={current[field]}
              themeValue={THEME_TOKENS[resolved][themeTokenFor(field)]}
              onChange={(hex) => setDraft(field, hex)}
            />
          ))}
        </div>
      </div>

      {/* -- readability -------------------------------------------------- */}
      {warnings.length > 0 ? (
        <div
          role="alert"
          className="my-3 rounded-[10px] border border-warn/30 bg-warn/5 p-3"
        >
          <p className="text-[13px] font-medium text-warn flex items-center gap-1.5">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {t("appearance.warn.title")}
          </p>
          <ul className="mt-1.5 space-y-1">
            {warnings.map((w) => (
              <li key={w.id} className="text-[12.5px] text-ink-dim">
                {t(`appearance.warn.${w.id}`)}{" "}
                <span dir="ltr" className="text-ink-mute tabular-nums">
                  {t("appearance.warn.ratio", { ratio: formatRatio(w.ratio) })}
                </span>
              </li>
            ))}
          </ul>
          {/* A warning, never a refusal: a reader is allowed a low-contrast
              theme, and is told plainly what it costs. */}
          <p className="text-[12px] text-ink-mute mt-2">
            {t("appearance.warn.allowed")}
          </p>
        </div>
      ) : null}

      {/* -- preview ------------------------------------------------------ */}
      <div className="py-3">
        <p className="text-sm text-ink">{t("appearance.preview")}</p>
        <p className="text-[12.5px] text-ink-mute mt-0.5 mb-2">
          {t("appearance.preview.desc")}
        </p>
        <div
          // Every value here came out of the hex parser, so there is no path
          // from a stored string to a style declaration.
          style={{
            background: vars["--surface-0"],
            borderColor: vars["--border-subtle"],
            borderRadius: vars["--radius-card"],
            boxShadow: vars["--shadow-card"],
          }}
          className="border p-3"
        >
          <div
            style={{
              background: vars["--surface-2"],
              borderColor: vars["--border-subtle"],
              borderRadius: vars["--radius-card"],
            }}
            className="border p-3"
          >
            <p style={{ color: tokens.text }} className="text-[13px]">
              {t("appearance.preview.sample")}
            </p>
            <p
              style={{ color: tokens.textDim }}
              className="text-[12px] mt-0.5"
            >
              {t("appearance.preview.meta")}
            </p>
            <div
              style={{ background: tokens.mediaBackground }}
              className="mt-2 h-10 rounded-md"
              aria-hidden="true"
            />
            <div className="mt-2 flex items-center gap-2">
              <span
                style={{ background: tokens.accent }}
                className="inline-block h-5 w-12 rounded-full"
                aria-hidden="true"
              />
              <span
                style={{ background: vars["--surface-3"] }}
                className="inline-block h-5 w-12 rounded-full"
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

/** Which theme token a colour field overrides. */
function themeTokenFor(field: ColorField) {
  return field === "mediaBackground" ? ("mediaBackground" as const) : field;
}

function ThemeChoice({
  id,
  selected,
  onSelect,
}: {
  id: ThemeId;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  // `system` has no palette of its own; show whichever one it resolves to now.
  const shown = resolveTheme(id, prefersDarkScheme());
  const tokens = THEME_TOKENS[shown];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "rounded-[10px] border p-2 text-start transition-colors cursor-pointer",
        selected
          ? "border-accent bg-accent-soft"
          : "border-edge hover:border-edge-strong",
      )}
    >
      <div
        style={{ background: tokens.background, borderColor: tokens.border }}
        className="h-8 rounded-md border mb-1.5 flex items-center gap-1 px-1.5"
        aria-hidden="true"
      >
        <span
          style={{ background: tokens.surface }}
          className="h-4 flex-1 rounded-sm"
        />
        <span
          style={{ background: tokens.accent }}
          className="h-4 w-4 rounded-sm shrink-0"
        />
      </div>
      <span className="text-[12.5px] text-ink block truncate">
        {t(`appearance.theme.${id}`)}
      </span>
    </button>
  );
}

/**
 * One colour override.
 *
 * An empty preference means "this theme decides", which is a real third state
 * next to a chosen colour — so the swatch shows the theme's own value and the
 * row says which of the two it is, rather than pretending the reader picked it.
 */
function ColorControl({
  field,
  value,
  themeValue,
  onChange,
}: {
  field: ColorField;
  value: string;
  themeValue: string;
  onChange: (hex: string) => void;
}) {
  const { t } = useI18n();
  const custom = coerceColor(value) ? value !== "" : false;
  const shown = custom ? value : themeValue;
  const id = `ffn-color-${field}`;

  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[13px] text-ink block truncate">
          {t(`appearance.color.${field}`)}
        </label>
        <span className="text-[11.5px] text-ink-mute">
          {custom ? t("appearance.custom") : t("appearance.themeDefault")}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input
          id={id}
          type="color"
          value={shown}
          onChange={(e) => {
            // Defensive: a colour input yields `#rrggbb`, but the draft is the
            // only thing between this and a CSS declaration.
            const safe = coerceColor(e.target.value);
            if (safe) onChange(safe);
          }}
          className="size-7 rounded-md border border-edge bg-transparent cursor-pointer p-0"
        />
        <button
          type="button"
          onClick={() => onChange(defaultPreferences[field])}
          disabled={!custom}
          className="text-[11.5px] text-ink-mute hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {t("appearance.reset")}
        </button>
      </div>
    </div>
  );
}
