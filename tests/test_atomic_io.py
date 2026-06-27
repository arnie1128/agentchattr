import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.core import atomic_io
from agentchattr.core.atomic_io import write_json_atomic


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "data.json"

    def test_writes_valid_json_with_no_tmp_leftover(self):
        write_json_atomic(self.path, {"a": 1, "b": [2, 3]})
        self.assertEqual(
            json.loads(self.path.read_text("utf-8")), {"a": 1, "b": [2, 3]}
        )
        self.assertFalse((self.dir / "data.json.tmp").exists())

    def test_output_matches_legacy_bare_write_format(self):
        # The two converted sites used json.dumps(indent=2, ensure_ascii=False)
        # plus a trailing newline; output must stay byte-identical.
        data = [{"id": 1, "name": "café"}]
        write_json_atomic(self.path, data)
        expected = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        self.assertEqual(self.path.read_text("utf-8"), expected)

    def test_serialization_failure_leaves_original_intact(self):
        write_json_atomic(self.path, {"ok": True})
        original = self.path.read_text("utf-8")
        with self.assertRaises(TypeError):
            write_json_atomic(self.path, {"bad": {1, 2, 3}})  # set -> not JSON
        self.assertEqual(self.path.read_text("utf-8"), original)
        self.assertFalse((self.dir / "data.json.tmp").exists())

    def test_replace_failure_preserves_original_and_cleans_tmp(self):
        write_json_atomic(self.path, {"v": 1})
        original = self.path.read_text("utf-8")
        real_replace = os.replace

        def boom(src, dst):
            raise OSError("simulated replace failure")

        os.replace = boom
        try:
            with self.assertRaises(OSError):
                write_json_atomic(self.path, {"v": 2})
        finally:
            os.replace = real_replace
        self.assertEqual(self.path.read_text("utf-8"), original)
        self.assertFalse((self.dir / "data.json.tmp").exists())


class AtomicJsonlWriteTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "log.jsonl"

    def test_writes_one_json_object_per_line(self):
        rows = [{"id": 1, "t": "café"}, {"id": 2, "t": "x"}]
        atomic_io.write_jsonl_atomic(self.path, rows)
        lines = self.path.read_text("utf-8").splitlines()
        self.assertEqual([json.loads(ln) for ln in lines], rows)
        self.assertFalse((self.dir / "log.jsonl.tmp").exists())

    def test_replace_failure_preserves_original_and_cleans_tmp(self):
        atomic_io.write_jsonl_atomic(self.path, [{"v": 1}])
        original = self.path.read_text("utf-8")
        real_replace = os.replace

        def boom(src, dst):
            raise OSError("simulated replace failure")

        os.replace = boom
        try:
            with self.assertRaises(OSError):
                atomic_io.write_jsonl_atomic(self.path, [{"v": 2}])
        finally:
            os.replace = real_replace
        self.assertEqual(self.path.read_text("utf-8"), original)
        self.assertFalse((self.dir / "log.jsonl.tmp").exists())


class StoreSiteSmokeTests(unittest.TestCase):
    """The converted stores still persist valid JSON with no .tmp leftover."""

    def test_message_store_rewrite_is_atomic(self):
        from agentchattr.storage.store import MessageStore

        d = Path(tempfile.mkdtemp())
        s = MessageStore(str(d / "messages.jsonl"))
        s.add("user", "hello")
        s.add("user", "world")
        s._rewrite()  # the bulk-edit rewrite path (NEW-STATE-PERSIST-1)
        lines = (d / "messages.jsonl").read_text("utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        for ln in lines:
            json.loads(ln)
        self.assertFalse((d / "messages.jsonl.tmp").exists())

    def test_session_store_save_is_atomic(self):
        from agentchattr.session.session_store import SessionStore

        d = Path(tempfile.mkdtemp())
        store = SessionStore(str(d / "Sessions.json"))
        store._templates["t1"] = {
            "id": "t1", "name": "T", "roles": ["a"],
            "phases": [{"name": "P", "participants": ["a"], "is_output": True}],
        }
        store.create("t1", "general", {"a": "A"}, "user")
        self.assertTrue((d / "Sessions.json").exists())
        json.loads((d / "Sessions.json").read_text("utf-8"))
        self.assertFalse((d / "Sessions.json.tmp").exists())

    def test_job_store_save_is_atomic(self):
        from agentchattr.storage.jobs import JobStore

        d = Path(tempfile.mkdtemp())
        store = JobStore(str(d / "jobs.json"))
        store.create("title", "task", "general", "user")
        self.assertTrue((d / "jobs.json").exists())
        json.loads((d / "jobs.json").read_text("utf-8"))
        self.assertFalse((d / "jobs.json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
