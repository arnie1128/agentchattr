import sys
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from session_store import SessionStore
from session_engine import SessionEngine


class FakeMessages:
    """Minimal MessageStore stand-in: records callbacks and added messages."""

    def __init__(self):
        self._cbs = []
        self.added = []

    def on_message(self, cb):
        self._cbs.append(cb)

    def add(self, **kwargs):
        self.added.append(kwargs)
        return {"id": len(self.added)}


class FakeTrigger:
    def __init__(self):
        self.calls = []

    def trigger_sync(self, agent, channel=None, prompt=None):
        self.calls.append((agent, channel))


class FakeRegistry:
    def __init__(self, agents):
        self._agents = set(agents)

    def is_registered(self, name):
        return name in self._agents


class SessionAdvanceRaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = SessionStore(os.path.join(self.tmp, "Sessions.json"))
        # Inject a single-phase template with three agent participants.
        self.store._templates["t1"] = {
            "id": "t1",
            "name": "T",
            "roles": ["a", "b", "c"],
            "phases": [
                {
                    "name": "P1",
                    "participants": ["a", "b", "c"],
                    "prompt": "",
                    "is_output": True,
                },
            ],
        }
        self.messages = FakeMessages()
        self.trigger = FakeTrigger()
        self.registry = FakeRegistry(["A", "B", "C"])
        self.engine = SessionEngine(
            self.store, self.messages, self.trigger, self.registry
        )

    def test_double_advance_from_same_snapshot_advances_turn_once(self):
        """Two timers fired off one stale snapshot must not skip a participant.

        Reproduces BUG-1: _advance decided next turn from a snapshot and the
        live session was incremented unconditionally, so two near-simultaneous
        advances off the same snapshot stepped current_turn twice (0 -> 2),
        silently skipping participant 'b'.
        """
        session = self.store.create(
            "t1", "general", {"a": "A", "b": "B", "c": "C"}, "user"
        )
        snapshot = dict(session)  # current_phase=0, current_turn=0

        # Simulate the race: both timers carry the same snapshot.
        self.engine._advance(snapshot, message_id=1)
        self.engine._advance(dict(snapshot), message_id=1)

        live = self.store.get(session["id"])
        self.assertEqual(live["current_turn"], 1)

    def test_single_advance_still_progresses(self):
        """The stale-snapshot guard must not block a legitimate advance."""
        session = self.store.create(
            "t1", "general", {"a": "A", "b": "B", "c": "C"}, "user"
        )
        self.engine._advance(dict(session), message_id=1)

        live = self.store.get(session["id"])
        self.assertEqual(live["current_turn"], 1)
        self.assertEqual(self.trigger.calls[-1][0], "B")

    def test_enrich_leaves_the_source_session_untouched(self):
        """STATE-3: derived view fields must not land on the system-of-record dict."""
        session = self.store.create(
            "t1", "general", {"a": "A", "b": "B", "c": "C"}, "user"
        )
        enriched = self.engine._enrich(session)
        # the returned copy carries the computed view fields
        self.assertEqual(enriched["total_phases"], 1)
        self.assertEqual(enriched["phase_name"], "P1")
        self.assertEqual(enriched["current_agent"], "A")
        # the source dict (what SessionStore persists) stays clean
        for field in ("total_phases", "phase_name", "current_role", "current_agent"):
            self.assertNotIn(field, session)


if __name__ == "__main__":
    unittest.main()
