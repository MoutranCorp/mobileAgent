# mobile-agent — Historical Improvement & Flaw Spec

> An exhaustive catalog of flaws and improvement opportunities, gathered for
> discussion-then-implementation. Compiled from a parallel code audit of the whole
> tree (broker core, engines/approval, controls, web-ui core, managers/shell,
> styling/a11y, Android/provisioning) plus live runtime probing of the UI at phone
> size against the mock engine.

> **STATUS (2026-06): substantially implemented.** Worked through in batches on
> `claude/fixes-and-features-scxb2u`. All **High** and **Med** items, and the large
> majority of **Low** items, across §§1–7 are done — broker security (shell/path/
> traversal/IPC), approval-flow routing, per-session lifecycle, UI scroll/memory/
> reconnect/echo/find, markdown (tables/lang/escaping), color-mix→rgba compat,
> a11y, managers loading/validation, engine + control papercuts, the opencode
> adapter, and the Android/provisioning hardening. Each batch is its own commit;
> the broker `node:test` suite stays green and UI changes were browser-smoke-tested.
>
> **Consciously deferred (with rationale), NOT bugs left unfixed:**
> - §1:69 `_startLock` — re-audited as a correct promise-chain mutex (false positive).
> - §1:74 effort/permission-mode → all *live* engines — restarting background
>   engines mid-work is more disruptive than the cosmetic gap; new/restarted
>   engines already adopt the current value.
> - §4:145 rebuild tool-head/denial via `el()` — those fields already pass through
>   `esc()`; pure defense-in-depth, no active hole.
> - §5:171/174/175/178/181 — low-value manager UX (await-ack, rename ✕, dir-nav
>   spinner, render-rebuild focus, broker-side child paths).
> - §6:196 `bypassPermissions` default — a security-default flip is a product
>   decision and the broker default must change in lockstep; left for the owner.
> - §6:197 PWA PNG icon rasters — needs binary asset generation.
> - §5:184 "On-Device Agent"/"Agent" — deliberate PWA `name`/`short_name` split.

> **Delegation warning:** this is no longer the active backlog. Many entries below
> describe bugs that have since been fixed and tested. A delegated agent must
> verify any item against HEAD with `rg`, source reads, and focused tests before
> editing. Current sequencing lives in [`current-plan.md`](current-plan.md).

## How to read this

Each item: **[Severity] Title** — _type_ — `file:line` — problem → suggested fix.
Severity = user/impact-weighted: **High** = correctness/security/data-loss or
clearly-wrong behavior; **Med** = real bug/UX gap most users will hit; **Low** =
papercut/robustness/nicety. Line numbers are snapshot references — verify against
HEAD before editing (the code drifts).

Runtime-verified notes are tagged **[RT✓ good]** (held up under live testing) or
**[RT✗ confirmed]** (reproduced the flaw live).

---

## 0. Executive summary — cross-cutting themes

These patterns recur across many findings; fixing the pattern once kills a cluster.

1. **Per-server state that should be per-session.** `_pendingTurn`, `_suppressEcho`,
   `_turnCheckpoints`, permission/interrupt routing, and effort/permission-mode all
   live on a single instance but the broker is multi-session. Approvals/echoes can
   be attributed to the wrong session. → Key these by `sessionKey`.
2. **Unbounded growth / no eviction.** Transcript buffers, `_toolNames`,
   `state.toolCards`, file/apk widget Maps, the DOM transcript, and the terminal
   scroll-back all grow without limit. **[RT✗ confirmed]** transcript DOM grows
   ~28 nodes/message with no virtualization. → Add caps + LRU eviction + lazy history.
3. **Synchronous disk writes on the event loop.** `sessions.json`, `usage.json`,
   transcript appends, secrets/profiles all use `writeFileSync` on hot paths — on
   proot/eMMC this stalls the loop. → Debounced async writes.
4. **`innerHTML` template-literal rendering of server/agent fields.** Many render
   paths interpolate event fields into `innerHTML`. **[RT✓ good]** the *user-input*
   bubble path is correctly escaped (an `<img onerror>`/`<script>` payload did not
   execute), but the pattern is fragile and inconsistent; markdown raw-HTML handling
   and agent-output paths need dedicated XSS testing. → Build nodes with `el()`+`textContent`.
5. **Missing confirmations on destructive actions.** Hook delete, prompt delete,
   unsaved file-edit discard have no confirm; other deletes do. → Consistent confirms.
6. **Accessibility baseline gaps.** `outline:none` with no `:focus-visible` almost
   everywhere; sub-44px touch targets; color-only status; unlabeled controls.
