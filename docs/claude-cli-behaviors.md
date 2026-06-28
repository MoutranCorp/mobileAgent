# Claude Code CLI behaviors the broker depends on

Load-bearing, non-obvious facts about the `claude` CLI in headless `--print
--input-format stream-json` mode. The broker is built on top of these; if the
CLI ever changes one, the listed broker site is where it breaks. Treat
[`broker/src/protocol.js`](../broker/src/protocol.js) and the engine/control
files cited below as ground truth over this prose.

The headless invocation the broker uses (see
[`broker/src/engines/claude-code.js`](../broker/src/engines/claude-code.js)
`_spawn`):

```
claude --print --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --replay-user-messages \
       [--model X] [--effort L] [--resume ID] --permission-mode <mode> \
       [--permission-prompt-tool mcp__broker__permission_prompt --mcp-config FILE]
```

The CLI authenticates with the user's Max/OAuth subscription — no API key, no
metered billing. All stream-json parsing is confined to the engine file; only
canonical events ([`protocol.js`](../broker/src/protocol.js)) cross the boundary.
For the full event surface see [`claude-code-surface.md`](./claude-code-surface.md).

## 1. Model alias resolution is account/entitlement-dependent

`claude --model opus` on a plan **without** Opus access is silently substituted,
and the `system/init` event's `model` field reports the **substituted** id (e.g.
a `sonnet` id), not what you asked for. So you cannot trust `init.model == requested alias`.

WHY it matters: labelling `opus` from a substituted sonnet id produced two
entries both reading "Sonnet 4.6" — the duplicate-model-picker bug.

WHERE it's handled:
[`broker/src/controls/model-resolver.js`](../broker/src/controls/model-resolver.js).
Before caching or labelling a resolved id, `familyMatches(alias, id)` checks the
family token (`opus|sonnet|haiku|fable`) of the alias against the id. A
known-family alias must resolve to the **same** family or the id is rejected
(`observe`/`_resolveAll`); `labelFor` falls back to the capitalized alias
(`Opus`) so the picker still shows a distinct entry. Aliases with no family
token (`glm-5.2`, `mock-1`) resolve verbatim. Friendly labels ("Opus 4.8") are
derived from the id at runtime, never hardcoded; results cache to
`<stateDir>/models.json`.

## 2. `system/init` is emitted at startup, before any stdin

In stream-json input mode the CLI emits `system/init` immediately on spawn,
**before** reading any user message. So you can spawn, read `init.model`, and
kill the process to resolve a model id **for free** — no tokens spent.

WHERE: `ModelResolver._resolveOne` spawns `claude ... --model <alias>`, reads the
first `{type:"system", subtype:"init"}` line, then `SIGKILL`s the process. Live
engines also feed resolutions back for free via `server.js` calling
`modelResolver.observe(currentModel, ev.model)` on the init capabilities event.

Exception: if `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` is set, the CLI may block on
plugin syncing before `init`, so the read-then-kill probe is not instant. The
broker never sets this env var anywhere — it's noted here only as a caveat to be
aware of if a future change introduces plugin syncing into the probe path.

## 3. Capabilities are scanned ONLY at `system/init` — no hot-reload

`.claude/skills`, `.claude/commands`, `.claude/agents`, `.claude/output-styles`,
and configured MCP servers are scanned **once**, at `system/init`. A long-lived
stream-json session does **not** hot-reload them. The init payload carries the
whole capability surface (`slash_commands`, `agents`, `mcp_servers`, `tools`,
`output_style`, `plugins`, `plugin_errors`, `apiKeySource`, `permissionMode`),
re-broadcast by `_handleSystem` in the engine as a `capabilities` event.

WHY/WHERE it matters: creating or editing one of these mid-session requires
**re-spawning** the engine so a fresh init re-scans. The broker resumes the same
conversation across the respawn with `--resume <sessionId>` to preserve context.
- The set of init-only kinds is `BrokerServer.RESCAN_KINDS = {skills, commands,
  agents, output-styles, mcp}` in
  [`broker/src/server.js`](../broker/src/server.js). After writing/deleting one,
  `_rescanIfHarness` calls `session.refreshCapabilities()`.
- `refreshCapabilities` (in [`broker/src/session.js`](../broker/src/session.js))
  re-starts the engine with the current `resumeId`, but only when the engine is
  live and idle (it skips mid-turn).
