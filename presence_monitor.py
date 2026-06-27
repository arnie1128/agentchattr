"""Background presence reaper, extracted from app.configure() (SRV-7).

`tick()` runs one full pass: drain wrapper recovery-flag files, sweep presence,
crash-timeout dead wrappers, post/debounce leave messages, and broadcast status
on change. `run()` is the daemon loop. Both take explicit dependencies (state,
the broadcast coroutines, getters for the live event loop / last-active channel)
so a single tick can be unit-tested without booting FastAPI or an event loop.

Presence/activity reads and mutations all go through mcp_state's public ops
(STATE-1); this module owns only the orchestration that used to be an inline
closure in configure().
"""

import asyncio
import json
import logging
import time
from pathlib import Path

import mcp_state

log = logging.getLogger(__name__)

CRASH_TIMEOUT = 15   # seconds without a heartbeat before a wrapper is presumed dead
INTERVAL = 3         # seconds between reaper passes


def _schedule(coro_factory, event_loop):
    """Run a coroutine on the server's event loop from this worker thread."""
    if event_loop:
        asyncio.run_coroutine_threadsafe(coro_factory(), event_loop)


def drain_recovery_flags(state, data_dir):
    """Post a system note for each wrapper that dropped a `*_recovered` flag file."""
    try:
        for flag in Path(data_dir).glob("*_recovered"):
            agent_name = flag.read_text("utf-8").strip()
            flag.unlink()
            state.store.add(
                "system",
                f"Agent routing for {agent_name} interrupted — auto-recovered. "
                "If agents aren't responding, try sending your message again."
            )
    except Exception:
        pass


def tick(state, *, event_loop, broadcast_status, broadcast_raw, data_dir,
         last_active_channel, known_online, posted_leave, known_active,
         crash_timeout=CRASH_TIMEOUT):
    """Run one presence-reaper pass, mutating the persistent sets in place.

    known_online / posted_leave / known_active carry state across passes (online
    set for leave-edge detection, leave debounce, last-broadcast activity set).
    """
    drain_recovery_flags(state, data_dir)
    try:
        now = time.time()
        currently_online, currently_active = mcp_state.sweep()

        # Crash timeout: a wrapper with no heartbeat for crash_timeout is dead —
        # deregister it to free the slot (presence expiry alone only posts leaves).
        registered = set(state.registry.get_all_names())
        for name in registered:
            last_seen = mcp_state.last_seen(name)
            if last_seen > 0 and now - last_seen > crash_timeout:
                log.info("Crash timeout: deregistering %s (no heartbeat for %ss)", name, crash_timeout)
                result = state.registry.deregister(name)
                if result:
                    mcp_state.purge_identity(name)
                    state.registry.clean_renames_for(name)
                    renamed = result.get("_renamed_back")
                    if renamed:
                        mcp_state.migrate_identity(renamed["old"], renamed["new"])
                        state.store.rename_sender(renamed["old"], renamed["new"])
                        _schedule(lambda: broadcast_raw(json.dumps({
                            "type": "agent_renamed",
                            "old_name": renamed["old"],
                            "new_name": renamed["new"],
                        })), event_loop)
                    state.store.add(name, f"{name} disconnected (timeout)", msg_type="leave", channel=last_active_channel)
                    posted_leave.add(name)

        # Re-fetch registered names (crash timeout above may have changed them).
        registered = set(state.registry.get_all_names())

        # Registered instances that went offline → leave message (no deregister).
        timed_out = registered - currently_online
        for name in timed_out:
            inst = state.registry.get_instance(name)
            if not inst:
                continue
            if mcp_state.pop_renamed(name):   # just renamed, not actually offline
                continue
            if name not in posted_leave:
                posted_leave.add(name)
                state.store.add(name, f"{name} disconnected", msg_type="leave", channel=last_active_channel)

        # Clear leave debounce for agents that came back online.
        posted_leave -= currently_online

        # Non-registered agents going offline.
        went_offline = (known_online - currently_online) - timed_out
        for name in went_offline:
            if mcp_state.pop_renamed(name):
                continue
            if not state.registry.is_registered(name) and name not in posted_leave:
                posted_leave.add(name)
                state.store.add(name, f"{name} disconnected", msg_type="leave", channel=last_active_channel)

        if known_online != currently_online:
            _schedule(broadcast_status, event_loop)

        # Clear stale activity for agents that went offline.
        stale_active = mcp_state.clear_activity_offline(currently_online)
        if stale_active:
            currently_active -= set(stale_active)

        # Broadcast status on any change (online set or activity set).
        if currently_active != known_active or known_online != currently_online:
            known_active.clear()
            known_active.update(currently_active)
            _schedule(broadcast_status, event_loop)
        known_online.clear()
        known_online.update(currently_online)
    except Exception:
        pass


def run(state, *, get_event_loop, get_last_active_channel, broadcast_status,
        broadcast_raw, data_dir, interval=INTERVAL):
    """Daemon loop: tick() every `interval` seconds, forever."""
    known_online: set[str] = set()
    posted_leave: set[str] = set()
    known_active: set[str] = set()
    while True:
        time.sleep(interval)
        tick(
            state,
            event_loop=get_event_loop(),
            broadcast_status=broadcast_status,
            broadcast_raw=broadcast_raw,
            data_dir=data_dir,
            last_active_channel=get_last_active_channel(),
            known_online=known_online,
            posted_leave=posted_leave,
            known_active=known_active,
        )
