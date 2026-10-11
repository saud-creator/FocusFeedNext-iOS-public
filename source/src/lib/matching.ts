/**
 * Account matching for the search suggestion list.
 *
 * Pure, synchronous and dependency-free apart from the bidi helper: this is the
 * half of typeahead that runs on every keystroke, so it never touches the
 * network, React or the store. Everything that decides *which* accounts appear
 * lives here, which is also where the subtle bugs live -- an Arabic display name
 * written with a hamza the reader did not type, a handle in a different case, a
 * query that still carries the "@" the reader habitually types first.
 *
 * ## Folding
 *
 * Matching happens on a folded form of both sides, never on the raw text:
 *
 * - Bidi control characters are removed. A handle copied out of an Arabic
 *   sentence often arrives wrapped in U+2068/U+2069, and those are invisible.
 * - NFD decomposition followed by removal of every combining mark. This is what
 *   makes Arabic tashkeel irrelevant, folds the hamza carriers onto their base
 *   letters (U+0623/U+0625/U+0622 -> U+0627, U+0624 -> U+0648, U+0626 ->
 *   U+064A) and folds Latin accents ("cafe" -> "cafe") in one step.
 * - The three Arabic letters that do *not* decompose are mapped by hand: alef
 *   wasla U+0671 -> U+0627, alef maqsura U+0649 -> U+064A, teh marbuta U+0629
 *   -> U+0647. Readers type these interchangeably and X display names use both.
 * - Tatweel U+0640 is stretching, not a letter, so it is dropped.
 * - Arabic-Indic digits fold to ASCII digits, because an account named with
 *   U+0661 U+0662 should be findable by typing "12".
 *
 * The cost is that this also strips marks from scripts where they are load
 * bearing (Devanagari, Thai). That is a deliberate trade: the fold only ever
 * decides what appears in a suggestion list, never what is displayed, and the
 * two languages this app ships are the two it is tuned for.
 *
 * Lowering uses `toLowerCase` rather than `toLocaleLowerCase`. The locale-aware
 * form reads the *host* locale, so on a Turkish machine "I" would fold to a
 * dotless "i" and an account called "IEEE" would stop matching "ieee" -- the
 * same query would behave differently on two computers. Suggestion ranking has
 * to be reproducible, so it is pinned to the invariant rules.
 *
 * ## Source encoding
 *
 * Like `src/i18n/contentDirection.ts`, this file is pure ASCII: every Arabic
 * character is written as a numeric escape. Literal Arabic in a source file has
 * silently stopped matching before now when the file round-tripped through
 * another encoding, and that is a bug only Arabic readers ever see.
 */
import { stripBidiControls } from "@/i18n/contentDirection";

/** The least an account has to carry to be matched. Structural on purpose. */
export interface MatchCandidate {
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/** Every combining mark, in any script. Removed after NFD. */
const COMBINING = /\p{M}/gu;

/** U+0640, the Arabic stretching character. Carries no sound. */
const TATWEEL = /\u0640/g;

/** Alef wasla U+0671: written for it, typed as a plain alef U+0627. */
const ALEF_WASLA = /\u0671/g;
const ALEF = "\u0627";

/** Alef maqsura U+0649, routinely typed as a final yeh U+064A. */
const ALEF_MAQSURA = /\u0649/g;
const YEH = "\u064a";

/** Teh marbuta U+0629, routinely typed as a heh U+0647. */
const TEH_MARBUTA = /\u0629/g;
const HEH = "\u0647";

/** Arabic-Indic (U+0660..) and extended Arabic-Indic (U+06F0..) digits. */
const ARABIC_DIGITS = /[\u0660-\u0669\u06f0-\u06f9]/g;

/** Anything that is not a letter or a digit -- the word boundary for matching. */
const NON_WORD = /[^\p{L}\p{N}]+/u;

function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const base = cp >= 0x06f0 ? 0x06f0 : 0x0660;
  return String(cp - base);
}

/**
 * The form both sides of a comparison are put into.
 *
 * Idempotent: folding an already folded string returns it unchanged, which is
 * what lets a caller fold a candidate once and reuse it across keystrokes.
 */
