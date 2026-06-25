# On-Device Claude Code — Build Plan

**Goal:** A sideloaded Android app on the Pixel 10 Pro XL that gives the full Claude Code experience through your own custom UI, can build React Native / Expo apps, and lets you test them live on the *same* phone — with the daily loop running 100% on-device and only the occasional native-binary compile offloaded to the cloud.

**Hardware reality:** Pixel 10 Pro XL = Tensor G5 + 16 GB RAM + Android 16. The RAM (not the CPU) is what matters for a JS toolchain, and 16 GB is plenty. The CPU sits ~30% behind Snapdragon/Apple flagships but chews through Metro bundling fine. The real constraint is never compute — it's Android's app-sandbox exec policy, which the decisions below route around.

---

## 1. Decisions (locked) and why

| # | Decision | Why |
|---|----------|-----|
| 1 | **On-device primary** (not remote-brains) | Localhost test loop = zero network hop = fastest Fast Refresh; fully self-contained; no VM to pay for or keep online; matches the actual goal. |
| 2 | **Sideloaded Kotlin app at `targetSdkVersion 28`** | API 29+ forbids `execve()` on files in the app's writable data dir (W^X). SDK 28 keeps classic exec-from-data-dir. Google Play's min-target rule doesn't apply to a personal sideload, so this costs you nothing. |
| 3 | **Termux bootstrap → proot Debian (glibc) guest** | proot gives a normal Linux userland without root, where standard `linux-arm64` npm prebuilts (glibc-linked) run. Raw Termux is Bionic and breaks on many native deps. proot's ptrace overhead is irrelevant for dev work on this CPU. |
| 4 | **Drive the Claude Code CLI in headless stream-json mode — NOT the Agent SDK** | The CLI authenticates with your **Max subscription** (OAuth) → **no metered API billing**. The Agent SDK leans toward an `ANTHROPIC_API_KEY` (pay-as-you-go). Headless mode (`claude -p --output-format stream-json --input-format stream-json`) emits structured events purpose-built for a custom UI. |
| 5 | **Node "agent broker" in proot, exposing a localhost WebSocket** | One clean seam between the native UI and the agent. The broker owns the `claude` process, relays stream-json events, surfaces permission prompts, and exposes control endpoints (start Metro, run git, trigger build). UI just speaks WebSocket to `127.0.0.1`. |
| 6 | **Native Kotlin + Jetpack Compose UI** | You already know Kotlin; Compose is the cleanest way to render chat + collapsible tool/diff cards + approval prompts. (A WebView + web UI is a faster prototype if you want — the broker is UI-agnostic.) |
| 7 | **Foreground service + wake lock + battery-optimization exemption** | The agent, broker, and Metro must survive when you switch to the dev client to test. Without a foreground service, Doze kills them. This is the single most important piece of Android plumbing. |
| 8 | **Test loop = on-device Metro (localhost) + a dev client installed once** | `npx expo start` binds `localhost:8081`; the dev client loads the bundle and Fast-Refreshes on every save. No tunnel, no cloud, no rebuild per change. |
| 9 | **Native binary build = EAS cloud by default; on-device Gradle = optional advanced path** | You only need a *new* native binary when native deps change (rare). Cloud `eas build` is robust and doesn't touch the on-phone test experience. On-device Gradle is heroic and flaky (native-compile libs like Reanimated break) — keep it as a documented escape hatch for true zero-cloud. |
| 10 | **Project durability via GitHub** | Projects live in the proot home; `git push` to GitHub gives you backup/sync and survives an app reinstall. |
| 11 | **Broker is engine-pluggable; Claude (Max) is the default engine** | The UI speaks one canonical protocol; harness + model sit behind swappable adapters (Section 3). Lets you drop in GLM 5.2 or a whole different harness (opencode/goose) without touching the UI — while keeping Claude-on-Max as the zero-cost default. |

**The one unavoidable "cloud" dependency:** the model itself runs on Anthropic's servers. That's true of Claude Code on *any* machine — your code stays local; only the context the agent chooses to send goes over the wire, same as a desktop Claude Code session.

