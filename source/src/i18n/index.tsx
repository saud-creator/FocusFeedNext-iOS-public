import { createContext, useContext, useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import { en } from "./en";
import { ar } from "./ar";
import type {
  Catalog,
  Dir,
  I18n,
  LanguagePref,
  Locale,
  PluralCategory,
  TVars,
} from "./types";

export type {
  Catalog,
  Dir,
  I18n,
  LanguagePref,
  Locale,
  PluralCategory,
  TVars,
} from "./types";

export { en } from "./en";
export { ar } from "./ar";
export { detectDirection } from "./contentDirection";

/** Every catalog the app ships, keyed by locale. */
export const catalogs: Record<Locale, Catalog> = { en, ar };

/**
 * BCP-47 tags handed to `Intl`.
 *
 * Plain "ar" resolves to the Latin numbering system in current ICU builds,
 * which would print "1,234" inside an otherwise Arabic sentence. Pinning
 * `-u-nu-arab` keeps numbers, dates and compact figures Arabic-Indic
 * ("١٢٫٤ ألف") without dragging in a region-specific calendar.
 */
const INTL_LOCALE: Record<Locale, string> = {
  en: "en",
  ar: "ar-u-nu-arab",
};

// ---------------------------------------------------------------------------
// Missing-key reporting
// ---------------------------------------------------------------------------

/** Keys already reported, so a missing string in a list cannot flood the console. */
const warnedKeys = new Set<string>();

function warnMissing(locale: Locale, key: string): void {
  if (!import.meta.env.DEV) return;
  const id = `${locale}:${key}`;
  if (warnedKeys.has(id)) return;
  warnedKeys.add(id);
  console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
}

/** Test-only escape hatch so a suite can assert the "warn once" behaviour. */
export function resetMissingKeyWarnings(): void {
  warnedKeys.clear();
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replace every `{name}` with `vars.name`; unknown placeholders are left alone. */
function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name)
      ? String(vars[name])
      : match,
  );
}

// ---------------------------------------------------------------------------
// Locale resolution
// ---------------------------------------------------------------------------

/** "system" reads the browser locale; anything starting with "ar" means Arabic. */
export function resolveLocale(pref: LanguagePref): Locale {
  if (pref === "ar" || pref === "en") return pref;

  const tag =
    typeof navigator !== "undefined"
      ? (navigator.language ?? navigator.languages?.[0])
      : undefined;

  return typeof tag === "string" && tag.toLowerCase().startsWith("ar")
    ? "ar"
    : "en";
}

/** Arabic reads right to left; everything else we ship reads left to right. */
export function dirFor(locale: Locale): Dir {
  return locale === "ar" ? "rtl" : "ltr";
}

// ---------------------------------------------------------------------------
// Formatter construction
// ---------------------------------------------------------------------------

/**
 * Relative-time units, largest last. Months and years use average lengths —
 * exact enough for "3 months ago" and far cheaper than calendar arithmetic.
 */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 1_000],
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
  ["month", 2_629_746_000],
  ["year", 31_556_952_000],
];

function buildI18n(locale: Locale): I18n {
  const catalog = catalogs[locale];
  const tag = INTL_LOCALE[locale];

  // Built once per locale: constructing Intl objects is the expensive part.
  const numberFormat = new Intl.NumberFormat(tag);
  const compactFormat = new Intl.NumberFormat(tag, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const dateFormat = new Intl.DateTimeFormat(tag, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const dateTimeFormat = new Intl.DateTimeFormat(tag, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const relativeFormat = new Intl.RelativeTimeFormat(tag, {
    numeric: "auto",
  });
  const pluralRules = new Intl.PluralRules(tag);

  const formatNumber = (n: number): string =>
    Number.isNaN(n) ? "" : numberFormat.format(n);

  const formatCompact = (n: number): string =>
    Number.isNaN(n) ? "" : compactFormat.format(n);

  const t = (key: string, vars?: TVars): string => {
    const template = catalog[key];
    if (template === undefined) {
      warnMissing(locale, key);
      return key;
    }
    return interpolate(template, vars);
  };

  const plural = (key: string, count: number, vars?: TVars): string => {
    const category = pluralRules.select(count) as PluralCategory;
    const template = catalog[`${key}.${category}`] ?? catalog[`${key}.other`];
    if (template === undefined) {
      warnMissing(locale, `${key}.${category}`);
      return key;
    }
    return interpolate(template, { count: formatNumber(count), ...vars });
  };

  /** Parse an ISO string, returning null instead of an Invalid Date. */
  const parse = (iso: string): Date | null => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const formatDate = (iso: string): string => {
    const d = parse(iso);
    return d ? dateFormat.format(d) : "";
  };

  const formatDateTime = (iso: string): string => {
    const d = parse(iso);
    return d ? dateTimeFormat.format(d) : "";
  };

  const formatRelative = (iso: string): string => {
    const d = parse(iso);
    if (!d) return "";

    // Negative in the past, positive in the future — the sign Intl expects.
    const deltaMs = d.getTime() - Date.now();
    const abs = Math.abs(deltaMs);

    let unit: Intl.RelativeTimeFormatUnit = "second";
    let scale = 1_000;
    for (const [candidateUnit, candidateScale] of RELATIVE_UNITS) {
      if (abs < candidateScale) break;
      unit = candidateUnit;
      scale = candidateScale;
    }

    return relativeFormat.format(Math.round(deltaMs / scale), unit);
  };

  return {
    locale,
    dir: dirFor(locale),
    t,
    plural,
    formatNumber,
    formatCompact,
    formatDate,
    formatDateTime,
    formatRelative,
  };
}

/** One `I18n` per locale, shared by the provider and any non-React caller. */
const instances = new Map<Locale, I18n>();

/**
 * Get the `I18n` for a locale. Safe to call outside React — the store, an
 * error mapper or a test can localize without rendering a provider.
 */
export function createI18n(locale: Locale): I18n {
  const existing = instances.get(locale);
  if (existing) return existing;
  const built = buildI18n(locale);
  instances.set(locale, built);
  return built;
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/**
 * Defaults to English so a component rendered outside the provider (a unit
 * test, a portal, an error boundary) still renders real words instead of
 * crashing.
 */
const I18nContext = createContext<I18n>(createI18n("en"));

export function I18nProvider(props: {
  locale: Locale;
  children: ReactNode;
}): ReactElement {
  // Memoised on locale alone: the value is otherwise stable, so switching
  // language is the only thing that re-renders every consumer.
  const value = useMemo(() => createI18n(props.locale), [props.locale]);
  return (
    <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
  );
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export function useT(): I18n["t"] {
  return useContext(I18nContext).t;
}
