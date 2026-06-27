import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { ProfileStore } from './profiles.js';
import { SecretStore } from './secrets.js';
import { ProcessRunner } from './controls/process-runner.js';
import { ProjectManager } from './controls/projects.js';
import { DevTools } from './controls/devtools.js';
import { ClaudeConfig } from './controls/claude-config.js';
import { ModelResolver, labelFor } from './controls/model-resolver.js';
import { Updater } from './controls/updater.js';
import { TranscriptStore } from './controls/transcript.js';
import { Checkpoints } from './controls/checkpoints.js';
import { Files } from './controls/files.js';
import { PromptLibrary } from './controls/prompts.js';
import { AutoVerify } from './controls/autoverify.js';
import { UsageLedger } from './controls/usage-ledger.js';
import { sampleResources, evictionCandidates } from './controls/resources.js';
import { SessionManager } from './session.js';
import { EventType, CommandType, event } from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_UI_DIR = path.join(__dirname, '..', 'web-ui');

/**
 * BrokerServer — the single localhost seam between the native/web UI and the
 * agent. Speaks the canonical protocol (protocol.js): commands in, canonical
 * events out. Also serves the bundled web UI over HTTP on the same port so you
 * can drive the whole stack from a browser with zero install.
 */
export class BrokerServer {
  constructor(config) {
    this.config = config;
    this.clients = new Set();
    this._nativeFingerprint = null;
    this._pendingTurn = new Map(); // sessionKey -> { turnId, checkpointId, text } for revert stamping
    this._turnCheckpoints = {};    // sessionKey -> checkpoint id taken before the active turn

    // All outbound events flow through one hook so we can record the transcript
    // and detect native-dep changes before broadcasting.
    const emit = (ev) => this._emitEvent(ev);

    this.profiles = new ProfileStore(config.stateDir);
    this.secrets = new SecretStore(config.stateDir);
    this.transcript = new TranscriptStore(config.stateDir);
    this.checkpoints = new Checkpoints({ stateDir: config.stateDir });
    this.prompts = new PromptLibrary(config.stateDir);
    this.runner = new ProcessRunner({ emit, log: (m) => this._log(m) });
    this.projects = new ProjectManager({ config, runner: this.runner, emit });
    // Fall back to projectsDir (the cwd the engine actually uses when no project
    // is active) so file browsing + session lookup match where Claude ran.
    const getProjectDir = () => this.projects.getActive()?.dir || config.projectsDir;
    this.files = new Files({ getProjectDir });
    this.devtools = new DevTools({ config, runner: this.runner, projects: this.projects, emit });
    this.claudeConfig = new ClaudeConfig({ getProjectDir, getProjects: () => this.projects.list(), stateDir: config.stateDir });
    this.modelResolver = new ModelResolver({ stateDir: config.stateDir, claudeBin: config.claudeBin });
    this.updater = new Updater();
    this.session = new SessionManager({
      config,
      profiles: this.profiles,
      secrets: this.secrets,
      getActiveProject: () => this.projects.getActive(),
      getProject: (id) => this.projects.get(id), // resolve a session's own folder for cold-resume
      emit,
    });
    this.transcript.setProject(this.session.activeKey); // same key convention as sessions (project.id | '__main__')

    this.usage = new UsageLedger(config.stateDir);
    this.autoverify = new AutoVerify({
      stateDir: config.stateDir,
      runner: this.runner,
      emit,
      sendFix: (text) => this.session.sendUserMessage(text),
    });

    this.httpServer = http.createServer((req, res) => this._serveStatic(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => this._onConnection(ws));
  }

  start() {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, () => {
        const url = `http://${this.config.host}:${this.config.port}`;
        process.stderr.write(`\n  on-device agent broker\n`);
        process.stderr.write(`  WebSocket : ws://${this.config.host}:${this.config.port}\n`);
        process.stderr.write(`  Web UI    : ${url}\n`);
        process.stderr.write(`  Projects  : ${this.config.projectsDir}\n`);
        process.stderr.write(`  Profile   : ${this.config.defaultProfile}\n\n`);
        resolve(url);
      });
    });
  }

  async stop() {
    if (this._resTimer) { clearInterval(this._resTimer); this._resTimer = null; } // stop sampling before engines die
    this.runner.stopAll();
    // Force-close client sockets (don't wait on a polite close handshake) and
    // destroy any lingering keep-alive HTTP/WebSocket sockets — otherwise
    // httpServer.close() blocks until the browser's connection drains, which can
    // take a long time. closeAllConnections is Node 18.2+; the index.js timer is
    // the final backstop on older runtimes.
    for (const ws of this.clients) { try { ws.terminate(); } catch { /* ignore */ } }
    this.clients.clear();
    try { this.wss.close(); } catch { /* ignore */ }
    try { this.httpServer.closeAllConnections?.(); } catch { /* ignore */ }
    // Close the HTTP server + stop all engines, but never block shutdown forever.
    await Promise.race([
      (async () => {
        await new Promise((r) => this.httpServer.close(() => r()));
        await this.session.stopAll();
      })(),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    // Flush AFTER engines stop so any text they emitted during async shutdown — and
    // every background session's buffer, not just the active one — reaches disk.
    try { this.transcript.flushAll(); } catch { /* ignore */ }
    try { this.session.flushSessionsFile?.(); } catch { /* ignore */ }
  }

  // --- websocket --------------------------------------------------------------

  _onConnection(ws) {
    this.clients.add(ws);
    this._log(`client connected (${this.clients.size} total)`);
    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('close', () => {
      this.clients.delete(ws);
      this._log(`client disconnected (${this.clients.size} total)`);
    });
    ws.on('error', (err) => { this._log(`ws error: ${err?.message || err}`); this.clients.delete(ws); });
    // Greet with a full state snapshot.
    this._sendSnapshot(ws);
  }

  /** Central outbound hook. Every engine event is tagged with `sessionKey`; we
   *  record it to ITS session's transcript and do its bookkeeping against ITS
   *  project, but only the ACTIVE session's full stream reaches the UI (background
   *  sessions are surfaced via the SESSIONS event / busy badge instead). */
  _emitEvent(ev) {
    const activeKey = this.session.activeKey;
    const key = ev.sessionKey != null ? ev.sessionKey : activeKey;
    try {
      // Stamp the turn/checkpoint id onto the active turn's user_echo (FIFO, one in
      // flight) so its bubble can be reverted later. Must precede transcript.record.
      // (The engine emits this echo up front now — see claude-code `send()` — so it
      // records ABOVE the agent's response and replays in order.)
      if (ev.type === EventType.USER_ECHO) {
        const pt = this._pendingTurn.get(key); // keyed per-session: a background echo can't steal it
        if (pt) { ev.turnId = pt.turnId; ev.checkpointId = pt.checkpointId; this._pendingTurn.delete(key); }
      }
      this.transcript.record(ev); // routes by ev.sessionKey -> per-session buffer
      // Learn alias -> versioned id from the ACTIVE engine's init only (a background
      // engine's init must not train the resolver against the foreground's alias).
      if (ev.type === EventType.CAPABILITIES && ev.model && key === activeKey && this.session.currentModel) {
        this.modelResolver.observe(this.session.currentModel, ev.model);
      }
      if (ev.type === EventType.USAGE) {
        const profile = this.session.meta.get(key)?.profileId || this.session.activeProfileId;
        this.usage.record({ inTok: ev.inTok, outTok: ev.outTok, cost: ev.cost, profile });
      }
      if (ev.type === EventType.RESULT) {
        const proj = this._projectForKey(key);
        if (proj) {
          this._checkNativeChange(proj);
          this._emitTurnChanges(key, proj);
          // Self-healing verify runs for the foreground session only (Phase 1).
          if (key === activeKey) this.autoverify.onTurnComplete(proj.dir);
        }
        this._maybeBroadcastApks(key);
      }
      // A build (run/eas/gradle) finishing may have produced an .apk/.aab.
      if (ev.type === EventType.CONTROL_STATUS && (ev.state === 'done' || ev.state === 'exited')) {
        this._maybeBroadcastApks(key);
      }
    } catch {
      /* never let bookkeeping break the stream */
    }
    // Suppress a background session's full stream from the foreground UI.
    if (ev.sessionKey == null || ev.sessionKey === activeKey) this.broadcast(ev);
  }

  /** A session key is no longer the projectId (a folder can hold several sessions),
   *  so resolve the engine's own folder via its meta.projectId; fall back to treating
   *  the key as a projectId for the first/single session (key === projectId). */
  _projectForKey(key) {
    if (!key || key === '__main__') return null;
    const pid = this.session.meta.get(key)?.projectId;
    return (pid && this.projects.get(pid)) || this.projects.get(key) || null;
  }

  /** One resource sample + lifecycle pass: broadcast RESOURCES, then idle-evict
   *  (memory-pressure LRU + 5-min idle) — never a working/focused/pinned session.
   *  Returns the sample. Exposed so tests can drive a deterministic tick. */
  _lifecycleTick() {
    const IDLE_TTL_MS = 5 * 60 * 1000;
    let sample;
    try { sample = sampleResources(this.session.liveSessions()); } catch { return null; }
    const lowMemPct = this.config.memEvictPct;
    // Expose the active threshold + current usage so the UI can show how close we
    // are to evicting (it was a hidden 88% constant before).
    if (sample.mem) sample.mem.evictThreshold = lowMemPct;
    try { this.broadcast(event(EventType.RESOURCES, sample)); } catch { /* ignore */ }
    for (const key of evictionCandidates(sample, { lowMemPct })) this.session.stopEngineKeepTranscript(key);
    for (const s of sample.engines) {
      if (s.status === 'idle' && !s.pinned && !s.active && s.idleMs >= IDLE_TTL_MS) {
        this.session.stopEngineKeepTranscript(s.key);
      }
    }
    return sample;
  }

  /** Start the periodic lifecycle sampler. Called by the real entry point (index.js),
   *  NOT in the constructor, so tests stay deterministic (no surprise evictions). */
  startLifecycle(intervalMs = 5000) {
    if (this._resTimer) return;
    this._resTimer = setInterval(() => this._lifecycleTick(), intervalMs);
    this._resTimer.unref?.();
  }

  /** (Re)send the cross-project sessions list with live-busy overlay. */
  _sendSessionsList(ws) {
    const items = this.claudeConfig.listAllSessions();
    const liveBusy = {};
    for (const s of this.session.liveSessions()) if (s.sessionId) liveBusy[s.sessionId] = s.busy;
    const ev = event(EventType.CONFIG, { kind: 'sessions', scope: 'all', items, liveBusy, activeSessionId: this.session.engine?.sessionId || null });
    if (ws) this._send(ws, ev); else this.broadcast(ev);
  }

  /** Bring a session to the foreground WITHOUT stopping the previous one (it keeps
   *  running in the background). Replays that session's transcript + state. */
  async _switchView(key) {
    this.transcript.setProject(key);
    this._seedApks(); // re-baseline apks for the (possibly new) active project before any build can fire
    await this.session.setActiveKey(key); // ensures an engine for `key`, keeps siblings alive
    this.broadcast(event(EventType.TRANSCRIPT, { events: this.transcript.replay(), reset: true }));
    this.broadcast(event(EventType.ENGINE_STATE, { state: this.session.engine?.state || 'stopped', ...this.session.snapshot }));
    this.broadcast(event(EventType.PERMISSION_MODE, { mode: this.session.permissionMode }));
    if (this.session.lastCapabilities) this.broadcast(this.session.lastCapabilities);
    const p = this.projects.getActive();
    if (p) this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir)));
    this.broadcast(event(EventType.SESSIONS, { items: this.session.uiSessions(), activeKey: this.session.activeKey }));
  }

  _emitTurnChanges(key, proj) {
    const cpId = this._turnCheckpoints && this._turnCheckpoints[key];
    if (!proj || !cpId || !this.checkpoints.isRepo(proj.dir)) return;
    const ch = this.checkpoints.changesSince(proj.id, proj.dir, cpId);
    if (ch && ch.files && ch.files.length) {
      this.broadcast(event(EventType.TURN_CHANGES, { checkpointId: cpId, files: ch.files, stat: ch.stat, sessionKey: key }));
    }
  }

  _checkNativeChange(proj) {
    const active = proj || this.projects.getActive();
    if (!active) return;
    const fp = this.devtools.nativeFingerprint(active.id);
    if (!fp) return;
    const sig = JSON.stringify(fp);
    if (this._nativeFingerprint && this._nativeFingerprint !== sig) {
      this.broadcast(event(EventType.NATIVE_CHANGE, { deps: fp.nativeDeps, plugins: fp.plugins }));
    }
    this._nativeFingerprint = sig;
  }

  broadcast(ev) {
    const data = JSON.stringify(ev);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  _send(ws, ev) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(ev));
      } catch {
        /* ignore */
      }
    }
  }

  _sendSnapshot(ws) {
    this._send(ws, event(EventType.PROFILES, {
      profiles: this.profiles.list().map((p) => ({
        ...p,
        ready: this.secrets.isReady(p),
      })),
      activeProfileId: this.session.activeProfileId,
    }));
    this._send(ws, event(EventType.PROJECTS, this.projects.snapshot()));
    const active = this.projects.getActive();
    if (active) {
      const metro = this.devtools.metroInfo(active.id);
      if (metro) this._send(ws, event(EventType.METRO_STATUS, metro));
    }
    this._send(ws, event(EventType.ENGINE_STATE, {
      state: this.session.engine?.state || 'stopped',
      ...this.session.snapshot,
    }));
    this._send(ws, event(EventType.PERMISSION_MODE, { mode: this.session.permissionMode }));
    // Live sessions (so a reconnecting client restores the background busy badges).
    this._send(ws, event(EventType.SESSIONS, { items: this.session.uiSessions(), activeKey: this.session.activeKey }));
    if (this.session.lastCapabilities) this._send(ws, this.session.lastCapabilities);
    // Replay the recorded conversation so reloads/reconnects don't lose history.
    // reset:true makes it idempotent — the server greets with a snapshot AND the
    // client sends `hello`, so two replays could otherwise double the transcript.
    // Always send it (even when empty) so a reconnecting client can rebuild from
    // reset:true in place instead of eagerly blanking on open (which flickered).
    const replay = this.transcript.replay();
    this._send(ws, event(EventType.TRANSCRIPT, { events: replay, reset: true }));
    if (active) this._send(ws, event(EventType.CHECKPOINTS, this.checkpoints.list(active.id, active.dir)));
    this._send(ws, event(EventType.PROMPTS, { items: this.prompts.list() }));
    this._send(ws, event(EventType.AUTOVERIFY, {
      enabled: this.autoverify.enabled, command: this.autoverify.command,
      maxIterations: this.autoverify.maxIterations, iteration: this.autoverify.iteration,
    }));
    // Seed the APK baseline silently (no widget) so PRE-EXISTING artifacts on disk
    // never render in a session that didn't build them; freshly-built apks surface
    // via _maybeBroadcastApks and persist through the per-session transcript.
    this._seedApks();
    // Don't let a resource-sampling throw abort the rest of the greeting (effort,
    // models) — the snapshot must always finish. (_lifecycleTick is already guarded.)
    try { this._send(ws, event(EventType.RESOURCES, sampleResources(this.session.liveSessions()))); }
    catch (e) { this._log(`resource sample failed: ${e?.message || e}`); }
    // Current effort + whatever model labels we already know (no probe spawn here).
    this._send(ws, event(EventType.EFFORT, { level: this.session.effort }));
    this._send(ws, this._modelsEvent());
  }

  /** Build a MODELS event from the active profile + cached alias->id (no spawn). */
  _modelsEvent() {
    const profile = this.profiles.get(this.session.activeProfileId);
    const aliases = profile?.models?.length ? profile.models : profile?.model ? [profile.model] : [];
    const cache = this.modelResolver.cache;
    const items = aliases.map((alias) => ({ alias, id: cache[alias] || null, label: labelFor(alias, cache[alias]) }));
    return event(EventType.MODELS, { items, resolvedModel: this.session.engine?.model || null });
  }

  // Kinds the CLI reads ONLY at system/init — editing them needs a re-scan.
  static RESCAN_KINDS = new Set(['skills', 'commands', 'agents', 'output-styles', 'mcp']);

  /** After writing/deleting a harness resource, re-spawn the engine (resuming
   *  the session) so the new slash command / agent / MCP becomes live, and tell
   *  the user. The capabilities re-broadcast happens via the restarted init. */
  async _rescanIfHarness(kind, name, verbed) {
    if (!BrokerServer.RESCAN_KINDS.has(kind)) return;
    const restarted = await this.session.refreshCapabilities();
    const noun = kind.replace(/s$/, '');
    this.broadcast(event(EventType.TOAST, {
      message: restarted
        ? `${noun} "${name}" ${verbed} — reloaded the session.`
        : `${noun} "${name}" ${verbed} on next session start.`,
    }));
  }

  /** Resolve any unknown model aliases (free init-probe) then broadcast MODELS. */
  async _sendModels(ws, refresh) {
    const profile = this.profiles.get(this.session.activeProfileId);
    const aliases = profile?.models?.length ? profile.models : profile?.model ? [profile.model] : [];
    // Only claude-code profiles emit a resolvable system/init id; others stay as-is.
    if (profile?.harness === 'claude-code' && aliases.length) {
      const env = this.secrets.envForProfile(profile);
      const cwd = this.projects.getActive()?.dir || this.config.projectsDir;
      try { await this.modelResolver.list(aliases, { cwd, env, refresh }); } catch { /* keep labels */ }
    }
    return this.broadcast(this._modelsEvent());
  }

  async _onMessage(ws, raw) {
    let cmd;
    try {
      cmd = JSON.parse(raw.toString('utf8'));
    } catch {
      return this._send(ws, event(EventType.ERROR, { message: 'Malformed command JSON' }));
    }
    try {
      await this._dispatch(ws, cmd);
      this._send(ws, event(EventType.ACK, { ofType: cmd.type, ok: true }));
    } catch (e) {
      this._log(`command '${cmd.type}' failed: ${e.message}`);
      this._send(ws, event(EventType.ACK, { ofType: cmd.type, ok: false, message: e.message }));
      this._send(ws, event(EventType.ERROR, { message: e.message }));
    }
  }

  async _dispatch(ws, cmd) {
    switch (cmd.type) {
      case CommandType.HELLO:
        // The full snapshot is already sent once on connection; re-sending it here
        // (the client sends `hello` on open) just doubled every greeting event.
        return;
      case CommandType.PING:
        return this._send(ws, event(EventType.PONG, {}));

      // conversation
      case CommandType.USER_MESSAGE: {
        this.autoverify.resetChain(); // a real user message starts a fresh fix-chain
        // Auto-checkpoint the project before the turn so it can be rewound.
        const proj = this.projects.getActive();
        let checkpointId = null;
        if (proj && this.checkpoints.isRepo(proj.dir)) {
          const cp = this.checkpoints.snapshot(proj.id, proj.dir, (cmd.text || 'turn').slice(0, 60));
          if (cp) {
            this._turnCheckpoints[this.session.activeKey] = cp.id; // per-session baseline
            checkpointId = cp.id;
            this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(proj.id, proj.dir)));
          }
        }
        // Tag the upcoming user_echo so its bubble can be reverted to here later.
        // Set even when not a git repo (checkpointId null -> conversation-only revert).
        // The engine emits the echo up front (claude-code `send()` / mock), so it
        // records ABOVE the agent's response and replays in chronological order.
        this._turnSeq = (this._turnSeq || 0) + 1;
        this._pendingTurn.set(this.session.activeKey, { turnId: `t${this._turnSeq}`, checkpointId, text: cmd.text || '' });
        return this.session.sendUserMessage(cmd.text || '', cmd.images);
      }
      case CommandType.SLASH_COMMAND: {
        // Validate the command name — it's interpolated into the prompt sent to the
        // CLI; an empty/whitespace/newline name would send a malformed `/` line.
        const name = String(cmd.name || '').trim();
        if (!/^[\w][\w-]*$/.test(name)) {
          return this._send(ws, event(EventType.ERROR, { message: `Invalid slash command: ${JSON.stringify(cmd.name)}` }));
        }
        return this.session.sendUserMessage(`/${name}${cmd.args ? ' ' + cmd.args : ''}`);
      }
      case CommandType.COMPACT:
        return this.session.sendUserMessage(`/compact${cmd.focus ? ' ' + cmd.focus : ''}`);
      case CommandType.CLEAR:
        this.transcript.clear();
        // Drop the stored resume id so the NEXT engine start doesn't `--resume` the
        // just-cleared session (which would silently restore the model context the
        // user asked to wipe). /clear itself blanks the live CLI session.
        this.session.dropActiveResume();
        return this.session.sendUserMessage('/clear');
      case CommandType.INTERRUPT:
        return this.session.interrupt();

      // permissions
      case CommandType.APPROVE:
        return this.session.respondPermission(cmd.id, 'allow', { updatedInput: cmd.updatedInput }, cmd.sessionKey);
      case CommandType.DENY:
        return this.session.respondPermission(cmd.id, 'deny', { reason: cmd.reason }, cmd.sessionKey);
      case CommandType.SET_PERMISSION_MODE:
        await this.session.setPermissionMode(cmd.mode);
        return this.broadcast(event(EventType.PERMISSION_MODE, { mode: cmd.mode }));

      // session / engine
      case CommandType.NEW_SESSION: {
        // A new concurrent session (fresh tab) in the active folder; siblings keep
        // running. Point the transcript at the new key and start it blank.
        await this.session.newSession();
        this.transcript.setProject(this.session.activeKey);
        this.broadcast(event(EventType.TRANSCRIPT, { events: this.transcript.replay(), reset: true }));
        this.broadcast(event(EventType.SESSIONS, { items: this.session.uiSessions(), activeKey: this.session.activeKey }));
        return;
      }
      case CommandType.SESSION_STOP:
        if (!cmd.key || !this.session.meta.has(cmd.key)) return this._send(ws, event(EventType.ACK, { ok: false, message: 'Unknown session key' }));
        await this.session.stopEngineKeepTranscript(cmd.key);
        delete this._turnCheckpoints[cmd.key]; // drop the stale per-turn baseline
        return this.broadcast(event(EventType.SESSIONS, { items: this.session.uiSessions(), activeKey: this.session.activeKey }));
      case CommandType.SESSION_PIN:
        if (!cmd.key || !this.session.meta.has(cmd.key)) return this._send(ws, event(EventType.ACK, { ok: false, message: 'Unknown session key' }));
        this.session.setPinned(cmd.key, cmd.pinned);
        return this.broadcast(event(EventType.SESSIONS, { items: this.session.uiSessions(), activeKey: this.session.activeKey }));
      case CommandType.RESUME: {
        // Resume a session in ITS OWN project (so the engine spawns with the right
        // cwd and other projects' background engines stay alive — switching project
        // here uses setActive, not a manager-wide stop).
        const all = this.claudeConfig.listAllSessions();
        const meta = all.find((s) => s.id === cmd.sessionId);
        let projectId = cmd.projectId || meta?.projectId || null;
        if (projectId && this.projects.get(projectId)) {
          if (projectId !== this.projects.activeId) {
            this.projects.setActive(projectId);
            this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
          }
        } else {
          if (projectId) projectId = null;
          this.broadcast(event(EventType.TOAST, { message: 'Couldn’t match this session to a known folder — resuming in the active one.' }));
        }
        // Point the transcript store at the (now) active session key and seed it
        // from the CORRECT project's .jsonl. Claude's --resume restores model
        // context but doesn't re-stream past turns, so we replay them ourselves.
        const targetKey = this.projects.getActive()?.id || '__main__';
        this.transcript.setProject(targetKey);
        this._seedApks(); // baseline the resumed project's apks so a later build still surfaces
        const dir = projectId ? this.claudeConfig.sessionsDirForProject(projectId) : null;
        const past = this.claudeConfig.readSessionTranscript(cmd.sessionId, { dir });
        const seeded = this.transcript.replace(past);
        this.broadcast(event(EventType.TRANSCRIPT, { events: seeded, reset: true }));
        // resume() restarts ONLY the active project's engine (siblings untouched).
        await this.session.resume(cmd.sessionId);
        const p = this.projects.getActive();
        if (p) this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir)));
        return;
      }
      case CommandType.SESSION_RENAME: {
        this.claudeConfig.renameSession(cmd.id, cmd.title);
        return this._sendSessionsList(ws);
      }
      case CommandType.SESSION_DELETE: {
        const liveEntry = this.session.liveSessions().find((s) => s.sessionId === cmd.id);
        const res = this.claudeConfig.deleteSession(cmd.id, { projectId: cmd.projectId, projectDir: cmd.projectDir });
        if (res.error) { this.broadcast(event(EventType.ERROR, { message: `Delete failed: ${res.error}` })); return; }
        this.broadcast(event(EventType.TOAST, { message: 'Session deleted.' }));
        // If a live engine was using this session, don't leave it pointed at a now
        // -missing file (a later restart would --resume a deleted id and fail).
        if (liveEntry) {
          if (liveEntry.key === this.session.activeKey) {
            this.transcript.clear();
            await this.session.newSession(); // fresh session for the foreground
            this.broadcast(event(EventType.TRANSCRIPT, { events: this.transcript.replay(), reset: true }));
          } else {
            await this.session.forgetSession(liveEntry.key); // drop the dead id + engine
          }
        }
        this._sendSessionsList(ws);
        this.broadcast(event(EventType.SESSIONS, { items: this.session.uiSessions(), activeKey: this.session.activeKey }));
        return;
      }
      case CommandType.LIST_SESSIONS: {
        const items = cmd.scope === 'all' ? this.claudeConfig.listAllSessions() : this.claudeConfig.list('sessions');
        const liveBusy = {};
        for (const s of this.session.liveSessions()) if (s.sessionId) liveBusy[s.sessionId] = s.busy;
        return this._send(ws, event(EventType.CONFIG, {
          kind: 'sessions', scope: cmd.scope || 'project', items, liveBusy,
          activeSessionId: this.session.engine?.sessionId || null,
        }));
      }
      case CommandType.LIST_LIVE_SESSIONS:
        return this._send(ws, event(EventType.SESSIONS, { items: this.session.uiSessions(), activeKey: this.session.activeKey }));
      case CommandType.SWITCH_SESSION: {
        // A session key may be suffixed (projA#2), so resolve its folder via meta;
        // keep projects.activeId synced to the focused session's project.
        const pid = this.session.meta.get(cmd.key)?.projectId || (cmd.key && cmd.key !== '__main__' ? cmd.key : null);
        if (pid && this.projects.get(pid) && pid !== this.projects.activeId) {
          this.projects.setActive(pid);
          this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
        }
        await this._switchView(cmd.key);
        return;
      }
      case CommandType.SWITCH_ENGINE:
        await this.session.switchEngine(cmd.profileId);
        return this.broadcast(event(EventType.PROFILES, {
          profiles: this.profiles.list().map((p) => ({ ...p, ready: this.secrets.isReady(p) })),
          activeProfileId: this.session.activeProfileId,
        }));
      case CommandType.SWITCH_MODEL:
        return this.session.switchModel(cmd.model);
      case CommandType.MODELS_LIST:
        return this._sendModels(ws, !!cmd.refresh);
      case CommandType.SET_EFFORT:
        await this.session.setEffort(cmd.level);
        return this.broadcast(event(EventType.EFFORT, { level: cmd.level }));
      case CommandType.APP_VERSION:
        return this._send(ws, event(EventType.APP_VERSION, await this.updater.version()));
      case CommandType.APP_UPDATE: {
        this.broadcast(event(EventType.APP_UPDATE, { state: 'updating' }));
        const res = await this.updater.update();
        return this.broadcast(event(EventType.APP_UPDATE, res));
      }

      // harness config: skills / agents / commands / memory / settings
      case CommandType.CONFIG_LIST:
        return this._send(ws, event(EventType.CONFIG, {
          kind: cmd.kind, scope: cmd.scope || 'project',
          items: this.claudeConfig.list(cmd.kind, cmd.scope || 'project'),
        }));
      case CommandType.CONFIG_READ:
        return this._send(ws, event(EventType.CONFIG, {
          kind: cmd.kind, scope: cmd.scope || 'project', name: cmd.name,
          item: this.claudeConfig.read(cmd.kind, cmd.name, cmd.scope || 'project'),
        }));
      case CommandType.CONFIG_WRITE: {
        const res = this.claudeConfig.write(cmd.kind, cmd.name, cmd.scope || 'project', cmd);
        if (res.error) this.broadcast(event(EventType.ERROR, { message: res.error }));
        this._send(ws, event(EventType.CONFIG, {
          kind: cmd.kind, scope: cmd.scope || 'project',
          items: this.claudeConfig.list(cmd.kind, cmd.scope || 'project'),
        }));
        if (!res.error) await this._rescanIfHarness(cmd.kind, cmd.name, 'is now available');
        return;
      }
      case CommandType.CONFIG_DELETE: {
        this.claudeConfig.delete(cmd.kind, cmd.name, cmd.scope || 'project');
        this._send(ws, event(EventType.CONFIG, {
          kind: cmd.kind, scope: cmd.scope || 'project',
          items: this.claudeConfig.list(cmd.kind, cmd.scope || 'project'),
        }));
        await this._rescanIfHarness(cmd.kind, cmd.name, 'was removed');
        return;
      }

      // checkpoints / rewind
      case CommandType.CHECKPOINT_LIST: {
        const p = this.projects.getActive();
        return this._send(ws, event(EventType.CHECKPOINTS, p ? this.checkpoints.list(p.id, p.dir) : { items: [], enabled: false }));
      }
      case CommandType.CHECKPOINTS_ENABLE: {
        const p = this.projects.getActive();
        if (p) { this.checkpoints.enable(p.dir); this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir))); }
        return;
      }
      case CommandType.CHECKPOINT_CREATE: {
        const p = this.projects.getActive();
        if (p) { this.checkpoints.snapshot(p.id, p.dir, cmd.label || 'manual checkpoint'); this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir))); }
        return;
      }
      case CommandType.CHECKPOINT_RESTORE: {
        const p = this.projects.getActive();
        if (!p) return;
        const res = this.checkpoints.restore(p.id, p.dir, cmd.id);
        if (res.error) this.broadcast(event(EventType.ERROR, { message: `Restore failed: ${res.error}` }));
        else this.broadcast(event(EventType.CHECKPOINT_RESTORED, { id: res.id, removed: res.removed }));
        this.broadcast(event(EventType.FILES, this.files.list('.')));
        return;
      }
      case CommandType.REVERT: {
        const p = this.projects.getActive();
        let restoredFiles = null;
        // 1) Restore the codebase to the pre-turn snapshot. Abort BEFORE truncating
        //    if the checkpoint is gone, so we never lose the convo with files untouched.
        if (cmd.checkpointId) {
          if (!p || !this.checkpoints.isRepo(p.dir)) {
            return this.broadcast(event(EventType.REVERTED, { ok: false, message: 'This workspace has no checkpoints to restore.' }));
          }
          const res = this.checkpoints.restore(p.id, p.dir, cmd.checkpointId);
          if (!res || res.error) {
            return this.broadcast(event(EventType.REVERTED, { ok: false, message: res?.error || 'That checkpoint is no longer available — nothing was changed.' }));
          }
          restoredFiles = res.removed ?? null;
        }
        // 2) Truncate the conversation to before that message.
        const removed = this.transcript.truncateBefore(cmd.turnId);
        // 3) Fork a fresh engine session — Claude sessions are append-only, so this
        //    is the honest way to make the agent forget the reverted turn onward.
        const revertKey = this.session.activeKey;
        await this.session.newSession();
        // Clear stale turn state for the reverted session so the next echo isn't
        // stamped with a pre-revert turn/checkpoint id.
        this._pendingTurn.delete(revertKey);
        delete this._turnCheckpoints[revertKey];
        // 4) Push the rebuilt state to the UI.
        this.broadcast(event(EventType.TRANSCRIPT, { events: this.transcript.replay(), reset: true }));
        if (p) {
          this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir)));
          this.broadcast(event(EventType.FILES, this.files.list('.')));
        }
        return this.broadcast(event(EventType.REVERTED, {
          ok: true, checkpointId: cmd.checkpointId || null, removed: removed ?? 0, restoredFiles, text: cmd.text || '',
        }));
      }

      // files
      case CommandType.FILES_LIST:
        return this._send(ws, event(EventType.FILES, this.files.list(cmd.path || '.')));
      case CommandType.FILES_READ:
        return this._send(ws, event(EventType.FILE, this.files.read(cmd.path)));
      case CommandType.FILES_SEARCH:
        return this._send(ws, event(EventType.FILE_SEARCH, this.files.search(cmd.query)));
      case CommandType.FILES_GREP:
        return this._send(ws, event(EventType.FILE_GREP, this.files.grep(cmd.query)));
      case CommandType.FILES_REPLACE: {
        // Checkpoint first so a bad replace is one tap to undo.
        const p = this.projects.getActive();
        if (p && this.checkpoints.isRepo(p.dir)) {
          this.checkpoints.snapshot(p.id, p.dir, `before replace "${String(cmd.query).slice(0, 30)}"`);
          this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir)));
        }
        const res = this.files.replaceAll(cmd.query, cmd.replacement);
        this.broadcast(event(EventType.FILE_REPLACE, res));
        this.broadcast(event(EventType.FILES, this.files.list('.')));
        return;
      }
      case CommandType.TRANSCRIPT_SEARCH:
        return this._send(ws, event(EventType.TRANSCRIPT_SEARCH_RESULT, {
          query: cmd.query, matches: this.transcript.search(cmd.query),
        }));
      case CommandType.FILES_DIFF: {
        const ref = cmd.checkpointId
          ? this.checkpoints.resolve(this.projects.getActive()?.id, cmd.checkpointId) || 'HEAD'
          : (cmd.ref || 'HEAD');
        return this._send(ws, event(EventType.FILE_DIFF, this.files.diff(cmd.path, ref)));
      }
      case CommandType.FILES_WRITE: {
        const res = this.files.write(cmd.path, cmd.content);
        if (res.error) this.broadcast(event(EventType.ERROR, { message: `Write failed: ${res.error}` }));
        else this.broadcast(event(EventType.FILES, this.files.list('.')));
        return;
      }

      // prompt library
      case CommandType.PROMPTS_LIST:
        return this._send(ws, event(EventType.PROMPTS, { items: this.prompts.list() }));
      case CommandType.PROMPTS_SAVE:
        this.prompts.save(cmd.name, cmd.text);
        return this.broadcast(event(EventType.PROMPTS, { items: this.prompts.list() }));
      case CommandType.PROMPTS_DELETE:
        this.prompts.delete(cmd.name);
        return this.broadcast(event(EventType.PROMPTS, { items: this.prompts.list() }));

      // npm scripts
      case CommandType.SCRIPTS_LIST:
        return this._send(ws, event(EventType.SCRIPTS, this._scriptsSnapshot()));
      case CommandType.SCRIPT_RUN:
        this.devtools.runScript(cmd.name);
        return this.broadcast(event(EventType.SCRIPTS, this._scriptsSnapshot()));
      case CommandType.SCRIPT_STOP:
        this.devtools.stopScript(cmd.name);
        return this.broadcast(event(EventType.SCRIPTS, this._scriptsSnapshot()));

      // GitHub / publish
      case CommandType.GITHUB_PUSH:
        return this.devtools.githubPush({ commit: cmd.commit !== false, message: cmd.message });
      case CommandType.GITHUB_PR:
        return this.devtools.githubPr({ title: cmd.title, body: cmd.body, base: cmd.base });
      case CommandType.GIT_REMOTE_SET:
        return this.devtools.gitRemoteSet({ url: cmd.url });

      // auto-verify loop
      case CommandType.AUTOVERIFY_GET:
        return this.autoverify.emitState();
      case CommandType.AUTOVERIFY_SET:
        return this.autoverify.configure(cmd);

      // usage analytics
      case CommandType.USAGE_SUMMARY:
        return this._send(ws, event(EventType.USAGE_STATS, { summary: this.usage.summary() }));

      // checkpoint review
      case CommandType.CHECKPOINT_DIFF: {
        const p = this.projects.getActive();
        if (!p) return;
        return this._send(ws, event(EventType.CHECKPOINTS_DIFF, this.checkpoints.changesSince(p.id, p.dir, cmd.id)));
      }

      // projects
      case CommandType.LIST_PROJECTS:
        return this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
      case CommandType.OPEN_PROJECT: {
        this.projects.setActive(cmd.projectId);
        this._nativeFingerprint = null;
        this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
        await this._switchView(cmd.projectId);
        return;
      }
      case CommandType.CREATE_PROJECT: {
        const res = await this.projects.create(cmd.name, cmd.template);
        this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
        if (res.error) this.broadcast(event(EventType.ERROR, { message: res.error }));
        return;
      }
      case CommandType.WORKSPACE_BROWSE:
        return this._send(ws, event(EventType.WORKSPACE_BROWSE, this.projects.browse(cmd.path)));
      case CommandType.OPEN_PATH: {
        const res = this.projects.openPath(cmd.path);
        if (res.error) { this.broadcast(event(EventType.ERROR, { message: res.error })); return; }
        this._nativeFingerprint = null;
        this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
        await this._switchView(this.projects.activeId);
        return;
      }

      // controls
      case CommandType.LIST_APKS:
        return this._send(ws, event(EventType.APKS, { items: this._findApks() }));
      case CommandType.START_METRO:
        return this.devtools.startMetro(cmd.projectId);
      case CommandType.STOP_METRO:
        return this.devtools.stopMetro(cmd.projectId);
      case CommandType.GIT:
        return this.devtools.git(cmd.op, cmd, cmd.projectId);
      case CommandType.EAS_BUILD:
        return this.devtools.easBuild(cmd, cmd.projectId);
      case CommandType.RUN:
        return this.devtools.run(cmd.command, { cwd: cmd.cwd, projectId: cmd.projectId });

      default:
        throw new Error(`Unknown command type: ${cmd.type}`);
    }
  }

  // --- static web UI ----------------------------------------------------------

  _serveStatic(req, res) {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    // Dedicated health route so clients (the Android launcher) can distinguish a
    // ready broker from any other process answering on the port.
    if (urlPath === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, broker: 'on-device-agent', profile: this.config.defaultProfile }));
    }
    // /widget?path=<rel>[&kind=][&title=] — emit an inline file viewer for an
    // already-written project file (e.g. a Playwright screenshot) WITHOUT a
    // Write/Edit tool event. Local helper tools (see tools/webshot) hit this so a
    // captured PNG auto-renders in the transcript. Path-guarded to the project dir.
    if (urlPath === '/widget') {
      return this._serveWidget(req, res);
    }
    // /preview/* serves the ACTIVE PROJECT's files so static/SPA builds can be
    // previewed in an iframe. Path-guarded to the project dir.
    if (urlPath === '/preview' || urlPath.startsWith('/preview/')) {
      return this._servePreview(urlPath, res);
    }
    // /download/* serves an active-project file as an attachment (browser saves
    // it to the Downloads folder, which IS visible in the phone's Files app).
    if (urlPath.startsWith('/download/')) {
      return this._serveDownload(urlPath, res);
    }
    let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    // Prevent path traversal (require a separator so a sibling dir sharing the
    // prefix can't match).
    const filePath = path.resolve(WEB_UI_DIR, rel);
    if (filePath !== WEB_UI_DIR && !filePath.startsWith(WEB_UI_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      // index.html embeds ?v=__VER__ on its assets; stamp it from the bundle's mtimes
      // so a home-screen PWA re-fetches fresh JS/CSS whenever the UI changes (iOS PWAs
      // cache the start page hard and ignore cache-control on their own).
      const body = rel === 'index.html' ? Buffer.from(String(data).replace(/__VER__/g, this._assetVersion())) : data;
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-cache, no-store, must-revalidate' });
      res.end(body);
    });
  }

  /** A short stamp from the web-ui bundle's newest mtime — bumps on any UI change. */
  _assetVersion() {
    let m = 0;
    for (const f of ['app.js', 'managers.js', 'styles.css', 'markdown.js', 'diff.js']) {
      try { m = Math.max(m, fs.statSync(path.join(WEB_UI_DIR, f)).mtimeMs); } catch { /* ignore */ }
    }
    return Math.round(m).toString(36);
  }

  _scriptsSnapshot() {
    const items = this.files.scripts();
    const running = items.map((s) => s.name).filter((n) => this.devtools.isScriptRunning(n));
    return { items, running };
  }

  /** Emit an inline file-viewer card for a file that already exists in the active
   *  project, addressed by a project-relative path. Used by local capture tools
   *  (Playwright screenshots) so the file renders without a Write/Edit tool event.
   *  The event is recorded into the transcript, so it survives a reload. */
  _serveWidget(req, res) {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const project = this.projects.getActive();
    if (!project) return json(404, { ok: false, error: 'no active project' });
    let q;
    try { q = new URL(req.url, 'http://127.0.0.1').searchParams; } catch { return json(400, { ok: false, error: 'bad url' }); }
    const root = path.resolve(project.dir);
    let rel = String(q.get('path') || '').replace(/^[./\\]+/, '');
    if (!rel) return json(400, { ok: false, error: 'missing path' });
    const filePath = path.resolve(root, rel);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return json(403, { ok: false, error: 'forbidden' });
    if (!fs.existsSync(filePath)) return json(404, { ok: false, error: 'not found in project: ' + rel });
    // Normalize to forward-slash relative so the UI maps it to /preview consistently.
    rel = path.relative(root, filePath).split(path.sep).join('/');
    this._emitEvent(event(EventType.FILE_WIDGET, { path: rel, kind: q.get('kind') || undefined, title: q.get('title') || undefined }));
    json(200, { ok: true, path: rel });
  }

  _servePreview(urlPath, res) {
    const project = this.projects.getActive();
    if (!project) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('no active project');
    }
    const root = path.resolve(project.dir);
    let rel = urlPath.replace(/^\/preview\/?/, '') || 'index.html';
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const filePath = path.resolve(root, rel);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found in project: ' + rel);
      }
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
      res.end(data);
    });
  }

  _serveDownload(urlPath, res) {
    const project = this.projects.getActive();
    if (!project) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no active project'); }
    const root = path.resolve(project.dir);
    const rel = urlPath.replace(/^\/download\/?/, '');
    const filePath = path.resolve(root, rel);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found: ' + rel); }
      const name = path.basename(filePath).replace(/[\r\n"]/g, '');
      res.writeHead(200, {
        'content-type': contentType(filePath),
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }

  /** Find built Android artifacts (.apk/.aab) in the active project (bounded). */
  _findApks() {
    const project = this.projects.getActive();
    if (!project) return [];
    const root = path.resolve(project.dir);
    const SKIP = new Set(['node_modules', '.git', '.expo', '.gradle', 'ios', 'Pods']);
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 7 || out.length >= 30) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= 30) break;
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
        } else if (/\.(apk|aab)$/i.test(e.name)) {
          const full = path.join(dir, e.name);
          try {
            const st = fs.statSync(full);
            out.push({ rel: path.relative(root, full).split(path.sep).join('/'), name: e.name, size: st.size, mtime: st.mtimeMs });
          } catch { /* ignore */ }
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** Capture the active project's on-disk .apk/.aab set as the baseline, so PRE-
   *  EXISTING artifacts never render as widgets (only ones a build produces later
   *  do). Idempotent per project — re-seeding the same project is a no-op, so it's
   *  safe to call liberally (project-open, snapshot, session switch). */
  _seedApks() {
    const pid = this.projects.getActive()?.id || null;
    if (this._apkSeen && this._apkProject === pid) return;
    this._apkProject = pid;
    this._apkSeen = new Map(this._findApks().map((a) => [a.rel, a.mtime]));
  }

  /** Surface ONLY the .apk/.aab artifacts newly created/changed since the project's
   *  baseline, attributed to the session that produced them. A widget renders only
   *  when a build actually writes/updates an artifact — never on a plain reload of a
   *  project that merely contains one. */
  _maybeBroadcastApks(sessionKey) {
    const pid = this.projects.getActive()?.id || null;
    // No baseline yet (or the active project changed without a seed): establish one
    // silently and emit nothing — pre-existing artifacts are not "produced this turn".
    if (!this._apkSeen || this._apkProject !== pid) { this._seedApks(); return; }
    const items = this._findApks();
    const changed = items.filter((a) => !this._apkSeen.has(a.rel) || this._apkSeen.get(a.rel) < a.mtime);
    for (const a of items) this._apkSeen.set(a.rel, a.mtime);
    if (!changed.length) return;
    // Route through _emitEvent so it records to the producing session's transcript
    // (persists across reload) and only reaches the UI when that session is active.
    this._emitEvent(event(EventType.APKS, { items: changed, sessionKey: sessionKey ?? this.session.activeKey }));
  }

  _log(message) {
    if (this.config.verbose) process.stderr.write(`[broker] ${message}\n`);
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.bmp': 'image/bmp',
      '.md': 'text/markdown; charset=utf-8',
      '.markdown': 'text/markdown; charset=utf-8',
      '.webmanifest': 'application/manifest+json',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.wasm': 'application/wasm',
      '.apk': 'application/vnd.android.package-archive',
      '.aab': 'application/octet-stream',
      '.map': 'application/json',
      '.txt': 'text/plain; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
    }[ext] || 'application/octet-stream'
  );
}
