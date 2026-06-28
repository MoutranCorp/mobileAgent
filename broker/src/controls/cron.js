import fs from 'node:fs';
import path from 'node:path';

/**
 * CronManager — scheduled agent jobs, persisted device-local.
 *
 * A job runs a saved prompt in a chosen folder on a schedule. Scheduling is
 * evaluated IN-BROKER (a tick in server.js asks `due(now)`), so jobs fire while
 * the broker is alive; OS-level background wake (Android AlarmManager) can be
 * layered on later by calling the same `due()`/`noteRun()` surface.
 *
 * Schedule is stored as a 5-field cron string (`min hour dom month dow`) plus a
 * human label. The UI builds presets into cron via `presetToCron`, or passes a
 * raw cron expression straight through.
 *
 * Jobs live in `<stateDir>/cron-jobs.json` (gitignored). Each job:
 *   { id, name, prompt, projectId, schedule:{cron,label,source}, sessionMode,
 *     enabled, createdAt, lastRun, lastStatus, lastSessionKey, lastSessionId }
 * `sessionMode` is 'fresh' (new session each run) or 'persistent' (resume one
 * long-lived session so context accumulates).
 */

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// --- cron expression evaluation --------------------------------------------

/** Parse one cron field into a sorted list of allowed integers in [min,max]. */
export function parseField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const m = part.trim();
    if (m === '*') { for (let i = min; i <= max; i++) out.add(i); continue; }
    // step: */n or a-b/n or a/n
    const stepMatch = m.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (!step) throw new Error(`bad step in "${m}"`);
      let lo = min, hi = max;
      if (stepMatch[1] !== '*') {
        const r = stepMatch[1].split('-').map(Number);
        lo = r[0]; hi = r.length > 1 ? r[1] : max;
      }
      for (let i = lo; i <= hi; i += step) out.add(i);
      continue;
    }
    const range = m.match(/^(\d+)-(\d+)$/);
    if (range) { for (let i = Number(range[1]); i <= Number(range[2]); i++) out.add(i); continue; }
    if (/^\d+$/.test(m)) { out.add(Number(m)); continue; }
    throw new Error(`unparseable cron field "${field}"`);
  }
  const arr = [...out].filter((n) => n >= min && n <= max).sort((a, b) => a - b);
  if (!arr.length) throw new Error(`empty cron field "${field}"`);
  return arr;
}

