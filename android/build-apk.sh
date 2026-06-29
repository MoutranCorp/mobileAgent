#!/usr/bin/env bash
#
# Build app-debug.apk and refresh dist/app-debug.apk.
#
# Prereqs: run android/setup-build-tools.sh once (JDK 17 + Android SDK; on arm64
# also qemu-user + amd64 libs). On aarch64 hosts this wires AGP to run Google's
# x86_64 aapt2 under qemu (Android ships aapt2/zipalign x86_64-only) and swaps in
# the native arm64 zipalign. On x86_64 hosts it's a plain Gradle build.
#
# Output is signed with the repo's stable debug.keystore, so the APK installs
# in-place over an existing install (no data wipe).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
fi
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"

BT="$ANDROID_HOME/build-tools/34.0.0"
GRADLE_ARGS=(:app:assembleDebug --no-daemon --console=plain)

ARCH="$(uname -m)"
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  command -v qemu-x86_64-static >/dev/null \
    || { echo "qemu-x86_64-static missing — run android/setup-build-tools.sh first"; exit 1; }
  # AGP validates the override path ends in 'aapt2' and then exec's it; a shell
  # wrapper that defers to qemu+Google-aapt2 is accepted and is version-correct.
  OVR="$ANDROID_HOME/aapt2-override"
  mkdir -p "$OVR"
  cat > "$OVR/aapt2" <<EOF
#!/bin/sh
exec /usr/bin/qemu-x86_64-static "$BT/aapt2" "\$@"
EOF
  chmod +x "$OVR/aapt2"
  # AGP also exec's zipalign from build-tools during packaging — use the arm64 one.
  [ -x /usr/bin/zipalign ] && cp -f /usr/bin/zipalign "$BT/zipalign"
  GRADLE_ARGS+=("-Pandroid.aapt2FromMavenOverride=$OVR/aapt2")
fi

printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$HERE/local.properties"

( cd "$HERE" && ./gradlew "${GRADLE_ARGS[@]}" )

APK="$HERE/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || { echo "build produced no APK at $APK"; exit 1; }
cp -f "$APK" "$ROOT/dist/app-debug.apk"
echo "Updated $ROOT/dist/app-debug.apk"
