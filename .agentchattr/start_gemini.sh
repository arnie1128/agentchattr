#!/usr/bin/env sh
# Start Gemini wrapper for this project (auto-starts server if needed).
AGENTCHATTR_CONFIG_DIR="$(cd "$(dirname -- "$0")" && pwd)"
export AGENTCHATTR_CONFIG_DIR
. "$AGENTCHATTR_CONFIG_DIR/_load.sh" || exit 1
exec "$AGENTCHATTR_ROOT/launch.sh" gemini --agent-cwd "$AGENT_CWD" "$@"
