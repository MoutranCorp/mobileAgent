#!/usr/bin/env sh
# Invoked by RuntimeLauncher as `$PREFIX/bin/sh setup-guest.sh` (explicit
# interpreter — do not rely on this shebang).
# On-device provisioning, run once inside the Termux bootstrap to create the
# Debian guest and install the toolchain + broker. Mirrors provisioning/ but is
# the copy the app ships and runs.
set -e

echo "[setup-guest] installing proot-distro + debian…"
# pkg is Termux's package manager. If the bundled bootstrap shipped without it
# (or it can't reach a mirror) the install below is a no-op — so don't mask the
# outcome with `|| true` and march on; verify proot-distro actually exists and
# fail loudly with an actionable message, otherwise the failure surfaces much
# later as a cryptic `proot-distro: not found` mid-provision.
pkg update -y || echo "[setup-guest] warn: pkg update failed (offline mirror?) — continuing"
pkg install -y proot-distro git || echo "[setup-guest] warn: pkg install failed — checking for an existing proot-distro"
if ! command -v proot-distro >/dev/null 2>&1; then
  echo "[setup-guest] ERROR: proot-distro is not installed and pkg could not install it." >&2
  echo "[setup-guest] The bundled Termux bootstrap must pre-include proot-distro (and git)," >&2
  echo "[setup-guest] or the device needs network access to a Termux package mirror." >&2
  exit 1
fi
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
