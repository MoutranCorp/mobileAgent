# Claude Code surface — implementation reference

Authoritative notes (researched 2026-06) the broker + UI implement against. Sources:
code.claude.com/docs (headless, slash-commands, sub-agents, skills, plugins,
settings/permissions, memory, costs) + Anthropic streaming docs.

## stream-json output events (`claude -p --output-format stream-json --verbose [--include-partial-messages]`)

Each line is one JSON object. Top-level `type`:

- **`system`**
  - `subtype:"init"` — fields: `session_id`, `model`, `tools[]`, `mcp_servers[]`
    (`{name,status}`), `slash_commands[]`, `agents[]`, `cwd`, `permissionMode`,
    `apiKeySource`, `output_style`, `plugins[]`, `uuid`.
  - `subtype:"compact_boundary"` — `{compact_metadata:{trigger, pre_tokens}}`.
    Marks where history was summarized (auto-compact or `/compact`).
  - `subtype:"api_retry"` — `{attempt, max_retries, retry_delay_ms, error}`.
- **`assistant`** — `{message:{content:[blocks], usage}, parent_tool_use_id?}`.
  Block types: `text`, `thinking`, `redacted_thinking`, `tool_use`,
  `server_tool_use`, `web_search_tool_result`, `mcp_tool_use`.
- **`user`** — `{message:{content:[tool_result|text]}, parent_tool_use_id?}`.
- **`stream_event`** (only with `--include-partial-messages`) — wraps an Anthropic
  streaming event in `.event`: `message_start`, `content_block_start`,
  `content_block_delta` (delta types: `text_delta`.text, `thinking_delta`.thinking,
  `input_json_delta`.partial_json, `signature_delta`.signature,
  `citations_delta`.citation), `content_block_stop`, `message_delta` (cumulative
  `usage.output_tokens`, `stop_reason`), `message_stop`, `ping`, `error`.
- **`result`** — `{subtype:"success"|"error_max_turns"|"error_during_execution",
  total_cost_usd, usage{input_tokens,output_tokens,cache_*}, duration_ms,
  duration_api_ms, num_turns, result, session_id, permission_denials[], is_error}`.

**Double-emit hazard:** with `--include-partial-messages` the CLI streams deltas
**and** then sends a terminal `assistant` message with the FULL content. Stream
the deltas; treat the terminal `assistant` as commit-only (dedupe text/thinking).
For `tool_use`, the adapter surfaces the call at `content_block_start` (ephemeral
`tool_call` with `streaming:true`), streams `input_json_delta.partial_json` as
ephemeral `tool_delta`s, then the terminal `assistant` re-emits the SAME id as the
recorded finalize (full input). UI: block-start creates the card, deltas grow the
preview, finalize swaps in the rendered diff. Tool-result `content` may include
`image` blocks (base64/url) — emit them as `tool_result.images`, not flattened text.
`message_delta.stop_reason` other than end_turn/tool_use/stop_sequence is surfaced
as a `log` note (truncation/refusal/pause).

**Subagents:** the `Task` tool was renamed **`Agent`** (v2.1.63+; `Task` still an
alias — accept both). Nested subagent turns carry `parent_tool_use_id` linking
them to the parent Agent/Task tool_use → render nested/indented.

**Interrupt** (stream-json input mode): send a control message, don't SIGINT —
`{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}`.

**Slash commands in headless `-p`:** sending `/cmd args` as the user message text
auto-expands and runs (no special marshaling). So `/compact`, `/clear`,
`/skill-name`, `/command` all work via a normal `user_message`.

## File formats (project `.claude/` or user `~/.claude/`)

- **Skill** — `.claude/skills/<name>/SKILL.md`: YAML frontmatter
  (`name`,`description`,`allowed-tools`,`disallowed-tools`,`model`,`argument-hint`,
  `disable-model-invocation`,`user-invocable`,`context: default|fork`,`agent`) +
  markdown body. Args: `$ARGUMENTS`,`$1`,`$name`. `!`cmd`` injects shell output.
- **Subagent** — `.claude/agents/<name>.md`: frontmatter
  (`name`,`description`,`tools`,`disallowedTools`,`model`,`permissionMode`,
  `maxTurns`,`skills`,`memory`,`isolation: worktree`,`color`) + system-prompt body.
- **Slash command (legacy)** — `.claude/commands/<name>.md`: frontmatter
  (`description`,`argument-hint`,`allowed-tools`,`model`) + body. Filename → `/name`.
- **Settings/permissions** — `.claude/settings.json` /`settings.local.json`:
  `{permissions:{defaultMode, allow[], deny[], ask[], additionalDirectories[]}}`.
  Rule order: **deny → ask → allow**. Specifiers: `Bash(npm run test:*)`,
  `Read(./src/**)`, `WebFetch(domain:example.com)`, `Agent(Explore)`, `mcp__srv__*`.
- **Memory** — scopes (precedence): managed → `~/.claude/CLAUDE.md` →
  `./CLAUDE.md` or `./.claude/CLAUDE.md` → `./CLAUDE.local.md` (gitignored).
  `@path` imports (≤4 deep). Auto-memory index at
  `~/.claude/projects/<proj>/memory/MEMORY.md`. `#` shortcut adds a memory.
- **Plugin** — `.claude-plugin/plugin.json` + `marketplace.json`; bundles
  skills/commands/agents/hooks/mcp/output-styles.

## Permission modes

`default` (prompt first use), `acceptEdits` (auto-approve edits + safe fs),
`plan` (read-only, then ask), `bypassPermissions` (= `--dangerously-skip-permissions`;
skips prompts except explicit `ask`/`rm -rf /`), plus `auto` and `dontAsk`.
`--permission-mode` is start-time; runtime switch is Shift+Tab / control protocol.
The broker's MCP `--permission-prompt-tool` gating is used in `default` mode; other
modes pass through to the CLI.

## Context

`/compact [focus]`, `/clear`, `/context`. Token usage: `message_delta.usage.output_tokens`
is **cumulative** (don't sum deltas). Context windows: 200K default, 1M for
`sonnet`/`opus`/`fable` `[1m]` variants. `compact_boundary` event marks summarization.
