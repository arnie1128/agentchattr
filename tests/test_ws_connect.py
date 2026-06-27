"""Smoke test for the /ws WebSocket connect path (NEW-SRV-1).

The token check in app.websocket_endpoint must read `state.session_token`, not a
(nonexistent) bare module global. The bare-global regression raised NameError on
every connect — before `websocket.accept()` — and broke all live UI updates. No
test covered the connect path, which is why it shipped; this is that test.

Configures once per class: app.configure() adds security middleware, which
Starlette freezes once the app has started (first TestClient request), so a
per-test reconfigure would raise. This module runs after the other configure()
callers (alphabetical discovery), so starting the app here leaks to none of them.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.server import app  # noqa: E402
from src.state import app_state  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402


class WsConnectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Snapshot every state slot so configure() can't leak into other modules.
        cls._saved = {n: getattr(app_state.state, n) for n in app_state.State.__slots__}
        cls._tmp = tempfile.TemporaryDirectory()
        cfg = {
            "server": {"data_dir": cls._tmp.name},
            "agents": {"claude": {"label": "Claude", "color": "#3366ff"}},
        }
        app.configure(cfg, session_token="tok-123")
        cls.client = TestClient(app.app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls._tmp.cleanup()
        for n, v in cls._saved.items():
            setattr(app_state.state, n, v)

    def test_valid_token_connects_and_receives_initial_state(self):
        # Before the fix this raised NameError on the token line (pre-accept).
        with self.client.websocket_connect("/ws?token=tok-123") as ws:
            first = json.loads(ws.receive_text())
            self.assertEqual(first["type"], "settings")

    def test_invalid_token_is_closed_with_4003(self):
        with self.assertRaises(WebSocketDisconnect) as ctx:
            with self.client.websocket_connect("/ws?token=wrong") as ws:
                ws.receive_text()
        self.assertEqual(ctx.exception.code, 4003)


if __name__ == "__main__":
    unittest.main()
