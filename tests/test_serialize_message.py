"""Golden-fixture tests for mcp_bridge.serialize_message (NEW-MCP-2).

Locks the exact field set AND key order of both chat_read variants so the
consolidation stays byte-identical to the two former inline serializers.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import mcp_bridge  # noqa: E402


class SerializeMessageTests(unittest.TestCase):
    def test_channel_full_shape_and_order(self):
        m = {"id": 1, "sender": "claude", "text": "hi", "type": "chat",
             "time": "10:00", "channel": "dev", "reply_to": 5}
        e = mcp_bridge.serialize_message(m)
        self.assertEqual(list(e.keys()), ["id", "sender", "text", "type", "time", "channel", "reply_to"])
        self.assertEqual(e["channel"], "dev")
        self.assertEqual(e["reply_to"], 5)
        self.assertNotIn("job_id", e)

    def test_channel_defaults_and_omits_reply(self):
        m = {"id": 1, "sender": "a", "text": "x", "type": "chat", "time": "t"}
        e = mcp_bridge.serialize_message(m)
        self.assertEqual(list(e.keys()), ["id", "sender", "text", "type", "time", "channel"])
        self.assertEqual(e["channel"], "general")  # default

    def test_job_full_shape_and_order(self):
        m = {"id": 2, "sender": "codex", "text": "y", "time": "t",
             "type": "decision", "resolved": True}
        e = mcp_bridge.serialize_message(m, job_id=7)
        self.assertEqual(list(e.keys()), ["id", "sender", "text", "time", "job_id", "type", "resolved"])
        self.assertEqual(e["job_id"], 7)
        self.assertNotIn("channel", e)

    def test_job_omits_type_when_falsy(self):
        m = {"id": 3, "sender": "a", "text": "z", "time": "t", "type": ""}
        e = mcp_bridge.serialize_message(m, job_id=1)
        self.assertEqual(list(e.keys()), ["id", "sender", "text", "time", "job_id"])
        self.assertNotIn("type", e)  # conditional in the job variant only


if __name__ == "__main__":
    unittest.main()
