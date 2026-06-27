"""Tests for identity.Identity — the shared name/token holder (WRAP-5)."""

import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import identity  # noqa: E402


class IdentityTests(unittest.TestCase):
    def test_initial_values(self):
        i = identity.Identity("claude", "tok1")
        self.assertEqual(i.name, "claude")
        self.assertEqual(i.token, "tok1")
        self.assertEqual(i.get(), ("claude", "tok1"))

    def test_update_name_only(self):
        i = identity.Identity("claude", "tok1")
        self.assertTrue(i.update(name="claude-2"))
        self.assertEqual(i.get(), ("claude-2", "tok1"))

    def test_update_token_only(self):
        i = identity.Identity("claude", "tok1")
        self.assertTrue(i.update(token="tok2"))
        self.assertEqual(i.get(), ("claude", "tok2"))

    def test_update_both(self):
        i = identity.Identity("claude", "tok1")
        self.assertTrue(i.update(name="claude-2", token="tok2"))
        self.assertEqual(i.get(), ("claude-2", "tok2"))

    def test_update_same_values_reports_no_change(self):
        i = identity.Identity("claude", "tok1")
        self.assertFalse(i.update(name="claude", token="tok1"))

    def test_update_empty_is_ignored(self):
        i = identity.Identity("claude", "tok1")
        self.assertFalse(i.update())
        self.assertFalse(i.update(name="", token=None))
        self.assertEqual(i.get(), ("claude", "tok1"))

    def test_concurrent_updates_keep_a_consistent_pair(self):
        # Every writer sets name and token as a matched pair; a reader must never
        # observe a name from one writer with a token from another.
        i = identity.Identity("a0", "t0")
        pairs = {f"a{n}": f"t{n}" for n in range(50)}

        def writer(n):
            i.update(name=f"a{n}", token=f"t{n}")

        threads = [threading.Thread(target=writer, args=(n,)) for n in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        name, token = i.get()
        self.assertEqual(pairs[name], token)


class _Exc:
    def __init__(self, code):
        self.code = code


class _Client:
    def __init__(self, fail=False):
        self.fail = fail
        self.registered = []

    def register(self, agent, label):
        self.registered.append((agent, label))
        if self.fail:
            raise RuntimeError("register failed")
        return {"name": f"{agent}-1", "token": "fresh"}


class HandleHeartbeat409Tests(unittest.TestCase):
    def test_409_re_registers_sets_identity_and_recovers(self):
        client = _Client()
        ident = {}
        recovered = []
        handled = identity.handle_heartbeat_409(
            _Exc(409), client, "claude", "Claude",
            lambda n, t: ident.update(name=n, token=t),
            on_recover=lambda n: recovered.append(n))
        self.assertTrue(handled)
        self.assertEqual(client.registered, [("claude", "Claude")])
        self.assertEqual(ident, {"name": "claude-1", "token": "fresh"})
        self.assertEqual(recovered, ["claude-1"])

    def test_non_409_is_ignored(self):
        client = _Client()
        handled = identity.handle_heartbeat_409(
            _Exc(500), client, "claude", "Claude", lambda n, t: None)
        self.assertFalse(handled)
        self.assertEqual(client.registered, [])  # no re-register on non-409

    def test_register_failure_is_swallowed(self):
        # Best-effort recovery: a register failure must not raise out of the loop.
        identity.handle_heartbeat_409(
            _Exc(409), _Client(fail=True), "claude", "Claude", lambda n, t: None)


if __name__ == "__main__":
    unittest.main()