7. **Shell-string interpolation in git/gh commands** (devtools) is injectable. →
   `spawn` with arg arrays, never `shell:true` with interpolated user text.
8. **No exponential backoff / no visible "disconnected" state.** **[RT✗ confirmed]**
   dropping the socket shows no prominent reconnecting indicator; reconnect is a flat
   1.5s retry. → Backoff + jitter + a persistent banner after N failures.

**Highest-priority shortlist (security + correctness + data-loss):**
- **CONFIRMED XSS** — markdown link/autolink `href` isn't attribute-escaped, so an
  agent-emitted URL containing `"` injects live event-handler attributes that
  execute. PoC fired (`onmouseover` → handler ran). One-line fix. See §4.
- Shell injection in `devtools.js` git/gh ops (commit/push/PR/discard).
- Permission approval/interrupt routed to the *active* engine, not the requesting one.
- Permission IPC has **no timeout** and isn't flushed on engine crash → approval pipeline can hang forever.
- `_startLock` mutex is incorrect → closely-timed engine restarts run concurrently.
- Path-traversal: `files.js` symlink escape; `claude-config.deleteSession` raw `projectDir`.
- `_pendingTurn` global → revert metadata corruption across sessions.
- Android: `openExternal` accepts any URL/scheme; JS-bridge string escaping is unsafe.

---

## 1. Broker core & sessions  (`server.js`, `session.js`, `index.js`, `config.js`, `protocol.js`)

- **[High] `_startLock` mutex is incorrect** — race — `session.js:94–98` — a new lock Promise replaces the previous one before it's awaited, so concurrent callers run in parallel instead of serially; closely-timed restarts can orphan a child `claude`. → Proper async-mutex: `this._startLock = prev.then(runInner)`.
- **[High] Double snapshot on every connection** — bug — `server.js:131` + `385` — `_onConnection` sends a full snapshot AND the client's `hello` triggers a second; only `TRANSCRIPT` is idempotent, so PROFILES/PROJECTS/ENGINE_STATE/SESSIONS/CAPABILITIES/etc. fire twice. → Pick one trigger.
- **[High] `_pendingTurn` is global on a multi-session server** — bug — `server.js:144–149,409` — a background session's `user_echo` (e.g. autoverify) can consume the pending turn so the foreground echo loses `turnId`/`checkpointId`, corrupting revert. → `Map<sessionKey, pendingTurn>`.
- **[High] Checkpoint + pendingTurn setup only on `USER_MESSAGE`** — bug — `server.js:413–419` — `SLASH_COMMAND`/`COMPACT`/`CLEAR` bypass it, so slash-triggered file changes have no revert anchor; `/clear` wipes the transcript with no anchor. → Shared helper for all message-send paths.
- **[High] Permission approve/deny + interrupt routed to active engine** — bug — `session.js:248–249`, `server.js:417–420` — a background session's pending approval gets answered by the wrong engine if focus changed. → Carry `sessionKey` on APPROVE/DENY/INTERRUPT and route to `engines.get(key)`.
- **[High] effort/permission-mode change only restarts the active engine** — bug — `session.js:261–275` — value is stored globally but other live engines keep the old mode/effort; UI implies it applied everywhere. → Propagate to all live engines or scope+label per-session.
- **[Med] `/clear` doesn't drop the resume id** — bug — `server.js:410–412` — next restart `--resume`s the cleared session so the model context isn't actually blank. → delete `_sessionByProject[activeKey]` after `/clear`.
- **[Med] `RESUME` doesn't set `activeKey` before `resume()`** — bug — `server.js:441–470` — `resume()`'s no-key path may start the engine under a mismatched key vs the transcript target. → pass `{ key: targetKey, resumeId }`.
- **[Med] `setPermissionMode`/`setEffort` resume fallback ignores the `projectId`-keyed id** — bug — `session.js:261–275` vs `139` — cold-boot sessions whose id is only under the `projectId` key won't be found. → also check `_sessionByProject[projectId]`.
- **[Med] `SESSION_STOP`/`SESSION_PIN` accept unvalidated `cmd.key`** — robustness — `server.js:435–440` — silent no-op on bad key, no feedback. → validate + error event.
- **[Med] `_emitSessions` fires multiple times per engine event** — perf — `session.js:337–352` — STATUS + RESULT both broadcast in one microtask ×clients. → coalesce with a dirty flag.
- **[Med] `_saveSessions` is sync writeFileSync on every SESSION_META** — perf — `session.js:367` — blocks the loop on slow FS. → debounced async.
- **[Med] `stopAll()` runs after transcript flush** — bug — `server.js:98–116` — engine events during async shutdown aren't flushed to disk. → stop engines first, then flush.
- **[Med] `__main__` sleeping sessions excluded from `uiSessions()`** — missing-feature — `session.js:226` — a no-project session that's evicted vanishes irrecoverably without reload. → include with a label, or never evict `__main__`.
- **[Low] `_turnCheckpoints` never cleaned up** — leak — `server.js:394–395` — grows per session forever. → delete on SESSION_STOP/REVERT/forget.
- **[Low] `REVERT` doesn't reset `_pendingTurn`/`_turnCheckpoints`** — bug — `server.js:594–626` — stale turn metadata stamps the next echo. → clear after revert.
- **[Low] `ws.on('error')` swallows silently** — robustness — `server.js:129` — invisible even in verbose. → log it.
- **[Low] `_sendSnapshot` `sampleResources` not wrapped in try/catch** — bug — `server.js:316` — a throw aborts the whole greeting (unlike `_lifecycleTick`). → wrap it.
- **[Low] `SWITCH_ENGINE` only broadcasts PROFILES** — missing-feature — `server.js:518–523` — stale ENGINE_STATE/SESSIONS until the engine self-reports. → broadcast both after switch.
- **[Low] `config.js` doesn't validate `port`** — robustness — `config.js:44` — `--port foo` → `NaN` → confusing listen error. → range-check.
- **[Low] `SLASH_COMMAND` doesn't sanitize `cmd.name`** — robustness — `server.js:406–407` — empty/space/newline name sent verbatim. → validate `/^\w[\w-]*$/`.
- **[Low] `ack`/`pong` are bare string literals, not in `EventType`** — inconsistency — `protocol.js`, `server.js:382` — contract drift. → add `ACK`/`PONG`.
- **[Low] `SET_EFFORT` comment omits `ultracode`** — inconsistency — `protocol.js` — valid value undocumented. → update comment.

