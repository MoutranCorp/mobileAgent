#!/usr/bin/env bash
#
# Build the self-contained debug APK, copy it to shared Downloads, and ask Android
# to open the package installer. This is meant for on-device/proot development:
# fix code here, run this script, tap Update in the system installer.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APK="$ROOT/dist/app-debug.apk"
DEST_DIR="${APK_EXPORT_DIR:-/sdcard/Download}"
DEST_NAME="${APK_EXPORT_NAME:-mobile-agent-debug.apk}"
DEST="$DEST_DIR/$DEST_NAME"

"$HERE/build-apk.sh"

mkdir -p "$DEST_DIR"
cp -f "$APK" "$DEST"
chmod 0644 "$DEST" 2>/dev/null || true
echo "Copied APK to $DEST"

AM_BIN="$(command -v am || true)"
[ -n "$AM_BIN" ] || [ ! -x /system/bin/am ] || AM_BIN=/system/bin/am

if [ -n "$AM_BIN" ]; then
  echo "Opening Android package installer..."
  "$AM_BIN" start \
    -a android.intent.action.VIEW \
    -d "file://$DEST" \
    -t application/vnd.android.package-archive \
    --grant-read-uri-permission >/dev/null
  echo "Tap Update/Install in the Android installer to apply it."
else
  echo "Android activity manager ('am') is not available here."
  echo "Open $DEST from Files/Downloads to install it."
fi
