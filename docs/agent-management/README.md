# Agent Management - planning artifacts

Design + background for the **user-configurable "agents" (personas)** feature:
reusable bundles of system prompt + tool access + skills (+ optional
model/effort + filesystem scope) that the user can create, edit, and switch
between, even mid-session, with the conversation rendering as a group chat.

Sequencing note: this design was written against the current Claude Code
adapter. Do **not** implement it as the next cross-engine feature before
[`../multi-engine.md`](../multi-engine.md) Phase 1/2. If the user asks for
agent-management before that foundation, scope it explicitly as Claude-only and
expect a later engine-neutral refactor.

- **[design.md](design.md)** - the design doc. It contains the product shape,
  storage shape, Claude spawn-arg mapping, per-turn attribution, enforcement,
  protocol additions, and build phasing.
- **[system-prompt-and-context-notes.md](system-prompt-and-context-notes.md)** -
  background on how Claude Code's system prompts and context window worked in a
  measured on-device session. This motivated the `--append-system-prompt`
  approach, but it is not an active implementation checklist.

**Status:** product/design background complete, not yet implemented. Current
priority is multi-engine foundation first; see [`../current-plan.md`](../current-plan.md).
