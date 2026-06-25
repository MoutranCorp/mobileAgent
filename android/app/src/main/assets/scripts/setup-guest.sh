#!/usr/bin/env sh
# Invoked by RuntimeLauncher as `$PREFIX/bin/sh setup-guest.sh` (explicit
# interpreter — do not rely on this shebang).
# On-device provisioning, run once inside the Termux bootstrap to create the
# Debian guest and install the toolchain + broker. Mirrors provisioning/ but is
# the copy the app ships and runs.
set -e

echo "[setup-guest] installing proot-distro + debian…"
pkg update -y || true
pkg install -y proot-distro git || true
proot-distro install debian || echo "[setup-guest] debian already installed"

echo "[setup-guest] provisioning toolchain inside debian…"
proot-distro login debian -- bash -lc '
  set -e
  apt-get update -y
  apt-get install -y nodejs npm git curl
  mkdir -p "$HOME/projects"
  if [ ! -d "$HOME/agent-broker" ]; then
    echo "[setup-guest] place the broker at ~/agent-broker (git clone or copy)"
  else
    cd "$HOME/agent-broker" && npm install --omit=dev
  fi
  node --version && npm --version
'
echo "[setup-guest] done. Authenticate Claude with: proot-distro login debian -- claude  (then /login)"
