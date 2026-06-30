# Architecture & Codebase Map

> System architecture and a concrete map of where things live. Written for an
> agent landing in this repo cold. **Verify counts/lists against the source** —
> they drift. Treat [`broker/src/protocol.js`](../broker/src/protocol.js) and
> [`broker/src/session.js`](../broker/src/session.js) as ground truth over any
> prose here.

`mobile-agent` is a phone-first coding-agent runtime: a sideloaded Android app
hosts a local broker and web UI, builds Expo/React-Native apps, and tests them
live on the same phone. The current production engine is Claude Code; the broker
also has a Codex CLI app-server adapter behind the multi-engine seam. The daily
phone loop runs 100% on-device; only native binary compiles normally go to EAS.
The original background plan is [`ondevice-claude-code-plan.md`](../ondevice-claude-code-plan.md);
the active sequencing is [`docs/current-plan.md`](current-plan.md).

The supported runtime model is phone-first, not phone-only. Android/proot-Debian
is the primary deployment runtime, while the shared broker, web UI, and tests
must also run natively on Windows. Android-specific code can assume Android and
proot details; shared Node/web code should use portable path/process APIs and
must not depend on Bash-only behavior.

## The components (three + one)

| Dir | What it is | Runs where |
|---|---|---|
| [`broker/`](../broker) | **The heart.** A Node service exposing a localhost WebSocket that speaks a canonical event protocol, plus pluggable engine adapters and a control surface (Metro/git/EAS/run/projects/checkpoints/…). Fully runnable and tested on a dev box. | proot Debian on the phone; or any laptop |
| [`broker/web-ui/`](../broker/web-ui) | The **client** — transcript, tool cards, diffs, inline approvals, managers, terminal, Test button. Served by the broker over HTTP on the same port. The Android app hosts this in a WebView rather than reimplementing it natively (the plan's blessed fast path). | Android WebView, or any browser |
| [`android/`](../android) | Kotlin/Compose **shell**: foreground service + wake lock + battery exemption + proot/broker launch + Keystore secret injection + WebView host. | the phone |
| [`provisioning/`](../provisioning) | Termux → proot Debian bootstrap scripts (Phase 0 gate + Phase 2 provision). | the phone |

Also present, supporting roles:

- [`tools/webshot/`](../tools/webshot) — a small Playwright screenshot helper (skill + CLI) for verifying the web UI.
- [`dist/`](../dist) — prebuilt artifacts (`app-debug.apk`).

### Why `targetSdk 28` (the load-bearing Android setting)

The Kotlin shell pins `targetSdk = 28` (see
[`android/app/build.gradle.kts`](../android/app/build.gradle.kts)). API 29+
forbids `execve()` of files in the app's writable data dir. proot/Termux **must**
exec binaries it unpacked into the data dir, so `targetSdk 28` keeps
classic exec-from-data-dir legal. This is intentional and lint for
`ExpiredTargetSdkVersion` is disabled on purpose.

## Data flow

```
Android WebView (broker/web-ui)
        │  ws://127.0.0.1:8765   (one JSON object per WS message — see Protocol)
        ▼
   broker (BrokerServer, src/server.js)
        │  routes commands → SessionManager → active engine; events back out
        ▼
   engine adapter (src/engines/claude-code.js | codex-app-server.js | opencode.js | mock.js)
        │  spawns `claude --print --input-format stream-json --output-format stream-json …`
        ▼
   Claude CLI  ──HTTPS──▶  model API (default: Claude on your Max plan, OAuth, no metered billing)
```

The broker also serves `web-ui/` over plain HTTP on the same port, so a browser
pointed at `http://127.0.0.1:8765/` drives the full stack with zero install.
Off-phone, `npm run dev` boots the **mock** engine, which emits the exact same
events (and really writes files), so the whole UI works with no credentials.

## The canonical protocol (ground truth: `src/protocol.js`)

[`broker/src/protocol.js`](../broker/src/protocol.js) is the **single stable
contract** between the UI and any engine. Every adapter must translate its native
protocol into these shapes; raw harness shapes never reach the UI. Read it
directly for the authoritative, current event/command lists — do not trust a copy
here.

- **`EventType`** — events emitted engine→UI and broker→UI (e.g. `session_meta`,
  `assistant_text`, `tool_call`/`tool_result`, `permission_request`, `usage`,
  `context`, `sessions`, `checkpoints`, `control_output`, …).
- **`CommandType`** — commands accepted UI→broker (e.g. `user_message`,
  `approve`/`deny`, `switch_model`, `new_session`, `switch_session`,
  `checkpoint_restore`, `git`, `run`, …).
- Helpers: `event(type, fields)` stamps a `ts`; `StatusState` enumerates
  `idle|thinking|running|waiting|error`.
- `CAPABILITIES` includes an engine `features` declaration (thinking,
  permissions, questions, resume, slashCommands, models, effort, config). Treat
  feature-specific fields as optional and gate callers on `features` rather than
  assuming a Claude-shaped surface.

### Wire framing — read this carefully

The file header calls the schema "a superset of Claude Code's stream-json." That
describes the **shape** of the payloads, **not** the wire framing. On the
WebSocket, **each message is exactly one JSON object** `{ "type": <string>,
...fields }`. It is **NOT** newline-delimited JSON on the socket. (NDJSON
*does* appear elsewhere — see the comment in `protocol.js` lines 8–9, and the
two NDJSON-over-stdio hops below — but never on the WS to the UI.)

NDJSON-over-stdio is used internally, in two places, and must not be conflated
with the UI wire format:

1. Between the Claude CLI and the `claude-code` adapter (stream-json stdio),
   reassembled by [`src/jsonl.js`](../broker/src/jsonl.js). That buffer exists
   because stream-json arrives in arbitrary chunks — *the* #1 bug in custom CC
   UIs. One JSON object can split across two reads.
2. Between the permission MCP server and the broker's IPC bridge (see Approval
   flow).