- Caveat: `--resume` restores model context but does **not** re-emit past turns
  to the stream, so the broker replays stored history itself
  (`ClaudeConfig.readSessionTranscript`) to avoid a blank-looking resumed session.
- For **plugins** specifically, `/reload-plugins` re-scans without a full respawn.

## 4. Skills vs. commands vs. plugins — all surface as `/<name>`

- **Skills** (`.claude/skills/<name>/SKILL.md`) are invocable as `/<skill-name>`
  and are also auto-invoked by the model from their `description`, unless the
  frontmatter sets `disable-model-invocation`. The broker writes that key (and
  `user-invocable`) when authoring skills — see `ClaudeConfig.write('skills', …)`
  in [`broker/src/controls/claude-config.js`](../broker/src/controls/claude-config.js).
- **Commands** (`.claude/commands/<name>.md`) are the legacy flat form. Both
  skills and commands produce a `/<name>` slash command in `init.slash_commands`.
- **Plugins** install via the CLI's own slash commands, then need a reload
  (they are scanned at init, per fact 3):
  1. `/plugin marketplace add <git-url-or-owner/repo>`
  2. `/plugin install <name>@<marketplace>`
  3. `/reload-plugins` (or restart the session)

  `init.plugins` lists loaded plugins; load failures appear in `plugin_errors`.
  The web UI drives exactly this flow (`renderPluginInstall` in
  [`broker/web-ui/managers.js`](../broker/web-ui/managers.js)), sending the
  `marketplace add` / `install` slash commands and a `reload-plugins` button.

## AskUserQuestion (agent → user question forms)

The headless CLI does **not** expose the built-in `AskUserQuestion` tool, so the
broker provides its **own** equivalent as an MCP tool — `mcp__broker__AskUserQuestion`
(see `mcp/permission-server.js` `ASK_TOOL`). The broker MCP server is now started
in **every** permission mode (not just gated/`default`), since the on-device
default is `bypassPermissions`; `--permission-prompt-tool` is still only added in
gated mode. Flow:

1. Agent calls `mcp__broker__AskUserQuestion { questions }`.
2. `permission-server.js` forwards it to the bridge as `{ kind:'question' }`;
   `permission-bridge.js` routes it to the engine's `_onQuestion`, which emits a
   `QUESTION_REQUEST` event and returns a pending Promise.
3. The UI renders the form (`onQuestionRequest` → `renderQuestionForm`) and on
   submit sends `QUESTION_RESPONSE { id, answers }`.
4. `engine.respondQuestion` resolves the Promise; the bridge writes the answer
   back; the MCP tool returns it as the tool result — so the **MCP result IS the
   answer**, no control-protocol guessing needed.

The `_handleStreamMessage` `case 'control_request'` (verbatim logging) remains as
a diagnostic for any *other* inbound control message, but the question flow no
longer depends on it.

## Auth: `claude setup-token`, the credentials file, and env-token precedence

On-device sign-in uses `claude setup-token` (driven natively — see
[on-device-runtime.md](on-device-runtime.md) for the PTY mechanics). Behaviors the
broker depends on:

- **`setup-token` is an interactive `ink` TUI**, not pipe-friendly: over a plain pipe
  it block-buffers stdout (the OAuth URL never prints) and won't accept input. It
  needs a real PTY, and Enter is **carriage return (`\r`)**, not `\n`.
- **It writes credentials to `~/.claude/.credentials.json`** — the source of truth for
  the default (Max/OAuth) endpoint.
- **A `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` env var OVERRIDES the file** and
  is sent as a bearer token; a stale/empty one → `API Error: 401 Invalid bearer
  token`. So `engines/claude-code.js` **drops those env vars at spawn when the
  credentials file exists** (and not on an alt endpoint). When *deliberately* using a
  token instead (in-app paste, no `setup-token`), there's no creds file, so it's kept.

## Verifying these against the repo

- Engine / init handling: `broker/src/engines/claude-code.js` (`_handleSystem`,
  `_spawn`).
- Model family logic: `broker/src/controls/model-resolver.js`
  (`familyMatches`, `labelFor`, `_resolveOne`).
- Respawn-on-resource-change: `broker/src/server.js` (`RESCAN_KINDS`,
  `_rescanIfHarness`) and `broker/src/session.js` (`refreshCapabilities`).
- Tests: run `npm test` in `broker/` (do not trust hardcoded counts in older
  docs).
