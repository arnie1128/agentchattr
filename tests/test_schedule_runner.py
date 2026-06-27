"""Tests for the scheduled-prompt runner (SRV-7)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.server import schedule_runner  # noqa: E402


class FakeSchedules:
    def __init__(self, due):
        self._due = due
        self.ran = []
        self.deleted = []

    def run_due(self):
        return list(self._due)

    def mark_run(self, sid):
        self.ran.append(sid)

    def delete(self, sid):
        self.deleted.append(sid)


class FakeStore:
    def __init__(self):
        self.added = []

    def add(self, sender, text, **kw):
        self.added.append((sender, text, kw))


class FakeState:
    def __init__(self, store, schedules):
        self.store = store
        self.schedules = schedules


class ScheduleRunnerTests(unittest.TestCase):
    def test_due_schedule_posts_and_marks_run(self):
        sch = FakeSchedules([
            {"id": 1, "prompt": "hi", "targets": ["claude"], "channel": "dev", "created_by": "user"}
        ])
        store = FakeStore()
        schedule_runner.tick(FakeState(store, sch))
        self.assertEqual(len(store.added), 1)
        sender, text, kw = store.added[0]
        self.assertEqual(sender, "user")
        self.assertIn("@claude hi", text)
        self.assertEqual(kw["channel"], "dev")
        self.assertEqual(sch.ran, [1])

    def test_one_shot_is_deleted_not_marked(self):
        sch = FakeSchedules([{"id": 2, "prompt": "x", "targets": ["a"], "one_shot": True}])
        schedule_runner.tick(FakeState(FakeStore(), sch))
        self.assertEqual(sch.deleted, [2])
        self.assertEqual(sch.ran, [])

    def test_empty_prompt_marks_run_without_posting(self):
        sch = FakeSchedules([{"id": 3, "prompt": "", "targets": []}])
        store = FakeStore()
        schedule_runner.tick(FakeState(store, sch))
        self.assertEqual(store.added, [])
        self.assertEqual(sch.ran, [3])

    def test_no_schedules_is_noop(self):
        class _NoSchedules:
            schedules = None

        schedule_runner.tick(_NoSchedules())  # must not raise


if __name__ == "__main__":
    unittest.main()
