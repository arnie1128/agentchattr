"""Thread-safe stores for room settings and agent hats.

`room_settings` and `agent_hats` used to be lock-free module dicts: mutated on
the asyncio loop (WebSocket handlers) and read from background threads (the
presence monitor and the MCP bridge). Compound read-modify-write — a channel
add/rename, or the multi-field settings update — could interleave with a
concurrent read and tear, and a reader iterating the channels list while it was
being mutated could raise mid-iteration.

These two small stores own their dict, guard every access with a lock,
centralize the field validation that was inlined in the WebSocket handler, and
persist atomically (so a crash mid-write never corrupts the file). They know
nothing about WebSockets — broadcasting stays in app.py, where the event loop
lives.
"""

import json
import re
import threading
from pathlib import Path

from atomic_io import write_json_atomic

DEFAULT_ROOM_SETTINGS = {
    "title": "agentchattr",
    "username": "user",
    "font": "sans",
    "channels": ["general"],
    "history_limit": "all",
    "contrast": "normal",
    "theme": "neutral",
    "ui_scale": 1.25,
    "chat_scale": 1.5,
    "custom_roles": [],
}

# Allowed UI/chat scale + theme/font values (must match the dropdown options in
# static/index.html). The backend rejects anything outside these enums so the
# UI never persists an untested ratio.
_UI_SCALE_CHOICES = (1.0, 1.125, 1.25, 1.375)
_CHAT_SCALE_CHOICES = (1.0, 1.25, 1.5, 1.75, 2.0)
_THEME_CHOICES = ("neutral", "purple")
_FONT_CHOICES = ("mono", "serif", "sans")

# Channel name + count limits.
_CHANNEL_NAME_RE = re.compile(r'^[a-z0-9][a-z0-9\-]{0,19}$')
MAX_CHANNELS = 8


