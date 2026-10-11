"""Apply the Focus Feed Next media-variant change to an installed twitter_cli.

Called by `install-focusfeed-twitter-cli.ps1`, which has already verified the
version and the anchors. Kept separate so the edits are readable, testable and
reversible by reinstalling the pin.

Why a rewriter rather than `git apply`: site-packages is not a git tree, and
vendoring a whole upstream checkout in order to patch three files would be a
much larger thing to keep honest. Every edit below is anchored on an exact
string and refuses rather than guesses.

It never reads, writes or requires a credential. It touches provider parsing,
serialisation and the bookmark fetch policy only.
"""

import io
import os
import sys


class Refused(Exception):
    """The source did not look the way the patch requires."""


def replace_once(text, old, new, what):
    if text.count(old) != 1:
        raise Refused(
            "expected exactly one occurrence of %s; found %d"
            % (what, text.count(old))
        )
    return text.replace(old, new, 1)


MODELS_OLD = '''class TweetMedia:
    type: str  # "photo" | "video" | "animated_gif"
    url: str
    width: Optional[int] = None
    height: Optional[int] = None
'''

MODELS_NEW = '''class MediaVariant:
    """One playable rendition of a video.

    Focus Feed Next: upstream keeps only the highest-bitrate MP4, which makes a
    quality menu impossible downstream — the alternatives are gone before the
    JSON is written.
    """

    url: str
    content_type: str
    bitrate: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None


@dataclass
class TweetMedia:
    type: str  # "photo" | "video" | "animated_gif"
    url: str
    width: Optional[int] = None
    height: Optional[int] = None
    variants: List["MediaVariant"] = field(default_factory=list)
    poster_url: Optional[str] = None
    duration_ms: Optional[int] = None
'''

PARSER_OLD = '''            media.append(
                TweetMedia(
                    type=media_type,
                    url=mp4_variants[0]["url"] if mp4_variants else media_item.get("media_url_https", ""),
                    width=_deep_get(media_item, "original_info", "width"),
                    height=_deep_get(media_item, "original_info", "height"),
                )
            )'''

PARSER_NEW = '''            _video_info = media_item.get("video_info", {})
            _duration = _video_info.get("duration_millis")
            media.append(
                TweetMedia(
                    type=media_type,
                    url=mp4_variants[0]["url"] if mp4_variants else media_item.get("media_url_https", ""),
                    width=_deep_get(media_item, "original_info", "width"),
                    height=_deep_get(media_item, "original_info", "height"),
                    variants=[
                        MediaVariant(
                            url=v.get("url", ""),
                            content_type=v.get("content_type", ""),
                            bitrate=v.get("bitrate"),
                            width=_variant_size(v.get("url", ""))[0],
                            height=_variant_size(v.get("url", ""))[1],
                        )
                        for v in mp4_variants
                        if v.get("url")
                    ],
                    poster_url=media_item.get("media_url_https") or None,
                    duration_ms=int(_duration) if isinstance(_duration, int) else None,
                )
            )'''

VARIANT_SIZE = '''

def _variant_size(url):
    # type: (str) -> tuple
    """Read `.../1280x720/...` out of a variant URL.

    X encodes the rendition size in the path. Nothing is inferred when that
    segment is absent: a guessed resolution on a quality menu is worse than no
    label at all, because the reader would act on it.
    """
    for part in url.split("/"):
        if "x" not in part:
            continue
        left, _, right = part.partition("x")
        if left.isdigit() and right.isdigit():
            return int(left), int(right)
    return None, None
'''

SERIAL_OLD = '''                "type": media.type,
                "url": media.url,
                "width": media.width,
                "height": media.height,'''

SERIAL_NEW = '''                "type": media.type,
                "url": media.url,
                "width": media.width,
                "height": media.height,
                "posterUrl": getattr(media, "poster_url", None),
                "durationMs": getattr(media, "duration_ms", None),
                "variants": [
                    {
                        "url": v.url,
                        "contentType": v.content_type,
                        "bitrate": v.bitrate,
                        "width": v.width,
                        "height": v.height,
                    }
                    for v in getattr(media, "variants", [])
                ],'''


