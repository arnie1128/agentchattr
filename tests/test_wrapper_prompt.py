"""Tests for the pure wrapper helpers extracted in WRAP-2:
build_trigger_prompt (wrapper.py) and build_tmux_session_name (wrapper_unix.py)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import wrapper  # noqa: E402
import wrapper_unix  # noqa: E402


class BuildTriggerPromptTests(unittest.TestCase):
    def test_channel_is_the_default_base(self):
        self.assertIn("read #dev", wrapper.build_trigger_prompt(channel="dev"))

    def test_job_id_overrides_channel(self):
        p = wrapper.build_trigger_prompt(channel="dev", job_id=7)
        self.assertIn("job_id=7", p)
        self.assertNotIn("#dev", p)

    def test_custom_prompt_wins(self):
        p = wrapper.build_trigger_prompt(channel="dev", job_id=7, custom_prompt="do X")
        self.assertTrue(p.startswith("do X"))

    def test_role_rules_hint_appended_in_order(self):
        p = wrapper.build_trigger_prompt(
            channel="dev", role="reviewer", rules_text="be terse", identity_hint=" HINT")
        self.assertIn("ROLE: reviewer", p)
        self.assertIn("RULES:\nbe terse", p)
        self.assertTrue(p.endswith(" HINT"))

    def test_empty_optionals_are_omitted(self):
        p = wrapper.build_trigger_prompt(channel="dev")
        self.assertNotIn("ROLE:", p)
        self.assertNotIn("RULES:", p)


class TmuxSessionNameTests(unittest.TestCase):
    def _name(self, agent="claude", proj="/tmp/proj"):
        return wrapper_unix.build_tmux_session_name(
            agent, project_dir=Path(proj), data_dir=Path("/tmp/data"),
            server_port=8300, mcp_cfg={"http_port": 8200, "sse_port": 8201})

    def test_deterministic_and_prefixed(self):
        self.assertEqual(self._name(), self._name())  # same inputs -> same name
        self.assertTrue(self._name().startswith("agentchattr-claude-proj-"))

    def test_distinct_projects_get_distinct_names(self):
        self.assertNotEqual(self._name(proj="/tmp/a"), self._name(proj="/tmp/b"))

    def test_unsafe_chars_sanitized(self):
        n = wrapper_unix.build_tmux_session_name(
            "Claude/Bot!", project_dir=Path("/tmp/My Proj"), data_dir=Path("/tmp/d"),
            server_port=1, mcp_cfg={})
        self.assertRegex(n, r"^agentchattr-[a-z0-9-]+$")


if __name__ == "__main__":
    unittest.main()
