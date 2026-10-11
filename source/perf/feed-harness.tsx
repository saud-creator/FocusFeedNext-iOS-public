/**
 * Scroll measurement rig for FeedList. Not shipped, not imported by the app.
 *
 * The claim being checked is about time, and time cannot be measured in jsdom.
 * So this mounts the genuine FeedList in a real engine, drives it with a
 * scripted scroll, and reports the work each step costs alongside the live DOM
 * size. Running it at two commits with the same script, on two ports at once,
 * is what makes the two numbers comparable.
 *
 * See perf/README.md.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeedList } from "@/components/feed/FeedList";
import { TooltipProvider } from "@/components/ui/primitives";
import { I18nProvider } from "@/i18n";
import type { Post, PostMedia } from "@/lib/api";
import { defaultPreferences, useAppStore } from '@/stores/useAppStore';
import "@/index.css";

const PARAMS = new URLSearchParams(location.search);
const COUNT = Math.max(100,Math.min(10000,Number(PARAMS.get("n") ?? 1000) || 1000));
const MEDIA_MODE = PARAMS.get("media") === "mixed";
useAppStore.setState({prefs:{...defaultPreferences,performanceMode:PARAMS.get('mode') === 'ultra' ? 'ultra' : 'balanced'}});

const AVATAR =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"/>';
const MEDIA_IMAGE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'><rect width='16' height='9'/></svg>";

/** Mix ratio-known and ratio-less images to exercise late media measurement. */
function mediaFor(i: number): PostMedia[] {
  if (!MEDIA_MODE || i % 5 !== 0) return [];
  const knownRatio = i % 2 === 0;
  return [
    {
      kind: i % 15 === 0 ? "video" : "image",
      url: i % 15 === 0 ? "" : MEDIA_IMAGE,
      previewUrl: i % 15 === 0 ? MEDIA_IMAGE : null,
      width: knownRatio ? 1280 : null,
      height: knownRatio ? 720 : null,
      alt: `Synthetic image ${i}`,
      durationMs: null,
      variants: [],
    },
  ];
}

/** Deterministic filler, so both runs render the same text at the same lengths. */
function body(i: number): string {
  const words = [
    "reserving",
    "capacity",
    "cut",
    "our",
    "tail",
    "latency",
    "by",
    "a",
    "third",
    "across",
    "every",
    "region",
    "we",
    "measured",
  ];
  const n = 12 + (i % 28);
  return Array.from(
    { length: n },
    (_, k) => words[(i + k) % words.length],
  ).join(" ");
}

function feed(count: number): Post[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    text: `${i}. ${body(i)}`,
    author: {
      id: `u${i % 40}`,
      username: `account_${i % 40}`,
      displayName: `Account ${i % 40}`,
      avatarUrl: AVATAR,
      bannerUrl: null,
      verified: i % 7 === 0,
      bio: null,
      followersCount: 1000 + i,
      followingCount: 100,
    },
    createdAt: new Date(Date.now() - i * 60_000).toISOString(),
    lang: "en",
    isRepost: false,
    repostedBy: null,
    isPromoted: false,
    quoted: null,
    metrics: {
      replies: i % 9,
      reposts: i % 13,
      likes: i * 3,
      quotes: 0,
      views: i * 40,
      bookmarks: i % 5,
    },
    media: mediaFor(i),
    url: `https://x.com/account_${i % 40}/status/p${i}`,
    isArticle: false,
    articleTitle: null,
    inReplyTo: null,
    provider: "harness",
  })) as unknown as Post[];
}

