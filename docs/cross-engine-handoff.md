# Cross-Engine Handoff Implementation Plan

Status: planned.

Owner: next implementation agent.

Goal: switching a live session from Claude Code to Codex CLI, or back again, should preserve enough context that the new engine can continue the same work in the same project without the user manually restating the task.

This plan is intentionally detailed so it can be delegated to a medium-capability coding agent. Follow it in order. Keep Android/proot-Debian as the primary runtime and Windows as a first-class development/runtime target.

## Product Contract

The user-facing behavior should be:

- A tab has one visible conversation, one project, and one current working directory.
- The active engine can change during the tab lifetime.
- When the engine changes, the target engine receives deterministic context built from the canonical local session state before the next real user prompt is delivered.
- The visible transcript is not duplicated or replaced by a giant summary.
- If the target engine has no native remote thread for this tab, starting a fresh remote engine thread is acceptable as long as it is seeded with the local handoff context.
- If the user sends a message while an engine switch is in progress, the message waits until the target engine is ready and seeded.
- The target engine must run in the session project cwd, not the app repo cwd.

Non-goals for v1:

- Do not use an LLM to summarize the conversation.
- Do not attempt to reuse a Claude native conversation id in Codex, or a Codex thread id in Claude.
- Do not make the core session layer depend on Claude-specific config or Codex-specific config.
- Do not solve engine-neutral historical replay for every old session row. This plan handles active live tab handoff first.

## Current Code Shape

Read these files before editing:

- `broker/src/session.js`
- `broker/src/engineAdapter.js`
- `broker/src/engines/claude.js`
- `broker/src/engines/codexAppServer.js`
- `broker/src/transcriptStore.js`
- `broker/src/server.js`
- `broker/src/protocol.js`
- `broker/test/session*.test.js`
- `broker/test/codex*.test.js`

Important current behavior:

- `SessionManager` already keeps live engines in a `Map` keyed by `sessionKey`.
- `SessionManager.switchEngine(profileId)` currently starts the target engine without building or injecting a handoff context.
- `CodexAppServerEngine._threadStartParams()` currently sends cwd/model/sandbox/approval fields, but does not send a transcript-derived summary.
- `TranscriptStore.replay()` only replays the active session. It does not expose an explicit read API for an arbitrary session key.
- `server.js` dispatches `SWITCH_ENGINE` directly to `session.switchEngine(cmd.profileId)`.

## Handoff Packet

Add a deterministic packet produced by the broker from local state. Recommended new file:

- `broker/src/controls/handoff.js`

Use a plain object with a versioned schema:

```js
{
  version: 1,
  sessionKey: "workspace/path::tab-id",
  projectId: "project-id-or-null",
  cwd: "C:\\path\\to\\project",
  fromHarness: "claude-code",
  toHarness: "codex-app-server",
  createdAt: "2026-06-29T00:00:00.000Z",
  currentGoal: "short deterministic goal string or null",
  constraints: [
    "Android/proot-Debian is the primary runtime.",
    "Shared broker/web code must also work on Windows."
  ],
  recentTurns: [
    {
      role: "user",
      text: "latest user prompt",
      at: "2026-06-29T00:00:00.000Z"
    }
  ],
  filesChanged: [
    {
      path: "broker/src/session.js",
      reason: "mentioned by tool output or transcript event"
    }
  ],
  commands: [
    {
      command: "npm test",
      status: "failed",
      summary: "short tail or failure summary"
    }
  ],
  todos: [
    {
      text: "implement prompt queue during engine switch",
      status: "pending"
    }
  ],
  errors: [
    "Failed to start engine. No rollout found for thread id."
  ],
  openQuestions: [],
  provenance: {
    recordCount: 0,
    truncated: false,
    omittedSections: []
  }
}
```

Keep this schema JSON-serializable. Do not store functions, class instances, platform-specific path objects, or raw huge tool outputs.

