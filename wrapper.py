"""Agent wrapper - runs the real interactive CLI with auto-trigger on @mentions.

Usage:
    python wrapper.py claude
    python wrapper.py codex
    python wrapper.py gemini
    python wrapper.py kimi
    python wrapper.py qwen

Cross-platform:
  - Windows: injects keystrokes via Win32 WriteConsoleInput (wrapper_windows.py)
  - Mac/Linux: injects keystrokes via tmux send-keys (wrapper_unix.py)

How it works:
  1. Starts the agent CLI in an interactive terminal.
  2. Watches the queue file in the background for @mentions from the chat room.
  3. When triggered, injects "use mcp to read #channel - you're mentioned, take appropriate action and respond".
  4. The agent picks up the prompt as if the user typed it.
"""

import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

from src.wrapper.identity import Identity, handle_heartbeat_409
from src.wrapper.server_client import ServerClient

ROOT = Path(__file__).parent

from src.mcp.mcp_inject import (
    _apply_mcp_inject,
    _build_provider_launch,
    _ensure_gemini_folder_trusted,
    _resolve_mcp_inject,
    _VALID_INJECT_MODES,
)


# ---------------------------------------------------------------------------
# Queue watcher
# ---------------------------------------------------------------------------

def _notify_recovery(data_dir: Path, agent_name: str):
    """Write a flag file that the server picks up and broadcasts as a system message."""
    try:
        flag = data_dir / f"{agent_name}_recovered"
        flag.write_text(agent_name, "utf-8")
    except Exception:
        pass


_IDENTITY_HINT = (
    " (If this is a multi-instance session, reclaim your previous identity from "
    "your context window, NOT from the chat history before responding. If you "
    "didn't have one, tell the user to give you a name by clicking your status "
    "pill at the top.)"
)


def build_trigger_prompt(*, channel, job_id=None, custom_prompt="", role="",
                         rules_text="", identity_hint="") -> str:
    """Assemble the agent wake prompt (pure — no I/O, WRAP-2).

    The watcher does the role/rules fetching and the epoch/refresh decision; this
    just builds the string from the already-resolved pieces so it is unit-testable
    without the network or filesystem.
    """
    if custom_prompt:
        prompt = custom_prompt
    elif job_id:
        prompt = f"use mcp to read job_id={job_id} - you're mentioned in a job thread, take appropriate action and respond"
    else:
        prompt = f"use mcp to read #{channel} - you're mentioned, take appropriate action and respond"
    if role:
        prompt += f"\n\nROLE: {role}"
    if rules_text:
        prompt += f"\n\nRULES:\n{rules_text}"
    if identity_hint:
        prompt += identity_hint
    return prompt


