# Development

How to build, run, test, and verify each component of **mobile-agent** — the
on-device Claude Code stack: a sideloaded Android shell (`android/`), a Node
broker (`broker/`), and a bundled web UI (`broker/web-ui/`) that the broker
serves and the shell hosts in a WebView.

This file is written for a **fresh clone with no prior context**. Everything
below is verified against the repo. Where a count could drift, it says "run the
command" rather than hardcoding a number.

> Ground truth: the canonical event/command contract lives in
> [`broker/src/protocol.js`](../broker/src/protocol.js); the active-engine /
> switching / resume logic lives in [`broker/src/session.js`](../broker/src/session.js).
> Trust those two files over any prose (including this doc and the READMEs).

---

## Prerequisites

You do **not** need everything for every task. Pick by component:

- **Node.js ≥ 21** and **npm** — for the broker and the UI tooling.
  - **Why 21, not 18:** the test script is `node --test "test/**/*.test.js"`, and that
    glob is expanded by **Node's built-in test-runner glob support, which only exists on
    Node ≥ 21**. On Node 18–20 the `test/**/*.test.js` pattern is passed through
    literally, matches nothing, and the suite silently runs zero tests. `broker/package.json`
    declares `"engines": { "node": ">=21" }` accordingly. (This box runs Node 24 — see below.)
- **git** — required at runtime, not just for cloning. The checkpoints control
  ([`broker/src/controls/checkpoints.js`](../broker/src/controls/checkpoints.js))
  shells out to `git` for non-destructive snapshots and restores, so `git` must
  be on `PATH` whenever the broker runs.
- **Claude Code CLI, logged in on a Max plan** — for the default real engine
  (`--profile claude-max` / the `claude-code` adapter). Not needed for the mock
  engine, tests, or UI screenshots.
- **Codex CLI, logged in** — for the `codex-app-server` profile. The adapter
  uses `codex app-server --stdio`; tests use a fake app-server and do not need
  Codex credentials. On Windows, use `CODEX_BIN` only for unusual installs; the
  adapter already resolves npm-installed Codex shims.
- **Chromium for Playwright** — only for UI screenshots / the `uishot` smoke
  test. Install once with `npx playwright install chromium` (Playwright itself
  is already a broker devDependency).
