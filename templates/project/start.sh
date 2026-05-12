#!/usr/bin/env sh
# Start the agentchattr server for this project (port from config.toml).
AGENTCHATTR_CONFIG_DIR="$(cd "$(dirname -- "$0")" && pwd)"
export AGENTCHATTR_CONFIG_DIR
. "$AGENTCHATTR_CONFIG_DIR/_load.sh" || exit 1
exec "$AGENTCHATTR_ROOT/macos-linux/start.sh" "$@"
