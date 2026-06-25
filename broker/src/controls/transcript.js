import fs from 'node:fs';
import path from 'node:path';

/**
 * TranscriptStore — records a curated, replayable copy of the canonical event
 * stream per project, so a conversation survives a page reload, a reconnect, or
 * a broker restart. Streamed assistant text/thinking deltas are COALESCED into
 * one record each so replay rebuilds clean bubbles instead of thousands of
 * fragments.
 *
 * Persisted as newline-delimited JSON at <stateDir>/transcripts/<projectId>.jsonl.
 */
const KEEP = new Set([
  'user_echo', 'assistant_text', 'assistant_thinking', 'tool_call', 'tool_result',
  'permission_resolved', 'permission_denied', 'compact', 'result',
]);
const MAX_RECORDS = 1500;

export class TranscriptStore {
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'transcripts');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    this.projectId = null;
    this._events = [];
    this._pendText = null; // { delta, parentToolUseId }
    this._pendThink = null;
  }

  _file() {
    return this.projectId ? path.join(this.dir, `${safe(this.projectId)}.jsonl`) : null;
  }

  setProject(projectId) {
    if (projectId === this.projectId) return;
    this._flush(false);
    this.projectId = projectId;
    this._events = this._load();
  }

  _load() {
    const f = this._file();
    if (!f || !fs.existsSync(f)) return [];
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-MAX_RECORDS).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  /** Record one canonical event (coalescing text). */
  record(ev) {
    if (!this.projectId || !ev || !ev.type) return;
    if (ev.type === 'assistant_text') {
      if (this._pendText && this._pendText.parentToolUseId === (ev.parentToolUseId || null)) {
        this._pendText.delta += ev.delta || '';
      } else {
        this._flushText();
        this._pendText = { type: 'assistant_text', delta: ev.delta || '', parentToolUseId: ev.parentToolUseId || null };
      }
      return;
    }
    if (ev.type === 'assistant_thinking') {
      if (this._pendThink) this._pendThink.delta += ev.delta || '';
      else this._pendThink = { type: 'assistant_thinking', delta: ev.delta || '', parentToolUseId: ev.parentToolUseId || null };
      return;
    }
    // Any other event commits pending text/thinking first.
    this._flushText();
    this._flushThink();
    if (KEEP.has(ev.type)) this._commit(ev);
  }

  _flushText() {
    if (this._pendText && this._pendText.delta) this._commit(this._pendText);
    this._pendText = null;
  }
  _flushThink() {
    if (this._pendThink && this._pendThink.delta) this._commit(this._pendThink);
    this._pendThink = null;
  }
  _flush() { this._flushText(); this._flushThink(); }

  _commit(rec) {
    this._events.push(rec);
    if (this._events.length > MAX_RECORDS) this._events = this._events.slice(-MAX_RECORDS);
    const f = this._file();
    if (f) {
      try { fs.appendFileSync(f, JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
    }
  }

  /** Replayable array for the current project (commits any pending text first). */
  replay() {
    this._flush();
    return this._events.slice();
  }

  clear() {
    this._events = [];
    this._pendText = null;
    this._pendThink = null;
    const f = this._file();
    if (f) { try { fs.writeFileSync(f, ''); } catch { /* ignore */ } }
  }

  /** Replace the recorded transcript wholesale (used when resuming a session
   *  whose history we parsed from Claude's own .jsonl). */
  replace(events) {
    this._pendText = null;
    this._pendThink = null;
    this._events = (events || []).filter((e) => e && KEEP.has(e.type)).slice(-MAX_RECORDS);
    const f = this._file();
    if (f) {
      try { fs.writeFileSync(f, this._events.map((e) => JSON.stringify(e)).join('\n') + (this._events.length ? '\n' : '')); } catch { /* ignore */ }
    }
    return this._events.slice();
  }

  /**
   * Drop the user_echo with this turnId and everything after it (a revert).
   * Rewrites the .jsonl so a restart/replay doesn't resurrect dropped turns.
   * Returns the number of records removed, or null if the turn isn't in the buffer.
   */
  truncateBefore(turnId) {
    this._flush();
    const idx = this._events.findIndex((e) => e.type === 'user_echo' && e.turnId === turnId);
    if (idx === -1) return null;
    const removed = this._events.length - idx;
    this._events = this._events.slice(0, idx);
    const f = this._file();
    if (f) {
      try { fs.writeFileSync(f, this._events.map((e) => JSON.stringify(e)).join('\n') + (this._events.length ? '\n' : '')); } catch { /* ignore */ }
    }
    return removed;
  }

  /** Search the recorded conversation for text (case-insensitive). */
  search(query, limit = 60) {
    if (!query) return [];
    const q = String(query).toLowerCase();
    const out = [];
    for (const rec of this.replay()) {
      let text = '';
      if (rec.type === 'user_echo') text = rec.text || '';
      else if (rec.type === 'assistant_text' || rec.type === 'assistant_thinking') text = rec.delta || '';
      else if (rec.type === 'tool_call') text = `${rec.name || ''} ${JSON.stringify(rec.input || {})}`;
      else if (rec.type === 'tool_result') text = String(rec.output || '');
      if (!text) continue;
      const i = text.toLowerCase().indexOf(q);
      if (i === -1) continue;
      const start = Math.max(0, i - 30);
      out.push({ type: rec.type, text: (start > 0 ? '…' : '') + text.slice(start, i + query.length + 60).trim() });
      if (out.length >= limit) break;
    }
    return out;
  }
}

function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}
