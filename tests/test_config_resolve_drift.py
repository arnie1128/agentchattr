"""Drift guard for the intentionally-duplicated path resolver (WRAP-6).

config_loader.resolve_path and instance-template/_load.py:resolve are kept as
two copies on purpose (the template runs before agentchattr's install dir is
located, so it cannot import config_loader). This asserts the two stay in sync
across absolute / ~user / relative inputs, so a silent edit to one is caught.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core import config_loader  # noqa: E402


def _load_template_module():
    path = ROOT / "instance-template" / "_load.py"
    spec = importlib.util.spec_from_file_location("_agentchattr_load_template", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ResolvePathDriftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = _load_template_module()
        cls.anchor = ROOT / "anchor-dir"

    def _assert_agree(self, raw):
        from_loader = config_loader.resolve_path(raw, self.anchor)
        from_template = str(self.template.resolve(raw, self.anchor))
        self.assertEqual(from_loader, from_template, f"resolver drift for {raw!r}")

    def test_absolute_path_agrees(self):
        self._assert_agree(str(ROOT))

    def test_relative_path_anchors_the_same(self):
        self._assert_agree("data/sub")

    def test_tilde_path_expands_the_same(self):
        self._assert_agree("~/somewhere")


if __name__ == "__main__":
    unittest.main()