## Deterministic Builder Rules

The handoff builder must be deterministic: same input records produce the same output except `createdAt`.

Inputs:

- Transcript records for the session key.
- Current project metadata, including cwd.
- Current active engine profile and target engine profile.
- Known session todos, tool events, and errors if available in canonical events.

Recommended public API:

```js
export function buildHandoffContext({
  sessionKey,
  project,
  fromProfile,
  toProfile,
  transcriptRecords,
  now = () => new Date()
}) {
  // returns packet
}

export function renderHandoffForEngine(packet, { targetHarness }) {
  // returns a compact text payload suitable for model context
}
```

Extraction rules:

- `cwd` must come from the session/project, never from `process.cwd()`.
- `currentGoal` should come from the latest substantial user request. Prefer the latest user message over assistant text.
- `recentTurns` should include the latest N user/assistant turns, in original order. Start with N = 12.
- `constraints` should be extracted from user text using simple stable patterns:
  - Sentences containing `must`, `should`, `do not`, `don't`, `never`, `always`, `primary runtime`, `Windows`, `Android`, `proot`, `APK`, `docs`, `tests`.
  - Preserve the original sentence text after trimming whitespace.
  - Deduplicate exact strings case-insensitively.
- `filesChanged` should come from canonical file events where available, otherwise from stable path-like matches in tool calls/results and assistant messages. Normalize separators for display with Node `path` APIs, but do not assume POSIX-only paths.
- `commands` should include command text and result status when the transcript has command/tool events. For failed commands, include a short deterministic tail. For successful commands, include only the command and a compact success marker.
- `todos` should include canonical todo events if available. If there is no structured todo source, leave it empty.
- `errors` should include protocol `ERROR` events, engine start errors, and visible config/runtime warnings.
- `openQuestions` should include unanswered direct questions from the latest user or assistant turns only if they are explicit.

Truncation rules:

- Keep the rendered handoff text under a conservative budget. Start with 12,000 characters.
- Never drop `cwd`, latest user goal, target engine identity, constraints, or errors.
- If over budget, drop in this order:
  1. Older successful command summaries.
  2. Older assistant prose.
  3. Older tool output details.
  4. Older user turns.
  5. Older file entries.
- Set `provenance.truncated = true` and append omitted section names.

Rendered handoff text should have stable headings and direct instructions:

```text
Cross-engine handoff context

You are continuing an existing local app session after an engine switch.
Do not treat this as a new project. Use the cwd below.

Session:
- cwd: ...
- previous engine: claude-code
- new engine: codex-app-server

Current goal:
...

User constraints:
- ...

Recent conversation:
[user] ...
[assistant] ...

Files and commands:
- ...

Known errors:
- ...
```

## Engine Seeding Contract

Extend `EngineAdapter` with an optional engine-neutral seed method:

```js
async seedContext(_handoff) {
  return { seeded: false };
}
```

Also add a capability flag:

```js
features: {
  contextSeed: true
}
```

Behavior:

- `seedContext` is called after the target engine process/thread is started and before the next user message is sent.
- The seed must not be shown as a normal user-authored chat message.
- If an engine cannot hide the seed from the visible remote transcript, it may send a clearly marked internal context message, but the local UI should not duplicate it as user text.
- If seeding fails, the switch should fail with a clear protocol error and leave the old engine usable when possible.

Codex implementation:

- Prefer app-server `thread/start` fields for static seed material where possible:
  - `baseInstructions`
  - `developerInstructions`
  - `summary`
- If Codex only accepts these at thread start, pass the rendered handoff into the first `thread/start` for new target Codex sessions.
- For resume of an existing Codex thread after intervening Claude work, use the best supported runtime seed path:
  - `turn/start.summary` if supported by the current app-server behavior.
  - Otherwise a hidden/internal seed turn before the real user turn.
- Add tests around `_threadStartParams()` and `_threadResumeParams()` so cwd and handoff fields cannot regress.

