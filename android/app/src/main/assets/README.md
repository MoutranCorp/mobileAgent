# App assets

Both payloads below are **generated, not committed** (see `android/.gitignore`).
The app is self-contained: a bundled **proot** runs a downloaded Debian guest, and
the broker runs inside it. (No Termux — see
[`service/ProotRuntime.kt`](../java/com/ondevice/agent/service/ProotRuntime.kt).)

## `proot-<arch>/`

The proot tracer binary + its libs + loaders, staged by
[`provisioning/make-runtime.sh`](../../../../../provisioning/make-runtime.sh):

```bash
ARCH=aarch64 bash provisioning/make-runtime.sh   # writes proot-aarch64/ here
```

Consumed by `ProotRuntime.stageProot()`, which copies it into
`files/runtime/proot` and runs it under `LD_LIBRARY_PATH`. `targetSdk 28` is what
allows exec from the app's data dir. The Debian rootfs itself is **downloaded** on
first launch (`ProotRuntime.downloadAndExtractRootfs`), not bundled.

## `broker.tar.gz`

The broker source, tarred from `../broker` by the Gradle `stageBroker` task
(`node_modules` are installed on-device). It's the **offline seed**:
`ProotRuntime.ensureBrokerSource()` prefers a `git clone` of the repo (so the in-app
Update / `git pull` works) and falls back to extracting this tarball when a clone
isn't possible.

> **aapt2 gunzips `.gz` assets at package time and strips the suffix**, so this
> ships in the APK as `broker.tar` (plain). The code matches by prefix — don't
> "fix" the name to add `.gz` back.

If no bundled proot is present the app falls back to **external-broker mode**: run
the broker on a computer + `adb reverse tcp:8765 tcp:8765`, or `--engine mock`.
