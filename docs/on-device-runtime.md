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

> See also [on-device-deploy.md](on-device-deploy.md) for the install/provision/update
> *flow*; this doc is the *internals*.

## Launch flow & marker gating

`RuntimeLauncher.launch()` runs a sequence, each step gated by a marker file under
`filesDir/runtime/` so it runs once:

1. **stage proot** out of `assets/proot-<arch>/` (`isProotStaged`).
2. **download + extract** the Debian rootfs (`.rootfs_ok`).
3. **provision** the toolchain — apt + Node 22 + Claude CLI (`.provisioned`).
4. **deliver the broker source** (`.broker_source`).

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
repo, so the in-app Update (`updater.js` → `git pull --ff-only`) works. Falls back
to extracting the bundled `broker.tar.gz` at `/root/agent-broker` when a clone
isn't possible (offline / private repo / no token). `brokerArgv()` runs from
whichever exists. A `GITHUB_TOKEN`/`GIT_TOKEN` secret (injected into the guest env)
is stored as a git credential for private-repo clone+pull; `BROKER_REPO_URL`
overrides the repo.

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
**load-bearing** even though no Kotlin API references them by name: they gate the
guest's access to the `/sdcard` and `/storage` binds (the on-device File Manager /
"file explorer"). Don't remove them as "unused".
