import { useEffect, useState, type ReactNode } from "react";
import {
  Gauge,
  Minimize,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatClock } from "./time";
import {
  hasQualityChoice,
  qualityLabel,
  type QualityLabel,
  type QualityOption,
} from "./quality";

/**
 * The fullscreen player's own chrome.
 *
 * ## Why this is not the card's controls made bigger
 *
 * The embedded player is 2.5rem of gradient at the bottom of a reading column:
 * a 16px play glyph, a 1px scrubber and a time that fits in eleven and a half
 * pixels of type. Stretched across a 27" display those same controls become a
 * hairline the pointer cannot find, sitting under a picture that is now the
 * whole room. Fullscreen is a different instrument, so it gets different
 * controls — 44px hit targets, a scrubber with a body to it, the buffered
 * range drawn behind the played one, and text at a size that can be read from
 * a sofa rather than from a desk.
 *
 * Everything in here is inert until the reader asks for it: the whole layer is
 * `pointer-events-none` and only the two bars take clicks, so a click on the
 * picture between them still reaches the surface and toggles playback. One
 * `stopPropagation` at the root is the boundary — a control never means "play"
 * as well as what it says.
 */

/** Seconds skipped by one arrow press. */
export const SEEK_STEP = 5;
/** One arrow press worth of volume. */
export const VOLUME_STEP = 0.1;

export interface FullscreenVideoControlsProps {
  touchLayout?: boolean;
  enabled?: boolean;
  onMenuChange?: (open: boolean) => void;
  playing: boolean;
  /** Playhead position, in seconds. */
  time: number;
  /** Total length in seconds; 0 or non-finite while it is still unknown. */
  duration: number;
  /** How far the buffer reaches ahead of the start, in seconds. */
  buffered: number;
  muted: boolean;
  volume: number;
  loop: boolean;
  speed: number;
  speeds: readonly number[];
  qualities: QualityOption[];
  qualityIndex: number;
  /** False once the reader has been still for a few seconds. */
  visible: boolean;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (value: number) => void;
  onToggleMute: () => void;
  onToggleLoop: () => void;
  onSpeed: (value: number) => void;
  onQuality: (index: number) => void;
  onExit: () => void;
  /** Any interaction in here also counts as "the reader is still there". */
  onActivity: () => void;
}

function pct(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0%";
  const ratio = Math.min(1, Math.max(0, value / total));
  return `${(ratio * 100).toFixed(2)}%`;
}

/** Big enough to hit without aiming: 44px, the smallest target worth having. */
const TARGET =
  "inline-flex items-center justify-center rounded-full text-white/90 " +
  "hover:text-white hover:bg-white/15 focus-visible:outline-2 " +
  "focus-visible:outline-white/70 transition-colors cursor-pointer size-11";

