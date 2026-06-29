# Agent Management — Design Doc

> Status: **design complete** (built collaboratively via Q&A, 2026-06-28). All decisions
> settled. Section 5 is the implementation spec; Section 6 is the build phasing.
> Ground-truth files referenced: `broker/src/session.js`, `broker/src/engines/claude-code.js`,
> `broker/src/profiles.js`, `broker/src/protocol.js`, `broker/web-ui/app.js`, `index.html`.
> **Line anchors re-verified 2026-06-28 against `main` @ `75f5d39`** (after the Expo-test /
> GitHub-sign-in batch). They drift as the code changes — treat them as hints, re-grep before relying.

> **Sequencing / delegation note:** this document is a Claude Code implementation
> design, not yet an engine-neutral implementation plan. The current repo
> priority is `docs/multi-engine.md` Phase 1/2, then `docs/codex-app-server.md`.
> Before implementing this feature across engines, split it into an
> engine-neutral `AgentStore`/UI/attribution layer plus per-engine mappers
> (Claude spawn flags, Codex app-server instructions/sandbox/approvals, etc.).
> If implemented before that split, label the work Claude-only.

## 1. Goal

Let the user **create, edit, and select "agents"** — each a reusable bundle of
**system prompt + tool access + skills + (optional) model/effort + filesystem scope** — and
switch the active agent **as easily as switching the model, even mid-session**, with
conversation history preserved across the switch.

Motivating example: start a session with a "Software Engineer" agent scoped to the projects
folder and a fixed tool set; implement a feature; then switch to a different agent *in the
same session* — the new agent sees the prior conversation but runs under its own
prompt/tools. The conversation then reads like a **group chat** with multiple speakers.

## 2. Confirmed mechanics (grounded in current code)

The design rests on these verified facts:

- **Restart-in-place already exists.** `SWITCH_MODEL` / `SET_EFFORT` / `SWITCH_ENGINE` /
  `SET_PERMISSION_MODE` each persist the choice to `userSettings`, then call
  `session.startEngine(...)`, which respawns the active `claude` process with `--resume`
  (`session.js:140`). **An "agent" is just a richer restart payload on this same path.**
- **Current restart bundle** (`session.js:181` → `createEngine`):
  `{cwd, env, model, resumeId, claudeBin, permissionMode, effort, ultracode, log}`. We
  extend it with the agent's fields.
- **Mid-session persona swap is free.** `--resume` replays only the transcript; the system
  prompt is a separate spawn arg, rebuilt every spawn (`_spawn()`, `claude-code.js:71`). A
  respawn gets the NEW agent's prompt with the OLD conversation.
- **Verified CLI levers (v2.1.195, on-device):**
  - `--append-system-prompt[-file]` / `--system-prompt[-file]` (print-mode only; broker
    always runs `--print`).
  - `--allowed-tools` / `--disallowed-tools <tools...>` — allow/deny, support patterns like
    `Bash(git *)`, `Edit`, `Write`, `Read`.
  - `--tools <tools...>` — restrict which tools even EXIST ("default" = all).
  - `--add-dir <dirs...>` — *expands* tool-accessible dirs.
  - `--permission-mode <mode>` — default / acceptEdits / plan / bypassPermissions.
  - `--settings` / `--setting-sources` — settings JSON + which sources load (for skills).

## 3. Hazards designed around

1. **Naming collision.** `CONFIG { kind:'agents' }` in the protocol already means Claude
   Code's built-in **subagents** (`.claude/agents/*.md`, spawned by the Agent/Task tool).
   Our concept is a top-level persona → we keep "Agent" user-facing and rename the existing
   config kind to **`subagents`** internally.
2. **Tool-allow ≠ filesystem-scoping.** A tool allowlist does not stop edits outside a
   folder; path scoping needs per-call inspection (the broker permission bridge) — see 5.4.
3. **`bypassPermissions` skips the bridge.** Path/pattern enforcement only works in gated
   modes → restricted agents must pin a gated permission mode (see 4.8 / 5.4).

## 4. Decisions (all settled)

