import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from router import Router


class RouterMentionTests(unittest.TestCase):
    def test_hyphenated_agent_name_is_parsed_as_full_mention(self):
        router = Router(["telegram-bridge"], default_mention="none")

        self.assertEqual(
            set(router.parse_mentions("please ask @telegram-bridge to check")),
            {"telegram-bridge"},
        )

    def test_shorter_agent_name_does_not_match_prefix_of_hyphenated_unknown(self):
        router = Router(["telegram"], default_mention="none")

        self.assertEqual(router.parse_mentions("@telegram-bridge check"), [])
        self.assertEqual(router.get_targets("ben", "@telegram-bridge check"), [])

    def test_longest_hyphenated_name_wins_when_prefix_agent_also_exists(self):
        router = Router(["telegram", "telegram-bridge"], default_mention="none")

        self.assertEqual(
            set(router.parse_mentions("@telegram-bridge check")),
            {"telegram-bridge"},
        )

    def test_unknown_exact_handle_still_does_not_route(self):
        router = Router(["telegram-bridge"], default_mention="none")

        self.assertEqual(router.parse_mentions("@telegram-bot check"), [])
        self.assertEqual(router.get_targets("ben", "@telegram-bot check"), [])


class RouterAllMentionTests(unittest.TestCase):
    def test_all_without_checker_tags_every_agent(self):
        router = Router(["claude", "codex"], default_mention="none")
        self.assertEqual(
            set(router.parse_mentions("@all please look")), {"claude", "codex"}
        )

    def test_all_filters_to_the_online_set(self):
        # @all expands only to agents the online_checker reports — the
        # mechanism BUG-2's fix relies on (app.py wires this to
        # active AND present, not merely claimed).
        online = {"claude"}
        router = Router(
            ["claude", "codex"], default_mention="none",
            online_checker=lambda: online,
        )
        self.assertEqual(router.parse_mentions("@all status?"), ["claude"])

    def test_all_empty_when_no_one_online(self):
        router = Router(
            ["claude", "codex"], default_mention="none",
            online_checker=lambda: set(),
        )
        self.assertEqual(router.parse_mentions("@all anyone?"), [])


if __name__ == "__main__":
    unittest.main()
