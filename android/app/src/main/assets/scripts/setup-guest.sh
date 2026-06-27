#!/usr/bin/env sh
# Invoked by RuntimeLauncher as `$PREFIX/bin/sh setup-guest.sh` (explicit
# interpreter — do not rely on this shebang).
#
# One-time on-device provisioning, run inside the Termux bootstrap to stand up the
# Debian guest and install the toolchain + broker. This is the self-contained /
# auto-provision route: the app ships the broker bundled in assets and stages it at
# $BROKER_TARBALL, so NO separate git clone or external repo is needed. First run
# needs network (Debian rootfs + apt + npm); later launches just start the broker.
#
# Env (set by RuntimeLauncher):
#   BROKER_TARBALL  host path to the bundled broker source tarball (optional; if
#                   absent the guest's existing ~/agent-broker is reused).
set -e

echo "[setup-guest] installing proot-distro + git…"
# pkg is Termux's package manager. If the bundled bootstrap shipped without it (or
# it can't reach a mirror) the install below is a no-op — so don't mask the outcome
# with `|| true`; verify proot-distro actually exists and fail loudly with an
# actionable message, otherwise the failure surfaces later as a cryptic
# `proot-distro: not found` mid-provision.
pkg update -y || echo "[setup-guest] warn: pkg update failed (offline mirror?) — continuing"
pkg install -y proot-distro git || echo "[setup-guest] warn: pkg install failed — checking for an existing proot-distro"
if ! command -v proot-distro >/dev/null 2>&1; then
  echo "[setup-guest] ERROR: proot-distro is not installed and pkg could not install it." >&2
  echo "[setup-guest] The bundled Termux bootstrap must include pkg/apt with a reachable" >&2
  echo "[setup-guest] mirror (first run needs network), or pre-include proot-distro." >&2
  exit 1
fi
proot-distro install debian || echo "[setup-guest] debian already installed"

# Bind the bundled broker tarball into the guest at a fixed path (avoids guessing
# the rootfs location). Only when one was staged.
BIND=""
if [ -n "${BROKER_TARBALL:-}" ] && [ -f "$BROKER_TARBALL" ]; then
  echo "[setup-guest] delivering bundled broker into the guest…"
  BIND="--bind ${BROKER_TARBALL}:/root/agent-broker.tar.gz"
else
  echo "[setup-guest] no bundled broker tarball — will reuse ~/agent-broker if present"
fi

echo "[setup-guest] provisioning toolchain + broker inside debian…"
# shellcheck disable=SC2086  # intentional word-split of $BIND
proot-distro login debian $BIND -- bash -lc '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y nodejs npm git curl
  mkdir -p "$HOME/projects"

  if [ -f /root/agent-broker.tar.gz ]; then
    echo "[setup-guest] installing bundled broker -> ~/agent-broker"
    rm -rf "$HOME/agent-broker.new"; mkdir -p "$HOME/agent-broker.new"
    tar xf /root/agent-broker.tar.gz -C "$HOME/agent-broker.new"  # GNU tar auto-detects gzip vs plain (aapt may have gunzipped it)
    rm -rf "$HOME/agent-broker"; mv "$HOME/agent-broker.new" "$HOME/agent-broker"
    rm -f /root/agent-broker.tar.gz
    cd "$HOME/agent-broker" && npm install --omit=dev
  elif [ -d "$HOME/agent-broker" ]; then
    cd "$HOME/agent-broker" && npm install --omit=dev
  else
    echo "[setup-guest] ERROR: no bundled broker and no ~/agent-broker — cannot run." >&2
    exit 1
  fi

  # Claude Code CLI for the real engine (mock works without it). Non-fatal: the UI
  # still comes up and the user can install/login later.
  npm install -g @anthropic-ai/claude-code || echo "[setup-guest] warn: claude CLI install failed — install it later for the real engine"
  node --version && npm --version
'
echo "[setup-guest] done. For the real engine, authenticate once:"
echo "[setup-guest]   proot-distro login debian -- claude   (then /login)"
