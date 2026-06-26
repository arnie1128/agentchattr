"""Tests for the naming/slot/color policy extracted from registry.py.

These are pure functions, so they test in isolation — no registry instance,
no lock, no disk.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from naming import derive_color, family_conflict, next_free_slot, parse_name  # noqa: E402


class ParseNameTests(unittest.TestCase):
    def test_numbered_slot(self):
        self.assertEqual(parse_name("gemini-2"), ("gemini", 2))

    def test_bare_base_is_slot_one(self):
        self.assertEqual(parse_name("gemini"), ("gemini", 1))

    def test_custom_alias_keeps_full_name_slot_one(self):
        # "claude-music" — suffix isn't an int, so the whole name is the base
        self.assertEqual(parse_name("claude-music"), ("claude-music", 1))

    def test_hyphenated_base_with_trailing_number(self):
        self.assertEqual(parse_name("telegram-bridge-3"), ("telegram-bridge", 3))


class NextFreeSlotTests(unittest.TestCase):
    def test_empty_sets_give_slot_one(self):
        self.assertEqual(next_free_slot(set(), set()), 1)

    def test_skips_taken(self):
        self.assertEqual(next_free_slot({1}, set()), 2)

    def test_skips_reserved(self):
        self.assertEqual(next_free_slot(set(), {1, 2}), 3)

    def test_fills_lowest_gap_across_both(self):
        self.assertEqual(next_free_slot({1, 3}, {2}), 4)


class FamilyConflictTests(unittest.TestCase):
    BASES = {"claude": {}, "gemini": {}}

    def test_other_family_base_blocked(self):
        self.assertIsNotNone(family_conflict("gemini", "claude", self.BASES))

    def test_other_family_numbered_blocked(self):
        self.assertIsNotNone(family_conflict("gemini-2", "claude", self.BASES))

    def test_custom_alias_in_own_family_allowed(self):
        self.assertIsNone(family_conflict("claude-prime", "claude", self.BASES))

    def test_unrelated_custom_name_allowed(self):
        self.assertIsNone(family_conflict("cudders", "claude", self.BASES))

    def test_numbered_within_own_family_allowed(self):
        self.assertIsNone(family_conflict("claude-2", "claude", self.BASES))


class DeriveColorTests(unittest.TestCase):
    def test_slot_one_returns_base_unchanged(self):
        self.assertEqual(derive_color("#3366ff", 1), "#3366ff")

    def test_malformed_hex_returns_input(self):
        self.assertEqual(derive_color("#abc", 2), "#abc")

    def test_variant_slot_shifts_to_a_distinct_valid_hex(self):
        out = derive_color("#3366ff", 2)
        self.assertNotEqual(out, "#3366ff")
        self.assertRegex(out, r"^#[0-9a-f]{6}$")


if __name__ == "__main__":
    unittest.main()