export function foldForMatch(text: string | null | undefined): string {
  if (!text) return "";
  return stripBidiControls(text)
    .normalize("NFD")
    .replace(COMBINING, "")
    .replace(TATWEEL, "")
    .replace(ALEF_WASLA, ALEF)
    .replace(ALEF_MAQSURA, YEH)
    .replace(TEH_MARBUTA, HEH)
    .replace(ARABIC_DIGITS, asciiDigit)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold a query and drop the "@" readers type out of habit.
 *
 * The "@" is removed *after* folding so that whitespace and bidi controls
 * around it cannot hide it: " @Reem " and U+2068 + "@reem" both come out as
 * "reem".
 */
export function normalizeQuery(raw: string | null | undefined): string {
  return foldForMatch(raw).replace(/^@+/, "");
}

/** An account's handle in comparison form: no "@", folded, lowercased. */
export function normalizeHandle(username: string | null | undefined): string {
  return normalizeQuery(username);
}

/**
 * Whether a query could be an X handle, and so is worth an exact lookup.
 *
 * X handles are ASCII letters, digits and underscore, at most 15 characters.
 * Anything else -- a phrase, Arabic, a space -- cannot resolve to an account, so
 * asking the provider about it would be a round trip guaranteed to fail.
 */
export function looksLikeHandle(raw: string): boolean {
  return /^@?[A-Za-z0-9_]{1,15}$/.test(raw.trim());
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Why a candidate matched, best first.
 *
 * Ranking is the whole point of returning a tier rather than a boolean: with a
 * one or two character query almost everything matches by substring, and an
 * unranked list buries the account whose handle the reader is halfway through
 * typing under twenty accidental hits.
 */
export const MatchTier = {
  ExactHandle: 0,
  ExactName: 1,
  HandlePrefix: 2,
  NamePrefix: 3,
  HandleWord: 4,
  NameWord: 5,
  HandleContains: 6,
  NameContains: 7,
} as const;

export type MatchTierValue = (typeof MatchTier)[keyof typeof MatchTier];

/** True when any word of `text` starts with `query`. */
function hasWordStartingWith(text: string, query: string): boolean {
  if (!text) return false;
  return text
    .split(NON_WORD)
    .some((word) => word.length > 0 && word.startsWith(query));
}

/**
 * How well one account answers one query, or `null` for no match at all.
 *
 * `query` must already be normalised -- callers fold once per keystroke rather
 * than once per candidate.
 */
export function scoreAccount(
  account: MatchCandidate,
  query: string,
): MatchTierValue | null {
  if (!query) return null;

  const handle = normalizeHandle(account.username);
  const name = foldForMatch(account.displayName);

  if (handle && handle === query) return MatchTier.ExactHandle;
  if (name && name === query) return MatchTier.ExactName;
  if (handle.startsWith(query)) return MatchTier.HandlePrefix;
  if (name.startsWith(query)) return MatchTier.NamePrefix;
  // "reem_codes" is two words to a reader typing "codes"; so is a display name
  // that mixes scripts, where the Latin half often sits at the end.
  if (hasWordStartingWith(handle, query)) return MatchTier.HandleWord;
  if (hasWordStartingWith(name, query)) return MatchTier.NameWord;
  if (handle.includes(query)) return MatchTier.HandleContains;
  if (name.includes(query)) return MatchTier.NameContains;
  return null;
}

/** Whether an account answers a *raw*, un-normalised query at all. */
export function accountMatches(account: MatchCandidate, raw: string): boolean {
  return scoreAccount(account, normalizeQuery(raw)) !== null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * One account per handle, keeping the fullest record.
 *
 * The suggestion pool is assembled from five sources that overlap heavily -- the
 * same account is usually in Following, in the feed and in the bookmarks -- and
 * the copies are not equally complete. A quoted post's author carries a handle
 * and a display name and nothing else, so first-wins would show a suggestion
 * with no avatar while a full record sat one source away.
 *
 * Order is preserved: the winner keeps the position of the first copy seen, so
 * the caller's source priority survives deduplication.
 */
export function dedupeAccounts<T extends MatchCandidate>(
  accounts: readonly T[],
): T[] {
  const byHandle = new Map<string, T>();
  for (const account of accounts) {
    const key = normalizeHandle(account.username);
    if (!key) continue;
    const existing = byHandle.get(key);
    if (!existing) {
      byHandle.set(key, account);
      continue;
    }
    if (richness(account) > richness(existing)) byHandle.set(key, account);
  }
  return [...byHandle.values()];
}

/** How much of an account record is actually filled in. */
function richness(account: MatchCandidate): number {
  return (account.avatarUrl ? 2 : 0) + (account.displayName?.trim() ? 1 : 0);
}

/** How many suggestions a list shows at once. Beyond this it stops being one. */
export const MAX_SUGGESTIONS = 8;

/**
 * The accounts that answer a query, best first.
 *
 * Stable within a tier: candidates that scored the same keep the order they
 * were given in, so the caller's source priority (Following before feed before
 * bookmarks) decides ties rather than an arbitrary sort.
 */
export function matchAccounts<T extends MatchCandidate>(
  accounts: readonly T[],
  raw: string,
  limit: number = MAX_SUGGESTIONS,
): T[] {
  const query = normalizeQuery(raw);
  if (!query) return [];

  const scored: { account: T; tier: MatchTierValue; at: number }[] = [];
  let at = 0;
  for (const account of dedupeAccounts(accounts)) {
    const tier = scoreAccount(account, query);
    if (tier !== null) scored.push({ account, tier, at: at++ });
  }

  scored.sort((a, b) => a.tier - b.tier || a.at - b.at);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.account);
}