class SettingsStore:
    """Lock-guarded room settings, persisted to settings.json."""

    def __init__(self, path, defaults=None):
        self._path = Path(path)
        self._lock = threading.RLock()
        # Copy list values so the store never aliases the module-level default
        # (or a caller's dict) — a channel append must not mutate the source.
        src = DEFAULT_ROOM_SETTINGS if defaults is None else defaults
        self._data = {
            k: list(v) if isinstance(v, list) else v for k, v in src.items()
        }

    def load(self):
        """Merge persisted settings over the defaults; guarantee 'general'."""
        with self._lock:
            if self._path.exists():
                try:
                    saved = json.loads(self._path.read_text("utf-8"))
                    self._data.update(saved)
                except Exception:
                    pass
            channels = self._data.get("channels")
            if not channels:
                self._data["channels"] = ["general"]
            elif "general" not in channels:
                channels.insert(0, "general")

    def _save(self):
        # Caller holds the lock.
        write_json_atomic(self._path, self._data)

    def get(self, key, default=None):
        """Read a single (scalar) setting under the lock."""
        with self._lock:
            return self._data.get(key, default)

    def channels(self):
        """A copy of the channel list — safe to iterate without the lock."""
        with self._lock:
            return list(self._data.get("channels", ["general"]))

    def snapshot(self):
        """A copy of the whole settings dict for broadcast / REST.

        Lists are copied one level deep so a consumer can't mutate the live
        dict and a reader never observes a torn write.
        """
        with self._lock:
            return {
                k: list(v) if isinstance(v, list) else v
                for k, v in self._data.items()
            }

    def update(self, patch):
        """Validate and apply a settings patch; persist atomically.

        Returns a dict of the keys that actually changed, so the caller can
        sync downstream state (e.g. router.max_hops for max_agent_hops).
        """
        changed = {}
        with self._lock:
            d = self._data
            if "title" in patch and isinstance(patch["title"], str):
                d["title"] = patch["title"].strip() or "agentchattr"
                changed["title"] = d["title"]
            if "username" in patch and isinstance(patch["username"], str):
                d["username"] = patch["username"].strip() or "user"
                changed["username"] = d["username"]
            if "font" in patch and patch["font"] in _FONT_CHOICES:
                d["font"] = patch["font"]
                changed["font"] = d["font"]
            if "max_agent_hops" in patch:
                try:
                    hops = max(1, min(int(patch["max_agent_hops"]), 1000))
                    d["max_agent_hops"] = hops
                    changed["max_agent_hops"] = hops
                except (ValueError, TypeError):
                    pass
            if "contrast" in patch and patch["contrast"] in ("normal", "high"):
                d["contrast"] = patch["contrast"]
                changed["contrast"] = d["contrast"]
            if "theme" in patch and patch["theme"] in _THEME_CHOICES:
                d["theme"] = patch["theme"]
                changed["theme"] = d["theme"]
            if "ui_scale" in patch:
                try:
                    v = float(patch["ui_scale"])
                    if any(abs(v - c) < 1e-6 for c in _UI_SCALE_CHOICES):
                        d["ui_scale"] = v
                        changed["ui_scale"] = v
                except (ValueError, TypeError):
                    pass
            if "chat_scale" in patch:
                try:
                    v = float(patch["chat_scale"])
                    if any(abs(v - c) < 1e-6 for c in _CHAT_SCALE_CHOICES):
                        d["chat_scale"] = v
                        changed["chat_scale"] = v
                except (ValueError, TypeError):
                    pass
            if "rules_refresh_interval" in patch:
                try:
                    ri = int(patch["rules_refresh_interval"])
                    d["rules_refresh_interval"] = max(0, min(ri, 100))
                    changed["rules_refresh_interval"] = d["rules_refresh_interval"]
                except (ValueError, TypeError):
                    pass
            if "history_limit" in patch:
                val = str(patch["history_limit"]).strip().lower()
                if val == "all":
                    d["history_limit"] = "all"
                    changed["history_limit"] = "all"
                else:
                    try:
                        d["history_limit"] = max(1, min(int(val), 10000))
                        changed["history_limit"] = d["history_limit"]
                    except (ValueError, TypeError):
                        pass
            if "custom_roles" in patch and isinstance(patch["custom_roles"], list):
                d["custom_roles"] = [
                    str(r).strip()[:20] for r in patch["custom_roles"]
                    if isinstance(r, str) and r.strip()
                ][:20]
                changed["custom_roles"] = d["custom_roles"]
            self._save()
        return changed

    # --- Channel mutations (compound; validate + mutate + persist atomically).
    # Each returns None on success or an error string the caller may ignore
    # (the WebSocket handler treats any error as a silent no-op, matching the
    # previous inline behavior).

    def add_channel(self, name):
        name = (name or "").strip().lower()
        with self._lock:
            if not name or not _CHANNEL_NAME_RE.match(name):
                return "invalid channel name"
            channels = self._data.setdefault("channels", ["general"])
            if name in channels:
                return "channel already exists"
            if len(channels) >= MAX_CHANNELS:
                return "channel limit reached"
            channels.append(name)
            self._save()
        return None

    def rename_channel(self, old_name, new_name):
        old_name = (old_name or "").strip().lower()
        new_name = (new_name or "").strip().lower()
        with self._lock:
            if old_name == "general":
                return "cannot rename the general channel"
            if not new_name or not _CHANNEL_NAME_RE.match(new_name):
                return "invalid channel name"
            channels = self._data.get("channels", [])
            if old_name not in channels:
                return "unknown channel"
            if new_name in channels:
                return "channel already exists"
            channels[channels.index(old_name)] = new_name
            self._save()
        return None

    def remove_channel(self, name):
        name = (name or "").strip().lower()
        with self._lock:
            if name == "general":
                return "cannot delete the general channel"
            channels = self._data.get("channels", [])
            if name not in channels:
                return "unknown channel"
            channels.remove(name)
            self._save()
        return None

    def replace_channels(self, channels):
        """Overwrite the channel list (used after an archive import adds some)."""
        with self._lock:
            self._data["channels"] = list(channels)
            self._save()


def _sanitize_svg(svg: str) -> str:
    """Strip dangerous content (scripts, event handlers, javascript:) from SVG."""
    svg = re.sub(r'<script[^>]*>.*?</script>', '', svg, flags=re.DOTALL | re.IGNORECASE)
    svg = re.sub(r'\bon\w+\s*=', '', svg, flags=re.IGNORECASE)
    svg = re.sub(r'javascript\s*:', '', svg, flags=re.IGNORECASE)
    return svg


class HatStore:
    """Lock-guarded per-agent hat SVGs, persisted to hats.json."""

    def __init__(self, path):
        self._path = Path(path)
        self._lock = threading.RLock()
        self._data: dict[str, str] = {}

    def load(self):
        with self._lock:
            if self._path.exists():
                try:
                    self._data = json.loads(self._path.read_text("utf-8"))
                except Exception:
                    self._data = {}

    def _save(self):
        # Caller holds the lock.
        write_json_atomic(self._path, self._data, indent=None)

    def set(self, agent: str, svg: str) -> str | None:
        """Validate, sanitize, and store a hat SVG. Returns error string or None."""
        svg = svg.strip()
        if not svg.lower().startswith("<svg"):
            return "Hat must be an SVG element (starts with <svg)."
        if len(svg) > 5120:
            return "Hat SVG too large (max 5KB)."
        svg = _sanitize_svg(svg)
        with self._lock:
            self._data[agent.lower()] = svg
            self._save()
        return None

    def clear(self, agent: str) -> bool:
        """Remove an agent's hat. Returns whether anything was removed."""
        key = agent.lower()
        with self._lock:
            if key in self._data:
                del self._data[key]
                self._save()
                return True
        return False

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self._data)