Claude implementation:

- Investigate the currently installed Claude Code CLI flags before implementing. Do not guess.
- If `--append-system-prompt` or an equivalent init-time context flag is available, use it for new Claude processes.
- If only prompt-level injection is available, use an internal seed prompt before the next real user prompt and suppress local transcript duplication.
- Preserve the existing Claude resume behavior for normal same-engine resume.

## Session Orchestration

Update `SessionManager.switchEngine(profileId)` to become a real handoff sequence:

1. Resolve the target profile.
2. Capture the current session key, project, cwd, active profile, and transcript records.
3. Build the handoff packet.
4. Stop or detach the current engine only after the target can be started, where practical.
5. Start the target engine with handoff startup options.
6. Call `targetEngine.seedContext(handoff)` if the startup path did not already seed it.
7. Mark the target profile active for the session.
8. Emit a compact system/status event for the UI, not a giant transcript entry.

Add a prompt queue or switch lock:

- `sendUserMessage()` must wait for any in-flight switch/seeding promise before sending.
- If the switch fails, the queued user message must not be silently lost.
- Add a test for `SWITCH_ENGINE` immediately followed by `USER_MESSAGE`.

Recommended implementation shape:

```js
this._switchPromiseBySessionKey = new Map();

async switchEngine(profileId) {
  const key = this.sessionKey;
  const promise = this._switchEngineLocked(key, profileId);
  this._switchPromiseBySessionKey.set(key, promise);
  try {
    return await promise;
  } finally {
    if (this._switchPromiseBySessionKey.get(key) === promise) {
      this._switchPromiseBySessionKey.delete(key);
    }
  }
}

async sendUserMessage(text, options) {
  const pendingSwitch = this._switchPromiseBySessionKey.get(this.sessionKey);
  if (pendingSwitch) await pendingSwitch;
  // existing send path
}
```

Adapt the exact code to the current `SessionManager` shape rather than forcing this snippet.

## Resume Store

The current resume model is not enough for seamless switching back and forth because each engine has its own native remote conversation id.

Add a per-harness resume record while preserving backwards compatibility.

Target shape:

```json
{
  "session-key": {
    "activeHarness": "codex-app-server",
    "resumes": {
      "claude-code": {
        "resumeId": "claude-native-id",
        "cwd": "C:\\project"
      },
      "codex-app-server": {
        "resumeId": "codex-thread-id",
        "cwd": "C:\\project"
      }
    }
  }
}
```

Migration requirements:

- Existing string records must continue to load.
- Existing object records shaped like `{ resumeId, harness, cwd }` must continue to load.
- New writes should use the per-harness shape.
- Reads should ask for a resume id by session key and harness id.
- If a target harness has no resume id, start a fresh native thread and seed it.

Do not block v1 handoff on perfect old-history rendering. The critical path is live tab switching.

## UI Behavior

Keep the UI small and explicit:

- Show the active engine/profile accurately after a switch.
- Do not render the full handoff text as a chat bubble.
- Add a compact status event such as `Switched from Claude Code to Codex. Context handoff applied.`
- If handoff failed, show the error and keep the composer usable.
- Model/effort/speed selectors must still reflect the target engine's available options after switching.

If UI code changes, run `npm run uishot` from `broker/`.

## Implementation Phases

### Phase 1: Transcript Read API and Handoff Builder

Files:

- `broker/src/transcriptStore.js`
- `broker/src/controls/handoff.js`
- `broker/test/handoff.test.js`

Tasks:

- Add a read-only API for records by session key.
- Build the packet schema.
- Implement deterministic extraction and truncation.
- Add fixture-style tests with mixed user, assistant, command, file, and error events.

Acceptance:

- Same fixture input produces deep-equal output when `now` is fixed.
- Windows paths and POSIX paths are both preserved sanely.
- Oversized transcript marks `provenance.truncated = true`.