def _queue_watcher(get_identity_fn, inject_fn, *, is_multi_instance: bool = False, trigger_flag=None,
                   client=None, agent_name: str = "", get_token_fn=None,
                   refresh_interval: int = 10):
    """Poll queue file and inject an MCP read task when triggered."""
    first_mention = True
    last_rules_epoch = 0  # 0 = unknown/cold start — will inject on first trigger
    trigger_count = 0
    while True:
        try:
            _, queue_file = get_identity_fn()
            if queue_file.exists() and queue_file.stat().st_size > 0:
                with open(queue_file, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                queue_file.write_text("", "utf-8")

                has_trigger = False
                channel = "general"
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    has_trigger = True
                    if isinstance(data, dict) and "channel" in data:
                        channel = data["channel"]

                if has_trigger:
                    # Signal activity BEFORE injecting — covers the thinking phase
                    if trigger_flag is not None:
                        trigger_flag[0] = True
                    time.sleep(0.5)

                    # Check if this is a job/activity-scoped trigger
                    job_id = None
                    custom_prompt = ""
                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                            if isinstance(data, dict) and "job_id" in data:
                                job_id = data["job_id"]
                            if isinstance(data, dict):
                                raw_prompt = data.get("prompt", "")
                                if isinstance(raw_prompt, str) and raw_prompt.strip():
                                    custom_prompt = raw_prompt.strip()
                        except json.JSONDecodeError:
                            pass

                    # Use current identity (may have changed via rename)
                    current_name, _ = get_identity_fn()
                    # Fetch role — check both current name and base name
                    role = client.fetch_role(current_name)
                    if not role and current_name != agent_name:
                        role = client.fetch_role(agent_name)

                    # Smart rules injection: first trigger, epoch change, or periodic refresh
                    _token = get_token_fn() if get_token_fn else ""
                    rules_data = client.fetch_active_rules(_token)
                    trigger_count += 1
                    rules_text = ""
                    if rules_data:
                        # Use server-side refresh_interval (live from settings UI)
                        ri = rules_data.get("refresh_interval", refresh_interval)
                        need_inject = (
                            last_rules_epoch == 0
                            or rules_data["epoch"] != last_rules_epoch
                            or (ri > 0 and trigger_count % ri == 0)
                        )
                        if need_inject:
                            if rules_data["rules"]:
                                rules_text = "; ".join(rules_data["rules"])
                            last_rules_epoch = rules_data["epoch"]
                            client.report_rule_sync(current_name, rules_data["epoch"], _token)

                    identity_hint = ""
                    if first_mention and is_multi_instance:
                        identity_hint = _IDENTITY_HINT
                        first_mention = False

                    prompt = build_trigger_prompt(
                        channel=channel, job_id=job_id, custom_prompt=custom_prompt,
                        role=role, rules_text=rules_text, identity_hint=identity_hint,
                    )
                    # Flatten to single line — multi-line text triggers paste
                    # detection in CLIs (Claude Code shows "[Pasted text +N]")
                    # which can break injection of long session prompts
                    inject_fn(prompt.replace("\n", " "))
        except Exception:
            pass

        time.sleep(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _parse_wrapper_args(agent_names: list[str]):
    """Build the wrapper CLI parser and return (args, unrecognized_extra).

    The per-project isolation flags are consumed earlier by
    config_loader.apply_cli_overrides(); they are declared here only so
    --help lists them and argparse doesn't reject them.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Agent wrapper with chat auto-trigger")
    parser.add_argument("agent", choices=agent_names, help=f"Agent to wrap ({', '.join(agent_names)})")
    parser.add_argument("--no-restart", action="store_true", help="Do not restart on exit")
    parser.add_argument("--label", type=str, default=None, help="Custom display label")
    parser.add_argument("--data-dir",      default=None, help="Override server.data_dir (path)")
    parser.add_argument("--port",          default=None, help="Override server.port (int)")
    parser.add_argument("--mcp-http-port", default=None, help="Override mcp.http_port (int)")
    parser.add_argument("--mcp-sse-port",  default=None, help="Override mcp.sse_port (int)")
    parser.add_argument("--upload-dir",    default=None, help="Override images.upload_dir (path)")
    parser.add_argument(
        "--agent-cwd", default=None,
        help="Override agent working directory (overrides config.cwd). "
             "Accepts absolute, ~user, or shell-CWD-relative paths.",
    )
    return parser.parse_known_args()


def main():
    import urllib.error

    from src.core.config_loader import apply_cli_overrides, load_config

    # Apply AGENTCHATTR_* overrides (from CLI flags or env) BEFORE loading
    # config so the wrapper connects to the same data_dir/ports as a server
    # launched with matching flags.
    apply_cli_overrides()
    config = load_config(ROOT)

    agent_names = list(config.get("agents", {}).keys())
    args, extra = _parse_wrapper_args(agent_names)

    agent = args.agent
    agent_cfg = config.get("agents", {}).get(agent, {})
    # cwd resolution priority: --agent-cwd > config.cwd > "."
    if args.agent_cwd:
        # CLI relative paths anchor at shell CWD (POSIX convention).
        cwd = str(Path(args.agent_cwd).expanduser().resolve())
        cwd_source = "--agent-cwd"
    else:
        cwd = agent_cfg.get("cwd", ".")
        cwd_source = "config.cwd" if "cwd" in agent_cfg else "default"
    command = agent_cfg.get("command", agent)
    data_dir = ROOT / config.get("server", {}).get("data_dir", "./data")
    data_dir.mkdir(parents=True, exist_ok=True)
    server_port = config.get("server", {}).get("port", 8300)
    mcp_cfg = config.get("mcp", {})
    client = ServerClient(server_port)

    try:
        registration = client.register(agent, args.label)
    except Exception as exc:
        print(f"  Registration failed ({exc}).")
        print("  Wrapper cannot continue without a registered identity.")
        sys.exit(1)

    assigned_name = registration["name"]
    assigned_token = registration["token"]
    print(f"  Registered as: {assigned_name} (slot {registration.get('slot', '?')})")

    # Resolve the MCP injection mode. Every agent direct-injects (settings file,
    # CLI flag, env var, or bearer-from-env); the server authenticates the token,
    # so there is no local proxy.
    inject_cfg = _resolve_mcp_inject(agent, agent_cfg)
    inject_mode = inject_cfg.get("mcp_inject", "")
    if inject_mode and inject_mode not in _VALID_INJECT_MODES:
        print(f"  Error: unknown mcp_inject mode '{inject_mode}' for agent '{agent}'.")
        print(f"  Valid modes: {', '.join(sorted(_VALID_INJECT_MODES))}")
        sys.exit(1)

    _id = Identity(assigned_name, assigned_token)

    def get_identity():
        name = _id.name
        return name, data_dir / f"{name}_queue.jsonl"

    def get_token():
        return _id.token

    # Rewrite MCP config when token/name changes (e.g. after 409 re-register).
    # Most CLIs won't re-read mid-session, but the file is correct for next restart.
    def _rewrite_mcp_config(instance_name: str, new_token: str):
        if not inject_mode:
            return  # nothing to rewrite for agents with no inject config
        try:
            _apply_mcp_inject(
                inject_cfg, instance_name, data_dir,
                token=new_token, mcp_cfg=mcp_cfg,
                project_dir=(ROOT / cwd).resolve(),
            )
        except Exception:
            pass

    def set_runtime_identity(new_name: str | None = None, new_token: str | None = None):
        old_name, old_token = _id.get()
        changed = _id.update(new_name, new_token)
        current_name, current_token = _id.get()

        if changed:
            if new_name and new_name != old_name:
                print(f"  Identity updated: {old_name} -> {new_name}")
            if new_token and new_token != old_token:
                print(f"  Session refreshed for @{current_name}")
            _rewrite_mcp_config(current_name, current_token)

        return changed

    queue_file = data_dir / f"{assigned_name}_queue.jsonl"
    if queue_file.exists():
        queue_file.write_text("", "utf-8")

    strip_vars = {"CLAUDECODE"} | set(agent_cfg.get("strip_env", []))
    env = {k: v for k, v in os.environ.items() if k not in strip_vars}

    resolved = shutil.which(command)
    if not resolved:
        print(f"  Error: '{command}' not found on PATH.")
        print("  Install it first, then try again.")
        sys.exit(1)
    command = resolved

    project_dir = (ROOT / cwd).resolve()

    # Gemini: ensure the project directory is trusted so MCPs are allowed.
    # Gemini blocks ALL MCPs for untrusted folders — even system-settings ones.
    if agent == "gemini" or inject_cfg.get("mcp_inject") == "env":
        _ensure_gemini_folder_trusted(project_dir)

    launch_args, env, inject_env, mcp_settings_path = _build_provider_launch(
        agent=agent,
        agent_cfg=agent_cfg,
        instance_name=assigned_name,
        data_dir=data_dir,
        extra_args=extra,
        env=env,
        token=assigned_token,
        mcp_cfg=mcp_cfg,
        project_dir=project_dir,
    )

    print(f"  === {assigned_name.capitalize()} Chat Wrapper ===")
    print(f"  MCP: direct connect ({inject_mode}) with bearer auth")
    if mcp_settings_path:
        print(f"  Config: {mcp_settings_path}")
    print(f"  @{assigned_name} mentions auto-inject MCP reads")
    print(f"  Starting {command} in {project_dir} (cwd source: {cwd_source})\n")

    def _heartbeat():
        while True:
            current_name, _ = get_identity()
            current_token = get_token()
            try:
                resp_data = client.heartbeat(current_name, current_token)
                server_name = resp_data.get("name", current_name)
                if server_name != current_name:
                    set_runtime_identity(server_name)
            except urllib.error.HTTPError as exc:
                handle_heartbeat_409(
                    exc, client, agent, args.label, set_runtime_identity,
                    on_recover=lambda n: _notify_recovery(data_dir, n))
                time.sleep(5)
                continue
            except Exception:
                time.sleep(5)
                continue

            time.sleep(5)

    threading.Thread(target=_heartbeat, daemon=True).start()

    _watcher_inject_fn = None
    _watcher_thread = None
    _is_multi_instance = registration.get("slot", 1) > 1
    _trigger_flag = [False]  # shared: queue watcher sets True, activity checker reads
    _refresh_interval = 10  # default; overridden per-trigger by server settings

    def _watcher_kwargs():
        # Single source for the queue-watcher thread kwargs (NEW-WRAP-1: pass the
        # shared client instead of server_port so the watcher stops re-creating
        # one per trigger).
        return {"is_multi_instance": _is_multi_instance, "trigger_flag": _trigger_flag,
                "client": client, "agent_name": assigned_name,
                "get_token_fn": get_token, "refresh_interval": _refresh_interval}

    def start_watcher(inject_fn):
        nonlocal _watcher_inject_fn, _watcher_thread
        _watcher_inject_fn = inject_fn
        _watcher_thread = threading.Thread(
            target=_queue_watcher,
            args=(get_identity, inject_fn),
            kwargs=_watcher_kwargs(),
            daemon=True,
        )
        _watcher_thread.start()

    def _watcher_monitor():
        nonlocal _watcher_thread
        while True:
            time.sleep(5)
            if _watcher_thread and not _watcher_thread.is_alive() and _watcher_inject_fn:
                _watcher_thread = threading.Thread(
                    target=_queue_watcher,
                    args=(get_identity, _watcher_inject_fn),
                    kwargs=_watcher_kwargs(),
                    daemon=True,
                )
                _watcher_thread.start()
                current_name, _ = get_identity()
                _notify_recovery(data_dir, current_name)

    threading.Thread(target=_watcher_monitor, daemon=True).start()

    _activity_checker = None

    def _set_activity_checker(checker):
        nonlocal _activity_checker
        _activity_checker = checker

    def _activity_monitor():
        last_active = None
        last_report_time = 0
        REPORT_INTERVAL = 3  # re-send state every 3s while active (keeps server lease fresh)
        while True:
            time.sleep(1)
            if not _activity_checker:
                continue
            try:
                active = _activity_checker()
                now = time.time()
                # Send on state change, periodically while active (refresh lease),
                # or periodically while idle (keep presence alive)
                IDLE_REPORT_INTERVAL = 8  # keep-alive while idle
                should_send = (
                    active != last_active
                    or (active and now - last_report_time >= REPORT_INTERVAL)
                    or (not active and now - last_report_time >= IDLE_REPORT_INTERVAL)
                )
                if should_send:
                    current_name, _ = get_identity()
                    current_token = get_token()
                    client.heartbeat_active(current_name, current_token, active)
                    last_active = active
                    last_report_time = now
            except Exception:
                pass

    threading.Thread(target=_activity_monitor, daemon=True).start()

    _agent_pid = [None]

    if sys.platform == "win32":
        from src.wrapper.windows import get_activity_checker, run_agent

        _set_activity_checker(get_activity_checker(_agent_pid, agent_name=assigned_name, trigger_flag=_trigger_flag))
    else:
        from src.wrapper.unix import get_activity_checker, run_agent, build_tmux_session_name

        unix_session_name = build_tmux_session_name(
            assigned_name,
            project_dir=project_dir,
            data_dir=data_dir,
            server_port=server_port,
            mcp_cfg=mcp_cfg,
        )
        _set_activity_checker(get_activity_checker(unix_session_name, trigger_flag=_trigger_flag))

    run_kwargs = dict(
        command=command,
        extra_args=launch_args,
        cwd=cwd,
        env=env,
        queue_file=queue_file,
        agent=agent,
        no_restart=args.no_restart,
        start_watcher=start_watcher,
        strip_env=list(strip_vars),
        pid_holder=_agent_pid,
        inject_env=inject_env,
        inject_delay=agent_cfg.get("inject_delay", 0.3),
    )
    # Windows-only injection tuning (no-op on other platforms).
    if sys.platform == "win32":
        run_kwargs["enter_backend"] = agent_cfg.get("enter_backend", "console_input")
    if sys.platform != "win32":
        run_kwargs["session_name"] = unix_session_name

    try:
        run_agent(**run_kwargs)
    finally:
        try:
            current_name, _ = get_identity()
            current_token = get_token()
            client.deregister(current_name, current_token)
            print(f"  Deregistered {current_name}")
        except Exception:
            pass

    print("  Wrapper stopped.")


if __name__ == "__main__":
    main()
