# Multi-engine roadmap — making any engine a first-class citizen

**Status: active prerequisite plan / not yet implemented.** This is the design for
evolving the broker from "claude-code with a couple of stub adapters" to "any
engine works perfectly, with a different engine runnable per tab simultaneously."
It is the required foundation before a production Codex adapter or an
engine-neutral Agent/persona system. Implement this before executing older
Claude-specific plans unless the user explicitly asks for a Claude-only feature.

Shared-code portability is part of this plan: Android/proot-Debian is the
primary deployment runtime, but broker/web/test code must also work on native
Windows. New engine seams should use Node path/process APIs and tests should not
assume Bash, `/tmp`, or POSIX path separators.

## The goal

1. The app works **perfectly with any engine** — claude-code CLI, opencode, grok
   CLI, and even non-CLI agents (langgraph / an in-process or HTTP Python agent).
2. **Multiple tabs run at once, each on a different engine** — e.g. tab 1 claude-max,
   tab 2 opencode, tab 3 a langgraph agent, all live concurrently.

## Where we are today (~2/5 pluggable)

The **bones are right** — do NOT rebuild these:

- `EngineAdapter` base (`broker/src/engines/base.js`) + a canonical, mostly
  engine-neutral wire protocol (`broker/src/protocol.js`). Three adapters already
  exist (`claude-code`, `mock`, `opencode`) — the seam demonstrably works.
- Sessions are **already** an `engines: Map<sessionKey, engine>` with a per-session
  `meta` carrying `profileId`/`model`/`sessionId`/`cwd` (`broker/src/session.js`).
  Many engines *can* be live at once today.
- `createEngine(profile)` dispatches by `profile.harness`; profiles are user-editable
  (`broker/src/profiles.js`, `engines/index.js`).
- All transcript / tool-card / thinking / markdown **rendering is protocol-driven**
  and already engine-neutral, as is most of `controls/` (~85% by count: transcript,
  backup, updater, cron, autoverify, checkpoints, fsmanager, process-runner, prompts,
  devtools, user-settings, resources are all agnostic).

Two systemic problems hold the score down.

## Root cause #1 — claude logic leaked *outside* the adapter

The contract should be "all claude specifics live in `engines/claude-code.js`;
everyone else speaks canonical protocol." In practice it leaked into every layer.
Each row is a leak to push **behind a per-engine interface** or **gate on a declared
capability**:

| Layer | Leak (file) | Why it breaks other engines |
|---|---|---|
| Broker core | `controls/model-resolver.js` spawns the `claude` CLI; labels hardcode `opus\|sonnet\|haiku\|fable` | grok/opencode/langgraph have no `claude --model` aliasing |
| Broker core | `claudeConfig.readSessionTranscript()` parses `~/.claude/**/*.jsonl` for resume/replay (`server.js` RESUME) | other engines don't write that format |
| Broker core | `resumeId` + `sessions.json` assume a claude-style resumable sessionId | langgraph/grok may have no resume concept |
| Broker core | `RESCAN_KINDS = {skills,commands,agents,output-styles,mcp}` (`server.js`) | claude `.claude/` concepts |
| Broker core | `secrets.claudeEnv()` / `.claude/.credentials.json` drop (`session.js`, `claude-code.js`) | other engines auth via API key / env |
| Controls | `controls/claude-config.js` (whole module) reads `.claude/` skills/commands/agents/memory/MCP + session `.jsonl` | 100% claude-only |
| Protocol | `CAPABILITIES` = `slash_commands`/`agents`/`mcp_servers`/`output_style`/`plugins`; plus `EFFORT` levels, `THINKING`, `COMPACT`, `USAGE` cache-token billing | ~40% of the protocol is claude-shaped — dead weight or wrong for others |
| Permissions | the approval flow is wired through claude's MCP permission-bridge (`mcp/permission-bridge.js`, `permission-server.js`) | a non-MCP engine can't gate without reimplementing it |
| UI | model picker parses a claude id regex; effort selector ("ultracode only on Opus"); Manage tabs = skills/agents/MCP/output-styles (`web-ui/app.js`, `managers.js`) | claude vocabulary baked into the client |
| Android | `ProotRuntime` hardcodes `npm i -g @anthropic-ai/claude-code`; `ClaudeLogin`/`ClaudeUpdate` run `claude setup-token` / `claude update` | provisioning + native auth/update are claude-only |

## Root cause #2 — global singletons block "engine per tab"

`SessionManager` keeps **one** of each of these, mirroring only the *active* tab —
even though per-session `meta` already exists to hold them:

`activeProfileId`, `currentModel`, `permissionMode`, `effort`, `lastCapabilities`,
`_lastStatus`.

So a backgrounded opencode tab can't keep its own model/permission/capabilities while
a claude tab is foreground. This is the single biggest blocker to per-tab engines —
and it's mostly **state relocation** (globals → `meta` / a `*ByKey` map), not a
rewrite, because the per-session map already exists.

## The plan (phased, ordered by leverage)

### Phase 1 — Formalize the contract + a capability declaration
*Low risk, unlocks everything below.*

