"""Runtime agent state shared by the MCP tools and the web server.

Presence, activity, cursors, roles, and last-read pointers — plus their disk
persistence and rename/delete migration — used to live as module globals in
mcp_bridge.py, which app.py poked directly (mcp_bridge._presence, ...). They are
self-contained (no dependency on the tools, registry, or store), so they move
here as one cohesive module. Both mcp_bridge (the tools) and app.py (the
presence reaper) import this module and read state via mcp_state.X.
"""

import json
import os
import time
import logging
import threading
from pathlib import Path

log = logging.getLogger(__name__)


_presence: dict[str, float] = {}
_activity: dict[str, bool] = {}   # True = screen changed on last poll
_activity_ts: dict[str, float] = {}  # timestamp of last active=True heartbeat
ACTIVITY_TIMEOUT = 8  # auto-expire activity after 8s without a fresh active=True
_presence_lock = threading.Lock()   # guards both _presence and _activity
_renamed_from: set[str] = set()    # old names from renames — suppress leave messages
_cursors: dict[str, dict[str, int]] = {}  # agent_name → {channel_name → last_id}
_cursors_lock = threading.Lock()
_empty_read_count: dict[str, int] = {}  # sender → consecutive empty reads
# Last channel (or job_id) each agent explicitly read from. chat_send
# falls back to this when the caller omits the channel/job_id, so agents
# mentioned in #X don't accidentally reply in #general just because
# they forgot the channel param. Closes #58.
_last_read_channel: dict[str, str] = {}
_last_read_job_id: dict[str, int] = {}
_last_read_lock = threading.Lock()
PRESENCE_TIMEOUT = 10  # ~2 missed heartbeats (5s interval) = offline

# Roles — per-instance, persisted to roles.json
_roles: dict[str, str] = {}  # agent_name → role string
_ROLES_FILE: Path | None = None

# Cursor persistence — set by run.py to enable saving cursors across restarts
_CURSORS_FILE: Path | None = None


def _load_cursors():
    """Load cursor state from disk (called by run.py after store init)."""
    global _cursors
    if _CURSORS_FILE is None or not _CURSORS_FILE.exists():
        return
    try:
        data = json.loads(_CURSORS_FILE.read_text("utf-8"))
        with _cursors_lock:
            _cursors.update(data)
    except Exception:
        log.warning("Failed to load cursor state from %s", _CURSORS_FILE)


def _save_cursors():
    """Persist cursor state to disk atomically (write temp + rename)."""
    if _CURSORS_FILE is None:
        return
    try:
        with _cursors_lock:
            snapshot = dict(_cursors)
        _CURSORS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _CURSORS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot), "utf-8")
        os.replace(tmp, _CURSORS_FILE)  # atomic on POSIX
    except Exception:
        log.warning("Failed to save cursor state to %s", _CURSORS_FILE)


def _load_roles():
    """Load persisted roles from disk."""
    global _roles
    if _ROLES_FILE is None or not _ROLES_FILE.exists():
        return
    try:
        _roles = json.loads(_ROLES_FILE.read_text("utf-8"))
    except Exception:
        log.warning("Failed to load roles from %s", _ROLES_FILE)


def _save_roles():
    """Persist roles to disk atomically."""
    if _ROLES_FILE is None:
        return
    try:
        _ROLES_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _ROLES_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_roles), "utf-8")
        os.replace(tmp, _ROLES_FILE)
    except Exception:
        log.warning("Failed to save roles to %s", _ROLES_FILE)


def set_role(name: str, role: str):
    """Set or clear an agent's role. Empty string clears."""
    if role:
        _roles[name] = role
    else:
        _roles.pop(name, None)
    _save_roles()


def get_role(name: str) -> str:
    """Get an agent's current role, or empty string."""
    return _roles.get(name, "")


def get_all_roles() -> dict[str, str]:
    """All active roles."""
    return dict(_roles)


def migrate_identity(old_name: str, new_name: str):
    """Migrate all runtime state when an agent is renamed (presence, cursors, activity, roles)."""
    with _presence_lock:
        if old_name in _presence:
            _presence[new_name] = _presence.pop(old_name)
        if old_name in _activity:
            _activity[new_name] = _activity.pop(old_name)
        if old_name in _activity_ts:
            _activity_ts[new_name] = _activity_ts.pop(old_name)
        _renamed_from.add(old_name)  # suppress leave message for old name
    with _cursors_lock:
        if old_name in _cursors:
            _cursors[new_name] = _cursors.pop(old_name)
    if old_name in _roles:
        _roles[new_name] = _roles.pop(old_name)
        _save_roles()
    _save_cursors()


def purge_identity(name: str):
    """Remove all runtime state for a deregistered agent (presence, activity, cursors, roles)."""
    with _presence_lock:
        _presence.pop(name, None)
        _activity.pop(name, None)
        _activity_ts.pop(name, None)
    with _cursors_lock:
        _cursors.pop(name, None)
    if name in _roles:
        del _roles[name]
        _save_roles()
    _save_cursors()


def migrate_cursors_rename(old_name: str, new_name: str):
    """Move cursor entries from old channel name to new channel name."""
    with _cursors_lock:
        for agent_cursors in _cursors.values():
            if old_name in agent_cursors:
                agent_cursors[new_name] = agent_cursors.pop(old_name)
    _save_cursors()


def migrate_cursors_delete(channel: str):
    """Remove cursor entries for a deleted channel."""
    with _cursors_lock:
        for agent_cursors in _cursors.values():
            agent_cursors.pop(channel, None)
    _save_cursors()


def _update_cursor(sender: str, msgs: list[dict], channel: str | None):
    if sender and msgs:
        ch_key = channel if channel else "__all__"
        with _cursors_lock:
            agent_cursors = _cursors.setdefault(sender, {})
            agent_cursors[ch_key] = msgs[-1]["id"]
        _save_cursors()


def _touch_presence(name: str):
    """Update presence timestamp — called on any MCP tool use."""
    with _presence_lock:
        _presence[name] = time.time()


def _get_online() -> list[str]:
    now = time.time()
    with _presence_lock:
        return [name for name, ts in _presence.items()
                if now - ts < PRESENCE_TIMEOUT]


def is_online(name: str) -> bool:
    now = time.time()
    with _presence_lock:
        return name in _presence and now - _presence.get(name, 0) < PRESENCE_TIMEOUT


def set_active(name: str, active: bool):
    with _presence_lock:
        _activity[name] = active
        if active:
            _activity_ts[name] = __import__("time").time()


def is_active(name: str) -> bool:
    import time as _time
    with _presence_lock:
        if not _activity.get(name, False):
            return False
        # Auto-expire stale activity
        ts = _activity_ts.get(name, 0)
        if _time.time() - ts > ACTIVITY_TIMEOUT:
            _activity[name] = False
            return False
        return True
