#!/usr/bin/env bash
#
# One-time setup to build the Android APK on a Linux host (incl. Debian arm64).
#
# Installs JDK 17 + the Android SDK (platform 34 + build-tools 34). On aarch64 it
# ALSO installs qemu-user + amd64 runtime libs and a native arm64 zipalign,
# because Google ships aapt2/zipalign as x86_64-only — see build-apk.sh for how
# the build then runs Google's exact aapt2 under emulation (version-perfect for
# AGP 8.5, which Debian's own aapt2 is too old for: no `--source-path`).
#
# Run once as root (it apt-installs). Then build with android/build-apk.sh.
# Re-running is safe; already-present pieces are skipped.
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

[ "$(id -u)" = 0 ] || { echo "Run as root (this apt-installs packages)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== base toolchain =="
apt-get update
apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip wget file ca-certificates

ARCH="$(dpkg --print-architecture)"
if [ "$ARCH" = "arm64" ]; then
  echo "== arm64 host: native zipalign + qemu/amd64 runtime for aapt2 =="
  apt-get install -y --no-install-recommends android-sdk-build-tools apksigner
  dpkg --add-architecture amd64
  apt-get update
  apt-get install -y --no-install-recommends qemu-user-static libc6:amd64 libstdc++6:amd64 zlib1g:amd64
fi

echo "== Android SDK (cmdline-tools; sdkmanager is Java, arch-independent) =="
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  tmp="$(mktemp -d)"
  wget -q "$CMDLINE_TOOLS_URL" -O "$tmp/cmdtools.zip"
  unzip -q "$tmp/cmdtools.zip" -d "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi

SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKM" --licenses >/dev/null
"$SDKM" "platforms;android-34" "build-tools;34.0.0"

echo
echo "Setup complete. ANDROID_HOME=$ANDROID_HOME"
echo "Now build with:  android/build-apk.sh"
