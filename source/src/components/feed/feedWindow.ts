/** Extra rows are bounded regardless of swipe velocity or total feed length. */
export function feedWindow(start: number, end: number, count: number, up: boolean, pixelsPerMs: number, mode: 'balanced' | 'fast' | 'battery' | 'ultra' = 'balanced'): number[] {
  const lead = mode === 'ultra' ? 16 : mode === 'battery' ? 4 : mode === 'fast' || pixelsPerMs > 2 ? 12 : 6;
  const trail = mode === 'ultra' ? 6 : mode === 'battery' ? 2 : mode === 'fast' || pixelsPerMs > 2 ? 4 : 3;
  const first = Math.max(0, start - (up ? lead : trail));
  const last = Math.min(count - 1, end + (up ? trail : lead));
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
}