function Harness() {
  const [posts] = useState(() => feed(COUNT));
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  // The scrolling element is a bounded overflow container, which is what the
  // application's shell gives the feed. Letting the document scroll instead
  // would measure a layout the product never has.
  return (
    <div
      id="scroller"
      style={{
        height: "100vh",
        overflowY: "auto",
        maxWidth: 720,
        margin: "0 auto",
        padding: 16,
      }}
    >
      <FeedList
        posts={posts}
        readIds={readIds}
        onMarkRead={(id, read) =>
          setReadIds((prev) => {
            const next = new Set(prev);
            if (read) next.add(id);
            else next.delete(id);
            return next;
          })
        }
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <I18nProvider locale="en">
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// -- the measurement -------------------------------------------------------

type Report = Record<string, number | string>;

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    frames: samples.length,
    median: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    worst: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    over32ms: samples.filter((d) => d > 32).length,
  };
}

function scroller(): HTMLElement {
  return document.getElementById("scroller")!;
}

/**
 * Scroll one direction in fixed steps, timing the work each step causes.
 *
 * Deliberately not frame intervals: requestAnimationFrame is throttled to a
 * standstill whenever the measuring tab is not the visible one, and a run that
 * silently reports zero frames is worse than no run at all. What is timed
 * instead is the thing that stutters — moving the scroll position, forcing the
 * layout that invalidates, letting React commit, then forcing layout again.
 * That is the synchronous cost a real frame would have had to absorb, and it
 * is measurable whether or not anything is on screen.
 */
async function sweep(direction: "down" | "up", steps: number, px: number) {
  const el = scroller();
  const costs: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t0 = performance.now();
    el.scrollTop += direction === "down" ? px : -px;
    void el.scrollHeight; // flush the layout the scroll invalidated
    await new Promise((r) => setTimeout(r, 0)); // let React commit
    void el.scrollHeight; // flush the layout that commit invalidated
    costs.push(performance.now() - t0);
  }
  return costs;
}

declare global {
  interface Window {
    __measure: () => Promise<Report>;
  }
}

window.__measure = async () => {
  const el = scroller();
  el.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 300));

  const nodesAtTop = document.querySelectorAll("*").length;
  const cardsAtTop = document.querySelectorAll(
    '[data-testid="post-card"]',
  ).length;

  const down = await sweep("down", 60, 400);
  const nodesAtBottom = document.querySelectorAll("*").length;
  const cardsAtBottom = document.querySelectorAll(
    '[data-testid="post-card"]',
  ).length;

  // The direction the complaint was about.
  const up = await sweep("up", 60, 400);
  const cardsBack = document.querySelectorAll(
    '[data-testid="post-card"]',
  ).length;

  const d = stats(down);
  const u = stats(up);
  return {
    posts: COUNT,
    nodesAtTop,
    cardsAtTop,
    nodesAtBottom,
    cardsAtBottom,
    cardsBack,
    downSteps: d.frames,
    downMedianMs: d.median,
    downP95Ms: d.p95,
    downWorstMs: d.worst,
    downStepsOver32ms: d.over32ms,
    downTotalMs: +down.reduce((a, b) => a + b, 0).toFixed(1),
    upSteps: u.frames,
    upMedianMs: u.median,
    upP95Ms: u.p95,
    upWorstMs: u.worst,
    upStepsOver32ms: u.over32ms,
    upTotalMs: +up.reduce((a, b) => a + b, 0).toFixed(1),
  };
};

// A visible control lets the same fixture run through browser automation.
const runButton=document.createElement('button'); runButton.textContent='Run scroll measurement';
runButton.style.cssText='position:fixed;right:4px;top:4px;z-index:100;background:white;color:black;padding:8px';
runButton.addEventListener('click',async()=>{
  runButton.disabled=true;
  let result=document.getElementById('perf-results');
  if (!result) { result=document.createElement('pre');result.id='perf-results';result.style.cssText='position:fixed;right:4px;top:48px;z-index:100;background:white;color:black;max-height:70vh;overflow:auto;padding:8px;font-size:10px';document.body.append(result); }
  result.textContent=JSON.stringify(await window.__measure(),null,2);runButton.disabled=false;
});document.body.append(runButton);
