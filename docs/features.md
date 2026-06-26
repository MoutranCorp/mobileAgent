# Feature surface & roadmap

This is the canonical inventory of what **mobile-agent** already implements, so an
agent landing in the repo cold does not rebuild or break existing work. It is
written for a fresh clone with no external memory.

If a prose claim here disagrees with code, **the code wins** — the load-bearing
contracts are [`broker/src/protocol.js`](../broker/src/protocol.js) (every UI↔broker
message) and [`broker/src/session.js`](../broker/src/session.js) (the multi-session
engine model). Drift notes are flagged inline. For Claude Code stream-mapping
specifics see [`docs/claude-code-surface.md`](claude-code-surface.md).

**Tests are the source of truth for "it works."** Run `cd broker && npm test`.
At time of writing: **93 tests pass across 21 files** in `broker/test/` (glob it
yourself; old docs that say 19/13/34/45/91 are stale). The test script is
`node --test "test/**/*.test.js"` (the quoted glob matters on Windows Node 24).

---

## Architecture in one paragraph

A sideloaded Android app hosts a WebView that loads a web UI served by a Node
**broker** running on-device (in Termux → proot Debian). The broker speaks a
single **canonical event protocol** over a localhost WebSocket and drives a
pluggable engine — `claude-code` (default, the real CLI on a Max plan = no
metered billing), `opencode` (conformance), or `mock` (offline tests/UI shots).
Components: [`broker/`](../broker) (heart + tests), [`broker/web-ui/`](../broker/web-ui)
(the client), [`android/`](../android) (Kotlin/Compose shell, `targetSdk 28`),
[`provisioning/`](../provisioning) (Termux→proot→toolchain→broker scripts).

---

## Broker

- **Canonical protocol.** `protocol.js` exports `EventType` (engine/broker → UI)
  and `CommandType` (UI → broker). It is a **superset of Claude Code stream-json**,
  so the `claude-code` adapter maps ~1:1; raw harness shapes must never leak to the
  UI. Wire format is one JSON object per WS message, `{ type, ts, ...fields }` (NOT
  newline-delimited).
- **Engine adapters** (`src/engines/`): `claude-code`, `opencode`, `mock`
  (registry in `engines/index.js`). `base.js` honors `opts.model`/effort/permission.
- **Full Claude Code stream coverage:** token-by-token `assistant_text` deltas,
  `assistant_thinking` (with signature), server/MCP tools, **subagent nesting** via
  `parentToolUseId`, `compact` boundaries, `permission_denials`, `usage`/`context`
  meters, `result` end-of-turn.
- **Permission modes** `default | acceptEdits | plan | bypassPermissions`
  (`SET_PERMISSION_MODE`); approval flow runs through a Claude Code
  `--permission-prompt-tool` MCP server + IPC bridge (`src/mcp/`). `bypass`-as-root
  via `IS_SANDBOX=1`.
