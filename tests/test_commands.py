"""Tests for commands.py broadcast-macro expansion (SRV-3)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.server import commands  # noqa: E402

AGENTS = ["claude", "codex"]
COLORS = {"claude": "#f80", "codex": "#08f"}


class IsMacroTests(unittest.TestCase):
    def test_known_macros(self):
        for cmd in ("/hatmaking", "/artchallenge", "/roastreview", "/poetry"):
            self.assertTrue(commands.is_macro(cmd))

    def test_non_macros(self):
        for cmd in ("/continue", "/clear", "/unknown", "", "hello"):
            self.assertFalse(commands.is_macro(cmd))


class ExpandTests(unittest.TestCase):
    def test_non_macro_returns_none(self):
        self.assertIsNone(commands.expand("/continue", AGENTS, COLORS))
        self.assertIsNone(commands.expand("", AGENTS, COLORS))

    def test_roastreview_mentions_all(self):
        out = commands.expand("/roastreview", AGENTS, COLORS)
        self.assertIn("@claude", out)
        self.assertIn("@codex", out)
        self.assertIn("roast review", out.lower())

    def test_artchallenge_default_theme(self):
        out = commands.expand("/artchallenge", AGENTS, COLORS)
        self.assertIn("anything you like", out)

    def test_artchallenge_custom_theme(self):
        out = commands.expand("/artchallenge dragons at dawn", AGENTS, COLORS)
        self.assertIn("**dragons at dawn**", out)

    def test_hatmaking_includes_colors(self):
        out = commands.expand("/hatmaking", AGENTS, COLORS)
        self.assertIn("claude=#f80", out)
        self.assertIn("codex=#08f", out)

    def test_hatmaking_color_falls_back(self):
        out = commands.expand("/hatmaking", ["mystery"], {})
        self.assertIn("mystery=#888", out)

    def test_poetry_default_haiku(self):
        out = commands.expand("/poetry", AGENTS, COLORS)
        self.assertIn("haiku", out)

    def test_poetry_valid_forms(self):
        self.assertIn("limerick", commands.expand("/poetry limerick", AGENTS, COLORS))
        self.assertIn("sonnet", commands.expand("/poetry sonnet", AGENTS, COLORS))

    def test_poetry_invalid_form_defaults_to_haiku(self):
        out = commands.expand("/poetry epic", AGENTS, COLORS)
        self.assertIn("haiku", out)


if __name__ == "__main__":
    unittest.main()
