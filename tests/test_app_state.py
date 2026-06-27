"""Smoke test for the app_state.state wiring (SRV-2).

Verifies that app.configure() populates the single shared `state` object and
that mcp_bridge sees the very same object — the contract that replaced run.py's
per-name re-export into mcp_bridge.
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.server import app  # noqa: E402
from agentchattr.state import app_state  # noqa: E402
from agentchattr.mcp import mcp_bridge  # noqa: E402


class SharedStateTests(unittest.TestCase):
    def setUp(self):
        # Snapshot every state slot so configure() can't leak into other tests.
        self._saved = {n: getattr(app_state.state, n) for n in app_state.State.__slots__}

        def restore():
            for n, v in self._saved.items():
                setattr(app_state.state, n, v)

        self.addCleanup(restore)

    def test_app_and_mcp_bridge_import_the_same_object(self):
        self.assertIs(app.state, mcp_bridge.state)
        self.assertIs(app.state, app_state.state)

    def test_configure_populates_shared_state(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = {
                "server": {"data_dir": d},
                "agents": {"claude": {"label": "Claude", "color": "#3366ff"}},
            }
            app.configure(cfg, session_token="tok-123")

        s = app_state.state
        self.assertIsNotNone(s.store)
        self.assertIsNotNone(s.rules)
        self.assertIsNotNone(s.registry)
        self.assertIsNotNone(s.router)
        self.assertIsNotNone(s.session_engine)
        self.assertEqual(s.session_token, "tok-123")
        # mcp_bridge reads the same wired singletons — no re-export step.
        self.assertIs(mcp_bridge.state.store, s.store)
        self.assertIs(mcp_bridge.state.registry, s.registry)

    def test_state_slots_reject_typoed_attribute(self):
        with self.assertRaises(AttributeError):
            app_state.state.stroe = "typo"  # noqa: F841


if __name__ == "__main__":
    unittest.main()
