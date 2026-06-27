"""Tests for session_engine.auto_cast — role→agent assignment (SRV-8, moved from app.py)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.session.session_engine import auto_cast  # noqa: E402


class AutoCastTests(unittest.TestCase):
    def test_assigns_one_agent_per_role_in_order(self):
        self.assertEqual(auto_cast(["lead", "review"], ["x", "y"], "u"), {"lead": "x", "review": "y"})

    def test_reuses_agents_round_robin_when_more_roles(self):
        self.assertEqual(
            auto_cast(["a", "b", "c"], ["x", "y"], "u"),
            {"a": "x", "b": "y", "c": "x"},
        )

    def test_empty_when_no_agents(self):
        self.assertEqual(auto_cast(["a"], [], "u"), {})

    def test_empty_roles_is_empty_cast(self):
        self.assertEqual(auto_cast([], ["x"], "u"), {})


if __name__ == "__main__":
    unittest.main()
