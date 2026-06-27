"""Tests for the MCP config writers (mcp_inject.py).

Focused on the shape of the JSON written to provider settings files — Gemini
needs "httpUrl", CodeBuddy needs "url", legacy paths still work.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mcp_inject import _write_json_mcp_settings  # noqa: E402


class JsonMcpSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / "settings.json"

    def _read(self):
        return json.loads(self.target.read_text("utf-8"))

    def test_default_http_uses_httpUrl_key(self):
        # Backward compat: no http_key override → "httpUrl" (Gemini-style)
        _write_json_mcp_settings(self.target, "http://127.0.0.1:8200/mcp",
                                 transport="http")
        data = self._read()
        entry = data["mcpServers"]["agentchattr"]
        self.assertEqual(entry["type"], "http")
        self.assertEqual(entry["httpUrl"], "http://127.0.0.1:8200/mcp")
        self.assertNotIn("url", entry)

    def test_http_key_override_writes_url_key(self):
        # CodeBuddy-style: http_key="url" → MCP-standard "url" key
        _write_json_mcp_settings(self.target, "http://127.0.0.1:8200/mcp",
                                 transport="http", http_key="url")
        data = self._read()
        entry = data["mcpServers"]["agentchattr"]
        self.assertEqual(entry["type"], "http")
        self.assertEqual(entry["url"], "http://127.0.0.1:8200/mcp")
        self.assertNotIn("httpUrl", entry)

    def test_sse_transport_always_uses_url(self):
        # SSE doesn't use httpUrl regardless of http_key setting
        _write_json_mcp_settings(self.target, "http://127.0.0.1:8201/sse",
                                 transport="sse")
        data = self._read()
        entry = data["mcpServers"]["agentchattr"]
        self.assertEqual(entry["type"], "sse")
        self.assertEqual(entry["url"], "http://127.0.0.1:8201/sse")

    def test_bearer_token_written_as_authorization_header(self):
        _write_json_mcp_settings(self.target, "http://127.0.0.1:8200/mcp",
                                 transport="http", token="secret-token-123",
                                 http_key="url")
        entry = self._read()["mcpServers"]["agentchattr"]
        self.assertEqual(entry["headers"]["Authorization"], "Bearer secret-token-123")

    def test_existing_servers_preserved(self):
        # Write a pre-existing settings file with an unrelated server
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.target.write_text(json.dumps({
            "mcpServers": {"some-other-server": {"type": "http", "url": "http://elsewhere"}}
        }))
        _write_json_mcp_settings(self.target, "http://127.0.0.1:8200/mcp",
                                 transport="http", http_key="url")
        data = self._read()
        self.assertIn("some-other-server", data["mcpServers"])
        self.assertIn("agentchattr", data["mcpServers"])


class ExpanduserPathTests(unittest.TestCase):
    """Verify the _build_provider_launch path expansion logic.

    Unit-testing _build_provider_launch directly would require too much
    scaffolding (registry, token, etc.). Instead we verify Path behavior
    matches our expectations — the wrapper code uses Path(...).expanduser()
    at a single well-defined spot.
    """

    def test_tilde_prefix_expands_to_home(self):
        raw = "~/.codebuddy/.mcp.json"
        expanded = Path(raw).expanduser()
        self.assertTrue(expanded.is_absolute())
        # Must no longer contain a literal ~
        self.assertNotIn("~", str(expanded))
        # Sanity: should land under the user's home dir
        self.assertTrue(str(expanded).startswith(str(Path.home())))

    def test_absolute_path_unchanged_by_expanduser(self):
        raw = str(Path("/tmp/literal-abs").resolve())
        expanded = Path(raw).expanduser()
        self.assertEqual(str(expanded), raw)

    def test_relative_path_stays_relative_after_expanduser(self):
        # Relative paths without ~ aren't made absolute by expanduser alone —
        # that's handled by the subsequent `base / target` join in wrapper.py.
        raw = ".qwen/settings.json"
        expanded = Path(raw).expanduser()
        self.assertFalse(expanded.is_absolute())


class BearerFlagInjectTests(unittest.TestCase):
    """The proxy-free codex inject path (MCP-2): direct URL + bearer-from-env."""

    def test_bearer_flag_emits_url_and_token_env_flags_token_out_of_argv(self):
        from mcp_inject import _apply_mcp_inject, SERVER_NAME

        cfg = {"mcp_inject": "bearer_flag", "mcp_transport": "http"}
        args, env, _ = _apply_mcp_inject(
            cfg, "codex", Path(tempfile.mkdtemp()), None,
            token="tok-xyz", mcp_cfg={"http_port": 8200},
        )
        joined = " ".join(args)
        self.assertIn(f'mcp_servers.{SERVER_NAME}.url="http://127.0.0.1:8200/mcp"', joined)
        self.assertIn(f'mcp_servers.{SERVER_NAME}.bearer_token_env_var="AGENTCHATTR_TOKEN"', joined)
        self.assertEqual(env.get("AGENTCHATTR_TOKEN"), "tok-xyz")
        self.assertNotIn("tok-xyz", joined)  # token never in argv

    def test_bearer_flag_custom_env_var(self):
        from mcp_inject import _apply_mcp_inject

        cfg = {"mcp_inject": "bearer_flag", "mcp_bearer_env_var": "MY_TOK"}
        args, env, _ = _apply_mcp_inject(
            cfg, "codex", Path(tempfile.mkdtemp()), None,
            token="t", mcp_cfg={"http_port": 8200},
        )
        self.assertIn('bearer_token_env_var="MY_TOK"', " ".join(args))
        self.assertEqual(env.get("MY_TOK"), "t")


if __name__ == "__main__":
    unittest.main()
