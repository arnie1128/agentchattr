"""Tests for uploads.save_upload — the shared MCP image path-copy (NEW-MCP-1)."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.server import uploads  # noqa: E402


class SaveUploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.up = self.tmp / "uploads"
        self.config = {"images": {"upload_dir": str(self.up)}}

    def _make_src(self, name="pic.png"):
        p = self.tmp / name
        p.write_bytes(b"data")
        return str(p)

    def test_valid_copies_and_returns_attachment(self):
        att, err = uploads.save_upload(self._make_src("pic.png"), self.config)
        self.assertIsNone(err)
        self.assertEqual(att["name"], "pic.png")
        self.assertTrue(att["url"].startswith("/uploads/"))
        self.assertEqual(len(list(self.up.glob("*.png"))), 1)  # copied into upload dir

    def test_missing_file_returns_error(self):
        att, err = uploads.save_upload(str(self.tmp / "nope.png"), self.config)
        self.assertIsNone(att)
        self.assertIn("not found", err)

    def test_unsupported_extension_returns_error(self):
        att, err = uploads.save_upload(self._make_src("x.exe"), self.config)
        self.assertIsNone(att)
        self.assertIn("Unsupported", err)
        self.assertFalse(self.up.exists())  # nothing written on rejection


if __name__ == "__main__":
    unittest.main()
