import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createEngine } from './engines/index.js';
import { EventType, StatusState, event } from './protocol.js';

export const MAIN_KEY = '__main__'; // session key when no project is open
// Mirror of TranscriptStore's filename sanitizer, so we can tell whether a candidate
// key would collide with an existing transcript on disk.
const safeKey = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const normCwd = (cwd) => {
  if (!cwd) return null;
  const resolved = path.resolve(String(cwd));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const sameCwd = (a, b) => {
  const left = normCwd(a);
  const right = normCwd(b);
  return !!left && !!right && left === right;
};

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
    this.meta = new Map(); // sessionKey -> { busy, lastStatus, profileId, harness, model, effort, serviceTier, permissionMode, sessionId, projectId, lastActivityTs, pinned, title }
    this._activeKeyByProject = new Map(); // projectId -> the project's currently-bound session key
    this.activeKey = this._sessionKeyFor(getActiveProject());
    this.defaultProfileId = config.defaultProfile;
    this.defaultPermissionMode = config.permissionMode || 'default';
    this.defaultEffort = config.effort || 'high'; // low|medium|high|xhigh|max|ultracode
    this.defaultServiceTier = undefined;
    this.defaultModel = null;
    this.defaultModelsByProfile = new Map();
    this.sessionsFile = path.join(config.stateDir, 'sessions.json');
    this._sessionByProject = this._loadSessions();
    this.capabilitiesByKey = new Map(); // sessionKey -> last capabilities event
  }

  get _activeMeta() { return this.meta.get(this.activeKey) || null; }
  get activeProfileId() { return this._activeMeta?.profileId || this.defaultProfileId; }
  set activeProfileId(profileId) {
    this.defaultProfileId = profileId;
    const m = this._activeMeta;
    if (m) m.profileId = profileId;
  }
  get permissionMode() { return this._activeMeta?.permissionMode || this.defaultPermissionMode; }
  set permissionMode(mode) {
    this.defaultPermissionMode = mode;
    const m = this._activeMeta;
    if (m) m.permissionMode = mode;
  }
  get effort() { return this._activeMeta?.effort || this.defaultEffort; }
  set effort(level) {
    this.defaultEffort = level;
    const m = this._activeMeta;
    if (m) m.effort = level;
  }
  get serviceTier() {
    const m = this._activeMeta;
    return m && Object.prototype.hasOwnProperty.call(m, 'serviceTier') ? m.serviceTier : this.defaultServiceTier;
  }
  set serviceTier(value) {
    this.defaultServiceTier = value ?? null;
    const m = this._activeMeta;
    if (m) m.serviceTier = value ?? null;
  }
  get currentModel() {
    const profile = this.profiles.get(this.activeProfileId);
    return this._activeMeta?.model || this._preferredModelForProfile(this.activeProfileId, profile);
  }
  set currentModel(model) {
    const profileId = this.activeProfileId;
    const profile = this.profiles.get(profileId);
    const clean = this._sanitizeModelForProfile(profile, model, { allowCustom: true });
    this.defaultModel = clean;
    this._rememberModelForProfile(profileId, clean);
    const m = this._activeMeta;
    if (m) m.model = clean;
  }
  get lastCapabilities() { return this.capabilitiesByKey.get(this.activeKey) || null; }
  set lastCapabilities(caps) {
    if (caps) this.capabilitiesByKey.set(this.activeKey, caps);
    else this.capabilitiesByKey.delete(this.activeKey);
  }

  /**
   * The session key bound to a project's foreground session. For the FIRST session
   * of a project the key === projectId (readable, and keeps resume/cold-resume +
   * project binding back-compatible). `fresh` mints an additional session in the same
   * folder as `projectId-<token>` — a **non-recycling, collision-checked** suffix.
   *
   * The old scheme used `projectId#N` from an in-memory counter that RESET to 0 on
   * every broker restart, so keys recycled and a "new" session could collide with a
   * dead session's leftover transcript / resume id on disk (the "new tab shows old
   * messages" bug). A random token never recycles; `-` is filesystem/URL-safe (unlike
   * `#`); and `_keyTaken` rejects any clash with a live engine, a persisted resume id,
   * or an existing transcript file.
   */
  _sessionKeyFor(project, { fresh = false } = {}) {
    const pid = project?.id || MAIN_KEY;
    const bound = this._activeKeyByProject.get(pid);
    if (!fresh) {
      if (bound) return bound;
      this._activeKeyByProject.set(pid, pid); // first session: key === projectId
      return pid;
    }
    // Bare projectId only when truly unused (no live engine, no leftover state);
    // otherwise mint a unique suffixed key that can't overwrite anything.
    if (!bound && !this._keyTaken(pid)) { this._activeKeyByProject.set(pid, pid); return pid; }
    let key;
    do { key = `${pid}-${crypto.randomBytes(4).toString('hex')}`; } while (this._keyTaken(key));
    this._activeKeyByProject.set(pid, key);
    return key;
  }

  /** A key is unavailable if a live engine/meta holds it, a persisted resume id is
   *  keyed by it, OR a transcript file already exists for it — so a freshly-minted key
   *  is guaranteed blank (no recycled history) even across broker restarts. */
  _keyTaken(key) {
    if (this.meta.has(key)) return true;
    if (Object.prototype.hasOwnProperty.call(this._sessionByProject, key)) return true;
    try { return fs.existsSync(path.join(this.config.stateDir, 'transcripts', `${safeKey(key)}.jsonl`)); }
    catch { return false; }
  }

  _projectById(id) { return (id && this.getProject(id)) || null; }

  /** The engine the UI is currently viewing (back-compat for `session.engine`). */
  get engine() { return this.engines.get(this.activeKey) || null; }

  _resumeRecord(key) {
    const rec = this._sessionByProject[key];
    if (!rec) return null;
    if (typeof rec === 'string') return { resumeId: rec, harness: 'claude-code', legacy: true };
    if (rec && typeof rec === 'object' && rec.resumeId) {
      return { resumeId: rec.resumeId, harness: rec.harness || null, cwd: rec.cwd || null };
    }
    return null;
  }

  _resumeIdFor(key, harness, cwd = null) {
    const rec = this._resumeRecord(key);
    if (!rec?.resumeId) return null;
    if (!rec.harness || rec.harness !== harness) return null;
    // Codex thread ids are not safe to reuse across workspaces. Legacy Codex
    // records have no cwd, so treat them as stale and start a fresh thread.
    if (harness === 'codex-app-server' && !sameCwd(rec.cwd, cwd)) return null;
    return rec.resumeId;
  }

  _metaResumeIdFor(meta, harness, cwd) {
    if (!meta?.sessionId) return null;
    if (meta.harness && meta.harness !== harness) return null;
    if (harness === 'codex-app-server' && !sameCwd(meta.cwd, cwd)) return null;
    return meta.sessionId;
  }

  _storeResume(key, resumeId, harness, cwd = null) {
    if (!key || !resumeId) return;
    const rec = { resumeId, harness: harness || null };
    if (cwd) rec.cwd = cwd;
    this._sessionByProject[key] = rec;
    this._saveSessions();
  }

  _deleteResume(key) {
    if (key && this._sessionByProject[key]) {
      delete this._sessionByProject[key];
      this._saveSessions();
    }
  }

  // --- public API -------------------------------------------------------------

  async ensureEngine(key = this.activeKey) {
    const e = this.engines.get(key);
    if (e && e.state === 'ready') return e;
    if (e && e.state === 'starting') {
      const ready = await this._waitForEngineReady(e);
      if (ready) return ready;
    } else if (e && e.state !== 'stopped' && e.state !== 'stopping') {
      return e;
    }
    const m = this.meta.get(key);
    if (m) {
      // Cold-resume a previously-live (idle-evicted) session in ITS OWN folder —
      // never the globally-active project, or it would resume in the wrong cwd.
      const project = this._projectById(m.projectId);
      const profileId = m.profileId || this.activeProfileId;
      const profile = this.profiles.get(profileId);
      const cwd = project?.dir || m.cwd;
      const resumeId = this._resumeIdFor(key, profile?.harness, cwd) || null;
      // Pass the session's own cwd. If the project still exists, use its current
      // dir; if it was deleted, fall back to meta.cwd and fail in that folder
      // instead of silently resuming in another project.
      return this.startEngine(profileId, { key, project, cwd, resumeId, focus: key === this.activeKey });
    }
    return this.startEngine(this.activeProfileId, { key, focus: key === this.activeKey });
  }

  _waitForEngineReady(engine, timeoutMs = 90_000) {
    if (!engine) return Promise.resolve(null);
    if (engine.state === 'ready') return Promise.resolve(engine);
    if (engine.state === 'stopped') return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        engine.off('engine_state', onState);
        resolve(value);
      };
      const onState = (state) => {
        if (state === 'ready') finish(engine);
        else if (state === 'stopped') finish(null);
      };
      const timer = setTimeout(() => {
        this._emitError('Engine startup timed out. Try sending the message again.');
        finish(null);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      engine.on('engine_state', onState);
    });
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
    const prevActiveKey = this.activeKey;
    const shouldFocus = opts.focus !== false;
    if (shouldFocus) this.activeKey = key;
    await this.stopEngine(key); // replace only THIS key's engine

    // The session's folder: prefer an explicit cwd (cold-resume keeps its OWN folder
    // even if the project was deleted), then the resolved project, then the prior cwd.
    const cwd = opts.cwd || project?.dir || prevMeta?.cwd || this.config.projectsDir;
    const projectId = prevMeta?.projectId ?? project?.id ?? null; // an existing session's own folder id wins (cold-resume after a fallback)
    const env = this.secrets.envForProfile(profile);
    // In-app Claude sign-in token/key applies to default-endpoint claude-code engines
    // (the Max/OAuth profile) without a broker restart.
    if (profile?.harness === 'claude-code' && !profile.baseUrl) Object.assign(env, this.secrets.claudeEnv());
    // Resolve the resume id. A FRESH tab must get its OWN brand-new Claude session
    // (resume nothing) — otherwise it inherits the folder's existing session and
    // every concurrent tab writes into the SAME .jsonl, so they collapse into one
    // session (the "only one session shows in this folder" bug). The persisted
    // fallback is keyed by SESSION KEY to match how it's written (line ~389); the
    // first session's key === projectId, so cold-resume of a project still works.
    const sameHarness = !prevMeta?.harness || prevMeta.harness === profile.harness;
    const explicitResume = resumeId && (!opts.resumeHarness || opts.resumeHarness === profile.harness) ? resumeId : null;
    const storedResume = key ? this._resumeIdFor(key, profile.harness, cwd) : null;
    const metaResume = sameHarness ? this._metaResumeIdFor(prevMeta, profile.harness, cwd) : null;
    const resolvedResume = opts.fresh
      ? (explicitResume ?? null)
      : (explicitResume ?? metaResume ?? storedResume ?? null);

    // Keep the chosen model across non-model restarts, but never carry a model
    // alias from one engine family into another. Existing phone installs can have
    // a global saved Claude alias such as "haiku"; Codex must not resume with it.
    const profileChanged = !!prevMeta?.profileId && profileId !== prevMeta.profileId;
    const activeModel = shouldFocus ? this.currentModel : this._preferredModelForProfile(profileId, profile);
    const chosen =
      this._sanitizeModelForProfile(profile, model, { allowCustom: true }) ||
      (profileChanged ? null : this._sanitizeModelForProfile(profile, prevMeta?.model, { allowCustom: true })) ||
      (profileChanged ? null : this._sanitizeModelForProfile(profile, activeModel, { allowCustom: true })) ||
      this._sanitizeModelForProfile(profile, profile.model);
    this._rememberModelForProfile(profileId, chosen);
    const permissionMode = opts.permissionMode || prevMeta?.permissionMode || this.defaultPermissionMode;
    // Effort: a per-call override (cron jobs) wins over the global pref; never mutate
    // the default effort from a detached run.
    const effortPref = opts.effort || prevMeta?.effort || this.defaultEffort;
    const serviceTier = profile.harness === 'codex-app-server'
      ? (opts.serviceTier !== undefined ? opts.serviceTier : (prevMeta?.serviceTier ?? this.defaultServiceTier))
      : null;
    const isUltra = effortPref === 'ultracode'; // maps to xhigh + the ultracode setting

    const engine = createEngine(profile, {
      cwd, env, model: chosen,
      resumeId: resolvedResume,
      claudeBin: this.config.claudeBin,
      codexBin: this.config.codexBin,
      permissionMode,
      effort: isUltra ? 'xhigh' : effortPref,
      serviceTier,
      ultracode: isUltra,
      // A detached/background session (cron) sends its prompt immediately, so its
      // real init arrives at once — skip the capability-warmup probe there. The
      // foreground session may sit idle, so it needs the probe for slash commands.
      warmCapabilities: !opts.detached,
      log: (m) => this._log(m),
    });
    this.engines.set(key, engine);
    this.meta.set(key, {
      busy: false, lastStatus: prevMeta?.lastStatus || StatusState.IDLE,
      profileId, harness: profile.harness, model: chosen,
      permissionMode, effort: effortPref, serviceTier,
      sessionId: resolvedResume || null, projectId, cwd,
      lastActivityTs: Date.now(), lastTurnTs: prevMeta?.lastTurnTs || Date.now(),
      pinned: prevMeta?.pinned || false, title: prevMeta?.title || null,
    });

    engine.on('event', (ev) => this._onEngineEvent(ev, projectId, key));
    engine.on('engine_state', (state) => {
      this.emit(event(EventType.ENGINE_STATE, { state, profileId, model: engine.model, sessionKey: key }));
    });

    try {
      await engine.start();
    } catch (e) {
      if (this._canStartFreshAfterResumeFailure(profile, resolvedResume, e, opts)) {
        this._log(`resume failed for ${profile.harness} (${e.message}); starting a fresh thread`);
        this._deleteResume(key);
        const m = this.meta.get(key);
        if (m) m.sessionId = null;
        return this._startEngineInner(profileId, {
          ...opts,
          resumeId: null,
          resumeHarness: null,
          _freshAfterResumeFailure: true,
        });
      }
      if (!shouldFocus) this.activeKey = prevActiveKey;
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
    // Leaving a tab counts as "just used": restamp the session we're switching AWAY
    // from so its recency-grace window starts now. Without this the memory evictor
    // would sleep the tab you just left on the very next tick (the "instant 💤" bug).
    const prev = this.activeKey;
    if (prev && prev !== key) { const pm = this.meta.get(prev); if (pm) pm.lastActivityTs = Date.now(); }
    this.activeKey = key;
    const m = this.meta.get(key);
    if (m) {
      m.lastActivityTs = Date.now(); // focusing a tab counts as activity (resets its idle timer)
      // Keep the project's bound key in sync with the foreground view, else a later
      // newSession()/restart-in-place resolves against a stale key and a session's
      // turns can route into a sibling (the "sessions merging" bug).
      if (m.projectId) this._activeKeyByProject.set(m.projectId, key);
    }
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
      const working = !!(m.busy || m.inTurn); // a queued-but-not-yet-acked prompt counts as working
      out.push({
        key, projectId: m.projectId, profileId: m.profileId, harness: m.harness,
        model: m.model, effort: m.effort, serviceTier: m.serviceTier ?? null, permissionMode: m.permissionMode,
        sessionId: m.sessionId, busy: working, lastStatus: m.lastStatus,
        active: key === this.activeKey,
        pid: e.proc?.pid ?? null,
        status: working ? 'working' : 'idle',
        idleMs: working ? 0 : (m.lastActivityTs ? Math.max(0, now - m.lastActivityTs) : 0),
        lastTurnTs: m.lastTurnTs || m.lastActivityTs || null,
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
      // A session with inTurn but no engine is WAKING — a prompt was queued and the
      // engine is still (re)spawning (proot + claude + --resume). It must read as working,
      // not 💤 sleeping, or the tab + focused chrome show idle during the whole cold start.
      const waking = !!m.inTurn;
      out.push({
        key, projectId: m.projectId, profileId: m.profileId, harness: m.harness,
        model: m.model, effort: m.effort, serviceTier: m.serviceTier ?? null, permissionMode: m.permissionMode,
        sessionId: m.sessionId, busy: waking, lastStatus: waking ? 'working' : 'idle',
        active: key === this.activeKey, pid: null, status: waking ? 'working' : 'sleeping',
        idleMs: waking ? 0 : (m.lastActivityTs ? Math.max(0, now - m.lastActivityTs) : 0),
        lastTurnTs: m.lastTurnTs || m.lastActivityTs || null,
        pinned: !!m.pinned, title: m.title || (key === MAIN_KEY ? 'Main' : null), sleeping: !waking,
      });
    }
    return out;
  }

  async sendUserMessage(text, attachments) {
    // inTurn marks the session busy the INSTANT a prompt is queued — set it BEFORE
    // ensureEngine(), because a cold/idle-evicted session's spawn (proot + claude +
    // --resume) takes SECONDS, and during that window the session must already read as
    // busy: it shows the working indicator immediately, keeps the focused chrome (Stop
    // button / pill / activity row) from reconciling back to idle on the optimistic
    // timeout, and protects the session from eviction mid-spawn. Cleared on
    // result / error / interrupt. (Fixes the cold-send "stays idle" bug.)
    const m = this.meta.get(this.activeKey);
    if (m) { m.inTurn = true; m.lastTurnTs = Date.now(); m.lastActivityTs = Date.now(); }
    this._emitSessions();
    const engine = await this.ensureEngine();
    if (!engine) { if (m) m.inTurn = false; this._emitSessions(); return; }
    await engine.send({ type: 'user_message', text, attachments });
  }

  respondPermission(id, decision, extra, key) {
    // Route the decision to the engine that RAISED the request (the UI echoes back
    // the request's sessionKey), not whatever happens to be active now — the user
    // may have switched sessions while an approval was pending.
    const e = (key && this.engines.get(key)) || this.engine;
    if (e) e.respondPermission(id, decision, extra);
  }
  respondQuestion(id, answers, key) {
    // Route to the engine that RAISED the question (UI echoes its sessionKey), so a
    // question survives the user switching to another session while it's pending.
    const e = (key && this.engines.get(key)) || this.engine;
    if (e) e.respondQuestion(id, answers);
  }
  interrupt() {
    // Stop ends the turn now — even if a hung cold-resume never emits a result — so the
    // session stops being eviction-protected and the indicator clears. (Your point:
    // a stuck session is just a Stop click away.)
    const m = this.meta.get(this.activeKey);
    if (m) m.inTurn = false;
    if (this.engine) this.engine.interrupt();
    this._emitSessions();
  }

  async switchEngine(profileId) { this._log(`switching engine -> ${profileId}`); return this.startEngine(profileId, {}); }

  /** Forget the active key's resume id (used by /clear) so the next start is fresh. */
  dropActiveResume() {
    this._deleteResume(this.activeKey);
    const m = this._activeMeta;
    if (m) m.sessionId = null;
  }

  async switchModel(model, opts = {}) {
    const profileId = this.activeProfileId;
    const profile = this.profiles.get(profileId);
    const clean =
      this._sanitizeModelForProfile(profile, model, { allowCustom: true }) ||
      this._sanitizeModelForProfile(profile, profile?.model);
    this._log(`switching model -> ${clean || 'default'} (fresh session)`);
    this.defaultModel = clean;
    this._rememberModelForProfile(profileId, clean);
    if (Object.prototype.hasOwnProperty.call(opts, 'effort')) this.defaultEffort = opts.effort;
    if (Object.prototype.hasOwnProperty.call(opts, 'serviceTier')) this.defaultServiceTier = opts.serviceTier ?? null;
    this._deleteResume(this.activeKey); // a fresh session for THIS key only
    return this.startEngine(profileId, {
      model: clean,
      resumeId: null,
      effort: opts.effort,
      serviceTier: opts.serviceTier,
    });
  }

  async setPermissionMode(mode) {
    const m = this._activeMeta;
    this.defaultPermissionMode = mode;
    if (m) m.permissionMode = mode;
    const resumeId = this.engine?.sessionId || this._resumeIdFor(this.activeKey, m?.harness || this.engine?.harness, m?.cwd || this.engine?.cwd) || null;
    this._log(`set permission mode -> ${mode} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async setEffort(level) {
    const m = this._activeMeta;
    this.defaultEffort = level;
    if (m) m.effort = level;
    if (m?.harness === 'codex-app-server' && this.engine) {
      this.engine.effort = level === 'ultracode' ? 'xhigh' : level;
      this._emitSessions();
      return this.engine;
    }
    const resumeId = this.engine?.sessionId || this._resumeIdFor(this.activeKey, m?.harness || this.engine?.harness, m?.cwd || this.engine?.cwd) || null;
    this._log(`set effort -> ${level} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async setServiceTier(serviceTier) {
    const m = this._activeMeta;
    this.defaultServiceTier = serviceTier ?? null;
    if (m) m.serviceTier = serviceTier ?? null;
    if (m?.harness === 'codex-app-server' && this.engine) {
      this.engine.serviceTier = serviceTier ?? null;
      this._emitSessions();
      return this.engine;
    }
    const resumeId = this.engine?.sessionId || this._resumeIdFor(this.activeKey, m?.harness || this.engine?.harness, m?.cwd || this.engine?.cwd) || null;
    this._log(`set service tier -> ${serviceTier || 'standard'} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId, serviceTier: serviceTier ?? null });
  }

  async refreshCapabilities() {
    if (!this.engine || this.engine.state === 'stopped') return null;
    const status = this._activeMeta?.lastStatus || StatusState.IDLE;
    if (status && status !== StatusState.IDLE && status !== StatusState.ERROR) return null;
    const resumeId = this.engine?.sessionId || this._resumeIdFor(this.activeKey, this._activeMeta?.harness || this.engine?.harness, this._activeMeta?.cwd || this.engine?.cwd) || null;
    this._log(`refreshing capabilities (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  /** Start a NEW concurrent session in the active folder (a fresh tab), leaving any
   *  existing sessions in that folder running in the background. */
  async newSession() {
    return this.startEngine(this.activeProfileId, { project: this.getActiveProject(), fresh: true, resumeId: null });
  }

  async resume(sessionId, opts = {}) {
    return this.startEngine(opts.profileId || this.activeProfileId, {
      resumeId: sessionId,
      resumeHarness: opts.harness,
    });
  }

  /**
   * Start an engine for a background task (a cron job) WITHOUT changing which
   * session the UI is viewing — the foreground activeKey/profile/model are
   * preserved. `fresh` mints a new session in the folder; pass a stable `key` +
   * `resumeId` to continue one persistent session. Returns { engine, key } or null.
   */
  async startDetached({ projectId, cwd, resumeId = null, fresh = false, key, profileId = null, model = null, effort = null, serviceTier = undefined } = {}) {
    const project = this._projectById(projectId) || (cwd ? { id: projectId || null, dir: cwd } : this.getActiveProject());
    const pid = project?.id ?? null;
    const saved = {
      active: this.activeKey,
      binding: pid != null ? this._activeKeyByProject.get(pid) : undefined,
    };
    // Per-job engine overrides (cron): fall back to the foreground profile/model/effort.
    const engine = await this.startEngine(profileId || this.activeProfileId, { key, project, cwd: cwd || project?.dir, resumeId, fresh, model: model || undefined, effort: effort || undefined, serviceTier, detached: true });
    const newKey = this.activeKey; // startEngine focused the (possibly minted) key; capture before restoring
    // Restore the foreground view — the detached session runs in the background.
    // Crucially also restore the project→activeKey binding, which startEngine
    // (fresh) rebinds to the new session; leaving it would route the foreground
    // folder's next new_session/restart into the cron session.
    this.activeKey = saved.active;
    if (pid != null) {
      if (saved.binding === undefined) this._activeKeyByProject.delete(pid);
      else this._activeKeyByProject.set(pid, saved.binding);
    }
    this._emitSessions();
    return engine ? { engine, key: newKey } : null;
  }

  /** Send a user message to a SPECIFIC session (not necessarily the active one). */
  async sendTo(key, text, attachments) {
    const engine = this.engines.get(key);
    if (!engine) return false;
    const m = this.meta.get(key);
    if (m) { m.inTurn = true; m.lastTurnTs = Date.now(); m.lastActivityTs = Date.now(); }
    this._emitSessions();
    await engine.send({ type: 'user_message', text, attachments });
    return true;
  }

  /** Forget a key's persisted resume id (so a deleted session is never --resume'd)
   *  and tear down its engine if live. Used when a session's .jsonl is deleted. */
  /** All session keys (live or sleeping) bound to a given project id. */
  keysForProject(projectId) {
    const out = [];
    for (const [key, m] of this.meta) if (m && m.projectId === projectId) out.push(key);
    return out;
  }

  async forgetSession(key) {
    const m = this.meta.get(key);
    const pid = m?.projectId;
    // Clear the per-project resume hint only if it pointed at THIS session's id
    // (don't orphan sibling sessions that share the folder).
    if (m?.sessionId && pid && this._resumeRecord(pid)?.resumeId === m.sessionId) this._deleteResume(pid);
    if (key && key !== MAIN_KEY && this._sessionByProject[key]) this._deleteResume(key); // legacy: key may be a projectId
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
      lastStatus: this._activeMeta?.lastStatus || StatusState.IDLE,
      permissionMode: this.permissionMode,
      effort: this.effort,
      serviceTier: this.serviceTier,
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
      const harness = ev.engine || m?.harness || this.engines.get(key)?.harness || null;
      const cwd = ev.cwd || m?.cwd || this.engines.get(key)?.cwd || null;
      this._storeResume(key, ev.sessionId, harness, cwd);
      if (m) { m.sessionId = ev.sessionId; m.harness = harness; if (cwd) m.cwd = cwd; }
    }
    if (ev.type === EventType.STATUS && ev.state) {
      const busy = ev.state !== StatusState.IDLE && ev.state !== StatusState.ERROR;
      // A plain IDLE here is the engine's INIT (before "thinking"), NOT the end of the
      // turn — so DON'T clear inTurn on idle; only ERROR ends a turn (result clears the
      // normal completion). Status is also not session-history activity: Codex emits
      // startup/status notifications when a tab is opened or cold-resumed.
      const changed = !m || m.busy !== busy || m.lastStatus !== ev.state;
      if (m) { m.lastStatus = ev.state; m.busy = busy; m.lastActivityTs = Date.now();
        if (ev.state === StatusState.ERROR) m.inTurn = false; }
      // Keep the sessions screen + nav badge live for EVERY session (active too),
      // so a working session always shows its indicator.
      if (changed) this._emitSessions();
    }
    if (ev.type === EventType.CAPABILITIES) {
      const e = this.engines.get(key); if (e) e._lastCaps = ev;
      this.capabilitiesByKey.set(key, ev);
    }
    if (ev.type === EventType.PERMISSION_MODE && ev.mode && m) m.permissionMode = ev.mode;
    if (ev.type === EventType.SESSION_META && ev.sessionId) this._emitSessions(); // sessionId now known
    if (ev.type === EventType.RESULT && m) { if (m.busy) m.busy = false; m.inTurn = false; m.lastActivityTs = Date.now(); m.lastTurnTs = Date.now(); this._emitSessions(); }
    this.emit(ev);
  }

  _emitSessions() { this.emit(event(EventType.SESSIONS, { items: this.uiSessions(), activeKey: this.activeKey })); }

  _emitError(message) { this.emit(event(EventType.ERROR, { message })); }
  _log(message) {
    if (this.config.verbose) process.stderr.write(`[session] ${message}\n`);
    this.emit(event(EventType.LOG, { level: 'debug', message }));
  }
  _profileModelAliases(profile) {
    const aliases = [];
    if (Array.isArray(profile?.models)) aliases.push(...profile.models);
    if (profile?.model) aliases.push(profile.model);
    return [...new Set(aliases.filter(Boolean).map(String))];
  }
  _sanitizeModelForProfile(profile, model, { allowCustom = false } = {}) {
    if (!model) return null;
    const wanted = String(model);
    const aliases = this._profileModelAliases(profile);
    if (aliases.includes(wanted)) return wanted;
    if (allowCustom && !this._looksIncompatibleWithProfile(profile, wanted)) return wanted;
    if (!aliases.length) return wanted;
    return null;
  }
  _looksIncompatibleWithProfile(profile, model) {
    const value = String(model || '').toLowerCase();
    if (profile?.harness === 'codex-app-server') {
      return value === 'opus' || value === 'sonnet' || value === 'haiku' || value.startsWith('claude-');
    }
    if (profile?.harness === 'claude-code') {
      return value.startsWith('gpt-') || value.startsWith('o1') || value.startsWith('o3') || value.startsWith('o4');
    }
    return false;
  }
  _rememberModelForProfile(profileId, model) {
    if (!profileId) return;
    if (model) this.defaultModelsByProfile.set(profileId, model);
    else this.defaultModelsByProfile.delete(profileId);
  }
  _preferredModelForProfile(profileId, profile) {
    return this._sanitizeModelForProfile(profile, this.defaultModelsByProfile.get(profileId), { allowCustom: true }) ||
      this._sanitizeModelForProfile(profile, this.defaultModel, { allowCustom: true }) ||
      this._sanitizeModelForProfile(profile, profile?.model);
  }
  _canStartFreshAfterResumeFailure(profile, resumeId, error, opts = {}) {
    if (opts._freshAfterResumeFailure || !resumeId) return false;
    if (profile?.harness !== 'codex-app-server') return false;
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes('no rollout found') ||
      (msg.includes('thread') && (msg.includes('not found') || msg.includes('missing') || msg.includes('unknown')));
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
