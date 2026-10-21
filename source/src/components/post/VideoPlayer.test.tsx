import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PostMedia } from "@/lib/api";
import * as apiModule from '@/lib/api';
import {waitFor} from '@testing-library/react';
import { VideoPlayer } from "./VideoPlayer";
import { MediaGallery } from "./MediaGallery";
import { renderWithProviders } from "@/test/factories";
import { resetAudioPreferences, resetPlayback } from "@/lib/mediaSession";
import { defaultPreferences, useAppStore } from "@/stores/useAppStore";
import { CONTROLS_IDLE_MS } from "@/components/media/useAutoHideControls";

const CLIP = "https://cdn.example.com/clip.mp4";

describe('registered media recovery',()=>{
  it('retries registered bytes even if the optional fresh-post request fails',async()=>{
    const recover=vi.fn().mockRejectedValue(new Error('provider busy'));
    renderWithProviders(<VideoPlayer media={video()} onRecover={recover}/>);
    const failed=element();fireEvent.error(failed);
    await userEvent.click(screen.getByRole('button',{name:'Retry video'}));
    await waitFor(()=>expect(element()).not.toBe(failed));
    fireEvent.loadedMetadata(element());
    expect(screen.getByRole('button',{name:'Play'})).toBeEnabled();
    expect(recover).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('refreshes a refused source once without replaying an account write',async()=>{
    vi.spyOn(apiModule,'isTauri').mockReturnValue(true);
    const probe=vi.spyOn(apiModule.api,'probeMedia').mockResolvedValue(403);
    const recover=vi.fn().mockResolvedValue(undefined);
    const url='http://127.0.0.1:9876/media/'+'a'.repeat(32)+'/'+'b'.repeat(32);
    renderWithProviders(<VideoPlayer media={video({url})} onRecover={recover}/>);
    const first=element();fireEvent.error(first);
    await waitFor(()=>expect(element()).not.toBe(first));
    expect(recover).toHaveBeenCalledExactlyOnceWith(true);
    fireEvent.error(element());await waitFor(()=>expect(probe).toHaveBeenCalledTimes(2));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button',{name:'Retry video'})).toBeEnabled();
  });
  it('provides deliberate recovery when the proxy supplied no video source',async()=>{
    const recover=vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<VideoPlayer media={video({url:''})} onRecover={recover}/>);
    await userEvent.click(screen.getByRole('button',{name:'Retry video'}));
    expect(recover).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('settles a visible stalled load instead of buffering forever',()=>{
    vi.useFakeTimers();
    renderWithProviders(<VideoPlayer media={video()}/>);
    fireEvent.loadStart(element());
    act(()=>vi.advanceTimersByTime(20001));
    expect(screen.getByRole('button',{name:'Retry video'})).toBeEnabled();
    expect(surface()).toHaveStyle({height:'160px'});
    vi.useRealTimers();
  });

  it('allows a genuinely refreshed source to clear a terminal failure',()=>{
    useAppStore.setState({prefs:{...defaultPreferences,autoplay:'off'}});
    const view=renderWithProviders(<VideoPlayer media={video()}/>);
    fireEvent.error(element());
    fireEvent.loadStart(element());
    expect(screen.getByRole('button',{name:'Retry video'})).toBeInTheDocument();
    view.rerender(<VideoPlayer media={video({url:'https://cdn.example.com/refreshed.mp4'})}/>);
    fireEvent.loadStart(element());fireEvent.loadedMetadata(element());
    expect(screen.queryByRole('button',{name:'Retry video'})).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Play'})).toBeInTheDocument();
  });
  it('keeps recovery visible when WebKit pauses a failed video',()=>{
    renderWithProviders(<VideoPlayer media={video()}/>);
    fireEvent.error(element());
    expect(screen.getByRole('button',{name:'Retry video'})).toBeInTheDocument();
    fireEvent.pause(element());
    scrollTo(false);expect(screen.queryByTestId('video-element')).not.toBeInTheDocument();
    scrollTo(true);
    fireEvent.loadStart(element());
    fireEvent.waiting(element());
    fireEvent.loadedMetadata(element());
    fireEvent.playing(element());
    expect(screen.getByRole('button',{name:'Retry video'})).toBeInTheDocument();
    expect(surface()).toHaveStyle({height:'160px'});
  });
  it('tries one real lower rendition when a reachable best source cannot decode',async()=>{
    useAppStore.setState({prefs:{...defaultPreferences,videoQuality:'best'}});
    vi.spyOn(apiModule,'isTauri').mockReturnValue(true);
    vi.spyOn(apiModule.api,'probeMedia').mockResolvedValue(200);
    const high='http://127.0.0.1:9876/media/'+'a'.repeat(32)+'/'+'b'.repeat(32);
    const low='http://127.0.0.1:9876/media/'+'a'.repeat(32)+'/'+'c'.repeat(32);
    renderWithProviders(<VideoPlayer media={video({url:high,variants:[{url:high,label:'1080p',bitrate:4000000},{url:low,label:'480p',bitrate:500000}]})}/>);
    Object.defineProperty(element(),'error',{configurable:true,value:{code:4}});
    fireEvent.error(element());
    await waitFor(()=>expect(element().getAttribute('src')).toBe(low));
  });
  it('uses native diagnostics when browser fetch is unavailable and renews a stale registration once',async()=>{
    vi.spyOn(apiModule,'isTauri').mockReturnValue(true);
    const probe=vi.spyOn(apiModule.api,'probeMedia').mockResolvedValue(404);
    const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new TypeError('opaque origin'));
    const recover=vi.fn().mockResolvedValue(undefined);
    const url='http://127.0.0.1:9876/media/'+'a'.repeat(32)+'/'+'b'.repeat(32);
    renderWithProviders(<VideoPlayer media={video({url})} onRecover={recover}/>);
    const firstAttempt=element();
    fireEvent.error(firstAttempt);await waitFor(()=>expect(recover).toHaveBeenCalledWith(false));
    // The first renewal must settle and mount its fresh attempt before the
    // fixture injects a second failure into that attempt.
    await waitFor(()=>expect(element()).not.toBe(firstAttempt));
    expect(probe).toHaveBeenCalledWith(url);expect(fetch).not.toHaveBeenCalled();
    fireEvent.error(element());await waitFor(()=>expect(screen.getByRole('button',{name:'Retry video'})).toBeEnabled());
    expect(recover).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button',{name:'Retry video'}));
    await waitFor(()=>expect(recover).toHaveBeenLastCalledWith(true));
  });
});

function video(over: Partial<PostMedia> = {}): PostMedia {
  return {
    kind: "video",
    url: CLIP,
    previewUrl: null,
    width: 1280,
    height: 720,
    alt: "A demo capture",
    // A minute, so the clock reads across both fields and a five-second seek
    // lands somewhere real.
    durationMs: 60_000,
    variants: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
/** Every IntersectionObserver callback this render created. */
let observers: Array<(entries: { isIntersecting: boolean }[]) => void> = [];
const OriginalIO = window.IntersectionObserver;

beforeEach(() => {
  resetPlayback();
  resetAudioPreferences();
  useAppStore.setState({ prefs: { ...defaultPreferences } });
  // jsdom implements no playback, so the shared stubs in src/test/setup.ts are
  // already mock functions; spying on one returns that same mock rather than a
  // fresh one, and its call history would otherwise run on into the next case.
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  play.mockClear();
  pause.mockClear();

  observers = [];
  window.IntersectionObserver = class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      observers.push(cb);
    }
    root = null;
    rootMargin = "";
    thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof window.IntersectionObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.IntersectionObserver = OriginalIO;
});

/** Move the card in or out of the viewport. */
function scrollTo(onScreen: boolean) {
  act(() => {
    for (const cb of observers) cb([{ isIntersecting: onScreen }]);
  });
}

const surface = () => screen.getByTestId("video-surface");
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;

/**
 * Enter fullscreen the way a reader does.
 *
 * jsdom implements no Fullscreen API at all, so `requestFullscreen` is absent
 * and the player falls back to laying itself over the window — which is the
 * same path a view that refuses the request takes, and exactly the one worth
 * exercising by default.
 */
async function goFullscreen(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("video-enter-fullscreen"));
  return screen.findByTestId("video-fullscreen-controls");
}

/**
 * Enough of the Fullscreen API for the path the product actually takes.
 *
 * WebView2 grants these requests; jsdom has none of them. Without this stub
 * every case above would exercise only the fallback, and the one thing that
 * makes the custom chrome possible — fullscreening the *frame* rather than the
 * `<video>`, which would hand the display to the browser's own controls —
 * would go unchecked.
 */
function installFullscreenApi() {
  let element: Element | null = null;
  let target: Element | null = null;
  const grant = (el: Element) => {
    element = el;
    target = el;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  const request = vi.fn(function (this: Element) {
    // Not an arrow: the API is called as a method, and which element it was
    // called on is the thing under test.
    grant(this);
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    element = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  Object.defineProperty(Element.prototype, "requestFullscreen", {
    configurable: true,
    writable: true,
    value: request,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => element,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    writable: true,
    value: exit,
  });
  return {
    request,
    exit,
    askedFor: () => target,
    /** The browser leaving fullscreen on its own — Escape, or the window. */
    browserExit: () =>
      act(() => {
        element = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      }),
    uninstall: () => {
      delete (Element.prototype as { requestFullscreen?: unknown })
        .requestFullscreen;
      delete (document as unknown as { fullscreenElement?: unknown })
        .fullscreenElement;
      delete (document as unknown as { exitFullscreen?: unknown })
        .exitFullscreen;
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * The complaint this sprint exists to answer.
 *
 * Fullscreen used to be the card's 2.5rem control strip stretched across a
 * display. These assertions are about the two layouts being different objects:
 * entering swaps one for the other rather than scaling it.
 */
describe("fullscreen is its own layout", () => {
  it("shows the compact bar and no fullscreen chrome to begin with", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    expect(screen.getByTestId("video-controls")).toBeInTheDocument();
    expect(
      screen.queryByTestId("video-fullscreen-controls"),
    ).not.toBeInTheDocument();
    expect(surface()).toHaveAttribute("data-fullscreen", "false");
  });

  it("replaces the compact bar entirely once fullscreen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);

    await goFullscreen(user);

    expect(screen.getByTestId("video-fullscreen-controls")).toBeInTheDocument();
    // The whole point: not both, and not the small one stretched.
    expect(screen.queryByTestId("video-controls")).not.toBeInTheDocument();
    expect(surface()).toHaveAttribute("data-fullscreen", "true");
  });

  it("carries the same <video> across, rather than mounting a second one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    const before = element();

    await goFullscreen(user);

    expect(screen.getAllByTestId("video-element")).toHaveLength(1);
    // Same node: a remount here would restart the clip and re-request it.
    expect(element()).toBe(before);
  });

  it("gives fullscreen the controls the card has no room for", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    // A wide seek bar with a buffered range behind it, a volume slider, a
    // clock, a speed control and an exit — none of which the compact bar has
    // room for at 11.5px.
    expect(screen.getByTestId("video-seek")).toBeInTheDocument();
    expect(screen.getByTestId("video-buffered")).toBeInTheDocument();
    expect(screen.getByTestId("video-volume")).toBeInTheDocument();
    expect(screen.getByTestId("video-fullscreen-speed")).toBeInTheDocument();
    expect(screen.getByTestId("video-exit-fullscreen")).toBeInTheDocument();
    expect(screen.getByTestId("video-fullscreen-time")).toHaveTextContent(
      "0:00 / 1:00",
    );
  });

  it("names the region and the exit control in words, not glyphs", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    expect(surface()).toHaveAccessibleName("Full screen video player");
    const exit = screen.getByTestId("video-exit-fullscreen");
    expect(exit).toHaveAccessibleName("Exit full screen");
    // Visible text as well as a label: an unlabelled corner icon over a black
    // screen is a guess.
    expect(exit).toHaveTextContent("Exit full screen");
  });

  it("draws the buffered range only as far as the bytes actually reach", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    const el = element();
    // A buffer that reaches 15s of a 60s clip, with the playhead inside it.
    Object.defineProperty(el, "buffered", {
      configurable: true,
      value: {
        length: 1,
        start: () => 0,
        end: () => 15,
      },
    });
    fireEvent.progress(el);

    expect(screen.getByTestId("video-buffered")).toHaveAttribute(
      "data-buffered",
      "25.00%",
    );
  });

  it("comes back to the compact bar when fullscreen ends", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    await user.click(screen.getByTestId("video-exit-fullscreen"));

    expect(screen.getByTestId("video-controls")).toBeInTheDocument();
    expect(
      screen.queryByTestId("video-fullscreen-controls"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("when the browser grants a real fullscreen", () => {
  let api: ReturnType<typeof installFullscreenApi>;

  beforeEach(() => {
    api = installFullscreenApi();
  });
  afterEach(() => api.uninstall());

  it("hands the frame to the browser, never the <video> itself", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);

    await user.click(screen.getByTestId("video-enter-fullscreen"));

    expect(api.request).toHaveBeenCalledTimes(1);
    // Fullscreening the element itself would give the display to the browser's
    // own controls and leave every control built here off screen.
    expect(api.askedFor()).toBe(surface());
    expect(api.askedFor()).not.toBe(element());
    expect(
      await screen.findByTestId("video-fullscreen-controls"),
    ).toBeInTheDocument();
  });

  it("fills the display rather than laying itself over the window", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await user.click(screen.getByTestId("video-enter-fullscreen"));
    await screen.findByTestId("video-fullscreen-controls");

    // The browser has already promoted the frame to the top layer, so pinning
    // it over the window as well would be fighting it.
    expect(surface()).not.toHaveClass("fixed");
    expect(surface()).toHaveClass("h-full");
  });

  it("follows the browser back out when it exits on its own", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await user.click(screen.getByTestId("video-enter-fullscreen"));
    await screen.findByTestId("video-fullscreen-controls");

    // Escape handled by the browser, or the window leaving fullscreen: the
    // keydown never reaches the player, so this is the only notice it gets.
    api.browserExit();

    expect(
      screen.queryByTestId("video-fullscreen-controls"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("video-controls")).toBeInTheDocument();
  });

  it("asks the document to exit when the exit control is used", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await user.click(screen.getByTestId("video-enter-fullscreen"));
    await screen.findByTestId("video-fullscreen-controls");

    await user.click(screen.getByTestId("video-exit-fullscreen"));

    expect(api.exit).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("video-fullscreen-controls"),
    ).not.toBeInTheDocument();
  });

  it("exits through the document on Escape as well", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await user.click(screen.getByTestId("video-enter-fullscreen"));
    await screen.findByTestId("video-fullscreen-controls");

    fireEvent.keyDown(surface(), { key: "Escape" });
    expect(api.exit).toHaveBeenCalledTimes(1);
  });
});

describe("inside the embedded shell", () => {
  it("uses the crash-safe in-app layout without calling the DOM API", async () => {
    const user = userEvent.setup();
    const api = installFullscreenApi();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    try {
      renderWithProviders(<VideoPlayer media={video()} />);
      await user.click(screen.getByTestId("video-enter-fullscreen"));
      await screen.findByTestId("video-fullscreen-controls");

      expect(api.request).not.toHaveBeenCalled();
      expect(surface()).toHaveClass("fixed");
      expect(surface()).toHaveAttribute("data-fullscreen", "true");
      // The fixed surface must escape the feed's animated/scrollable <main>,
      // not merely receive fixed styles while remaining inside it.
      expect(surface().parentElement?.parentElement).toBe(document.body);
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS?: unknown })
        .__TAURI_INTERNALS;
      api.uninstall();
    }
  });
});

