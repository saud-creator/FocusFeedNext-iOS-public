import {intersectionRootOf} from '@/lib/scroll';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Gauge,
  Maximize,
  Monitor,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { api,isTauri, type PostMedia } from "@/lib/api";
import { useNativeMedia } from '@/lib/nativeMedia';
import {
  classifyMediaError,
  classifyProxyFailure,
  isProxiedMedia,
  posterFor,
  videoErrorKey,
  type VideoErrorKind,
} from "@/lib/media";
import {
  claimPlayback,
  prefersReducedMotion,
  registerAutoplay,
  releasePlayback,
  rememberMuted,
  rememberVolume,
  sessionMuted,
  sessionVolume,
} from "@/lib/mediaSession";
import {
  enterFullscreen,
  isNativelyFullscreen,
  leaveFullscreen,
  onFullscreenChange,
} from "@/components/media/fullscreen";
import {
  FullscreenVideoControls,
  SEEK_STEP,
  VOLUME_STEP,
} from "@/components/media/FullscreenVideoControls";
import {
  compactQualityLabel,
  qualityOptions,
  resolveQualityIndex,
} from "@/components/media/quality";
import { formatClock } from "@/components/media/time";
import { useAutoHideControls } from "@/components/media/useAutoHideControls";
import { useAppStore } from "@/stores/useAppStore";
import { usePlatform } from '@/lib/platform';
import { useEffectivePolicy } from '@/lib/runtime';
import { useNativeOverlay } from '@/lib/nativeOverlay';
import { enterNativeVideoFullscreen, leaveNativeVideoFullscreen, onNativeVideoFullscreen } from '@/components/media/nativeVideoFullscreen';
import { InlineVideoSettings } from '@/components/media/InlineVideoSettings';
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** Retries allowed before the player stops trying. */
const VIDEO_FALLBACK_RATIO = "16/9";

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

type Status = "idle" | "loading" | "buffering" | "playing" | "paused" | "error";

/** One decoder shared by inline controls and fullscreen. iPhone uses its
 * native video presentation when available; other hosts use a full-window
 * layout with an exit that remains available during errors. Off-screen media
 * is released, and source changes preserve the playhead and playback intent. */