### Phase 2: Engine Adapter Seed Contract

Files:

- `broker/src/engineAdapter.js`
- Existing fake/mock engine test utilities.
- `broker/test/session*.test.js`

Tasks:

- Add `seedContext` default method.
- Add `features.contextSeed`.
- Add a fake engine that records call order.
- Test that switch handoff seeds before the next real user message.

Acceptance:

- Existing engines still pass tests without implementing custom seed logic.
- Fake engine observes `start -> seedContext -> sendUserMessage`.

### Phase 3: Codex Seeding

Files:

- `broker/src/engines/codexAppServer.js`
- `broker/test/codex*.test.js`
- `docs/codex-app-server.md`

Tasks:

- Allow `start()` to receive handoff startup context.
- Include handoff context in `thread/start` fields when starting a new Codex thread.
- Include handoff context in `turn/start.summary` or equivalent when resuming an existing Codex thread after another engine has worked in the tab.
- Verify cwd is always the project cwd.
- Document the observed app-server behavior.

Acceptance:

- Unit tests assert `thread/start` includes cwd and handoff fields.
- Resume tests assert intervening handoff context is sent before the real prompt.
- No fallback uses `process.cwd()` as the project cwd.

### Phase 4: Session Switch Orchestration and Queueing

Files:

- `broker/src/session.js`
- `broker/src/server.js`
- `broker/src/protocol.js` if a new status event is needed.
- `broker/test/session*.test.js`

Tasks:

- Build handoff before replacing the active engine.
- Start and seed target engine.
- Add switch lock/prompt queue behavior.
- Emit compact switch status.
- Handle failure without dropping queued user text.

Acceptance:

- Switching engines in a live session preserves the session key and cwd.
- Back-to-back `SWITCH_ENGINE` and `USER_MESSAGE` sends the message only after seed completes.
- Failed seeding surfaces an error and does not silently mark the target engine active.

### Phase 5: Per-Harness Resume Records

Files:

- Search for current resume persistence helpers before editing.
- Likely `broker/src/session.js`, `broker/src/engines/*`, and related tests.

Tasks:

- Store resume ids by harness.
- Read old record formats.
- Write only the new format.
- Preserve same-engine resume behavior.
- When switching to a harness with no native resume id, start fresh and seed.

Acceptance:

- Migration tests cover string, old object, and new object records.
- Switching Claude -> Codex -> Claude can find both native ids when both exist.

### Phase 6: Claude Seeding

Files:

- `broker/src/engines/claude.js`
- `docs/claude-cli-behaviors.md`
- Claude adapter tests.

Tasks:

- Inspect Claude CLI help/output in the local environment.
- Implement the least invasive seed path.
- Document the exact CLI behavior discovered.

Acceptance:

- Claude can receive handoff context after a Codex-worked interval.
- Same-engine Claude resume behavior remains unchanged.

### Phase 7: UI Polish

Files:

- `broker/web-ui/app.js`
- `broker/web-ui/styles.css`
- UI tests or screenshot harness if needed.

Tasks:

- Display compact switch/handoff status.
- Keep engine/model/effort/speed controls in sync after switching.
- Ensure no full handoff blob renders as a user message.

Acceptance:

- `npm run uishot` exits zero.
- Phone-sized screenshot has no overlapping selector/status text.

### Phase 8: Real Android Runtime Verification

Files:

- `docs/development.md`
- `docs/on-device-deploy.md`
- `dist/app-debug.apk` only if native Android bundled assets or startup behavior changed.

Tasks:

- Run broker tests on Windows.
- Build Android APK if native code or bundled broker assets changed.
- On phone, test Claude -> Codex in a project and verify Codex identifies the correct cwd.
- On phone, test Codex -> Claude if Phase 6 is included.
- Update docs with any non-obvious runtime behavior.

Acceptance:

- `cd broker && npm test`
- `cd broker && npm run uishot` if UI changed.
- `.\gradlew.bat assembleDebug` if Android changed.
- Real-device smoke notes added to docs when verified.

