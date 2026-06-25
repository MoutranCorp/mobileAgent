import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { JsonLineBuffer } from '../jsonl.js';

/**
 * Resolves Claude model aliases (opus/sonnet/haiku) to their versioned ids
 * (claude-opus-4-8, ...) by reading the `system/init` event the CLI emits BEFORE
 * any tokens are spent — so it's free. From the id we derive a friendly label
 * ("Opus 4.8") dynamically, never hardcoding version numbers. Results are cached
 * to <stateDir>/models.json so this runs at most once per machine.
 */
export class ModelResolver {
  constructor({ stateDir, claudeBin = 'claude' }) {
    this.file = path.join(stateDir, 'models.json');
    this.claudeBin = claudeBin;
    this.cache = this._load();
    this._inFlight = null;
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
    try { fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2)); } catch { /* ignore */ }
  }

  /** Record a resolved id observed from a live engine's init (free). */
  observe(alias, id) {
    if (alias && id && this.cache[alias] !== id) { this.cache[alias] = id; this._save(); }
  }

  /** Return [{alias, id, label}] for the given aliases, resolving misses. */
  async list(aliases, { cwd, env, refresh = false } = {}) {
    if (refresh) this.cache = {};
    if (this._inFlight) await this._inFlight;
    const missing = aliases.filter((a) => !this.cache[a]);
    if (missing.length) {
      this._inFlight = this._resolveAll(missing, { cwd, env });
      await this._inFlight;
      this._inFlight = null;
    }
    return aliases.map((alias) => ({ alias, id: this.cache[alias] || null, label: labelFor(alias, this.cache[alias]) }));
  }

  async _resolveAll(aliases, opts) {
    for (const a of aliases) {
      const id = await this._resolveOne(a, opts);
      if (id) { this.cache[a] = id; this._save(); }
    }
  }

  _resolveOne(alias, { cwd, env, timeoutMs = 12000 } = {}) {
    return new Promise((resolve) => {
      let proc;
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        try { proc && proc.kill('SIGKILL'); } catch { /* ignore */ }
        resolve(v);
      };
      const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', alias];
      try {
        proc = spawn(this.claudeBin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch {
        return resolve(null);
      }
      const buf = new JsonLineBuffer();
      const t = setTimeout(() => finish(null), timeoutMs);
      proc.on('error', () => { clearTimeout(t); finish(null); });
      proc.on('exit', () => { clearTimeout(t); finish(null); });
      proc.stdout.on('data', (c) => {
        for (const msg of buf.push(c)) {
          if (msg.type === 'system' && msg.subtype === 'init') { clearTimeout(t); finish(msg.model || null); }
        }
      });
    });
  }
}

/** "claude-opus-4-8" -> "Opus 4.8"; "claude-haiku-4-5-20251001" -> "Haiku 4.5". */
export function labelFor(alias, id) {
  if (id) {
    const m = id.match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
    if (m) return `${cap(m[1])} ${m[2]}.${m[3]}`;
  }
  return cap(alias);
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