## Session / engine model (ground truth: `src/session.js`)

`SessionManager` does **not** own a single active engine. It owns a **`Map` of
engines keyed by `sessionKey`** — many concurrent live sessions, possibly several
in the same project folder — and tracks one **`activeKey`** (the one the UI is
viewing). Background sessions keep generating while you look at another. Read
[`broker/src/session.js`](../broker/src/session.js) for the exact behavior.

- **`engines: Map<sessionKey, engine>`** and **`meta: Map<sessionKey, {...}>`**
  (busy, lastStatus, profileId, harness, model, effort, permissionMode,
  sessionId, projectId, cwd, lastActivityTs, pinned, title). Capabilities are
  cached per session in `capabilitiesByKey`.
- **Session keys.** The first session of a project uses `key === projectId` (so
  resume/cold-resume + project binding stay simple and readable). A second+ concurrent
  session in the same folder mints `projectId-<token>` (a random hex suffix) via
  `_sessionKeyFor(project, { fresh: true })`. The suffix is **non-recycling and
  collision-checked** (`_keyTaken` rejects a clash with a live engine, a persisted
  resume id, or an existing transcript file) — the old `projA#N` counter reset to 0 on
  every broker restart, so keys recycled and a fresh session could inherit a dead
  session's leftover transcript/resume id ("new tab shows old messages"). `-` is also
  filesystem/URL-safe (unlike `#`). `_activeKeyByProject` binds each project to its
  current foreground key. The no-project case uses `'__main__'`.
- **`activeKey` is a view pointer**, not a lifecycle gate.
  `setActiveKey(key)` switches which session the UI sees *without stopping the
  others*; `newSession()` starts a fresh concurrent session in the active folder.
  On focus, the broker rebroadcasts the focused session's own profile/model/
  effort/permission/status/capabilities. Switching tabs does not mutate a
  background session's controls.
- **Restart-in-place semantics.** Changing the active model/effort/permission/
  profile (`switchModel`, `setEffort`, `setPermissionMode`, `switchEngine`,
  `refreshCapabilities`) replaces **only the active key's** engine with a
  fresh/resumed engine process. Opening another project just moves `activeKey`.
  Model preferences are validated against the target profile/harness so a saved
  Claude alias such as `haiku` is not passed to Codex, while explicit compatible
  custom overrides remain possible.
- **Lifecycle eviction & cold-resume.** `stopEngineKeepTranscript(key)`
  idle-evicts a live engine but keeps its `meta` (incl. `sessionId`) and
  transcript, so `ensureEngine(key)` later **cold-resumes** it in *its own* folder
  via `--resume`. `setPinned(key, …)` exempts a session from the memory backstop.
  `forgetSession(key)` is called when a `.jsonl` is deleted: it drops the resume
  hint, tears down the engine, and rebinds the project to a surviving sibling.
  For Codex, a stale server-side thread id, such as app-server reporting
  `No rollout found for thread id`, is cleared and replaced with a fresh
  `thread/start` for that session key instead of leaving the engine stuck.
  Codex resume hints are also cwd-qualified: a saved Codex thread id is ignored
  if its stored cwd is missing or does not match the session cwd, which prevents
  an old app/broker-folder thread from resuming inside a project tab.
