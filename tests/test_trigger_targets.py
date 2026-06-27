"""Tests for app._trigger_targets — the shared routing-gate loop (SRV-5).

Covers the gates the channel and job routers share (pending-skip, session turn
guard, offline-queue notice) and the exact-payload pass-through (prompt incl.
"", job_id) that keeps both callers behaviour-identical.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.server import app  # noqa: E402
from agentchattr.state import app_state  # noqa: E402
from agentchattr.state import mcp_state  # noqa: E402


class _FakeRegistry:
    def __init__(self, pending=()):
        self.pending = set(pending)

    def get_instance(self, n):
        return {"state": "pending"} if n in self.pending else {"state": "active"}


class _FakeAgents:
    def __init__(self, available):
        self.available = set(available)
        self.calls = []

    def is_available(self, n):
        return n in self.available

    async def trigger(self, target, **kw):
        self.calls.append((target, kw))


class _FakeStore:
    def __init__(self):
        self.added = []

    def add(self, sender, text, **kw):
        self.added.append((sender, text, kw))


class TriggerTargetsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved = (app_state.state.registry, app_state.state.agents, app_state.state.store)
        self._pres = dict(mcp_state._presence)

        def restore():
            (app_state.state.registry, app_state.state.agents, app_state.state.store) = self._saved
            mcp_state._presence.clear()
            mcp_state._presence.update(self._pres)

        self.addCleanup(restore)
        mcp_state._presence.clear()

    def _wire(self, available, pending=()):
        agents = _FakeAgents(available)
        store = _FakeStore()
        app_state.state.registry = _FakeRegistry(pending)
        app_state.state.agents = agents
        app_state.state.store = store
        return agents, store

    async def test_triggers_available_targets(self):
        agents, _ = self._wire(available=["a", "b"])
        await app._trigger_targets(["a", "b"], channel="general", chat_msg="x")
        self.assertEqual([c[0] for c in agents.calls], ["a", "b"])

    async def test_skips_pending_instances(self):
        agents, _ = self._wire(available=["a"], pending=["a"])
        await app._trigger_targets(["a"], channel="general", chat_msg="x")
        self.assertEqual(agents.calls, [])

    async def test_session_guard_allows_only_one(self):
        agents, _ = self._wire(available=["a", "b"])
        await app._trigger_targets(["a", "b"], channel="g", chat_msg="x", allowed_agent="b")
        self.assertEqual([c[0] for c in agents.calls], ["b"])

    async def test_notify_offline_posts_queue_notice_and_still_triggers(self):
        agents, store = self._wire(available=["a"])  # available but no presence -> offline
        await app._trigger_targets(["a"], channel="g", chat_msg="x", notify_offline=True)
        self.assertTrue(any("queued" in t for _, t, _ in store.added))
        self.assertEqual([c[0] for c in agents.calls], ["a"])

    async def test_payload_passthrough(self):
        agents, _ = self._wire(available=["a"])
        await app._trigger_targets(["a"], channel="g", chat_msg="x", job_id=7)
        self.assertEqual(agents.calls[0][1].get("job_id"), 7)
        self.assertNotIn("prompt", agents.calls[0][1])  # job path passes no prompt
        agents.calls.clear()
        await app._trigger_targets(["a"], channel="g", chat_msg="x", prompt="")
        self.assertEqual(agents.calls[0][1].get("prompt"), "")  # "" is still forwarded
        self.assertNotIn("job_id", agents.calls[0][1])


if __name__ == "__main__":
    unittest.main()
