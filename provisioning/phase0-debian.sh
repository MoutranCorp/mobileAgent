#!/usr/bin/env bash
#
# PHASE 0 (Debian side) — the gate, step 2 of 2.
#
# Run this INSIDE the Debian guest (`proot-distro login debian`). It proves the
# three riskiest assumptions of the whole plan:
#   (a) Claude Code runs on-device on your Max plan,
#   (b) Metro bundles on-device,
#   (c) a dev client can test on the same phone.
# If all three pass, the entire plan is viable. Do NOT start the Kotlin app
# until this passes.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

export WATCHMAN_DISABLE=1
export EXPO_NO_TELEMETRY=1

step "Installing base toolchain (node, npm, git, curl)"
apt-get update -y
apt-get install -y nodejs npm git curl ca-certificates
ok "node $(node --version), npm $(npm --version)"

step "Installing Claude Code CLI"
if have claude; then ok "claude already installed: $(claude --version 2>/dev/null || echo '?')"
else npm install -g @anthropic-ai/claude-code; fi

cat <<EOF

${c_yellow}ACTION REQUIRED — authenticate Claude Code on your Max subscription:${c_reset}
  1) run:  claude
  2) use:  /login
  3) open the printed URL in your phone browser, authorize, paste the code back
  4) verify it shows logged in (no API key)

Press Enter once you've logged in to continue the smoke test…
EOF
read -r _

step "Smoke test 1/3 — Claude headless stream-json"
TMPD="$(mktemp -d)"
( cd "$TMPD" && echo "hello from on-device" > note.txt
  claude -p "List the files in this directory." --output-format stream-json | head -n 20 ) \
  && ok "stream-json emitted (one JSON object per line)" \
  || warn "stream-json smoke test failed — check 'claude /login' / auth status"

step "Smoke test 2/3 — scaffold an Expo app"
cd "$HOME"
if [ ! -d demo ]; then
  npx --yes create-expo-app@latest demo
fi
cd demo
npx --yes expo install expo-dev-client >/dev/null 2>&1 || warn "expo-dev-client install had issues"
ok "Expo app scaffolded at ~/demo"

step "Smoke test 3/3 — start Metro on localhost (Ctrl-C to stop)"
cat <<EOF
Run this, then open Expo Go / your dev client and point it at exp://127.0.0.1:8081:

  cd ~/demo && WATCHMAN_DISABLE=1 npx expo start --localhost --dev-client

Edit a screen, save, and confirm Fast Refresh updates the running app on THIS phone.
EOF

ok "Phase 0 gate scripted. When all three pass, proceed to provision-debian.sh."
