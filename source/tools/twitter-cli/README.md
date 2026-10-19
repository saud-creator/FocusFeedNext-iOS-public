# The twitter-cli provider patches

Focus Feed Next reads X through [twitter-cli], pinned to one commit. This
directory holds the provider changes the app needs and the means to apply them
the same way twice.

[twitter-cli]: https://github.com/public-clis/twitter-cli

## Why there is a patch at all

Upstream sorts a video's MP4 renditions by bitrate and keeps the largest:

```python
mp4_variants.sort(key=lambda v: v.get("bitrate", 0), reverse=True)
url=mp4_variants[0]["url"] if mp4_variants else ...
```

The rest are discarded before anything is serialised. No consumer can offer a
quality choice afterwards, because by then there is nothing to choose between.
That is the whole reason for this directory — not a preference about upstream's
design, just a fact about where the information stops.

## What the patch does

The media change is additive. `url` keeps its exact previous meaning, so an
unpatched consumer sees no difference. The bookmark change is deliberately
scoped to that operation: ordinary feeds retain the provider safety cap.

| File | Change |
| --- | --- |
| `models.py` | `TweetMedia` gains `variants`, `poster_url`, `duration_ms`, all defaulted |
| `parser.py` | fills them from `video_info`, which already carries everything — no extra request |
| `serialization.py` | emits them |
| `client.py` | lets Bookmarks follow its terminal cursor instead of stopping at the generic count cap |

Resolution is read from the variant URL path (`.../1280x720/...`), which is how
X encodes it. When that segment is absent the size is left absent rather than
guessed: a wrong resolution on a quality menu is worse than no label, because
the reader would act on it. `duration_ms` and `poster_url` appear only when X
genuinely sent them.

## Running it

```powershell
.\install-focusfeed-twitter-cli.ps1
```

It verifies the pin, installs through the **same pipx environment the app
already resolves**, checks that the upstream source still contains the context
the provider patches expect, applies both, and proves the patched build imports,
reports variants and opts Bookmarks out of the generic count cap. Running it
twice does nothing the second time.

To go back:

```powershell
.\install-focusfeed-twitter-cli.ps1 -Rollback
```

which reinstalls the pinned commit unpatched.

## Rules it keeps

- **One `twitter.exe`.** It installs into the existing pipx environment and
  never creates a second shim. Two installations is the failure that makes a
  patch look as though it did nothing, because the app keeps using the other
  one.
- **It refuses rather than forces.** Every edit is anchored on an exact string
  and must match exactly once. A half-applied patch produces a build that
  imports and parses wrongly, which is worse than one that would not install.
- **It never touches credentials.** The patches are confined to parsing,
  serialisation and bookmark fetch policy. Nothing in this directory reads, writes, prints or requires
  `auth_token` or `ct0`.
- **The hashes are recorded.** `PATCH_SHA256.txt` contains one SHA-256 line for
  each provider patch and is shown in Diagnostics, so a running app can be
  matched to the provider it was built against.

## What the app does with the variants

Every variant URL is registered with the Rust media proxy and rewritten to an
opaque loopback URL. **React never receives an X CDN URL** — it cannot play one
anyway (a request from `tauri.localhost` is cross-site and the CDN refuses it),
and it must not appear in the DOM.

The quality menu shows one entry per genuine distinct resolution, deduplicated
by preferring the highest bitrate, with a bitrate label only where resolution
is unknown. With a single variant it shows an honest disabled indicator rather
than a list of one.