// ---------------------------------------------------------------------------

describe("fullscreen controls get out of the way", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Fake timers and userEvent do not mix; the click is direct here. */
  function enterFullscreen() {
    fireEvent.click(screen.getByTestId("video-enter-fullscreen"));
    fireEvent.play(element());
    return screen.getByTestId("video-fullscreen-controls");
  }

  it("hides after a few seconds of stillness and returns on movement", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    const chrome = enterFullscreen();
    expect(chrome).toHaveAttribute("data-visible", "true");

    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS);
    });
    expect(screen.getByTestId("video-fullscreen-controls")).toHaveAttribute(
      "data-visible",
      "false",
    );

    fireEvent.pointerMove(surface());
    expect(screen.getByTestId("video-fullscreen-controls")).toHaveAttribute(
      "data-visible",
      "true",
    );
  });

  it("returns on any key, including one it does nothing with", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    enterFullscreen();
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS);
    });
    expect(screen.getByTestId("video-fullscreen-controls")).toHaveAttribute(
      "data-visible",
      "false",
    );

    fireEvent.keyDown(surface(), { key: "q" });
    expect(screen.getByTestId("video-fullscreen-controls")).toHaveAttribute(
      "data-visible",
      "true",
    );
  });

  it("hides again after the reader stops moving", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    enterFullscreen();
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS - 100);
    });
    fireEvent.pointerMove(surface());
    // The clock restarts rather than carrying on from where it was.
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS - 100);
    });
    expect(screen.getByTestId("video-fullscreen-controls")).toHaveAttribute(
      "data-visible",
      "true",
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId("video-fullscreen-controls")).toHaveAttribute(
      "data-visible",
      "false",
    );
  });

  it("never hides the compact bar, which has nothing to get out of the way of", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    act(() => {
      vi.advanceTimersByTime(CONTROLS_IDLE_MS * 3);
    });
    expect(screen.getByTestId("video-controls")).toBeInTheDocument();
  });

  it('keeps exit reachable while the transport controls fade',()=>{
    renderWithProviders(<VideoPlayer media={video()} />);
    enterFullscreen();
    act(()=>vi.advanceTimersByTime(CONTROLS_IDLE_MS));
    expect(screen.getByTestId('video-exit-fullscreen')).toHaveClass('pointer-events-auto');
    fireEvent.click(screen.getByTestId('video-exit-fullscreen'));
    expect(surface()).toHaveAttribute('data-fullscreen','false');
  });

  it('wakes hidden controls on a tap without pausing the video',()=>{
    renderWithProviders(<VideoPlayer media={video()} />);
    enterFullscreen();
    act(()=>vi.advanceTimersByTime(CONTROLS_IDLE_MS));
    fireEvent.click(surface());
    expect(pause).not.toHaveBeenCalled();
    expect(screen.getByTestId('video-fullscreen-controls')).toHaveAttribute('data-visible','true');
  });
});

