# On-device runtime — the proot/Debian/WebView mechanics (hard-won)

This documents the **non-obvious, load-bearing** mechanisms in the Android app's
self-contained runtime. They were each discovered the hard way on real devices;
the rationale lives here so a new agent doesn't re-break them. The code is the
ground truth — this explains the *why*. Key files:

- [`service/ProotRuntime.kt`](../android/app/src/main/java/com/ondevice/agent/service/ProotRuntime.kt) — proot staging, rootfs download/extract, provision, broker delivery, the proot command construction.
- [`service/RuntimeLauncher.kt`](../android/app/src/main/java/com/ondevice/agent/service/RuntimeLauncher.kt) — orchestrates the launch flow + stops the broker.
- [`service/ClaudeLogin.kt`](../android/app/src/main/java/com/ondevice/agent/service/ClaudeLogin.kt) — native `claude setup-token` sign-in.
- [`service/ClaudeUpdate.kt`](../android/app/src/main/java/com/ondevice/agent/service/ClaudeUpdate.kt) — native `claude update` (Runtime-screen widget).
- [`ui/AgentWebView.kt`](../android/app/src/main/java/com/ondevice/agent/ui/AgentWebView.kt) + [`RuntimeConfig.kt`](../android/app/src/main/java/com/ondevice/agent/RuntimeConfig.kt) — the WebView host.

Additional key files for Codex runtime support:

- [`service/CodexLogin.kt`](../android/app/src/main/java/com/ondevice/agent/service/CodexLogin.kt) - native `codex login` sign-in.
- [`service/CodexUpdate.kt`](../android/app/src/main/java/com/ondevice/agent/service/CodexUpdate.kt) - native Codex CLI install/update (Runtime-screen widget).

> See also [on-device-deploy.md](on-device-deploy.md) for the install/provision/update
> *flow*; this doc is the *internals*.

## Launch flow & marker gating

`RuntimeLauncher.launch()` runs a sequence, each step gated by a marker file under
`filesDir/runtime/` so it runs once:

1. **stage proot** out of `assets/proot-<arch>/` (`isProotStaged`).
2. **download + extract** the Debian rootfs (`.rootfs_ok`).
3. **provision** the toolchain — apt + Node 22 + Claude CLI + Codex CLI (`.provisioned`).
4. **deliver the broker source** (`.broker_source`).

The provision step installs both `@anthropic-ai/claude-code` and `@openai/codex`
for fresh environments. Existing already-provisioned environments skip this
one-time marker-gated step; use the Runtime screen's Codex install/update action
to backfill Codex into those guests.

Two of these markers are **version-stamped** (companion `const`s in ProotRuntime):
`ROOTFS_VERSION` and `BROKER_SOURCE_VERSION`. `isRootfsReady()`/`isBrokerSourceReady()`
require the marker's content to equal the current version. **Bump the relevant
constant whenever you change extraction or broker-delivery logic** — app data
survives an install-over, so without a bump an existing device keeps its stale
rootfs / bundled broker. Bumping re-runs *only* that step (no full re-provision).

## Rootfs extraction: pure-Java, hardlinks → relative symlinks

`downloadAndExtractRootfs` / `extractTarXz` extract the linuxcontainers Debian
`.tar.xz` **in pure Java** (commons-compress + xz), NOT via system/toybox tar.
Reasons, all of which will bite a naive rewrite:

- **Android blocks `link(2)` in app storage** → a real tar dies on the many
  hardlinked binaries (perl, coreutils). We convert every **hardlink → a relative
  symlink** to the target within the rootfs.
- toybox tar can't do `.xz`.
- Path-traversal guard is **lexical** (reject any `..` component) — do NOT use
  `canonicalPath`, it resolves symlinks and would drop legit absolute symlinks
  (systemd masks → `/dev/null`, `alternatives`, `/usr/sbin/ip`).
- Device nodes are skipped (the image has none; containers get `/dev` from runtime).

## proot configuration (the part that fights libc/apt)

`prootHostBase()` + `applyEnv()` + `guestBinds()`:

