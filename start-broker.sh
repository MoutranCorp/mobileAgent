#!/usr/bin/env bash
#
# One-tap launcher for the on-device agent broker.
#
# Run from anywhere inside the Debian guest after a reboot/crash:
#
#   bash ~/mobileAgent/start-broker.sh
#
# It resolves the broker relative to this script, so the path can't drift
# regardless of where the repo is cloned. Open http://127.0.0.1:8765/ once
# the banner prints.
#
# Env overrides:
#   PROFILE    engine profile (default: claude-max; use 'mock' for offline)
#   PORT       broker port (default: 8765)
#   PROJECTS   project workspace dir (default: ~/projects)
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

PROFILE="${PROFILE:-claude-max}"
PORT="${PORT:-8765}"
PROJECTS="${PROJECTS:-$HOME/projects}"

export WATCHMAN_DISABLE=1
export EXPO_NO_TELEMETRY=1

[ -f "$HERE/broker/src/index.js" ] || {
  echo "✗ broker not found at $HERE/broker — is this the repo root?" >&2
  exit 1
}

cd "$HERE/broker"
exec node src/index.js \
  --profile "$PROFILE" \
  --port "$PORT" \
  --projects "$PROJECTS" \
  --verbose