- **Eviction policy (`evictionCandidates` in `controls/resources.js`).** Only
  *idle, unpinned, non-active* engines are evictable, LRU-first. Two guards keep a
  just-used session warm so flipping between a few tabs doesn't instantly 💤 the one
  you left: (1) an **`inTurn`** meta flag set the instant a prompt is queued
  (`sendUserMessage`/`sendTo`) — before the engine's first status — marks the session
  `working` (so it shows the indicator immediately *and* is filtered out of eviction);
  it's cleared on `RESULT`/`ERROR`/`interrupt`, **not** on an init `idle`. (2) A
  **recency grace** (`graceMs`, 90 s): between the low (`memEvictPct`, 88 %) and
  critical (`memCriticalPct`, 95 %) memory thresholds, a session idle for less than
  the grace is kept; at/above critical, OOM risk overrides the grace and it's evicted
  regardless. `setActiveKey` restamps the *left* tab's `lastActivityTs` so the grace
  measures "time since you switched away."
- **Event tagging.** `_onEngineEvent` stamps every engine event with its owning
  `sessionKey` before re-emitting, so the server records it to the right
  transcript and only surfaces the active session's full stream (plus a busy
  badge for the rest).
- **Session history list.** `LIST_SESSIONS` returns a merged history surface:
  Claude on-disk `.jsonl` sessions plus broker-known live/sleeping sessions from
  other engines. Non-Claude rows include `sessionKey`, so the Web UI opens them
  with `SWITCH_SESSION { key, projectId }`; Claude-only historical rows still use
  `RESUME`. `SWITCH_SESSION` is not a creation fallback: the broker rejects stale
  restored tab keys that are neither live/sleeping meta nor active-harness-compatible
  persisted resume records, which prevents startup workspace hydration from minting
  fresh sessions.
- **Back-compat.** `get engine()` returns the active engine, so older code that
  said `session.engine` (the "singular active engine" mental model) still works —
  but that getter is a convenience over the Map, not the real ownership.

`startEngine` is serialized behind a `_startLock` so closely-timed restarts can't
orphan a child `claude` process. Resume ids persist to `<stateDir>/sessions.json`
keyed by **`sessionKey`** as `{ resumeId, harness, cwd? }` (the first session's key ===
its `projectId`, so the file stays back-compatible; legacy string values are
treated as Claude-only until rewritten). Keying by `projectId` let a 2nd
concurrent session in the same folder clobber the 1st's resume id and resume
*into* it on the next restart (the "sessions merged" bug); storing the harness
also prevents a Claude session id from being passed to opencode/Codex or vice
versa. New records also store cwd; Codex uses that cwd as part of the resume
contract and treats missing/mismatched cwd as stale. `setActiveKey` also rebinds
`_activeKeyByProject` to the focused key so a later `newSession()`/restart-in-place
can't route a turn into a sibling session.

## Code map

> **Glob `broker/src/` yourself** — this list is a snapshot and drifts; e.g.
> `controls/` holds well over a dozen modules. Run `npm test` for the real test
> count (old docs saying 19/13/45 are stale — trust the runner, not a number).

### `broker/src/` (core)

| File | Role |
|---|---|
| `index.js` | Entry point. Loads config, starts `BrokerServer`, starts the lifecycle sampler, autostarts the engine, handles signals. |
| `server.js` | `BrokerServer` — the localhost seam. Owns the HTTP+WS server, wires every control + the `SessionManager`, routes commands, broadcasts events, serves `web-ui/`. |
| `session.js` | `SessionManager` — the engine `Map`, keys, active view, restart/resume/eviction. (See above.) |
| `protocol.js` | Canonical `EventType` / `CommandType` / `StatusState` + `event()`. The contract. |
| `jsonl.js` | `JsonLineBuffer` — reassembles stream-json across chunked stdout reads. |
| `config.js` | CLI-arg + env config loader (port, host, projectsDir, stateDir, claudeBin, …). |
| `profiles.js` | `ProfileStore` + `DEFAULT_PROFILES` — engine/model profiles (claude-max, codex-app-server, glm-zai, opencode, mock) and their billing/auth. Existing `<stateDir>/profiles.json` files are merged with new built-in defaults on load, including newly-added built-in model/model-list fields, so already-provisioned devices pick up new built-in profiles without losing custom/user-edited profiles. |
| `secrets.js` | `SecretStore` — auth tokens / env for a profile (`<stateDir>/secrets.json`, Keystore-injected on phone). `claudeEnv()`/`hasClaudeAuth()` back the in-app Claude sign-in (`SET_SECRET` command stores `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`, `CLAUDE_AUTH` event reports status), injected into default-endpoint claude-code engines. |