- **Model & effort:** dynamic model version labels resolved from the CLI
  `system/init` id (never hardcoded; cross-family resolved ids rejected so
  `opus`→sonnet-id can't mislabel). Effort picker `low|medium|high|xhigh|max`
  plus an `ultracode` level that maps to `xhigh` + the ultracode setting. Chosen
  model persists across effort/permission/resume restarts.
- **Controls** (`src/controls/`): `transcript` (per-session persistence + replay),
  `checkpoints` (git snapshot per turn + restore + diff), `files` (list/read/grep/
  find&replace/diff/write incl. `.env`), `projects`, `prompts`, `usage-ledger`
  (by-day cost), `autoverify` (bounded verify-loop after each turn), `process-runner`
  (Metro/git/EAS/run streamed), `resources` (device/process sampling — see below),
  `updater` (self-update), `model-resolver`, `claude-config` (cross-project session
  scan), `frontmatter`, `devtools`.
- **In-app self-update** (`controls/updater.js`): finds the app repo via
  `git rev-parse --show-toplevel`, reports the current build (sha/subject/branch/
  dirty), runs `git pull --ff-only`, and classifies changed paths — web-ui → one-tap
  Reload (served from disk), broker src/deps → "restart the broker", android →
  rebuild. `APP_VERSION` / `APP_UPDATE` protocol messages.
- **Revert/rewind:** `REVERT { turnId, checkpointId?, text }` restores files and
  truncates the conversation to before a user message (`REVERTED` event).

## Web UI (`broker/web-ui/`)

Served by the broker; hosted in the Android WebView. iOS-native design system in
`styles.css` (system colors + label opacities, light+dark via `prefers-color-scheme`,
SF type scale, frosted-glass materials, safe-area insets). No service worker; assets
are cache-busted with `?v=__VER__` rewritten to a mtime-derived version at serve time.

- **Managers sheet (☰)** (`managers.js`): **Skills, Agents, Commands, Output styles,
  Memory, Permissions** (modes + allow/deny/ask rules), **Hooks, Sessions** browser,
  **Projects, Context** inspector (live window meter + `/compact` + `/clear`),
  **MCP / Plugins** (editable `.mcp.json` add/edit/remove + `/plugin` install),
  **Engine, System** (see Tabbed workspace), **Files, Scripts, Git, Checkpoints,
  Prompts, Usage, Update**. UI-created skills/commands/agents/MCP hot-reload via
  engine re-spawn (resume) + toast.
- **Transcript:** persistence + replay; Markdown rendering (`web-ui/markdown.js`,
  dependency-free, XSS-safe, tolerant of partial mid-stream input; raw md kept on
  `dataset.md` for export/search); export-to-Markdown.
- **Live feedback:** single `state.activity` (idle/working/waiting) drives an
  iMessage typing-dots bubble labelled with the live action; thinking traces in a
  collapsible pulsing card; send button morphs to **Stop** (interrupt) while working.
- **Project tooling:** file explorer + content grep + per-file diff + inline edit +
  `.env` editor; git diff review (discard/commit); checkpoints/rewind +
  review-changes-since-checkpoint; npm scripts runner; GitHub commit/push/PR + set
  remote; web preview (`/preview` static serve, needs an ACTIVE project); native-dep →
  rebuild prompt; one-tap **Test** (Metro + `exp://` deep-link); live todos
  (`renderTodos`, markers drawn by CSS).
- **Inline viewer widgets:** any GENERATED viewable file from a Write/Edit tool gets
  an inline preview card served from `/preview/<rel>` — html runs live in a sandboxed
  iframe, svg/image render on a checker bg, markdown via `MD.render`. All get
  `</> Code` view-source + Copy + **Download** + Open-full. Reconstructed on resume
  via transcript replay.
- **File download** (`GET /download/<rel>`, path-guarded, binary-safe attachment):
  pulls artifacts out of the invisible proot rootfs into the phone's real Downloads.
  `_findApks()` bounded walk → `APKS` event; **APK widget** "⬇ Save to Downloads".
- **Floating composer:** one rounded frosted card floating above the bottom edge,
  holding textarea + control row (attach, model·effort pill, mic, send) + in-card
  action row (New/Undo/Test/Preview/Export/Terminal/access). Conversation scrolls
  UNDER it; `syncComposerInset()` reserves a dynamic bottom inset. Expand → fullscreen
  `#fullEditor`. Defaults: access=`bypassPermissions`, model=opus 4.8.
- **Multimodal:** image attach; voice input; `@`-file mention; slash-command palette;
  plan-mode approval card; prompt library; command palette (Ctrl-K / ⌘ touch button).
- **Visual/smoke harness:** `npm run uishot` (Playwright + mock broker, iPhone
  viewport, screenshots, **fails on JS console errors**).

## Android (`android/`)

Kotlin/Compose shell at `targetSdk 28` (keeps `exec()` from the data dir legal for
Termux/proot). Owns the foreground service + wake lock + battery exemption +
proot/broker launch + Keystore secret injection. **WebView↔native bridge**
(`window.AndroidAgent`): confirm/alert→AlertDialog, image attach→system picker,
export→FileProvider share, voice→SpeechRecognizer, notifications→native,
`exp://` deep-link & PR links→openExternal. The web UI feature-detects the bridge
and falls back to web APIs on desktop. **Lesson: desktop-browser-verified features
do not all work in a WebView — always check WebView limits.**

## Provisioning (`provisioning/`)

Phase 0 (gate) + Phase 2 (provision) scripts: Termux → proot Debian → toolchain →
broker (`phase0-*.sh`, `provision-debian.sh`, `run-broker.sh`, `lib.sh`). User
placeholders remain: bootstrap tarball, `claude /login`, optional provider keys,
Gradle wrapper jar.

---

## The tabbed-workspace subsystem

The biggest and newest subsystem. The whole app is a **multi-session / multi-file
workspace**: a tab strip under the title bar replaces the old context bar. **This is
fully shipped (all 4 phases) but invisible in any prose other than this file — read
the code, not your assumptions.** Ground truth: `session.js`,
`controls/resources.js`, `web-ui/app.js`.

### Per-session engines (NOT per-project)

`SessionManager` (`session.js`) keeps an `engines` **Map keyed by `sessionKey`** —
many live `claude` CLI child processes can share one project folder. Key minting
(`_sessionKeyFor`):

- The **first** session of a project gets `sessionKey === projectId` (back-compat:
  all old project-keyed behavior and tests are unchanged).
- A second+ concurrent session in the same folder mints a suffixed key `projA#N`
  (`_keySeq`), and a non-colliding suffix is always chosen so a new tab can never
  overwrite a live engine.

`meta` (per key) carries `{ busy, lastStatus, profileId, model, sessionId,
projectId, cwd, lastActivityTs, pinned, title }`. `session.engine` is now a **getter**
for the active key's engine. A global **start-lock** serializes (re)starts so
closely-timed restarts can't orphan a child process. Switching
model/effort/permission/profile replaces ONLY the active key's engine; opening
another project just `setActiveKey`s (siblings keep generating in the background).
`ensureEngine` **cold-resumes a previously idle-evicted session in its OWN folder**
via stored `meta.cwd` (never the globally-active project — a HIGH bug that was fixed).
Every engine event is stamped `ev.sessionKey` so the server records it to the right
transcript and only broadcasts the active session's full stream (others → a
lightweight `SESSIONS` busy overlay).