---

## 2. Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Pixel 10 Pro XL (Android 16)                                │
│                                                              │
│  ┌────────────────────────┐      ┌────────────────────────┐  │
│  │  Your Kotlin App        │      │  Dev Client (.apk)     │  │
│  │  (Compose UI)           │      │  custom Expo Go w/      │  │
│  │  targetSdk 28           │      │  your native modules    │  │
│  │                         │      └───────────▲────────────┘  │
│  │  ┌───────────────────┐  │                  │ exp://localhost:8081
│  │  │ Foreground Service│  │                  │ (Fast Refresh)
│  │  │  + wake lock      │  │                  │
│  │  └─────────┬─────────┘  │                  │
│  └────────────┼────────────┘                  │
│       launches │ (exec, SDK28)                 │
│   ┌───────────▼───────────────────────────────┼────────────┐ │
│   │  Termux bootstrap  →  proot Debian (glibc) │            │ │
│   │                                            │            │ │
│   │   ┌─────────────────┐    ┌─────────────────┴────────┐  │ │
│   │   │ Node Agent Broker│◄──►│ Metro (npx expo start)   │  │ │
│   │   │  ws://localhost  │    │ localhost:8081           │  │ │
│   │   └────────┬─────────┘    └──────────────────────────┘  │ │
│   │            │ spawns / stream-json stdio                  │ │
│   │   ┌────────▼─────────┐    ┌──────────────────────────┐  │ │
│   │   │ Engine adapter   │    │ project files / git      │  │ │
│   │   │ CC / GLM / local │───►│ ~/projects/<app>         │  │ │
│   │   └────────┬─────────┘    └──────────────────────────┘  │ │
│   └────────────┼───────────────────────────────────────────┘ │
└────────────────┼─────────────────────────────────────────────┘
                 │ HTTPS
                 ▼
   model API — default api.anthropic.com (Max); swappable per engine profile
```

**Three localhost connections, no tunnels:** UI → broker, dev client → Metro, and the broker ↔ the active engine over stdio. proot shares the network namespace (it's ptrace-based, not a container), so `127.0.0.1` is shared across all of it.

---

## 3. Engine / model abstraction (pluggable brain)

The broker is not hard-wired to Claude Code. Treat it as a host for **interchangeable engines**, where an *engine* = a harness adapter + a provider/model config. The UI only ever speaks the canonical protocol below, so swapping the model — or the entire harness — never touches the UI.

### Two axes of pluggability

- **Model swap (keep the harness):** pure config. Claude Code reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` + model mappings, so pointing it at GLM 5.2 via Z.ai's Anthropic-compatible endpoint is a base-URL + model-name change. For any model that only speaks OpenAI format, run a **LiteLLM proxy** inside proot as a universal translator (Anthropic-format in → any provider out). One proxy unlocks essentially every model behind the Claude Code harness.
- **Harness swap (replace the agent loop):** Claude Code → opencode → goose → Aider → your own. Each speaks a different protocol, so each gets a thin **adapter** that normalizes it to the canonical schema. Most open harnesses are already model-agnostic, so writing one adapter usually buys model-switching *inside* that harness for free.

### Canonical protocol (the stable contract)

Define it once as a superset of Claude Code's stream-json (the richest format, so it maps ~1:1).

- **Events (engine → UI):** `session_meta {sessionId, engine, model}` · `assistant_text {delta}` · `tool_call {id, name, input}` · `tool_result {id, status, output}` · `permission_request {id, action, detail}` · `status {state}` (thinking | running | waiting | error) · `usage {inTok, outTok, cost?}` · `error {message}`.
- **Commands (UI → engine):** `user_message {text}` · `approve {id}` / `deny {id}` · `interrupt` · `resume {sessionId}` · `switch_engine {profileId}` · `switch_model {model}`.

### Engine adapter interface

Every adapter implements `start(profile)`, `send(cmd)`, `respondPermission(id, decision)`, `interrupt()`, `stop()`, and emits canonical events. Its only job is native-protocol ↔ canonical translation.

