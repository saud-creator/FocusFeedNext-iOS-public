import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen } from "@testing-library/react";
import { ar } from "./ar";
import { en } from "./en";
import {
  I18nProvider,
  catalogs,
  createI18n,
  dirFor,
  resetMissingKeyWarnings,
  resolveLocale,
  useI18n,
  useT,
} from "./index";
import {
  BIDI_ISOLATE_CHARS,
  detectDirection,
  isolate,
  stripBidiControls,
} from "./contentDirection";

/** Mirrors the ErrorCode enum in src-tauri/src/models.rs, in declaration order. */
const ERROR_CODES = [
  "tool_missing",
  "not_authenticated",
  "cookie_expired",
  "rate_limited",
  "api_error",
  "schema_changed",
  "empty_response",
  "process_timeout",
  "process_crashed",
  "invalid_json",
  "database_error",
  "media_unavailable",
  "network_unavailable",
  "provider_unavailable",
  "agent_reach_unavailable",
  "blocked_operation",
] as const;

const EN = createI18n("en");
const AR = createI18n("ar");

// ---------------------------------------------------------------------------

describe("catalogs", () => {
  it("share exactly the same key set", () => {
    const enKeys = Object.keys(en).sort();
    const arKeys = Object.keys(ar).sort();

    const missingFromAr = enKeys.filter((k) => !(k in ar));
    const missingFromEn = arKeys.filter((k) => !(k in en));

    expect(
      missingFromAr,
      `keys present in en but missing from ar:\n  ${missingFromAr.join("\n  ")}`,
    ).toEqual([]);
    expect(
      missingFromEn,
      `keys present in ar but missing from en:\n  ${missingFromEn.join("\n  ")}`,
    ).toEqual([]);
    expect(arKeys).toEqual(enKeys);
  });

  it("ships both locales through the catalogs map", () => {
    expect(catalogs.en).toBe(en);
    expect(catalogs.ar).toBe(ar);
  });

  it("has no empty value in either catalog", () => {
    for (const [name, catalog] of Object.entries({ en, ar })) {
      const empty = Object.entries(catalog)
        .filter(([, value]) => value.trim() === "")
        .map(([key]) => key);
      expect(empty, `empty values in ${name}: ${empty.join(", ")}`).toEqual([]);
    }
  });

  it("never uses a placeholder in ar that en does not define", () => {
    // A placeholder only ar knows about can never be filled by a caller that
    // was written against the English string, so it would render literally.
    const placeholders = (s: string) =>
      new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

    const extra: string[] = [];
    for (const key of Object.keys(en)) {
      const allowed = placeholders(en[key]);
      for (const name of placeholders(ar[key])) {
        if (!allowed.has(name)) extra.push(`${key}: {${name}}`);
      }
    }
    expect(
      extra,
      `unknown placeholders in ar:\n  ${extra.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps placeholders identical for every non-plural key", () => {
    // Plural categories are exempt on purpose: Arabic writes "رد واحد" and
    // "ردّان" without a numeral, while English writes "1 reply".
    const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;
    const placeholders = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    const mismatched: string[] = [];
    for (const key of Object.keys(en)) {
      if (PLURAL_SUFFIX.test(key)) continue;
      const a = placeholders(en[key]).join(",");
      const b = placeholders(ar[key]).join(",");
      if (a !== b)
        mismatched.push(`${key} (en: ${a || "-"} / ar: ${b || "-"})`);
    }
    expect(
      mismatched,
      `placeholder mismatch:\n  ${mismatched.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has a title and a repair for every ErrorCode in models.rs", () => {
    const missing: string[] = [];
    for (const code of ERROR_CODES) {
      for (const suffix of ["title", "repair"]) {
        const key = `error.${code}.${suffix}`;
        if (!(key in en)) missing.push(`en:${key}`);
        if (!(key in ar)) missing.push(`ar:${key}`);
      }
    }
    expect(missing, `missing error strings: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not translate product names in the Arabic catalog", () => {
    expect(ar["app.name"]).toBe("Focus Feed Next");
    expect(ar["connect.authToken"]).toBe("auth_token");
    expect(ar["connect.ct0"]).toBe("ct0");
    expect(ar["home.provider.twitterCli"]).toBe("twitter-cli");
    expect(ar["home.provider.agentReach"]).toBe("Agent Reach");
  });

  it("names each language in its own language in both catalogs", () => {
    expect(en["settings.language.arabic"]).toBe("العربية");
    expect(ar["settings.language.arabic"]).toBe("العربية");
    expect(en["settings.language.english"]).toBe("English");
    expect(ar["settings.language.english"]).toBe("English");
  });
});

// ---------------------------------------------------------------------------

describe("resolveLocale", () => {
  const original = Object.getOwnPropertyDescriptor(
    window.navigator,
    "language",
  );

  const setLanguage = (value: string) => {
    Object.defineProperty(window.navigator, "language", {
      value,
      configurable: true,
    });
  };

  afterEach(() => {
    if (original) Object.defineProperty(window.navigator, "language", original);
  });

  it("returns an explicit preference untouched", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("ar")).toBe("ar");
  });

  it("reads the browser locale for 'system'", () => {
    setLanguage("ar-SA");
    expect(resolveLocale("system")).toBe("ar");

    setLanguage("ar");
    expect(resolveLocale("system")).toBe("ar");

    setLanguage("AR-EG");
    expect(resolveLocale("system")).toBe("ar");
  });

  it("falls back to English for any non-Arabic system locale", () => {
    setLanguage("en-GB");
    expect(resolveLocale("system")).toBe("en");

    setLanguage("fr-FR");
    expect(resolveLocale("system")).toBe("en");

    setLanguage("");
    expect(resolveLocale("system")).toBe("en");
  });
});

describe("dirFor", () => {
  it("maps Arabic to rtl and English to ltr", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });

  it("agrees with the dir exposed on the i18n object", () => {
    expect(AR.dir).toBe("rtl");
    expect(EN.dir).toBe("ltr");
  });
});

// ---------------------------------------------------------------------------

describe("t", () => {
  const TWICE = "test.interpolation.twice";

  beforeAll(() => {
    en[TWICE] = "{name} talked to {name}";
    ar[TWICE] = "{name} تحدث إلى {name}";
  });

  afterAll(() => {
    delete en[TWICE];
    delete ar[TWICE];
  });

  it("returns the plain string for a key with no placeholders", () => {
    expect(EN.t("common.cancel")).toBe("Cancel");
    expect(AR.t("common.cancel")).toBe("إلغاء");
  });

  it("interpolates a placeholder", () => {
    expect(EN.t("post.repostedBy", { name: "Ada" })).toBe("Ada reposted");
    expect(AR.t("post.repostedBy", { name: "Ada" })).toContain("Ada");
  });

  it("interpolates the same variable more than once", () => {
    expect(EN.t(TWICE, { name: "Ada" })).toBe("Ada talked to Ada");
    expect(AR.t(TWICE, { name: "Ada" })).toBe("Ada تحدث إلى Ada");
  });

  it("accepts numbers as variables", () => {
    expect(EN.t("nav.badgeOverflow", { count: 999 })).toBe("999+");
  });

  it("leaves an unknown placeholder in place rather than printing undefined", () => {
    const out = EN.t("post.repostedBy", { other: "Ada" });
    expect(out).toBe("{name} reposted");
    expect(out).not.toContain("undefined");
  });

  it("returns the key itself when the key is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetMissingKeyWarnings();

    expect(EN.t("nope.not.a.key")).toBe("nope.not.a.key");
    expect(AR.t("also.missing")).toBe("also.missing");

    warn.mockRestore();
  });

  it("warns at most once for the same missing key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetMissingKeyWarnings();

    EN.t("repeatedly.missing");
    EN.t("repeatedly.missing");
    EN.t("repeatedly.missing");

    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------

describe("plural", () => {
  it("selects the right Arabic form for each CLDR category", () => {
    expect(AR.plural("profile.followers", 0)).toBe(ar["profile.followers.zero"]);
    expect(AR.plural("profile.followers", 1)).toBe(ar["profile.followers.one"]);
    expect(AR.plural("profile.followers", 2)).toBe(ar["profile.followers.two"]);
    expect(AR.plural("profile.followers", 3)).toBe(
      ar["profile.followers.few"].replace("{count}", AR.formatNumber(3)),
    );
    expect(AR.plural("profile.followers", 11)).toBe(
      ar["profile.followers.many"].replace("{count}", AR.formatNumber(11)),
    );
    expect(AR.plural("profile.followers", 100)).toBe(
      ar["profile.followers.other"].replace("{count}", AR.formatNumber(100)),
    );
  });

  it("produces six distinct Arabic forms for the required plural sets", () => {
    for (const key of [
      "feed.newPosts",
      "people.count",
      "profile.loaded",
      "profile.followers",
      "profile.following",
    ]) {
      const forms = ["zero", "one", "two", "few", "many", "other"].map(
        (c) => ar[`${key}.${c}`],
      );
      expect(forms.every(Boolean), `missing a form for ${key}`).toBe(true);
      // zero/one/two are number-free in Arabic, so they must not be identical
      // to the counted forms.
      expect(new Set(forms).size, `duplicate forms for ${key}`).toBeGreaterThan(
        3,
      );
    }
  });

  it("selects one vs other in English", () => {
    expect(EN.plural("profile.followers", 1)).toBe("1 follower");
    expect(EN.plural("profile.followers", 2)).toBe("2 followers");
    expect(EN.plural("profile.followers", 0)).toBe("0 followers");
    expect(EN.plural("feed.newPosts", 5)).toBe("Show 5 new posts");
  });

  it("formats the injected count with the locale formatter", () => {
    expect(EN.plural("people.count", 1234)).toBe("1,234 accounts");
    // Arabic renders Arabic-Indic digits, so the Latin form must not appear.
    expect(AR.plural("people.count", 1234)).not.toContain("1,234");
  });

  it("lets an explicit variable override the injected count", () => {
    expect(EN.plural("people.count", 5, { count: "many" })).toBe(
      "many accounts",
    );
  });

  it("falls back to the .other form when a category is missing", () => {
    const key = "test.partial.plural";
    en[`${key}.other`] = "{count} widgets";
    try {
      // Arabic asks for .zero / .two / .few, none of which exist here.
      expect(EN.plural(key, 0)).toBe("0 widgets");
      expect(EN.plural(key, 3)).toBe("3 widgets");
    } finally {
      delete en[`${key}.other`];
    }
  });

  it("returns the key when no form exists at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetMissingKeyWarnings();
    expect(EN.plural("no.such.plural", 3)).toBe("no.such.plural");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------

describe("formatters", () => {
  it("formats numbers differently per locale", () => {
    expect(EN.formatNumber(1234)).toBe("1,234");
    expect(AR.formatNumber(1234)).not.toBe(EN.formatNumber(1234));
  });

  it("formats compact numbers differently per locale", () => {
    expect(EN.formatCompact(12_400)).toBe("12.4K");
    expect(AR.formatCompact(12_400)).not.toBe(EN.formatCompact(12_400));
    expect(AR.formatCompact(12_400)).not.toBe("");
  });

  it("survives edge numbers without throwing", () => {
    for (const i18n of [EN, AR]) {
      for (const n of [0, -1, -98_765, 1e21, Number.MAX_SAFE_INTEGER]) {
        expect(() => i18n.formatNumber(n)).not.toThrow();
        expect(() => i18n.formatCompact(n)).not.toThrow();
        expect(typeof i18n.formatNumber(n)).toBe("string");
        expect(typeof i18n.formatCompact(n)).toBe("string");
      }
      expect(i18n.formatNumber(0)).not.toBe("");
      expect(i18n.formatCompact(0)).not.toBe("");
      expect(i18n.formatNumber(Number.NaN)).toBe("");
      expect(i18n.formatCompact(Number.NaN)).toBe("");
    }
  });

  it("formats dates differently per locale", () => {
    const iso = "2026-07-24T13:45:00Z";
    expect(EN.formatDate(iso)).toMatch(/2026/);
    expect(AR.formatDate(iso)).not.toBe(EN.formatDate(iso));
    expect(AR.formatDate(iso)).not.toBe("");
  });

  it("formats date and time differently per locale", () => {
    const iso = "2026-07-24T13:45:00Z";
    expect(EN.formatDateTime(iso)).toMatch(/2026/);
    expect(EN.formatDateTime(iso).length).toBeGreaterThan(
      EN.formatDate(iso).length,
    );
    expect(AR.formatDateTime(iso)).not.toBe(EN.formatDateTime(iso));
  });

  it("returns an empty string for an unparseable date", () => {
    for (const i18n of [EN, AR]) {
      expect(i18n.formatDate("not-a-date")).toBe("");
      expect(i18n.formatDateTime("not-a-date")).toBe("");
      expect(i18n.formatRelative("not-a-date")).toBe("");
      expect(i18n.formatDate("")).toBe("");
    }
  });

  it("picks a sensible relative unit", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    expect(EN.formatRelative(ago(0))).toBe("now");
    expect(EN.formatRelative(ago(30_000))).toMatch(/second/);
    expect(EN.formatRelative(ago(5 * 60_000))).toMatch(/minute/);
    expect(EN.formatRelative(ago(3 * 3_600_000))).toMatch(/hour/);
    expect(EN.formatRelative(ago(3 * 86_400_000))).toMatch(/day/);
    expect(EN.formatRelative(ago(3 * 604_800_000))).toMatch(/week/);
    expect(EN.formatRelative(ago(90 * 86_400_000))).toMatch(/month/);
    expect(EN.formatRelative(ago(800 * 86_400_000))).toMatch(/year/);
  });

  it("handles future timestamps", () => {
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect(EN.formatRelative(soon)).toMatch(/in /);
    expect(AR.formatRelative(soon)).not.toBe("");
  });

  it("formats relative time differently per locale", () => {
    const iso = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(AR.formatRelative(iso)).not.toBe(EN.formatRelative(iso));
    expect(AR.formatRelative(iso)).not.toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("detectDirection", () => {
  it("detects pure Arabic as rtl", () => {
    expect(detectDirection("مرحبا بالعالم")).toBe("rtl");
  });

  it("detects pure English as ltr", () => {
    expect(detectDirection("hello world")).toBe("ltr");
  });

  it("ignores a leading mention", () => {
    expect(detectDirection("@handle مرحبا بالعالم")).toBe("rtl");
    expect(detectDirection("@handle hello world")).toBe("ltr");
  });

  it("ignores a leading URL", () => {
    expect(detectDirection("https://example.com/a مرحبا بالعالم")).toBe("rtl");
    expect(detectDirection("www.example.com مرحبا")).toBe("rtl");
  });

  it("ignores a leading hashtag", () => {
    expect(detectDirection("#BreakingNews مرحبا بالعالم")).toBe("rtl");
  });

  it("uses the first strong letter, not any occurrence", () => {
    expect(detectDirection("hello مرحبا world")).toBe("ltr");
  });

  it("keeps an Arabic sentence rtl when it embeds a Latin brand name", () => {
    expect(detectDirection("مرحبا بكم في Focus Feed Next اليوم")).toBe("rtl");
  });

  it("treats emoji, digits and punctuation as neutral", () => {
    expect(detectDirection("🎉🎉🎉")).toBe("ltr");
    expect(detectDirection("123 456,789")).toBe("ltr");
    expect(detectDirection("!!! ??? ...")).toBe("ltr");
    expect(detectDirection("2026 مرحبا")).toBe("rtl");
    expect(detectDirection("١٢٣ مرحبا")).toBe("rtl");
  });

  it("returns ltr for an empty string", () => {
    expect(detectDirection("")).toBe("ltr");
    expect(detectDirection("   ")).toBe("ltr");
  });

  it("detects Hebrew as rtl", () => {
    expect(detectDirection("שלום עולם")).toBe("rtl");
  });

  it("is not confused by leading bidi control characters", () => {
    expect(detectDirection(`${BIDI_ISOLATE_CHARS.RLM}hello`)).toBe("ltr");
    expect(detectDirection(`${BIDI_ISOLATE_CHARS.LRM}مرحبا`)).toBe("rtl");
  });

  it("agrees with the direction of the surrounding interface for each locale", () => {
    expect(detectDirection(en["nav.home"])).toBe(dirFor("en"));
    expect(detectDirection(ar["nav.home"])).toBe(dirFor("ar"));
  });
});

describe("bidi helpers", () => {
  it("wraps text in a first-strong isolate by default", () => {
    const wrapped = isolate("مرحبا");
    expect(wrapped.startsWith(BIDI_ISOLATE_CHARS.FSI)).toBe(true);
    expect(wrapped.endsWith(BIDI_ISOLATE_CHARS.PDI)).toBe(true);
  });

  it("wraps with an explicit direction when asked", () => {
    expect(isolate("x", "rtl").startsWith(BIDI_ISOLATE_CHARS.RLI)).toBe(true);
    expect(isolate("x", "ltr").startsWith(BIDI_ISOLATE_CHARS.LRI)).toBe(true);
  });

  it("round-trips through stripBidiControls", () => {
    expect(stripBidiControls(isolate("مرحبا"))).toBe("مرحبا");
    expect(stripBidiControls("plain")).toBe("plain");
  });
});

// ---------------------------------------------------------------------------

function Probe() {
  const { locale, dir, formatCompact } = useI18n();
  const t = useT();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="dir">{dir}</span>
      <span data-testid="title">{t("settings.title")}</span>
      <span data-testid="compact">{formatCompact(12_400)}</span>
    </div>
  );
}

describe("I18nProvider", () => {
  it("provides the English catalog", () => {
    render(
      <I18nProvider locale="en">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("dir")).toHaveTextContent("ltr");
    expect(screen.getByTestId("title")).toHaveTextContent("Settings");
    expect(screen.getByTestId("compact")).toHaveTextContent("12.4K");
  });

  it("provides the Arabic catalog and rtl direction", () => {
    render(
      <I18nProvider locale="ar">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("locale")).toHaveTextContent("ar");
    expect(screen.getByTestId("dir")).toHaveTextContent("rtl");
    expect(screen.getByTestId("title")).toHaveTextContent(ar["settings.title"]);
  });

  it("falls back to English outside a provider instead of crashing", () => {
    render(<Probe />);
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("title")).toHaveTextContent("Settings");
  });

  it("reuses one i18n instance per locale", () => {
    expect(createI18n("ar")).toBe(createI18n("ar"));
    expect(createI18n("en")).not.toBe(createI18n("ar"));
  });
});

/**
 * Every key the interface asks for must exist.
 *
 * The catalogs are checked against *each other* above, which proves they agree
 * but says nothing about whether either one has what the components need. A
 * key that is missing from both renders as the key itself — the Appearance
 * section shipped in this sprint reading `appearance.colors` on screen, and
 * both catalogs agreed about it perfectly.
 */
describe("keys used by the interface", () => {
  const sources = import.meta.glob("../**/*.{ts,tsx}", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;

  /** `t("some.key")` and `plural("some.key", n)` — literal keys only. */
  function keysIn(source: string): string[] {
    return [...source.matchAll(/\b(?:t|plural)\(\s*"([a-zA-Z0-9_.]+)"/g)].map(
      (m) => m[1],
    );
  }

  it("finds enough call sites to be meaningful", () => {
    const total = Object.values(sources).reduce(
      (n, s) => n + keysIn(s).length,
      0,
    );
    expect(total).toBeGreaterThan(200);
  });

  it("has a value for every key the source asks for", () => {
    const missing = new Map<string, string[]>();
    for (const [file, source] of Object.entries(sources)) {
      if (file.includes(".test.")) continue;
      for (const key of keysIn(source)) {
        // Plural sets are stored as `key.<category>`, so the bare key is
        // legitimately absent; one category standing in proves the set exists.
        const ok = key in en || `${key}.other` in en;
        if (ok) continue;
        const at = missing.get(key) ?? [];
        at.push(file.replace("../", "src/"));
        missing.set(key, at);
      }
    }
    const report = [...missing]
      .map(([key, files]) => `  "${key}" — used in ${files.join(", ")}`)
      .join("\n");
    expect(
      missing.size,
      `keys used by components but absent from the catalogs, so they render as\nthe key itself:\n${report}`,
    ).toBe(0);
  });
});