| # | Decision | Choice |
|---|----------|--------|
| 4.1 | Terminology | User-facing **"Agent"**; rename CC subagents → `subagents` in code |
| 4.2 | Profile/model relationship | **Orthogonal + optional pin** (agent may pin model/effort, still overridable) |
| 4.3 | v1 capabilities | **All five**: system prompt, tool access, skills, optional model/effort pin, filesystem scope |
| 4.3b | Prompt mode | **Per-agent `append` (default) or `replace`** — maximally customizable |
| 4.4 | Switching scope | **Per-chat only**; other chats unaffected |
| 4.4b | New-chat default | Every new chat opens with a single designated **default agent** |
| 4.5 | Seed agents | **Curated set** (Assistant=default, Software Engineer, Reviewer), all editable/deletable |
| 4.6 | Protocol/wiring | New commands + per-turn attribution (spec in §5.3/§5.5) |
| 4.7 | UI surface | **Agent pill in the composer** (next to model/effort) + **"Agents" editor screen in web UI** |
| 4.8 | Enforcement | Tool gating **both** (remove + pattern-gate); **agent owns permission mode**; skills **via settings**; fs-scope **broker path filter** |
| 4.9 | Conversation UI | **Group chat**: per-turn attribution, **full avatar** (icon + name + accent color), **persisted to disk** |
| 4.9b | Icon source | **Built-in SVG set + custom SVG** |
| 4.10 | Live-edit timing | **Hot-apply when idle** (respawn immediately if not mid-turn; else next message) |
| 4.11 | Avatar/color | **Auto-assigned on create, user-editable** |
| 4.12 | Default "Assistant" | **Light persona** with rich, *true* environment context (phone/app/`/sdcard` toggle) — see §7.1 |
| 4.13 | Per-cron-job agent | **Yes**, add `agentId` to jobs; null → **default agent** (§7.2) |
| 4.14 | Subagents | **Both** (built-ins + our personas) projected via `--agents`; **all agents always** available; namespaced to avoid collision (§7.3) |

## 5. Implementation specification

### 5.1 Agent definition (`agents.json`)
Stored in `<stateDir>/agents.json`, seeded from a `DEFAULT_AGENTS` const + loaded by a new
`AgentStore` (mirrors `ProfileStore` in `profiles.js`). Shape:

```jsonc
{
  "id": "software-engineer",      // stable id
  "label": "Software Engineer",   // display name (the group-chat speaker name)
  "description": "Edits code within the projects folder", // short; used for the subagent registry (§7.3) + UI
  "isDefault": false,             // exactly one agent has true (new-chat default)
  "promptMode": "append",         // "append" | "replace"
  "systemPrompt": "You are a ...",// text fed to --append-system-prompt or --system-prompt
  "tools": null,                  // null = all; or explicit available-tool whitelist (--tools)
  "allowedTools": ["Bash(git *)"],// auto-approved patterns (--allowed-tools)
  "disallowedTools": ["Bash(rm *)"], // denied patterns (--disallowed-tools)
  "skills": null,                 // null = all; or ["deep-research", ...] (via settings, §5.4)
  "permissionMode": "default",    // agent-owned posture; gated if it has restrictions
  "pinnedModel": null,            // null = use runtime model; or "opus"
  "pinnedEffort": null,           // null = use runtime effort; or "high"
  "fsScope": null,                // null = no scope; or { roots: ["<projectsDir>"] }
  "icon": { "kind": "builtin", "value": "wrench" }, // or { kind:"svg", value:"<svg.../>" }
  "accentColor": "#4f9cff"
}
```

Validation rules: exactly one `isDefault`; deleting the default reassigns it; an agent with
`fsScope` or `disallowedTools` is forced to a gated `permissionMode` at spawn (warn in editor
if user sets bypass).

### 5.2 Spawn-arg mapping (in `engines/claude-code.js` `_spawn()`)
The engine gains agent fields (passed via `createEngine` from `session.js`). New args appended
near the existing `--model`/`--effort` block (`claude-code.js:84-89`, inside `_spawn()` at :71):
- `promptMode==="append"` → `--append-system-prompt <systemPrompt>`; `"replace"` → `--system-prompt`.
- `tools` → `--tools <list>` when not null.
- `allowedTools` / `disallowedTools` → `--allowed-tools` / `--disallowed-tools`.
- `skills` → write a per-spawn settings JSON enabling only those skills; pass via `--settings`
  (compose with the existing ultracode `--settings`). (Verify exact settings key for skill
  enablement during build; fallback = disallow the `Skill` tool when `skills:[]`.)
