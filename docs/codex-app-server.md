# Codex App Server Integration Plan

Status: broker adapter implemented and smoke-tested against real Codex app-server
on Windows; Android/proot provisioning and native Codex auth/update controls are
implemented but still need phone runtime verification.

This is the delegation spec for adding Codex CLI as a first-class engine. The
repo now includes a `codex-app-server` profile/harness and a testable JSON-RPC
stdio adapter. The focused tests use a fake app-server child process, so they do
not require Codex to be installed or logged in.

## Sources

- Official Codex app-server docs: <https://developers.openai.com/codex/app-server>
- Official non-interactive mode docs: <https://developers.openai.com/codex/noninteractive>
- Official CLI reference: <https://developers.openai.com/codex/cli/reference>
- Official approvals/security docs: <https://developers.openai.com/codex/agent-approvals-security>
- Local probe on 2026-06-30: `codex-cli 0.142.4`
- Local schema command: `codex app-server generate-ts --out <tmp-dir>`
- Local real smoke on 2026-06-30: adapter start + one prompt returned
  `mobile-agent codex smoke`.

Regenerate schemas whenever the Codex CLI version changes. Do not hand-copy
generated schema files into the repo unless a test fixture explicitly needs a
small excerpt.

## Integration Choice

Use `codex app-server --stdio` for the broker adapter.

Why:

- App-server is the rich-client surface: threads, turns, items, approvals,
  conversation history, streamed deltas, and auth integration.
- `codex exec --json` is for scripts, CI, and one-shot automation. It is useful
  for fixtures and smoke tests, but it is not the right primary transport for
  this phone UI.
- The app-server WebSocket transport exists but is experimental/unsupported. It
  also adds auth/listener concerns that the broker does not need when it owns the
  child process. Prefer stdio on both Android/proot-Debian and Windows.

Transport detail:

- App-server stdio is JSONL JSON-RPC messages.
- The mobile-agent WebSocket protocol remains one JSON object per WebSocket
  message. Do not expose app-server JSONL directly to the UI.

## Cross-platform Requirements

The adapter must work in both supported shared-code runtimes:

- Android/proot-Debian: `codex` runs inside the guest, with Linux paths and the
  phone project directory layout.
- Native Windows: `codex.exe` or `codex` runs from PowerShell/Node, with Windows
  paths and the native Windows sandbox.

Implementation rules:

- Spawn Codex with `child_process.spawn(...)` argument arrays, never interpolated
  shell strings. Native Windows npm shims are special: the adapter resolves the
  npm-installed `@openai/codex/bin/codex.js` and spawns it with the current Node
  process because `spawn('codex')` can hit extensionless/WindowsApps shims that
  fail with `EPERM`/`EINVAL`.
- `CODEX_BIN` or profile `codexBin` can override the binary for unusual installs.
- Do not use shell interpolation.
- Pass `cwd` as an absolute path supplied by `ProjectManager`/session metadata.
- Use `path` and `os.tmpdir()` for any local files. Never hardcode `/tmp` in
  shared adapter code.
- Keep path strings opaque when relaying them to Codex; only normalize for local
  containment checks.
- Tests that assert paths must cover at least one Windows-style path and one
  POSIX-style path.

## Adapter Shape

The implemented harness is `codex-app-server`, behind the normal
`createEngine(profile)` dispatch. It does not route through Claude-only modules.

Feature declaration:

```js
{
  thinking: true,
  permissions: true,
  questions: true,
  resume: true,
  slashCommands: false,
  models: true,
  effort: true,
  appServer: true
}
```

The scaffold declares the implemented booleans above, plus `config: false`.
`appServer` is part of the base feature surface so other engines explicitly
report `false`.

## JSON-RPC Lifecycle

On adapter start:

1. Spawn `codex app-server --stdio`. Tests may override the binary and args to
   launch `broker/test/fixtures/fake-codex-app-server.mjs`; the production
   default remains `codex app-server --stdio`.
2. Read stdout line-by-line as JSON-RPC messages.
3. Send `initialize` with client info and app-server capabilities, then
   `initialized`.
4. Start or resume a Codex thread:
   - New: `thread/start`
   - Resume: `thread/resume`
5. Store the returned Codex `thread.id` as the engine session id.

Generated schema fields observed in `codex-cli 0.142.4`:

- `ThreadStartParams`: `model`, `cwd`, `approvalPolicy`, `approvalsReviewer`,
  `sandbox`, `config`, `baseInstructions`, `developerInstructions`,
  `personality`, `ephemeral`, and related fields.
- `ThreadResumeParams`: `threadId` plus similar overrides. The generated comment
  says to prefer `threadId` whenever possible.
- `TurnStartParams`: `threadId`, `input`, `cwd`, `approvalPolicy`,
  `approvalsReviewer`, `sandboxPolicy`, `model`, `effort`, `summary`,
  `personality`, `outputSchema`.
- `UserInput`: text, image URL, local image path, skill, and mention.
- `ServerRequest`: command/file/permissions approvals, tool user input, MCP
  elicitation, legacy exec/apply-patch approvals, dynamic tool calls, token
  refresh, and attestation.

## Broker Mapping

Session:

- Broker `sessionId` = Codex `thread.id`.
- Persist the harness with the session id. `sessions.json` must be able to
  distinguish Claude resume ids from Codex thread ids.
- If `resume` is unavailable or fails, surface a clear `ERROR`/toast and start a
  new thread only when the user requested a new session.

User message:

- `CommandType.USER_MESSAGE { text, attachments }` maps to `turn/start`.
- Text maps to `UserInput { type: 'text', text, text_elements: [] }`.
- Images should map to `localImage` when the broker has a local file path, or
  `image` when only a URL is available. Do not silently drop attachments.