export function VideoPlayer({
  media,
  defaultSpeed,
  onRecover,
}: {
  media: PostMedia;
  defaultSpeed?: number;
  onRecover?: (freshSource?:boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const {present:presentNativeMedia}=useNativeMedia();
  const prefs = useAppStore((s) => s.prefs);
  const { isIphone } = usePlatform();
  const policy = useEffectivePolicy(isIphone);
  const ref = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const isGif = media.kind === "gif";
  const qualities = useMemo(() => qualityOptions(media), [media]);
  const sources = useMemo(() => qualities.map((q) => q.url), [qualities]);
  // The reader's stored preference chooses the starting source; with the one
  // stream the provider actually publishes this always resolves to that one.
  const [sourceIndex, setSourceIndex] = useState(() =>
    resolveQualityIndex(qualities, policy.videoQuality),
  );
  const [status, setStatus] = useState<Status>("idle");
  const [errorKind, setErrorKind] = useState<VideoErrorKind>("unknown");
  const [retrying,setRetrying]=useState(false);
  const retryInFlight=useRef(false);
  const recoveredRegistration=useRef(false);
  const formatFallback=useRef(false);
  // A GIF is always silent; ordinary video starts from whatever the reader
  // last chose in this session.
  const [muted, setMuted] = useState(isGif || sessionMuted());
  const [volume, setVolume] = useState(() => sessionVolume());
  // Looping is on by default for everything, not just GIFs. A post's video is
  // usually a few seconds of a demo or a clip, and the thing a reader does with
  // one is watch it again — having it stop dead on a frozen last frame means
  // reaching for a control to see it twice.
  const [loop, setLoop] = useState(prefs.videoLoop);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [duration, setDuration] = useState((media.durationMs ?? 0) / 1000);
  /** The dimensions the browser actually decoded for the selected source. */
  const [decodedSize, setDecodedSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [speed, setSpeed] = useState(defaultSpeed ?? prefs.defaultSpeed);
  const [showSpeed, setShowSpeed] = useState(false);
  const [fullscreenMenuOpen, setFullscreenMenuOpen] = useState(false);
  const errorProbe = useRef<AbortController | null>(null);
  const revealTap = useRef(false);
  const [nonce, setNonce] = useState(0);
  // Keep the element mounted in a generous nearby runway so it can fetch
  // metadata before the reader reaches it. A second, tighter observer below
  // controls autoplay; those two concerns must not be conflated or a video
  // would start while it is still merely approaching the viewport.
  const [visible, setVisible] = useState(!isIphone);
  const [inViewport, setInViewport] = useState(!isIphone);
  const [fullscreen, setFullscreen] = useState(false);
  /** Whether the browser granted a real fullscreen, as opposed to our own. */
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const videoFullscreenRef = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const resumePlaying = useRef(false);
  useNativeOverlay(fullscreen);
  useEffect(() => { if (!policy.foreground) { ref.current?.pause(); } }, [policy.foreground]);
  /** Keep the player in its card while a browser fullscreen request settles. */
  const [nativeRequestPending, setNativeRequestPending] = useState(false);
  const nativeRef = useRef(false);
  /** Lets Escape/click exit win over a late request promise. */
  const nativeRequestId = useRef(0);
  const wantsFullscreen = useRef(false);
  /** The host stays the same so moving it never remounts the video element. */
  const fullscreenHost = useMemo(() => {
    if (typeof document === "undefined") return null;
    const host = document.createElement("div");
    host.className = "contents";
    return host;
  }, []);
  const fullscreenAnchorRef = useRef<HTMLDivElement>(null);
  /** Where to pick up after the element is replaced. */
  const resumeAt = useRef(0);
  /** A deliberate pause wins until the card leaves and re-enters the view. */
  const userPaused = useRef(false);
  /** Avoid issuing the same autoplay request again on a state-only rerender. */
  const autoplayRequested = useRef(false);
  /** Distinguishes the play event caused by our muted autoplay request. */
  const autoplaying = useRef(false);
  const playingAutomatically = useRef(false);
  useEffect(() => {
    if (!policy.autoplay && playingAutomatically.current) {
      ref.current?.pause(); autoplayRequested.current = false; playingAutomatically.current = false;
    }
  }, [policy.autoplay]);
  useEffect(() => {
    // Keep an explicit in-player selection until the saved/effective policy
    // changes. Preserve the playhead through the existing source-change path.
    resumeAt.current = ref.current?.currentTime ?? resumeAt.current;
    setSourceIndex(resolveQualityIndex(qualities, policy.videoQuality));
  }, [policy.videoQuality, qualities]);

  const src = sources[sourceIndex];
  const poster = posterFor(media);
  const resolutionLabel = useMemo(() => {
    if (decodedSize && decodedSize.height > 0) {
      return `${decodedSize.height}p`;
    }

    const label = compactQualityLabel(qualities[sourceIndex], sourceIndex);
    if (label.kind === "text") return label.text;
    if (label.kind === "bitrate") return `${label.kbps}k`;
    return t("post.video.quality.best");
  }, [decodedSize, qualities, sourceIndex, t]);
  const resolutionTitle = decodedSize
    ? `${decodedSize.width}×${decodedSize.height}`
    : resolutionLabel;
  const hasDuration = Number.isFinite(duration) && duration > 0;
  // Releasing off-screen players is a preference; fullscreen overrides it,
  // because a fullscreen video is by definition the thing being looked at even
  // when the card behind it has scrolled away.
  const mounted = policy.foreground && (visible || !policy.cleanup || fullscreen);
  const useBodyFullscreenLayer =
    fullscreen && !videoFullscreen && !nativeFullscreen && !nativeRequestPending;
  const expandedLayout = fullscreen && !videoFullscreen;

  // The feed's <main> is scrollable and carries an entrance animation. A fixed
  // descendant can be clipped or positioned against that scroller, especially
  // in the embedded shell where the native Fullscreen API is intentionally not
  // called. Keep the React portal target stable and move only that target; the
  // video node and its decoder remain mounted throughout.
  useLayoutEffect(() => {
    if (!fullscreenHost) return;
    const anchor = fullscreenAnchorRef.current;
    const target = useBodyFullscreenLayer ? document.body : anchor;
    if (!target || fullscreenHost.parentNode === target) return;
    target.appendChild(fullscreenHost);
  }, [fullscreenHost, sources.length, useBodyFullscreenLayer]);

  useEffect(() => {
    return () => fullscreenHost?.remove();
  }, [fullscreenHost]);

  // Do not let the feed continue scrolling behind the in-app fullscreen layer.
  // Native fullscreen owns the document scroll surface, so it needs no lock.
  useEffect(() => {
    if (!useBodyFullscreenLayer || typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [useBodyFullscreenLayer]);

  // Focus after the host has moved, so keyboard controls keep working in the
  // body-level fallback as well as in the native top layer.
  useEffect(() => {
    if (!expandedLayout) return;
    try {
      frameRef.current?.focus();
    } catch {
      // A host can detach the frame during the transition; pointer controls
      // remain available and the fullscreen layout is still valid.
    }
  }, [expandedLayout, nativeFullscreen, useBodyFullscreenLayer]);
  // Reserve the first layout box before metadata arrives. Without this, an
  // initially mounted video can report an intrinsic height of zero and then
  // expand after decode, forcing the virtualizer to remeasure the feed while
  // the reader is moving through it.
  const mediaRatio =
    decodedSize ? `${decodedSize.width}/${decodedSize.height}` : media.width && media.height
      ? `${media.width}/${media.height}`
      : VIDEO_FALLBACK_RATIO;

  const { visible: chromeVisible, wake } = useAutoHideControls(expandedLayout && status === 'playing' && !fullscreenMenuOpen);
  useEffect(() => () => { errorProbe.current?.abort(); }, [src,nonce]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      // A bounded runway keeps one nearby metadata request useful without
      // mounting/decoding a page of videos ahead of the reader.
      { root:intersectionRootOf(el),rootMargin: `${policy.speculative ? Math.min(350,policy.imageMargin) : 0}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [policy.speculative,policy.imageMargin]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setInViewport(true); return; }
    const io = new IntersectionObserver(
      ([entry]) => {
        // The small fallback keeps the jsdom test seam and older WebView2
        // implementations honest when they omit intersectionRatio.
        const ratio =
          typeof entry.intersectionRatio === "number"
            ? entry.intersectionRatio
            : 1;
        setInViewport(entry.isIntersecting && ratio >= 0.35);
      },
      { root:intersectionRootOf(el),threshold: [0, 0.35] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed;
  }, [speed, mounted, sourceIndex, nonce]);

  // Restore this session's volume/mute state onto each freshly mounted element.
  useEffect(() => {
    const el = ref.current;
    if (!el || isGif) return;
    el.volume = volume;
    el.muted = muted;
  }, [mounted, nonce, isGif, muted, volume, sourceIndex]);

  // Keep cleanup tied to the element lifecycle, not to a volume or mute
  // toggle. Autoplay sets muted as a safety requirement; releasing the active
  // registration during that state update would make a video play correctly
  // but disappear from the main-player registry.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return () => {
      // Whatever replaces this element — a scroll back into view, a retry, a
      // change of quality — continues from here rather than from the start.
      if (Number.isFinite(el.currentTime)) resumeAt.current = el.currentTime;
      autoplayRequested.current = false;
      autoplaying.current = false;
      releasePlayback(el);
      el.pause();
    };
  }, [mounted, nonce, isGif, sourceIndex]);

  // A quality change and a retry replace the keyed video element. Do not carry
  // the previous stream's dimensions into the new badge while it buffers.
  useEffect(() => {
    setDecodedSize(null);
    // A new declared source or deliberate retry is a new attempt. A WebKit
    // remount of the same failed source must retain its compact recovery UI.
    setStatus('idle');
  }, [nonce, src]);

  // Autoplay visible media muted. Muting before play is required by Chromium's
  // autoplay policy. The shared media session grants only one autoplay slot;
  // other nearby cards keep their metadata/poster without running a decoder.
  useEffect(() => {
    const el = ref.current;
    if (
      !el ||
      status === 'error' ||
      !mounted ||
      !inViewport ||
      !policy.autoplay ||
      userPaused.current ||
      autoplayRequested.current
    )
      return;
    if (isGif && !prefs.gifAutoplay) return;
    if (prefersReducedMotion()) return;

    if (!isGif) {
      // Do not remember this as the user's durable choice. It is an autoplay
      // safety requirement; an explicit unmute still takes effect immediately
      // and is remembered through the normal control path.
      setMuted(true);
      el.muted = true;
    } else {
      el.muted = true;
    }
    if (!registerAutoplay(el)) return;
    autoplayRequested.current = true;
    autoplaying.current = true;
    void el.play().catch(() => {
      autoplayRequested.current = false;
      autoplaying.current = false;
      releasePlayback(el);
      // Autoplay refusal is not a media failure worth surfacing. The poster
      // and play control remain available for a deliberate start.
    });
  }, [inViewport, isGif, mounted, nonce, prefs.gifAutoplay, policy.autoplay,status]);

  // Leave the active set and pause as soon as the card is no longer actually
  // visible. Keeping a nearby element mounted is useful for metadata, but it
  // must not keep consuming video data while the reader is elsewhere.
  useEffect(() => {
    const el = ref.current;
    if (!el || inViewport || fullscreen) return;
    userPaused.current = false;
    autoplayRequested.current = false;
    autoplaying.current = false;
    if (!el.paused) el.pause();
    releasePlayback(el);
    if (status === "playing" || status === "buffering") setStatus("paused");
  }, [fullscreen, inViewport, status]);

  // Leaving the viewport pauses and drops the element (below), which is what
  // actually frees the decoder; this keeps our own state honest.
  useEffect(() => {
    if (!mounted && (status === "playing" || status === "buffering")) {
      setStatus("paused");
    }
  }, [mounted, status]);

  const onError = useCallback(() => {
    const code = ref.current?.error?.code;
    // Try the next candidate before declaring failure — but only when there
    // genuinely is one. On live data there is exactly one source.
    if (policy.videoQuality !== 'best' && sourceIndex + 1 < sources.length) {
      setStatus('idle');
      setSourceIndex((i) => i + 1);
      return;
    }
    const fallback = classifyMediaError(code);
    resumePlaying.current=false;
    setErrorKind(fallback);
    setStatus("error");
    wake();

    // The element reports every proxy failure as the same opaque
    // "source not supported". One HEAD against the same URL tells us whether
    // the registration expired, the CDN refused, or the format really is
    // undecodable — so the message can name the actual cause.
    const url = sources[sourceIndex];
    if (!url || !isProxiedMedia(url)) return;
    errorProbe.current?.abort();
    const probe = new AbortController(); errorProbe.current = probe;
    const deadline = window.setTimeout(() => probe.abort(),8000);
    void (isTauri()?api.probeMedia(url):fetch(url, { method: "HEAD", signal:probe.signal }).then(res=>res.status))
      .then(async code => {
        if(probe.signal.aborted) return;
        if(code>=200 && code<300) {
          if((ref.current?.error?.code===3 || ref.current?.error?.code===4) && sourceIndex+1<sources.length && !formatFallback.current) {
            formatFallback.current=true;resumeAt.current=ref.current?.currentTime??resumeAt.current;
            setSourceIndex(index=>index+1);setStatus('idle');
          }
          return;
        }
        setErrorKind(classifyProxyFailure(code));
        if(code===404 && onRecover && !recoveredRegistration.current) {
          recoveredRegistration.current=true;
          if(retryInFlight.current) return;
          retryInFlight.current=true;setRetrying(true);
          try {await onRecover(false);if(!probe.signal.aborted){setStatus('idle');setNonce(n=>n+1);}}
          finally {retryInFlight.current=false;setRetrying(false);}
        }
      })
      .catch(() => { if (!probe.signal.aborted) setErrorKind("network"); })
      .finally(() => window.clearTimeout(deadline));
  }, [sourceIndex, sources, policy.videoQuality, wake,onRecover]);

  const retry = async () => {
    if (retryInFlight.current) return;
    retryInFlight.current=true;setRetrying(true);
    autoplayRequested.current = false;
    errorProbe.current?.abort();
    try {
      if(onRecover) await onRecover(true);
      setSourceIndex(resolveQualityIndex(qualities, policy.videoQuality));
      setErrorKind("unknown");setStatus("idle");setNonce(n=>n+1);
    } catch {setStatus('error');setErrorKind('network');}
    finally {retryInFlight.current=false;setRetrying(false);}
  };

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el || status === "error") return;
    if (el.paused) {
      userPaused.current = false;
      autoplaying.current = false;
      claimPlayback(el);
      void el.play().catch((error: unknown) => {
        if (error instanceof DOMException && ['NotAllowedError','AbortError'].includes(error.name)) {
          releasePlayback(el); setStatus('paused'); return;
        }
        onError();
      });
    } else {
      userPaused.current = true;
      autoplaying.current = false;
      el.pause();
    }
  }, [onError, status]);

  const seekTo = useCallback(
    (seconds: number) => {
      const el = ref.current;
      const total =
        el && Number.isFinite(el.duration) && el.duration > 0
          ? el.duration
          : duration;
      const limit = Number.isFinite(total) && total > 0 ? total : seconds;
      const next = Math.min(limit, Math.max(0, seconds));
      if (!Number.isFinite(next)) return;
      if (el) { try { el.currentTime = next; } catch { return; } }
      setTime(next);
    },
    [duration],
  );

  const applyVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    setVolume(clamped);
    rememberVolume(clamped);
    const el = ref.current;
    if (el) el.volume = clamped;
    // Raising the volume on a muted video is a request to hear it.
    if (clamped > 0) {
      setMuted(false);
      rememberMuted(false);
      if (el) el.muted = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      rememberMuted(next);
      if (ref.current) ref.current.muted = next;
      return next;
    });
  }, []);

  const toggleLoop = useCallback(() => {
    setLoop((l) => {
      const next = !l;
      if (ref.current) ref.current.loop = next;
      return next;
    });
  }, []);

  const chooseQuality = useCallback((index: number) => {
    // The element is keyed on its source, so this replaces it; `resumeAt`,
    // captured on the way out, puts the playhead back where it was.
    autoplayRequested.current = false;
    resumeAt.current = ref.current?.currentTime ?? resumeAt.current;
    resumePlaying.current = ref.current ? !ref.current.paused : false;
    setStatus('idle');setNonce(value=>value+1);
    setSourceIndex(index);
  }, []);

  // ---------------------------------------------------------------------
  // Fullscreen
  // ---------------------------------------------------------------------

  const exit = useCallback(() => {
    wantsFullscreen.current = false;
    nativeRequestId.current += 1;
    setFullscreen(false);
    setNativeFullscreen(false);
    setNativeRequestPending(false);
    setVideoFullscreen(false);
    const wasVideo = videoFullscreenRef.current;
    videoFullscreenRef.current = false;
    if (wasVideo) leaveNativeVideoFullscreen(ref.current);
    const wasNative = nativeRef.current;
    nativeRef.current = false;
    if (wasNative) void leaveFullscreen();
    const target = returnFocus.current;
    if (target?.isConnected) window.requestAnimationFrame(() => target.focus({preventScroll:true}));
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video || !isIphone) return;
    const remove = onNativeVideoFullscreen(video, () => {
      wantsFullscreen.current = true;
      videoFullscreenRef.current = true;
      setVideoFullscreen(true); setFullscreen(true); setNativeRequestPending(false);
    }, exit);
    return () => {
      remove();
      if (videoFullscreenRef.current) {
        videoFullscreenRef.current = false; wantsFullscreen.current = false;
        leaveNativeVideoFullscreen(video); setVideoFullscreen(false); setFullscreen(false);
      }
    };
  }, [isIphone, mounted, nonce, src, exit]);

  useEffect(() => () => {
    wantsFullscreen.current = false;
    nativeRequestId.current += 1;
    if (nativeRef.current) void leaveFullscreen();
  }, []);

  const enter = useCallback(() => {
    wantsFullscreen.current = true;
    const requestId = ++nativeRequestId.current;
    const frame = frameRef.current;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShowSpeed(false);
    if (isIphone && isTauri() && src) {
      const position=ref.current?.currentTime ?? 0;
      const playing=ref.current ? !ref.current.paused : false;
      ref.current?.pause();
      void presentNativeMedia([{url:src,kind:'video',alt:media.alt}],0,{position,playing,speed,muted,loopPlayback:loop}).then(result=>{
        if(!result || nativeRequestId.current!==requestId) return;
        wantsFullscreen.current=false;
        resumeAt.current=result.position;resumePlaying.current=result.playing;
        setNonce(value=>value+1);
      }).catch(()=>{
        if(nativeRequestId.current!==requestId) return;
        if(enterNativeVideoFullscreen(ref.current)) {videoFullscreenRef.current=true;setVideoFullscreen(true);}
        setFullscreen(true);
      });
      return;
    }
    if (isIphone && enterNativeVideoFullscreen(ref.current)) {
      videoFullscreenRef.current = true;
      setVideoFullscreen(true); setNativeRequestPending(false); setFullscreen(true);
      return;
    }
    // The DOM Fullscreen API is not safe in the shipped WebView2 shell on
    // some Windows builds: the host can terminate the renderer while the
    // request is being promoted to the native top layer, before JavaScript
    // gets a rejected promise back. The CSS layout below is the deliberate,
    // crash-safe fullscreen mode for Tauri. A normal browser still gets the
    // native top layer and its Escape/window-exit integration.
    if (isTauri()) {
      setNativeRequestPending(false);
    } else {
      setNativeRequestPending(true);
      // Invoke the request before changing layout so it still runs in the
      // original click gesture. The stable host then waits for the result
      // before choosing native or body-level CSS fullscreen.
      void enterFullscreen(frame).then((granted) => {
        if (nativeRequestId.current !== requestId) { if (granted && isNativelyFullscreen(frame)) void leaveFullscreen(); return; }
        nativeRef.current = granted;
        setNativeFullscreen(granted);
        setNativeRequestPending(false);
      });
    }
    setFullscreen(true);
    // Keys only reach the player when the player has focus, so entering takes
    // it. Nothing else on the page can be typed at while it is up.
    try {
      frameRef.current?.focus();
    } catch {
      // A host can detach the frame during the transition; fullscreen itself
      // is still valid and the controls remain reachable by pointer.
    }
  }, [isIphone, src, media.alt, speed, muted, loop, presentNativeMedia]);

  const toggleFullscreen = useCallback(() => {
    if (fullscreen) exit();
    else enter();
  }, [fullscreen, enter, exit]);
  useEffect(()=>{if (!sources.length && fullscreen) exit();},[sources.length,fullscreen,exit]);

  // The browser's own exits — Escape, the window leaving fullscreen, another
  // element taking it — arrive here and nowhere else.
  useEffect(
    () =>
      onFullscreenChange(() => {
        const isFs = isNativelyFullscreen(frameRef.current);
        if (isFs && !wantsFullscreen.current) { void leaveFullscreen(); return; }
        if (isFs) {
          nativeRef.current = true;
          setNativeFullscreen(true);
          setNativeRequestPending(false);
          setFullscreen(true);
        } else if (nativeRef.current) {
          nativeRef.current = false;
          setNativeFullscreen(false);
          setNativeRequestPending(false);
          setFullscreen(false);
        }
      }),
    [],
  );

  /**
   * The fullscreen keyboard.
   *
   * Scoped twice over: only while fullscreen, and only from inside the player,
   * because these are single letters and arrows. Every handled key is consumed
   * — the app's own shortcuts are Ctrl-chorded, and a bare Space that reached
   * the page would scroll the feed behind the video as well as pausing it.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!fullscreen) return;
    // A chord belongs to the application, not to the player.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    wake();
    if (e.key !== 'Escape' && e.target !== e.currentTarget && e.target instanceof Element &&
        e.target.closest('button,input,select,textarea,[role="menuitemradio"]')) return;

    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    switch (e.key) {
      case " ":
      case "Spacebar":
        take();
        toggle();
        break;
      case "ArrowLeft":
        take();
        seekTo((ref.current?.currentTime ?? time) - SEEK_STEP);
        break;
      case "ArrowRight":
        take();
        seekTo((ref.current?.currentTime ?? time) + SEEK_STEP);
        break;
      case "ArrowUp":
        take();
        applyVolume(volume + VOLUME_STEP);
        break;
      case "ArrowDown":
        take();
        applyVolume(volume - VOLUME_STEP);
        break;
      case "m":
      case "M":
        take();
        toggleMute();
        break;
      case "f":
      case "F":
        take();
        toggleFullscreen();
        break;
      case "Escape":
        take();
        exit();
        break;
      default:
        break;
    }
  };

  const playing = status === "playing";

  if (sources.length === 0) {
    // No decodable source at all — an HLS-only or image-only media item.
    return (
      <div className="relative rounded-xl overflow-hidden bg-black border border-edge">
        {poster ? (
          <img
            src={poster}
            alt={media.alt ?? ""}
            loading="lazy"
            decoding="async"
            className="w-full max-h-[520px] object-contain"
          />
        ) : (
          <div className="aspect-video grid place-items-center text-ink-mute text-sm">
            {t("post.media.noPreview")}
          </div>
        )}
        <div className="absolute inset-0 grid place-items-center bg-black/45">
          <div className="text-center px-6">
            <p className="text-white/90 text-sm font-medium">
              {/* An empty source on a video item means the Rust side had
                  nowhere to point it: the local proxy did not start. Saying
                  "preview only" there would blame the post for a local
                  problem. */}
              {media.url.trim() === ""
                ? t("post.video.error.proxyUnavailable")
                : t("post.video.previewOnly")}
            </p>
            <p className="text-white/60 text-[12.5px] mt-1 max-w-xs">
              {media.url.trim() === ""
                ? t("post.video.error.proxyUnavailable.desc")
                : t("post.video.previewOnly.desc")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const surface = (
    <div
      ref={frameRef}
      data-testid="video-surface"
      data-fullscreen={fullscreen ? "true" : "false"}
      // Focusable, but not a tab stop: a feed of videos should not put a stop
      // between every post and the next. Fullscreen focuses it directly, and
      // the controls inside it are ordinary buttons that keep their own place
      // in the order.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerMove={fullscreen ? wake : undefined}
      onPointerDown={(event)=>{revealTap.current=expandedLayout && event.pointerType !== 'mouse' && !chromeVisible; if(revealTap.current) wake();}}
      // The whole frame is the play/pause target, not the <video> alone: the
      // controls, the buffering badge and the letterbox bars all sit over the
      // picture, and a reader aiming at "the video" hits one of them as often
      // as not. Everything that is itself a control stops the click here (see
      // the handlers below) so it never means two things at once.
      onClick={expandedLayout ? () => { if (!chromeVisible || revealTap.current) { revealTap.current=false; wake(); return; } wake(); if (prefs.videoClickToggle) toggle(); } : prefs.videoClickToggle ? toggle : undefined}
      className={cn(
        "relative overflow-hidden bg-black group outline-none",
        prefs.videoClickToggle && "cursor-pointer",
        expandedLayout
          ? // Native fullscreen already fills the display; the fixed inset is
            // for the case where the request was refused, so the layout the
            // reader asked for still arrives.
            cn(
              "flex items-center justify-center",
              nativeFullscreen
                ? "h-full w-full"
                : "video-fullscreen-surface fixed inset-0 z-[200]",
              !chromeVisible && "cursor-none",
            )
          : "w-full rounded-xl border border-edge",
      )}
      style={
        !expandedLayout ? status==='error'?{height:160}:{ aspectRatio: mediaRatio, maxHeight: isIphone ? 'min(65svh, 520px)' : 520 } : undefined
      }
      {...(fullscreen
        ? { role: "region", "aria-label": t("a11y.video.fullscreenPlayer") }
        : {})}
    >
      {mounted ? (
        <video
          // `nonce` forces a genuinely fresh element on retry; calling load()
          // on a failed element does not always clear its error state.
          key={`${src}-${nonce}`}
          ref={ref}
          src={src}
          poster={poster}
          loop={loop}
          muted={muted}
          playsInline
          // Only the active player moves beyond metadata. Nearby cards are
          // cheap poster/metadata candidates, and cards released by
          // virtualization do not issue a request at all.
          preload={
            inViewport && (status === "playing" || autoplayRequested.current)
              ? "auto"
              : mounted
                ? "metadata"
                : "none"
          }
          data-testid="video-element"
          className={cn(
            "h-full w-full bg-black object-contain",
            !fullscreen && "max-h-[520px]",
          )}
          onLoadStart={() => setStatus(current=>current==='error'?'error':'loading')}
          onWaiting={() => setStatus(current=>current==='error'?'error':'buffering')}
          onPlaying={() => setStatus(current=>current==='error'?'error':'playing')}
          onPlay={(e) => {
            if(status==='error'){e.currentTarget.pause();return;}
            if (autoplaying.current) {
              playingAutomatically.current = true;
              if (!registerAutoplay(e.currentTarget)) {
                e.currentTarget.pause();
                autoplaying.current = false;
                return;
              }
            } else { playingAutomatically.current = false; claimPlayback(e.currentTarget); }
            autoplaying.current = false;
            setStatus("playing");
          }}
          onVolumeChange={(e) => {
            if (isGif) return;
            rememberVolume(e.currentTarget.volume);
            rememberMuted(e.currentTarget.muted);
            setMuted(e.currentTarget.muted);
            if (!isIphone) setVolume(e.currentTarget.volume);
          }}
          onPause={(e) => {
            releasePlayback(e.currentTarget);
            // WebKit may enqueue pause after error, especially on fullscreen
            // dismissal. Only a new load or deliberate retry clears failure.
            setStatus(current=>current==='error'?'error':'paused');
          }}
          onTimeUpdate={(e) => {
            setTime(Number.isFinite(e.currentTarget.currentTime) ? e.currentTarget.currentTime : 0);
            setBuffered(bufferedAhead(e.currentTarget));
          }}
          onProgress={(e) => setBuffered(bufferedAhead(e.currentTarget))}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            setDuration(el.duration);
            if (el.videoWidth > 0 && el.videoHeight > 0) {
              setDecodedSize({ width: el.videoWidth, height: el.videoHeight });
            }
            setStatus(current=>current==='error'?'error':el.paused?'paused':'playing');
            // Continue where the previous element left off. Only ever a seek
            // within the source already being fetched, never a second load.
            const at = resumeAt.current;
            if (
              at > 0.5 &&
              (!Number.isFinite(el.duration) || at < el.duration)
            ) {
              try { el.currentTime = at; setTime(at); } catch { /* A not-yet-seekable source keeps its current position. */ }
            }
            if (resumePlaying.current) {
              resumePlaying.current = false;
              claimPlayback(el);
              void el.play().catch(() => { releasePlayback(el); setStatus('paused'); });
            }
          }}
          onError={onError}
        />
      ) : (
        // Placeholder keeps the card's height stable while unmounted.
        <div
          className="w-full bg-black"
          style={{
            aspectRatio: mediaRatio,
            maxHeight: 520,
          }}
        />
      )}

      {status !== "error" && mounted && !fullscreen ? (
        <div
          data-testid="video-resolution-badge"
          title={resolutionTitle}
          aria-label={`${t("a11y.video.quality")}: ${resolutionLabel}`}
          className="absolute top-2 end-2 inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/85 pointer-events-none"
          dir="ltr"
        >
          <Monitor className="size-3" aria-hidden="true" />
          <span>{resolutionLabel}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <div
          className="absolute inset-0 grid place-items-center bg-black/75 text-center px-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <p className="text-white/90 text-sm">
              {t(videoErrorKey(errorKind))}
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-0">
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="min-h-11 inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline cursor-pointer"
              >
                <RotateCcw className="size-3.5" />
                {t("post.video.retry")}
              </button>
              {sourceIndex + 1 < sources.length && <button type="button" className="min-h-11 text-xs text-white underline" onClick={() => {
                resumeAt.current = ref.current?.currentTime ?? resumeAt.current;
                setSourceIndex(index => index+1); setStatus('idle'); setNonce(value=>value+1);
              }}>{t('post.video.lowerQuality')}</button>}
            </div>
          </div>
        </div>
      ) : null}

      {status === "loading" || status === "buffering" ? (
        <div className="absolute inset-x-0 top-0 p-2 pointer-events-none">
          <span className="inline-block rounded bg-black/70 px-2 py-0.5 text-[11.5px] text-white/80">
            {status === "loading"
              ? t("post.video.state.loading")
              : t("post.video.state.buffering")}
          </span>
        </div>
      ) : null}

      {/* One layout or the other, never both: the compact bar is not rendered
          at all in fullscreen, so there is nothing left of the card's chrome to
          stretch across the display. */}
      {expandedLayout ? (
        <FullscreenVideoControls
          touchLayout={isIphone}
          enabled={status !== 'error' && mounted}
          onMenuChange={setFullscreenMenuOpen}
          playing={playing}
          time={time}
          duration={duration}
          buffered={buffered}
          muted={muted}
          volume={volume}
          loop={loop}
          speed={speed}
          speeds={SPEEDS}
          qualities={qualities}
          qualityIndex={sourceIndex}
          visible={chromeVisible}
          onToggle={toggle}
          onSeek={seekTo}
          onVolume={applyVolume}
          onToggleMute={toggleMute}
          onToggleLoop={toggleLoop}
          onSpeed={setSpeed}
          onQuality={chooseQuality}
          onExit={exit}
          onActivity={wake}
        />
      ) : null}

      {status !== "error" && mounted && !fullscreen ? (
        <div
          data-testid="video-controls"
          // One boundary rather than a stopPropagation on each control: the
          // seek bar, the volume and loop toggles, the speed menu and full
          // screen all live in here, and every one of them would otherwise
          // also toggle playback on the way out through the frame.
          onClick={(e) => e.stopPropagation()}
          className={cn("absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2.5 group-hover:opacity-100 focus-within:opacity-100 transition-opacity",isIphone ? 'opacity-100 [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:inline-flex [&_button]:items-center [&_button]:justify-center' : 'opacity-0')}
        >
          {/* A timeline is only shown when the duration is actually known.
              A zero-width scrubber that cannot be dragged is a lie. */}
          {hasDuration ? (
            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={Math.min(time, duration)}
              onChange={(e) => seekTo(Number(e.target.value))}
              // Not "Play": the scrubber and the play button were sharing one
              // label, so a screen reader announced two different controls as
              // the same thing.
              aria-label={t("a11y.video.seek")}
              className={cn("w-full accent-[var(--accent)] cursor-pointer",isIphone ? 'h-11':'h-5')}
            />
          ) : null}
          <div className={cn("flex items-center gap-1 mt-1 text-white/90",isIphone ? 'flex-nowrap':'flex-wrap')}>
            {hasDuration && !isIphone && <button type="button" aria-label={t('post.video.back10')} onClick={() => seekTo((ref.current?.currentTime ?? time)-10)} className="inline-flex items-center justify-center"><RotateCcw className="size-4" /></button>}
            <button
              type="button"
              onClick={toggle}
              aria-label={
                playing ? t("post.video.pause") : t("post.video.play")
              }
              className="cursor-pointer hover:text-white"
            >
              {playing ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </button>
            {hasDuration && !isIphone && <button type="button" aria-label={t('post.video.forward10')} onClick={() => seekTo((ref.current?.currentTime ?? time)+10)} className="inline-flex items-center justify-center"><RotateCw className="size-4" /></button>}
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? t("post.video.unmute") : t("post.video.mute")}
              className="cursor-pointer hover:text-white"
            >
              {muted ? (
                <VolumeX className="size-4" />
              ) : (
                <Volume2 className="size-4" />
              )}
            </button>
            <span className="text-[11.5px] tabular-nums whitespace-nowrap" dir="ltr" aria-label={hasDuration ? `${formatClock(time)} / ${formatClock(duration)}` : formatClock(time)}>
              {formatClock(time)}
              {hasDuration && <span className={isIphone ? 'hidden min-[390px]:inline' : undefined}>{` / ${formatClock(duration)}`}</span>}
            </span>

            <div className="ms-auto flex items-center gap-2">
              {isIphone ? <InlineVideoSettings speed={speed} speeds={SPEEDS} qualities={qualities} qualityIndex={sourceIndex} loop={loop} onSpeed={setSpeed} onQuality={chooseQuality} onLoop={toggleLoop} /> : <>
              <button
                type="button"
                onClick={toggleLoop}
                aria-label={t("post.video.loop")}
                className={cn(
                  "cursor-pointer hover:text-white",
                  loop && "text-accent",
                )}
              >
                <Repeat className="size-4" />
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowSpeed((s) => !s)}
                  aria-label={t("post.video.speed")}
                  className="cursor-pointer hover:text-white inline-flex items-center gap-1"
                >
                  <Gauge className="size-4" />
                  <span className="text-[11px] tabular-nums">{speed}×</span>
                </button>
                {showSpeed ? (
                  <div className="absolute bottom-6 end-0 bg-surface-2 border border-edge rounded-lg p-1 flex flex-col">
                    {SPEEDS.map((s) => (
                      <button
                        type="button"
                        key={s}
                        onClick={() => {
                          setSpeed(s);
                          setShowSpeed(false);
                        }}
                        className={cn(
                          "px-2.5 py-1 text-[12px] rounded cursor-pointer hover:bg-surface-3",
                          s === speed ? "text-accent" : "text-ink-dim",
                        )}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              </>}
              <button
                type="button"
                onClick={enter}
                aria-label={t("post.video.fullscreen")}
                data-testid="video-enter-fullscreen"
                className="cursor-pointer hover:text-white"
              >
                <Maximize className="size-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  const placeholder = useBodyFullscreenLayer ? (
    <div
      data-testid="video-surface-placeholder"
      aria-hidden="true"
      className="w-full rounded-xl border border-edge bg-black"
      style={status==='error' && !fullscreen ? {height:160} : { aspectRatio: mediaRatio, maxHeight: 520 }}
    />
  ) : null;

  return (
    <div
      ref={fullscreenAnchorRef}
      className={useBodyFullscreenLayer ? "block w-full" : "contents"}
    >
      {placeholder}
      {fullscreenHost ? createPortal(surface, fullscreenHost) : surface}
    </div>
  );
}

/**
 * How far the buffer reaches, in seconds from the start.
 *
 * Only the range the playhead is actually inside counts: a video seeked around
 * in has several disjoint ranges, and drawing the furthest one would show the
 * reader a bar claiming everything up to it has arrived when the seconds just
 * ahead of the playhead have not.
 */
function bufferedAhead(el: HTMLVideoElement): number {
  const ranges = el.buffered;
  if (!ranges || typeof ranges.length !== "number") return 0;
  for (let i = 0; i < ranges.length; i++) {
    try {
      if (
        ranges.start(i) <= el.currentTime &&
        ranges.end(i) >= el.currentTime
      ) {
        return ranges.end(i);
      }
    } catch {
      return 0;
    }
  }
  return 0;
}