- `permissionMode` → already handled; agent value overrides the global default for that session.
- `fsScope` → no CLI flag; enforced in the permission bridge (§5.4). Optionally also set the
  session `cwd`/omit `--add-dir` so the scope root is the natural working dir.
- **subagent projection** → at spawn, build `--agents <json>` from ALL agent defs (§7.3):
  `{ "<namespacedId>": { description, prompt (per promptMode), tools, model } }`. Additive —
  built-in subagents stay available.
- `pinnedModel`/`pinnedEffort` → resolved in `session.js` (runtime pick > agent pin > profile
  default), mirroring the existing `chosen = model || ... || profile.model` logic at `session.js:173`.
- **Second spawn site to mind:** `_warmCapabilities()` (`claude-code.js:~216`) spawns a
  short-lived probe to emit the skills/commands/subagents palette without costing a turn. If an
  agent restricts skills (via `--settings`), the probe should apply the same settings or the
  capability surface (Manage tab) will list skills the active agent can't actually use.

### 5.3 Per-turn attribution (the group-chat backbone)
- `session.js` tags every assistant event it emits for a turn with the active agent's
  `{agentId, agentName, icon, accentColor}` (it knows the agent — it set it at spawn).
- **Persistence:** a sidecar per session (e.g. `<session folder>/agent-turns.json`, written
  next to how `sessionId` is persisted today) maps turn boundaries → agentId. On
  resume/reconnect the broker replays history with attribution intact (survives UI reload,
  resume, broker restart). The agent *definition* (name/icon/color) is resolved from
  `agents.json` at render time by `agentId`, so renaming/recoloring an agent updates old
  turns' display too (only the id is stamped per turn).
- Edge case: an agent deleted after it spoke → fall back to its last-known name/icon stored
  alongside the turn, or a generic "Agent (removed)".

### 5.4 Enforcement details
- **Tool gating (both):** whole-tool removal via `--tools`/`--disallowed-tools`; fine-grained
  via the broker permission bridge auto-denying calls that match `disallowedTools` patterns or
  don't match `allowedTools`.
- **FS scope (broker path filter):** extend `_onPermission` / the permission bridge
  (`engines/claude-code.js` + the permission server) to inspect `Edit`/`Write`/`MultiEdit`
  file paths and `Bash` command targets; auto-deny anything outside `fsScope.roots`. Only
  consulted in gated modes — hence the forced-gating rule.
- **Skills (via settings):** compose `--settings`/`--setting-sources` at spawn so only the
  agent's skills load (CLI scans skills once at init; a respawn re-runs init, so a switch
  re-applies the set — consistent with the documented init-only behavior).

### 5.5 Protocol additions (`protocol.js`)
Events (broker→UI):
- `AGENTS` — `{ agents: [<defs>], activeAgentByKey: { <sessionKey>: agentId } }`.
- Extend existing assistant/message events with `agentId` (+ resolved name/icon/color) for
  per-turn attribution (§5.3).
- Rename the existing `CONFIG { kind:'agents' }` → `kind:'subagents'`.

Commands (UI→broker):
- `SWITCH_AGENT` — `{ agentId }` → set the active agent for the **current** session and
  respawn (hot-apply when idle; defer to next turn if busy) via `startEngine`.
- `AGENT_SAVE` — `{ agent }` (create/update), `AGENT_DELETE` — `{ id }`,
  `AGENT_SET_DEFAULT` — `{ id }`. All persist to `agents.json` and re-emit `AGENTS`.
- Extend `CRON_CREATE`/`CRON_UPDATE`/`CRON_JOBS` with `agentId` (§7.2); null → default agent.

### 5.6 UI (`web-ui/`)
- **Composer pill:** add an agent pill in `.composer-actions` beside `.model-pill`
  (`index.html:150`); `onchange` → `send({type:'switch_agent', agentId})`.
- **Group-chat rendering:** replace the hardcoded label at `app.js:997`
  (`el('div','role','Agent')`) with the per-turn agent's avatar (icon + accent color) + name;
  consecutive same-agent turns can collapse the header like a messaging app.