/** Parse a 5-field cron string into { minute, hour, dom, month, dow }. */
export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields, got ${fields.length}`);
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dow: parseField(fields[4], 0, 6), // 0 = Sunday
    domRestricted: fields[2].trim() !== '*',
    dowRestricted: fields[4].trim() !== '*',
  };
}

function matches(parsed, d) {
  if (!parsed.minute.includes(d.getMinutes())) return false;
  if (!parsed.hour.includes(d.getHours())) return false;
  if (!parsed.month.includes(d.getMonth() + 1)) return false;
  const domOk = parsed.dom.includes(d.getDate());
  const dowOk = parsed.dow.includes(d.getDay());
  // Standard cron: when BOTH day-of-month and day-of-week are restricted, a match
  // on EITHER fires; if only one is restricted, that one must match.
  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true; // both '*'
}

/**
 * Next fire time strictly AFTER `after` (local time), or null if the expression
 * never matches within a year. Minute-resolution (seconds zeroed).
 */
export function nextRun(expr, after = new Date()) {
  let parsed;
  try { parsed = parseCron(expr); } catch { return null; }
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after
  const limit = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (d <= limit) {
    if (matches(parsed, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Validate a raw cron string; returns true/false. */
export function isValidCron(expr) {
  try { parseCron(expr); return true; } catch { return false; }
}

/**
 * Build a cron string + label from a friendly preset.
 *   { every:'minutes'|'hours'|'days'|'weeks', n, hour, minute, weekday }
 */
export function presetToCron(p = {}) {
  const n = Math.max(1, Math.floor(Number(p.n) || 1));
  const minute = Math.min(59, Math.max(0, Math.floor(Number(p.minute) || 0)));
  const hour = Math.min(23, Math.max(0, Math.floor(Number(p.hour) || 0)));
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  switch (p.every) {
    case 'minutes': {
      const step = Math.min(59, n);
      return { cron: `*/${step} * * * *`, label: step === 1 ? 'every minute' : `every ${step} minutes` };
    }
    case 'hours': {
      const step = Math.min(23, n);
      return { cron: `${minute} */${step} * * *`, label: `every ${step === 1 ? 'hour' : step + ' hours'} at :${String(minute).padStart(2, '0')}` };
    }
    case 'days': {
      if (n === 1) return { cron: `${minute} ${hour} * * *`, label: `daily at ${hhmm}` };
      return { cron: `${minute} ${hour} */${n} * *`, label: `every ${n} days at ${hhmm}` };
    }
    case 'weeks': {
      const wd = Math.min(6, Math.max(0, Math.floor(Number(p.weekday) || 0)));
      return { cron: `${minute} ${hour} * * ${wd}`, label: `weekly on ${DOW_NAMES[wd]} at ${hhmm}` };
    }
    default:
      return { cron: `${minute} ${hour} * * *`, label: `daily at ${hhmm}` };
  }
}

// --- manager ----------------------------------------------------------------

const SESSION_MODES = new Set(['fresh', 'persistent']);

export class CronManager {
  constructor(stateDir) {
    this.file = stateDir ? path.join(stateDir, 'cron-jobs.json') : null;
    this.jobs = this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.jobs) ? data.jobs : [];
    } catch { return []; }
  }

  _save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* best-effort persistence */ }
  }

  /** Jobs with a computed nextRun attached (for the UI). */
  list() {
    return this.jobs.map((j) => ({ ...j, nextRun: this._nextRunFor(j) }));
  }

  get(id) { return this.jobs.find((j) => j.id === id) || null; }

  _nextRunFor(job) {
    if (!job.enabled) return null;
    return nextRun(job.schedule?.cron || '', new Date());
  }

  _newId() {
    return 'cron_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  _normalizeSchedule(schedule = {}) {
    if (schedule.source === 'preset' && schedule.preset) {
      const { cron, label } = presetToCron(schedule.preset);
      return { cron, label, source: 'preset', preset: schedule.preset };
    }
    const cron = String(schedule.cron || '').trim();
    if (!isValidCron(cron)) throw new Error(`invalid cron expression: "${cron}"`);
    return { cron, label: schedule.label || cron, source: 'cron' };
  }

  create({ name, prompt, projectId, schedule, sessionMode = 'fresh', enabled = true, profileId = null, model = null, effort = null } = {}) {
    if (!prompt || !String(prompt).trim()) throw new Error('a cron job needs a prompt');
    const sched = this._normalizeSchedule(schedule);
    const job = {
      id: this._newId(),
      name: (name && String(name).trim()) || sched.label,
      prompt: String(prompt),
      projectId: projectId || null,
      schedule: sched,
      sessionMode: SESSION_MODES.has(sessionMode) ? sessionMode : 'fresh',
      // Per-job engine overrides; null = use the broker's active profile/model/effort.
      profileId: profileId || null,
      model: model || null,
      effort: effort || null,
      enabled: enabled !== false,
      createdAt: Date.now(),
      lastRun: null,
      lastStatus: null, // 'running' | 'ok' | 'error'
      lastSessionKey: null,
      lastSessionId: null,
    };
    this.jobs.push(job);
    this._save();
    return job;
  }

  update(id, patch = {}) {
    const job = this.get(id);
    if (!job) return null;
    if (patch.name != null) job.name = String(patch.name);
    if (patch.prompt != null) job.prompt = String(patch.prompt);
    if (patch.projectId !== undefined) job.projectId = patch.projectId || null;
    if (patch.sessionMode && SESSION_MODES.has(patch.sessionMode)) job.sessionMode = patch.sessionMode;
    if (patch.profileId !== undefined) job.profileId = patch.profileId || null;
    if (patch.model !== undefined) job.model = patch.model || null;
    if (patch.effort !== undefined) job.effort = patch.effort || null;
    if (patch.enabled != null) job.enabled = !!patch.enabled;
    if (patch.schedule) job.schedule = this._normalizeSchedule(patch.schedule);
    this._save();
    return job;
  }

  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i === -1) return false;
    this.jobs.splice(i, 1);
    this._save();
    return true;
  }

  toggle(id, enabled) {
    const job = this.get(id);
    if (!job) return null;
    job.enabled = enabled != null ? !!enabled : !job.enabled;
    this._save();
    return job;
  }

  /**
   * Jobs that are due to fire at `now`: enabled, and whose next fire time after
   * their last run (or creation) has arrived. Missed windows while the broker was
   * down fire ONCE (the next computed time from lastRun is in the past), then
   * `noteRun` moves them forward.
   */
  due(now = Date.now()) {
    const out = [];
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (!job.schedule?.cron) continue;
      const base = job.lastRun || job.createdAt || now;
      const next = nextRun(job.schedule.cron, new Date(base));
      if (next != null && next <= now) out.push(job);
    }
    return out;
  }

  /** Record that a job fired (or its outcome). */
  noteRun(id, { status, sessionKey, sessionId, at } = {}) {
    const job = this.get(id);
    if (!job) return null;
    if (at != null || status === 'running') job.lastRun = at || Date.now();
    if (status) job.lastStatus = status;
    if (sessionKey !== undefined) job.lastSessionKey = sessionKey;
    if (sessionId) job.lastSessionId = sessionId;
    this._save();
    return job;
  }
}
