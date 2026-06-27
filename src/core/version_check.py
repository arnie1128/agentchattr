"""GitHub release version-check (SRV-8), lifted out of app.py.

Self-contained: reads the local VERSION file, queries the GitHub releases API
(30-min cached), and reports whether this checkout is behind. No chat state, so
it carries its own unit tests. app.py keeps only a thin route that calls check()
in an executor (the network call is blocking).
"""

import json
import time
import urllib.request
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]  # src/core/version_check.py -> repo root
_cache: dict = {"data": None, "fetched_at": 0.0}
_CACHE_TTL = 1800  # 30 minutes


def read_local_version() -> str:
    """Read version from the VERSION file in the project root."""
    try:
        return (_ROOT / "VERSION").read_text().strip()
    except Exception:
        return ""


def detect_install_kind() -> str:
    """Detect how this copy was installed: official_git, fork, or unknown."""
    import subprocess
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5, cwd=_ROOT,
        )
        url = result.stdout.strip().lower()
        if "bcurts/agentchattr" in url:
            return "official_git"
        elif url:
            return "fork"
    except Exception:
        pass
    return "unknown"


def fetch_latest_release() -> dict | None:
    """Fetch the latest release from the GitHub API, with a 30-min cache."""
    now = time.time()
    if _cache["data"] and (now - _cache["fetched_at"]) < _CACHE_TTL:
        return _cache["data"]
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/bcurts/agentchattr/releases/latest",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "agentchattr"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            result = {"tag": data.get("tag_name", ""), "url": data.get("html_url", "")}
            _cache["data"] = result
            _cache["fetched_at"] = now
            return result
    except Exception:
        return _cache.get("data")


def compare_versions(current: str, latest_tag: str) -> str:
    """Compare version strings. Returns 'behind', 'current', or 'unknown'."""
    latest = latest_tag.lstrip("v")  # strip leading 'v' from the tag
    if not current or not latest:
        return "unknown"
    try:
        from packaging.version import Version
        if Version(current) < Version(latest):
            return "behind"
        return "current"
    except Exception:
        return "unknown"


def check() -> dict:
    """Full version check. Returns {current, latest, state, url}.

    Blocking (network) — call via run_in_executor. `state` is one of
    update_available / upstream_update / current / unknown.
    """
    current = read_local_version()
    release = fetch_latest_release()
    if not release or not release.get("tag"):
        return {"current": current, "latest": "", "state": "unknown", "url": ""}

    latest_tag = release["tag"]
    install_kind = detect_install_kind()
    comparison = compare_versions(current, latest_tag)

    if comparison == "behind":
        if install_kind == "official_git":
            release_state = "update_available"
        elif install_kind == "fork":
            release_state = "upstream_update"
        else:
            release_state = "unknown"
    elif comparison == "current":
        release_state = "current"
    else:
        release_state = "unknown"

    return {
        "current": current,
        "latest": latest_tag,
        "state": release_state,
        "url": release.get("url", ""),
    }
