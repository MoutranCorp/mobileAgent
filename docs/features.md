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
  dirty), and updates by **`git fetch --depth=1 origin <branch>` + `git reset --hard
  FETCH_HEAD`** (NOT `git pull`). The delivery clone is shallow (`--depth 1`), and
  `git pull` on a shallow clone is fragile — it fails with "did not send all necessary
  objects" and a half-finished pull corrupts the object store ("bad object …");
  fetch+reset skips history reconciliation and jumps straight to the tip even if the
  old HEAD is corrupt. If the fetch itself fails (deeper corruption), it **re-clones
  fresh and swaps the directory** in (`_reclone`; the clone holds no user data).
  Classifies changed paths — web-ui → one-tap Reload (served from disk), broker
  src/deps → "restart the broker", android → rebuild. Dirty-tree guard refuses to
  reset over local edits. `APP_VERSION` / `APP_UPDATE` protocol messages.
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
  **Engine, System** (see Tabbed workspace), **Files** (project-scoped), **File
  Manager** (whole device — see below), **Scripts, Git, Checkpoints, Prompts,
  Usage, Update**. UI-created skills/commands/agents/MCP hot-reload via engine
  re-spawn (resume) + toast.
- **User settings** (`controls/user-settings.js`, schema `config/user-settings.default.json`):
  a single persisted store for per-user UI/engine prefs — last-used **model /
  effort / permission-mode** (re-applied broker-side on startup), **open tabs +
  active tab**, and the **Manage tab order**. Defaults are committed; the live
  `<stateDir>/user-settings.json` is device-local (gitignored). Sent in the
  connect snapshot as `user_settings`; the client persists changes via
  `user_settings_patch` (deep-merge). Tabs also keep a localStorage fast-cache and
  hydrate from the durable store if that cache is empty.
