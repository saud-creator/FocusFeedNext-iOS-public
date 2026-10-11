import { describe, expect, it } from "vitest";
import {
  MAX_SUGGESTIONS,
  MatchTier,
  accountMatches,
  dedupeAccounts,
  foldForMatch,
  looksLikeHandle,
  matchAccounts,
  normalizeHandle,
  normalizeQuery,
  scoreAccount,
} from "./matching";

/**
 * Arabic fixtures, written as escapes for the same reason the module is.
 *
 * `AKHBAR` opens with a hamza-carrying alef (U+0623); `AKHBAR_PLAIN` is the
 * same word as somebody would actually type it, with a bare alef. They must be
 * indistinguishable to the matcher.
 */
const AKHBAR = "\u0623\u062e\u0628\u0627\u0631"; // "news", written properly
const AKHBAR_PLAIN = "\u0627\u062e\u0628\u0627\u0631"; // typed without hamza
const AKHBAR_HARAKAT = "\u0623\u064e\u062e\u0652\u0628\u064e\u0627\u0631"; // vowelled
const REEM = "\u0631\u064a\u0645"; // "Reem"
const MAKTABA_TEH = "\u0645\u0643\u062a\u0628\u0629"; // ends in teh marbuta
const MAKTABA_HEH = "\u0645\u0643\u062a\u0628\u0647"; // ends in heh
const MUSTAFA_MAQSURA = "\u0645\u0635\u0637\u0641\u0649"; // ends in alef maqsura
const MUSTAFA_YEH = "\u0645\u0635\u0637\u0641\u064a"; // ends in yeh
const ARABIC_TWELVE = "\u0661\u0662"; // Arabic-Indic 12
const FSI = "\u2068";
const PDI = "\u2069";

const account = (username: string, displayName?: string | null) => ({
  username,
  displayName,
});

// ---------------------------------------------------------------------------

describe("foldForMatch", () => {
  it("lowercases and trims", () => {
    expect(foldForMatch("  Reem_Codes  ")).toBe("reem_codes");
  });

  it("collapses runs of whitespace", () => {
    expect(foldForMatch("Reem   Al  Otaibi")).toBe("reem al otaibi");
  });

  it("returns an empty string for nothing at all", () => {
    expect(foldForMatch("")).toBe("");
    expect(foldForMatch(null)).toBe("");
    expect(foldForMatch(undefined)).toBe("");
  });

  it("folds Arabic hamza carriers onto their base letters", () => {
    expect(foldForMatch(AKHBAR)).toBe(AKHBAR_PLAIN);
  });

  it("ignores Arabic vowel marks", () => {
    expect(foldForMatch(AKHBAR_HARAKAT)).toBe(foldForMatch(AKHBAR));
  });

  it("folds teh marbuta onto heh", () => {
    expect(foldForMatch(MAKTABA_TEH)).toBe(foldForMatch(MAKTABA_HEH));
  });

  it("folds alef maqsura onto yeh", () => {
    expect(foldForMatch(MUSTAFA_MAQSURA)).toBe(foldForMatch(MUSTAFA_YEH));
  });

  it("drops tatweel", () => {
    expect(foldForMatch("\u0631\u0640\u0640\u064a\u0645")).toBe(
      foldForMatch(REEM),
    );
  });

  it("folds Arabic-Indic digits to ASCII", () => {
    expect(foldForMatch(ARABIC_TWELVE)).toBe("12");
    expect(foldForMatch("\u06f3\u06f4")).toBe("34");
  });

  it("folds Latin accents", () => {
    expect(foldForMatch("Caf\u00e9")).toBe("cafe");
  });

  it("removes invisible bidi controls", () => {
    expect(foldForMatch(`${FSI}reem${PDI}`)).toBe("reem");
  });

  it("is idempotent", () => {
    for (const s of [AKHBAR, MAKTABA_TEH, "Caf\u00e9", `${FSI}Reem${PDI}`]) {
      expect(foldForMatch(foldForMatch(s))).toBe(foldForMatch(s));
    }
  });
});