## 2. Engines & approval bridge  (`engines/*`, `jsonl.js`, `mcp/*`, `secrets.js`, `profiles.js`)

- **[High] Pending permissions dangle on engine crash** — bug — `claude-code.js:142–147` — `exit` handler doesn't flush `_pendingPermissions`; a mid-turn crash leaves the permission-server (and UI) blocked forever. → resolve all pending as deny + stop bridge on exit.
- **[High] Permission IPC has no timeout** — robustness — `permission-server.js:87–105`, `permission-bridge.js`, `claude-code.js:~470` — if the UI/tab closes, the approval Promise never resolves and the pipeline stalls. → configurable timeout (~120s) → deny + `PERMISSION_DENIED`.
- **[High] IPC connect race sets `ipcSocket` before `connect`** — race — `permission-server.js:82–84` — a socket that already errored may stay assigned; later `write` throws uncaught. → assign only inside the `connect` callback.
- **[High] `_sawTextDeltas`/`_sawThinkingDeltas` not reset per turn boundary** — bug — `claude-code.js:312–322,232–235` — a turn with no terminal `assistant` wrapper leaves stale flags → terminal text suppressed next turn. → also reset on `result`.
- **[Med] `_toolNames` never cleared** — leak/bug — `claude-code.js:277–288` — grows per session; reused tool ids would be wrongly deduped. → clear at `message_start`.
- **[Med] No `stdout.on('end')` flush** — bug — `jsonl.js`, `claude-code.js:136` — a final line without trailing newline is dropped. → flush on end.
- **[Med] `THINKING` status emitted after every assistant msg** — bug — `claude-code.js:168–169` — clobbers `RUNNING` when the message is tool-only; status flickers. → only emit if a text/thinking block was present.
- **[Med] `_pendingEcho` not cleared on interrupt/stop** — bug — `claude-code.js:~437,309` — an interrupt before the CLI replay leaves it set → suppresses the *next* turn's echo. → clear on interrupt/stop.
- **[Med] Permission TCP bridge unauthenticated** — security — `permission-bridge.js:39–45` — any local process can inject allow/deny or read pending tool inputs (relevant on shared-localhost Android). → shared-secret token handshake.
- **[Med] `endProcess` clears the SIGKILL timer in `catch`, not on `exit`** — bug — `claude-code.js:572–591` — timer can fire after resolve; exit listener can leak. → clearTimeout in the exit callback.
- **[Med] opencode `_teardown` doesn't await exit** — robustness — `opencode.js:211–227` — orphan keeps the port; next spawn binds the wrong server. → wait for exit w/ SIGKILL fallback.
- **[Med] opencode `_subscribeEvents` not awaited; `send` ignores non-200** — race/missing-path — `opencode.js:52,183–194` — early SSE events lost; failed sends look successful. → await + check `res.ok`.
- **[Med] `profiles.json` written world-readable** — security — `profiles.js:89` — no `mode:0o600` (secrets.json has it). → add restrictive mode.
- **[Low] `windowForModel` regex over-broad** — bug — `claude-code.js:~528` — `1m` substring match; no 200k/500k support. → explicit model→window map.
- **[Low] opencode port 4096 hardcoded, no conflict detection** — robustness — `opencode.js:33` — a foreign server on 4096 is treated as opencode. → nonce/PID check.
- **[Low] `base.start()` leaves state `starting` if `_spawn` throws** — robustness — `base.js:48–54` — stop/start logic then misbehaves. → try/catch → `stopped` + rethrow.
- **[Low] `profiles/_load` overwrites a corrupt file with defaults silently** — robustness — `profiles.js:76–85` — user customizations lost without warning. → warn/toast.
- **[Low] `secrets.set` swallows write errors** — robustness — `secrets.js:40–46` — secret silently not persisted. → return/throw status.