- **Android SDK + JDK 17** — only for building the Android app. Details under
  [Android app](#android-app).

---

## Broker

The broker is the heart of the system and the one piece that runs identically on
a laptop and the phone. It speaks the canonical protocol over a localhost
WebSocket and serves the web UI over HTTP.

```bash
cd broker
npm install

# Offline demo — no credentials, runs anywhere:
npm run dev            # == node src/index.js --engine mock
# open http://127.0.0.1:8765/

# Real engine (needs the Claude Code CLI logged in on a Max plan):
node src/index.js --profile claude-max

# Codex engine (needs Codex CLI login):
node src/index.js --profile codex-app-server
```

Default bind is `127.0.0.1:8765`. Flags: `--port` `--host` `--profile <id>`
`--engine <id>` `--projects <dir>` `--state <dir>` `--verbose`. Env equivalents:
`BROKER_PORT`, `BROKER_HOST`, `BROKER_PROFILE`, `PROJECTS_DIR`, `STATE_DIR`,
`CLAUDE_BIN`, `CODEX_BIN`, `PERMISSION_MODE` (engine selection is CLI-only via `--engine`). See
[`broker/README.md`](../broker/README.md) for the full protocol surface and
engine table.

### The mock engine

`--engine mock` / `--profile mock` runs a fake harness that emits the exact same
canonical events as the real one — it writes real files into the project dir and
drives the approval flow. The whole stack (protocol, UI, tool cards, diffs,
approvals, widgets) is buildable, testable, and demoable with **zero
credentials** against it. All tests and the UI screenshots run on it.

### Tests

```bash
npm test     # == node --test "test/**/*.test.js"
```

This runs the `node:test` suite (no extra test framework), covering JSONL
buffering, the mock engine, the WS server end-to-end, config managers,
checkpoints/revert, sessions, multisession re-keying, the updater, widgets,
downloads, and more. **Do not trust hardcoded test counts** — verify with:

```bash
rg --files broker/test              # file list
npm test                            # the suite prints "tests N / pass N / fail N"
```

Requires Node ≥ 21 (see Prerequisites — on older Node the glob silently matches
nothing).

### Editing the UI vs restarting the broker

The broker serves `web-ui/` **from disk per request** — there is no build step.

- **UI edits** (`web-ui/app.js`, `managers.js`, `diff.js`, `markdown.js`,
  `styles.css`, `index.html`) show up on a **browser reload** — no restart.
- **Broker edits** (`src/server.js`, anything under `src/engines/`, the rest of
  `src/`) need a **broker restart**.

Note that the **empty state and the live todo list are built in JavaScript**,
not in static HTML — they come from `buildEmptyState()` and `renderTodos()` in
[`web-ui/app.js`](../broker/web-ui/app.js) (around lines 1911 and 1489). If you
are editing those views, edit the JS; you will not find them in `index.html`.

---

## UI verification

Screenshots + a JS-error smoke test.

The web UI renders in a phone WebView/browser and the look matters, so it is
verified visually with Playwright. The same script doubles as a **smoke test**:
it **exits non-zero on any JS console error or page error**, so a green run means
the UI loaded and drove through its states without throwing.

```bash
# one-time: install the browser
npx playwright install chromium

# 1) start a mock broker on the UI port.
# PowerShell / native Windows:
$p = Join-Path $env:TEMP 'uiproj'; $s = Join-Path $env:TEMP 'uistate'
node src/index.js --engine mock --port 8799 --projects $p --state $s

# Bash / Android-proot / macOS / Linux:
node src/index.js --engine mock --port 8799 --projects /tmp/uiproj --state /tmp/uistate

# 2) in another shell, drive + screenshot it:
npm run uishot [prefix]        # == node scripts/uishot.mjs [prefix]
```

Environment variables (see [`broker/scripts/uishot.mjs`](../broker/scripts/uishot.mjs)
for the authoritative flow):

| Var | Default | Meaning |
|---|---|---|
| `UI_URL` | `http://127.0.0.1:8799` | broker the script connects to |
| `SCHEME` | `dark` | set `light` to screenshot light mode |
| `OUT_DIR` | `.uishots` | output dir (gitignored via `broker/.gitignore`) |
| `UISHOT_UPDATE` | unset | set `1` to opt into the real `git pull` Update-panel path |

The script renders at **iPhone 15 Pro size** (393×852 logical, `deviceScaleFactor: 2`,
`isMobile`, `hasTouch`) and walks the UI through, in order: empty state → the
**tab strip** + folder/access pills in the composer → the **folder-switcher
sheet** → the **System tab** (RESOURCES panel: RAM bar, engine list) → the **tab
long-press menu** (rename + colour swatches) → compose (with the fullscreen
expand editor) → send/working/conversation → markdown rendering → bubble action
menus → the managers sheet (Skills / Sessions / Update) → command palette →
terminal → the **HTML microapp widget** (+ view-source) → the **SVG/image inline
viewer** and opening a file as an **editable file tab** → the markdown file
viewer → the **APK build widget**. It screenshots each step into `OUT_DIR` and
prints `CHECK ...` assertions to stdout along the way.

To assess results, **read the PNGs** in `OUT_DIR`; run once with `SCHEME=light`
to check light mode too. A non-zero exit means the UI threw — read the
`*** JS ERRORS ***` block it prints.

---

## Android app

The Kotlin/Jetpack-Compose shell (`android/`) owns the Android plumbing the
broker can't — the foreground service, wake lock, battery-optimization
exemption, proot/broker launch, and Keystore secret injection — and hosts the
web UI in a WebView. Read [`android/README.md`](../android/README.md) for the
WebView↔native bridge and UI architecture.

**Requires JDK 17 + an Android SDK** (platform `android-34`, build-tools). The
Gradle wrapper is committed and pinned to **Gradle 8.9**
(`android/gradle/wrapper/gradle-wrapper.properties`).

```bash
cd android

# 1) point Gradle at your SDK (Android Studio writes this for you):
echo "sdk.dir=/path/to/Android/sdk" > local.properties      # gitignored

# 2) accept SDK licenses once:
<sdk>/cmdline-tools/latest/bin/sdkmanager --licenses

# 3) make sure the self-contained runtime asset is present:
# From the repo root, on a Bash-capable machine:
ARCH=aarch64 bash provisioning/make-runtime.sh

# 4) build the debug APK:
./gradlew :app:assembleDebug    # → app/build/outputs/apk/debug/app-debug.apk (~16 MB)
./gradlew :app:lintDebug        # passes
./gradlew :app:installDebug     # sideload to a connected adb device
```

**Preferred Linux build (incl. arm64):** the repo ships scripts for SDK setup and
APK build/copy. Stage proot first when `assets/proot-aarch64/proot` is absent:

```bash
sudo android/setup-build-tools.sh   # once: JDK 17 + SDK (+ qemu/amd64 libs on arm64)
ARCH=aarch64 bash provisioning/make-runtime.sh
android/build-apk.sh                 # build → refresh dist/app-debug.apk
jar tf dist/app-debug.apk | grep 'assets/proot-aarch64/proot'
```

When building directly on the phone from the app's proot-Debian guest, use the
same setup once, then run:

```bash
android/build-and-offer-apk.sh
```

That builds the self-contained debug APK and copies it to
`/sdcard/Download/mobile-agent-debug.apk`. If Android's `am` tool is visible from
the current shell it also opens the package installer; otherwise open the APK from
Files/Downloads. Current builds also expose **Runtime → App update → Install
exported APK**, which opens that same file through the app's FileProvider. The
debug keystore is stable, so this preserves app data.

On Windows/PowerShell, build only after `proot-aarch64` is already staged (or use
a real Bash/WSL environment to run `make-runtime.sh` first):

```powershell
cd android
.\gradlew.bat :app:assembleDebug
cd ..
Copy-Item -Force android\app\build\outputs\apk\debug\app-debug.apk dist\app-debug.apk
jar tf dist\app-debug.apk | Select-String 'assets/proot-aarch64/proot'
```

**aarch64 (arm64 Linux) gotcha — Android's `aapt2`/`zipalign` are x86_64-only.**
Google does not publish an arm64 `aapt2`, and Debian's own `aapt2` is too old for
AGP 8.5 (it lacks `aapt2 compile --source-path`). So on arm64 the build runs
**Google's exact `aapt2` under `qemu-user`** (version-perfect for AGP) via a tiny
wrapper passed as `-Pandroid.aapt2FromMavenOverride=<dir>/aapt2`, and swaps in the
native **arm64 `zipalign`** (`android-sdk-build-tools` package) over the x86_64 one
in `build-tools/34.0.0`. `build-apk.sh` wires both automatically; `setup-build-tools.sh`
installs `qemu-user-static` + `libc6:amd64`/`libstdc++6:amd64`/`zlib1g:amd64`. (AGP
validates the override path *ends in* `aapt2` and then exec's it, so a shell wrapper
is accepted.) d8/r8/apksigner are JVM tools and need no emulation.

Key build facts (from [`android/app/build.gradle.kts`](../android/app/build.gradle.kts)):

- **`targetSdk = 28`** (intentional). API 29+ forbids `execve()` on files in the
  app's writable data dir (W^X), which would break the **bundled proot + Debian
  guest**. `compileSdk = 34` (Compose needs it; AGP allows target < compile),
  `minSdk = 26`.
- **Build the self-contained APK:** `android/app/src/main/assets/proot-aarch64/proot`
  is mandatory. Stage it with `ARCH=aarch64 bash provisioning/make-runtime.sh` if
  missing, then build with `cd android && ./gradlew :app:assembleDebug` or
  `android/build-apk.sh`. The Gradle `verifyBundledProot` prebuild check fails when
  the asset is missing, because a fresh phone must start on-device provisioning, not
  external-broker mode. `stageBroker` bundles `broker.tar.gz` automatically. The
  Debian rootfs, Node, CLI and broker are provisioned on the device at first launch
  — see [on-device-runtime.md](on-device-runtime.md).
- **Lint disables `ExpiredTargetSdkVersion` and `BatteryLife`** on purpose
  (`disable += setOf("ExpiredTargetSdkVersion", "BatteryLife")`) — both are
  documented, deliberate decisions for a sideloaded app, not oversights.

### External-broker mode (fast UI dev, no on-device runtime)

The app installs and runs against a broker on your computer — the fast way to
exercise the full UI without provisioning the on-device runtime:

1. Run the broker on your computer: `cd ../broker && npm run dev`
2. `adb reverse tcp:8765 tcp:8765`
3. In the app's **Agent** tab, tap **Load agent UI anyway**.

For the real on-device runtime, the APK must contain bundled proot assets and then
auto-provisions on first launch (the rootfs is downloaded). See
[on-device-runtime.md](on-device-runtime.md).

---

## This development machine (Windows)

These are the **concrete values for this specific box**. A fresh clone on another
machine must substitute its own paths/versions — nothing here is required by the
project, it just records what is installed here so you don't have to rediscover
it.

- **OS:** Windows 11. Shell is PowerShell; a Bash tool (Git Bash / POSIX `sh`) is
  also available.
- **Node 24 / npm 11** (verified `v24.13.1` / `11.8.0`) — comfortably past the
  Node ≥ 21 floor, so the broker test suite is expected to run here. If a run
  hangs, inspect lingering `node` processes and rerun the focused test file.
- **JDK 17** installed.
- **Android SDK at `C:/src/androidsdk`** (`ANDROID_HOME`), with platforms
  **android-34/35/36**, build-tools, platform-tools, and cmdline-tools.
- **Gradle is not on `PATH`.** A standalone **Gradle 8.9** lives at
  `C:/src/gradle-dist/gradle-8.9` (matching the committed wrapper). You can use
  either `./gradlew` or that `gradle` directly.
- **Codex CLI:** `codex-cli 0.142.4`; real adapter smoke verified by starting
  `codex-app-server` and sending one prompt.
- **`android/local.properties`** (gitignored) contains exactly:
  ```
  sdk.dir=C:/src/androidsdk
  ```

### Load-bearing limit on this box

The broker **fully runs and tests** here, and the Android APK **builds** here
(`:app:assembleDebug` → `app-debug.apk`, `:app:lintDebug` passes). But **you
cannot run, install, or runtime-test the app on this machine**: there is **no
emulator binary, no system image, and no physical device connected via adb**.
Anything that needs the app actually running — the WebView↔native bridge
behaviors (confirm/alert dialogs, image picker, file export, voice input,
notifications), the soft-keyboard `adjustResize` handling, the foreground
service / proot launch — requires the **user's phone** (or an emulator they
install). Do on-device verification there, not here.
