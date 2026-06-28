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

## Self-contained APK: provisioning & updating (the current default)

The sideloaded APK now bundles proot + the broker and provisions a Debian guest on
first launch — no Termux, no manual scripts. The flow (in
[`service/ProotRuntime.kt`](../android/app/src/main/java/com/ondevice/agent/service/ProotRuntime.kt),
driven by [`RuntimeLauncher.kt`](../android/app/src/main/java/com/ondevice/agent/service/RuntimeLauncher.kt)),
each step gated by its own marker so it runs once:

1. **stage proot** out of `assets/proot-<arch>/`,
2. **download + extract** the Debian rootfs (`.rootfs_ok`, version `ROOTFS_VERSION`),
3. **provision the toolchain** — apt + Node 22 + Claude CLI (`.provisioned`),
4. **deliver the broker source** (`.broker_source`, version `BROKER_SOURCE_VERSION`).

**Updating the broker / UI = the in-app Update.** Step 4 delivers the broker as a real
**`git clone --depth 1`** at `/root/mobileAgent` (broker runs from
`/root/mobileAgent/broker`), so the Manage → Update panel works: web-ui changes apply
on a browser reload, `broker/src` changes need a Stop+Start (Runtime tab). The clone
is **shallow**, so Update uses `git fetch --depth=1 origin <branch>` + `git reset
--hard FETCH_HEAD` (NOT `git pull` — which on a shallow clone fails with "did not send
all necessary objects" and can corrupt the object store); if the fetch fails it
**re-clones fresh**. Bumping `BROKER_SOURCE_VERSION` re-runs *only* step 4, migrating an
existing bundled install to a clone without re-downloading the rootfs or re-running apt.

**Manual recovery if the clone is corrupt** ("`fatal: bad object …`" / "did not send
all necessary objects" from a `git pull` interrupted mid-fetch) — in the in-app
Terminal: `cd /root/mobileAgent && git fetch --depth=1 origin main && git reset --hard
FETCH_HEAD`; if that still errors, re-clone: `cd /root && git clone --depth 1
<repo-url> mobileAgent.new && rm -rf mobileAgent && mv mobileAgent.new mobileAgent`,
then Stop & Start the runtime. The clone holds no user data (projects + sessions live
outside it).

- **Private repo:** set a `GITHUB_TOKEN` (or `GIT_TOKEN`) secret in the Runtime tab. It's
  injected into the guest env and stored as a git credential (`/root/.git-credentials`,
  chmod 600) so both the clone and later pulls authenticate. Override the repo with a
  `BROKER_REPO_URL` secret.
- **Offline / no token:** the clone falls back to the bundled tarball at
  `/root/agent-broker`; the app still runs, but in-app Update stays inert until a clone
  succeeds. (To force a fresh self-contained build instead, install a new APK — but note
  delivery is marker-gated, so bump `BROKER_SOURCE_VERSION` to make a reinstall re-deliver.)

**Updating the native app (new APK) = install OVER the existing app — do NOT
uninstall.** All runtime state (the proot rootfs, Node, the `claude` CLI, projects,
sessions, Claude login) lives in the app's internal storage, which Android **wipes on
uninstall**. A new APK only installs over the old one when both share a signing key —
so the repo commits a fixed `android/debug.keystore` wired via `signingConfigs.debug`,
giving every build one identity. Build, then `adb install -r` (or tap the APK) to
update in place with zero data loss. (Adopting the committed key the first time needs
one final uninstall+reinstall, since the previously-installed app used an ephemeral key.)

**Backup / restore (survives a true uninstall).** `broker/src/controls/backup.js`
mirrors projects + the broker state dir (sessions/transcripts/settings) +
`~/.claude/.credentials.json` to `/sdcard/MobileAgentBackup` (shared storage isn't
wiped on uninstall; it's bind-mounted into the guest). On a fresh install the broker
**auto-restores** on startup *only when the live data is empty* (non-destructive);
it also backs up every `BACKUP_INTERVAL_MIN` (default 30) and on demand via Manage →
System → **Back up now**. The rootfs/toolchain still re-provisions (it can't live on
the FUSE sdcard), but work + login come back.

The script-based path below is the **dev/manual fallback** (and the repo-clone +
`start-broker.sh` workflow), not the default.

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
block the bundled **proot** (and its Debian guest) from launching. Tap through it.

<a name="fallback-external-broker-mode"></a>
### Fallback: external-broker mode

If **no bootstrap is bundled**, the APK runs in external-broker mode. This is the
degraded fallback — useful for trying the UI before provisioning:

1. Run the broker on your computer: `cd ../broker && npm run dev` (or `--engine mock`).
2. `adb reverse tcp:8765 tcp:8765`.
3. In the app's **Agent** tab, tap **Load agent UI anyway**.

<a name="self-contained-auto-provision"></a>
## Self-contained install (auto-provision — no separate Termux)

This is the current default — the build + auto-provision + update flow is documented
in [Self-contained APK: provisioning & updating](#self-contained-apk-provisioning--updating-the-current-default)
at the top. In short:

1. Stage proot once (any Linux box): `ARCH=aarch64 bash provisioning/make-runtime.sh`
   → `android/app/src/main/assets/proot-<arch>/`. The broker is staged automatically
   by the Gradle `stageBroker` task.
2. `cd android && ./gradlew :app:assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`.
3. Install + open → **Start runtime**. First launch downloads the Debian rootfs and
   installs the toolchain + broker (minutes, one-time); later launches just start it.
4. Sign in via the **Runtime tab → Sign in to Claude** (native `claude setup-token`).

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