# The provider's generic timeline guard is useful for ordinary feeds, but it
# is the wrong policy for this app's Bookmarks page. The bookmark endpoint
# already exposes a terminal cursor; refusing to follow it after 200/400/500
# rows makes an account's saved list look complete when it is not.
CLIENT_FETCH_BOOKMARKS_OLD = '''        return self._fetch_timeline("Bookmarks", count, get_instructions)'''

CLIENT_FETCH_BOOKMARKS_NEW = '''        # Focus Feed Next: bookmarks must continue until the endpoint's
        # terminal cursor, not the generic safety cap used by other reads.
        return self._fetch_timeline(
            "Bookmarks",
            count,
            get_instructions,
            respect_max_count=False,
        )'''

CLIENT_SIGNATURE_OLD = '''    def _fetch_timeline(self, operation_name, count, get_instructions, extra_variables=None, override_base_variables=False, field_toggles=None, use_post=False, include_promoted=False, start_cursor=None, return_cursor=False):'''

CLIENT_SIGNATURE_NEW = '''    def _fetch_timeline(self, operation_name, count, get_instructions, extra_variables=None, override_base_variables=False, field_toggles=None, use_post=False, include_promoted=False, start_cursor=None, return_cursor=False, respect_max_count=True):'''

CLIENT_CAP_OLD = '''        # Enforce max count cap
        count = min(count, self._max_count)'''

CLIENT_CAP_NEW = '''        # Focus Feed Next: ordinary reads keep the provider safety cap, while
        # bookmarks opt out and follow their own terminal cursor to exhaustion.
        if respect_max_count:
            count = min(count, self._max_count)'''


def read(path):
    with io.open(path, encoding="utf-8") as fh:
        return fh.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def patch_models(path):
    text = read(path)
    if "class MediaVariant" in text:
        return False
    # `List` and `field` are needed by the new defaults; upstream imports both
    # already, but assert rather than assume.
    for needed in ("from dataclasses import", "List"):
        if needed not in text:
            raise Refused("models.py does not import %s" % needed)
    if "field" not in text.split("\n")[0:20][0] and "field" not in text:
        raise Refused("models.py does not import `field`")
    write(path, replace_once(text, MODELS_OLD, MODELS_NEW, "the TweetMedia definition"))
    return True


def patch_parser(path):
    text = read(path)
    if "_variant_size" in text:
        return False
    if "MediaVariant" not in text:
        text = replace_once(
            text,
            "from .models import",
            "from .models import MediaVariant,",
            "the models import",
        )
    text = replace_once(text, PARSER_OLD, PARSER_NEW, "the video media branch")
    write(path, text + VARIANT_SIZE)
    return True


def patch_serialization(path):
    text = read(path)
    if '"variants"' in text:
        return False
    write(path, replace_once(text, SERIAL_OLD, SERIAL_NEW, "the media serialiser"))
    return True


def patch_client(path):
    text = read(path)
    if "respect_max_count=False" in text:
        return False
    text = replace_once(
        text,
        CLIENT_FETCH_BOOKMARKS_OLD,
        CLIENT_FETCH_BOOKMARKS_NEW,
        "the bookmark fetch call",
    )
    text = replace_once(
        text,
        CLIENT_SIGNATURE_OLD,
        CLIENT_SIGNATURE_NEW,
        "the timeline fetch signature",
    )
    write(path, replace_once(text, CLIENT_CAP_OLD, CLIENT_CAP_NEW, "the timeline count cap"))
    return True


def main(site):
    steps = (
        ("models.py", patch_models),
        ("parser.py", patch_parser),
        ("serialization.py", patch_serialization),
        ("client.py", patch_client),
    )
    changed = 0
    for name, fn in steps:
        path = os.path.join(site, name)
        if not os.path.exists(path):
            raise Refused("no %s in %s" % (name, site))
        if fn(path):
            changed += 1
            print("patched %s" % name)
        else:
            print("%s already patched" % name)
    print("done (%d file(s) changed)" % changed)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: apply_patch.py <path to twitter_cli package>", file=sys.stderr)
        sys.exit(2)
    try:
        main(sys.argv[1])
    except Refused as e:
        print("refusing to patch: %s" % e, file=sys.stderr)
        sys.exit(1)
