import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from './engines/index.js';
import { EventType, StatusState, event } from './protocol.js';

const MAIN_KEY = '__main__'; // session key when no project is open

/**
 * SessionManager — owns one engine PER PROJECT (the session key) so background
 * sessions keep running when you switch away. Exactly one key is "active" (the
 * one the UI is viewing); the rest keep generating in the background. Every event
 * an engine emits is stamped with its `sessionKey` so the server can record it to
 * the right transcript and only surface the active session's full stream (plus a
 * lightweight busy indicator for the others).
 *
 * Switching the active model/effort/permission/session replaces ONLY the active
 * key's engine (a fresh/resumed session). Opening another project switches the
 * active key without stopping the previous engine.
 */
export class SessionManager {
  constructor({ config, profiles, secrets, getActiveProject, emit }) {
    this.config = config;
    this.profiles = profiles;
    this.secrets = secrets;
    this.getActiveProject = getActiveProject;
    this.emit = emit;

    this.engines = new Map(); // key -> engine (one live session per project)
    this.meta = new Map(); // key -> { busy, lastStatus, profileId, model, sessionId, projectId }
    this.activeKey = this._keyFor(getActiveProject());
    this.activeProfileId = config.defaultProfile;
    this.permissionMode = config.permissionMode || 'default'; // global default for new engines
    this.effort = config.effort || 'high'; // low|medium|high|xhigh|max|ultracode (global pref)
    this.currentModel = null; // active session's requested model alias (for resolver labelling)
    this.sessionsFile = path.join(config.stateDir, 'sessions.json');
    this._sessionByProject = this._loadSessions();
    this._lastStatus = StatusState.IDLE; // mirror of the ACTIVE session
    this.lastCapabilities = null; // mirror of the ACTIVE session
  }

  _keyFor(project) { return project?.id || MAIN_KEY; }

  /** The engine the UI is currently viewing (back-compat for `session.engine`). */
  get engine() { return this.engines.get(this.activeKey) || null; }

  // --- public API -------------------------------------------------------------

  async ensureEngine(key = this.activeKey) {
    const e = this.engines.get(key);
    if (e && e.state !== 'stopped') return e;
    return this.startEngine(this.activeProfileId, {});
  }

  async startEngine(profileId, { resumeId, model } = {}) {
    const profile = this.profiles.get(profileId);
    if (!profile) { this._emitError(`No such profile: ${profileId}`); return null; }
    if (!this.secrets.isReady(profile)) {
      this._emitError(
        `Profile '${profile.label}' is missing its auth token (${profile.authRef}). Add it in Settings before switching.`
      );
      return null;
    }

    const project = this.getActiveProject();
    const key = this._keyFor(project);
    this.activeKey = key;
    // Replace only THIS key's engine (a fresh/resumed session for the active view).
    await this.stopEngine(key);

    const cwd = project?.dir || this.config.projectsDir;
    const env = this.secrets.envForProfile(profile);
    const resolvedResume = resumeId ?? (project ? this._sessionByProject[project.id] : null) ?? null;

    // Keep the chosen model across non-model restarts; drop it on a profile change.
    const profileChanged = profileId !== this.activeProfileId;
    const chosen = model || (profileChanged ? null : this.currentModel) || profile.model;
    this.activeProfileId = profileId;
    this.currentModel = chosen;
    const isUltra = this.effort === 'ultracode'; // maps to xhigh + the ultracode setting

    const engine = createEngine(profile, {
      cwd, env, model: chosen,
      resumeId: resolvedResume,
      claudeBin: this.config.claudeBin,
      permissionMode: this.permissionMode,
      effort: isUltra ? 'xhigh' : this.effort,
      ultracode: isUltra,
      log: (m) => this._log(m),
    });
    this.engines.set(key, engine);
    this.meta.set(key, { busy: false, lastStatus: StatusState.IDLE, profileId, model: chosen, sessionId: null, projectId: project?.id || null });

    engine.on('event', (ev) => this._onEngineEvent(ev, project, key));
    engine.on('engine_state', (state) => {
      this.emit(event(EventType.ENGINE_STATE, { state, profileId, model: engine.model, sessionKey: key }));
    });

    try {
      await engine.start();
    } catch (e) {
      this._emitError(`Failed to start engine: ${e.message}`);
      return null;
    }
    this._emitSessions();
    return engine;
  }

  async stopEngine(key = this.activeKey) {
    const e = this.engines.get(key);
    if (!e) return;
    this.engines.delete(key);
    try { await e.stop(); } catch { /* ignore */ }
  }

  async stopAll() {
    const all = [...this.engines.values()];
    this.engines.clear();
    await Promise.all(all.map((e) => e.stop().catch(() => {})));
  }

  /** Switch which session the UI is viewing WITHOUT stopping the others. */
  async setActiveKey(key) {
    this.activeKey = key;
    const m = this.meta.get(key);
    this._lastStatus = m?.lastStatus || StatusState.IDLE;
    this.currentModel = m?.model || this.currentModel;
    this.lastCapabilities = this.engines.get(key)?._lastCaps || null;
    const e = await this.ensureEngine(key);
    this._emitSessions();
    return e;
  }