## 3. Control modules  (`controls/*`)

- **[High] Symlink path-traversal in `files.js`** — security — `files.js:23–27` — `path.resolve` doesn't follow symlinks; `project/evil → /etc` escapes the containment check. → `fs.realpathSync` before the prefix check, or reject symlinks.
- **[High] Shell injection in git ops** — security — `devtools.js:112–123,193–211` — commit/push/PR message + `discard`/`add` paths interpolate user strings into `shell:true` commands; `$(...)`/backticks execute. → `spawn`/`spawnSync` with arg arrays, no shell.
- **[High] Raw `projectDir` traversal in `claude-config.deleteSession`** — security — `claude-config.js:64–76` — `path.join(.../projects, projectDir)` with no sanitization → `../../etc`. → reject separators/`..`.
- **[High] Checkpoint temp-index races across concurrent turns** — race — `checkpoints.js:45–56` — shared `<project>.index`/`.diffindex` corrupt each other when autoverify + a new turn overlap. → per-session/random temp filenames.
- **[High] `autoverify.active` can stick true** — bug — `autoverify.js:66–75` — a synchronous throw from `run()` skips `active=false`, permanently disabling autoverify. → `finally`.
- **[Med] `process-runner.stop` deletes tracking before exit** — race — `process-runner.js:107` — `isRunning` returns false while the proc lives → double Metro spawn. → delete in the exit handler only.
- **[Med] `transcript` buffers never evicted** — leak — `transcript.js:41–46` — one buffer per session key ever viewed, up to 1500 events each. → LRU cap.
- **[Med] Transcript `_load` aborts whole file on one bad line** — robustness — `transcript.js:31–38` — a partial last append (kill mid-write) loses the whole transcript on reload. → per-line try/catch (as `readSessionTranscript` does).
- **[Med] Checkpoint restore leaves empty agent-created dirs** — bug — `checkpoints.js:119–125` — only files removed, not new directories. → second pass rmdir empties / targeted `git clean -fd`.
- **[Med] `files.replaceAll` not atomic** — robustness — `files.js:205` — a kill mid-loop leaves a half-replaced tree. → temp-file + rename, or require a checkpoint.
- **[Med] `usage-ledger` writes on every record** — perf — `usage-ledger.js:39–50` — sync write per turn. → debounce.
- **[Med] `updater._toplevel` cached on failure** — robustness — `updater.js:29–33` — a transient error permanently points `git pull` at a fallback dir. → cache only on success.
- **[Med] `updater.update` doesn't pre-check a dirty tree** — robustness — `updater.js:47–68` — `--ff-only` fails opaquely. → `git status --porcelain` first + actionable message/option.
- **[Med] `claude-config.encodeCwd` may diverge from Claude's real encoding** — inconsistency — `claude-config.js:583–587` — a mismatch makes every session→project mapping null (the live cause of "folder unknown"). → verify against a known path + add a test.
- **[Med] per-project (50) vs all-sessions (120) caps inconsistent** — inconsistency — `claude-config.js:322,332` — same project shows different counts in different views. → unify/document.
- **[Med] `model-resolver` `_inFlight` guard is racy** — race — `model-resolver.js:40–49` — overlapping `list()` calls can double-resolve. → per-alias promise map / mutex.
- **[Low] `autoverify.iteration` not reset on configure** — bug — `autoverify.js:44–49` — stale iteration vs new max confuses the UI. → reset in configure.
- **[Low] hook `delete` removes the whole group** — bug — `claude-config.js:559–565` — ignores the third id part (`event#gi#hi`) and splices the group. → splice `hooks[event][gi].hooks` at `hi`.
- **[Low] Metro port = base + array index** — bug — `projects.js:58,82` — deleting a project shifts others' ports, orphaning running Metro. → persist a stable port per project id.
- **[Low] `frontmatter` key regex drops dotted keys** — bug — `frontmatter.js:14` — `allowed.tools` silently skipped. → broaden key charset.
- **[Low] `resources.evictionCandidates` 88% hardcoded, no feedback** — missing-feature — `resources.js:104–109` — backstop may never fire on Android (page cache); UI can't see threshold. → configurable + expose usedPct/threshold.
- **[Low] `transcript.truncateBefore` always hits the active buffer** — bug — `transcript.js:141–152` — a revert while focused elsewhere truncates the wrong session. → accept a `key`.
- **[Low] `prompts.save` accepts whitespace-only names** — robustness — `prompts.js:42–47` — `' '` stored, dup risk. → trim+validate non-empty.

