#!/usr/bin/env bash
#
# PHASE 0 (Termux side) — the gate, step 1 of 2.
#
# Run this INSIDE Termux (installed from F-Droid, not the Play Store build).
# It installs proot-distro + a Debian guest, copies the provisioning scripts
# into the guest, and tells you how to continue inside Debian.
#
#   pkg install -y git
#   git clone <this repo> ~/mobile-agent   # or copy it over
#   bash ~/mobile-agent/provisioning/phase0-termux.sh
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

[ -n "${PREFIX:-}" ] || die "PREFIX not set — are you running inside Termux?"

step "Updating Termux packages"
pkg update -y && pkg upgrade -y || warn "pkg update had non-fatal errors"

step "Installing proot-distro + git + curl"
pkg install -y proot-distro git curl

step "Installing Debian guest (glibc userland)"
if proot-distro list 2>/dev/null | grep -q "debian.*installed"; then
  ok "Debian already installed"
else
  proot-distro install debian
fi

step "Staging provisioning scripts into the Debian guest home"
GUEST_HOME="$PREFIX/var/lib/proot-distro/installed-rootfs/debian/root"
mkdir -p "$GUEST_HOME/mobile-agent"
cp -r "$HERE/.." "$GUEST_HOME/mobile-agent-src" 2>/dev/null || true
cp -r "$HERE" "$GUEST_HOME/provisioning"

ok "Phase 0 (Termux) complete."
cat <<EOF

Next: drop into Debian and run the gate validation + provisioning:

  proot-distro login debian
  bash ~/provisioning/phase0-debian.sh        # the gate: claude + metro smoke tests
  bash ~/provisioning/provision-debian.sh     # full toolchain + broker install

EOF
