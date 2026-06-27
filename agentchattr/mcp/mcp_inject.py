"""MCP config injection for agent CLIs.

Self-contained, platform-agnostic helpers that resolve how each agent CLI
should be told to reach the agentchattr MCP server and write/return the
provider-specific config (settings file, CLI flag, env var, or bearer-from-env).
Lifted out of wrapper.py so the wrapper module is left with process
supervision and identity, not provider-config plumbing.
"""

import json
import os
from pathlib import Path

SERVER_NAME = "agentchattr"


# ---------------------------------------------------------------------------
# Per-instance provider config
# ---------------------------------------------------------------------------

def _write_json_mcp_settings(config_file: Path, url: str, transport: str = "http",
                              *, token: str = "", http_key: str = "httpUrl") -> Path:
    """Write/merge a settings-style JSON file with nested mcpServers config.

    Preserves existing servers in the file — only updates the agentchattr entry.

    Gemini CLI 0.32+ expects:
      - "httpUrl" key (not "url") for streamable-http transport
      - "url" key for SSE transport
      - "trust": true to skip per-call approval prompts

    `http_key` controls which JSON key names the HTTP transport URL. Defaults
    to "httpUrl" (Gemini/Qwen). Providers like CodeBuddy that follow the
    standard MCP shape should set `mcp_http_key = "url"` in their config.
    Only affects settings_file / env injector modes (not the Claude flag
    writer or Kilo env_content writer).
    """
    config_file.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if config_file.exists():
        try:
            existing = json.loads(config_file.read_text("utf-8"))
        except Exception:
            pass
    servers = existing.get("mcpServers", {})
    # Default: Gemini-style "httpUrl" for HTTP. Override with http_key="url"
    # for providers that follow the standard MCP shape (e.g. CodeBuddy).
    if transport in ("http", "streamable-http"):
        entry: dict = {"type": "http", http_key: url, "trust": True}
    else:
        entry = {"type": transport, "url": url, "trust": True}
    if token:
        entry["headers"] = {"Authorization": f"Bearer {token}"}
    servers[SERVER_NAME] = entry
    existing["mcpServers"] = servers

    # Enable folder trust so ~/.gemini/trustedFolders.json is respected
    security = existing.get("security", {})
    folder_trust = security.get("folderTrust", {})
    folder_trust["enabled"] = True
    security["folderTrust"] = folder_trust
    existing["security"] = security

    config_file.write_text(json.dumps(existing, indent=2) + "\n", "utf-8")
    return config_file


def _read_project_mcp_servers(project_dir: Path) -> dict:
    """Read existing MCP servers from the project's .mcp.json."""
    mcp_file = project_dir / ".mcp.json"
    if mcp_file.exists():
        try:
            data = json.loads(mcp_file.read_text("utf-8"))
            servers = data.get("mcpServers", {})
            # Remove agentchattr — we'll add our own authenticated version
            servers.pop(SERVER_NAME, None)
            return servers
        except Exception:
            pass
    return {}


def _write_claude_mcp_config(
    config_file: Path,
    url: str,
    *,
    token: str = "",
    project_servers: dict | None = None,
) -> Path:
    """Write a Claude Code --mcp-config file with bearer auth.

    Includes all project MCP servers (unity-mcp etc.) so --strict-mcp-config
    can be used without losing other servers."""
    config_file.parent.mkdir(parents=True, exist_ok=True)

    # Start with other project servers (e.g. unity-mcp)
    servers = dict(project_servers or {})

    # Add agentchattr with bearer token for direct server auth
    entry: dict = {"type": "http", "url": url}
    if token:
        entry["headers"] = {"Authorization": f"Bearer {token}"}
    servers[SERVER_NAME] = entry

    payload = {"mcpServers": servers}
    config_file.write_text(json.dumps(payload, indent=2) + "\n", "utf-8")
    return config_file


# ---------------------------------------------------------------------------
# Built-in provider defaults (applied when agent config has no mcp_inject)
# ---------------------------------------------------------------------------

_BUILTIN_DEFAULTS: dict[str, dict] = {
    "claude": {
        "mcp_inject": "flag",
        "mcp_flag": "--mcp-config",
        "mcp_transport": "http",
        "mcp_merge_project": True,  # include unity-mcp etc.
    },
    "gemini": {
        "mcp_inject": "env",
        "mcp_env_var": "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
        "mcp_transport": "http",  # streamable-http; SSE has blocking issues in Gemini 0.32.x
        "mcp_merge_project": True,
    },
    "codex": {
        "mcp_inject": "bearer_flag",  # MCP-2: direct bearer connect, proxy-free (live-confirmed)
        # mcp_merge_project disabled — Codex reads .mcp.json natively,
        # and duplicate detection is name-based only (e.g. unityMCP vs unity-mcp)
    },
    "kimi": {
        "mcp_inject": "flag",
        "mcp_flag": "--mcp-config-file",
        "mcp_transport": "http",
        "mcp_merge_project": True,
    },
    "kilo": {
        "mcp_inject": "env_content",
        "mcp_env_var": "KILO_CONFIG_CONTENT",
        "mcp_transport": "http",
    },
}

