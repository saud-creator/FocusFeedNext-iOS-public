/** Only ordinary web destinations may leave the reader. */
export function externalUrl(value: string): string | null {
  if (value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

/** Sentence punctuation is not part of a link; balanced URL parentheses are. */
export function trimUrlPunctuation(value: string): string {
  let url = value.replace(/[.,!?;:،؛؟]+$/u, '');
  while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1);
  return url;
}