- **`claude-code` adapter (build first):** spawns `claude -p --output-format stream-json --input-format stream-json --replay-user-messages`; stream-json maps almost 1:1 to the canonical schema.
- **`opencode` adapter (build second, as the conformance test):** drives opencode's server API and maps its events. If a *second* engine renders identically in your UI, the abstraction is proven.
- **LiteLLM is not an engine** — it's a provider shim used *under* the `claude-code` engine for non-Anthropic-format models.

### Engine profiles (what the picker switches)

A profile is `{id, label, harness, baseUrl, authRef, model, billing}`:

| Profile | harness | baseUrl | auth | model | billing |
|---|---|---|---|---|---|
| Claude (Max) | claude-code | default | Max OAuth | opus / sonnet | flat sub |
| GLM 5.2 (Z.ai) | claude-code | `api.z.ai/api/anthropic` | `ANTHROPIC_AUTH_TOKEN` | `glm-5.2[1m]` | flat sub (GLM Coding Plan) |
| GLM 5.2 (OpenRouter) | claude-code + LiteLLM | local proxy | OpenRouter key | glm-5.2 | metered |
| Local GLM | any | `http://your-server:port` | none / LAN | glm-5.2 | self-hosted (needs a 256 GB+ box) |
| opencode + X | opencode | (opencode provider config) | provider key | any | per provider |

### The "seamless" truth

Claude Code fixes the model at session start — there's no mid-conversation hot-swap. So "seamless" lives at *your* layer: picking a profile makes the broker stop the current engine process and respawn it with the new env/adapter (optionally `resume`-ing the session id). A fresh task feels instant; an in-flight conversation resets context unless resumed. Model-agnostic harnesses like opencode may switch live — adapter-dependent.

### Secrets

Provider keys live in the **Android Keystore**, injected as env into the engine process at spawn — never written to a project `.env` or committed. The default Claude (Max) profile uses OAuth, no key.

**Where it lands in the phases:** build the Phase 1 broker against this canonical schema with the `claude-code` adapter; add a second adapter (a GLM profile or opencode) before Phase 3 as the proof. The profile picker is a Phase 3 UI element backed by Phase 5 settings.

---

## 4. Phased build plan

Each phase is an independently testable milestone. **Do them in order** — early phases de-risk the hard parts before you invest in UI.

### Phase 0 — Validate the riskiest assumptions in plain Termux *(the gate)*

**Goal:** Prove, with zero custom code, that (a) Claude Code runs on-device on your Max plan, (b) Metro bundles on-device, and (c) a dev client tests on the same phone. If all three pass, the entire plan is viable.

**Steps:**
1. Install **Termux from F-Droid** (not Play Store — that build is stale).
2. Set up a Debian guest:
   ```bash
   pkg update && pkg install proot-distro
   proot-distro install debian
   proot-distro login debian
   ```
3. Inside Debian, install the toolchain:
   ```bash
   apt update && apt install -y nodejs npm git curl
   npm install -g @anthropic-ai/claude-code   # package name as published; verify
   ```
4. Authenticate Claude Code with your **Max subscription**: run `claude`, use `/login`, open the printed URL in the phone browser, authorize, paste the code back. Confirm `claude auth status` shows logged in (no API key).
5. Smoke-test headless stream-json:
   ```bash
   claude -p "List files in this directory." --output-format stream-json
   ```
   Confirm you get one JSON object per line (`system/init`, assistant text, tool_use, tool_result).
6. Scaffold an Expo app and start Metro:
   ```bash
   npx create-expo-app@latest demo && cd demo
   npx expo install expo-dev-client
   npx expo start --localhost
   ```
7. Get a test client on the phone: install **Expo Go** from Play (works for standard-SDK apps), OR build a dev client once via `eas build --profile development --platform android` and install the resulting APK. Open it, point it at `localhost:8081`, confirm the app loads.
8. Edit a screen, save, and confirm **Fast Refresh** updates the running app on the same phone.

**Done when:** you can chat with Claude Code in the terminal (on your Max plan) *and* see your Expo app live-reload on the same phone. **Do not start Kotlin until this passes.**

