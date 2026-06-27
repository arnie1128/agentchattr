"""Tests for the public resolve methods extracted in SRV-4.

store.resolve_decision and jobs.resolve_message move the atomic check-and-set
out of the HTTP handlers, which previously reached into private members
(store._lock/_messages/_rewrite, jobs._save).
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.storage.store import MessageStore
from src.storage.jobs import JobStore


class ResolveDecisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = MessageStore(os.path.join(self.tmp, "log.jsonl"))

    def _add_decision(self, choices=("a", "b")):
        return self.store.add("planner", "Pick one", msg_type="decision",
                              metadata={"choices": list(choices)})

    def test_resolve_marks_chosen_and_returns_sender(self):
        msg = self._add_decision()
        error, channel, sender = self.store.resolve_decision(msg["id"], "a")
        self.assertIsNone(error)
        self.assertEqual(sender, "planner")
        stored = self.store.get_by_id(msg["id"])
        self.assertTrue(stored["metadata"]["resolved"])
        self.assertEqual(stored["metadata"]["chosen"], "a")

    def test_double_resolve_is_rejected(self):
        msg = self._add_decision()
        self.store.resolve_decision(msg["id"], "a")
        error, _, _ = self.store.resolve_decision(msg["id"], "b")
        self.assertEqual(error, ("already resolved", 400))

    def test_invalid_choice_rejected(self):
        msg = self._add_decision(choices=("yes", "no"))
        error, _, _ = self.store.resolve_decision(msg["id"], "maybe")
        self.assertEqual(error[1], 400)
        self.assertFalse(self.store.get_by_id(msg["id"])["metadata"].get("resolved"))

    def test_missing_message_is_404(self):
        error, _, _ = self.store.resolve_decision(9999, "a")
        self.assertEqual(error, ("message not found", 404))

    def test_non_decision_message_rejected(self):
        chat = self.store.add("ben", "hi")
        error, _, _ = self.store.resolve_decision(chat["id"], "a")
        self.assertEqual(error, ("not a decision message", 400))


class ResolveJobMessageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.jobs = JobStore(os.path.join(self.tmp, "jobs.json"))

    def test_resolve_marks_message_and_returns_job(self):
        job = self.jobs.create("T", "task", "general", "user")
        self.jobs.add_message(job["id"], "codex", "[suggestion] refactor")
        error, rjob, rmsg = self.jobs.resolve_message(job["id"], 0, "accepted")
        self.assertIsNone(error)
        self.assertEqual(rjob["id"], job["id"])
        self.assertEqual(rmsg["resolved"], "accepted")

    def test_missing_job_returns_not_found(self):
        error, job, msg = self.jobs.resolve_message(9999, 0, "dismissed")
        self.assertEqual(error, "not found")
        self.assertIsNone(job)

    def test_invalid_index_rejected(self):
        job = self.jobs.create("T", "task", "general", "user")
        error, _, _ = self.jobs.resolve_message(job["id"], 5, "dismissed")
        self.assertEqual(error, "invalid message index")


if __name__ == "__main__":
    unittest.main()
