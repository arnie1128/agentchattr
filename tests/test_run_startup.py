"""Smoke test for the boot-resume startup hook (NEW-SRV-2).

run.py's FastAPI startup hook resumed active sessions via a bare `session_engine`
name that was never defined/imported -> NameError in the startup event, breaking
session-resume-on-boot. The resume step now lives in a module-level helper that
reads the shared `state` singleton; this test invokes it directly (the suite
never boots the ASGI app, which is why the regression was uncovered).

Imports run.py at module scope only — main() is not called, and run.py's heavy
imports (fastapi/uvicorn) live inside main(), so this needs neither.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.state import app_state  # noqa: E402
import run  # noqa: E402


class BootResumeTests(unittest.TestCase):
    def setUp(self):
        self._saved = app_state.state.session_engine

        def restore():
            app_state.state.session_engine = self._saved

        self.addCleanup(restore)

    def test_resume_calls_session_engine_when_wired(self):
        engine = MagicMock()
        app_state.state.session_engine = engine
        run.resume_sessions_on_boot()  # before the fix: NameError on session_engine
        engine.resume_active_sessions.assert_called_once_with()

    def test_resume_is_a_noop_before_configure(self):
        app_state.state.session_engine = None
        run.resume_sessions_on_boot()  # must not raise


if __name__ == "__main__":
    unittest.main()
