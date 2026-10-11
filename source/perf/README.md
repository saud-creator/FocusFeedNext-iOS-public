# Scroll measurement

`feed-harness.html` mounts the real `FeedList` with synthetic posts and drives
it with a scripted scroll. It exists because the claim being checked — that long
feeds stopped stuttering, particularly upward — is a claim about time, and time
cannot be measured in jsdom: there is no compositor there, so any millisecond
figure it produced would describe the test double rather than the feed.

## Running it

```bash
npm run dev
```

Then open `http://localhost:5173/perf/feed-harness.html` and, in the console:

```js
await window.__measure();
```

`?n=500` sets the feed size (500 is the default). `?media=mixed` adds
ratio-known and ratio-less synthetic images so the browser run also exercises
late media measurement while scrolling.

To measure a different commit with the same instrument, put the harness in a
worktree at that commit and serve it on another port:

```bash
git worktree add ../ffn-wt/perf-before <commit> --detach
```

Copy `perf/` in, point `node_modules` at the main checkout, and run
`npx vite --port 5174 --strictPort`. Both servers can run at once, which is what
makes the two numbers comparable rather than two runs on a machine in two
different states.

## What it reports

`__measure()` scrolls 60 steps of 400px down, then 60 back up, and for each step
times: moving the scroll position, forcing the layout that invalidates, letting
React commit, and forcing layout again. That is the synchronous work a real
frame would have had to absorb.

Frame intervals are deliberately _not_ what is timed. `requestAnimationFrame` is
throttled to a standstill whenever the measuring tab is not the visible one, and
the first version of this harness duly reported zero frames and zero
milliseconds — a result that looks like a pass.

## Results

Measured 2026-07-26, Chromium, 720px viewport, 500 text-only posts.

|                          | before (`be0c00a`) | after (`e2b822a`) |
| ------------------------ | ------------------ | ----------------- |
| cards mounted            | 500                | **11**            |
| DOM elements             | 25,818             | **595**           |
| downward, median ms/step | 10.2               | **4.8**           |
| downward, p95            | 11.6               | **5.7**           |
| downward, 60 steps total | 605.8 ms           | **277.8 ms**      |
| upward, median ms/step   | 10.2               | **4.9**           |
| upward, p95              | 12.0               | **6.1**           |
| upward, worst step       | 13.4               | **6.2**           |
| upward, 60 steps total   | 624.3 ms           | **298.5 ms**      |

The DOM is 43× smaller and a scroll step costs a little over half what it did,
in both directions. Card count stays at 11 at the top of the list, at the
bottom, and back at the top again, so nothing accumulates over a round trip.

Two honest caveats:

- The `?media=mixed` mode adds deterministic ratio-known and ratio-less images
  for layout testing; it does not simulate a real CDN or video decoder.
- These posts carry no media. The old build kept every image and video element
  alive for all 500 cards, and that is where its memory and decode cost lived,
  so the real-world gap is wider than the table shows — but by how much is not
  something this harness measured, so it is not claimed.
- The harness has no backend, so it does not exercise the other half of the same
  fix: automatic mark-as-read used to invalidate the feed query per post, and a
  screenful of reading fired six or seven refetches that each replaced the whole
  visible array. These numbers isolate the windowing alone.
