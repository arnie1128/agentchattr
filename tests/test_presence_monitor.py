"""Orchestration tests for the presence reaper (SRV-7).

Drives presence_monitor.tick() with fake state + real mcp_state, asserting the
crash-timeout, leave-debounce, back-online and recovery-flag behaviours that
were never covered while the reaper was an inline closure in configure().
event_loop/broadcast are None so the broadcast calls are skipped.
"""

import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.state import mcp_state  # noqa: E402
from src.server import presence_monitor  # noqa: E402


class FakeStore:
    def __init__(self):
        self.added = []
        self.renamed = []

    def add(self, sender, text, **kw):
        self.added.append((sender, text, kw))

    def rename_sender(self, old, new):
        self.renamed.append((old, new))


class FakeRegistry:
    def __init__(self, names):
        self.names = set(names)
        self.deregistered = []

    def get_all_names(self):
        return list(self.names)

    def get_instance(self, n):
        return {"name": n} if n in self.names else None

    def is_registered(self, n):
        return n in self.names

    def deregister(self, n):
        if n in self.names:
            self.names.discard(n)
            self.deregistered.append(n)
            return {"name": n}
        return None

    def clean_renames_for(self, n):
        pass


class FakeState:
    def __init__(self, store, registry):
        self.store = store
        self.registry = registry


def _tick(state, **over):
    kw = dict(
        event_loop=None, broadcast_status=None, broadcast_raw=None,
        data_dir=over.pop("data_dir", "."), last_active_channel="general",
        known_online=over.pop("known_online", set()),
        posted_leave=over.pop("posted_leave", set()),
        known_active=over.pop("known_active", set()),
    )
    kw.update(over)
    presence_monitor.tick(state, **kw)
    return kw


class PresenceMonitorTests(unittest.TestCase):
    def setUp(self):
        names = ("_presence", "_activity", "_activity_ts", "_renamed_from")
        self._snap = {
            n: (dict(getattr(mcp_state, n)) if isinstance(getattr(mcp_state, n), dict)
                else set(getattr(mcp_state, n)))
            for n in names
        }

        def restore():
            for n, v in self._snap.items():
                d = getattr(mcp_state, n)
                d.clear()
                d.update(v)

        self.addCleanup(restore)
        for n in names:
            getattr(mcp_state, n).clear()

    def test_recovery_flag_drain(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "claude_recovered").write_text("claude", "utf-8")
            store = FakeStore()
            _tick(FakeState(store, FakeRegistry([])), data_dir=d)
            self.assertTrue(any("auto-recovered" in t for _, t, _ in store.added))
            self.assertFalse((Path(d) / "claude_recovered").exists())

    def test_crash_timeout_deregisters_and_posts_leave(self):
        mcp_state._presence["claude"] = time.time() - 100  # stale heartbeat
        store = FakeStore()
        reg = FakeRegistry(["claude"])
        _tick(FakeState(store, reg), crash_timeout=15)
        self.assertIn("claude", reg.deregistered)
        self.assertTrue(any("disconnected (timeout)" in t for _, t, _ in store.added))

    def test_leave_debounce_no_duplicate(self):
        # Registered, never heartbeated -> last_seen 0 -> no crash timeout, but
        # offline -> a single leave, debounced on the next pass.
        store = FakeStore()
        state = FakeState(store, FakeRegistry(["claude"]))
        po, ko = set(), set()
        _tick(state, posted_leave=po, known_online=ko)
        self.assertEqual(len([t for _, t, _ in store.added if "disconnected" in t]), 1)
        store.added.clear()
        _tick(state, posted_leave=po, known_online=ko)
        self.assertEqual([t for _, t, _ in store.added if "disconnected" in t], [])

    def test_back_online_clears_debounce(self):
        store = FakeStore()
        state = FakeState(store, FakeRegistry(["claude"]))
        po = {"claude"}  # we previously posted a leave
        mcp_state.touch_presence("claude")  # now back online
        _tick(state, posted_leave=po)
        self.assertNotIn("claude", po)  # cleared by `posted_leave -= currently_online`


if __name__ == "__main__":
    unittest.main()
