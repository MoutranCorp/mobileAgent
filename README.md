# On-Device Claude Code

A sideloaded Android app that gives you the full Claude Code experience through a
custom UI, builds React Native / Expo apps, and lets you test them live on the
**same phone** — with the daily loop running 100% on-device and only occasional
native compiles offloaded to the cloud.

This repo is the implementation of [`ondevice-claude-code-plan.md`](ondevice-claude-code-plan.md).

```
┌──────────────────────── Pixel (Android 16) ───────────────────────┐
│  Kotlin app (Compose, targetSdk 28)          Expo dev client       │
│   ├─ foreground service + wake lock           ▲  exp://localhost   │
│   └─ WebView → broker web UI                  │  (Fast Refresh)    │
│        │ ws://127.0.0.1:8765                  │                    │
│   ┌────▼──── Termux bootstrap → proot Debian (glibc) ──────────┐   │
│   │  Node agent broker  ◄──►  Metro (npx expo start)           │   │
│   │   ├─ canonical protocol over WebSocket                     │   │
│   │   ├─ engine adapters: claude-code · opencode · mock        │   │
│   │   └─ controls: Metro · git · EAS · run · projects          │   │
│   │            │ stream-json stdio                              │   │
│   └────────────┼───────────────────────────────────────────────┘   │
└────────────────┼────────────────────────────────────────────────────┘
                 ▼ HTTPS — model API (default: Claude on your Max plan)
```

## Try it in 60 seconds (no phone, no credentials)

The broker ships a **mock engine** that emits the exact same events as the real
one, so the whole stack runs on any laptop:

```bash
cd broker
npm install
npm run dev            # mock engine on http://127.0.0.1:8765
```

Open **http://127.0.0.1:8765/**, type *"build a counter screen"*, approve the
file write, and watch the agent stream text, render a diff, and write a real
`.tsx` file into the project dir. That's the full UI — transcript, tool cards,
diffs, inline approvals, terminal drawer, the Test button — driving the canonical
protocol end to end.

```bash
npm test              # 19 tests: JSONL buffering, mock engine, WS server, config CRUD
```

## More than a chat client

It surfaces the **full** Claude Code harness — aiming past the desktop app:

- **Every stream event rendered:** token-by-token text, collapsible thinking,
  tool cards with live diffs, **nested subagent** cards (`Agent`/`Task`), server &
  MCP tools, web-search results, context-compaction boundaries, and permission
  denials.
- **Permission control:** switch `default` / `acceptEdits` / `plan` /
  `bypassPermissions` live, with a guarded "bypass all" and a deny→ask→allow rule
  editor written to `.claude/settings.json`. Approval gating **fails closed**.
- **Skill, Subagent & Command managers:** create/edit/delete each (project or user
  scope) with a form — name, description, tools, model, body — written as the exact
  `SKILL.md` / `agents/*.md` / `commands/*.md` the CLI loads. Run them from a `/`
  command palette.
- **Memory editor:** edit every `CLAUDE.md` scope (project / local / user) inline.
- **Context inspector:** a live token meter, one-tap `/compact` (with focus),
  `/clear`, and `/context` breakdown.
- **Sessions browser:** list past transcripts and resume; MCP/Plugins/tools view.

And the daily-driver power features:

- **Checkpoints / rewind:** a non-destructive git snapshot is taken before every
  turn; one-tap **↶ Undo** rolls the project back (reverts the agent's edits *and*
  removes files it created this turn). The trust feature for an autonomous agent.
- **Transcript persistence:** conversations survive a page reload, reconnect, or
  broker restart — the recorded event stream replays on connect.
- **File explorer + changed-files view** and **`@`-mention autocomplete** to
  reference files in prompts.
- **Image attachment (multimodal):** 📎 attach / paste / drag a screenshot — or
  shoot one on the phone — and send it to the agent. Made for the test loop.
