import { useEffect, useSyncExternalStore } from "react";
import { api, type SessionSnapshot } from "@/lib/api";
import { useAppStore } from "@/stores/useAppStore";

/**
 * Startup lifecycle and connection monitoring.
 *
 * The guarantee this file exists to make is "one connection test per launch,
 * and no authenticated request before it says yes". That cannot live in a
 * component: Strict Mode mounts every component twice in development, the
 * connection area is mounted by every page header, and 0.2.x had the shell and
 * the feed screen each firing their own startup work with no knowledge of the
 * other. So the state machine is module-scoped and the React hooks below are
 * only windows onto it.
 *
 * Nothing here blocks paint. The shell renders, the chip says "checking", and
 * the answer arrives when it arrives.
 */

/** How often the monitor re-checks, when it is on and the window is visible. */
const AUTO_CHECK_MS = 5 * 60_000;
let monitoringIntervalMs = AUTO_CHECK_MS;
/** Poll the cheap snapshot while Rust's launch-time probe owns the worker. */
const JOIN_CHECK_MS = 100;
const JOIN_CHECK_TIMEOUT_MS = 60_000;

export type StartupPhase = "checking" | "ready" | "failed";

export interface StartupState {
  phase: StartupPhase;
  /** The last snapshot the lifecycle obtained. `null` until the first answer. */
  snapshot: SessionSnapshot | null;
  /**
   * Counts confirmed-good sessions, not renders and not checks.
   *
   * A page refreshes when this changes, so one working session produces one
   * refresh however many times the page re-renders, and a monitoring tick that
   * merely confirms what we already knew produces none at all.
   */
  readyToken: number;
}

const INITIAL: StartupState = {
  phase: "checking",
  snapshot: null,
  readyToken: 0,
};

let state: StartupState = INITIAL;
const listeners = new Set<() => void>();

let started = false;
let shuttingDown = false;
let nativeForeground = true;
let autoCheck = true;
let timer: ReturnType<typeof setInterval> | null = null;
/** The check currently in flight, so a second caller joins it. */
let pending: Promise<SessionSnapshot | null> | null = null;

function emit(next: StartupState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Record what a completed check found.
 *
 * Green is the only verdict that permits an authenticated request: it means the
 * last provider call actually worked. Degraded, expired and disconnected all
 * mean a refresh would at best be a second failure and at worst a wasted
 * subprocess against a session X has already rejected.
 */
function apply(snapshot: SessionSnapshot | null): void {
  const ok = snapshot?.state === "connected";
  const wasReady = state.phase === "ready";
  emit({
    phase: ok ? "ready" : "failed",
    snapshot: snapshot ?? state.snapshot,
    // Only a transition *into* a working session earns a refresh.
    readyToken: ok && !wasReady ? state.readyToken + 1 : state.readyToken,
  });
}

/** Publish a snapshot obtained outside the monitor, such as Settings. */
export function acceptSessionSnapshot(snapshot: SessionSnapshot): void {
  apply(snapshot);
}

/** A newly connected identity always earns a new feed generation. */
export function acceptConnectedSession(snapshot: SessionSnapshot): void {
  const ok = snapshot.state === "connected";
  emit({
    phase: ok ? "ready" : "failed",
    snapshot,
    readyToken: ok ? state.readyToken + 1 : state.readyToken,
  });
}

async function settledCheck(force: boolean): Promise<SessionSnapshot> {
  let snapshot = await api.checkSession(force);
  const deadline = Date.now() + JOIN_CHECK_TIMEOUT_MS;
  // The backend deliberately refuses to spawn a second twitter-cli process.
  // Its immediate answer can therefore be an in-progress snapshot owned by
  // the launch thread. Join that work by polling the cheap in-memory snapshot
  // instead of misclassifying the transient state as a failed session.
  while (
    (snapshot.checking ||
      (snapshot.hasCredentials && snapshot.reason === "not_checked")) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, JOIN_CHECK_MS));
    snapshot = await api.checkSession(false);
  }
  return snapshot;
}

/**
 * Run one check, or join the one already running.
 *
 * The backend refuses a concurrent probe anyway; this exists so the interface
 * does not show two spinners for one `twitter.exe`, and so a caller that joins
 * still gets an answer rather than silence.
 */
function runCheck(force: boolean): Promise<SessionSnapshot | null> {
  if (pending) return pending;
  if (shuttingDown) return Promise.resolve(state.snapshot);

  const run = settledCheck(force)
    .then((snapshot) => {
      apply(snapshot);
      return snapshot;
    })
    .catch(() => {
      // A check that could not even be attempted is a failed check. The chip
      // reports it and, crucially, no authenticated request follows.
      apply(null);
      return null;
    });

  pending = run.finally(() => {
    pending = null;
  });
  return pending;
}

