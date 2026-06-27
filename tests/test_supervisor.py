"""Tests for supervisor.run_loop — the shared agent restart loop (WRAP-4)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.wrapper import supervisor  # noqa: E402


class RunLoopTests(unittest.TestCase):
    def setUp(self):
        # Avoid real sleeps between simulated restarts.
        self._saved = supervisor.RESTART_DELAY
        supervisor.RESTART_DELAY = 0

    def tearDown(self):
        supervisor.RESTART_DELAY = self._saved

    def test_no_restart_runs_once(self):
        calls = []
        supervisor.run_loop(lambda: (calls.append(1), (True, ""))[1], no_restart=True)
        self.assertEqual(len(calls), 1)

    def test_restarts_until_should_restart_false(self):
        calls = []

        def run_once():
            calls.append(1)
            return (len(calls) < 3), ""  # exit-and-restart twice, then stop

        supervisor.run_loop(run_once, no_restart=False)
        self.assertEqual(len(calls), 3)

    def test_stop_when_run_once_returns_false(self):
        calls = []
        supervisor.run_loop(lambda: (calls.append(1), (False, ""))[1], no_restart=False)
        self.assertEqual(len(calls), 1)

    def test_keyboardinterrupt_runs_on_interrupt_then_stops(self):
        flag = []

        def run_once():
            raise KeyboardInterrupt

        supervisor.run_loop(run_once, no_restart=False, on_interrupt=lambda: flag.append(1))
        self.assertEqual(flag, [1])

    def test_keyboardinterrupt_without_handler_is_safe(self):
        def run_once():
            raise KeyboardInterrupt

        supervisor.run_loop(run_once, no_restart=False)  # must not raise


if __name__ == "__main__":
    unittest.main()
