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
  constructor({ config, profiles, secrets, getActiveProject, getProject, emit }) {
    this.config = config;
    this.profiles = profiles;
    this.secrets = secrets;
    this.getActiveProject = getActiveProject;
    this.getProject = getProject || (() => null); // resolve a project descriptor by id (for cold-resume cwd)
    this.emit = emit;

    this.engines = new Map(); // sessionKey -> engine (MANY live sessions, may share a project)
    this.meta = new Map(); // sessionKey -> { busy, lastStatus, profileId, model, sessionId, projectId, lastActivityTs, pinned, title }
    this._activeKeyByProject = new Map(); // projectId -> the project's currently-bound session key
    this._keySeq = 0; // suffix counter for additional concurrent sessions in the same folder
    this.activeKey = this._sessionKeyFor(getActiveProject());
    this.activeProfileId = config.defaultProfile;
    this.permissionMode = config.permissionMode || 'default'; // global default for new engines
    this.effort = config.effort || 'high'; // low|medium|high|xhigh|max|ultracode (global pref)
    this.currentModel = null; // active session's requested model alias (for resolver labelling)
    this.sessionsFile = path.join(config.stateDir, 'sessions.json');
    this._sessionByProject = this._loadSessions();
    this._lastStatus = StatusState.IDLE; // mirror of the ACTIVE session
    this.lastCapabilities = null; // mirror of the ACTIVE session
  }

  /**
   * The session key bound to a project's foreground session. For the FIRST session
   * of a project the key === projectId, so all existing project-keyed behavior (and
   * tests) is unchanged. `fresh` mints an additional suffixed key for a second+
   * concurrent session in the same folder (`projA#2`), and binds it as the project's
   * current session.
   */
  _sessionKeyFor(project, { fresh = false } = {}) {
    const pid = project?.id || MAIN_KEY;
    const bound = this._activeKeyByProject.get(pid);
    if (!fresh) {
      if (bound) return bound;
      this._activeKeyByProject.set(pid, pid); // first session: key === projectId
      return pid;
    }
    // Use the bare projectId only when it's truly unused; otherwise mint a fresh,
    // non-colliding suffix so a new tab can never overwrite a live engine.
    if (!bound && !this.meta.has(pid)) { this._activeKeyByProject.set(pid, pid); return pid; }
    let key;
    do { key = `${pid}#${++this._keySeq}`; } while (this.meta.has(key));
    this._activeKeyByProject.set(pid, key);
    return key;
  }

  _projectById(id) { return (id && this.getProject(id)) || null; }

  /** The engine the UI is currently viewing (back-compat for `session.engine`). */
  get engine() { return this.engines.get(this.activeKey) || null; }

  // --- public API -------------------------------------------------------------

  async ensureEngine(key = this.activeKey) {
    const e = this.engines.get(key);
    if (e && e.state !== 'stopped') return e;
    const m = this.meta.get(key);
    if (m) {
      // Cold-resume a previously-live (idle-evicted) session in ITS OWN folder —
      // never the globally-active project, or it would resume in the wrong cwd.
      const project = this._projectById(m.projectId);
      const resumeId = m.sessionId || this._sessionByProject[key] || null;
      // Pass the stored cwd so a session whose project folder was deleted resumes in
      // its OWN (now-missing) folder and fails loudly, never silently in another one.
      return this.startEngine(m.profileId || this.activeProfileId, { key, project, cwd: m.cwd, resumeId });
    }
    return this.startEngine(this.activeProfileId, { key });
  }

  async startEngine(profileId, opts = {}) {
    // Serialize engine (re)starts so closely-timed restarts can't overwrite each
    // other's engine and orphan a child `claude` process.
    const prev = this._startLock || Promise.resolve();
    let release;
    this._startLock = new Promise((r) => { release = r; });
    try { await prev; return await this._startEngineInner(profileId, opts); }
    finally { release(); }
  }

  async _startEngineInner(profileId, opts = {}) {
    const { resumeId, model } = opts;
    const profile = this.profiles.get(profileId);
    if (!profile) { this._emitError(`No such profile: ${profileId}`); return null; }
    if (!this.secrets.isReady(profile)) {
      this._emitError(
        `Profile '${profile.label}' is missing its auth token (${profile.authRef}). Add it in Settings before switching.`
      );
      return null;
    }

    // Resolve which session (key) + folder (project) this engine is for.
    let key, project;
    if (opts.fresh) {
      project = opts.project || this.getActiveProject();
      key = this._sessionKeyFor(project, { fresh: true }); // a NEW concurrent session
    } else if (opts.key) {
      key = opts.key;
      project = opts.project || this._projectById(this.meta.get(key)?.projectId) || this.getActiveProject();
    } else {
      // Restart the active session in place (effort/model/permission/profile change),
      // or first creation. Reuse activeKey ONLY when it belongs to THIS project — else
      // (e.g. RESUME after setActive desyncs activeKey from the active folder) derive
      // the project's own key so we never clobber a different folder's live session.
      project = opts.project || this.getActiveProject();
      const pid = project?.id ?? null;
      const canReuse = this.activeKey && this.meta.has(this.activeKey) && (this.meta.get(this.activeKey).projectId ?? null) === pid;
      key = canReuse ? this.activeKey : this._sessionKeyFor(project);
    }
    const prevMeta = this.meta.get(key); // preserve pin/title/projectId/cwd across a restart
    this.activeKey = key;
    await this.stopEngine(key); // replace only THIS key's engine

    // The session's folder: prefer an explicit cwd (cold-resume keeps its OWN folder
    // even if the project was deleted), then the resolved project, then the prior cwd.
    const cwd = opts.cwd || project?.dir || prevMeta?.cwd || this.config.projectsDir;
    const projectId = prevMeta?.projectId ?? project?.id ?? null; // an existing session's own folder id wins (cold-resume after a fallback)
    const env = this.secrets.envForProfile(profile);
    const resolvedResume = resumeId ?? prevMeta?.sessionId ?? (projectId ? this._sessionByProject[projectId] : null) ?? null;

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
    this.meta.set(key, {
      busy: false, lastStatus: StatusState.IDLE, profileId, model: chosen,
      sessionId: resolvedResume || null, projectId, cwd,
      lastActivityTs: Date.now(), pinned: prevMeta?.pinned || false, title: prevMeta?.title || null,
    });

    engine.on('event', (ev) => this._onEngineEvent(ev, projectId, key));
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

  /** Idle-evict (or manually stop) a live engine but KEEP its meta + transcript +
   *  resume hint, so it cold-resumes later on focus/send. */
  async stopEngineKeepTranscript(key) {
    if (!this.engines.has(key)) return;
    await this.stopEngine(key); // deletes the engine; meta (with sessionId) survives
    this._emitSessions();
  }

  /** Pin/unpin a session so the memory backstop never evicts it (keep-warm). */
  setPinned(key, pinned) {
    const m = this.meta.get(key);
    if (!m) return;
    m.pinned = !!pinned;
    this._emitSessions();
  }

  /** Switch which session the UI is viewing WITHOUT stopping the others. */
  async setActiveKey(key) {
    this.activeKey = key;
    const m = this.meta.get(key);
    if (m) {
      m.lastActivityTs = Date.now(); // focusing a tab counts as activity (resets its idle timer)
      // Keep the project's bound key in sync with the foreground view, else a later
      // newSession()/restart-in-place resolves against a stale key and a session's
      // turns can route into a sibling (the "sessions merging" bug).
      if (m.projectId) this._activeKeyByProject.set(m.projectId, key);
    }
    this._lastStatus = m?.lastStatus || StatusState.IDLE;
    this.currentModel = m?.model || this.currentModel;
    this.lastCapabilities = this.engines.get(key)?._lastCaps || null;
    const e = await this.ensureEngine(key);
    this._emitSessions();
    return e;
  }

  /** Live sessions (engines currently running), for the sessions screen + resources. */
  liveSessions() {
    const now = Date.now();
    const out = [];
    for (const [key, m] of this.meta) {
      const e = this.engines.get(key);
      if (!e) continue; // idle-evicted sessions hold no process -> not "live"
      out.push({
        key, projectId: m.projectId, profileId: m.profileId, model: m.model,
        sessionId: m.sessionId, busy: !!m.busy, lastStatus: m.lastStatus,
        active: key === this.activeKey,
        pid: e.proc?.pid ?? null,
        status: m.busy ? 'working' : 'idle',
        idleMs: m.busy ? 0 : (m.lastActivityTs ? Math.max(0, now - m.lastActivityTs) : 0),
        pinned: !!m.pinned,
        title: m.title || null,
      });
    }
    return out;
  }

  /** Live sessions PLUS "sleeping" ones — idle-evicted sessions whose engine was
   *  torn down but whose meta + transcript survive (cold-resumable). The workspace
   *  UI uses this so a dormant session stays in the tab strip as a 💤 tab instead of
   *  silently vanishing; tapping it cold-resumes. (`liveSessions()` stays live-only
   *  for resources/eviction.) */
  uiSessions() {
    const live = this.liveSessions();
    const liveKeys = new Set(live.map((s) => s.key));
    const now = Date.now();
    const out = live.slice();
    for (const [key, m] of this.meta) {
      if (liveKeys.has(key)) continue; // already live
      // The no-project scratch session is normally hidden, but if it was evicted
      // while holding real history (a sessionId) it must still surface — otherwise
      // it vanished irrecoverably until a reload.
      if (key === MAIN_KEY && !m.sessionId) continue;
      out.push({
        key, projectId: m.projectId, profileId: m.profileId, model: m.model,
        sessionId: m.sessionId, busy: false, lastStatus: 'idle',
        active: key === this.activeKey, pid: null, status: 'sleeping',
        idleMs: m.lastActivityTs ? Math.max(0, now - m.lastActivityTs) : 0,
        pinned: !!m.pinned, title: m.title || (key === MAIN_KEY ? 'Main' : null), sleeping: true,
      });
    }
    return out;
  }

  async sendUserMessage(text, images) {
    const engine = await this.ensureEngine();
    if (!engine) return;
    await engine.send({ type: 'user_message', text, images });
  }

  respondPermission(id, decision, extra, key) {
    // Route the decision to the engine that RAISED the request (the UI echoes back
    // the request's sessionKey), not whatever happens to be active now — the user
    // may have switched sessions while an approval was pending.
    const e = (key && this.engines.get(key)) || this.engine;
    if (e) e.respondPermission(id, decision, extra);
  }
  interrupt() { if (this.engine) this.engine.interrupt(); }

  async switchEngine(profileId) { this._log(`switching engine -> ${profileId}`); return this.startEngine(profileId, {}); }

  /** Forget the active key's resume id (used by /clear) so the next start is fresh. */
  dropActiveResume() {
    if (this._sessionByProject[this.activeKey]) {
      delete this._sessionByProject[this.activeKey];
      this._saveSessions();
    }
  }

  async switchModel(model) {
    this._log(`switching model -> ${model} (fresh session)`);
    delete this._sessionByProject[this.activeKey]; // a fresh session for THIS key only
    this._saveSessions();
    return this.startEngine(this.activeProfileId, { model, resumeId: null });
  }

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    const resumeId = this.engine?.sessionId || this._sessionByProject[this.activeKey] || null;
    this._log(`set permission mode -> ${mode} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async setEffort(level) {
    this.effort = level;
    const resumeId = this.engine?.sessionId || this._sessionByProject[this.activeKey] || null;
    this._log(`set effort -> ${level} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async refreshCapabilities() {
    if (!this.engine || this.engine.state === 'stopped') return null;
    if (this._lastStatus && this._lastStatus !== StatusState.IDLE && this._lastStatus !== StatusState.ERROR) return null;
    const resumeId = this.engine?.sessionId || this._sessionByProject[this.activeKey] || null;
    this._log(`refreshing capabilities (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  /** Start a NEW concurrent session in the active folder (a fresh tab), leaving any
   *  existing sessions in that folder running in the background. */
  async newSession() {
    return this.startEngine(this.activeProfileId, { project: this.getActiveProject(), fresh: true, resumeId: null });
  }

  async resume(sessionId) { return this.startEngine(this.activeProfileId, { resumeId: sessionId }); }

  /** Forget a key's persisted resume id (so a deleted session is never --resume'd)
   *  and tear down its engine if live. Used when a session's .jsonl is deleted. */
  async forgetSession(key) {
    const m = this.meta.get(key);
    const pid = m?.projectId;
    // Clear the per-project resume hint only if it pointed at THIS session's id
    // (don't orphan sibling sessions that share the folder).
    if (m?.sessionId && pid && this._sessionByProject[pid] === m.sessionId) { delete this._sessionByProject[pid]; this._saveSessions(); }
    if (key && key !== MAIN_KEY && this._sessionByProject[key]) { delete this._sessionByProject[key]; this._saveSessions(); } // legacy: key may be a projectId
    if (this.engines.has(key)) await this.stopEngine(key);
    this.meta.delete(key);
    if (pid && this._activeKeyByProject.get(pid) === key) {
      // Rebind the project to a surviving sibling session (or drop it if none) so the
      // bound key never dangles — a later newSession would otherwise collide on `pid`.
      const sibling = [...this.meta.keys()].find((k) => this.meta.get(k)?.projectId === pid);
      if (sibling) this._activeKeyByProject.set(pid, sibling); else this._activeKeyByProject.delete(pid);
    }
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

  _onEngineEvent(ev, projectId, key) {
    ev.sessionKey = key; // every engine event is tagged with its owning session
    const m = this.meta.get(key);
    if (ev.type === EventType.SESSION_META && ev.sessionId) {
      // Persist the resume id keyed by SESSION KEY (the first session's key === its
      // projectId, so sessions.json stays back-compatible) — keying by projectId let
      // a 2nd concurrent session in the same folder clobber the 1st's resume id and
      // resume INTO it on the next restart (the "prompts merged into another
      // session" bug). Cold-resume/eviction also reads meta.sessionId directly.
      this._sessionByProject[key] = ev.sessionId; this._saveSessions();
      if (m) m.sessionId = ev.sessionId;
    }
    if (ev.type === EventType.STATUS && ev.state) {
      const busy = ev.state !== StatusState.IDLE && ev.state !== StatusState.ERROR;
      const changed = !m || m.busy !== busy || m.lastStatus !== ev.state;
      if (m) { m.lastStatus = ev.state; m.busy = busy; m.lastActivityTs = Date.now(); } // any status change = activity (resets idle timer)
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
    if (ev.type === EventType.RESULT && m) { if (m.busy) m.busy = false; m.lastActivityTs = Date.now(); this._emitSessions(); }
    this.emit(ev);
  }

  _emitSessions() { this.emit(event(EventType.SESSIONS, { items: this.uiSessions(), activeKey: this.activeKey })); }

  _emitError(message) { this.emit(event(EventType.ERROR, { message })); }
  _log(message) {
    if (this.config.verbose) process.stderr.write(`[session] ${message}\n`);
    this.emit(event(EventType.LOG, { level: 'debug', message }));
  }
  _loadSessions() {
    try { if (fs.existsSync(this.sessionsFile)) return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8')); } catch { /* ignore */ }
    return {};
  }
  // Debounced: SESSION_META can fire rapidly (each engine (re)start), and a
  // synchronous write on every one stalls the event loop on slow (proot/eMMC) FS.
  _saveSessions() {
    if (this._sessionSaveTimer) return;
    this._sessionSaveTimer = setTimeout(() => { this._sessionSaveTimer = null; this.flushSessionsFile(); }, 400);
    this._sessionSaveTimer.unref?.();
  }
  /** Write sessions.json now (also used on shutdown to not lose a pending save). */
  flushSessionsFile() {
    if (this._sessionSaveTimer) { clearTimeout(this._sessionSaveTimer); this._sessionSaveTimer = null; }
    try { fs.writeFileSync(this.sessionsFile, JSON.stringify(this._sessionByProject, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
  }
}
