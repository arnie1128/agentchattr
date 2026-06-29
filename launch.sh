#!/usr/bin/env sh
# agentchattr - stable public launch entry.  Usage: launch.sh <target> [args]
#   <target> = open | server | <agent>   (e.g. launch.sh codex)
# Instances call ONLY this entry; engine-internal launcher paths may change
# freely behind it without breaking any instance.
cd "$(dirname -- "$0")" || exit 1
TARGET="${1:-server}"

if [ "$TARGET" = "open" ]; then
    PORT="${AGENTCHATTR_PORT:-8300}"
    URL="http://127.0.0.1:$PORT"
    if command -v open >/dev/null 2>&1; then open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
    else echo "Open $URL in your browser."; fi
    exit 0
fi

[ $# -gt 0 ] && shift
if [ "$TARGET" = "server" ]; then
    exec "launchers/macos-linux/start.sh" "$@"
else
    exec "launchers/macos-linux/start_$TARGET.sh" "$@"
fi
