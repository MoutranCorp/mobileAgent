import { EventEmitter } from 'node:events';
import { EventType, StatusState, event } from '../protocol.js';

export const DEFAULT_ENGINE_FEATURES = Object.freeze({
  thinking: false,
  permissions: false,
  questions: false,
  resume: false,
  slashCommands: false,
  models: false,
  effort: false,
  config: false,
  appServer: false,
});

/**
 * EngineAdapter — the seam that makes the brain pluggable.
 *
 * Every harness (Claude Code, opencode, goose, ...) gets a subclass whose ONLY
 * job is native-protocol <-> canonical translation. The broker and UI never see
 * a harness-specific shape; they only ever see canonical events (protocol.js).
 *
 * Subclasses must implement:
 *   _spawn()                 -> start the underlying process / connection
 *   send(cmd)                -> handle a canonical command (user_message, etc.)
 *   interrupt()              -> cancel the in-flight turn
 *   _teardown()              -> stop the underlying process / connection
 *
 * Subclasses may implement optional features declared by `features`:
 *   respondPermission(id,d)  -> resolve a pending permission_request
 *   respondQuestion(id,a)    -> resolve a pending question_request
 *
 * Unsupported optional responses must still be visible to the UI. The base
 * defaults emit canonical resolved/log events instead of silently dropping them.
 *
 * Subclasses emit canonical events by calling this.emitEvent(type, fields).
 */
export class EngineAdapter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../profiles.js').Profile} opts.profile
   * @param {string} opts.cwd        working directory (project dir)
   * @param {object} opts.env        environment to inject at spawn
   * @param {string} [opts.model]    requested model alias (overrides profile default)
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor(opts) {
    super();
    const { profile, cwd, env, log, model } = opts;
    this.profile = profile;
    this.cwd = cwd;
    this.env = env || {};
    this.log = log || (() => {});
    this.sessionId = null;
    // Honor the per-call model override — without this, switching models only
    // relabeled the UI while the CLI kept spawning with the profile default.
    this.model = model || profile?.model || null;
    this.permissionMode = opts.permissionMode || profile?.permissionMode || 'default';
    this.effort = opts.effort || null;
    this.state = 'stopped'; // stopped | starting | ready | stopping
    this.features = Object.freeze({
      ...DEFAULT_ENGINE_FEATURES,
      ...(this.constructor.features || {}),
      ...(opts.features || {}),
    });
  }

  /** Human-readable engine id (e.g. 'claude-code', 'opencode', 'mock'). */
  get harness() {
    return this.profile?.harness || 'unknown';
  }

  /** Start the engine. Emits session_meta once the session id is known. */
  async start() {
    this.state = 'starting';
    this.emit('engine_state', 'starting');
    try {
      await this._spawn();
    } catch (e) {
      // Leave a clean 'stopped' state so stop()/a retry behaves (was stuck 'starting').
      this.state = 'stopped';
      this.emit('engine_state', 'stopped');
      throw e;
    }
    this.state = 'ready';
    this.emit('engine_state', 'ready');
  }

  /** Stop the engine cleanly. */
  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.state = 'stopping';
    this.emit('engine_state', 'stopping');
    try {
      await this._teardown();
    } finally {
      this.state = 'stopped';
      this.emit('engine_state', 'stopped');
    }
  }

  // --- helpers for subclasses -------------------------------------------------

  /** Emit a canonical event to any listener (the session/server relays it). */
  emitEvent(type, fields = {}) {
    this.emit('event', event(type, fields));
  }

  emitText(delta) {
    if (delta) this.emitEvent(EventType.ASSISTANT_TEXT, { delta });
  }

  emitThinking(delta) {
    if (delta) this.emitEvent(EventType.ASSISTANT_THINKING, { delta });
  }

  emitStatus(stateName, detail) {
    this.emitEvent(EventType.STATUS, { state: stateName, detail });
  }

  emitError(message, extra = {}) {
    this.emitEvent(EventType.ERROR, { message, ...extra });
    this.emitStatus(StatusState.ERROR, message);
  }

  emitCapabilities(fields = {}) {
    this.emitEvent(EventType.CAPABILITIES, {
      ...fields,
      features: this.features,
    });
  }

  setSession(sessionId) {
    this.sessionId = sessionId;
    this.emitEvent(EventType.SESSION_META, {
      sessionId,
      engine: this.harness,
      model: this.model,
      profileId: this.profile?.id,
      cwd: this.cwd,
    });
  }

  // --- to be overridden -------------------------------------------------------

  async _spawn() {
    throw new Error(`${this.constructor.name} must implement _spawn()`);
  }

  async _teardown() {
    /* default no-op */
  }

  // eslint-disable-next-line no-unused-vars
  async send(cmd) {
    throw new Error(`${this.constructor.name} must implement send()`);
  }

  respondPermission(id, decision) {
    this.emitEvent(EventType.PERMISSION_RESOLVED, {
      id,
      decision: 'deny',
      requestedDecision: decision,
      unsupported: true,
      reason: `${this.harness} does not support broker-managed permissions`,
    });
    this.emitEvent(EventType.LOG, {
      level: 'warn',
      message: `${this.harness} ignored unsupported permission response ${id}`,
    });
  }

  respondQuestion(id) {
    this.emitEvent(EventType.QUESTION_RESOLVED, {
      id,
      unsupported: true,
      cancelled: true,
    });
    this.emitEvent(EventType.LOG, {
      level: 'warn',
      message: `${this.harness} ignored unsupported question response ${id}`,
    });
  }

  interrupt() {
    throw new Error(`${this.constructor.name} must implement interrupt()`);
  }
}