- **Manage chip row** (`managers.js`): the chips live in a single frosted
  **"liquid glass" container** (the app's `--mat-bar`/`--blur` recipe); the active
  chip floats above with the accent fill. An expandable **search chip** (always
  first) filters the panes as you type, and picked panes promote to the front
  (most-recently-used ordering, persisted in user settings) so frequent screens
  stay at the left edge.
- **Slash-command highlight** (`app.js` `syncSlashHighlight`): a leading
  `/command` in the composer lights up in place (accent token over a backdrop that
  mirrors the textarea); ordinary prose typing is untouched.
- **Agent question forms** (`app.js` `renderQuestionForm`): the headless CLI
  doesn't expose the built-in `AskUserQuestion`, so the broker provides its own as
  an **MCP tool** (`mcp/permission-server.js` `ASK_TOOL`, always registered). When
  the agent calls it, a `QUESTION_REQUEST` surfaces an interactive form (per
  question: single/multi-select option cards + a free-fill answer, gated submit);
  the submitted answer rides back as the **MCP tool result** (engine
  `_onQuestion`/`respondQuestion`, bridge `kind:'question'`). See
  [claude-cli-behaviors.md](claude-cli-behaviors.md).
- **Select text** (`app.js` `enableBubbleSelection`): the message long-press menu
  has a **Select text** action that flips the bubble into native-selection mode
  and pre-selects it, so a specific span can be grabbed (alongside Copy-all).
- **Scheduled jobs (cron)** (`controls/cron.js` + `managers.js` `renderCron`): a
  **⏰ Scheduled** Manage tab where a saved prompt runs in a chosen folder on a
  schedule (friendly presets **or** a raw 5-field cron expression). Per job: a
  **fresh** session each run or **one persistent** session that accumulates
  context; a per-job **Engine (profile) / Model / Effort** override (blank = the
  broker's active default — `startDetached`/`_startEngineInner` apply them to the
  detached run without mutating the foreground prefs); enable/disable, **run-now**,
  edit, delete, and open the last run. On completion the broker broadcasts a
  **notify-flagged toast** (`{notify:true}`) that the UI turns into a real OS
  notification (`notifyIfHidden` → native) so you're told when a job finishes.
  Scheduling is evaluated **in-broker** (a 30s tick → `cron.due()`), so jobs fire
  while the broker is alive (the foreground service keeps it up); the structure
  leaves room for OS-level background wake (Android AlarmManager) later. Jobs fire
  into a **background session** (`session.startDetached` — never disturbs the
  foreground view) via `server._fireCronJob`. Jobs persist in
  `<stateDir>/cron-jobs.json` (gitignored).
- **File Manager** (`managers.js` `renderFileManager` + `controls/fsmanager.js`):
  a **whole-filesystem** browser (NOT project-scoped) over absolute paths (`~`
  expanded). Navigate (home/up/go-to-path), **new folder**, and per-entry
  **rename / clone / move / delete / extract** (.zip/.tar/.tar.gz/.tgz). Any file
  opens as an **editable tab** in the app, served by the `/fsraw?path=` route
  (the absolute-path analog of `/preview`) and saved via `fs_write`. Commands:
  `fs_browse/read/write/mkdir/rename/move/copy/delete/extract` → `fs_list`/`fs_file`.
  Deliberately **unsandboxed** (loopback-only broker, single on-device user); the
  UI gates destructive actions behind confirms and the control refuses to delete
  `$HOME` or `/`. Reach of the host filesystem is gated by Android's **All files
  access** (`MANAGE_EXTERNAL_STORAGE`): a **toggle on the native Runtime screen**
  (`MainScreen.FileAccessSection` → `MainActivity.requestAllFilesAccess`, reflecting
  `Environment.isExternalStorageManager()`; legacy `WRITE_EXTERNAL_STORAGE` on
  API < 30) opens the grant screen, after which the `/sdcard` + `/storage` proot
  binds let the browser read all shared storage. System files and other apps'
  private storage still require root.
- **Transcript:** persistence + replay; Markdown rendering (`web-ui/markdown.js`,
  dependency-free, XSS-safe, tolerant of partial mid-stream input; supports GFM
  pipe tables with column alignment, rendered in a horizontal scroller so wide
  tables don't overflow the phone; raw md kept on `dataset.md` for
  export/search); export-to-Markdown.
- **Live feedback:** single `state.activity` (idle/working/waiting) drives an
  iMessage typing-dots bubble labelled with the live action; thinking traces in a
  collapsible pulsing card; send button morphs to **Stop** (interrupt) while working.
  After a send the indicator is **latched** (`beginAwaiting`/`awaitingActive`) until
  the engine produces a real event, so waking a cold/idle-evicted session shows
  **"Waking up…"** instantly and never flickers back to idle on the engine's init
  status (addresses the "send to a sleeping session feels dead" lag).
- **Full trace transparency:** the claude-code adapter surfaces the whole stream —
  tool calls appear at their block-start and their **input streams live**
  (`input_json_delta` → `tool_delta`, an ephemeral preview that finalizes to the
  rendered diff/command); **image tool results** (screenshots, image reads, MCP
  image output) render as pictures, not base64 JSON (`splitToolContent`); `api_retry`,
  unusual `stop_reason`s (truncation/refusal/pause), and other system notes show as
  dim inline `.sys-note` lines. Streaming previews are marked `ephemeral` so they
  cross the socket but are never recorded/replayed.
- **Project tooling:** file explorer + content grep + per-file diff + inline edit +
  `.env` editor; git diff review (discard/commit); checkpoints/rewind +
  review-changes-since-checkpoint; npm scripts runner; GitHub commit/push/PR + set
  remote; web preview (`/preview` static serve, needs an ACTIVE project); native-dep →
  rebuild prompt; one-tap **Test** (Metro + `exp://` deep-link); live todos
  (`renderTodos`, markers drawn by CSS).
- **Inline viewer widgets:** any GENERATED viewable file from a Write/Edit tool gets
  an inline preview card served from `/preview/<rel>` — html runs live in a sandboxed
  iframe, svg/image render on a checker bg, markdown via `MD.render`. Every kind shares
  the **same action set**: a **Show/Hide** toggle, `</> Code` view-source + Copy,
  **Download**, **⧉ Tab** (open the file as an editable tab), and Open-full. Widgets
  **default to collapsed** (header only) and render their body lazily on first Show
  (`setFileCollapsed`), so generated files don't flood the transcript; the html iframe
  is torn down on collapse. Reconstructed on resume via transcript replay.
- **Tool-call cards** auto-collapse once the call finishes cleanly (diffs included;
  subagents keep their nested view open), so completed actions don't take up space —
  tap the header to re-expand. Errors stay expanded with the failure reason.
- **Data backup / restore** (`controls/backup.js`): mirrors projects + the broker
  state dir (sessions/transcripts/settings) + `~/.claude/.credentials.json` to
  `/sdcard/MobileAgentBackup` (shared storage — survives an app uninstall; bind-mounted
  into the guest). Auto-**restores** on broker startup *only when the live data is empty*
  (non-destructive), periodic auto-backup (`BACKUP_INTERVAL_MIN`, default 30) + manual
  **Back up now** in Manage → System (`backup_now`/`backup_status`). Pairs with the
  stable APK signing key (install new builds OVER the app, never uninstall) so routine
  updates don't lose data in the first place.
- **File download** (`GET /download/<rel>`, path-guarded, binary-safe attachment):
  pulls artifacts out of the invisible proot rootfs into the phone's real Downloads.
  `_findApks()` bounded walk → `APKS` event; **APK widget** "⬇ Save to Downloads".
  The widget appears only when a build **creates/changes** an `.apk/.aab`: the broker
  baselines a project's existing artifacts on open (`_seedApks`) and emits only
  newer/added ones, tagged with the producing `sessionKey` (so it records to that
  session's transcript and never pops in a conversation that didn't build it).
- **Floating composer:** one rounded frosted card floating above the bottom edge,
  holding textarea + control row (attach, model·effort pill, mic, send) + in-card
  action row (New/Undo/Test/Preview/Export/Terminal/access). Conversation scrolls
  UNDER it; `syncComposerInset()` reserves a dynamic bottom inset. Expand → fullscreen
  `#fullEditor`. Defaults: access=`bypassPermissions`, model=opus 4.8.
- **Multimodal:** image attach; voice input; `@`-file mention; slash-command palette;
  plan-mode approval card; prompt library; command palette (Ctrl-K / ⌘ touch button).
- **Interactive terminal:** the Terminal drawer runs project commands (`run`), and
  once a command is live the input routes to its **stdin** (`run_input`) with a Stop
  button (`run_stop`) — so interactive CLIs can be driven from the phone. This is the
  on-device Claude login path: run `claude setup-token`, open the printed URL, paste
  the code back. (Reliable fallback: set `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`
  in Runtime → secrets and restart.) NB: stdin is a pipe, not a PTY, so full-screen
  TUIs (raw-mode `claude` REPL) won't render — prefer line-oriented commands.
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

The **default** path is the self-contained APK: it auto-provisions on first launch
(proot staged from assets → download Debian rootfs → install toolchain → deliver the
broker as a git clone) and signs in to Claude natively from the Runtime tab. See
[on-device-deploy.md](on-device-deploy.md) for the flow and
[on-device-runtime.md](on-device-runtime.md) for the internals. `make-runtime.sh`
stages the proot binaries into `android/.../assets/proot-<arch>/`.

The `phase0-*.sh` / `provision-debian.sh` / `run-broker.sh` / `lib.sh` scripts are the
**degraded manual fallback** (run the broker in a real Termux + proot-distro Debian);
not the default.

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
  independent of the internal `#N` key suffix. The tab set is the **persisted +
  explicitly-opened** sessions only: `onSessions` refreshes existing tabs and always
  keeps one for the ACTIVE session, but does NOT auto-open a tab for every session the
  broker remembers (that flooded the strip with background/sleeping sessions on
  reconnect). Other sessions live in the **folder sheet**; tap one to open it. A fresh
  `new_session` clears its transcript broker-side, so a recycled key (the `#N` counter
  resets on broker restart) can't surface a dead session's leftover messages.
- **File tabs** are **client-only** — `state.activeTabId` is decoupled from the broker
  `activeKey`, so switching a file tab does NOT `switch_session`. `applyViewMode()`
  swaps in `#fileView` (name · Rendered|Source toggle · Save · ⬇ · ✕) and hides the
  transcript+composer. Source is an editable textarea fetched from `/preview`; **Save**
  round-trips via `files_write`. Entry points: inline file-widget "⧉ Tab" + ☰ Files
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

The folder pill is a button → a **folder switcher sheet**: folders are ordered
**most-recently-active first** and each header carries a compact **"+ New"** pill
(no separate row). It lists the **latest 3 on-disk sessions per folder**
(`list_sessions scope:all` → grouped by `projectId`, top-3 by mtime →
`state.recentSessionsByProject`). Live ones are flagged, tap=`switchTab`, and their
dot takes the **folder's colour** when open as a tab; historical tap=`RESUME
{sessionId, projectId, projectDir}` (NOT `switch_session`). The "ago" label uses the
session's **transcript mtime** (time of the latest message), NOT `lastTurnTs` — which
the engine bumps on any status change, so opening/spawning a session made a fresh tab
read "just now". Folder recency is likewise by newest-message mtime.
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
- **On-device deploy path is now WORKING end-to-end** on a real Pixel (verified
  through many device rounds): self-contained APK auto-provisions (proot + downloaded
  Debian + toolchain + git-clone broker), renders the UI in the WebView, the in-app
  Update (`git pull`) works, and native Claude sign-in authenticates. The abandoned
  bundled-Termux-bootstrap approach and its gaps (`setup-guest.sh`, `make-bootstrap.sh`)
  were removed. Remaining nicety: a smoother sign-out/credential-clear UX. See
  [`docs/on-device-deploy.md`](on-device-deploy.md) (flow) and
  [`docs/on-device-runtime.md`](on-device-runtime.md) (internals/gotchas).
- The autonomous feature loop was **stopped after iteration 4**: the harness-control
  surface (skills/agents/commands/output-styles/memory/permissions/mcp/hooks) is
  complete, and remaining ideas (light theme polish, Metro error cards, token-budget
  guard, more project templates) are cosmetic/niche. Prefer hardening and the deferred
  items above over net-new managers.

> Before adding a "new" feature, grep this file and `broker/src/protocol.js` — most of
> the obvious surface already exists. When in doubt, run `npm test` and read the code.