- **Plan-mode approval card**, **native-dep change → rebuild prompt**, **🎤 voice
  input**, and **turn-complete notifications** (so you get pinged when the agent
  finishes or needs approval while you're off testing in the dev client).

And the IDE-grade workflow tools:

- **Git diff review:** view a per-file working-tree diff (rendered), **discard** a
  file's changes, or **commit** selected work — alongside the checkpoint rewind.
- **Project content search (grep)** and a **file explorer** with **inline editing**
  (and a `.env` editor) — fix a typo without involving the agent.
- **Live plan tracking:** the agent's `TodoWrite` renders as a pinned, updating
  checklist (like the desktop app).
- **In-app web preview:** the broker serves the project at `/preview`, so static /
  SPA builds render in an iframe right next to the chat.
- **Prompt library:** save reusable prompts and one-tap them into the composer.
- **Export conversation to Markdown.**
- **npm scripts runner:** one-tap `test`/`dev`/`build`/`lint` from `package.json`,
  output streamed to the terminal; stop long-running ones.
- **GitHub integration:** commit + push, open a PR (via `gh`), and set the remote —
  the plan's durability goal, one tap.
- **MCP server management:** add/edit/remove MCP servers (`.mcp.json`) from the UI,
  alongside the live status from the running engine.
- **Auto-verify loop:** opt-in — after each turn, run a verify command (e.g.
  `npm test`); on failure the output is fed back to the agent to self-correct,
  bounded by max attempts. A self-healing build loop.
- **Review changes since a checkpoint:** diff any snapshot against the working
  tree before deciding to rewind.
- **Usage & cost analytics:** token/cost totals for today, all-time, and a
  by-day chart (persisted across restarts).
- **Project-wide find & replace:** from a search, replace across files in one tap
  (a checkpoint is taken first, so ↶ Undo reverts it).
- **Conversation search:** a find bar (🔍 / Ctrl-F) with highlight + next/prev.
- **Hooks manager:** view/add/remove Claude Code lifecycle hooks
  (`.claude/settings.json`) — e.g. lint on `PostToolUse`.
- **"Changed this turn" summary:** after each turn, a collapsible card lists exactly
  which files the agent touched (diff vs the pre-turn checkpoint).
- **Output-styles manager:** CRUD `.claude/output-styles/*.md` — completing the
  harness-control surface (skills · agents · commands · output-styles · memory ·
  permissions · MCP · hooks).
- **Command palette (Ctrl/Cmd-K):** fuzzy access to every action — test, push, run
  a script, switch model/engine, open any manager, compact/clear, and more.

All of this rides the same canonical protocol, so it works in the WebView app and
any browser pointed at the broker. Open the managers with the **☰** menu, or hit
**Ctrl-K** for the command palette.

## The real thing (on the phone)

1. **Provision** the runtime: [`provisioning/README.md`](provisioning/README.md)
   walks Termux → proot Debian → toolchain → broker, including the Phase 0 gate
   that proves Claude + Metro work on-device before you build anything.
2. **Authenticate** Claude on your Max plan: `claude` then `/login` (flat
   subscription, no metered API billing).
3. **Build the app**: [`android/README.md`](android/README.md). It installs and
   runs even before the on-device bootstrap exists (external-broker mode), so you
   can use the full UI immediately via `adb reverse`.

## Repo layout

| Path | What |
|---|---|
| [`broker/`](broker) | **The heart.** Node agent broker: canonical protocol, pluggable engine adapters, control endpoints, WS server. Fully runnable + tested here. |
| [`broker/web-ui/`](broker/web-ui) | The web client (served by the broker). Transcript, streamed deltas, collapsible tool cards, diffs, inline approvals, status, terminal drawer, project/engine/model pickers, Test button. |
| [`android/`](android) | Kotlin/Compose shell: foreground service, wake lock, battery exemption, proot/broker launch, Keystore secrets, WebView host. `targetSdk 28`. |
| [`provisioning/`](provisioning) | Phase 0 (validate) + Phase 2 (provision) scripts for the phone. |

## How it maps to the plan's phases

| Phase | Status |
|---|---|
| **0** Validate riskiest assumptions | Scripted: [`provisioning/phase0-*.sh`](provisioning) (the gate). |
| **1** Agent broker (headless CC → WebSocket) | **Done.** [`broker/`](broker) — canonical schema, `claude-code` adapter, JSONL buffering, sessions/resume, controls. Built against the pluggable schema from day one. |
| **2** Kotlin shell + foreground service | **Done (source).** [`android/`](android) — FGS, wake lock, battery exemption, bootstrap launch. |
| **3** Custom UI | **Done.** The web UI delivers the full transcript/tool-card/diff/approval experience; the Compose shell hosts it + native runtime controls. |
| **4** One-tap Test loop | **Done.** `start_metro` + `exp://` deep-link from the Test button; native-dep change detection in the broker. |
| **5** Projects, sessions, durability | **Done.** Project switcher + per-project Metro ports + session resume + git controls + Keystore secrets. |
| **6** Fully self-contained native builds | Documented escape hatch (default: EAS cloud), per the plan. |
| **§3** Engine/model pluggability | **Done.** `claude-code` + `opencode` + `mock` adapters behind one canonical schema; profiles for Claude (Max), GLM (Z.ai), opencode, mock. |

## What needs your input (placeholders)

Nothing blocks the laptop demo or the external-broker app path. For a fully
self-contained on-device build you'll supply:

- **`android/app/src/main/assets/bootstrap-aarch64.tar.gz`** — the prebuilt Termux
  arm64 bootstrap tarball (large, arch-specific, not committed). See
  [`android/app/src/main/assets/README.md`](android/app/src/main/assets/README.md).
  Until present, the app runs in external-broker mode.
- **Claude `/login`** — the one OAuth step that can't be scripted.
- **GLM / OpenRouter keys** *(optional)* — only if you switch off the default
  Claude (Max) profile. Add them in the app's Runtime ▸ Secrets (Keystore) or
  `broker/<stateDir>/secrets.json`.
- **EAS account** *(optional)* — only for cloud dev-client builds when native deps
  change.
- ~~Gradle wrapper jar~~ — now generated and committed; `./gradlew` works directly.
  The app **compiles** (`gradle :app:assembleDebug` → a 16 MB debug APK) and
  **passes lint** with the installed SDK; only on-device *runtime* testing needs a
  phone or emulator.

## Why these choices

The locked decisions (on-device primary, `targetSdk 28` for exec, proot Debian
for glibc prebuilts, driving the **CLI** in stream-json so it uses your **Max
subscription** instead of metered API billing, a foreground service to survive
Doze, and an engine-pluggable broker) are explained in
[`ondevice-claude-code-plan.md`](ondevice-claude-code-plan.md). The code follows
them.

## License

GPL-3.0-or-later (the Termux bootstrap + `termux-exec` it builds on are GPLv3).
Fine for personal use; revisit if you distribute.