  /** Live sessions (one per project with an engine), for the sessions screen. */
  liveSessions() {
    const out = [];
    for (const [key, m] of this.meta) {
      if (!this.engines.has(key)) continue;
      out.push({ key, projectId: m.projectId, profileId: m.profileId, model: m.model,
        sessionId: m.sessionId, busy: !!m.busy, lastStatus: m.lastStatus, active: key === this.activeKey });
    }
    return out;
  }

  async sendUserMessage(text, images) {
    const engine = await this.ensureEngine();
    if (!engine) return;
    await engine.send({ type: 'user_message', text, images });
  }

  respondPermission(id, decision, extra) { if (this.engine) this.engine.respondPermission(id, decision, extra); }
  interrupt() { if (this.engine) this.engine.interrupt(); }

  async switchEngine(profileId) { this._log(`switching engine -> ${profileId}`); return this.startEngine(profileId, {}); }

  async switchModel(model) {
    this._log(`switching model -> ${model} (fresh session)`);
    const project = this.getActiveProject();
    if (project) delete this._sessionByProject[project.id];
    this._saveSessions();
    return this.startEngine(this.activeProfileId, { model, resumeId: null });
  }

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    const project = this.getActiveProject();
    const resumeId = this.engine?.sessionId || (project ? this._sessionByProject[project.id] : null);
    this._log(`set permission mode -> ${mode} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async setEffort(level) {
    this.effort = level;
    const project = this.getActiveProject();
    const resumeId = this.engine?.sessionId || (project ? this._sessionByProject[project.id] : null);
    this._log(`set effort -> ${level} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async refreshCapabilities() {
    if (!this.engine || this.engine.state === 'stopped') return null;
    if (this._lastStatus && this._lastStatus !== StatusState.IDLE && this._lastStatus !== StatusState.ERROR) return null;
    const project = this.getActiveProject();
    const resumeId = this.engine?.sessionId || (project ? this._sessionByProject[project.id] : null);
    this._log(`refreshing capabilities (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async newSession() {
    const project = this.getActiveProject();
    if (project) delete this._sessionByProject[project.id];
    this._saveSessions();
    return this.startEngine(this.activeProfileId, { resumeId: null });
  }

  async resume(sessionId) { return this.startEngine(this.activeProfileId, { resumeId: sessionId }); }

  /** Forget a key's persisted resume id (so a deleted session is never --resume'd)
   *  and tear down its engine if live. Used when a session's .jsonl is deleted. */
  async forgetSession(key) {
    if (key && key !== MAIN_KEY) { delete this._sessionByProject[key]; this._saveSessions(); }
    if (this.engines.has(key)) await this.stopEngine(key);
    this._emitSessions();
  }

  get snapshot() {
    return {
      activeProfileId: this.activeProfileId,
      engineState: this.engine?.state || 'stopped',
      model: this.engine?.model || null,
      requestedModel: this.currentModel,
      sessionId: this.engine?.sessionId || null,
      lastStatus: this._lastStatus,
      permissionMode: this.permissionMode,
      effort: this.effort,
      activeKey: this.activeKey,
    };
  }

  // --- internals --------------------------------------------------------------

  _onEngineEvent(ev, project, key) {
    ev.sessionKey = key; // every engine event is tagged with its owning session
    const m = this.meta.get(key);
    if (ev.type === EventType.SESSION_META && ev.sessionId) {
      if (project) { this._sessionByProject[project.id] = ev.sessionId; this._saveSessions(); }
      if (m) m.sessionId = ev.sessionId;
    }
    if (ev.type === EventType.STATUS && ev.state) {
      const busy = ev.state !== StatusState.IDLE && ev.state !== StatusState.ERROR;
      const changed = !m || m.busy !== busy || m.lastStatus !== ev.state;
      if (m) { m.lastStatus = ev.state; m.busy = busy; }
      if (key === this.activeKey) this._lastStatus = ev.state;
      // Keep the sessions screen + nav badge live for EVERY session (active too),
      // so a working session always shows its indicator.
      if (changed) this._emitSessions();
    }
    if (ev.type === EventType.CAPABILITIES) {
      const e = this.engines.get(key); if (e) e._lastCaps = ev;
      if (key === this.activeKey) this.lastCapabilities = ev;
    }
    if (ev.type === EventType.PERMISSION_MODE && ev.mode && key === this.activeKey) this.permissionMode = ev.mode;
    if (ev.type === EventType.SESSION_META && ev.sessionId) this._emitSessions(); // sessionId now known
    if (ev.type === EventType.RESULT && m && m.busy) { m.busy = false; this._emitSessions(); }
    this.emit(ev);
  }

  _emitSessions() { this.emit(event(EventType.SESSIONS, { items: this.liveSessions(), activeKey: this.activeKey })); }

  _emitError(message) { this.emit(event(EventType.ERROR, { message })); }
  _log(message) {
    if (this.config.verbose) process.stderr.write(`[session] ${message}\n`);
    this.emit(event(EventType.LOG, { level: 'debug', message }));
  }
  _loadSessions() {
    try { if (fs.existsSync(this.sessionsFile)) return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8')); } catch { /* ignore */ }
    return {};
  }
  _saveSessions() {
    try { fs.writeFileSync(this.sessionsFile, JSON.stringify(this._sessionByProject, null, 2)); } catch { /* ignore */ }
  }
}