## 4. Web UI core  (`app.js`, `markdown.js`, `diff.js`)

- **[High] `scrollDown()` force-snaps to bottom on every delta** — ux — `app.js:~1990` (~20 callers) — reading scroll-back while the agent streams yanks you back every token; the worst mobile papercut. → track an "at-bottom" flag; only auto-scroll when already pinned.
- **[High] Unbounded transcript DOM + Maps** — perf — `app.js:13,1109,1270` — **[RT✗ confirmed]** ~28 nodes/msg, never trimmed; `toolCards`/`fileWidgets`/`apkWidgets` grow forever → OOM/jank on long sessions. → cap rendered messages + lazy older history; prune Maps.
- **[High] CONFIRMED XSS — markdown link/autolink `href` not attribute-escaped** — security — `markdown.js:39,45` — **[RT✗ confirmed, PoC fired]** `inline()` escapes only `<>&` (not `"`), and `safeUrl(u)` returns the URL unescaped into `href="…"`. Payload `[x](https://a"onmouseover="window.__xss=1)` rendered `<a href="https://a" onmouseover="window.__xss=1" …>` — a **live event-handler attribute**; dispatching `mouseover` executed it (`window.__xss===1`). Agent output flows through `MD.render`, and agent output is influenceable by prompt-injection from files/web it reads → real exploit path. → run the URL through `escapeAttr()` (or reject URLs containing `"`/`'`/whitespace/control chars) before inserting into `href`. (Raw `<script>`/`<img onerror>` and fenced/inline HTML are correctly escaped — verified inert.)
- **[High] Other `innerHTML` template literals mix in server fields** — security — `app.js:1045,1361,1622` — **[RT✓ good]** the user-input bubble path is escaped (payload didn't fire), but tool head / denial / turn-changes build innerHTML from event fields; fragile if a field ever carries markup. → build via `el()`+`textContent`.
- **[Med] Flat 1.5s reconnect, no backoff, no "giving up"** — robustness — `app.js:~183` — **[RT✗ confirmed]** dropping the socket shows no prominent disconnected state. → exp backoff + jitter + persistent banner/manual reconnect after N tries.
- **[Med] `resetConversation()` on every reconnect blanks transcript before snapshot** — ux — `app.js:174,756` — flicker to empty state on flaky links. → reset only when the `reset:true` transcript arrives; show "Reconnecting…" overlay.
- **[Med] `renderTabs()` nukes `#tabs` innerHTML mid-gesture** — bug — `app.js:~412` — a `sessions` event during a tab drag detaches the dragged element → gesture stuck. → skip full re-render while `_tabGesture` active / diff in place.
- **[Med] Find-in-conversation mutates live DOM** — bug — `app.js:1704–1716` — `replaceChild`/`normalize` while streaming can mis-route the next RAF render; doesn't update `toolCards` refs. → find only on a static snapshot / disable while streaming.
- **[Med] Terminal scroll-back unbounded** — perf — `app.js:1762–1768` — big builds (`npm install`, gradle) append thousands of spans, no cap. → cap ~2000 lines, drop oldest.
- **[Med] Optimistic image-count suffix breaks echo dedup** — bug — `app.js:999,2031` — bubble shows `text+"\n📎 N images"` but `pendingSent` stores augmented text; server echo (plain text) doesn't match → duplicate bubble. → push un-augmented text.
- **[Med] `doSend()` double-send race** — bug — `app.js:2022–2041` — activity guard set after async work; simultaneous Enter+tap can pass twice. → set `activity='working'` synchronously at top.
- **[Med] `applyTranscript` replays with per-item activity/scroll churn** — perf — `app.js:1448–1459` — hundreds of `setActivity`/`scrollDown` during replay. → `replaying` flag; scroll once at end.
- **[Med] `markdown.js` fenced-code language tag discarded** — missing-feature — `markdown.js:85` — no `language-x` class for highlighting/labels. → capture as `data-lang`.
- **[Med] `diff.js` LCS allows 1.5M cells (~6MB) on main thread** — perf — `diff.js:9,84` — GC spike mid-stream on a Pixel. → lower threshold / off-thread.
- **[Low] `renderMd` writes full source to `dataset.md` every frame** — perf — `app.js:~842` — duplicates a large string into the DOM each RAF. → set once on finalize.
- **[Low] `exportMarkdown` anchor not appended; revoke at 1000ms** — bug — `app.js:1608` — fails silently in some WebViews; slow saves break. → append to body; revoke later.
- **[Low] `markdown.js` nested list misreads tab indent** — bug — `markdown.js:69` — tab-indented sublists render flat. → expand tabs first.
- **[Low] `markdown.js` blockquote recursion unbounded** — robustness — `markdown.js:117` — deep `>>>>` can blow the stack. → depth cap.
- **[Low] `addFileWidget` keyed by raw path** — bug — `app.js:1156` — absolute vs relative path → duplicate cards for one file. → normalize via `projectRelPath`.
- **[Low] `onUserEcho` stamps `lastUserBubble()` by DOM position** — bug — `app.js:969` — rapid double-send can stamp the wrong bubble's turnId. → match by per-send id.
- **[Low] `onSessions` clobbers `activeTabId` before broker ACKs switch** — ux — `app.js:297` — visible wrong-tab flash on switch. → `_pendingActiveKey` guard.
- **[Low] action buttons lack `aria-label`/`role`/`aria-expanded`** — a11y — `app.js` (approvals, tab ✕, tool toggles) — emoji-only to screen readers. → label them.

## 5. Web UI managers & shell  (`managers.js`, `index.html`)

- **[High] Hook delete + Prompt delete have no confirmation** — ux/data-loss — `managers.js:448,927` — a stray tap silently deletes; every other delete confirms. → add `confirm()`.
- **[High] File inline-edit discards unsaved changes on back** — data-loss — `managers.js:803` — "←" drops textarea edits with no prompt. → confirm if dirty.
- **[Med] No loading/skeleton state on any data pane** — ux — `managers.js:86–172` — shows "No skills/sessions yet" until async data lands (looks empty when it isn't). → "Loading…" placeholder.
- **[Med] Scope toggle re-renders with stale data** — ux — `managers.js:252` — renders before the new-scope response arrives. → request first / loading state.
- **[Med] Editor save closes optimistically, no error path** — robustness — `managers.js:342–346` — a rejected `config_write` still looks successful. → await ack / surface errors.
- **[Med] Name sanitization silently rewrites the typed name** — ux — `managers.js:344` — `[^\w-]→-` with no feedback. → reflect/warn.
- **[Med] Permissions: mode-select change isn't obviously unsaved; Enter in add-rule does nothing** — ux — `managers.js:385–428,414` — easy to think a change saved. → unsaved indicator / Enter handler / auto-save mode.
- **[Med] Session rename has no touch cancel (Escape only)** — a11y — `managers.js:488–498` — mobile keyboards lack Esc. → ✕ cancel / commit on blur.
- **[Med] Files dir-nav shows previous listing until response** — ux — `managers.js:785` — no loading clear. → clear + spinner on navigate.
- **[Med] Manager modal has no Escape-to-close** — a11y — `managers.js:84` — desktop expectation missing. → global keydown.
- **[Med] Commit with empty message sends `undefined`** — ux — `managers.js:882,1051` — relies on broker default or can hang git. → require/clarify.
- **[Low] `render()` rebuilds the whole modal on every tab/scope switch** — ux/a11y — `managers.js:87` — destroys focus / in-progress typing. → only `renderPane()` for tab switches.
- **[Low] Manager tab strip (20 tabs) has no scroll affordance** — ux — `managers.js:15`, `styles.css:831` — hidden scrollbar, offscreen tabs invisible. → edge fade / grouping.
- **[Low] Sessions grouped by `s.project` name (lossy)** — bug — `managers.js:519` — same-named projects merge. → group by `projectId`.
- **[Low] Projects browser builds child paths client-side** — bug — `managers.js:609` — can diverge from broker normalization. → broker returns full child paths.
- **[Low] Context "Compact" closes modal with no feedback** — ux — `managers.js:662` — no success/progress signal. → toast / stay open.
- **[Low] `section()` MCP helper takes raw HTML (footgun)** — security — `managers.js:696` — safe today, fragile by contract. → take text, escape internally.
- **[Low] Title/name inconsistency** — inconsistency — `index.html:6,31,98`, `manifest.json` — "On-Device Agent" vs "Agent". → one canonical name.

## 6. Styling, responsive & accessibility  (`styles.css`, `index.html`, `manifest.json`)

- **[High] No `:focus-visible` ring anywhere** — a11y — `styles.css:255,649,669,729,784,920,952` — bare `outline:none` on nearly every control; keyboard/switch users have no cursor. → `:focus-visible { outline:2px solid var(--accent); outline-offset:2px }`.
- **[High] `color-mix()` used 39× with no fallback** — a11y/compat — `styles.css:17,163,440,507,562,700,787` — unsupported in older WebView Chromium (targetSdk 28 devices) → status pills, active-tab border, find-hit, toasts render wrong. → rgba fallback before each use.
- **[High] Markdown tables overflow horizontally on phones** — responsive — `styles.css:449` — no scroll wrapper → page-level horizontal scroll. → wrap tables in `overflow-x:auto`.
- **[Med] Touch targets below 44px** — a11y — `styles.css:217 (tab-close 16px), 707 (attach-x 20px)` — frequent mis-taps. → ≥36–44px hit areas.
- **[Med] Composer selects strip focus ring** — a11y — `styles.css:255,669` — keyboard users can't tell focus. → `:focus-visible`.
- **[Med] No left/right safe-area insets** — responsive — `styles.css` — landscape notch overlaps navbar/composer/toasts. → `env(safe-area-inset-left/right)`.
- **[Med] `<main>` transcript + conn-dot lack accessible names/live region** — a11y — `index.html:33,90` — landmark unlabeled; connection state color-only, not announced. → `aria-label` + `role="status" aria-live`.
- **[Med] `reduced-motion` relies on near-zero durations + misses the shimmer** — a11y — `styles.css:977` — can stutter; thinking shimmer not explicitly stopped. → `animation:none` + explicit shimmer override.
- **[Low] `bypassPermissions` is the shipped default** — ux/security — `index.html:167` — every new session bypasses prompts. → default to "ask"; persist choice.
- **[Low] PWA icon: single SVG `any maskable`, no PNG rasters / Apple-touch PNG** — robustness — `manifest.json:11`, `index.html:13` — installers may ignore maskable; iOS ignores SVG. → split purposes + 192/512 PNG + apple-touch PNG. (flagged by 3 audits)
- **[Low] `theme-color` fixed dark, mismatches light mode** — ux — `index.html:8` — **[RT✓]** light mode bg is white but browser chrome stays dark. → two `media` theme-color metas.
- **[Low] `html-app-iframe` fixed 420px height** — responsive — `styles.css:490` — overflows short viewports. → `clamp(220px,55dvh,420px)`.

## 7. Android shell & provisioning  (`android/`, `provisioning/`)

- **[High] `openExternal(url)` accepts any URL/scheme from JS** — security — `WebAppBridge.kt:35–37` — XSS in rendered agent content could launch `intent://`/`file://`/deep links. → allow-list `http/https/exp`.
- **[High] JS-bridge string escape is unsafe** — security — `WebAppBridge.kt:39–43` — `esc()` misses backticks, `</script>`, ` / ` → can break out of the generated JS. → `JSONObject.quote()`.
- **[High] Foreground service has no `foregroundServiceType`** — robustness — `AndroidManifest.xml:44` — API 34+ refuses to start an untyped FGS. → declare `dataSync`/`specialUse`.
- **[High] Bootstrap tar extraction unsanitized** — security — `BootstrapManager.kt:70–76` — asset filename → ProcessBuilder; malicious tar could path-traverse out of `usrDir`. → validate extracted paths / `--one-top-level`.
- **[Med] `RuntimeLauncher.stop()` only SIGTERMs the top shell** — robustness — `RuntimeLauncher.kt:168` — proot guest + Node orphaned; port stays bound, secrets resident. → `destroyForcibly` + kill the process group.
- **[Med] Health-poll thread `while(true)` never stops** — robustness — `RuntimeLauncher.kt:145–166` — restart spawns a second poller. → cancellation flag / executor.
- **[Med] `RECEIVE_BOOT_COMPLETED` declared, no receiver** — missing-feature — `AndroidManifest.xml:12` — auto-start doesn't work; misleading permission. → add receiver or drop permission.
- **[Med] `PARTIAL_WAKE_LOCK` acquired with no timeout** — robustness/perf — `AgentForegroundService.kt:72` — OOM-kill without onDestroy → CPU awake till reboot. → bounded `acquire(ms)`.
- **[Med] Exported markdown written plaintext to cacheDir; `allowBackup=true`** — security — `MainActivity.kt:95`, `AndroidManifest.xml:20` — conversation/secrets backed up / not cleaned. → `allowBackup=false` or exclude cache; delete temp.
- **[Med] WebView `LOAD_NO_CACHE`** — perf — `AgentWebView.kt:46` — re-fetches all assets each load though they're `?v=` cache-busted. → `LOAD_DEFAULT`.
- **[Med] `setup-guest.sh` uses Termux `pkg` not present post-bootstrap** — robustness — `assets/scripts/setup-guest.sh:9` — silent `|| true` → proot-distro never installed. → pre-include in tarball / APT fallback.
- **[Low] WebChromeClient grants all media permissions** — security — `AgentWebView.kt:87` — XSS microapp could get camera. → grant audio-only.
- **[Low] `provision-debian.sh` installs EOL Node 12** — robustness — `provisioning/provision-debian.sh:22` — below broker's Node ≥21. → NodeSource setup.

## 8. Runtime-verified summary (live, mock engine, phone viewport)

What held up well (don't spend effort here): user-input **XSS escaping** (payload inert), raw `<script>`/`<img onerror>` and fenced/inline HTML **escaped inert**, **no horizontal overflow** from long tokens, **reload-mid-stream recovery** (no stuck-busy), **interrupt-mid-turn** (clean busy→idle, post-interrupt send works), **rapid tab-switching** (8 switches/3 sessions → exactly one active tab, no content bleed, 0 console errors), **background-stream suppression** on switch (idle foreground stays idle), markdown/widget rendering, manager panes render with **zero console errors** across all tabs, tab long-press menu, and the sleeping-tab + plan-panel + find-bar fixes from prior commits.

What reproduced as flaws: **unbounded transcript DOM growth**, **no visible disconnect/reconnect state**, **light-mode/theme-color mismatch**. (Force-scroll-on-stream and the per-session-state bugs are code-confirmed but need an interactive/real-engine repro to demo.)

Agent-output XSS now tested: raw `<script>`/`<img onerror>` and fenced/inline HTML are **correctly escaped (inert)**, but the markdown **link/autolink `href` is a confirmed, executable XSS** (PoC fired — see §4). Interrupt-mid-turn and rapid tab-switching (via taps) are now tested and clean. Still genuinely open: the **tab-drag-overlapping-a-`sessions`-event** race (needs an actual pointer drag concurrent with a heartbeat — `.click()` doesn't hit it), the force-scroll-on-stream papercut (needs a slow real stream to feel), and a long real coding session for memory/jank.

---

## 9. Historical suggested discussion / implementation order

The list below is preserved as audit history. Do not execute it literally without
first proving the item is still open on current HEAD.

0. **Confirmed XSS (historical):** attribute-escape the markdown link/autolink URL in `markdown.js`. PoC-verified at the time of the audit; verify against current `markdown.js` before editing.
1. **Security batch** (small, high value): devtools shell-injection → arg arrays; `files.js` symlink + `deleteSession` traversal; Android `openExternal` allow-list + JS-bridge `JSONObject.quote`; `profiles.json` mode.
2. **Approval-flow correctness**: route approve/deny/interrupt by `sessionKey`; permission IPC timeout + crash flush + bridge auth.
3. **Per-session state**: `_pendingTurn`/`_suppressEcho`/`_turnCheckpoints` → keyed maps; effort/permission-mode scope.
4. **Mutex + lifecycle**: fix `_startLock`; stop-engines-before-flush; debounce all JSON writes.
5. **UI scroll + memory**: at-bottom-aware autoscroll; cap transcript DOM + terminal + Maps with lazy history.
6. **Reconnect UX**: backoff + jitter + persistent disconnected banner.
7. **A11y + confirmations batch**: `:focus-visible`, touch targets, labels, Escape-to-close, delete confirms, `color-mix` fallbacks, table overflow.
8. **Android robustness**: FGS type, wake-lock bound, process-group kill, boot receiver, backup exclusions.
9. **Papercuts**: the remaining Low items as a cleanup sweep.
