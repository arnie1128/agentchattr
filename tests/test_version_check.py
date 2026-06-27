"""Tests for version_check (SRV-8).

compare_versions degrades to 'unknown' without the `packaging` dependency (as it
did inline in app.py), so the meaningful coverage is the state-mapping in check()
— exercised by monkeypatching the module's leaf functions.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.core import version_check as vc  # noqa: E402


class CompareVersionsTests(unittest.TestCase):
    def test_empty_inputs_are_unknown(self):
        self.assertEqual(vc.compare_versions("", "v1.0.0"), "unknown")
        self.assertEqual(vc.compare_versions("1.0.0", ""), "unknown")


class CheckStateMappingTests(unittest.TestCase):
    def setUp(self):
        self._saved = (vc.fetch_latest_release, vc.detect_install_kind,
                       vc.compare_versions, vc.read_local_version)

        def restore():
            (vc.fetch_latest_release, vc.detect_install_kind,
             vc.compare_versions, vc.read_local_version) = self._saved

        self.addCleanup(restore)
        vc.read_local_version = lambda: "1.0.0"

    def test_no_release_is_unknown(self):
        vc.fetch_latest_release = lambda: None
        r = vc.check()
        self.assertEqual(r["state"], "unknown")
        self.assertEqual(r["latest"], "")

    def test_behind_official_git_is_update_available(self):
        vc.fetch_latest_release = lambda: {"tag": "v2.0.0", "url": "u"}
        vc.detect_install_kind = lambda: "official_git"
        vc.compare_versions = lambda c, l: "behind"
        r = vc.check()
        self.assertEqual(r["state"], "update_available")
        self.assertEqual(r["latest"], "v2.0.0")
        self.assertEqual(r["url"], "u")

    def test_behind_fork_is_upstream_update(self):
        vc.fetch_latest_release = lambda: {"tag": "v2.0.0", "url": ""}
        vc.detect_install_kind = lambda: "fork"
        vc.compare_versions = lambda c, l: "behind"
        self.assertEqual(vc.check()["state"], "upstream_update")

    def test_current_is_current(self):
        vc.fetch_latest_release = lambda: {"tag": "v1.0.0", "url": ""}
        vc.compare_versions = lambda c, l: "current"
        self.assertEqual(vc.check()["state"], "current")


if __name__ == "__main__":
    unittest.main()
