"""Tests for SessionStore public template API (NEW-SRV-4)."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from session_store import SessionStore  # noqa: E402


class TransientTemplateTests(unittest.TestCase):
    def test_register_transient_is_in_memory_and_not_persisted(self):
        d = Path(tempfile.mkdtemp())
        store = SessionStore(str(d / "Sessions.json"))
        tmpl = {"id": "draft-1", "name": "T", "roles": ["a"], "phases": []}
        store.register_transient_template(tmpl)
        self.assertIs(store.get_template("draft-1"), tmpl)
        self.assertFalse((d / "custom_templates.json").exists())  # transient, not saved


if __name__ == "__main__":
    unittest.main()