export function FullscreenVideoControls({
  touchLayout = false,
  enabled = true,
  onMenuChange,
  playing,
  time,
  duration,
  buffered,
  muted,
  volume,
  loop,
  speed,
  speeds,
  qualities,
  qualityIndex,
  visible,
  onToggle,
  onSeek,
  onVolume,
  onToggleMute,
  onToggleLoop,
  onSpeed,
  onQuality,
  onExit,
  onActivity,
}: FullscreenVideoControlsProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<"none" | "speed" | "quality">("none");
  useEffect(() => { onMenuChange?.(menu !== 'none'); }, [menu,onMenuChange]);

  const hasDuration = Number.isFinite(duration) && duration > 0;
  const canChooseQuality = hasQualityChoice(qualities);

  // A menu left open behind hidden controls would swallow the next click on
  // the picture, so hiding the chrome closes it.
  useEffect(() => {
    if (!visible) setMenu("none");
  }, [visible]);

  const nameOf = (label: QualityLabel): string => {
    if (label.kind === "text") return label.text;
    if (label.kind === "bitrate")
      return t("post.video.quality.bitrate", { kbps: label.kbps });
    return t("post.video.quality.best");
  };

  const currentQuality = nameOf(
    qualityLabel(qualities[qualityIndex], qualityIndex),
  );

  const VolumeIcon =
    muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // Hidden chrome must also be untouchable, or the first click after it fades
  // lands on a control the reader can no longer see instead of on the picture.
  const reachable = visible ? "pointer-events-auto" : "pointer-events-none";

  return (
    <div
      data-testid="video-fullscreen-controls"
      data-visible={visible ? "true" : "false"}
      // One boundary for the whole layer. The root itself takes no pointer
      // events, so the only clicks arriving here are the ones that bubbled out
      // of a control — exactly the ones that must not also toggle playback.
      onClick={(e) => e.stopPropagation()}
      onPointerMove={onActivity}
      className={cn(
        "absolute inset-0 z-10 flex flex-col justify-between pointer-events-none",
      )}
    >
      {/* Top: leaving, said plainly. An icon alone at the corner of a black
          screen is a guess; this one is a labelled button. */}
      <div className="flex justify-end pt-[max(12px,env(safe-area-inset-top))] pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] pb-3 bg-gradient-to-b from-black/70 to-transparent">
        <button
          type="button"
          onClick={onExit}
          aria-label={t("post.video.exitFullscreen")}
          data-testid="video-exit-fullscreen"
          className={cn(
            "pointer-events-auto touch-manipulation",
            "inline-flex items-center gap-2 rounded-full",
            "bg-black/60 hover:bg-black/80 border border-white/25",
            "px-4 h-11 text-[15px] font-medium text-white cursor-pointer",
            "focus-visible:outline-2 focus-visible:outline-white/70",
          )}
        >
          <Minimize className="size-5" />
          <span>{t("post.video.exitFullscreen")}</span>
        </button>
      </div>

      {/* Bottom: the transport. */}
      {enabled && <div
        role="group"
        aria-label={t("post.video.controls")}
        className={cn(
          reachable,
          "transition-opacity duration-200 motion-reduce:transition-none",
          visible ? "opacity-100" : "opacity-0",
          "bg-gradient-to-t from-black/90 via-black/70 to-transparent",
          // Generous padding so nothing sits against the edge of the display,
          // and safe-area insets for a view whose window has none to spare.
          "pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-10",
          "pb-[max(1rem,env(safe-area-inset-bottom))]",
        )}
      >
        {hasDuration ? (
          <div
            className="relative flex h-9 items-center"
            data-testid="video-seek-row"
          >
            <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/25" />
            {/* What has actually arrived, drawn behind the playhead. */}
            <div
              data-testid="video-buffered"
              data-buffered={pct(buffered, duration)}
              className="absolute start-0 h-1.5 rounded-full bg-white/45"
              style={{ width: pct(buffered, duration) }}
            />
            <div
              data-testid="video-played"
              className="absolute start-0 h-1.5 rounded-full bg-[var(--accent)]"
              style={{ width: pct(time, duration) }}
            />
            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={Math.min(time, duration)}
              onChange={(e) => {
                onActivity();
                onSeek(Number(e.target.value));
              }}
              aria-label={t("a11y.video.seek")}
              aria-valuetext={`${formatClock(time)} / ${formatClock(duration)}`}
              data-testid="video-seek"
              // Transparent but real: the visible track above is decoration,
              // and this is the control a pointer and a screen reader both get.
              className="absolute inset-x-0 h-9 w-full cursor-pointer opacity-0"
            />
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2 text-white/90">
          {hasDuration && <button type="button" className={TARGET} aria-label={t('post.video.back10')} onClick={() => { onActivity(); onSeek(time-10); }}><RotateCcw className="size-5" /></button>}
          <button
            type="button"
            onClick={onToggle}
            aria-label={playing ? t("post.video.pause") : t("post.video.play")}
            data-testid="video-fullscreen-play"
            className={cn(TARGET, "bg-white/10 hover:bg-white/25")}
          >
            {playing ? (
              <Pause className="size-6" />
            ) : (
              <Play className="size-6" />
            )}
          </button>

          {hasDuration && <button type="button" className={TARGET} aria-label={t('post.video.forward10')} onClick={() => { onActivity(); onSeek(time+10); }}><RotateCw className="size-5" /></button>}
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? t("post.video.unmute") : t("post.video.mute")}
            data-testid="video-fullscreen-mute"
            className={TARGET}
          >
            <VolumeIcon className="size-5" />
          </button>

          {!touchLayout && <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              onActivity();
              onVolume(Number(e.target.value));
            }}
            aria-label={t("a11y.video.volume")}
            data-testid="video-volume"
            className="h-9 w-24 sm:w-32 cursor-pointer accent-[var(--accent)]"
          />}

          <span
            data-testid="video-fullscreen-time"
            className="ms-1 text-[15px] tabular-nums text-white/85"
            // Clock text is read left to right in both catalogues.
            dir="ltr"
          >
            {hasDuration
              ? `${formatClock(time)} / ${formatClock(duration)}`
              : formatClock(time)}
          </span>

          <div className={cn('ms-auto flex items-center gap-2',touchLayout && 'basis-full justify-end')}>
            {touchLayout && <span className="me-auto text-xs text-white/70">{t('post.video.hardwareVolume')}</span>}
            <button
              type="button"
              onClick={onToggleLoop}
              aria-label={t("a11y.video.loop")}
              aria-pressed={loop}
              data-testid="video-fullscreen-loop"
              className={cn(TARGET, loop && "text-[var(--accent)]")}
            >
              <Repeat className="size-5" />
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setMenu((m) => (m === "speed" ? "none" : "speed"))
                }
                aria-label={t("a11y.video.speed")}
                aria-expanded={menu === "speed"}
                data-testid="video-fullscreen-speed"
                className={cn(TARGET, "w-auto gap-1.5 px-3")}
              >
                <Gauge className="size-5" />
                <span className="text-[14px] tabular-nums">{speed}×</span>
              </button>
              {menu === "speed" ? (
                <Menu label={t("post.video.speed")} testid="video-speed-menu">
                  {speeds.map((s) => (
                    <MenuItem
                      key={s}
                      selected={s === speed}
                      onClick={() => {
                        onSpeed(s);
                        setMenu("none");
                      }}
                    >
                      <span className="tabular-nums">{s}×</span>
                    </MenuItem>
                  ))}
                </Menu>
              ) : null}
            </div>

            {/* Quality. With one genuine source this is an indicator, not a
                menu: a list of resolutions the provider never published would
                be three buttons pointing at identical bytes. */}
            <div className="relative">
              <button
                type="button"
                onClick={
                  canChooseQuality
                    ? () =>
                        setMenu((m) => (m === "quality" ? "none" : "quality"))
                    : undefined
                }
                disabled={!canChooseQuality}
                aria-label={t("a11y.video.quality")}
                aria-expanded={
                  canChooseQuality ? menu === "quality" : undefined
                }
                title={
                  canChooseQuality ? undefined : t("post.video.quality.only")
                }
                data-testid={
                  canChooseQuality ? "video-quality" : "video-quality-single"
                }
                className={cn(
                  TARGET,
                  "w-auto gap-1.5 px-3 text-[14px]",
                  !canChooseQuality &&
                    "cursor-default text-white/55 hover:bg-transparent hover:text-white/55",
                )}
              >
                <SlidersHorizontal className="size-5" />
                <span>{currentQuality}</span>
              </button>
              {canChooseQuality && menu === "quality" ? (
                <Menu
                  label={t("post.video.quality")}
                  testid="video-quality-menu"
                >
                  {qualities.map((q, i) => (
                    <MenuItem
                      key={q.url}
                      selected={i === qualityIndex}
                      onClick={() => {
                        onQuality(i);
                        setMenu("none");
                      }}
                    >
                      {nameOf(qualityLabel(q, i))}
                    </MenuItem>
                  ))}
                </Menu>
              ) : null}
            </div>
          </div>
        </div>
      </div>}
    </div>
  );
}

/**
 * A menu that opens upwards.
 *
 * Anchored to the top of its trigger and capped in height: the trigger sits at
 * the bottom edge of the display, so a menu that opened downwards, or one long
 * enough to overflow, would be cut off by the edge of the window.
 */
function Menu({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <div
      role="menu"
      aria-label={label}
      data-testid={testid}
      className={cn(
        "absolute bottom-full end-0 mb-3 min-w-28 max-h-[40vh] overflow-y-auto",
        "rounded-xl border border-white/15 bg-black/90 p-1.5 shadow-xl",
        "flex flex-col gap-0.5",
      )}
    >
      {children}
    </div>
  );
}

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "h-10 rounded-lg px-4 text-start text-[14px] cursor-pointer",
        "hover:bg-white/15",
        selected ? "text-[var(--accent)]" : "text-white/85",
      )}
    >
      {children}
    </button>
  );
}
