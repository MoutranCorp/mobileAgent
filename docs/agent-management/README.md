# Agent Management — planning artifacts

Design + background for the **user-configurable "agents" (personas)** feature: reusable
bundles of system prompt + tool access + skills (+ optional model/effort + filesystem scope)
that the user can create, edit, and switch between — even mid-session — with the conversation
rendering as a group chat.

- **[design.md](design.md)** — the design doc. All settled decisions, the implementation
  spec (storage shape, spawn-arg mapping, per-turn attribution, enforcement, protocol), and
  the build phasing.
- **[system-prompt-and-context-notes.md](system-prompt-and-context-notes.md)** — background:
  how Claude Code's system prompts and the context window actually work, measured live
  on-device. The research that motivated the `--append-system-prompt` approach.

**Status:** design complete, not yet implemented. Next step: Phase 1 in `design.md` §6
(`AgentStore` + `agents.json` + threading agent fields through the spawn path).