// ---------------------------------------------------------------------------

/**
 * The keys are single letters and bare arrows, which is only safe because they
 * are scoped twice — to fullscreen, and to the player having focus — and
 * because every one of them is consumed. The application's own shortcuts are
 * Ctrl chords; a bare Space that escaped would scroll the feed behind the
 * video as well as pausing it.
 */
describe("the fullscreen keyboard", () => {
  it("does nothing at all before fullscreen", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    // Visible ordinary clips now autoplay muted. The keyboard must still do
    // nothing until fullscreen, so ignore the expected autoplay request.
    play.mockClear();
    const consumed = !fireEvent.keyDown(surface(), { key: " " });
    expect(consumed).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it("plays and pauses on Space, and consumes the event", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    play.mockClear();

    expect(fireEvent.keyDown(surface(), { key: " " })).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);

    // jsdom's element never actually starts, so playing state is imposed here.
    Object.defineProperty(element(), "paused", {
      configurable: true,
      value: false,
    });
    expect(fireEvent.keyDown(surface(), { key: " " })).toBe(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("seeks five seconds each way", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    expect(fireEvent.keyDown(surface(), { key: "ArrowRight" })).toBe(false);
    expect(screen.getByTestId("video-fullscreen-time")).toHaveTextContent(
      "0:05 / 1:00",
    );
    expect(element().currentTime).toBe(5);

    expect(fireEvent.keyDown(surface(), { key: "ArrowRight" })).toBe(false);
    expect(element().currentTime).toBe(10);

    expect(fireEvent.keyDown(surface(), { key: "ArrowLeft" })).toBe(false);
    expect(element().currentTime).toBe(5);
  });

  it("never seeks past either end", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    fireEvent.keyDown(surface(), { key: "ArrowLeft" });
    expect(element().currentTime).toBe(0);
    expect(screen.getByTestId("video-fullscreen-time")).toHaveTextContent(
      "0:00 / 1:00",
    );
  });

  it("moves the volume with the arrows", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    const slider = screen.getByTestId("video-volume") as HTMLInputElement;
    // Autoplay is muted by design; unmute before testing the audible volume
    // control itself.
    await user.click(screen.getByTestId("video-fullscreen-mute"));
    expect(slider.value).toBe("1");

    expect(fireEvent.keyDown(surface(), { key: "ArrowDown" })).toBe(false);
    expect((screen.getByTestId("video-volume") as HTMLInputElement).value).toBe(
      "0.9",
    );
    expect(element().volume).toBeCloseTo(0.9);

    expect(fireEvent.keyDown(surface(), { key: "ArrowUp" })).toBe(false);
    expect((screen.getByTestId("video-volume") as HTMLInputElement).value).toBe(
      "1",
    );
  });

  it("mutes on M", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    expect(screen.getByTestId("video-fullscreen-mute")).toHaveAccessibleName(
      "Unmute",
    );

    expect(fireEvent.keyDown(surface(), { key: "m" })).toBe(false);
    expect(screen.getByTestId("video-fullscreen-mute")).toHaveAccessibleName(
      "Mute",
    );
    expect(element().muted).toBe(false);

    fireEvent.keyDown(surface(), { key: "M" });
    expect(element().muted).toBe(true);
  });

  it("leaves fullscreen on F", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    expect(fireEvent.keyDown(surface(), { key: "f" })).toBe(false);
    expect(
      screen.queryByTestId("video-fullscreen-controls"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("video-controls")).toBeInTheDocument();
  });

  it("leaves fullscreen on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    expect(fireEvent.keyDown(surface(), { key: "Escape" })).toBe(false);
    expect(
      screen.queryByTestId("video-fullscreen-controls"),
    ).not.toBeInTheDocument();
  });

  it("leaves a Ctrl chord to the application", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    play.mockClear();

    // Ctrl+1..9, Ctrl+0, Ctrl+D and Ctrl+, all belong to the app shell. None
    // of them may be swallowed by a video that happens to be open.
    for (const key of ["1", "0", "d", ","]) {
      expect(fireEvent.keyDown(surface(), { key, ctrlKey: true })).toBe(true);
    }
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByTestId("video-fullscreen-controls")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("a control never also means play", () => {
  it("toggles playback from the picture itself", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    play.mockClear();

    await user.click(surface());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("keeps that true in fullscreen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    play.mockClear();

    await user.click(surface());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not toggle when a fullscreen control is used", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    play.mockClear();

    await user.click(screen.getByTestId("video-fullscreen-mute"));
    await user.click(screen.getByTestId("video-fullscreen-loop"));
    await user.click(screen.getByTestId("video-fullscreen-speed"));
    await user.click(screen.getByTestId("video-seek"));

    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("does not toggle when the exit control is used", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    play.mockClear();

    await user.click(screen.getByTestId("video-exit-fullscreen"));
    expect(play).not.toHaveBeenCalled();
  });

  it("still toggles from the fullscreen play button, which is a control that means exactly that", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);
    play.mockClear();

    await user.click(screen.getByTestId("video-fullscreen-play"));
    // Once, not twice: the click must not also reach the surface behind it.
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("honours the preference that turns click-to-toggle off", async () => {
    useAppStore.setState({
      prefs: { ...defaultPreferences, videoClickToggle: false },
    });
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    play.mockClear();

    await user.click(surface());
    expect(play).not.toHaveBeenCalled();

    // The button still works — the preference is about the picture.
    await user.click(screen.getByLabelText("Play"));
    expect(play).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

/**
 * The provider publishes one MP4 per video. A menu of resolutions would be
 * three buttons pointing at the same bytes.
 */
describe("the quality control tells the truth", () => {
  it("requires an explicit lower-quality choice after the best variant fails", async () => {
    useAppStore.setState({ prefs: { ...defaultPreferences, videoQuality: "best", defaultSpeed: 1.5 } });
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video({ url: "", variants: [
      { label: "1920x1080", url: "https://cdn.example.com/1080.mp4", bitrate: 4000000 },
      { label: "640x360", url: "https://cdn.example.com/360.mp4", bitrate: 500000 },
    ] })} />);
    expect(element().src).toContain("1080.mp4");
    fireEvent.error(element());
    expect(element().src).toContain("1080.mp4");
    await user.click(screen.getByRole("button", { name: "Try a lower quality" }));
    expect(element().src).toContain("360.mp4");
    expect(element().playbackRate).toBe(1.5);
  });
  it("shows the decoded resolution in a compact badge", () => {
    renderWithProviders(<VideoPlayer media={video()} />);

    const el = element();
    expect(screen.getByTestId("video-resolution-badge")).toHaveTextContent(
      "Best available",
    );

    Object.defineProperty(el, "videoWidth", {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(el, "videoHeight", {
      configurable: true,
      value: 720,
    });
    fireEvent.loadedMetadata(el);

    const badge = screen.getByTestId("video-resolution-badge");
    expect(badge).toHaveTextContent("720p");
    expect(badge).toHaveAttribute("title", "1280×720");
  });

  it("starts with the highest real variant when the primary URL is lower", () => {
    // Best is a deliberate choice; the application default is the data-saving
    // 720p target and should choose the nearest genuine lower variant.
    useAppStore.setState({
      prefs: { ...defaultPreferences, videoQuality: "best" },
    });
    renderWithProviders(
      <VideoPlayer
        media={video({
          url: "https://cdn.example.com/360.mp4",
          width: 640,
          height: 360,
          variants: [
            {
              label: "1920x1080",
              url: "https://cdn.example.com/1080.mp4",
              bitrate: 1_800_000,
            },
            {
              label: "640x360",
              url: "https://cdn.example.com/360-variant.mp4",
              bitrate: 500_000,
            },
          ],
        })}
      />,
    );

    expect(element().src).toContain("1080.mp4");
    expect(screen.getByTestId("video-resolution-badge")).toHaveTextContent(
      "1080p",
    );
  });

  it("degrades to a single indicator that cannot be opened", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    const single = screen.getByTestId("video-quality-single");
    expect(single).toBeDisabled();
    expect(single).toHaveTextContent("Best available");
    expect(single).toHaveAttribute("title", "Only one quality available");
    expect(screen.queryByTestId("video-quality")).not.toBeInTheDocument();

    await user.click(single);
    expect(screen.queryByTestId("video-quality-menu")).not.toBeInTheDocument();
  });

  it("offers a menu only when the sources are genuinely different", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <VideoPlayer
        media={video({
          url: "",
          variants: [
            {
              label: "1280x720",
              url: "https://cdn.example.com/720.mp4",
              bitrate: 2_000_000,
            },
            {
              label: "640x360",
              url: "https://cdn.example.com/360.mp4",
              bitrate: 600_000,
            },
          ],
        })}
      />,
    );
    await goFullscreen(user);

    expect(
      screen.queryByTestId("video-quality-single"),
    ).not.toBeInTheDocument();
    const trigger = screen.getByTestId("video-quality");
    // Best available is the default, and it resolves to the highest real one.
    expect(trigger).toHaveTextContent("1280x720");
    expect(element().src).toContain("720.mp4");

    await user.click(trigger);
    const menu = screen.getByTestId("video-quality-menu");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("1280x720");
    expect(items[1]).toHaveTextContent("640x360");
    expect(items[0]).toHaveAttribute("aria-checked", "true");

    await user.click(items[1]);
    expect(element().src).toContain("360.mp4");
    expect(screen.getByTestId("video-quality")).toHaveTextContent("640x360");
  });

  it("never invents a resolution the payload does not carry", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    const chrome = screen.getByTestId("video-fullscreen-controls");
    for (const invented of ["1080", "720p", "480p", "360p", "Auto"]) {
      expect(chrome).not.toHaveTextContent(invented);
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * Behaviour the fullscreen work was not allowed to cost. Each of these was
 * true before this sprint and has to stay true after it.
 */
describe("what fullscreen must not have broken", () => {
  it("loops by default", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    expect(element().loop).toBe(true);
  });

  it("carries the loop setting into fullscreen and lets it be turned off there", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    const loop = screen.getByTestId("video-fullscreen-loop");
    expect(loop).toHaveAttribute("aria-pressed", "true");
    await user.click(loop);
    expect(screen.getByTestId("video-fullscreen-loop")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(element().loop).toBe(false);
  });

  it("plays an animated GIF by itself, muted and looping", () => {
    renderWithProviders(<VideoPlayer media={video({ kind: "gif" })} />);
    expect(element().muted).toBe(true);
    expect(element().loop).toBe(true);
    expect(play).toHaveBeenCalled();
  });

  it("holds a GIF still when the reader has asked for reduced motion", () => {
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation(
        (query: string) =>
          ({ matches: true, media: query }) as unknown as MediaQueryList,
      );
    renderWithProviders(<VideoPlayer media={video({ kind: "gif" })} />);
    expect(play).not.toHaveBeenCalled();
    matchMedia.mockRestore();
  });

  it("holds a GIF still when the preference is off", () => {
    useAppStore.setState({
      prefs: { ...defaultPreferences, gifAutoplay: false },
    });
    renderWithProviders(<VideoPlayer media={video({ kind: "gif" })} />);
    expect(play).not.toHaveBeenCalled();
  });

  it("autoplays one visible ordinary video while keeping nearby cards bounded", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    expect(play).toHaveBeenCalledTimes(1);
    expect(element()).toHaveProperty("muted", true);
    expect(element()).toHaveAttribute("preload", "auto");
  });

  it("allows only one visible clip to autoplay", () => {
    renderWithProviders(
      <MediaGallery
        media={[
          video(),
          video({ url: "https://cdn.example.com/second-clip.mp4" }),
        ]}
      />,
    );

    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("reserves a stable frame before video metadata arrives", () => {
    renderWithProviders(
      <VideoPlayer media={video({ width: null, height: null })} />,
    );

    expect(surface().style.aspectRatio).toBe("16/9");
    expect(surface().style.maxHeight).toBe("520px");
    expect(element()).toHaveClass("h-full");
  });

  it("releases a player that scrolls away and resumes where it stopped", () => {
    renderWithProviders(<VideoPlayer media={video()} />);
    element().currentTime = 12;

    scrollTo(false);
    // The decoder is gone, not merely paused.
    expect(screen.queryByTestId("video-element")).not.toBeInTheDocument();

    scrollTo(true);
    const back = element();
    expect(back).toBeInTheDocument();
    // The element asks for its own metadata once; the position is applied to
    // that same load rather than provoking a second one.
    fireEvent.loadedMetadata(back);
    expect(back.currentTime).toBe(12);
  });

  it("keeps the player mounted off-screen when the preference says so", () => {
    useAppStore.setState({
      prefs: { ...defaultPreferences, videoOffscreenCleanup: false },
    });
    renderWithProviders(<VideoPlayer media={video()} />);

    scrollTo(false);
    expect(screen.getByTestId("video-element")).toBeInTheDocument();
  });

  it("keeps a fullscreen video mounted even if its card scrolls away", async () => {
    const user = userEvent.setup();
    renderWithProviders(<VideoPlayer media={video()} />);
    await goFullscreen(user);

    scrollTo(false);
    expect(screen.getByTestId("video-element")).toBeInTheDocument();
    expect(screen.getByTestId("video-fullscreen-controls")).toBeInTheDocument();
  });

  it("still explains a source it cannot play", () => {
    renderWithProviders(
      <VideoPlayer media={video({ url: "", variants: [] })} />,
    );
    expect(
      screen.getByText("Video is unavailable this session."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("video-element")).not.toBeInTheDocument();
  });
});
