import sys
import os
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.session.session_store import SessionStore
from src.session.session_engine import SessionEngine


class FakeMessages:
    """Minimal MessageStore stand-in: records callbacks and added messages."""

    def __init__(self):
        self._cbs = []
        self.added = []

    def on_message(self, cb):
        self._cbs.append(cb)

    def add(self, *args, **kwargs):
        # Mirror MessageStore.add(sender, text, ...): accept the positional
        # sender/text the engine passes for draft cards.
        if args:
            kwargs.setdefault("sender", args[0])
            if len(args) > 1:
                kwargs.setdefault("text", args[1])
        self.added.append(kwargs)
        return {"id": len(self.added)}

    def get_recent(self, count=50, channel=None):
        return list(self.added)


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


class SessionDraftTests(unittest.TestCase):
    """SRV-3: draft detect/validate/post moved from app.py into the engine."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = SessionStore(os.path.join(self.tmp, "Sessions.json"))
        self.messages = FakeMessages()
        self.engine = SessionEngine(
            self.store, self.messages, FakeTrigger(), FakeRegistry(["claude"])
        )

    @staticmethod
    def _draft(body):
        return "Here is my proposal:\n```session\n" + body + "\n```"

    def test_non_agent_sender_is_ignored(self):
        handled = self.engine.process_draft(
            self._draft('{"name": "x"}'), "user", "general", is_known_agent=False)
        self.assertFalse(handled)
        self.assertEqual(self.messages.added, [])

    def test_text_without_block_returns_false(self):
        handled = self.engine.process_draft(
            "just chatting", "claude", "general", is_known_agent=True)
        self.assertFalse(handled)
        self.assertEqual(self.messages.added, [])

    def test_invalid_json_posts_invalid_card(self):
        handled = self.engine.process_draft(
            self._draft("{ not json"), "claude", "general", is_known_agent=True)
        self.assertTrue(handled)
        card = self.messages.added[-1]
        self.assertEqual(card["msg_type"], "session_draft")
        self.assertFalse(card["metadata"]["valid"])

    def test_invalid_template_reports_errors(self):
        handled = self.engine.process_draft(
            self._draft('{"name": "x"}'), "claude", "general", is_known_agent=True)
        self.assertTrue(handled)
        card = self.messages.added[-1]
        self.assertFalse(card["metadata"]["valid"])
        self.assertTrue(card["metadata"]["errors"])

    def test_valid_template_posts_valid_card(self):
        body = json.dumps({
            "name": "My Session",
            "roles": ["a", "b"],
            "phases": [{"name": "P1", "participants": ["a", "b"],
                        "prompt": "go", "is_output": True}],
        })
        handled = self.engine.process_draft(
            self._draft(body), "claude", "general", is_known_agent=True)
        self.assertTrue(handled)
        card = self.messages.added[-1]
        self.assertTrue(card["metadata"]["valid"])
        self.assertEqual(card["metadata"]["revision"], 1)
        self.assertIn("My Session", card["text"])


if __name__ == "__main__":
    unittest.main()
