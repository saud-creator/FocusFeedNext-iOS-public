/**
 * Shared i18n types.
 *
 * Kept in their own module so catalogs, the provider and consumers can all
 * import them without creating an import cycle.
 */

/** A locale the interface can actually render. */
export type Locale = "en" | "ar";

/** What the user picked in Settings; "system" is resolved at runtime. */
export type LanguagePref = "system" | "en" | "ar";

/** Writing direction of the interface (or of a single piece of content). */
export type Dir = "ltr" | "rtl";

/** Placeholder values for `{name}`-style interpolation. */
export type TVars = Record<string, string | number>;

/** A flat, dot-namespaced message catalog. */
export type Catalog = Record<string, string>;

/** The six CLDR plural categories. Arabic uses all of them; English uses two. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** Everything a component needs to render localized, correctly formatted text. */
export interface I18n {
  locale: Locale;
  dir: Dir;
  /** Look up a key and interpolate `{vars}`. A missing key returns the key. */
  t: (key: string, vars?: TVars) => string;
  /** Look up `key.<plural category>` for `count` via `Intl.PluralRules`. */
  plural: (key: string, count: number, vars?: TVars) => string;
  formatNumber: (n: number) => string;
  formatCompact: (n: number) => string;
  formatDate: (iso: string) => string;
  formatDateTime: (iso: string) => string;
  formatRelative: (iso: string) => string;
}
