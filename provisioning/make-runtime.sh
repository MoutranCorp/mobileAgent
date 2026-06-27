#!/usr/bin/env bash
#
# make-runtime.sh — stage the native bits the self-contained app needs (option 1:
# proot + Debian, NO Termux). Produces, under android assets:
#   proot-<arch>/proot           the proot tracer binary
#   proot-<arch>/lib/*.so         its shared-lib deps (libtalloc, …)
#
# proot runs ON Android (host) and uses ptrace to give the bundled Debian rootfs a
# fake root + path binds — none of the Termux-prefix coupling that blocked the
# stock-bootstrap approach. The Debian rootfs itself is DOWNLOADED on first launch
# (see RuntimeLauncher), so it isn't staged here.
#
# Run once (any Linux box with curl/ar/tar/xz) when bumping proot. Artifacts are
# gitignored.
#
# Env: ARCH (aarch64|arm|x86_64|i686), PROOT_DEB_URL (override)
set -euo pipefail

ARCH="${ARCH:-aarch64}"
REPO="${TERMUX_REPO:-https://packages.termux.dev/apt/termux-main}"
# proot + its runtime libs are separate Termux packages. libc.so resolves to
# Android's own Bionic at runtime (proot uses only standard symbols), so we bundle
# proot + libtalloc + libandroid-shmem and run under LD_LIBRARY_PATH.
PROOT_DEB="${PROOT_DEB:-pool/main/p/proot/proot_5.1.107.81_${ARCH}.deb}"
TALLOC_DEB="${TALLOC_DEB:-pool/main/libt/libtalloc/libtalloc_2.4.3_${ARCH}.deb}"
SHMEM_DEB="${SHMEM_DEB:-pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_${ARCH}.deb}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/android/app/src/main/assets/proot-${ARCH}}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ need '$1'" >&2; exit 1; }; }
need curl; need ar; need tar; need xz

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/root"

# Download + unpack a .deb's data tarball into $work/root (handles .xz/.gz/.zst).
unpack_deb() {
  local rel="$1" name; name="$(basename "$rel")"
  echo "→ $name"
  curl -fL --retry 3 -o "$work/$name" "$REPO/$rel"
  ( cd "$work" && ar x "$name" )
  local data; data=$(ls "$work"/data.tar.* 2>/dev/null | head -1)
  case "$data" in
    *.xz)  tar -xJf "$data" -C "$work/root" ;;
    *.gz)  tar -xzf "$data" -C "$work/root" ;;
    *.zst) tar --zstd -xf "$data" -C "$work/root" ;;
    *)     tar -xf "$data" -C "$work/root" ;;
  esac
  rm -f "$work"/data.tar.* "$work"/control.tar.* "$work"/debian-binary
}

unpack_deb "$PROOT_DEB"
unpack_deb "$TALLOC_DEB"
unpack_deb "$SHMEM_DEB"

proot_bin=$(find "$work/root" -type f -name proot | head -1)
[ -n "$proot_bin" ] || { echo "✗ proot binary not found in .deb" >&2; exit 1; }

rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR/lib" "$OUT_DIR/libexec/proot"
cp "$proot_bin" "$OUT_DIR/proot"; chmod +x "$OUT_DIR/proot"

# proot needs its loader helper(s) (PROOT_LOADER) — without them it can't set up
# the ptrace sandbox.
for ldr in loader loader32; do
  found=$(find "$work/root" -path "*/libexec/proot/$ldr" | head -1)
  [ -n "$found" ] && { cp "$found" "$OUT_DIR/libexec/proot/$ldr"; chmod +x "$OUT_DIR/libexec/proot/$ldr"; echo "  loader: $ldr"; }
done

# Copy proot's NEEDED libs (except libc.so → Android Bionic) out of the unpacked
# .debs. The lib filename inside Termux pkgs matches the SONAME.
for need_lib in $(readelf -d "$proot_bin" 2>/dev/null | awk -F'[][]' '/NEEDED/{print $2}'); do
  [ "$need_lib" = "libc.so" ] && continue
  found=$(find "$work/root" -name "$need_lib" | head -1)
  if [ -n "$found" ]; then cp -L "$found" "$OUT_DIR/lib/$need_lib"; echo "  lib: $need_lib"; else echo "  ⚠ missing: $need_lib"; fi
done

echo "✓ staged proot -> $OUT_DIR"
readelf -d "$OUT_DIR/proot" 2>/dev/null | awk -F'[][]' '/NEEDED/{print "    needs "$2}'
ls -la "$OUT_DIR" "$OUT_DIR/lib"
