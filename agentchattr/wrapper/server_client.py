"""HTTP client for the chat server's wrapper-facing API.

A single definition of the server's HTTP contract — URLs, auth headers, body
shapes, timeouts — shared by wrapper.py and wrapper_api.py, replacing the
~28 inline ``urllib.request`` call sites and the duplicated ``_auth_headers``.

The error contract mirrors the original inline calls so the swap is
behavior-preserving:

* Methods whose callers wrap them in their own ``try/except`` raise on
  failure — ``register``, ``heartbeat``, ``heartbeat_active``,
  ``deregister``, ``get_status``, ``read_messages``, ``send_message``.
  (``heartbeat`` in particular must let an HTTP 409 propagate so the caller
  can re-register.)
* Best-effort methods swallow failures and return a default — ``fetch_role``
  -> ``""``, ``fetch_active_rules`` -> ``None``, ``report_rule_sync`` -> None.
"""

import json
import urllib.request


def _auth_headers(token: str, *, include_json: bool = False) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    if include_json:
        headers["Content-Type"] = "application/json"
    return headers


class ServerClient:
    """Talks to the chat server over its local HTTP API.

    Holds only the base URL; the per-instance auth token is passed per call
    because the wrapper's identity (and token) can change at runtime after a
    409 re-registration.
    """

    def __init__(self, server_port: int, host: str = "127.0.0.1"):
        self.base_url = f"http://{host}:{server_port}"

    # --- registration / presence ---

    def register(self, base: str, label: str | None = None) -> dict:
        body = json.dumps({"base": base, "label": label}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/api/register",
            method="POST",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())

    def heartbeat(self, name: str, token: str) -> dict:
        """Liveness heartbeat with no activity payload. Raises on failure so
        the caller can handle an HTTP 409 identity collision."""
        req = urllib.request.Request(
            f"{self.base_url}/api/heartbeat/{name}",
            method="POST",
            data=b"",
            headers=_auth_headers(token),
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())

    def heartbeat_active(self, name: str, token: str, active: bool) -> dict:
        """Heartbeat carrying the active/idle flag. Raises on failure."""
        body = json.dumps({"active": active}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/api/heartbeat/{name}",
            method="POST",
            data=body,
            headers=_auth_headers(token, include_json=True),
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())

    def deregister(self, name: str, token: str) -> None:
        req = urllib.request.Request(
            f"{self.base_url}/api/deregister/{name}",
            method="POST",
            data=b"",
            headers=_auth_headers(token),
        )
        urllib.request.urlopen(req, timeout=5)

    # --- status / roles / rules ---

    def get_status(self, token: str) -> dict:
        req = urllib.request.Request(
            f"{self.base_url}/api/status",
            headers=_auth_headers(token),
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())

    def fetch_role(self, name: str) -> str:
        """Best-effort: returns "" on any failure."""
        try:
            req = urllib.request.Request(f"{self.base_url}/api/roles")
            with urllib.request.urlopen(req, timeout=3) as resp:
                roles = json.loads(resp.read())
            return roles.get(name, "")
        except Exception:
            return ""

    def fetch_active_rules(self, token: str = "") -> dict | None:
        """Best-effort: returns None on any failure."""
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            req = urllib.request.Request(
                f"{self.base_url}/api/rules/active", headers=headers
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                return json.loads(resp.read())
        except Exception:
            return None

    def report_rule_sync(self, name: str, epoch: int, token: str = "") -> None:
        """Best-effort: swallows any failure."""
        try:
            body = json.dumps({"epoch": epoch}).encode()
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            req = urllib.request.Request(
                f"{self.base_url}/api/rules/agent_sync/{name}",
                method="POST",
                data=body,
                headers=headers,
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass

    # --- messages (used by wrapper_api) ---

    def read_messages(self, token: str, channel: str = "general",
                      since_id: int = 0, limit: int = 20) -> dict:
        params = f"limit={limit}&channel={channel}"
        if since_id:
            params = f"since_id={since_id}&{params}"
        req = urllib.request.Request(
            f"{self.base_url}/api/messages?{params}",
            headers=_auth_headers(token),
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())

    def send_message(self, token: str, text: str,
                     channel: str = "general") -> dict:
        body = json.dumps({"text": text, "channel": channel}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/api/send",
            method="POST",
            data=body,
            headers=_auth_headers(token, include_json=True),
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
