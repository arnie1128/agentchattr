"""Tests for JobStore read/write contract (NEW-STATE-PERSIST-2)."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from jobs import JobStore  # noqa: E402


class ListAllPureReadTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "jobs.json"
        self.store = JobStore(str(self.path))

    def test_list_all_does_not_write_to_disk(self):
        self.store.create("title", "task", "general", "user")
        before = self.path.read_bytes()
        self.store.list_all()
        self.store.list_all(channel="general")
        self.store.list_all(status="done")
        self.assertEqual(self.path.read_bytes(), before)  # read must not persist

    def test_created_jobs_have_positive_sort_order(self):
        self.store.create("a", "task", "general", "user")
        self.store.create("b", "task", "general", "user")
        self.assertTrue(all(j.get("sort_order", 0) > 0 for j in self.store.list_all()))

    def test_filters_apply(self):
        self.store.create("a", "task", "general", "user")              # default status "done"
        self.store.create("b", "task", "dev", "user", status="open")
        self.assertEqual(len(self.store.list_all(channel="dev")), 1)
        self.assertEqual(len(self.store.list_all(status="done")), 1)
        self.assertEqual(len(self.store.list_all(status="open")), 1)


if __name__ == "__main__":
    unittest.main()
