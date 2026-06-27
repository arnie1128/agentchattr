"""Tests for the single reachability predicate (STATE-1).

`app.reachable(name)` / `app.reachable_names()` are the one place registry
identity (claimed) and mcp_state presence (heartbeat) are combined for @all
routing. These stub the registry and drive presence directly — no full
configure() needed.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.server import app  # noqa: E402
from src.state import app_state  # noqa: E402
from src.state import mcp_state  # noqa: E402


class _StubRegistry:
    def __init__(self, active_names):
        self._names = list(active_names)

    def get_active_names(self):
        return list(self._names)


class ReachableTests(unittest.TestCase):
    def setUp(self):
        self._saved_registry = app_state.state.registry
        self._saved_presence = dict(mcp_state._presence)

        def restore():
            app_state.state.registry = self._saved_registry
            mcp_state._presence.clear()
            mcp_state._presence.update(self._saved_presence)

        self.addCleanup(restore)
        mcp_state._presence.clear()

    def test_reachable_requires_claimed_and_present(self):
        app_state.state.registry = _StubRegistry(["claude"])
        mcp_state.touch_presence("claude")
        self.assertTrue(app.reachable("claude"))
        self.assertEqual(app.reachable_names(), {"claude"})

    def test_not_reachable_when_claimed_but_offline(self):
        app_state.state.registry = _StubRegistry(["claude"])  # no heartbeat
        self.assertFalse(app.reachable("claude"))
        self.assertEqual(app.reachable_names(), set())

    def test_not_reachable_when_present_but_unclaimed(self):
        app_state.state.registry = _StubRegistry([])  # not in active names
        mcp_state.touch_presence("ghost")
        self.assertFalse(app.reachable("ghost"))
        self.assertEqual(app.reachable_names(), set())

    def test_no_registry_is_empty(self):
        app_state.state.registry = None
        self.assertFalse(app.reachable("claude"))
        self.assertEqual(app.reachable_names(), set())


if __name__ == "__main__":
    unittest.main()
