#!/usr/bin/env bash
#
# PHASE 2 provisioning (Debian side) — install the toolchain + the agent broker
# into the guest so the foreground service can launch it.
#
#   proot-distro login debian
#   bash ~/provisioning/provision-debian.sh
#
# Env:
#   BROKER_SRC   path to the broker source to copy (default: ~/mobile-agent-src/broker)
#   BROKER_REPO  git URL to clone if BROKER_SRC is absent
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

BROKER_SRC="${BROKER_SRC:-$HOME/mobile-agent-src/broker}"
BROKER_DEST="$HOME/agent-broker"

step "Ensuring toolchain"
apt-get update -y
apt-get install -y nodejs npm git curl ca-certificates
have claude || npm install -g @anthropic-ai/claude-code
ok "node $(node --version), npm $(npm --version)"

step "Installing GitHub CLI (gh) for the 'Create PR' feature (optional)"
if have gh; then ok "gh already installed"
else
  apt-get install -y gh 2>/dev/null && ok "gh installed" || \
    warn "gh not in apt; install from https://github.com/cli/cli (PR creation needs it; push works without it)"
fi

step "Installing the agent broker into $BROKER_DEST"
if [ -d "$BROKER_SRC" ]; then
  mkdir -p "$BROKER_DEST"
  cp -r "$BROKER_SRC/." "$BROKER_DEST/"
  ok "Copied broker from $BROKER_SRC"
elif [ -n "${BROKER_REPO:-}" ]; then
  rm -rf "$BROKER_DEST"
  git clone "$BROKER_REPO" "$BROKER_DEST"
  ok "Cloned broker from $BROKER_REPO"
elif [ -d "$BROKER_DEST" ]; then
  ok "Broker already present at $BROKER_DEST"
else
  die "No broker source. Set BROKER_SRC or BROKER_REPO, or copy the broker to $BROKER_DEST"
fi

step "Installing broker dependencies"
( cd "$BROKER_DEST" && npm install --omit=dev )
ok "Broker deps installed"

step "Creating projects directory"
mkdir -p "$HOME/projects"
ok "~/projects ready"

step "Verifying broker boots (mock engine, 3s)"
( cd "$BROKER_DEST" && BROKER_AUTOSTART=1 timeout 3 node src/index.js --profile mock --port 8765 \
    --projects "$HOME/projects" >/tmp/broker-check.log 2>&1 || true )
if grep -q "Web UI" /tmp/broker-check.log; then ok "Broker boots cleanly"; else warn "Check /tmp/broker-check.log"; fi

cat <<EOF

${c_green}Provisioning complete.${c_reset}

Start the broker:
  bash ~/provisioning/run-broker.sh                 # default profile (claude-max)
  PROFILE=mock bash ~/provisioning/run-broker.sh    # offline demo, no login needed

Then open the UI:
  - on the phone app: it auto-loads http://127.0.0.1:8765/
  - in a browser:     http://127.0.0.1:8765/

If using Claude (Max), authenticate first:  claude   then  /login
EOF