_VALID_INJECT_MODES = {"settings_file", "env", "flag", "env_content", "bearer_flag"}


def _resolve_mcp_inject(agent: str, agent_cfg: dict) -> dict:
    """Resolve MCP injection config: explicit agent_cfg > built-in defaults > None."""
    inject_mode = agent_cfg.get("mcp_inject")
    if inject_mode:
        return dict(agent_cfg)
    if agent in _BUILTIN_DEFAULTS:
        merged = dict(_BUILTIN_DEFAULTS[agent])
        merged.update({k: v for k, v in agent_cfg.items() if k.startswith("mcp_")})
        return merged
    return {}


def _get_server_url(mcp_cfg: dict, transport: str) -> str:
    """Build the MCP server URL for the given transport."""
    if transport == "sse":
        port = mcp_cfg.get("sse_port", 8201)
        return f"http://127.0.0.1:{port}/sse"
    port = mcp_cfg.get("http_port", 8200)
    return f"http://127.0.0.1:{port}/mcp"


def _apply_mcp_inject(
    inject_cfg: dict,
    instance_name: str,
    data_dir: Path,
    *,
    token: str = "",
    mcp_cfg: dict | None = None,
    project_dir: Path | None = None,
) -> tuple[list[str], dict[str, str], Path | None]:
    """Apply MCP config injection based on the resolved inject config.

    Returns (extra_launch_args, inject_env, settings_path_or_None).
    settings_path is stored so re-registration can rewrite it.
    """
    mode = inject_cfg.get("mcp_inject")
    if not mode:
        return [], {}, None

    launch_args: list[str] = []
    inject_env: dict[str, str] = {}
    settings_path: Path | None = None
    config_dir = data_dir / "provider-config"
    transport = inject_cfg.get("mcp_transport", "http")
    server_url = _get_server_url(mcp_cfg or {}, transport)

    http_key = inject_cfg.get("mcp_http_key", "httpUrl")

    if mode == "settings_file":
        # Write a settings JSON file at a user-specified path (e.g. .qwen/settings.json,
        # or ~/.codebuddy/.mcp.json for user-scope configs).
        raw_path = inject_cfg.get("mcp_settings_path", "")
        if not raw_path:
            raise ValueError(f"mcp_inject = 'settings_file' requires mcp_settings_path")
        # Expand ~ to user home (e.g. ~/.codebuddy/.mcp.json), then resolve
        # relative paths against project_dir/CWD as before.
        target = Path(raw_path).expanduser()
        if not target.is_absolute():
            base = Path(project_dir) if project_dir else Path.cwd()
            target = base / target
        settings_path = _write_json_mcp_settings(target, server_url,
                                                  transport=transport, token=token,
                                                  http_key=http_key)
        # Optionally set an env var pointing to the settings file
        env_var = inject_cfg.get("mcp_env_var")
        if env_var:
            inject_env[env_var] = str(settings_path)

    elif mode == "env":
        # Write a settings file in provider-config dir, expose via env var
        env_var = inject_cfg.get("mcp_env_var")
        if not env_var:
            raise ValueError(f"mcp_inject = 'env' requires mcp_env_var")
        settings_path = _write_json_mcp_settings(
            config_dir / f"{instance_name}-settings.json",
            server_url, transport=transport, token=token, http_key=http_key,
        )
        # Merge project .mcp.json servers into the settings file
        merge_project = inject_cfg.get("mcp_merge_project", False)
        if merge_project and project_dir and settings_path:
            project_servers = _read_project_mcp_servers(project_dir)
            if project_servers:
                try:
                    data = json.loads(settings_path.read_text("utf-8"))
                    servers = data.get("mcpServers", {})
                    for name, cfg in project_servers.items():
                        if name not in servers:
                            # Normalize url key for providers that expect "httpUrl"
                            # (Gemini/Qwen). For standard-MCP providers with
                            # http_key="url", leave existing "url" entries as-is.
                            entry = dict(cfg)
                            srv_type = entry.get("type", "http")
                            if srv_type in ("http", "streamable-http") and http_key != "url":
                                if "url" in entry and http_key not in entry:
                                    entry[http_key] = entry.pop("url")
                            entry.setdefault("trust", True)
                            servers[name] = entry
                    data["mcpServers"] = servers
                    settings_path.write_text(json.dumps(data, indent=2) + "\n", "utf-8")
                except Exception:
                    pass
        inject_env[env_var] = str(settings_path)

    elif mode == "flag":
        # Write a config file, pass it as a CLI flag
        flag = inject_cfg.get("mcp_flag", "--mcp-config")
        merge_project = inject_cfg.get("mcp_merge_project", False)
        project_servers = _read_project_mcp_servers(project_dir) if (merge_project and project_dir) else {}
        settings_path = _write_claude_mcp_config(
            config_dir / f"{instance_name}-mcp.json",
            server_url, token=token, project_servers=project_servers,
        )
        launch_args = [flag, str(settings_path)]

    elif mode == "env_content":
        # Build JSON config content and set it as an env var directly (no file written).
        # Used by Kilo CLI which reads KILO_CONFIG_CONTENT at startup.
        env_var = inject_cfg.get("mcp_env_var")
        if not env_var:
            raise ValueError("mcp_inject = 'env_content' requires mcp_env_var")
        entry: dict = {"type": "remote", "url": server_url, "enabled": True}
        if token:
            entry["headers"] = {"Authorization": f"Bearer {token}"}
        payload = {"mcp": {SERVER_NAME: entry}}
        inject_env[env_var] = json.dumps(payload)

    elif mode == "bearer_flag":
        # Direct CLI-flag inject (codex's default since MCP-2): point at the REAL
        # server URL and have the agent read its bearer token from an env var,
        # keeping the token out of argv. This replaced the local identity proxy
        # (since deleted) after a live codex run confirmed the config keys
        # end-to-end; the server authenticates the Bearer token directly.
        token_env = inject_cfg.get("mcp_bearer_env_var", "AGENTCHATTR_TOKEN")
        launch_args = [
            "-c", f'mcp_servers.{SERVER_NAME}.url="{server_url}"',
            "-c", f'mcp_servers.{SERVER_NAME}.bearer_token_env_var="{token_env}"',
        ]
        if token:
            inject_env[token_env] = token

    return launch_args, inject_env, settings_path