## Delegation Slices

These slices can be given to separate agents, but merge in order because later slices depend on earlier contracts.

### Slice A: Handoff Builder

Prompt:

```text
Implement Phase 1 from docs/cross-engine-handoff.md. Add a deterministic handoff builder and transcript read API. Do not change engine behavior yet. Add focused node:test coverage for deterministic output, truncation, Windows/POSIX path handling, and error extraction. Update docs only if your implementation changes the planned API.
```

Review focus:

- No LLM calls.
- No platform-specific path assumptions.
- Output is stable under fixed time.

### Slice B: Seed Contract and Codex

Prompt:

```text
Implement Phases 2 and 3 from docs/cross-engine-handoff.md. Add the EngineAdapter seedContext contract and wire Codex app-server startup/resume seeding using supported app-server fields. Add tests that verify handoff context is sent before the first real user prompt and that cwd remains the project cwd. Update docs/codex-app-server.md with observed behavior.
```

Review focus:

- Codex receives context through app-server protocol, not visible UI duplication.
- Existing Codex tests still pass.
- Project cwd never falls back to the app repo cwd.

### Slice C: Session Switch Orchestration

Prompt:

```text
Implement Phase 4 from docs/cross-engine-handoff.md. Update SessionManager.switchEngine so it builds handoff context from the current local session, starts/seeds the target engine, queues any user prompt sent during the switch, and emits a compact status/error event. Add tests for successful switch, seed failure, and SWITCH_ENGINE immediately followed by USER_MESSAGE.
```

Review focus:

- No dropped user messages.
- Failed switch does not corrupt active engine state.
- The visible transcript is not filled with handoff text.

### Slice D: Resume Store and Claude

Prompt:

```text
Implement Phases 5 and 6 from docs/cross-engine-handoff.md. Migrate resume persistence to per-harness records with backwards-compatible reads, then add Claude handoff seeding using verified Claude CLI behavior. Preserve same-engine resume behavior. Update docs/claude-cli-behaviors.md with the exact behavior discovered.
```

Review focus:

- Existing resume records still load.
- Switching back to an engine uses that engine's native id when available.
- Claude implementation is based on inspected CLI behavior, not assumptions.

### Slice E: UI and Device Verification

Prompt:

```text
Implement Phase 7 and complete Phase 8 from docs/cross-engine-handoff.md. Add compact UI status for successful/failed handoff, keep engine/model/effort/speed controls synchronized after switching, run the UI screenshot harness, and document real Android/proot-Debian verification results. Rebuild and update dist/app-debug.apk only if native Android or bundled startup assets changed.
```

Review focus:

- Phone layout remains clean.
- No full handoff blob appears in chat.
- Android primary runtime and Windows support are both documented.

## Required Final Checks

Before handing work back:

```bash
cd broker
npm test
```

If UI changed:

```bash
cd broker
npm run uishot
```

If Android native code, provisioning, bundled broker assets, or startup behavior changed:

```powershell
.\gradlew.bat assembleDebug
Copy-Item android\app\build\outputs\apk\debug\app-debug.apk dist\app-debug.apk
```

Use the PowerShell form on Windows and the shell-equivalent copy command on Android/proot-Debian or Linux.

## Red-Team Checklist

Use this checklist during review:

- Can a medium-capability agent implement the next step without reading old chat context?
- Does every phase name exact files to inspect?
- Does every phase include tests and acceptance criteria?
- Is the Android/proot-Debian runtime protected from Windows-only assumptions?
- Is Windows protected from POSIX-only assumptions?
- Does the plan avoid LLM-generated summaries for v1?
- Does the plan keep the target cwd explicit?
- Does the plan prevent user prompts from racing ahead of engine seeding?
- Does the plan preserve old resume records?
- Does the UI avoid rendering internal context as user-visible chat?