/** True when something already proved the session works inside this window. */
function healthIsFresh(snapshot: SessionSnapshot | null): boolean {
  const times = [snapshot?.lastSuccessAt, snapshot?.checkedAt]
    .map((iso) => (iso ? Date.parse(iso) : Number.NaN))
    .filter((ms) => Number.isFinite(ms));
  if (times.length === 0) return false;
  return Date.now() - Math.max(...times) < monitoringIntervalMs;
}

function isVisible(): boolean {
  return nativeForeground && (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

function stopMonitor(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * (Re)arm the monitor.
 *
 * The timer only exists while the window is visible and monitoring is on, so a
 * minimised window is not merely skipping ticks — it has no timer at all.
 */
function armMonitor(): void {
  stopMonitor();
  if (!autoCheck || shuttingDown || !isVisible()) return;
  timer = setInterval(() => void monitorTick(), monitoringIntervalMs);
}

async function monitorTick(): Promise<void> {
  // Re-asked at the moment of firing as well as when arming: a window hidden
  // between ticks must not get one last probe in on its way out.
  if (!autoCheck || shuttingDown || !isVisible()) return;
  // A provider request that already succeeded inside this window is exactly the
  // evidence the probe would go looking for. The backend applies the same rule
  // — this side simply avoids the round trip that would learn it.
  if (healthIsFresh(state.snapshot)) return;
  await runCheck(false);
}

function onVisibilityChange(): void {
  armMonitor();
}
function onResume(): void { shuttingDown = false; armMonitor(); }
function onRuntime(event: Event): void {
  const wasForeground = nativeForeground;
  nativeForeground = (event as CustomEvent<{ foreground: boolean }>).detail.foreground;
  armMonitor();
  if (!wasForeground && nativeForeground && state.phase === 'failed' && state.snapshot?.hasCredentials &&
      !['auth_failed','no_credentials','rate_limited','tool_missing'].includes(state.snapshot.reason)) void runCheck(true);
}

/** Closing means closing: no probe may outlive the window it belongs to. */
function onShutdown(): void {
  shuttingDown = true;
  stopMonitor();
}

/**
 * Begin the sequence. Idempotent, and deliberately so — a Strict Mode double
 * mount, a second page header and a re-render all land here.
 */
export function startStartupSequence(): void {
  if (started) return;
  started = true;

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", onShutdown);
    window.addEventListener("pagehide", onShutdown);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('ffn-runtime', onRuntime);
  }

  // Unforced: a webview reload restarts this module but not the Rust process,
  // and the backend answering from its own snapshot is the correct outcome
  // there. On a genuine launch nothing has been checked, so it probes.
  void runCheck(false).finally(armMonitor);
}

/** Run the check the reader asked for, past the backend's own interval. */
export function runConnectionTest(): Promise<SessionSnapshot | null> {
  return runCheck(true);
}

/** Turn the 5-minute monitor on or off. Driven by `monitoring.autoCheck`. */
export function setAutoCheck(on: boolean): void {
  if (autoCheck === on) return;
  autoCheck = on;
  if (started) armMonitor();
}
export function setMonitoringInterval(minutes: number): void {
  const next = Math.max(1, Math.min(60, Number.isFinite(minutes) ? minutes : 5)) * 60_000;
  if (next === monitoringIntervalMs) return;
  monitoringIntervalMs = next;
  if (started) armMonitor();
}

/**
 * The lifecycle, started if it has not been already.
 *
 * Call this from anything that is always on screen. Calling it from several
 * places at once is the expected case, not a mistake.
 */
export function useStartupSequence(): StartupState {
  const monitoringOn = useAppStore((s) => s.prefs.autoCheckConnection);
  const interval = useAppStore(s => s.prefs.monitorIntervalMinutes);

  useEffect(() => {
    startStartupSequence();
  }, []);

  useEffect(() => {
    setAutoCheck(monitoringOn);
  }, [monitoringOn]);
  useEffect(() => setMonitoringInterval(interval), [interval]);

  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * Read-only view for screens that must wait for a working session before
 * issuing an authenticated request.
 */
export function useSessionReady(): StartupState {
  useEffect(() => {
    // Started here too, so a page that renders without a connection area still
    // gets a session — and still exactly one check.
    startStartupSequence();
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * Return the module to its pre-launch state.
 *
 * Test-only. Module scope is what makes the "exactly once" guarantee hold in
 * the app, and it is also what would otherwise leak one test's session into the
 * next test in the same file.
 */
export function resetStartupSequenceForTests(): void {
  stopMonitor();
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", onShutdown);
    window.removeEventListener("pagehide", onShutdown);
    window.removeEventListener('pageshow', onResume);
    window.removeEventListener('ffn-runtime', onRuntime);
  }
  state = INITIAL;
  started = false;
  shuttingDown = false;
  autoCheck = true;
  nativeForeground = true;
  monitoringIntervalMs = AUTO_CHECK_MS;
  pending = null;
  listeners.clear();
}
