"""Scheduled-prompt runner, extracted from app.configure() (SRV-7).

`tick()` fires every currently-due scheduled prompt once by adding it to the
store (whose on_message callback routes @mentions to agents — no manual trigger
needed). `run()` is the daemon loop. tick() takes the state object explicitly so
it can be unit-tested without booting FastAPI.
"""

import logging
import time

log = logging.getLogger(__name__)

INTERVAL = 30   # seconds between schedule passes


def tick(state):
    """Fire all currently-due scheduled prompts once."""
    if not state.schedules:
        return
    due = state.schedules.run_due()
    for s in due:
        prompt = s.get("prompt", "")
        targets = s.get("targets", [])
        channel = s.get("channel", "general")
        if not prompt or not targets:
            state.schedules.mark_run(s["id"])
            continue
        sender = s.get("created_by", "user")
        mention_str = " ".join(f"@{t}" for t in targets)
        full_text = f"{mention_str} {prompt}" if mention_str else prompt
        # store.add triggers _handle_new_message via callback, which routes
        # @mentions to agents — no manual trigger needed.
        state.store.add(sender, full_text, channel=channel)
        if s.get("one_shot"):
            state.schedules.delete(s["id"])
        else:
            state.schedules.mark_run(s["id"])


def run(state, *, interval=INTERVAL):
    """Daemon loop: tick() every `interval` seconds, forever."""
    while True:
        time.sleep(interval)
        try:
            tick(state)
        except Exception:
            log.exception("schedule runner error")
