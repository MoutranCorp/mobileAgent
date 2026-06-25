import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from './engines/index.js';
import { EventType, StatusState, event } from './protocol.js';

/**
 * SessionManager — owns exactly one active engine at a time and brokers the
 * canonical event stream out to the UI.
 *
 * "Seamless" engine/model switching lives here (Section 3): Claude Code fixes
 * the model at session start, so switching = stop the current engine, respawn
 * with the new profile/model, optionally `--resume`-ing the session id to keep
 * context. A fresh task feels instant; an in-flight conversation resets unless
 * resumed.
 */
export class SessionManager {
  /**
   * @param {object} deps
   * @param {import('./config.js')} deps.config
   * @param {import('./profiles.js').ProfileStore} deps.profiles
   * @param {import('./secrets.js').SecretStore} deps.secrets
   * @param {() => {id:string, dir:string}|null} deps.getActiveProject
   * @param {(event:object) => void} deps.emit  send a canonical event to the UI
   */
  constructor({ config, profiles, secrets, getActiveProject, emit }) {
    this.config = config;
    this.profiles = profiles;
    this.secrets = secrets;
    this.getActiveProject = getActiveProject;
    this.emit = emit;

    this.engine = null;
    this.activeProfileId = config.defaultProfile;
    this.permissionMode = config.permissionMode || 'default';
    this.effort = config.effort || 'high'; // low|medium|high|xhigh|max
    this.currentModel = null; // the alias/id last requested (for resolver labelling)
    this.sessionsFile = path.join(config.stateDir, 'sessions.json');
    this._sessionByProject = this._loadSessions();
    this._lastStatus = StatusState.IDLE;
    this.lastCapabilities = null;
  }

  // --- public API -------------------------------------------------------------

  async ensureEngine() {
    if (this.engine && this.engine.state !== 'stopped') return this.engine;
    return this.startEngine(this.activeProfileId, {});
  }

  async startEngine(profileId, { resumeId, model } = {}) {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      this._emitError(`No such profile: ${profileId}`);
      return null;
    }
    if (!this.secrets.isReady(profile)) {
      this._emitError(
        `Profile '${profile.label}' is missing its auth token (${profile.authRef}). ` +
          `Add it in Settings before switching.`
      );
      return null;
    }

    await this.stopEngine();

    const project = this.getActiveProject();
    const cwd = project?.dir || this.config.projectsDir;
    const env = this.secrets.envForProfile(profile);

    // Resume the project's last session if we have one and none was requested.
    const resolvedResume =
      resumeId ?? (project ? this._sessionByProject[project.id] : null) ?? null;

    this.activeProfileId = profileId;
    this.currentModel = model || profile.model;
    const engine = createEngine(profile, {
      cwd,
      env,
      model: model || profile.model,
      resumeId: resolvedResume,
      claudeBin: this.config.claudeBin,
      permissionMode: this.permissionMode,
      effort: this.effort,
      log: (m) => this._log(m),
    });
    this.engine = engine;

    engine.on('event', (ev) => this._onEngineEvent(ev, project));
    engine.on('engine_state', (state) => {
      this.emit(event(EventType.ENGINE_STATE, { state, profileId, model: engine.model }));
    });

    try {
      await engine.start();
    } catch (e) {
      this._emitError(`Failed to start engine: ${e.message}`);
      return null;
    }
    return engine;
  }

  async stopEngine() {
    if (!this.engine) return;
    const e = this.engine;
    this.engine = null;
    try {
      await e.stop();
    } catch {
      /* ignore */
    }
  }

  async sendUserMessage(text, images) {
    const engine = await this.ensureEngine();
    if (!engine) return;
    await engine.send({ type: 'user_message', text, images });
  }

  respondPermission(id, decision, extra) {
    if (this.engine) this.engine.respondPermission(id, decision, extra);
  }

  interrupt() {
    if (this.engine) this.engine.interrupt();
  }

  async switchEngine(profileId) {
    this._log(`switching engine -> ${profileId}`);
    return this.startEngine(profileId, {});
  }

  async switchModel(model) {
    // Claude Code fixes the model at session start and --resume restores the
    // original session's model, so resuming with a new model no-ops. Start a
    // FRESH session at the new model instead (context resets — surfaced to UI).
    this._log(`switching model -> ${model} (fresh session)`);
    const project = this.getActiveProject();
    if (project) delete this._sessionByProject[project.id];
    this._saveSessions();
    return this.startEngine(this.activeProfileId, { model, resumeId: null });
  }

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    // Permission mode is fixed at CLI start, so restart resuming the session.
    const project = this.getActiveProject();
    const resumeId = this.engine?.sessionId || (project ? this._sessionByProject[project.id] : null);
    this._log(`set permission mode -> ${mode} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async setEffort(level) {
    this.effort = level;
    // --effort is fixed at CLI start; restart resuming the session to keep context.
    const project = this.getActiveProject();
    const resumeId = this.engine?.sessionId || (project ? this._sessionByProject[project.id] : null);
    this._log(`set effort -> ${level} (resume ${resumeId || 'none'})`);
    return this.startEngine(this.activeProfileId, { resumeId });
  }

  async newSession() {
    const project = this.getActiveProject();
    if (project) delete this._sessionByProject[project.id];
    this._saveSessions();
    return this.startEngine(this.activeProfileId, { resumeId: null });
  }

  async resume(sessionId) {
    return this.startEngine(this.activeProfileId, { resumeId: sessionId });
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
    };
  }

  // --- internals --------------------------------------------------------------

  _onEngineEvent(ev, project) {
    if (ev.type === EventType.SESSION_META && ev.sessionId && project) {
      this._sessionByProject[project.id] = ev.sessionId;
      this._saveSessions();
    }
    if (ev.type === EventType.STATUS && ev.state) {
      this._lastStatus = ev.state;
    }
    if (ev.type === EventType.CAPABILITIES) {
      this.lastCapabilities = ev; // cache so reconnecting clients get it via snapshot
    }
    if (ev.type === EventType.PERMISSION_MODE && ev.mode) {
      this.permissionMode = ev.mode;
    }
    this.emit(ev);
  }

  _emitError(message) {
    this.emit(event(EventType.ERROR, { message }));
  }

  _log(message) {
    if (this.config.verbose) process.stderr.write(`[session] ${message}\n`);
    this.emit(event(EventType.LOG, { level: 'debug', message }));
  }

  _loadSessions() {
    try {
      if (fs.existsSync(this.sessionsFile))
        return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
    } catch {
      /* ignore */
    }
    return {};
  }

  _saveSessions() {
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify(this._sessionByProject, null, 2));
    } catch {
      /* ignore */
    }
  }
}
