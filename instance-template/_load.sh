#!/usr/bin/env sh
# _load.sh - parse .agentchattr/config.toml (via _load.py) and export env vars.
#
# Sourced (not executed) by the thin wrappers (start.sh / start_<agent>.sh)
# in this directory. Each thin wrapper sets AGENTCHATTR_CONFIG_DIR to its
# own dirname before sourcing so _load.sh can locate config.toml without
# guessing $0.
#
# Path values in config.toml are resolved with three forms supported:
#   * absolute       /path/to/your-project
#   * home-relative  ~/path/to/your-project
#   * config-dir     ../some/path  (anchored at this script's directory)
#
# Exports (when present in config.toml):
#   AGENTCHATTR_ROOT          - install dir of agentchattr
#   AGENT_CWD                 - working dir for the wrapped agent process
#   AGENTCHATTR_PORT          - server port
#   AGENTCHATTR_DATA_DIR      - server data dir
#   AGENTCHATTR_MCP_HTTP_PORT - MCP http port
#   AGENTCHATTR_MCP_SSE_PORT  - MCP SSE port

if [ -z "$AGENTCHATTR_CONFIG_DIR" ]; then
    echo "ERROR: _load.sh: AGENTCHATTR_CONFIG_DIR is not set (source from a thin wrapper)." >&2
    return 1 2>/dev/null || exit 1
fi

if [ ! -f "$AGENTCHATTR_CONFIG_DIR/_load.py" ]; then
    echo "ERROR: _load.sh: $AGENTCHATTR_CONFIG_DIR/_load.py not found." >&2
    return 1 2>/dev/null || exit 1
fi

_agentchattr_python=""
if command -v python3 >/dev/null 2>&1; then
    _agentchattr_python="python3"
elif command -v python >/dev/null 2>&1; then
    _agentchattr_python="python"
else
    echo "ERROR: _load.sh: Python 3.11+ required (for tomllib)." >&2
    return 1 2>/dev/null || exit 1
fi

_agentchattr_exports="$(
    "$_agentchattr_python" \
        "$AGENTCHATTR_CONFIG_DIR/_load.py" \
        "$AGENTCHATTR_CONFIG_DIR/config.toml" \
        "$AGENTCHATTR_CONFIG_DIR"
)"
_agentchattr_status=$?
if [ "$_agentchattr_status" -ne 0 ]; then
    echo "ERROR: _load.sh: _load.py failed (exit $_agentchattr_status)." >&2
    return 1 2>/dev/null || exit 1
fi

# Parse one KEY=VALUE per line and export. Values are preserved verbatim
# (including spaces) because IFS='=' with read splits on the first '=' only.
while IFS='=' read -r _agentchattr_key _agentchattr_value; do
    [ -n "$_agentchattr_key" ] || continue
    export "$_agentchattr_key=$_agentchattr_value"
done <<EOF
$_agentchattr_exports
EOF

unset _agentchattr_python _agentchattr_exports _agentchattr_status _agentchattr_key _agentchattr_value