- Write the `EngineAdapter` contract down (currently all implied): required methods
  (`_spawn`, `send`, `respondPermission`, `interrupt`) and **required vs optional**
  events. Add safe base-class defaults so optional features are no-ops, not silent
  drops — e.g. a default `respondQuestion(id)` that emits `QUESTION_RESOLVED` instead
  of the current `if (e.respondQuestion)` check that drops answers on opencode.
- Give each engine a **`features` declaration**: `{ thinking, permissions, questions,
  resume, slashCommands, models, effort }`. Emit it on `CAPABILITIES` (or a new
  `engine_info` event). This is what lets every other layer **degrade gracefully**
  instead of assuming claude features exist.
- Move the shared `toolId → name` map and (optionally) a reusable permission-bridge
  helper into `base.js` so new adapters don't copy 200 lines.

Delegation target:

```js
features = {
  thinking: false,
  permissions: false,
  questions: false,
  resume: false,
  slashCommands: false,
  models: false,
  effort: false,
  config: false
}
```

Every adapter overrides only the capabilities it actually implements. Base-class
defaults must be safe no-ops that emit a visible resolved/error event rather than
silently dropping work. For example, a default `respondQuestion` should resolve
the pending UI request as unsupported instead of doing nothing.

### Phase 2 — Make per-session state real (the per-tab unlock)
- Relocate the six globals (above) into per-session `meta`; turn `lastCapabilities`
  into `capabilitiesByKey`. `activeKey` stays a *view pointer* only.
- On tab switch, re-broadcast the focused session's own model/effort/permission/
  capabilities/status (today only `lastCapabilities` is re-sent, and only globally).
- Extend `sessions.json` from `{ key: resumeId }` to `{ key: { resumeId, harness } }`
  so resume state is per-engine.

Acceptance for this phase:

- A Claude tab and a mock/opencode/Codex-fixture tab can hold different profile,
  model, effort, permission, status, and capabilities at the same time.
- Switching tabs only changes the view pointer; it does not mutate a background
  session's engine settings.
- The persisted resume map can never pass a Claude session id to a Codex adapter
  or a Codex thread id to Claude.
- Tests include Windows-style and POSIX-style project paths for any new path
  handling.

### Phase 3 — Capability-gated UI + per-tab controls
- Tab objects gain `{ engineProfileId, model, effort, permissionMode }`; the model /
  effort / permission / slash-palette / Manage-config views read the **active tab's**
  engine + `features`, and **hide** controls the engine doesn't support.
- Add a per-tab **engine selector + indicator** (the native `MainScreen.kt` already
  lists profiles — the web composer needs the same per tab).

### Phase 4 — Abstract the claude-coupled subsystems
- `EngineConfig` provider interface; `claude-config.js` becomes the claude impl.
  Engines with no skills/commands return empty (the UI already hides empties via the
  Phase-1 `features`).
- Source model labels from the engine's `CAPABILITIES` instead of spawning `claude`
  in `model-resolver.js` (keep the claude probe only as the claude impl).
- Make resume an **optional capability**: engines that can't resume start fresh and
  rely on the broker's own agnostic `transcript.js` for replay (stop reading the
  engine's native on-disk format in core).
- Per-engine auth (the `profile.authRef` secret abstraction already exists; only
  claude needs the credentials-file drop + native PTY login).

### Phase 5 — Genericize the protocol
- Treat the claude-shaped `CAPABILITIES` fields as **optional**, gated by `features`;
  make `USAGE` cache-token fields, `EFFORT` levels, `THINKING`, and `COMPACT` optional
  (most of the UI already degrades). Decide whether to rename to neutral terms
  (`commands`/`subAgents`/`tools`/`modes`) or keep names + the `features` gate — the
  latter is far less churn.

### Phase 6 — Android: parameterize the native flows
- Provisioning installs a **configurable** engine CLI set (or per-engine bootstrap),
  not a hardcoded `@anthropic-ai/claude-code`.
- Login/update become per-engine. Most non-claude engines auth via an env/API key
  through `profile.authRef` and need **no** native PTY flow — only claude does.

## Acceptance test / forcing function

Drive **opencode to full parity** (it's currently ~15% wired — connects + sends, but
emits no capabilities/permissions/questions/resume). Making one real second engine
work end-to-end is the concrete test that Phases 1–4 actually landed. Then add a
non-CLI engine (a langgraph adapter over HTTP/in-process) to prove the contract isn't
secretly CLI-shaped.

For the immediate Codex goal, a fake `codex app-server` JSON-RPC fixture may be
used before opencode parity to validate the contract. Do not ship a real Codex
adapter until the same capability gates and per-session state rules pass with at
least one non-Claude fixture/adapter.

## Guardrails

- Don't rebuild the agnostic parts (rendering, transcript store, most of `controls/`).
- Every claude assumption removed should become either a **per-engine interface impl**
  or a **declared capability the UI gates on** — never a hardcoded `if hardcoded
  (harness === 'claude-code')` scattered through core.
- Keep `protocol.js` / `session.js` as ground truth; update this doc + `architecture.md`
  as the model changes.
- Keep shared implementation portable. Android-specific provisioning/login code
  can be Android-only; broker adapters, protocol, tests, and web UI must run on
  Windows too.