- **Agents editor screen:** a new web-UI view listing agents with create/edit/delete/set-default
  and a form for every field in §5.1 (prompt + mode toggle, tool allow/deny, skills multiselect,
  optional model/effort pin, fs-scope folder picker, icon picker [built-in grid + custom SVG
  paste], accent color).

## 6. Build phasing

0. **Precondition for cross-engine work.** Complete the multi-engine feature
   declaration and per-session state work first. If this feature is intentionally
   implemented earlier, keep the implementation under a Claude-specific mapper
   boundary so Codex/opencode are not forced through Claude flags or `.claude`
   config assumptions.
1. **Data + spawn core.** `AgentStore` + `agents.json` + `DEFAULT_AGENTS`; thread agent fields
   through `createEngine`→`_spawn()` (prompt, tools, model/effort pin, permission mode). Manual
   JSON editing works end-to-end before any UI.
2. **Switching.** `SWITCH_AGENT` command + per-session active-agent tracking + hot-apply respawn;
   `AGENTS` event. Verify mid-session swap keeps history (`--resume`) and applies new prompt.
3. **Group-chat attribution.** Per-turn `agentId` stamping + sidecar persistence + UI avatar/name
   rendering (`app.js:997`). Verify history survives reload/resume/restart.
4. **Enforcement.** Tool gating (remove + pattern); fs-scope path filter in the permission bridge;
   forced-gating rule. Test a scoped agent can't edit outside its roots.
5. **Skills.** Per-agent skill set via settings (with disallow-Skill fallback).
6. **Subagent projection.** Build `--agents` JSON from all agent defs at spawn (namespaced);
   keep built-ins. Verify the main agent can delegate to a persona via the Task tool.
7. **Cron integration.** Add `agentId` to cron jobs (`cron.js` create/update + `CRON_JOBS`),
   pass into the detached `startEngine`; default-agent fallback; agent picker in the cron editor.
8. **Editor UI.** Composer pill + full Agents management screen + icon/color pickers.
9. **Polish + docs.** Update `docs/features.md` (new subsystem), `docs/architecture.md`
   (protocol/session model), `docs/claude-cli-behaviors.md` (--agents/--settings findings),
   `protocol.js` comments; verify with `npm run uishot` + `npm test`.

## 7. Follow-up topics (in discussion, 2026-06-28)

### 7.1 Seed agent definitions — [DECIDED]

**Assistant (default) — [DECIDED: "light persona" with rich environment context].** No tool
restrictions, all skills, default permission mode, no model pin, no fs-scope. `promptMode:
append`. Its prompt must be **TRUE** (a false claim misleads every session). The broker
templates real values (e.g. `{projectsDir}`) at spawn. Draft prompt:

```text
You are running inside mobile-agent, an app that puts a full Claude Code workflow on a phone.

- You're on a phone, not a desktop. The app is sideloaded on an Android device; a Node
  "broker" runs inside a Termux → proot-Debian guest on the device, drives the `claude` CLI
  (you), and serves a web UI shown in the app's WebView. Don't assume a specific phone model.
- Filesystem: your working area is in the Linux guest (projects live under {projectsDir}).
  The phone's own files (photos, downloads, documents…) are mounted at /sdcard — but ONLY
  when the user has enabled the "All files access" toggle in the app's runtime tab. If
  /sdcard looks empty or inaccessible, that toggle is likely off; say so rather than
  assuming the files are gone.
- It's a real phone: be mindful of battery, memory, and that heavy/long-running commands
  cost real device resources. Output renders in a mobile WebView — keep replies scannable.
- The user can switch which agent (persona) handles the conversation at any time, even
  mid-chat, so the thread may read like a group chat with several agents.

Be a helpful, general-purpose assistant; you have full tool access unless a more specialized
agent is selected.
```

**Software Engineer — [DECIDED].** `promptMode: append`; `fsScope.roots = [{projectsDir}]`
(can only edit inside the projects folder); `permissionMode: acceptEdits` (gated, so fs-scope
is enforced); dev-oriented tools (all the default coding tools; no restriction needed beyond
fs-scope for v1); all skills. Prompt: a concise "careful software engineer working in this
repo; match surrounding code; build/test on-device per the repo's docs" persona that builds on
the Assistant's environment context (or restates the key facts since append stacks on stock,
not on the default agent).

