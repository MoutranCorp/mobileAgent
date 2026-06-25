#!/usr/bin/env bash
# Shared helpers for the provisioning scripts.
set -euo pipefail

c_reset=$'\033[0m'; c_blue=$'\033[34m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'
step()  { printf '%s==>%s %s\n' "$c_blue"  "$c_reset" "$*"; }
ok()    { printf '%s ✓ %s%s\n'  "$c_green" "$*" "$c_reset"; }
warn()  { printf '%s ! %s%s\n'  "$c_yellow" "$*" "$c_reset"; }
die()   { printf '%s ✗ %s%s\n'  "$c_red" "$*" "$c_reset" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }
