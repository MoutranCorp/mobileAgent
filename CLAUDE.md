# CLAUDE.md — agent onboarding for `mobile-agent`

This file is read automatically by Claude Code when it opens this repo. It is the
**single source of truth** for working here: everything an agent needs to be
productive lives in this repo (this file + [`docs/`](docs/)), not in any external
memory. If you change the project, **you are expected to keep these docs current**
— see [Keeping context current](#keeping-context-current) at the bottom.

## What this is

`mobile-agent` puts the **full Claude Code experience on a phone**: a sideloaded
Android app runs a Node "broker" inside Termux/proot-Debian on the device; the
broker drives the `claude` CLI and serves a custom web UI that the app hosts in a
WebView. You build/test Expo apps live on the same Pixel; only native binary
compiles go to EAS cloud. It implements [`ondevice-claude-code-plan.md`](ondevice-claude-code-plan.md).

**Project principle:** the goal is the *fully on-device* loop (broker in
Termux/proot on the phone). Lead with that path; a PC-hosted broker over
`adb reverse` is only a degraded fallback — see [docs/on-device-deploy.md](docs/on-device-deploy.md).

## Repo map

| Path | What it is |
|------|------------|
| `broker/` | **The heart.** Node service: WebSocket + canonical protocol, engine adapters, controls. Builds & tests here. |
| `broker/web-ui/` | The client (vanilla JS, served by the broker from disk). Hosted in the Android WebView. |
| `android/` | Kotlin/Compose shell, `targetSdk 28` (keeps `exec()` from the data dir legal for proot). Foreground service + proot/broker launch (`service/ProotRuntime.kt`), native Claude sign-in (`service/ClaudeLogin.kt`), WebView host (`ui/AgentWebView.kt`). |
| `provisioning/` | Termux → proot Debian → toolchain → broker scripts (Phase 0 gate + Phase 2 provision). |
| `dist/` | Prebuilt `app-debug.apk` for sideloading. |
| `tools/webshot/` | An unrelated on-device website-screenshot **skill** (don't confuse with the UI test harness). |
| `docs/` | Deep context (read these). |

## Documentation index — read what's relevant before working

- [docs/architecture.md](docs/architecture.md) — components, data flow, the **canonical protocol**, the **per-session engine model**, and a code map of `broker/src`.
- [docs/development.md](docs/development.md) — prerequisites + how to build/run/test/verify each component (incl. the UI screenshot harness and this machine's toolchain).
- [docs/features.md](docs/features.md) — the current implemented surface, including the **tabbed-workspace / multi-session** subsystem, plus roadmap/deferred.
- [docs/claude-cli-behaviors.md](docs/claude-cli-behaviors.md) — non-obvious `claude` CLI behaviors the broker depends on (model resolution, init-only scans, no hot-reload).
- [docs/claude-code-surface.md](docs/claude-code-surface.md) — authoritative notes on the Claude Code stream/surface the adapter targets.
- [docs/on-device-deploy.md](docs/on-device-deploy.md) — getting it running on a real Pixel: the self-contained provision/update *flow* + the degraded fallbacks.
- [docs/on-device-runtime.md](docs/on-device-runtime.md) — the **internals** of the Android runtime (proot+Debian, marker versions, hardlink-safe extraction, fake `/proc`/apt/seccomp, git-clone broker delivery, PTY-based Claude sign-in, WebView dvh/http gotchas, node-direct stop). Read this before touching `ProotRuntime`/`ClaudeLogin`/`AgentWebView`.

## Quickstart (no phone, no credentials)

```bash
cd broker
npm install
npm run dev            # mock engine + web UI on http://127.0.0.1:8765
npm test               # node:test suite — run it for the live count, don't trust a hardcoded number
```

Open http://127.0.0.1:8765/ and drive the full UI against the mock engine.

**On-device run / relaunch (Termux→Debian guest):** if the repo is cloned in place
(e.g. `~/mobileAgent`), there is **no `~/agent-broker` and no `~/provisioning/`** —
launch with the repo-root script (resolves the broker relative to itself, so it
works after any reboot/Termux reset): `bash ~/mobileAgent/start-broker.sh`
(`PROFILE=mock` for offline). The `~/provisioning/run-broker.sh` + `~/agent-broker`
path only exists if you ran `provision-debian.sh`. See [docs/on-device-deploy.md](docs/on-device-deploy.md).

**Prerequisites:** Node **≥ 21** (the test script relies on `node --test` glob
expansion, which is 21+), npm, git. For the real engine: the `claude` CLI logged
in on a Max plan. For UI screenshots: `npx playwright install chromium`. For the
Android app: Android SDK + JDK 17. Full detail in [docs/development.md](docs/development.md).

## High-value facts (the things that bite)

- **Wire framing:** the protocol is **one JSON object per WebSocket message — NOT
  newline-delimited JSON on the wire.** [`broker/src/protocol.js`](broker/src/protocol.js)
  is the authoritative event/command list; treat it as ground truth over any prose.
- **Sessions:** [`broker/src/session.js`](broker/src/session.js) holds a **`Map` of
  engines keyed by sessionKey** (multiple concurrent live sessions per project) —
  *not* a single active engine. Don't re-key it back to per-project.
- **Web UI is served from disk per request** (no build step): UI edits show on a
  browser reload; only `server.js`/engine changes need a broker restart. The empty
  state + todo list are built in JS (`buildEmptyState`/`renderTodos` in
  `web-ui/app.js`), not in static `index.html`.
- **Verify UI changes** with `npm run uishot` — it drives the UI at phone size and
  **exits non-zero on any JS console error** (so it's also a smoke test). See
  [docs/development.md](docs/development.md#ui-verification).
- **CLI is init-only:** `claude` scans skills/commands/agents/MCP **once at
  `system/init`**; a live stream-json session does not hot-reload them
  (re-spawn with `--resume`). See [docs/claude-cli-behaviors.md](docs/claude-cli-behaviors.md).
- **This box can build+test the broker and compile the APK, but cannot run/install
  the app** (no emulator/system image, no adb device). On-device runtime testing
  needs the user's phone. See [docs/development.md](docs/development.md#this-development-machine-windows).
- **On-device runtime is full of device-specific gotchas** that are documented in
  [docs/on-device-runtime.md](docs/on-device-runtime.md), not just code comments —
  e.g. the WebView loads **loopback HTTP only** (https → blank `ERR_SSL_PROTOCOL_ERROR`)
  and **`dvh`/`vh` misresolve to 0** (use `calc(N*var(--vh))`); rootfs extraction must
  stay **pure-Java** (Android blocks hardlinks); proot runs **with seccomp** + fake
  `/proc` binds; the broker is delivered as a **git clone** (that's what makes in-app
  Update work). Bump `ROOTFS_VERSION`/`BROKER_SOURCE_VERSION` when changing those steps.
- **Claude auth precedence:** when `~/.claude/.credentials.json` exists (native sign-in
  / `claude setup-token`), the engine **drops** `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`
  from its env so a stale token can't override the file (the "401 Invalid bearer token"
  cause). See `engines/claude-code.js` + [docs/claude-cli-behaviors.md](docs/claude-cli-behaviors.md).

## Keeping context current

**These docs are hand-maintained and drift fast if ignored. When your change makes
a doc wrong, fix the doc in the same change.** Concretely:

- Added/changed a **feature or subsystem** → update [docs/features.md](docs/features.md).
- Changed **build/run/test**, a tool version, or an env constraint → update [docs/development.md](docs/development.md).
- Changed the **architecture, protocol shape, or session/engine model** → update [docs/architecture.md](docs/architecture.md) (and remember `protocol.js`/`session.js` are the real ground truth).
- Learned a **non-obvious `claude` CLI behavior** → add it to [docs/claude-cli-behaviors.md](docs/claude-cli-behaviors.md).
- Touched the **on-device deploy path** → update [docs/on-device-deploy.md](docs/on-device-deploy.md).
- Touched the **Android runtime internals** (proot/rootfs/provision/login/WebView in `ProotRuntime`/`RuntimeLauncher`/`ClaudeLogin`/`AgentWebView`) → update [docs/on-device-runtime.md](docs/on-device-runtime.md), and bump the relevant version `const` if extraction/broker delivery changed.

**Anti-staleness rules:** prefer "run `npm test`" / "glob `src/`" over hardcoding
counts and file lists (they rot). Don't duplicate `protocol.js` — link to it. After
a substantive change, skim this file and fix anything it now gets wrong.
