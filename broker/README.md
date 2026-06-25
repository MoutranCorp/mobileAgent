# Agent broker

A Node service that turns a pluggable agent harness into a clean localhost
WebSocket API speaking one **canonical protocol**. This is the heart of the
system (Phase 1 of the plan) and the one piece that runs identically on a laptop
and on the phone.

```
UI  ──ws──▶  broker  ──stdio/http──▶  engine adapter ──▶ model API
                │
                └── controls: Metro · git · EAS · run · projects
```

## Run it

```bash
npm install

# Offline demo — no credentials, no proot, runs anywhere:
npm run dev                       # == node src/index.js --engine mock
# open http://127.0.0.1:8765/

# Real engine (needs the Claude Code CLI logged in on a Max plan):
node src/index.js --profile claude-max
```

Flags: `--port 8765` `--host 127.0.0.1` `--profile <id>` `--projects <dir>`
`--state <dir>` `--verbose`. Env equivalents: `BROKER_PORT`, `BROKER_HOST`,
`BROKER_PROFILE`, `PROJECTS_DIR`, `STATE_DIR`, `CLAUDE_BIN`, `PERMISSION_MODE`.

## The mock engine

`--engine mock` / `--profile mock` runs a fake harness that emits the exact same
canonical events as the real one — it even writes real files into the project
dir and drives the approval flow. It exists so the whole stack (protocol, UI,
tool cards, diffs, approvals, Test loop) is buildable and demoable with zero
credentials. The 13-test suite runs entirely against it.

```bash
npm test     # node --test; covers JSONL buffering, the mock engine, and the WS server end-to-end
```

## Canonical protocol (the stable contract)

Defined in [`src/protocol.js`](src/protocol.js). UIs only ever speak this; raw
harness shapes never leak past an adapter.

**Events (engine → UI):** `session_meta` · `capabilities` (init: slash commands,
agents, MCP servers, tools, permission mode, output style) · `status` ·
`assistant_text` · `assistant_thinking` · `user_echo` · `tool_call` · `tool_result`
(both tagged with `parentToolUseId` for subagent nesting) · `permission_request` ·
`permission_resolved` · `permission_denied` · `permission_mode` · `usage` ·
`context` (live window meter) · `compact` (context summarized) · `result` · `error`
plus broker-level `control_output` · `metro_status` · `git_status` · `projects` ·
`profiles` · `engine_state` · `config` (skills/agents/commands/memory/settings/sessions).

**Commands (UI → broker):** `user_message` · `slash_command` · `compact` / `clear` ·
`approve` / `deny` · `set_permission_mode` · `interrupt` · `new_session` / `resume` /
`list_sessions` · `switch_engine` · `switch_model` · `open_project` / `create_project`
/ `list_projects` · `config_list` / `config_read` / `config_write` / `config_delete`
(skills · agents · commands · memory · settings) · `start_metro` / `stop_metro` ·
`git` · `eas_build` · `run` · `hello` · `ping`.

### Full Claude Code stream coverage

The `claude-code` adapter runs with `--include-partial-messages` for true
token-by-token deltas and maps the **entire** stream surface: text, thinking
(+ redacted), `tool_use`/`server_tool_use`/`mcp_tool_use`, `web_search_tool_result`,
subagent (`Agent`/`Task`) nesting via `parent_tool_use_id`, `system/init`
capabilities, `compact_boundary`, `permission_denials`, and per-turn usage/context.
Approval gating uses the MCP `--permission-prompt-tool`, which **fails closed** if
the broker link drops (set `BROKER_FAIL_OPEN=1` to override). All four permission
modes (`default`/`acceptEdits`/`plan`/`bypassPermissions`) are switchable live; see
[docs/claude-code-surface.md](../docs/claude-code-surface.md).

### Harness config (managers)

`controls/claude-config.js` reads/writes the `.claude/` config so the UI offers
first-class managers: **Skills** (`.claude/skills/<n>/SKILL.md`), **Subagents**
(`.claude/agents/<n>.md`), **Slash commands** (`.claude/commands/<n>.md`),
**Memory** (CLAUDE.md across scopes), **Permissions** (settings.json allow/deny/ask),
and a **Sessions** browser (`~/.claude/projects/*.jsonl`) — each at project or user
scope.

### Durability & power features

- `controls/transcript.js` — records a coalesced, replayable copy of the event
  stream per project (`<stateDir>/transcripts/`), replayed on connect so reloads
  don't lose history.
- `controls/checkpoints.js` — non-destructive git snapshots (temp-index
  `commit-tree`) taken before every turn; `restore` rewinds tracked files and
  removes non-ignored files created since (confined to the project dir).
- `controls/files.js` — project file tree / read / fuzzy search (for `@`-mentions)
  / **content grep** / per-file **diff** (vs HEAD) / **write** (inline edit & .env)
  / git changed-files, skipping `node_modules`/`.git`/build dirs.
- `controls/prompts.js` — saved reusable prompts (`<stateDir>/prompts.json`).
- **Web preview:** the broker serves the active project at `/preview/*`
  (path-guarded) so static/SPA builds render in an iframe.
- **Multimodal:** `user_message` carries `images: [{ mime, dataBase64 }]`, sent as
  Anthropic image content blocks. Native-dep changes emit `native_change` to
  prompt an EAS dev-client rebuild. The agent's `TodoWrite` drives a live checklist
  in the UI.

> **Snapshot race note:** on loopback the server's initial snapshot can arrive in
> the same tick as the socket `open`. UIs must attach their message handler
> synchronously at socket creation **and** send `hello` on open to re-request a
> snapshot. The bundled web UI does both.

## Engines (pluggable brain)

| harness | adapter | notes |
|---|---|---|
| `claude-code` | [`src/engines/claude-code.js`](src/engines/claude-code.js) | Default. Spawns `claude --print --input-format stream-json --output-format stream-json --verbose --replay-user-messages`. Real approval flow via an MCP `permission_prompt` tool ([`src/mcp/`](src/mcp)). Alt endpoints (GLM via Z.ai) are a `baseUrl` + token change. |
| `opencode` | [`src/engines/opencode.js`](src/engines/opencode.js) | Conformance proof — a non-Claude harness rendering through the same events. Drives `opencode serve`'s HTTP/SSE API. |
| `mock` | [`src/engines/mock.js`](src/engines/mock.js) | Offline demo / test engine. |

Adding a harness = one adapter file + one line in
[`src/engines/index.js`](src/engines/index.js). The UI never changes.

Profiles are defined in [`src/profiles.js`](src/profiles.js) and editable at
`<stateDir>/profiles.json`. Secrets resolve from env (Keystore-injected on
Android) or `<stateDir>/secrets.json` (gitignored) — see
[`src/secrets.js`](src/secrets.js).

## Layout

```
src/
  index.js              entry
  server.js             WebSocket + static web UI, command routing
  protocol.js           canonical events/commands
  session.js            owns the active engine; engine/model switching + resume
  jsonl.js              line-buffered stream-json parser (the #1 custom-UI bug)
  config.js  profiles.js  secrets.js
  engines/              base · claude-code · opencode · mock · index
  controls/             process-runner · projects · devtools (metro/git/eas/run)
                        claude-config (skills/agents/commands/memory/settings/sessions) · frontmatter
  mcp/                  permission-server (stdio MCP, fail-closed) · permission-bridge (IPC)
web-ui/                 the bundled web client:
                        index.html · app.js (transcript/protocol) · managers.js (skills/agents/…/permissions)
                        diff.js · styles.css
test/                  node:test suite (jsonl · mock-engine · server · config)
```
