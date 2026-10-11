/**
 * Playback state shared between video cards, for this run only.
 *
 * Everything here lives in module scope and nowhere else — no browser storage
 * API of any kind, and nothing in the database. The whole app persists nothing
 * about what was read or watched, and a remembered volume would be the first
 * crack in that. Closing the window loses it, which is the intended behaviour
 * rather than a limitation. `src/checks/persistence.test.ts` enforces this
 * across the tree.
 */

/**
 * The one video element that is currently allowed to play.
 *
 * A long virtualized feed may mount several players, but only one decoder is
 * allowed to run at a time. The active `current` element is the one selected
 * by the reader's most recent deliberate play action, or the first autoplayed
 * element when no video has been chosen yet.
 */
const active = new Set<HTMLVideoElement>();
let current: HTMLVideoElement | null = null;

/**
 * Make a video the main player after a deliberate reader action.
 *
 * Pause and release every other player before granting the claim. This keeps
 * one active decoder and one active network stream even when a page renders a
 * runway of nearby cards.
 */
export function claimPlayback(el: HTMLVideoElement): void {
  for (const other of [...active]) {
    if (other === el) continue;
    other.pause();
    active.delete(other);
  }
  active.add(el);
  current = el;
}

/** Register a visible, muted autoplay when no other video owns the slot. */
export function registerAutoplay(el: HTMLVideoElement): boolean {
  if (active.size > 0 && !active.has(el)) return false;
  active.add(el);
  current = el;
  return true;
}

/** Give up the claim, if this element still holds it. */
export function releasePlayback(el: HTMLVideoElement): void {
  active.delete(el);
  if (current !== el) return;
  current = null;
}

/** Test seam — resets the module between cases. */
export function resetPlayback(): void {
  active.clear();
  current = null;
}

export function currentlyPlaying(): HTMLVideoElement | null {
  return current;
}
export function pauseAllPlayback(): void {
  for (const el of [...active]) el.pause();
  active.clear(); current = null;
}

// ---------------------------------------------------------------------------
// Audio preferences, session-scoped
// ---------------------------------------------------------------------------

let volume = 1;
let muted = false;

export function sessionVolume(): number {
  return volume;
}

export function sessionMuted(): boolean {
  return muted;
}

export function rememberVolume(v: number): void {
  // Clamped rather than trusted: a slider bound to a stale ref can briefly
  // report NaN, and assigning that to `.volume` throws.
  volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

export function rememberMuted(m: boolean): void {
  muted = m;
}

export function resetAudioPreferences(): void {
  volume = 1;
  muted = false;
}

/**
 * Whether the user has asked for reduced motion.
 *
 * Animated GIFs autoplay by default because that is what a GIF is; when this is
 * true they hold on their first frame until played deliberately.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