### The tab strip (sessions + files)

`app.js` tab manager: `ensureTab/switchTab/closeTab/renderTabs`, persisted in
localStorage. Tabs carry `kind:'session'|'file'` and an `id` (session id=key, file
id=`'file:'+rel`).

- **Session tabs.** Indicators derived LIVE in `renderTabs`: `waiting(!) > working
  (spinner) > done(✓) > dot` (order matters — a waiting session is also "busy").
  Titles numbered **per folder** (`seen[k]`: first="demo", rest="demo 2"),
  independent of the internal `#N` key suffix.
- **File tabs** are **client-only** — `state.activeTabId` is decoupled from the broker
  `activeKey`, so switching a file tab does NOT `switch_session`. `applyViewMode()`
  swaps in `#fileView` (name · Rendered|Source toggle · Save · ⬇ · ✕) and hides the
  transcript+composer. Source is an editable textarea fetched from `/preview`; **Save**
  round-trips via `files_write`. Entry points: inline file-widget "✎ Edit" + ☰ Files
  "↗ Open as tab" (`window.Agent.openFileTab`).
- **Gestures** (`wireTabGesture`, pointer events, `touch-action:none`): tap=switch,
  450ms hold=menu, post-hold slide=drag-reorder (insertion by neighbor centers),
  pre-hold horizontal slide=scroll the strip. Menu: rename, 8 color swatches
  (`TAB_COLORS`, persisted as `userTitle`/`userColor`), Close / others / left / right /
  all. (Note: "Close all" uses `tmenu-danger`, not global `.danger` which is a red bg.)

### The System tab

A first-class manager pane fed by the `RESOURCES` event. Source = `controls/resources.js`
(pure /proc readers, exported for tests):

- **Device RAM** from `/proc/meminfo` — uses **MemAvailable** not MemFree (Android
  hoards RAM for cache; "free" wildly understates usable). Dev box has no `/proc` →
  falls back to `os.*` (coarser; broker + tests still run).
- **Per-engine RSS** from `/proc/<pid>/status` VmRSS; plus broker RSS and aggregate
  `agentsRssMb`, CPU load, `hasProc`.
- Per-session **Stop / Pin** controls.

### Session lifecycle & eviction

