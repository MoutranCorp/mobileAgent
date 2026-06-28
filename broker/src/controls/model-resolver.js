import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { JsonLineBuffer } from '../jsonl.js';

/**
 * Resolves Claude model aliases (opus/sonnet/haiku) to their versioned ids
 * (claude-opus-4-8, ...) by reading the `system/init` event. We send a trivial
 * message to trigger init (newer CLIs defer it until the first input) and SIGKILL
 * at init — which precedes the API request, so it's free, no tokens spent. From
 * the id we derive a friendly label ("Opus 4.8") dynamically, never hardcoding
 * version numbers. Results cache to <stateDir>/models.json (once per machine).
 */
export class ModelResolver {
  constructor({ stateDir, claudeBin = 'claude' }) {
    this.file = path.join(stateDir, 'models.json');
    this.claudeBin = claudeBin;
    this.cache = this._load();
    this._chain = null;
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
    if (!alias || !id || !familyMatches(alias, id)) return; // reject cross-family (e.g. opus -> sonnet id)
    if (this.cache[alias] !== id) { this.cache[alias] = id; this._save(); }
  }

  /** Return [{alias, id, label}] for the given aliases, resolving misses. */
  async list(aliases, { cwd, env, refresh = false } = {}) {
    if (refresh) this.cache = {};
    // Serialize all resolution through one chain. The old `_inFlight` guard was
    // racy: two concurrent callers could both observe it null, both compute the
    // same `missing` set, and both spawn resolvers (double work, possible
    // duplicate caching). Recomputing `missing` *inside* the chained step means a
    // later caller sees whatever an earlier step already cached.
    const run = async () => {
      const missing = aliases.filter((a) => !this.cache[a]);
      if (missing.length) await this._resolveAll(missing, { cwd, env });
    };
    this._chain = (this._chain || Promise.resolve()).then(run, run);
    await this._chain;
    return aliases.map((alias) => ({ alias, id: this.cache[alias] || null, label: labelFor(alias, this.cache[alias]) }));
  }

  async _resolveAll(aliases, opts) {
    for (const a of aliases) {
      const id = await this._resolveOne(a, opts);
      // Only cache when the resolved id's family matches the requested alias.
      // An account without (e.g.) Opus access reports a Sonnet id for `--model
      // opus`; caching that would label opus "Sonnet 4.6" and duplicate sonnet.
      if (id && familyMatches(a, id)) { this.cache[a] = id; this._save(); }
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
      // The CLI now defers `system/init` until it reads the FIRST user message
      // (older versions emitted it on spawn). Send a trivial one to trigger init;
      // we SIGKILL at init — before the API request — so it stays free (no tokens).
      try { proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'); } catch { /* ignore */ }
    });
  }
}

/** "claude-opus-4-8" -> "Opus 4.8"; "claude-haiku-4-5-20251001" -> "Haiku 4.5". */
export function labelFor(alias, id) {
  // Only trust an id-derived version label when its family matches the alias.
  // Otherwise (e.g. alias 'opus' resolved to a sonnet id on a non-Opus account)
  // fall back to the capitalized alias so the picker shows a distinct "Opus".
  if (id && familyMatches(alias, id)) {
    const m = id.match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
    if (m) return `${cap(m[1])} ${m[2]}.${m[3]}`;
  }
  return cap(alias);
}

/** The model family token in a string, or null (glm-5.2, mock-1 -> null). */
export function familyOf(s) {
  const m = String(s || '').match(/opus|sonnet|haiku|fable/i);
  return m ? m[0].toLowerCase() : null;
}

/** Aliases with no family token (glm-5.2, mock-1) resolve verbatim. A known
 *  family alias (opus/sonnet/haiku/fable) must resolve to the SAME family. */
export function familyMatches(alias, id) {
  const fa = familyOf(alias);
  if (!fa) return true;
  return fa === familyOf(id);
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
