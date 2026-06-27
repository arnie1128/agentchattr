"""Thread-safe agent identity (name + token).

Both the CLI wrapper (wrapper.py) and the API wrapper (wrapper_api.py) register
with the server, can be renamed by it (the heartbeat response carries the
authoritative name), and must re-register on a 409 when another instance has
taken their slot. The identity therefore changes at runtime and is read by
several threads (heartbeat, queue watcher, activity monitor), so it lives behind
a lock here instead of as a bare dict guarded ad hoc in each wrapper.

Each wrapper keeps its own side effects on a change (the CLI wrapper rewrites
the MCP config for the new identity; the API wrapper just
logs) and any extra per-wrapper state (the CLI's derived queue path, the API's
working flag) — this owns only the name/token pair and its lock.
"""

import threading


class Identity:
    def __init__(self, name: str, token: str):
        self._lock = threading.Lock()
        self._name = name
        self._token = token

    @property
    def name(self) -> str:
        with self._lock:
            return self._name

    @property
    def token(self) -> str:
        with self._lock:
            return self._token

    def get(self) -> tuple[str, str]:
        """An atomic (name, token) snapshot."""
        with self._lock:
            return self._name, self._token

    def update(self, name: str | None = None, token: str | None = None) -> bool:
        """Apply a new name and/or token; return whether anything changed.

        Empty/None values are ignored, so a heartbeat that only renames keeps
        the current token, and a session refresh that only rotates the token
        keeps the current name.
        """
        with self._lock:
            changed = False
            if name and name != self._name:
                self._name = name
                changed = True
            if token and token != self._token:
                self._token = token
                changed = True
            return changed


def handle_heartbeat_409(exc, client, agent, label, set_identity, *, on_recover=None) -> bool:
    """Recover from a heartbeat HTTP 409 (stale session) — shared by both wrappers.

    If `exc` is a 409, re-register a fresh identity, push it via
    set_identity(name, token), and run the per-wrapper on_recover(name) hook (a
    recovery-flag file in wrapper.py, a log line in wrapper_api.py). Returns
    whether `exc` was a 409. Best-effort: register/recover failures are swallowed
    so the heartbeat loop keeps running.
    """
    if getattr(exc, "code", None) != 409:
        return False
    try:
        replacement = client.register(agent, label)
        set_identity(replacement["name"], replacement["token"])
        if on_recover:
            on_recover(replacement["name"])
    except Exception:
        pass
    return True
