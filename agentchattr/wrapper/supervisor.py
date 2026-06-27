"""Shared agent restart loop for the platform wrappers.

wrapper_windows.py and wrapper_unix.py both supervise the agent CLI with the
same skeleton: run it, and on a clean exit either stop (--no-restart) or wait a
few seconds and relaunch, until the user hits Ctrl+C. Only *how* the agent is
launched, waited on, and torn down is platform-specific (a direct subprocess +
Win32 console vs a detachable tmux session). That platform code stays in the
platform files; this owns the shared skeleton.
"""

import time

RESTART_DELAY = 3


def run_loop(run_once, no_restart, *, on_interrupt=None):
    """Supervise the agent until --no-restart or Ctrl+C.

    run_once() launches the agent and blocks until it exits or the user detaches
    it. It returns (should_restart, exit_note):
      * should_restart=True  -> the agent exited and may be relaunched
      * should_restart=False -> stop supervising without a restart (e.g. the
        user detached a tmux session still running in the background, or the
        launch failed)
    exit_note, when truthy, is printed before the "restarting" line so each
    platform can include its own detail (e.g. the Windows exit code).

    on_interrupt(), if given, runs on Ctrl+C before the loop breaks (e.g. to
    kill the tmux session).
    """
    while True:
        try:
            should_restart, exit_note = run_once()
            if not should_restart or no_restart:
                break
            if exit_note:
                print(exit_note)
            print(f"  Restarting in {RESTART_DELAY}s... (Ctrl+C to quit)")
            time.sleep(RESTART_DELAY)
        except KeyboardInterrupt:
            if on_interrupt is not None:
                on_interrupt()
            break