- Broker `{ mime, dataBase64, name }` attachments are written to `os.tmpdir()`:
  images become `localImage`; text-like files become extra text inputs with the
  decoded content; binary files become a text note with the saved temp path.
  Temp files are cleaned up after turn completion or engine teardown.

Events:

- `thread/started` or thread-start response -> `SESSION_META`
- `turn/started` -> `ENGINE_STATE running`
- `item/agentMessage/delta` -> `ASSISTANT_DELTA`
- `item/reasoning/summaryTextDelta` / `item/reasoning/textDelta` -> `THINKING`
- `item/started` / `item/completed` for command/file/tool items -> canonical
  tool events/cards where possible
- `command/exec/outputDelta`, `process/outputDelta`, and related output deltas
  -> `TOOL_DELTA` or control-output style cards
- `thread/tokenUsage/updated` or turn completion usage -> `USAGE`
- `turn/completed` -> `RESULT` and `ENGINE_STATE idle`
- `error`, `warning`, `configWarning`, `deprecationNotice` -> `ERROR` or `TOAST`
  depending on severity

Current adapter coverage:

- JSONL JSON-RPC request/response/notification plumbing over stdio.
- `initialize` / `initialized`, `thread/start`, `thread/resume`, and `turn/start`.
- `item/agentMessage/delta` -> `ASSISTANT_TEXT`.
- reasoning text deltas -> `ASSISTANT_THINKING`.
- `turn/completed` -> `RESULT`, `USAGE`, and idle status.
- command/process output deltas and simple item start/completion mapping to
  canonical tool events.
- `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, and
  `item/fileChange/patchUpdated` mapping.
- `turn/interrupt` with the active Codex `turnId`.
  Capture the `turnId` from the `turn/start` response as well as the later
  `turn/started` notification; otherwise an immediate user interrupt can race
  before the notification is processed and no interrupt request is sent.
- The WebUI can send `switch_engine` and a prompt back-to-back. `SessionManager`
  must wait for a `starting` Codex engine to become `ready` before calling
  `send()`, or the prompt can hit the adapter before `thread/start` returns a
  session id.

Approvals/questions:

- Server requests include command execution approval, file change approval,
  permissions approval, tool user input, MCP elicitation, and legacy exec/apply
  patch approvals.
- Map approval requests to the existing permission card UI when they represent
  command/file/permission decisions.
- Map tool user input and MCP elicitation to the existing question flow where
  possible.
- Always answer the exact JSON-RPC request id. On interrupt/teardown, resolve or
  reject pending requests so the app-server child cannot hang forever.

The adapter maps app-server approval requests by exact generated method names,
not case-sensitive substring guesses. Responses use the generated shapes:
`{decision:'accept'|'decline'}` for command/file approvals, legacy
`{decision:'approved'|'denied'}` for old exec/apply-patch approvals, and
`{permissions, scope}` for permissions requests.

Tool user-input requests now stay pending until the UI sends
`QUESTION_RESPONSE`; responses are mapped to
`{ answers: { [questionId]: { answers: [...] } } }`. MCP elicitations are mapped
to the same question card where possible, with Accept/Decline/Cancel options.

## Permissions And Sandbox Mapping

Codex and Claude do not have the same permission model. The broker UI must show
engine-neutral labels and engine-specific detail.

Suggested mapping:

- Broker default/interactive mode -> Codex `approvalPolicy: 'on-request'` with a
  writable workspace sandbox.
- Broker read-only/plan-like mode -> Codex read-only sandbox.
- Broker bypass-like mode -> Codex `approvalPolicy: 'never'` plus the broadest
  sandbox explicitly selected by the user/profile. Treat this as dangerous.

Do not assume Claude `permissionMode` strings are valid Codex values. Put the
translation behind the Codex adapter or a per-engine permission mapper.

## Authentication

Codex app-server should reuse normal Codex CLI auth where possible.

- On Android/proot-Debian, auth lives inside the guest environment.
- On Windows, auth lives in the user's Windows Codex config/auth location.
- The Android Runtime tab now drives `codex login --device-auth`,
  `codex login --with-api-key`, `codex login status`, and a backfill-safe
  `npm install -g @openai/codex` install/update action inside the guest, so
  credentials live under `/root/.codex` and existing already-provisioned phones
  can add Codex without wiping the Debian environment.
- Existing broker state may have a stale `<stateDir>/profiles.json` created
  before Codex existed. `ProfileStore` merges missing built-in defaults on load,
  including `codex-app-server`, while preserving custom profile edits.
- Never write tokens into project files or broker transcripts.

## MVP Task List

1. Finish multi-engine feature declarations and per-session state.
2. Add a `codex-app-server` profile/harness. **Done.**
3. Implement a JSON-RPC stdio client with request id tracking and notification
   dispatch. **Scaffold done.**
4. Implement thread start/resume and turn start. **Scaffold done.**
5. Map agent/reasoning/command/file/tool deltas to the canonical protocol.
   **Core mapping done.**
6. Map approval and user-input requests. **Done for command/file/permissions
   approvals and tool user input; MCP elicitation has a best-effort form bridge.**
7. Add focused tests with a fake app-server process fixture. **Done.**
8. Add one optional real-Codex smoke path. **Done manually on Windows; keep it
   manual because it needs credentials and may consume quota.**

## Acceptance Gates

- Existing `cd broker && npm test` passes on Windows.
- New Codex adapter tests run without real Codex credentials by using a fake
  app-server JSON-RPC child.
- A manual real-Codex smoke test can start a thread, send one prompt, stream
  deltas, request/resolve an approval if triggered, and resume by thread id.
- UI controls degrade by `features`; no Claude-only Manage tabs or permission
  labels appear as if they are Codex-native.
