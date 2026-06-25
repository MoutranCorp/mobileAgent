# App assets

## `bootstrap-aarch64.tar.gz` (PLACEHOLDER — not committed)

The app expects a prebuilt **Termux arm64 bootstrap** tarball here, named
`bootstrap-aarch64.tar.<gz|xz|zst>`. It is large and architecture-specific, so
it is **not** committed to git (see `.gitignore`). Produce/obtain it once and
drop it in this folder before building a release that provisions on-device.

How to get it:

1. From the official Termux bootstrap artifacts
   (`termux/termux-packages` → `scripts/setup-android-sdk.sh` builds, or the
   prebuilt `bootstrap-aarch64.zip` from a Termux release), **or**
2. Snapshot a working Termux install's `$PREFIX` (`/data/data/com.termux/files/usr`)
   into a tarball.

`BootstrapManager.extractBootstrap()` extracts it into the app's private
`files/runtime/usr` using the platform `tar`. `targetSdk 28` is what allows the
extracted binaries to be `exec()`-ed from the data dir.

Until this file exists, the app runs in **external-broker mode**: run the broker
on your computer and `adb reverse tcp:8765 tcp:8765`, or use `--engine mock`, and
the WebView UI works fully.

## `scripts/`

On-device shell scripts copied into `files/runtime/scripts` on first run:

- `setup-guest.sh` — provisions the Debian guest + Node toolchain + broker.
- `run-broker.sh`  — starts the broker inside the guest.