**Reviewer — [DECIDED].** `promptMode: append`; **read-only** — `disallowedTools:
["Edit","Write","MultiEdit","NotebookEdit","Bash(rm *)","Bash(git commit *)","Bash(git push *)"]`
(or `tools` limited to read/search + safe Bash); `permissionMode: default` (gated). Prompt: a
"review code for correctness/security/clarity; do not modify files, only report findings"
persona. Pairs naturally with being spawned as a subagent (§7.3).

> Open during build: exact tool lists per the verified tool names; whether to express Reviewer
> as a `--tools` allowlist vs a `--disallowed-tools` denylist (§8).

### 7.2 Per-cron-job agent — [DECIDED]
**Clean extension** — `controls/cron.js` already stores per-job `profileId/model/effort`
(`cron.js:192/225`, null = use active defaults) and `CRON_CREATE`/`CRON_UPDATE` already carry
those. Add `agentId` the same way: store on the job (`create`/`update`), include in the
`CRON_JOBS` event, and pass into `startEngine` when the job runs (the cron runner already
builds a detached session). UI: an agent picker in the cron editor next to the existing
engine/model/effort pickers.
- **Null-agent fallback — [DECIDED]: the designated default agent.** A job with no pinned
  agent runs under the default agent (predictable for scheduled/detached runs; matches
  new-chat behavior). *(Note: this intentionally differs from how cron's `profileId/model/effort`
  null means "active defaults" — agent null means the **default agent**, since "active" is
  ill-defined for a scheduled run.)*

### 7.3 Choosing subagents for delegated tasks — [DECIDED]
When the main agent uses the **Task tool** to delegate, it picks a `subagent_type`. The CLI
exposes `--agents <json>` = a per-session custom subagent registry
(`{name:{description, prompt, tools?, model?}}`).
- **[DECIDED: both]** Keep Claude Code's built-in subagents (Explore, Plan, general-purpose,
  the project `reviewer.md`…) AND make our Agent personas spawnable as subagent types.
- **[DECIDED: all always]** Every defined Agent is always projected into `--agents` at spawn
  (no per-agent whitelist field needed). Each projected entry = `{ description, prompt
  (resolved per promptMode), tools, model }` from the agent definition.
- **Naming collision (subagent level):** our persona ids can clash with built-in subagent
  names (e.g. our `Reviewer` vs the built-in `reviewer.md`). Project our personas under a
  **distinct namespace** (e.g. id `agent:reviewer` or the exact label) so both remain
  selectable and neither is silently shadowed. (Decide the prefix during build, §8.)
- **Enforcement caveat:** `--agents` natively supports prompt/tools/model only — NOT our
  broker fs-scope or pattern-gating. Subagent tool calls still route through the permission
  bridge, but it can't yet tell which persona a subagent is. **v1: subagents get
  prompt + tools + model; fs-scope/pattern-gating for subagents is deferred to v2.**

## 8. Open items to verify during build
- Exact `--settings` key (or `--setting-sources`) that enables/disables specific **skills**;
  fallback is coarse Skill-tool disallow.
- Whether `--tools` vs `--disallowed-tools` is the cleaner removal lever in practice.
- Bash command path-extraction heuristics for fs-scope (commands can touch many paths).
- Renaming `CONFIG kind:'agents'`→`'subagents'` — concrete call sites (re-verified
  2026-06-28): `protocol.js:57`, `server.js:461` (`RESCAN_KINDS`), `controls/claude-config.js`
  (:18, :142, :267, :476, :520, :530, :636), `web-ui/managers.js` (:25, :217, :274, :396, :425,
  :451, :467, :481). **Note:** `managers.js:25` is the *existing user-facing* "Agents" Manage tab
  (for CC subagents) — retitle it to **"Subagents"** so it doesn't clash with the new top-level
  Agent feature. **Do NOT rename the on-disk `.claude/agents/*.md` directory** — that's Claude
  Code's own format; only the internal config-kind label and the UI tab title change.
- Subagent-registry namespace prefix that keeps our personas from shadowing built-in
  subagents of the same name (our `Reviewer` vs `.claude/agents/reviewer.md`) (§7.3).
- Broker templating of `{projectsDir}` (and any other real env values) into seed-agent
  prompts at spawn so the default Assistant's environment claims stay TRUE (§7.1).