- **Seccomp stays ON.** Do NOT set `PROOT_NO_SECCOMP`. Disabling it forces proot to
  ptrace-emulate every syscall and returned `ENOSYS` for some reads (notably
  `/proc/sys/crypto/fips_enabled`), which **crashes libgcrypt → apt aborts**.
  proot-distro runs with seccomp on; so do we. (There is no `--no-seccomp` CLI flag
  in proot 5.1.107 anyway.)
- **Fake `/proc` binds.** Android's kernel doesn't expose some `/proc` entries; bind
  fakes over them (after the broad `/proc` bind so they win): `fips_enabled` (the
  critical one — libgcrypt FATALs on its absence), plus `cap_last_cap`, `loadavg`,
  `stat`, `uptime`, `version`, `vmstat` (mirrors proot-distro). Without
  `fips_enabled`, apt-key/gpgv and apt's http hash check both abort with SIGABRT.
- **apt sandbox off.** apt's download method drops privileges to `_apt` via
  `setresuid(2)`, which proot can't honor → "Operation not permitted". We write
  `/etc/apt/apt.conf.d/99proot` (`APT::Sandbox::User "root"`) AND pass
  `-o APT::Sandbox::User=root` on every `apt-get` (belt-and-suspenders).
- **resolv.conf** is written per-config; each guest-config write is independent
  (the image's `/etc/resolv.conf` is a dangling symlink — a shared try/catch would
  let it abort the apt-config write).

## Broker delivery as a git clone (enables in-app Update)

`ensureBrokerSource()` `git clone`s the repo to `/root/mobileAgent` and runs the
broker from `/root/mobileAgent/broker` — a **real checkout** whose toplevel is the
repo, so the in-app Update (`updater.js` → shallow `git fetch` + `git reset --hard`,
re-clone on corruption) works. Falls back
to extracting the bundled `broker.tar.gz` at `/root/agent-broker` when a clone
isn't possible (offline / private repo / no token). `brokerArgv()` runs from
whichever exists. During the Codex profile migration the clone is also validated
for the profile backfill code; if the remote checkout is older than the APK
bundle, the bundled broker is used and the stale `/root/mobileAgent` checkout is
removed from the launch path. A `GITHUB_TOKEN`/`GIT_TOKEN` secret (injected into
the guest env) is stored as a git credential for private-repo clone+pull;
`BROKER_REPO_URL` overrides the repo.

## Native Claude sign-in (`ClaudeLogin.kt`)

`claude setup-token` is an interactive `ink` TUI. To drive it headlessly:

- Run it under a **real PTY** via util-linux `script -qec '…' /dev/null`. Over a
  plain pipe it block-buffers stdout (the URL never prints) and won't take input.
- **Widen the PTY** (`stty cols 400`) so the long OAuth URL isn't line-wrapped.
- **Strip ANSI** from output before regex-matching the URL/token (spinner + cursor
  control would split them).
- Submit the code as **the code, then a separate `\r` after a short delay**. In a
  PTY, Enter is **carriage return (`\r`)**, not `\n`; and ink treats a fast burst as
  a bracketed *paste*, absorbing a trailing `\r` as literal text — so the code
  echoes (masked) but never submits. A distinct, delayed CR registers as Enter.
- **Credentials file is authoritative.** `setup-token` writes
  `/root/.claude/.credentials.json`; on success we *clear* any
  `CLAUDE_CODE_OAUTH_TOKEN` Keystore secret so a stale env token can't override the
  file. The broker side mirrors this — see "auth precedence" in
  [claude-cli-behaviors.md](claude-cli-behaviors.md).

## Native Claude Code update (`ClaudeUpdate.kt`)

A "Claude Code" section on the Runtime screen runs the CLI's built-in
`claude update` in the guest (same `script -qec` PTY + ANSI-strip pattern as sign-in)
and reports the installed version (`claude --version`). It's in the APK, not the web
UI, on purpose: it's a runtime action (available before the broker is up) that
updates the very binary the broker spawns. A refreshed CLI takes effect on **new**
agent sessions; live engines keep the binary they launched with, so Stop & Start the
runtime to move every session onto it. Output streams to the runtime log.

