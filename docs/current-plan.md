# Current Plan

This file is the active priority list for delegation. Older planning documents
remain useful background, but this file decides what should be executed first.

## Runtime Contract

`mobile-agent` is phone-first, not phone-only.

- Android/proot-Debian is the primary deployment runtime and the only place the
  full on-device loop can be proven.
- Native Windows is a first-class broker/web development runtime. Shared Node,
  web UI, tests, and docs must work from PowerShell on Windows as well as from
  Bash inside Debian.
- Android-only code may assume Android/proot paths. Shared code may not assume
  `/tmp`, `/sdcard`, POSIX path separators, shell glob expansion outside the
  documented Node version, or Bash-only command syntax.
- Prefer Node APIs (`path`, `os.tmpdir`, `spawn` with argument arrays) for shared
  implementation. When docs need shell commands, include a Windows-safe form or
  explicitly mark the command as Android/proot-only.

## Current Reality

- Current production engine: `claude-code`.
- Existing conformance/non-default engines: `mock`, partial `opencode`.
- Codex CLI support exists through `codex app-server`, with remaining work around
  cross-engine continuity, selector/control parity, and real Android/proot-Debian
  verification.
- Persona/agent management is designed, but its current implementation details
  are Claude-specific and should not be built as the next cross-engine feature
  until the handoff and per-session engine seams are solid.

## Execution Order

1. **Multi-engine foundation and parity fixes**
   - Implement `docs/multi-engine.md` Phase 1 and Phase 2 first.
   - Add adapter feature declarations.
   - Move active model, effort, permission mode, status, capabilities, and profile
     state into per-session metadata.
   - Keep all changes passing on Windows and Android/proot-Debian.

2. **Codex app-server stabilization**
   - Follow `docs/codex-app-server.md`.
   - Use `codex app-server --stdio` as the primary transport.
   - Map Codex threads/turns/items/approval requests onto the canonical broker
     protocol without routing through Claude-only modules.
   - Preserve the project cwd for every Codex thread/turn and keep model, effort,
     and speed controls in sync with the active tab.
   - `docs/model-control-catalog.md` is implemented for the broker/WebUI Codex
     path: Codex model, reasoning effort, and speed/service-tier discovery now
     flows through app-server `model/list` with a fallback catalog.

3. **Seamless cross-engine handoff**
   - Follow `docs/cross-engine-handoff.md`.
   - Build deterministic local handoff context from the broker transcript and
     session metadata before switching engines.
   - Seed the target engine before the next real user prompt.
   - Store native resume ids per harness so switching back can use the right
     engine-native conversation when available.

4. **Engine-neutral persona layer**
   - Rework `docs/agent-management/design.md` into an engine-neutral `AgentStore`
     plus engine-specific mappers.
   - Implement the Claude mapper first only if explicitly scoped as Claude-only.
   - Implement the Codex mapper after the Codex adapter exposes the required
     capabilities.

5. **Android native engine flows**
   - Parameterize native login/update/provisioning flows after a second real
     engine exists.
   - Keep the self-contained APK path primary; keep external-broker mode as a
     fallback for debugging.

## Do Not Execute As Current Worklists

- `ondevice-claude-code-plan.md` is historical architecture/background. It is not
  the current task order.
- `docs/improvement-spec.md` is a historical audit. It contains many fixed items;
  verify every item against HEAD before treating it as open.
- `docs/qol-suggestions.md` is a living UX idea list, not a correctness backlog.
- `docs/agent-management/` is not the next implementation plan unless the user
  explicitly prioritizes personas over Codex/multi-engine work.

## Acceptance Gates

For broker/web changes:

- `cd broker && npm test`
- UI changes: `cd broker`, run a mock broker, then `npm run uishot`
- Test both PowerShell/native Windows paths and Android/proot-Debian paths when a
  change touches filesystem, process, shell, or path behavior.

For Android/runtime changes:

- Build the debug APK on Windows when possible.
- Verify runtime behavior on a real phone; this Windows machine cannot prove
  WebView/native/proot behavior by itself.