Always-warm = **working OR focused OR pinned**. A background session **idle > 5 min**
drops its process (cold-resume from its `.jsonl` on focus/send); under memory pressure
an **idle-only LRU** eviction runs. There is **no cap** on concurrent agents (cost is
flat-subscription; the only real limit is the Pixel's RAM). Mechanism:
`server._lifecycleTick` (in `server.js`, **started by `index.js` via `startLifecycle`,
NOT the constructor** — keeps tests deterministic) broadcasts `RESOURCES` then evicts:
`evictionCandidates(sample)` (LRU, `usedPct >= 88`, max 3, never working/focused/pinned)
plus a hard `IDLE_TTL_MS = 5*60*1000`. Eviction calls
`stopEngineKeepTranscript(key)` — the engine dies but `meta` (incl. `sessionId`) and
the transcript survive for cold resume. (5 min ≈ prompt-cache TTL.)

### Folder switcher & sessions

The folder pill is a button → a **folder switcher sheet**: each folder expands to its
sessions + "New chat here" + "Open another folder". It lists the **latest 3 on-disk
sessions per folder** (`list_sessions scope:all` → grouped by `projectId`, top-3 by
mtime → `state.recentSessionsByProject`). Live ones are flagged and tap=`switchTab`;
historical tap=`RESUME {sessionId, projectId, projectDir}` (NOT `switch_session`).
Ambiguous-encoding sessions bucket under "Folder unknown". Resume is **project-aware**
(`claude-config` re-encodes each known project dir to map a session folder →
projectId), so it resumes in the right cwd and seeds from the right `.jsonl` without
clobbering a running sibling. `+` tap = new session in the current folder; `+`
long-press = the sheet.

### Message timestamps

`.msg-time` HH:MM on every bubble. `handleEvent` stashes `state._lastEventTs=ev.ts`;
assistant `dataset.ts` set at first delta and stamped in `finalizeAssistant`; user
time from `meta.ts || nowIso`, reconciled to the server `ts` in `stampUserBubble`.
(Transcript `record()` keeps the first delta's `ts` so REPLAY stamps the right time.)

### Relevant protocol messages

Events: `RESOURCES`, `SESSIONS { items, activeKey }`, `ENGINE_STATE`.
Commands: `SESSION_STOP { key }` (tear down a live engine, keep transcript),
`SESSION_PIN { key, pinned }` (keep-warm exemption), `SWITCH_SESSION { key }`
(foreground a live session, no engine stop), `NEW_SESSION` (fresh concurrent session
in the active folder), `LIST_LIVE_SESSIONS`, `LIST_SESSIONS { scope:'all' }`,
`RESUME { sessionId, projectId?, projectDir? }`, `SESSION_DELETE`, `SESSION_RENAME`
(sidecar `<stateDir>/session-titles.json`).

---

## Roadmap / deferred (honest status)

- **Background-session permission prompts** — DEFERRED. A background session awaiting
  approval shows busy, but the permission card only appears when you switch to it.
- **Per-session cost display** — DEFERRED. The usage ledger is aggregate/by-day; cost
  is not yet broken out per concurrent session.
- **On-device deploy path is genuinely incomplete.** The end-to-end install on a real
  Pixel still has user placeholders (bootstrap tarball, `claude /login`, provider keys)
  and was largely built/tested on a dev box with no on-device runtime (no emulator/
  connected device, no `/proc`). See [`docs/on-device-deploy.md`](on-device-deploy.md)
  for the path **and an honest list of the code-level gaps** (e.g. `setup-guest.sh`
  never delivers the broker; the bootstrap tarball is gitignored with no committed
  recipe). Keep that doc honest as the path is actually walked on-device.
- The autonomous feature loop was **stopped after iteration 4**: the harness-control
  surface (skills/agents/commands/output-styles/memory/permissions/mcp/hooks) is
  complete, and remaining ideas (light theme polish, Metro error cards, token-budget
  guard, more project templates) are cosmetic/niche. Prefer hardening and the deferred
  items above over net-new managers.

> Before adding a "new" feature, grep this file and `broker/src/protocol.js` — most of
> the obvious surface already exists. When in doubt, run `npm test` and read the code.
