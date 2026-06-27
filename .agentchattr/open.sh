#!/usr/bin/env sh
# Open this project's chat room in the browser (uses this instance's port).
AGENTCHATTR_CONFIG_DIR="$(cd "$(dirname -- "$0")" && pwd)"
export AGENTCHATTR_CONFIG_DIR
. "$AGENTCHATTR_CONFIG_DIR/_load.sh" || exit 1
exec "$AGENTCHATTR_ROOT/launch.sh" open