describe("normalizeQuery", () => {
  it("strips a leading @", () => {
    expect(normalizeQuery("@reem_codes")).toBe("reem_codes");
  });

  it("strips a leading @ regardless of case, spacing or repetition", () => {
    expect(normalizeQuery("  @@Reem_Codes ")).toBe("reem_codes");
  });

  it("strips an @ hidden behind a bidi control", () => {
    expect(normalizeQuery(`${FSI}@Reem${PDI}`)).toBe("reem");
  });

  it("leaves an @ that is not leading alone", () => {
    expect(normalizeQuery("a@b")).toBe("a@b");
  });

  it("agrees with normalizeHandle", () => {
    expect(normalizeHandle("@Reem_Codes")).toBe(normalizeQuery("reem_codes"));
  });
});

describe("looksLikeHandle", () => {
  it("accepts an X handle with or without the @", () => {
    expect(looksLikeHandle("reem_codes")).toBe(true);
    expect(looksLikeHandle("@reem_codes")).toBe(true);
    expect(looksLikeHandle(" @Reem_Codes ")).toBe(true);
  });

  it("refuses anything that cannot be a handle", () => {
    expect(looksLikeHandle("")).toBe(false);
    expect(looksLikeHandle("rust lang")).toBe(false);
    expect(looksLikeHandle(AKHBAR)).toBe(false);
    expect(looksLikeHandle("a".repeat(16))).toBe(false);
    expect(looksLikeHandle("reem-codes")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("scoreAccount", () => {
  const reem = account("reem_codes", "Reem Al Otaibi");

  it("ranks an exact handle above everything", () => {
    expect(scoreAccount(reem, "reem_codes")).toBe(MatchTier.ExactHandle);
  });

  it("ranks a handle prefix above a name prefix", () => {
    expect(scoreAccount(reem, "reem_")).toBe(MatchTier.HandlePrefix);
    expect(scoreAccount(account("x_reem", "Reem"), "reem")).toBe(
      MatchTier.ExactName,
    );
  });

  it("treats an underscore as a word break in a handle", () => {
    expect(scoreAccount(reem, "codes")).toBe(MatchTier.HandleWord);
  });

  it("matches a later word of a display name", () => {
    expect(scoreAccount(reem, "otaibi")).toBe(MatchTier.NameWord);
  });

  it("falls back to a substring in the middle of a word", () => {
    expect(scoreAccount(reem, "taib")).toBe(MatchTier.NameContains);
  });

  it("returns null when nothing matches", () => {
    expect(scoreAccount(reem, "zzz")).toBeNull();
  });

  it("returns null for an empty query rather than matching everything", () => {
    expect(scoreAccount(reem, "")).toBeNull();
  });

  it("does not report an empty display name as an exact match", () => {
    expect(scoreAccount(account("someone", ""), "")).toBeNull();
    expect(scoreAccount(account("someone", null), "x")).toBeNull();
  });
});

describe("accountMatches", () => {
  it("normalises the raw query first", () => {
    expect(accountMatches(account("reem_codes", "Reem"), " @REEM ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("matchAccounts", () => {
  // -- English ---------------------------------------------------------------

  const english = [
    account("rustlang_daily", "Rust Daily"),
    account("ml_papers", "ML Papers"),
    account("reem_codes", "Reem Al Otaibi"),
    account("daily_ui", "Daily UI"),
  ];

  it("matches an English display name", () => {
    expect(matchAccounts(english, "rust").map((a) => a.username)).toEqual([
      "rustlang_daily",
    ]);
  });

  it("matches an English handle case-insensitively", () => {
    expect(matchAccounts(english, "REEM_CODES").map((a) => a.username)).toEqual(
      ["reem_codes"],
    );
  });

  it("puts the handle prefix before the incidental word match", () => {
    expect(matchAccounts(english, "daily").map((a) => a.username)).toEqual([
      "daily_ui", // handle prefix
      "rustlang_daily", // second word of the handle
    ]);
  });

  it("normalises a leading @ away", () => {
    expect(matchAccounts(english, "@reem").map((a) => a.username)).toEqual([
      "reem_codes",
    ]);
    expect(matchAccounts(english, "@reem")).toEqual(
      matchAccounts(english, "reem"),
    );
  });

  // -- Arabic ----------------------------------------------------------------

  const arabic = [
    account("akhbar_now", AKHBAR), // display name with hamza
    account("maktaba", MAKTABA_TEH),
    account("mustafa", MUSTAFA_MAQSURA),
    account("reem_ar", REEM),
  ];

  it("matches an Arabic display name typed without the hamza", () => {
    expect(matchAccounts(arabic, AKHBAR_PLAIN).map((a) => a.username)).toEqual([
      "akhbar_now",
    ]);
  });

  it("matches an Arabic display name typed with vowel marks", () => {
    expect(
      matchAccounts(arabic, AKHBAR_HARAKAT).map((a) => a.username),
    ).toEqual(["akhbar_now"]);
  });

  it("matches across the teh marbuta / heh spelling difference", () => {
    expect(matchAccounts(arabic, MAKTABA_HEH).map((a) => a.username)).toEqual([
      "maktaba",
    ]);
  });

  it("matches across the alef maqsura / yeh spelling difference", () => {
    expect(matchAccounts(arabic, MUSTAFA_YEH).map((a) => a.username)).toEqual([
      "mustafa",
    ]);
  });

  it("matches an Arabic prefix, not only the whole word", () => {
    expect(
      matchAccounts(arabic, AKHBAR_PLAIN.slice(0, 3)).map((a) => a.username),
    ).toEqual(["akhbar_now"]);
  });

  // -- mixed -----------------------------------------------------------------

  const mixed = [
    account("ffn_ar", `${AKHBAR} Tech`),
    account("tech_ar", `Tech ${REEM}`),
    account("riyadh_dev", `${REEM} | Riyadh Dev`),
  ];

  it("matches the Latin half of a mixed display name", () => {
    expect(matchAccounts(mixed, "tech").map((a) => a.username)).toEqual([
      "tech_ar", // handle prefix
      "ffn_ar", // second word of the name
    ]);
  });

  it("matches the Arabic half of a mixed display name", () => {
    expect(matchAccounts(mixed, REEM).map((a) => a.username)).toEqual([
      "riyadh_dev", // name prefix
      "tech_ar", // second word of the name
    ]);
  });

  it("matches an Arabic word that follows a Latin separator", () => {
    expect(matchAccounts(mixed, "riyadh").map((a) => a.username)).toEqual([
      "riyadh_dev",
    ]);
  });

  it("matches a mixed-script query against a mixed-script name", () => {
    expect(matchAccounts(mixed, `${AKHBAR_PLAIN} tech`)).toHaveLength(1);
  });

  // -- shape -----------------------------------------------------------------

  it("returns nothing for an empty or whitespace query", () => {
    expect(matchAccounts(english, "")).toEqual([]);
    expect(matchAccounts(english, "   ")).toEqual([]);
    expect(matchAccounts(english, "@")).toEqual([]);
  });

  it("caps the list at the requested limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      account(`user_${i}`, `User ${i}`),
    );
    expect(matchAccounts(many, "user")).toHaveLength(MAX_SUGGESTIONS);
    expect(matchAccounts(many, "user", 3)).toHaveLength(3);
  });

  it("keeps source order within one tier", () => {
    const ordered = [
      account("first_daily", "First"),
      account("second_daily", "Second"),
    ];
    expect(matchAccounts(ordered, "daily").map((a) => a.username)).toEqual([
      "first_daily",
      "second_daily",
    ]);
  });

  it("shows one row per account however many sources supplied it", () => {
    const duplicated = [
      account("reem_codes", "Reem"),
      account("@Reem_Codes", "Reem"),
      account("reem_codes", "Reem"),
    ];
    expect(matchAccounts(duplicated, "reem")).toHaveLength(1);
  });
});

describe("dedupeAccounts", () => {
  it("keeps the richest copy of an account", () => {
    const thin = { username: "reem_codes", displayName: "Reem" };
    const full = {
      username: "@Reem_Codes",
      displayName: "Reem Al Otaibi",
      avatarUrl: "data:image/png;base64,",
    };
    expect(dedupeAccounts([thin, full])).toEqual([full]);
    expect(dedupeAccounts([full, thin])).toEqual([full]);
  });

  it("keeps the position of the first copy seen", () => {
    const a = { username: "a", displayName: "A" };
    const b = { username: "b", displayName: "B" };
    const richA = { username: "a", displayName: "A", avatarUrl: "x" };
    expect(dedupeAccounts([a, b, richA]).map((x) => x.username)).toEqual([
      "a",
      "b",
    ]);
  });

  it("drops an account with no usable handle", () => {
    expect(dedupeAccounts([{ username: "@" }, { username: "  " }])).toEqual([]);
  });
});
