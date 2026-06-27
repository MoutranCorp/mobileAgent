import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_FILE = path.join(HERE, '..', '..', 'config', 'user-settings.default.json');

/** Strip the `$comment` documentation keys from a (possibly nested) object. */
function stripComments(v) {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) { if (k === '$comment') continue; out[k] = stripComments(v[k]); }
    return out;
  }
  return v;
}

/** Deep-merge `patch` onto `base` (objects merge; arrays/scalars/null replace). */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    out[k] = (pv && typeof pv === 'object' && !Array.isArray(pv)) ? deepMerge(out[k], pv) : pv;
  }
  return out;
}

/**
 * UserSettings — the single store for per-user UI/engine preferences (open tabs,
 * selected model/effort/permission-mode, Manage-screen tab order, …). The schema
 * + defaults are committed at config/user-settings.default.json; the LIVE copy is
 * `<stateDir>/user-settings.json` (gitignored, device-local). The live file is
 * deep-merged over the defaults, so new default keys appear for existing installs
 * with no migration. Writes are debounced; flush() forces them out on shutdown.
 */
export class UserSettings {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'user-settings.json');
    this._defaults = this._loadDefaults();
    this._saved = this._loadSaved();
    this._saveTimer = null;
  }

  _loadDefaults() {
    try { return stripComments(JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'))); }
    catch (e) { console.warn(`[user-settings] could not read defaults (${e?.message || e})`); return { version: 1 }; }
  }

  _loadSaved() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object') return raw;
      }
    } catch (e) {
      // Don't lose a user's settings on a transient/corrupt read — warn + start from defaults.
      console.warn(`[user-settings] could not parse ${this.file} (${e?.message || e}); using defaults`);
    }
    return {};
  }

  /** The effective settings (defaults deep-merged with the saved overrides). */
  get() { return deepMerge(this._defaults, this._saved); }

  /** Deep-merge a partial patch onto the saved overrides and persist (debounced).
   *  Returns the new effective settings. */
  patch(partial) {
    if (!partial || typeof partial !== 'object') return this.get();
    this._saved = deepMerge(this._saved, partial);
    this._scheduleSave();
    return this.get();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._write(); }, 400);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._write();
  }

  _write() {
    try {
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this._saved, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file); // atomic
    } catch (e) { console.warn(`[user-settings] save failed: ${e?.message || e}`); }
  }
}
