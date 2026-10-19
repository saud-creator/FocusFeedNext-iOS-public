import type { Dir } from "./types";

/**
 * Per-content direction detection.
 *
 * This supersedes the simpler `isRtlText` in `src/lib/utils.ts`, which answers
 * "does this string contain any RTL character?" - a question that gets the
 * direction wrong for an English sentence quoting one Arabic word, and wrong
 * again for an Arabic post that happens to open with "@handle" or a URL.
 *
 * The rule here is the Unicode first-strong rule, applied after the parts that
 * carry no real direction have been removed: URLs, @mentions and #hashtags are
 * ASCII-shaped wrappers around otherwise neutral content, and digits, emoji,
 * punctuation and combining marks are not strong in either direction.
 *
 * This file is deliberately pure ASCII: ranges are numeric code points and the
 * bidi controls are built with `String.fromCharCode`. The previous RTL range in
 * `utils.ts` was written with literal characters and silently stopped matching
 * Arabic when the file round-tripped through another encoding - a bug only RTL
 * users ever saw. Do not paste literal Arabic or control characters in here.
 */

/** Bare URLs, including scheme-less "www." forms. */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** "@handle" - X handles are ASCII, so a mention never signals direction. */
const MENTION_RE = /(^|[^\p{L}\p{N}_])@[A-Za-z0-9_]{1,20}/gu;

/** "#tag" in any script: a hashtag is a label, not the body of the sentence. */
const HASHTAG_RE = /(^|[^\p{L}\p{N}_])#[\p{L}\p{N}_]+/gu;

/** Any letter in any script. Digits, emoji, marks and punctuation are excluded. */
const ANY_LETTER = /\p{L}/u;

/**
 * Code point ranges holding strong right-to-left letters.
 *
 * U+0590..U+08FF is contiguous and covers Hebrew, Arabic, Syriac, Arabic
 * Supplement, Thaana, NKo, Samaritan, Mandaic, Syriac Supplement and Arabic
 * Extended-A/B. The two tails are the Hebrew and Arabic presentation forms.
 */
const RTL_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
];

function isStrongRtl(codePoint: number): boolean {
  for (const [low, high] of RTL_RANGES) {
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

/** LRM, RLM, the embeddings/overrides (U+202A..U+202E) and the isolates. */
function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/** Bidi control characters, for embedding one direction inside another. */
export const BIDI_ISOLATE_CHARS = {
  /** Left-to-right isolate, U+2066. */
  LRI: String.fromCharCode(0x2066),
  /** Right-to-left isolate, U+2067. */
  RLI: String.fromCharCode(0x2067),
  /** First-strong isolate, U+2068: let the renderer decide from the content. */
  FSI: String.fromCharCode(0x2068),
  /** Pop directional isolate, U+2069: closes LRI, RLI or FSI. */
  PDI: String.fromCharCode(0x2069),
  /** Left-to-right mark, U+200E. */
  LRM: String.fromCharCode(0x200e),
  /** Right-to-left mark, U+200F. */
  RLM: String.fromCharCode(0x200f),
} as const;

/**
 * Direction of a piece of content, by the first strong letter that is actually
 * part of the prose. Returns "ltr" when nothing in the string is directional
 * (empty text, digits only, emoji only).
 */
export function detectDirection(text: string): Dir {
  if (typeof text !== "string" || text.length === 0) return "ltr";

  const prose = text
    .replace(URL_RE, " ")
    // The capture group preserves the boundary character, which may itself be
    // the first strong letter of the sentence.
    .replace(MENTION_RE, "$1 ")
    .replace(HASHTAG_RE, "$1 ");

  for (const ch of prose) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined || isBidiControl(codePoint)) continue;
    if (!ANY_LETTER.test(ch)) continue;
    return isStrongRtl(codePoint) ? "rtl" : "ltr";
  }

  return "ltr";
}

/**
 * Wrap `text` in a bidi isolate so it cannot reorder the sentence around it.
 * Without an explicit direction a first-strong isolate lets the renderer
 * decide - the right choice for user content interpolated into a template.
 */
export function isolate(text: string, dir?: Dir): string {
  const open =
    dir === "rtl"
      ? BIDI_ISOLATE_CHARS.RLI
      : dir === "ltr"
        ? BIDI_ISOLATE_CHARS.LRI
        : BIDI_ISOLATE_CHARS.FSI;
  return `${open}${text}${BIDI_ISOLATE_CHARS.PDI}`;
}

/** Remove any bidi control characters, for text going into a plain-text sink. */
export function stripBidiControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint !== undefined && isBidiControl(codePoint)) continue;
    out += ch;
  }
  return out;
}
