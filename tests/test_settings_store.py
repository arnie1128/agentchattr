"""Tests for settings_store.SettingsStore and HatStore (SRV-6).

Covers the validated update(patch), the compound channel mutations, snapshot
isolation, atomic persistence, and the hat SVG validation/sanitization that
moved out of app.py's inline WebSocket handler.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentchattr.storage import settings_store  # noqa: E402


class SettingsUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "settings.json"
        self.store = settings_store.SettingsStore(self.path)

    def test_defaults_present(self):
        self.assertEqual(self.store.get("title"), "agentchattr")
        self.assertEqual(self.store.channels(), ["general"])

    def test_update_returns_changed_keys(self):
        changed = self.store.update({"title": "  Hi  ", "username": "alice"})
        self.assertEqual(changed, {"title": "Hi", "username": "alice"})
        self.assertEqual(self.store.get("title"), "Hi")
        self.assertEqual(self.store.get("username"), "alice")

    def test_update_blank_falls_back_to_default(self):
        self.store.update({"title": "   ", "username": ""})
        self.assertEqual(self.store.get("title"), "agentchattr")
        self.assertEqual(self.store.get("username"), "user")

    def test_update_rejects_invalid_enum(self):
        changed = self.store.update({"font": "comic", "theme": "rainbow"})
        self.assertEqual(changed, {})
        self.assertEqual(self.store.get("font"), "sans")
        self.assertEqual(self.store.get("theme"), "neutral")

    def test_max_agent_hops_clamped_and_reported(self):
        self.assertEqual(self.store.update({"max_agent_hops": 99999})["max_agent_hops"], 1000)
        self.assertEqual(self.store.update({"max_agent_hops": 0})["max_agent_hops"], 1)
        self.assertEqual(self.store.update({"max_agent_hops": "nope"}), {})

    def test_scale_must_match_choice(self):
        self.assertIn("ui_scale", self.store.update({"ui_scale": 1.25}))
        self.assertNotIn("ui_scale", self.store.update({"ui_scale": 9.0}))

    def test_history_limit_all_or_clamped_int(self):
        self.assertEqual(self.store.update({"history_limit": "ALL"})["history_limit"], "all")
        self.assertEqual(self.store.update({"history_limit": "50"})["history_limit"], 50)
        self.assertEqual(self.store.update({"history_limit": 999999})["history_limit"], 10000)

    def test_custom_roles_sanitized_and_capped(self):
        roles = ["  reviewer  ", "", 5, "x" * 40] + [f"r{i}" for i in range(25)]
        changed = self.store.update({"custom_roles": roles})
        out = changed["custom_roles"]
        self.assertEqual(out[0], "reviewer")
        self.assertTrue(all(len(r) <= 20 for r in out))
        self.assertLessEqual(len(out), 20)

    def test_persistence_roundtrip(self):
        self.store.update({"title": "Persisted"})
        reloaded = settings_store.SettingsStore(self.path)
        reloaded.load()
        self.assertEqual(reloaded.get("title"), "Persisted")

    def test_snapshot_is_isolated(self):
        snap = self.store.snapshot()
        snap["channels"].append("leak")
        snap["title"] = "mutated"
        self.assertEqual(self.store.channels(), ["general"])
        self.assertEqual(self.store.get("title"), "agentchattr")


class ChannelMutationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = settings_store.SettingsStore(Path(self.tmp.name) / "settings.json")

    def test_add_channel(self):
        self.assertIsNone(self.store.add_channel("Planning"))  # lowercased
        self.assertIn("planning", self.store.channels())

    def test_add_rejects_bad_name_and_duplicate(self):
        self.assertIsNotNone(self.store.add_channel("has space"))
        self.assertIsNotNone(self.store.add_channel(""))
        self.store.add_channel("dev")
        self.assertIsNotNone(self.store.add_channel("dev"))

    def test_add_respects_limit(self):
        for i in range(settings_store.MAX_CHANNELS):  # general + ... up to cap
            self.store.add_channel(f"c{i}")
        self.assertIsNotNone(self.store.add_channel("overflow"))
        self.assertLessEqual(len(self.store.channels()), settings_store.MAX_CHANNELS)

    def test_rename_channel(self):
        self.store.add_channel("dev")
        self.assertIsNone(self.store.rename_channel("dev", "engineering"))
        self.assertIn("engineering", self.store.channels())
        self.assertNotIn("dev", self.store.channels())

    def test_rename_protects_general_and_validates(self):
        self.assertIsNotNone(self.store.rename_channel("general", "lobby"))
        self.assertIsNotNone(self.store.rename_channel("missing", "x"))
        self.store.add_channel("dev")
        self.assertIsNotNone(self.store.rename_channel("dev", "general"))  # target exists

    def test_remove_channel(self):
        self.store.add_channel("dev")
        self.assertIsNone(self.store.remove_channel("dev"))
        self.assertNotIn("dev", self.store.channels())

    def test_remove_protects_general_and_unknown(self):
        self.assertIsNotNone(self.store.remove_channel("general"))
        self.assertIsNotNone(self.store.remove_channel("nope"))

    def test_replace_channels_persists(self):
        self.store.replace_channels(["general", "planning"])
        self.assertEqual(self.store.channels(), ["general", "planning"])


class LoadTests(unittest.TestCase):
    def test_load_merges_and_guarantees_general_first(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "settings.json"
        path.write_text(json.dumps({"title": "Saved", "channels": ["dev"]}), "utf-8")
        store = settings_store.SettingsStore(path)
        store.load()
        self.assertEqual(store.get("title"), "Saved")
        self.assertEqual(store.channels()[0], "general")
        self.assertIn("dev", store.channels())

    def test_load_handles_corrupt_file(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "settings.json"
        path.write_text("{ not json", "utf-8")
        store = settings_store.SettingsStore(path)
        store.load()  # must not raise
        self.assertEqual(store.channels(), ["general"])


class HatStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "hats.json"
        self.store = settings_store.HatStore(self.path)

    def test_set_valid_svg(self):
        self.assertIsNone(self.store.set("Claude", "<svg></svg>"))
        self.assertIn("claude", self.store.snapshot())  # key lowercased

    def test_set_rejects_non_svg(self):
        self.assertIsNotNone(self.store.set("a", "<div></div>"))

    def test_set_rejects_oversize(self):
        self.assertIsNotNone(self.store.set("a", "<svg>" + "x" * 6000 + "</svg>"))

    def test_set_sanitizes_script_and_handlers(self):
        self.store.set("a", '<svg onload="x()"><script>alert(1)</script></svg>')
        stored = self.store.snapshot()["a"]
        self.assertNotIn("<script", stored.lower())
        self.assertNotIn("onload=", stored.lower())

    def test_clear_reports_change(self):
        self.store.set("a", "<svg></svg>")
        self.assertTrue(self.store.clear("A"))   # case-insensitive
        self.assertFalse(self.store.clear("a"))  # already gone

    def test_persistence_roundtrip(self):
        self.store.set("a", "<svg></svg>")
        reloaded = settings_store.HatStore(self.path)
        reloaded.load()
        self.assertIn("a", reloaded.snapshot())

    def test_on_change_fires_on_set_and_clear(self):
        fires = []
        self.store.on_change(lambda: fires.append(1))
        self.store.set("a", "<svg></svg>")          # success -> fire
        self.assertEqual(len(fires), 1)
        self.store.set("a", "<div></div>")          # invalid -> no fire
        self.assertEqual(len(fires), 1)
        self.store.clear("a")                        # removed -> fire
        self.assertEqual(len(fires), 2)
        self.store.clear("a")                        # nothing to remove -> no fire
        self.assertEqual(len(fires), 2)


if __name__ == "__main__":
    unittest.main()