### `broker/src/engines/` (adapters — the pluggable brain)

| File | Role |
|---|---|
| `base.js` | `EngineAdapter` (EventEmitter). The seam: subclasses do native↔canonical translation only. Implement `_spawn`/`send`/`interrupt`/`_teardown`; override optional response hooks only for declared features; emit via `emitEvent`/`emitCapabilities`. If `_spawn` fails after partially launching a child process, the base class calls `_teardown()` before reporting `stopped`. |
| `index.js` | `createEngine(profile, opts)` — `REGISTRY` maps a harness name to its class. Adding a harness = one entry + one file; the UI never changes. |
| `claude-code.js` | Default adapter. Drives `claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages …`. All stream-json parsing lives here. Stands up the permission bridge in gated modes. **Auth precedence:** when `~/.claude/.credentials.json` exists and on the default endpoint, drops `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` from the spawn env so a stale token can't override the file (the 401 cause). |
| `codex-app-server.js` | Codex CLI adapter. Spawns `codex app-server --stdio` (with Windows npm-shim resolution), starts/resumes Codex threads, maps generated app-server notifications/approvals/questions to the canonical protocol, and converts broker attachments into Codex `UserInput`. |
| `opencode.js` | `OpencodeEngine` — conformance adapter for a second harness. |
| `mock.js` | `MockEngine` — fully self-contained fake harness; emits identical canonical events and really touches the filesystem. The zero-credential demo path. |

Every adapter exposes a complete `features` object with safe base defaults.
Optional response hooks such as `respondPermission` and `respondQuestion` resolve
visibly through canonical events when unsupported, so callers do not need
method-existence checks that silently drop work.

### `broker/src/controls/` (the control surface — glob for the live set)

Notable modules (one line each):

