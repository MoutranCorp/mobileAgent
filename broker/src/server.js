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
    this.claudeConfig = new ClaudeConfig({ getProjectDir });
    this.modelResolver = new ModelResolver({ stateDir: config.stateDir, claudeBin: config.claudeBin });
    this.updater = new Updater();
    this.session = new SessionManager({
      config,
      profiles: this.profiles,
      secrets: this.secrets,
      getActiveProject: () => this.projects.getActive(),
      emit,
    });
    this.transcript.setProject(this.projects.getActive()?.id || null);

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
    this.transcript.replay(); // flush any pending text record to disk
    this.runner.stopAll();
    await this.session.stopEngine();
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => this.wss.close(r));
    await new Promise((r) => this.httpServer.close(r));
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
    ws.on('error', () => this.clients.delete(ws));
    // Greet with a full state snapshot.
    this._sendSnapshot(ws);
  }

  /** Central outbound hook: record transcript + detect native-dep change, then broadcast. */
  _emitEvent(ev) {
    try {
      // Stamp the turn/checkpoint id onto this turn's user_echo (FIFO, one in flight)
      // so its bubble can be reverted later. Must happen before transcript.record.
      if (ev.type === EventType.USER_ECHO && this._pendingTurn) {
        ev.turnId = this._pendingTurn.turnId;
        ev.checkpointId = this._pendingTurn.checkpointId;
        this._pendingTurn = null;
      }
      this.transcript.record(ev);
      // Learn alias -> versioned id for FREE from the live engine's init, so the
      // model picker can show "Opus 4.8" without an extra probe spawn.
      if (ev.type === EventType.CAPABILITIES && ev.model && this.session.currentModel) {
        this.modelResolver.observe(this.session.currentModel, ev.model);
      }
      if (ev.type === EventType.USAGE) {
        this.usage.record({ inTok: ev.inTok, outTok: ev.outTok, cost: ev.cost, profile: this.session.activeProfileId });
      }
      if (ev.type === EventType.RESULT) {
        this._checkNativeChange();
        this._emitTurnChanges();
        // Self-healing: run the verify command after the turn (no-op if disabled).
        const active = this.projects.getActive();
        if (active) this.autoverify.onTurnComplete(active.dir);
      }
    } catch {
      /* never let bookkeeping break the stream */
    }
    this.broadcast(ev);
  }

  _emitTurnChanges() {
    const active = this.projects.getActive();
    if (!active || !this._turnCheckpoint || !this.checkpoints.isRepo(active.dir)) return;
    const ch = this.checkpoints.changesSince(active.id, active.dir, this._turnCheckpoint);
    if (ch && ch.files && ch.files.length) {
      this.broadcast(event(EventType.TURN_CHANGES, { checkpointId: this._turnCheckpoint, files: ch.files, stat: ch.stat }));
    }
  }

  _checkNativeChange() {
    const active = this.projects.getActive();
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
    if (this.session.lastCapabilities) this._send(ws, this.session.lastCapabilities);
    // Replay the recorded conversation so reloads/reconnects don't lose history.
    // reset:true makes it idempotent — the server greets with a snapshot AND the
    // client sends `hello`, so two replays could otherwise double the transcript.
    const replay = this.transcript.replay();
    if (replay.length) this._send(ws, event(EventType.TRANSCRIPT, { events: replay, reset: true }));
    if (active) this._send(ws, event(EventType.CHECKPOINTS, this.checkpoints.list(active.id, active.dir)));
    this._send(ws, event(EventType.PROMPTS, { items: this.prompts.list() }));
    this._send(ws, event(EventType.AUTOVERIFY, {
      enabled: this.autoverify.enabled, command: this.autoverify.command,
      maxIterations: this.autoverify.maxIterations, iteration: this.autoverify.iteration,
    }));
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
      this._send(ws, event(EventType.ack, { ofType: cmd.type, ok: true }));
    } catch (e) {
      this._log(`command '${cmd.type}' failed: ${e.message}`);
      this._send(ws, event(EventType.ack, { ofType: cmd.type, ok: false, message: e.message }));
      this._send(ws, event(EventType.ERROR, { message: e.message }));
    }
  }

  async _dispatch(ws, cmd) {
    switch (cmd.type) {
      case CommandType.HELLO:
        return this._sendSnapshot(ws);
      case CommandType.PING:
        return this._send(ws, event('pong', {}));

      // conversation
      case CommandType.USER_MESSAGE: {
        this.autoverify.resetChain(); // a real user message starts a fresh fix-chain
        // Auto-checkpoint the project before the turn so it can be rewound.
        const proj = this.projects.getActive();
        let checkpointId = null;
        if (proj && this.checkpoints.isRepo(proj.dir)) {
          const cp = this.checkpoints.snapshot(proj.id, proj.dir, (cmd.text || 'turn').slice(0, 60));
          if (cp) {
            this._turnCheckpoint = cp.id; // baseline for "what changed this turn"
            checkpointId = cp.id;
            this.broadcast(event(EventType.CHECKPOINTS, this.checkpoints.list(proj.id, proj.dir)));
          }
        }
        // Tag the upcoming user_echo so its bubble can be reverted to here later.
        // Set even when not a git repo (checkpointId null -> conversation-only revert).
        this._turnSeq = (this._turnSeq || 0) + 1;
        this._pendingTurn = { turnId: `t${this._turnSeq}`, checkpointId, text: cmd.text || '' };
        return this.session.sendUserMessage(cmd.text || '', cmd.images);
      }
      case CommandType.SLASH_COMMAND:
        return this.session.sendUserMessage(`/${cmd.name}${cmd.args ? ' ' + cmd.args : ''}`);
      case CommandType.COMPACT:
        return this.session.sendUserMessage(`/compact${cmd.focus ? ' ' + cmd.focus : ''}`);
      case CommandType.CLEAR:
        this.transcript.clear();
        return this.session.sendUserMessage('/clear');
      case CommandType.INTERRUPT:
        return this.session.interrupt();

      // permissions
      case CommandType.APPROVE:
        return this.session.respondPermission(cmd.id, 'allow', { updatedInput: cmd.updatedInput });
      case CommandType.DENY:
        return this.session.respondPermission(cmd.id, 'deny', { reason: cmd.reason });
      case CommandType.SET_PERMISSION_MODE:
        await this.session.setPermissionMode(cmd.mode);
        return this.broadcast(event(EventType.PERMISSION_MODE, { mode: cmd.mode }));

      // session / engine
      case CommandType.NEW_SESSION:
        this.transcript.clear();
        return this.session.newSession();
      case CommandType.RESUME: {
        // Claude's --resume restores model context but does NOT re-stream past
        // turns, so the UI would stay blank. Parse the session's own .jsonl into
        // canonical records, seed the transcript store, and replay to clients.
        const past = this.claudeConfig.readSessionTranscript(cmd.sessionId);
        const seeded = this.transcript.replace(past);
        this.broadcast(event(EventType.TRANSCRIPT, { events: seeded, reset: true }));
        return this.session.resume(cmd.sessionId);
      }
      case CommandType.LIST_SESSIONS:
        return this._send(ws, event(EventType.CONFIG, {
          kind: 'sessions', items: this.claudeConfig.list('sessions'),
        }));
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
        await this.session.newSession();
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
        this.transcript.setProject(cmd.projectId);
        this._nativeFingerprint = null;
        this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
        const replay = this.transcript.replay();
        this._send(ws, event(EventType.TRANSCRIPT, { events: replay, reset: true }));
        const p = this.projects.getActive();
        if (p) this._send(ws, event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir)));
        // Re-point the engine at the new project (resume its session if any).
        await this.session.startEngine(this.session.activeProfileId, {});
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
        this.transcript.setProject(this.projects.activeId);
        this._nativeFingerprint = null;
        this.broadcast(event(EventType.PROJECTS, this.projects.snapshot()));
        this._send(ws, event(EventType.TRANSCRIPT, { events: this.transcript.replay(), reset: true }));
        const p = this.projects.getActive();
        if (p) this._send(ws, event(EventType.CHECKPOINTS, this.checkpoints.list(p.id, p.dir)));
        await this.session.startEngine(this.session.activeProfileId, {});
        return;
      }

      // controls
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
    // /preview/* serves the ACTIVE PROJECT's files so static/SPA builds can be
    // previewed in an iframe. Path-guarded to the project dir.
    if (urlPath === '/preview' || urlPath.startsWith('/preview/')) {
      return this._servePreview(urlPath, res);
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
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  _scriptsSnapshot() {
    const items = this.files.scripts();
    const running = items.map((s) => s.name).filter((n) => this.devtools.isScriptRunning(n));
    return { items, running };
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
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-cache' });
      res.end(data);
    });
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
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.wasm': 'application/wasm',
      '.map': 'application/json',
      '.txt': 'text/plain; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
    }[ext] || 'application/octet-stream'
  );
}
