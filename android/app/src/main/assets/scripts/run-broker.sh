#!/usr/bin/env sh
# Invoked via explicit interpreter — do not rely on this shebang.
# Start the broker inside the Debian guest. PROFILE/PORT come from the app.
PROFILE="${PROFILE:-claude-max}"
PORT="${PORT:-8765}"
exec proot-distro login debian -- bash -lc \
  "cd \$HOME && node \$HOME/agent-broker/src/index.js --profile $PROFILE --port $PORT --projects \$HOME/projects"