def _ensure_gemini_folder_trusted(project_dir: Path) -> None:
    """Add project_dir as TRUST_FOLDER in ~/.gemini/trustedFolders.json.

    Gemini CLI blocks ALL MCPs (including system-settings ones) for untrusted
    folders. A more-specific TRUST_FOLDER entry overrides any parent-level
    DO_NOT_TRUST rule, so we always write the exact cwd we're launching in.
    Respects GEMINI_CLI_TRUSTED_FOLDERS_PATH env override if set.
    """
    trusted_path_env = os.environ.get("GEMINI_CLI_TRUSTED_FOLDERS_PATH", "")
    if trusted_path_env:
        trusted_file = Path(trusted_path_env)
    else:
        trusted_file = Path.home() / ".gemini" / "trustedFolders.json"

    try:
        data: dict = {}
        if trusted_file.exists():
            try:
                data = json.loads(trusted_file.read_text("utf-8"))
            except Exception:
                data = {}

        folder_key = str(project_dir)
        if data.get(folder_key) == "TRUST_FOLDER":
            return  # already trusted — nothing to do

        data[folder_key] = "TRUST_FOLDER"
        trusted_file.parent.mkdir(parents=True, exist_ok=True)
        trusted_file.write_text(json.dumps(data, indent=2) + "\n", "utf-8")
        print(f"  Trusted folder for Gemini MCPs: {folder_key}")
    except Exception as exc:
        print(f"  Warning: could not update Gemini trusted folders: {exc}")


def _build_provider_launch(
    agent: str,
    agent_cfg: dict,
    instance_name: str,
    data_dir: Path,
    extra_args: list[str],
    env: dict[str, str],
    *,
    token: str = "",
    mcp_cfg: dict | None = None,
    project_dir: Path | None = None,
) -> tuple[list[str], dict[str, str], dict[str, str], Path | None]:
    """Return provider-specific launch args/env/inject_env/settings_path.

    inject_env: env vars that must propagate INTO the agent process.  On
    Mac/Linux these are prefixed onto the tmux command via ``env VAR=val``
    because subprocess.run(env=...) only affects the tmux client binary.
    On Windows they are simply merged into the Popen env dict.
    """
    inject_cfg = _resolve_mcp_inject(agent, agent_cfg)
    mcp_args, inject_env, settings_path = _apply_mcp_inject(
        inject_cfg, instance_name, data_dir,
        token=token, mcp_cfg=mcp_cfg, project_dir=project_dir,
    )

    launch_args = [*mcp_args, *extra_args]
    launch_env = dict(env)

    return launch_args, launch_env, inject_env, settings_path
