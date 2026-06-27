"""Behavior tests for mcp_state — the presence/roles/cursor state extracted
from mcp_bridge (MCP-3).

_ROLES_FILE / _CURSORS_FILE default to None, so set_role/_update_cursor skip
disk writes; these exercise the in-memory contract only. Each test snapshots
and restores the module dicts so they don't leak across tests.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import mcp_state  # noqa: E402


class McpStateTests(unittest.TestCase):
    def setUp(self):
        snap = {
            "_presence": dict(mcp_state._presence),
            "_activity": dict(mcp_state._activity),
            "_activity_ts": dict(mcp_state._activity_ts),
            "_renamed_from": set(mcp_state._renamed_from),
            "_cursors": {k: dict(v) for k, v in mcp_state._cursors.items()},
            "_roles": dict(mcp_state._roles),
        }

        def restore():
            for name, val in snap.items():
                d = getattr(mcp_state, name)
                d.clear()       # dict and set both support clear()+update()
                d.update(val)

        self.addCleanup(restore)
        # Start each test from a clean slate.
        for name in ("_presence", "_activity", "_activity_ts", "_cursors", "_roles"):
            getattr(mcp_state, name).clear()
        mcp_state._renamed_from.clear()

    def test_touch_presence_marks_online(self):
        self.assertFalse(mcp_state.is_online("claude"))
        mcp_state._touch_presence("claude")
        self.assertTrue(mcp_state.is_online("claude"))
        self.assertIn("claude", mcp_state._get_online())

    def test_role_round_trip_and_clear(self):
        mcp_state.set_role("claude", "reviewer")
        self.assertEqual(mcp_state.get_role("claude"), "reviewer")
        self.assertEqual(mcp_state.get_all_roles(), {"claude": "reviewer"})
        mcp_state.set_role("claude", "")  # empty clears
        self.assertEqual(mcp_state.get_role("claude"), "")

    def test_migrate_identity_moves_presence_and_role(self):
        mcp_state._touch_presence("claude")
        mcp_state.set_role("claude", "lead")
        mcp_state.migrate_identity("claude", "claude-music")
        self.assertTrue(mcp_state.is_online("claude-music"))
        self.assertFalse(mcp_state.is_online("claude"))
        self.assertEqual(mcp_state.get_role("claude-music"), "lead")
        self.assertIn("claude", mcp_state._renamed_from)

    def test_purge_identity_clears_all(self):
        mcp_state._touch_presence("codex")
        mcp_state.set_role("codex", "qa")
        mcp_state.purge_identity("codex")
        self.assertFalse(mcp_state.is_online("codex"))
        self.assertEqual(mcp_state.get_role("codex"), "")

    def test_update_cursor_records_last_id(self):
        mcp_state._update_cursor("claude", [{"id": 7}, {"id": 9}], "general")
        self.assertEqual(mcp_state._cursors["claude"]["general"], 9)

    # --- Presence service API (STATE-1) ---

    def test_touch_presence_public_alias(self):
        mcp_state.touch_presence("claude")
        self.assertTrue(mcp_state.is_online("claude"))

    def test_sweep_reports_online_and_active(self):
        import time
        now = time.time()
        mcp_state._presence["claude"] = now
        mcp_state._presence["stale"] = now - mcp_state.PRESENCE_TIMEOUT - 1
        mcp_state._activity["claude"] = True
        mcp_state._activity_ts["claude"] = now
        online, active = mcp_state.sweep()
        self.assertEqual(online, {"claude"})
        self.assertEqual(active, {"claude"})

    def test_sweep_auto_expires_stale_activity(self):
        import time
        now = time.time()
        mcp_state._presence["claude"] = now
        mcp_state._activity["claude"] = True
        mcp_state._activity_ts["claude"] = now - mcp_state.ACTIVITY_TIMEOUT - 1
        _, active = mcp_state.sweep()
        self.assertEqual(active, set())
        self.assertFalse(mcp_state._activity["claude"])  # expired in place

    def test_last_seen_returns_timestamp(self):
        import time
        self.assertEqual(mcp_state.last_seen("nobody"), 0)
        t = time.time()
        mcp_state._presence["claude"] = t
        self.assertEqual(mcp_state.last_seen("claude"), t)

    def test_pop_renamed_is_one_shot(self):
        mcp_state._renamed_from.add("claude-2")
        self.assertTrue(mcp_state.pop_renamed("claude-2"))
        self.assertFalse(mcp_state.pop_renamed("claude-2"))  # cleared after first pop

    def test_clear_activity_offline(self):
        mcp_state._activity["on"] = True
        mcp_state._activity["off"] = True
        cleared = mcp_state.clear_activity_offline({"on"})
        self.assertEqual(cleared, ["off"])
        self.assertTrue(mcp_state._activity["on"])
        self.assertFalse(mcp_state._activity["off"])

    def test_report_active_returns_changed(self):
        self.assertTrue(mcp_state.report_active("claude", True))    # False -> True
        self.assertFalse(mcp_state.report_active("claude", True))   # no change
        self.assertTrue(mcp_state.report_active("claude", False))   # True -> False


if __name__ == "__main__":
    unittest.main()
