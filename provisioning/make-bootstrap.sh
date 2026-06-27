#!/usr/bin/env bash
#
# make-bootstrap.sh — produce the Termux userland tarball the APK bundles.
#
# The app's BootstrapManager.extractBootstrap() expects a GZIP tar at
# android/app/src/main/assets/bootstrap-<arch>.tar.gz (it can NOT decompress the
# .xz/.zst that Termux ships natively, and a .zip can't carry symlinks). This
# script converts the official Termux bootstrap into that exact format:
#
#   1. download the official bootstrap-<arch>.zip from termux/termux-packages,
#   2. unzip it,
#   3. recreate the symlinks listed in SYMLINKS.txt (zip can't store symlinks),
#   4. repackage the tree as a .tar.gz (with real symlinks) into the APK assets.
#
# This is the AUTO-PROVISION route: the bootstrap is just the Termux base (apt/pkg).
# proot-distro + Debian + the toolchain are installed by setup-guest.sh on first
# launch (needs network, one-time). Run this ONCE (on any machine with curl+unzip)
# whenever you want to refresh the bundled userland; the tarball is gitignored.
#
# Env:
#   ARCH           aarch64 (default) | arm | x86_64 | i686
#   BOOTSTRAP_URL  override the download URL entirely (else a pinned release below)
#   BOOTSTRAP_TAG  termux-packages release tag (default: the pinned one below)
#   OUT_DIR        where to write the tarball (default: the APK assets dir)
set -euo pipefail

ARCH="${ARCH:-aarch64}"
# Pin a known release for reproducibility; override BOOTSTRAP_TAG/URL to bump it.
# (Find newer tags at https://github.com/termux/termux-packages/releases — filter
# 'bootstrap'.) The '+' in the tag must be %2B-encoded in the download URL.
BOOTSTRAP_TAG="${BOOTSTRAP_TAG:-bootstrap-2026.06.21-r1+apt.android-7}"
TAG_ENC="${BOOTSTRAP_TAG//+/%2B}"
DEFAULT_URL="https://github.com/termux/termux-packages/releases/download/${TAG_ENC}/bootstrap-${ARCH}.zip"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-$DEFAULT_URL}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/android/app/src/main/assets}"
OUT="$OUT_DIR/bootstrap-${ARCH}.tar.gz"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ need '$1' on PATH" >&2; exit 1; }; }
need curl; need unzip; need tar

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
zip="$work/bootstrap.zip"
root="$work/root"
mkdir -p "$root"

echo "→ downloading $BOOTSTRAP_URL"
curl -fL --retry 3 -o "$zip" "$BOOTSTRAP_URL" || {
  echo "✗ download failed. Bump BOOTSTRAP_TAG to a tag that exists at" >&2
  echo "  https://github.com/termux/termux-packages/releases  (filter: 'bootstrap')," >&2
  echo "  or set BOOTSTRAP_URL directly." >&2
  exit 1
}

echo "→ unzipping"
unzip -q "$zip" -d "$root"

# Recreate symlinks. SYMLINKS.txt lines are '<target>←<linkpath>' (U+2190 sep).
if [ -f "$root/SYMLINKS.txt" ]; then
  echo "→ recreating symlinks from SYMLINKS.txt"
  count=0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    target="${line%%←*}"
    link="${line#*←}"
    [ -z "$link" ] && continue
    mkdir -p "$root/$(dirname "$link")"
    ln -sf "$target" "$root/$link"
    count=$((count + 1))
  done < "$root/SYMLINKS.txt"
  rm -f "$root/SYMLINKS.txt"
  echo "  ($count symlinks)"
fi

mkdir -p "$OUT_DIR"
echo "→ packing $OUT"
# Pack the CONTENTS at the archive root (so it extracts straight into $PREFIX);
# preserve the symlinks we just recreated.
tar czf "$OUT" -C "$root" .

bytes=$(wc -c < "$OUT")
echo "✓ wrote $OUT ($((bytes / 1024 / 1024)) MB)"
echo "  Rebuild the APK to bundle it:  cd android && ./gradlew :app:assembleDebug"
