"""Parse .agentchattr/config.toml and emit KEY=VALUE lines on stdout.

Shared helper for the POSIX (_load.sh) and Windows (_load.cmd / start_*.cmd)
thin wrappers. Doing the TOML parsing here keeps the shell-specific code
short and avoids reimplementing path resolution rules per platform.

Usage:
    python _load.py <config_file> <config_dir>

Stdout: one KEY=VALUE line per setting. The caller is responsible for
    turning those into environment variables in its own syntax.
Stderr: human-readable error message on failure.
Exit:   0 on success, non-zero on any failure.

Path values from config.toml accept three forms (anchored at config_dir):
    * absolute       /path/to/your-project
    * home-relative  ~/path/to/your-project
    * config-dir     ../some/path
"""

import sys

try:
    import tomllib
except ModuleNotFoundError:
    print("_load.py: Python 3.11+ required (tomllib missing)", file=sys.stderr)
    sys.exit(1)

from pathlib import Path


def resolve(raw, anchor):
    # Same rule as config_loader.resolve_path (kept duplicated on purpose:
    # this template runs before agentchattr's install dir is known, so it
    # cannot import config_loader). Keep the two in sync.
    p = Path(str(raw)).expanduser()
    if not p.is_absolute():
        p = anchor / p
    return p.resolve()


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: _load.py <config_file> <config_dir>", file=sys.stderr)
        return 2

    config_file = Path(sys.argv[1])
    config_dir = Path(sys.argv[2])

    try:
        with open(config_file, "rb") as f:
            data = tomllib.load(f)
    except FileNotFoundError:
        print(f"_load.py: {config_file} not found", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"_load.py: failed to parse {config_file}: {exc}", file=sys.stderr)
        return 1

    root = data.get("agentchattr", {}).get("root")
    if not root:
        print("_load.py: config.toml missing [agentchattr] root", file=sys.stderr)
        return 1

    print(f"AGENTCHATTR_ROOT={resolve(root, config_dir)}")
    print(f"AGENT_CWD={resolve(data.get('agent', {}).get('cwd', '..'), config_dir)}")

    server = data.get("server", {})
    if "port" in server:
        print(f"AGENTCHATTR_PORT={server['port']}")
    if "data_dir" in server:
        print(f"AGENTCHATTR_DATA_DIR={resolve(server['data_dir'], config_dir)}")

    mcp = data.get("mcp", {})
    if "http_port" in mcp:
        print(f"AGENTCHATTR_MCP_HTTP_PORT={mcp['http_port']}")
    if "sse_port" in mcp:
        print(f"AGENTCHATTR_MCP_SSE_PORT={mcp['sse_port']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
