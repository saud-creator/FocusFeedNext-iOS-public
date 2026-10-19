/**
 * Clock text for a player.
 *
 * Hours appear only when there are any: `0:07` for a seven-second clip and
 * `1:02:33` for a long one, rather than a permanent `00:00:07` that makes every
 * short video look like a recording of a meeting. Anything unknown — which is
 * what a `<video>` reports before metadata arrives, and what jsdom reports
 * always — reads as zero rather than `NaN:aN`.
 */
export function formatClock(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
