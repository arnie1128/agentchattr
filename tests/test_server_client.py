import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server_client
from server_client import ServerClient


class FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode()

    def getcode(self):
        return 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ServerClientContractTests(unittest.TestCase):
    def setUp(self):
        self.captured = []
        self._real_urlopen = server_client.urllib.request.urlopen
        self._next_payload = {}

        def fake_urlopen(req, timeout=None):
            self.captured.append({"req": req, "timeout": timeout})
            return FakeResp(self._next_payload)

        server_client.urllib.request.urlopen = fake_urlopen
        self.client = ServerClient(8300)

    def tearDown(self):
        server_client.urllib.request.urlopen = self._real_urlopen

    def _last(self):
        return self.captured[-1]["req"]

    def test_register_posts_base_and_label(self):
        self._next_payload = {"name": "claude", "token": "t", "slot": 1}
        out = self.client.register("claude", "Claude")
        req = self._last()
        self.assertEqual(req.full_url, "http://127.0.0.1:8300/api/register")
        self.assertEqual(req.method, "POST")
        self.assertEqual(json.loads(req.data), {"base": "claude", "label": "Claude"})
        self.assertEqual(out["name"], "claude")

    def test_heartbeat_empty_body_with_auth(self):
        self._next_payload = {"name": "claude"}
        self.client.heartbeat("claude", "tok")
        req = self._last()
        self.assertEqual(req.full_url, "http://127.0.0.1:8300/api/heartbeat/claude")
        self.assertEqual(req.data, b"")
        self.assertEqual(req.headers["Authorization"], "Bearer tok")

    def test_heartbeat_active_sends_flag_and_json_header(self):
        self._next_payload = {"name": "claude"}
        self.client.heartbeat_active("claude", "tok", True)
        req = self._last()
        self.assertEqual(json.loads(req.data), {"active": True})
        self.assertEqual(req.headers["Content-type"], "application/json")

    def test_read_messages_builds_query(self):
        self._next_payload = {"messages": []}
        self.client.read_messages("tok", channel="dev", since_id=7, limit=5)
        req = self._last()
        self.assertIn("/api/messages?since_id=7&limit=5&channel=dev", req.full_url)
        self.assertEqual(req.headers["Authorization"], "Bearer tok")

    def test_send_message_posts_text_and_channel(self):
        self._next_payload = {"ok": True}
        self.client.send_message("tok", "hello", channel="dev")
        req = self._last()
        self.assertEqual(req.full_url, "http://127.0.0.1:8300/api/send")
        self.assertEqual(json.loads(req.data), {"text": "hello", "channel": "dev"})

    def test_fetch_active_rules_omits_auth_when_no_token(self):
        self._next_payload = {"epoch": 1}
        self.client.fetch_active_rules("")
        req = self._last()
        self.assertNotIn("Authorization", req.headers)

    def test_fetch_role_returns_empty_on_error(self):
        def boom(req, timeout=None):
            raise OSError("server down")

        server_client.urllib.request.urlopen = boom
        self.assertEqual(self.client.fetch_role("claude"), "")

    def test_report_rule_sync_swallows_error(self):
        def boom(req, timeout=None):
            raise OSError("server down")

        server_client.urllib.request.urlopen = boom
        self.client.report_rule_sync("claude", 3, "tok")  # must not raise


if __name__ == "__main__":
    unittest.main()
