import { create } from 'zustand';
import { api, isTauri } from './api';
import { useAppStore, type Preferences } from '@/stores/useAppStore';
import { pauseAllPlayback } from './mediaSession';

export interface RuntimeSnapshot {
  foreground: boolean;
  wifi: boolean;
  expensive: boolean;
  constrained: boolean;
  lowPower: boolean;
  thermal: 'nominal' | 'fair' | 'serious' | 'critical';
  reduceMotion: boolean;
  reduceTransparency: boolean;
  contentSizeScale: number;
  memoryRevision: number;
}
export const defaultRuntime: RuntimeSnapshot = {
  foreground: true, wifi: true, expensive: false, constrained: false,
  lowPower: false, thermal: 'nominal', reduceMotion: false,
  reduceTransparency: false, contentSizeScale: 1, memoryRevision: 0,
};
export const useRuntimeStore = create<{ snapshot: RuntimeSnapshot }>(() => ({ snapshot: defaultRuntime }));

export function effectivePolicy(prefs: Preferences, runtime: RuntimeSnapshot, ios: boolean) {
  const hot = runtime.thermal === 'serious' || runtime.thermal === 'critical';
  const saving = prefs.performanceMode === 'battery' || runtime.lowPower || hot;
  const mode = saving ? 'battery' : prefs.performanceMode;
  const speculative = runtime.foreground && !runtime.constrained && !runtime.lowPower && !hot;
  const autoplay = runtime.foreground && !runtime.reduceMotion && !runtime.constrained && !saving &&
    (prefs.autoplay === 'any' || (prefs.autoplay === 'wifi' && runtime.wifi && !runtime.expensive));
  return {
    mode, speculative, autoplay, foreground: runtime.foreground,
    imageMargin: speculative ? (mode === 'ultra' ? 900 : mode === 'fast' ? 700 : mode === 'battery' ? 200 : 350) : 0,
    screensAhead: mode === 'ultra' || mode === 'fast' ? 3 : mode === 'battery' ? 1 : 2,
    videoQuality: prefs.videoQuality === 'auto'
      ? (saving ? '360' : runtime.expensive || !runtime.wifi ? '480' : '720') as '360' | '480' | '720'
      : prefs.videoQuality,
    cleanup: ios || prefs.videoOffscreenCleanup,
    reason: !runtime.foreground ? 'background' : hot ? 'thermal' : runtime.lowPower ? 'lowPower' : runtime.constrained ? 'lowData' : 'normal',
  };
}

let initialized = false;
export function startRuntime() {
  if (initialized) return;
  initialized = true;
  const publish = (patch: Partial<RuntimeSnapshot>) => {
    if (patch.foreground === false) { pauseAllPlayback(); if (isTauri()) void api.cancelNativeReads().catch(() => {}); }
    useRuntimeStore.setState(state => ({ snapshot: { ...state.snapshot, ...patch } }));
  };
  // Native lifecycle is authoritative on iOS: presenting sign-in or an OS sheet
  // may hide the reader document without backgrounding the application.
  const nativeIos = isTauri() && /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const visibility = () => { if (!nativeIos) publish({ foreground: document.visibilityState === 'visible' }); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pageshow', visibility);
  window.addEventListener('ffn-runtime', event => publish((event as CustomEvent<RuntimeSnapshot>).detail));
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) publish({ wifi: false });
  publish({ foreground: nativeIos || document.visibilityState === 'visible', reduceMotion: motion.matches });
  motion.addEventListener('change', () => publish({ reduceMotion: motion.matches }));
  if (isTauri()) void api.runtimeSnapshot().then(publish).catch(() => {});
}

export function useEffectivePolicy(ios = false) {
  const prefs = useAppStore(state => state.prefs);
  const runtime = useRuntimeStore(state => state.snapshot);
  return effectivePolicy(prefs, runtime, ios);
}