| File | Role |
|---|---|
| `checkpoints.js` | Non-destructive pre-turn git snapshots (temp-index `commit-tree`); restore rolls tracked files back + removes files the agent created. One-tap `enable` runs `git init`. The undo/rewind trust feature. |
| `autoverify.js` | Self-healing loop: after each turn run a verify command (default `npm test`); on failure feed output back to the agent, bounded by maxIterations. |
| `usage-ledger.js` | Persists token/cost usage by day (`<stateDir>/usage.json`) for the today/7-day/all-time dashboard. |
| `resources.js` | Device/process metrics: `/proc/meminfo` + `/proc/<pid>/status` on phone, `os.*` fallback on dev box. Exposes `sampleResources` + `evictionCandidates` (the memory backstop's LRU idle-eviction policy). |
| `projects.js` | `ProjectManager` — a project is a working dir; discovers subdirs of `projectsDir`, can open any folder, tracks active project + per-project Metro port. |
| `transcript.js` | `TranscriptStore` — replayable per-session copy of the event stream (`transcripts/<key>.jsonl`); coalesces streamed deltas; routes by `sessionKey`. |
| `model-resolver.js` | Resolves aliases (opus/sonnet/haiku) → versioned ids from the free `system/init` event; derives labels ("Opus 4.8") dynamically; caches to `models.json`. |
| `updater.js` | Self-update via `git pull` of the app's own repo; `classifyChanges()` decides reload vs broker-restart vs APK-rebuild. |
| `claude-config.js` | Read/write the Claude harness config under `.claude/` (skills / agents / commands / memory / settings / on-disk sessions), project or user scope. |
| `devtools.js` | `DevTools` — buttons map here: Metro lifecycle, git, EAS builds, arbitrary `run`. |
| `process-runner.js` | `ProcessRunner` — spawns external tools and streams output as `control_output` events keyed by channel; tracks long-running procs (Metro) across turns. |
| `files.js` | Read-only project browser: tree, size-capped read, fuzzy path search (@-mentions), changed-files list. Confined to the project dir. |
| `prompts.js` | `PromptLibrary` — saved reusable prompts (`<stateDir>/prompts.json`). |
| `frontmatter.js` | Minimal YAML-frontmatter parse/serialize for SKILL.md / agent / command files. |
| `cron.js` | `CronManager` — scheduled recurring agent prompts (5-field cron + presets), persisted to `<stateDir>/cron-jobs.json`. The server ticks it; due jobs run via `SessionManager.startDetached()` (a background engine that doesn't disturb the active view), `fresh` vs `persistent` session. Commands `CRON_*`, event `CRON_JOBS`. |
| `fsmanager.js` | `FileSystemManager` — whole-filesystem browser (absolute paths, `~` expansion), NOT project-scoped: browse/read/write/mkdir/rename/move/copy/delete/extract. Loopback-only, single-user by design. Commands `FS_*`, events `FS_LIST`/`FS_FILE`; `/fsraw` serves absolute-path files. |
| `user-settings.js` | `UserSettings` — persists UI/engine prefs (`<stateDir>/user-settings.json`), restored on restart. Event `USER_SETTINGS`, command `USER_SETTINGS_PATCH`. |

### `broker/src/mcp/` (the approval bridge)

| File | Role |
|---|---|
| `permission-server.js` | A self-contained MCP stdio server exposing one `permission_prompt` tool. Claude spawns it; it forwards each call to the broker over TCP. |
| `permission-bridge.js` | `PermissionBridge` — the broker-side TCP endpoint (ephemeral port) that receives those calls and resolves them with the UI's decision. |

### `broker/web-ui/` (the client)

| File | Role |
|---|---|
| `index.html` / `styles.css` | Shell + styling. |
| `app.js` | Main client: opens the WS, renders the transcript, streamed deltas, tool cards, status, composer. |
| `managers.js` | The "more than a chat client" surface: editors for Skills/Agents/Commands/Memory/Permissions, Sessions browser, Projects, live Context inspector, MCP/Plugins view. Talks to the broker via `window.Agent.send`. |
| `diff.js` / `markdown.js` | Diff rendering and markdown rendering. |
| `manifest.json` / `icon.svg` | PWA manifest + icon. |

## The approval (permission) flow

Approval is gated through a Claude Code `--permission-prompt-tool` MCP server plus
an IPC bridge. Flow:

1. The `claude-code` adapter, when `permissionMode` is gated (`default`/`gated`),
   starts a [`PermissionBridge`](../broker/src/mcp/permission-bridge.js) on a free
   localhost TCP port, then spawns the CLI with
   `--permission-prompt-tool mcp__broker__permission_prompt` and an
   `--mcp-config` that points `broker` at
   [`permission-server.js`](../broker/src/mcp/permission-server.js) (passing
   `BROKER_IPC_PORT`).
2. When the agent wants a gated tool, the CLI calls the MCP `permission_prompt`
   tool. `permission-server.js` forwards `{ id, kind:'permission', tool_name,
   input }` as **newline-delimited JSON over the TCP socket** to the bridge.
3. The bridge invokes `onRequest`, which surfaces a `permission_request` event to
   the UI and waits. The user's `approve`/`deny` command comes back, the bridge
   writes the decision back over the socket keyed by the same `id`.
4. `permission-server.js` returns the CLI-format result
   (`{ behavior: "allow", updatedInput }` | `{ behavior: "deny", message }`).

**Fail-closed by design:** if the broker IPC link is unavailable, the permission
server **denies** (set `BROKER_FAIL_OPEN=1` to opt into allow-on-failure). A
dropped socket must never silently disable approval for an agent that can run
Bash/Write. Non-gated modes (`acceptEdits`/`plan`/`bypassPermissions`/…) pass
straight through to the CLI, which enforces them itself.

## Where to look first

- Protocol questions → [`broker/src/protocol.js`](../broker/src/protocol.js).
- Session/engine lifecycle → [`broker/src/session.js`](../broker/src/session.js).
- The full Claude Code stream surface the adapter maps → [`docs/claude-code-surface.md`](claude-code-surface.md).
- The "why" behind locked decisions → [`ondevice-claude-code-plan.md`](../ondevice-claude-code-plan.md).
- Run the stack with no credentials: `cd broker && npm install && npm run dev`, then open `http://127.0.0.1:8765/`.
- Verify the suite: `cd broker && npm test`.

## Model/control catalog addendum

The model selector now uses an engine-neutral `ENGINE_OPTIONS` event. The broker
builds that event in `broker/src/controls/engine-options.js`: Codex uses
app-server `model/list` for model display names, supported reasoning efforts,
and speed/service tiers, while engines without dynamic catalogs fall back to
profile data and the legacy Claude alias resolver.
