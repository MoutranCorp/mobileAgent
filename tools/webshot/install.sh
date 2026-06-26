#!/usr/bin/env bash
# Install webshot as a global, always-available tool + Claude Code skill.
#
#   - system Chromium (ARM64) via apt, if missing
#   - the webshot tool + playwright-core into ~/.agent-tools/webshot
#   - a user-scoped skill into ~/.claude/skills/webshot so EVERY project/session
#     in the broker can use it
#
# Idempotent: safe to re-run. Run from anywhere.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_DIR="${HOME}/.agent-tools/webshot"
SKILL_DIR="${HOME}/.claude/skills/webshot"

echo "==> webshot install"

# 1. Chromium
if ! command -v chromium >/dev/null 2>&1 && [ ! -x /usr/bin/chromium ]; then
  echo "==> installing chromium (apt)…"
  if command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=; fi
  $SUDO apt-get update -qq
  $SUDO apt-get install -y chromium fonts-liberation
else
  echo "==> chromium already present: $(command -v chromium || echo /usr/bin/chromium)"
fi

# 2. Tool + deps
echo "==> installing tool into ${TOOL_DIR}"
mkdir -p "${TOOL_DIR}"
cp "${SRC_DIR}/webshot.js" "${SRC_DIR}/package.json" "${TOOL_DIR}/"
( cd "${TOOL_DIR}" && npm install --no-audit --no-fund --loglevel=error )
chmod +x "${TOOL_DIR}/webshot.js"

# 3. User-scoped skill (available in every project/session)
echo "==> installing skill into ${SKILL_DIR}"
mkdir -p "${SKILL_DIR}"
cp "${SRC_DIR}/SKILL.md" "${SKILL_DIR}/SKILL.md"

echo "==> done. Try:  node ${TOOL_DIR}/webshot.js https://example.com"