## Native Codex sign-in/update (`CodexLogin.kt`, `CodexUpdate.kt`)

Codex auth is separate from Claude auth and lives under `/root/.codex` inside the
guest. The Runtime screen drives the CLI directly:

- `codex login --device-auth` runs in a PTY (`script -qec`) so browser-device
  auth output is visible and the user can open the sign-in URL in a real browser.
- `codex login --with-api-key` is the API-key fallback; the key is written to the
  process stdin and then discarded by the app. Codex persists its own auth file
  in the guest.
- `codex login status` powers the signed-in display.
- `npm install -g @openai/codex` installs or updates the CLI. This is deliberate:
  it also migrates existing already-provisioned installs whose original
  `.provisioned` step ran before Codex was added.
- `codex --version` powers the installed-version display.

The broker's `codex-app-server` profile spawns `codex app-server --stdio` from
that same guest home, so new Codex sessions use the credentials/update written
by these native controls.

## Native GitHub sign-in (`GitHubAuth.kt`)

A "GitHub" section on the Runtime screen authenticates the on-device git so the
agent can push/pull/merge your repos (incl. private). Two methods, both native:
- **Device flow** — POST `https://github.com/login/device/code` (scope `repo`),
  show the `user_code` + open `github.com/login/device`, poll
  `login/oauth/access_token` until authorized. Needs an OAuth App **Client ID**
  (stored in plain `SharedPreferences`; no client secret in device flow).
- **Personal access token** — validate a pasted token via `GET /user`.

The token is stored in the **Keystore** as `GITHUB_TOKEN` + `GH_TOKEN` (so
`ProotRuntime.prootGuest` injects it into the guest env for the broker → claude →
git, *and* the `gh` CLI), plus `GITHUB_USER`/`GITHUB_EMAIL` for commit identity.
The token is **never written to a file**: `applyGitConfig` points git at the env
via a per-host credential helper —
`credential.https://github.com.helper = '!f() { echo username=$GITHUB_USER; echo password=$GITHUB_TOKEN; }; f'`
(the `$VARS` stay literal in `.gitconfig` and expand at git-run time). The same
`prootGuest` secret-injection that powers provider tokens is the delivery path, so
no broker change is needed — but a sign-in while the runtime is RUNNING needs a
Stop+Start to pick up the new env (same as Claude sign-in). `ensureGitConfig` is
called from `RuntimeLauncher.launch()` to re-apply the gitconfig if the rootfs lost
it (env reset) while the token secret survived; it's gated on a host-side
`.gitconfig` check so it costs nothing once configured. Sign-out removes the
secrets and `git config --remove-section`s the helper.

## Native notification bridge (`Notifier.kt`)

Background work that finishes when the app UI is closed (chiefly **scheduled cron
jobs**) still needs to reach the user. The web UI's `notifyIfHidden` only fires
when a WebView/WS is alive, so it can't help once the app is swiped away — but the
**foreground service stays running**, and it already pumps every line of the
broker's output. So the broker speaks to the service over that existing pipe:

- **Broker → marker line.** `server._nativeNotify({title,text,level})` writes one
  line to **stderr**: `@@NATIVE_NOTIFY@@ {json}`. stderr (not stdout) on purpose —
  the test runner's TAP lives on stdout and a stray line corrupts it, while the
  service merges stderr into the stream it reads (`ProcessBuilder.redirectErrorStream(true)`).
  It's **unconditional**, NOT gated behind `--verbose`, so a notification never
  depends on log level. The cron RESULT handler calls it alongside the in-app
  `notify` toast.
- **Service → real notification.** `RuntimeLauncher.pump()` runs each line through
  `Notifier.handleMarkerLine(ctx, line)`; a match is parsed and posted (and **not**
  re-logged as noise). `Notifier` posts on a **distinct, alerting channel**
  (`agent_jobs`, `IMPORTANCE_DEFAULT`) — separate from the silent `IMPORTANCE_LOW`
  "Agent runtime" ongoing-service channel — with stacking ids (1000–9000) so each
  completion is its own heads-up. `POST_NOTIFICATIONS` is declared in the manifest
  and pre-granted by the `targetSdk 28` install, so there's no runtime-permission flow.

