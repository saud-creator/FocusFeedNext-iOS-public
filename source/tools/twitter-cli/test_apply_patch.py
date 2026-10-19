"""Regression checks for the provider rewriter.

This test does not touch an installed provider or any credentials. It exercises
the bookmark-only count-cap edit against the exact source shape the installer
expects and confirms that the second run is idempotent.
"""

import importlib.util
import tempfile
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("apply_patch.py")
SPEC = importlib.util.spec_from_file_location("focusfeed_apply_patch", MODULE_PATH)
assert SPEC and SPEC.loader
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)


CLIENT_SOURCE = """class TwitterClient:
    def fetch_bookmarks(self, count, get_instructions):
        return self._fetch_timeline("Bookmarks", count, get_instructions)

    def _fetch_timeline(self, operation_name, count, get_instructions, extra_variables=None, override_base_variables=False, field_toggles=None, use_post=False, include_promoted=False, start_cursor=None, return_cursor=False):
        # Enforce max count cap
        count = min(count, self._max_count)
"""


def main():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "client.py"
        path.write_text(CLIENT_SOURCE, encoding="utf-8")

        assert PATCHER.patch_client(str(path)) is True
        patched = path.read_text(encoding="utf-8")
        assert "respect_max_count=False" in patched
        assert "if respect_max_count:" in patched
        assert "count = min(count, self._max_count)" in patched

        assert PATCHER.patch_client(str(path)) is False
        assert path.read_text(encoding="utf-8") == patched


if __name__ == "__main__":
    main()
    print("ok")
