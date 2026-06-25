#!/usr/bin/env bash
#
# Start the agent broker inside the Debian guest.
#
# Env:
#   PROFILE   engine profile id (default: claude-max). Use 'mock' for an offline
#             demo with no login.
#   PORT      broker port (default: 8765)
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

PROFILE="${PROFILE:-claude-max}"
PORT="${PORT:-8765}"
BROKER_DEST="${BROKER_DEST:-$HOME/agent-broker}"

[ -d "$BROKER_DEST" ] || die "Broker not found at $BROKER_DEST — run provision-debian.sh first"

export WATCHMAN_DISABLE=1
export EXPO_NO_TELEMETRY=1

step "Starting broker (profile=$PROFILE, port=$PORT)"
exec node "$BROKER_DEST/src/index.js" \
  --profile "$PROFILE" \
  --port "$PORT" \
  --projects "$HOME/projects" \
  --verbose