This is broker-emitted but **service-handled**: no part of it touches the WebView,
so it works with the app fully killed. The marker is a plain protocol on the output
stream, not a wire-protocol event — don't confuse it with `protocol.js`.

## WebView gotchas (Compose-hosted `AgentWebView`)

- **Loopback must be HTTP, never HTTPS.** The broker serves plain HTTP; an
  `https://127.0.0.1…` URL fails the TLS handshake (`ERR_SSL_PROTOCOL_ERROR`) and
  renders blank. `RuntimeConfig.brokerUrl()` normalizes loopback https→http, and the
  WebView retries over http on that error.
- **`dvh`/`vh` misresolve to 0** in this Compose-hosted WebView, collapsing
  `#app`/overlays to zero height (a blank page with a *full DOM*). Two-part fix:
  (a) the served CSS uses `calc(N * var(--vh))` with `--vh` driven from
  `innerHeight` by JS; (b) the APK injects (`FIX_AND_PROBE`, applied each load) a
  fitter that pins `html/body/#app` to a concrete `innerHeight` px and sets `--vh`,
  so it works even before the broker is updated. Page errors/load errors are logged
  as `[webui] …` in the runtime log.

## Expo "Test": Metro must bind IPv4, and readiness ≠ /status

The composer **Test** button starts Metro via `DevTools.startMetro` (`controls/devtools.js`)
and deep-links Expo Go. Three device-specific gotchas, all learned the hard way:
- **Metro binds IPv6 `::1` by default here.** `expo start --localhost` binds whatever
  `localhost` resolves to — in the Debian guest that's `::1` — but Expo's manifest
  always advertises `hostUri: 127.0.0.1`. So Expo Go follows the manifest to IPv4
  127.0.0.1, finds nothing, and shows "Something went wrong" (a browser works because
  it uses `localhost`→`::1`). Fix: spawn Metro with
  `NODE_OPTIONS=--dns-result-order=ipv4first` so it binds 127.0.0.1, matching the
  manifest. The `exp://` URL + readiness probe use 127.0.0.1 to match.
- **Readiness isn't `/status`.** Expo's dev server leaves `/status` hanging; probe the
  manifest endpoint (`GET /` + `expo-platform` header) instead, and accept any HTTP
  response as "up" (the probe tries both 127.0.0.1 and ::1 as a safety net).
- **The bundle builds fine in proot** (verified ~4.7 MB / HTTP 200); the failures were
  always the binding, not the toolchain. `_diagnoseExpoManifest`/`_probeBundle` log a
  `[diag]` line (manifest + native-bundle build result) to the terminal to confirm.
- Expo Go also only runs apps whose **Expo SDK** it supports — keep Expo Go updated, or
  pin scaffolded apps to a supported SDK.

## Stopping the broker: signal node directly, not proot

`RuntimeLauncher.stop()` does NOT just kill the proot process. node runs as proot's
**ptrace tracee** under our own UID; SIGKILLing the tracer just detaches and
*orphans* node (it keeps serving — the "Stop does nothing" bug), and proot doesn't
forward SIGTERM here. So we scan `/proc/<pid>/cmdline` for the broker entrypoint
(`…/src/index.js … --port …`) and `Os.kill` it directly (same-UID, so permitted):
SIGTERM first (the broker self-shuts-down with a 3s backstop), then SIGKILL +
force-kill proot.

## Storage permissions

`MANAGE_EXTERNAL_STORAGE` + legacy `READ/WRITE_EXTERNAL_STORAGE` are declared and
**load-bearing**: they gate the guest's access to the `/sdcard` and `/storage` binds
(the on-device File Manager / "file explorer"). The **Runtime screen's "File access"
toggle** (`MainScreen.FileAccessSection`) drives the grant: API ≥ 30 opens
`ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` and reflects
`Environment.isExternalStorageManager()`; API < 30 requests `WRITE_EXTERNAL_STORAGE`
(broad under targetSdk 28). Once granted, the unsandboxed broker FileSystemManager
reads all shared storage through those binds. Don't remove the permissions as "unused".
