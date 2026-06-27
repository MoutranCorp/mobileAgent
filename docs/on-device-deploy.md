# On-device deploy — running the whole stack on a Pixel

This doc is for a Claude Code agent (or human) landing in a **fresh clone** with no
prior context. It explains how to get mobile-agent running on an actual Pixel and
gives an **honest list of where the "pure sideload" path is still broken in code**.

## The goal: a fully on-device loop

The point of this project is that the **entire loop runs on the phone**:

```
Termux (F-Droid)  →  proot Debian guest  →  Node broker (127.0.0.1:8765)
                                                   ▲
                          Android app WebView ──────┘  (loads http://127.0.0.1:8765/)
```

Claude Code, the broker, and the web UI all execute *inside* the Debian guest on the
Pixel. The app is just a native Compose shell that hosts the broker's web UI in a
`WebView` and owns the Android plumbing the broker can't (foreground service, wake
lock, battery exemption, proot launch, Keystore secret injection — see
[`../android/README.md`](../android/README.md)).

> **External-broker mode is a degraded fallback, not the default.** You *can* run the
> broker on a PC and bridge it with `adb reverse tcp:8765 tcp:8765` (see
> [First run, external-broker mode](#fallback-external-broker-mode) below). Only reach
> for that when the on-device proot runtime isn't provisioned yet. The on-device
> localhost loop is the core goal; lead with it.

## Manual provisioning — the happy path

The provisioning scripts live in [`../provisioning`](../provisioning) and are the
**only path that actually installs a working broker today** (see
[Known gaps](#known-gaps-the-pure-sideload-path-is-incomplete)). They run on the
phone, inside Termux → Debian.

### 0. Install Termux from F-Droid

Install Termux from **F-Droid**, **not** the Play Store. The Play Store build is
deprecated and its package manager won't behave. `phase0-termux.sh` checks `$PREFIX`
to confirm it's running inside Termux.

### 1. Get the repo into Termux

```bash
pkg install -y git
git clone <this-repo-url> ~/mobile-agent      # or `adb push` the folder to ~/mobile-agent
```

The **clone location matters**: the scripts assume `~/mobile-agent`.
`phase0-termux.sh` stages a copy of the repo into the Debian guest at
`~/mobile-agent-src`, and `provision-debian.sh` defaults its broker source to
`~/mobile-agent-src/broker` (the `BROKER_SRC` env var). Clone elsewhere and you must
set `BROKER_SRC`/`BROKER_REPO` by hand.

### 2. Phase 0 (Termux side) — install proot + Debian

```bash
bash ~/mobile-agent/provisioning/phase0-termux.sh
```

What it does ([`phase0-termux.sh`](../provisioning/phase0-termux.sh)):
- `pkg update`/`upgrade`, installs `proot-distro git curl`.
- `proot-distro install debian` (skips if already installed).
- Copies the whole repo to `<guest>/root/mobile-agent-src` and the `provisioning/`
  dir to `<guest>/root/provisioning` (so the next scripts are reachable as
  `~/provisioning/*.sh` inside Debian).

### 3. Phase 0 (Debian side) — THE GATE

```bash
proot-distro login debian
bash ~/provisioning/phase0-debian.sh
```

This is the **viability gate** ([`phase0-debian.sh`](../provisioning/phase0-debian.sh)).
It installs `nodejs npm git curl` + the Claude Code CLI
(`@anthropic-ai/claude-code`), then **pauses for the one manual step**:

```bash
claude        # then type:  /login
```

Claude Code authenticates against your **Max subscription** via an OAuth
browser round-trip that can't be scripted. Open the printed URL on the phone,
authorize, paste the code back. After that the `claude-max` profile uses the flat
subscription — no metered API billing.

It then runs three smoke tests: (1) Claude headless `--output-format stream-json`,
(2) `create-expo-app` scaffold, (3) Metro on `127.0.0.1:8081` for a same-phone dev
client. Do **not** start building anything else until this passes.

### 4. Phase 2 — provision the broker

```bash
bash ~/provisioning/provision-debian.sh
```

What it does ([`provision-debian.sh`](../provisioning/provision-debian.sh)):
- Re-ensures the toolchain + Claude CLI; installs `gh` (optional, for the "Create PR"
  feature — push works without it).
- **Installs the broker** into `~/agent-broker`: copies from `$BROKER_SRC`
  (default `~/mobile-agent-src/broker`), else clones `$BROKER_REPO`, else uses an
  existing `~/agent-broker`, else `die`s.
- `npm install --omit=dev` in the broker; `mkdir -p ~/projects`.
- Boots the broker for 3s with the mock engine and greps the log for `Web UI` to
  confirm it starts.

### 5. Run the broker

There are **two layouts**, depending on how the broker got onto the phone — use the
launcher that matches yours:

**A) You cloned the whole repo and run it in place** (e.g. `git clone … ~/mobileAgent`).
This is the common case if you didn't run `provision-debian.sh`. Use the repo-root
launcher — it resolves the broker **relative to itself**, so the path can't drift:

```bash
bash ~/mobileAgent/start-broker.sh                 # default PROFILE=claude-max
PROFILE=mock bash ~/mobileAgent/start-broker.sh    # offline demo, no /login needed
```

[`start-broker.sh`](../start-broker.sh) `cd`s into `<repo>/broker` and runs
`node src/index.js --profile $PROFILE --port $PORT --projects $PROJECTS --verbose`.
**There is no `~/agent-broker` and no `~/provisioning/` in this layout** — run the
broker from the repo. This is also the **relaunch command after a Termux reset /
reboot / crash**.

**B) You ran `provision-debian.sh`**, which installed a *copy* of the broker to
`~/agent-broker` and dropped the provisioning scripts at `~/provisioning/`:

```bash
bash ~/provisioning/run-broker.sh                  # default PROFILE=claude-max
PROFILE=mock bash ~/provisioning/run-broker.sh     # offline demo, no /login needed
```

[`run-broker.sh`](../provisioning/run-broker.sh) `exec`s
`node ~/agent-broker/src/index.js --profile $PROFILE --port $PORT --projects ~/projects --verbose`.

Both launchers honor `PROFILE` (default `claude-max`), `PORT` (default `8765`), and set
`WATCHMAN_DISABLE`/`EXPO_NO_TELEMETRY`. The broker CLI also accepts `--host`, `--engine`,
and `--state` — see the header of `broker/src/index.js`. To keep it alive after closing
the terminal: `nohup bash ~/mobileAgent/start-broker.sh > ~/broker.log 2>&1 &`.

Open **`http://127.0.0.1:8765/`** in a phone browser, or launch the app (its WebView
auto-loads that URL). Projects live in `~/projects`; `git push` them routinely so they
survive an app reinstall.

## Installing the prebuilt APK

A prebuilt debug APK is committed at [`../dist/app-debug.apk`](../dist/app-debug.apk).
On the phone with USB debugging on:

```bash
adb install dist/app-debug.apk
```

(This `adb install` line is currently **missing from
[`../dist/README.md`](../dist/README.md)** — add it there.) To rebuild:
`cd ../android && ./gradlew assembleDebug` (needs JDK 17 + Android SDK
`android-34`; see [`../android/README.md`](../android/README.md)).

On the device, you'll need:
- **Settings ▸ Developer options ▸ USB debugging** enabled (for `adb`), or
- **Install from unknown sources** allowed for your file manager if you copy the APK
  over manually.

Expect a one-time **"built for an older version of Android"** prompt on install. This
is **expected and intentional**: the app sets `targetSdk 28` on purpose, because API
29+ forbids `execve()` on files in the app's writable data dir (W^X), which would
block the bundled Termux bootstrap + proot from launching. Tap through it.

<a name="fallback-external-broker-mode"></a>
### Fallback: external-broker mode

The APK installs and runs with **no bootstrap present**, in external-broker mode.
This is the degraded fallback — useful for trying the UI before provisioning:

1. Run the broker on your computer: `cd ../broker && npm run dev` (or `--engine mock`).
2. `adb reverse tcp:8765 tcp:8765`.
3. In the app's **Agent** tab, tap **Load agent UI anyway**.

## Known gaps (the pure-sideload path is incomplete)

These are **real code gaps**, not just doc staleness. Today, the only way to a working
on-device broker is the **manual `provision-debian.sh` path above**. The app's own
"install and provision itself" flow does not yet work end-to-end. TODOs for a future
agent:

1. **`setup-guest.sh` never delivers the broker.** The app ships
   [`../android/app/src/main/assets/scripts/setup-guest.sh`](../android/app/src/main/assets/scripts/setup-guest.sh)
   and runs it via `RuntimeLauncher`. But when `~/agent-broker` is absent it only
   **logs** `place the broker at ~/agent-broker (git clone or copy)` and exits — it
   never clones or copies anything. Meanwhile `RuntimeLauncher.kt` (line ~83) launches
   `node $HOME/agent-broker/src/index.js`, which then **fails** because the directory
   is empty. Only the manual `provision-debian.sh` (which copies from `$BROKER_SRC`)
   actually populates `~/agent-broker`. **Fix:** teach `setup-guest.sh` to fetch the
   broker (clone a repo URL or extract a bundled copy), mirroring `provision-debian.sh`.
   (`setup-guest.sh` now at least **fails loudly** if `proot-distro` couldn't be
   installed — previously `pkg ... || true` masked it and the failure surfaced later
   as a cryptic `proot-distro: not found` — but it still does not deliver the broker.)

2. **The bootstrap tarball is missing and unreproducible.** The app expects a Termux
   arm64 bootstrap at `android/app/src/main/assets/bootstrap-aarch64.tar.{gz,xz,zst}`,
   extracted by `BootstrapManager.extractBootstrap()`. It is **gitignored**
   (`android/app/src/main/assets/bootstrap-*.tar.*` in both `.gitignore` and
   `android/.gitignore`) and there is **no committed recipe/script** to build one — only
   prose hand-waving in
   [`../android/app/src/main/assets/README.md`](../android/app/src/main/assets/README.md)
   ("obtain from termux/termux-packages, or snapshot a working `$PREFIX`"). Without this
   tarball the app can only run in external-broker mode. **Fix:** commit a reproducible
   `make-bootstrap` script (or document an exact, pinned source) and wire it into a
   release build.

3. **The phase-0 gate can report success on failure.** In
   [`phase0-debian.sh`](../provisioning/phase0-debian.sh) the smoke tests use
   `... || warn`, so a failed Claude `stream-json` / auth check only prints a yellow
   warning and the script **continues to its green "gate scripted" / success message**.
   `phase0-termux.sh` likewise `|| warn`s its `pkg update`. So "the gate passed" is not
   a trustworthy signal — read the actual test output. **Fix:** make the
   auth/stream-json smoke test failure hard-fail (non-zero exit) so the gate truly gates.

## Reference: where the truth lives

- Broker protocol + session behavior are **ground truth** over any prose:
  `broker/src/protocol.js`, `broker/src/session.js`. The broker CLI flags are
  documented in the header of `broker/src/index.js`.
- Don't trust hardcoded test counts in older docs. Verify by running `npm test` in
  `broker/` (there are currently 21 `*.test.js` files under `broker/test/` — but run it
  rather than trusting this number).
