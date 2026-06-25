import fs from 'node:fs';
import path from 'node:path';
import { EventType, event } from '../protocol.js';

/**
 * AutoVerify — a self-healing build loop. When enabled, after each agent turn it
 * runs a verify command (default `npm test`). If it FAILS, the failure output is
 * fed back to the agent as a new message so it can fix the breakage — bounded by
 * maxIterations so it can't loop forever. The chain resets when YOU send a real
 * message. Config persists at <stateDir>/autoverify.json.
 */
export class AutoVerify {
  constructor({ stateDir, runner, emit, sendFix }) {
    this.file = path.join(stateDir, 'autoverify.json');
    this.runner = runner;
    this.emit = emit;
    this.sendFix = sendFix; // (text) => void  — sends a message to the agent
    const cfg = this._load();
    this.enabled = cfg.enabled ?? false;
    this.command = cfg.command || 'npm test';
    this.maxIterations = cfg.maxIterations ?? 3;
    this.iteration = 0;
    this.active = false;
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* ignore */
    }
    return {};
  }
  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        enabled: this.enabled, command: this.command, maxIterations: this.maxIterations,
      }, null, 2));
    } catch {
      /* ignore */
    }
  }

  configure({ enabled, command, maxIterations }) {
    if (enabled !== undefined) this.enabled = !!enabled;
    if (command !== undefined && command) this.command = command;
    if (maxIterations !== undefined) this.maxIterations = Math.max(1, Math.min(10, Number(maxIterations) || 3));
    this._save();
    this.emitState();
  }

  /** Reset the fix-chain — called when the user sends a real message. */
  resetChain() {
    this.iteration = 0;
  }

  emitState(extra = {}) {
    this.emit(event(EventType.AUTOVERIFY, {
      enabled: this.enabled, command: this.command, maxIterations: this.maxIterations,
      iteration: this.iteration, ...extra,
    }));
  }

  /** Called after each turn completes (RESULT). Runs verify, may re-prompt. */
  async onTurnComplete(cwd) {
    if (!this.enabled || this.active || !cwd) return;
    this.active = true;
    this.emitState({ state: 'running' });
    let res;
    try {
      res = await this.runner.run('verify', this.command, { cwd });
    } catch (e) {
      res = { code: -1, stdout: '', stderr: e.message };
    }
    this.active = false;
    if (res.code === 0) {
      this.iteration = 0;
      this.emitState({ state: 'passed' });
      return;
    }
    if (this.iteration >= this.maxIterations) {
      this.iteration = 0;
      this.emitState({ state: 'maxed' });
      return;
    }
    this.iteration += 1;
    this.emitState({ state: 'failed' });
    const out = ((res.stdout || '') + '\n' + (res.stderr || '')).trim().slice(-4000);
    this.sendFix(
      `The verify command \`${this.command}\` failed (auto-verify, attempt ${this.iteration}/${this.maxIterations}). ` +
        `Please fix the cause and keep changes minimal.\n\nOutput:\n${out}`
    );
  }
}