*Likely snags & fixes:* if Metro's file watcher complains, set `WATCHMAN_DISABLE=1` / disable watchman (Metro falls back to Node's watcher). If an npm package ships a glibc binary that won't run, you're in Debian/glibc already so most will — the exceptions are packages requiring on-device *compilation* (defer those to EAS).

---

### Phase 1 — The agent broker (headless Claude Code → WebSocket)

**Goal:** A Node service in proot that turns an agent harness into a clean WebSocket API your UI can consume. Build it against the **canonical schema in Section 3** with the `claude-code` adapter as the first engine — so pluggability is structural from day one, not a retrofit.

**Steps:**
1. In the Debian guest, create a small Node project (`agent-broker`).
2. Spawn `claude` in streaming I/O mode and keep it persistent:
   - `--output-format stream-json --input-format stream-json --replay-user-messages` so user turns echo back and you get a complete ordered transcript.
   - Choose a permission strategy: start with `--permission-mode acceptEdits` for speed, then add a proper approval flow (surface `tool_use` that needs confirmation to the UI, gate execution on the UI's reply).
3. Expose a WebSocket server on a fixed localhost port speaking the **canonical protocol** (Section 3): commands in (`user_message`, `approve`/`deny`, `interrupt`, `switch_engine`), canonical events out — produced by the engine adapter, never raw harness shapes.
4. **Buffer partial JSON chunks** — stream-json arrives in fragments; assemble complete lines before parsing. (This is the #1 bug in every custom Claude Code UI.)
5. Add control endpoints used later: `start_metro`, `stop_metro`, `git` (status/commit/push), `eas_build`, `run` (arbitrary command with streamed output).
6. Manage session lifecycle: capture `session_id` from `system/init`; support resume via `--resume <id>`.
7. **Keep the adapter seam explicit:** confine all stream-json parsing to the `claude-code` adapter, which emits canonical events. Don't let stream-json shapes leak into the WebSocket layer — that boundary is exactly what lets you drop in GLM or opencode later (Section 3).

**Done when:** from a throwaway WebSocket client (or a quick HTML page) you can send a prompt, watch the agent read/edit/run, approve a tool call, and see files change in `~/projects/<app>`.

---

### Phase 2 — The Kotlin shell + foreground service (runtime host)

**Goal:** The Android app that bundles and boots the whole environment and keeps it alive.

**Steps:**
1. New Android project, **`targetSdkVersion 28`**, `minSdk` per taste. (It will install on Android 16 via sideload; expect a one-time "built for an older version" notice. Apps targeting ≥ API 23 install fine.)
2. Bundle a **Termux bootstrap** (fork from `termux/termux-app` + `termux-packages`; both GPLv3 — which makes your app GPLv3, fine for personal use). Reuse their prebuilt arm64 bootstrap and `termux-exec` (the shebang-rewriting shim) rather than hand-rolling a userland.
3. On first launch, extract the bootstrap and run `proot-distro install debian` + provision the toolchain (script the Phase 0 setup).
4. Implement a **foreground service** that:
   - launches proot + the agent broker on start,
   - holds a **partial wake lock**,
   - shows a persistent notification,
   - requests `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` and guides you to grant it.
5. App connects to the broker over `ws://127.0.0.1:PORT` and shows raw events in a debug text view (no real UI yet).
6. **Critical test:** start a long agent task, switch to another app for a few minutes, return — the session and any running Metro must still be alive.

**Done when:** launching the app boots Debian + broker; backgrounding and returning does not kill the session.

---

### Phase 3 — The custom UI (Compose)

**Goal:** The Claude Code experience, your way.

**Build:**
- **Transcript:** user messages + assistant text (streamed token-by-token from deltas).
- **Tool-call cards (collapsible):** Bash (command + streamed stdout/stderr), file edits (rendered as a **diff**), file reads (path + snippet), web/search calls. Drive these off the `tool_use` / `tool_result` event types.
- **Approval prompts:** inline approve/deny for gated tool calls, wired to the broker.
- **Status surface:** thinking / running / waiting-for-you / error, derived from event types (fall back to light regex only where the structured field is missing).
- **Terminal/log drawer:** raw stream + a real shell pane for when you want to poke the environment directly.
- **Session controls:** new / resume / interrupt / model picker.

**Done when:** you can run a full task end-to-end from the UI — request → read → edit (see the diff) → run → approve → done — without touching the terminal.

---

### Phase 4 — The one-tap Test loop

**Goal:** The headline feature: tap once, your app opens and updates on the same phone.

**Steps:**
1. **Test button** calls the broker: ensure Metro is running for the active project (`start_metro` → `npx expo start --localhost --dev-client` if not already up).
2. **Deep-link into the dev client:** open `exp://127.0.0.1:8081` (or the dev client's "open URL" path). The dev client loads the bundle from localhost; every subsequent save Fast-Refreshes automatically.
3. **Dev-client acquisition flow:**
   - If the project is Expo-Go-compatible (no custom native modules) → just use Expo Go.
   - Otherwise → trigger `eas build --profile development --platform android` (cloud), surface the install link/QR in the UI, install once. Re-trigger only when native deps change.
4. **Detect native-dep changes:** when the agent edits `package.json` native deps / `app.json` plugins, prompt "native change detected — rebuild dev client?" so JS-only iteration never blocks on a build.
5. Smooth the handoff: returning from the dev client to your app should reattach to the live session (Phase 2 guarantees it's still running).

**Done when:** "build me a screen that does X" → agent writes it → tap **Test** → the app opens and live-updates on the same phone, no rebuild.

---

### Phase 5 — Projects, sessions, durability, polish

**Goal:** Daily-driver quality.

- **Multiple projects:** project switcher; each maps to a dir in `~/projects` and its own Metro port / session.
- **Session resume:** persist `session_id` per project; resume on reopen.
- **Git integration:** one-tap commit + push to GitHub (durability + sync); show diff/status in UI.
- **Secrets/env:** per-project `.env` management UI (Supabase, Cloudflare keys you already use).
- **Settings:** default permission mode, model selection, watchman on/off, Metro flags.
- **Thermal/battery niceties:** idle the broker between turns; "plug in for long sessions" hint; optional cap on concurrent Metro instances.

**Done when:** you reach for this instead of a laptop for real iteration.

---

### Phase 6 *(optional)* — Fully self-contained native builds

**Goal:** Zero cloud, even for the native binary. Advanced; accept the cost.

- Install an **arm64 Android SDK + JDK + Gradle** in the Debian guest.
- Use `expo prebuild` + `gradle assembleDebug`, or the `adb` daemon + `adb reverse` trick to let the on-device build attach to the device as an emulator target.
- **Reality check:** pure-JS and most-native apps build; libraries with their own native compile steps (e.g. Reanimated/cmake) are where on-device builds fall over. Treat this as "I want absolutely no cloud," not the everyday path.

**Done when:** you can produce an installable APK with no external service (slower and flakier than EAS, eyes open).

#### Build targets & loop quality by stack (zooming out)

The tool builds *anything the agent can write* — what differs by stack is how tight the on-device iteration loop is and where the heavy compile lands. Rough guide:

| Stack | Loop feel | "Test" mechanism | Compile burden / where |
|---|---|---|---|
| Single-file HTML / web SPA | Instant | Broker serves on localhost → WebView or phone browser | None |
| Node / Python backends, CLIs, scripts | Instant | Broker runs it in proot, streams output | None |
| **React Native (Expo) — primary target** | Sub-second Fast Refresh | Dev client loads JS bundle from `localhost:8081` | JS bundles on-device; native dev client built once (EAS cloud) only on native-dep change |
| Flutter | Hot reload (fast) | `flutter run` → attached device, hot reload | Full build only for release / native-dep change; on-device toolchain heavier than Metro |
| Native Kotlin / Android | Full rebuild each change (no hot reload) | gradle → APK → `PackageInstaller` (tap Install) → launch | Every change recompiles; on-device arm64 Gradle (aapt2 swap) **or** cloud CI — default to CI |

**Rule of thumb:** the more a stack leans on an interpreted/bundled layer (HTML, RN's JS, Flutter's Dart hot reload), the tighter the on-device loop. The more it's true native compilation (Kotlin/Android, anything NDK), the more you'll want cloud CI for the build and the phone purely as the run target. The core app + the test handoff are stack-agnostic; only the build step and loop speed change.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| **Doze kills Metro when you switch to the test app** | Foreground service + wake lock + battery-optimization exemption (Phase 2). This is non-negotiable. |
| **SDK 28 install friction on Android 16** | Sideload (not Play). Expect a one-time compatibility notice; installs fine since target ≥ API 23. |
| **npm packages with native binaries fail** | proot **Debian/glibc** guest (not raw Termux/Bionic) makes standard `linux-arm64` prebuilts work. Compilation-required packages → EAS cloud. |
| **Metro file-watching flakiness in proot** | Disable watchman; rely on Node's watcher. |
| **Wrong billing for the active engine** | When you want flat/Max, confirm the selected profile is Claude (Max) or the GLM flat plan; the UI badges metered profiles (OpenRouter/direct API). Verify Claude auth with `claude auth status`. |
| **Alt-endpoint behavior drift** (GLM tool-use, refusals, context handling) | Keep Claude (Max) as the trusted default; treat alt engines as opt-in per task, and keep your verification loop (tests/CI) as the real exit criteria regardless of model. |
| **Thermal throttling on long sessions** | Idle between turns; charge during heavy work; the bundling spikes are short. |
| **Partial-JSON parse bugs** | Buffer stream-json chunks to complete lines before `JSON.parse` (Phase 1). |
| **Losing work on reinstall** | Projects in proot home + routine `git push` to GitHub. |
| **OAuth token expiry mid-session** | Broker watches for `api_retry`/auth-error events and surfaces a re-login prompt. |

---

## 6. Tech stack summary

- **App shell:** Kotlin, Jetpack Compose, targetSdk 28, foreground service.
- **Userland:** forked Termux bootstrap + `termux-exec` → proot-distro Debian (glibc).
- **Broker:** Node + `ws` (WebSocket), child-process management, canonical event schema (Section 3).
- **Engines (pluggable):** `claude-code` adapter (default, Max OAuth) + at least one alternative — GLM 5.2 via Z.ai's Anthropic-compatible endpoint, or opencode; LiteLLM proxy in proot for OpenAI-format models.
- **Mobile dev:** Expo + Metro (localhost) + expo-dev-client; EAS Build (cloud) for native binaries.
- **Secrets:** Android Keystore → env injection at engine spawn.
- **Durability:** Git + GitHub.

---

## 7. What to use *today*, while you build this

Don't block your work for weeks. In the interim, **Claude Code on the web** (from the Claude mobile app) gives you a cloud agent you can drive from the phone with no setup; pair it with `eas update` → your dev client for testing. It isn't your custom UI and isn't on-device, but it keeps you productive and doubles as a reference for the event/UX patterns you'll reimplement in Phases 1–4.

---

## 8. Decisions you still own

- **Engines to ship first:** Claude (Max) is the default; pick the second engine to prove the abstraction — GLM 5.2 on the Z.ai flat plan (easiest, since it's Anthropic-compatible) or opencode (proves a genuinely non-Claude-Code harness).
- **UI fidelity vs. speed:** native Compose (best feel) vs. WebView + web UI (fastest prototype, reuse later). The broker doesn't care.
- **Guest distro:** Debian (recommended default) vs. Ubuntu vs. lean Alpine (musl — lighter but worse prebuilt compatibility; not recommended).
- **Permission model:** `acceptEdits` for flow vs. explicit per-tool approval for safety. Start permissive in dev, tighten as you trust it.
- **Distribution:** purely personal (simplest, GPLv3 is a non-issue) vs. eventually sharing (then the SDK-28 + GPLv3 choices need a second look, and you'd revisit the native-libs packaging route for a modern target).
