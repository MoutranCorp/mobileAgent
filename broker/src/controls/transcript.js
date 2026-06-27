import fs from 'node:fs';
import path from 'node:path';

/**
 * TranscriptStore — a curated, replayable copy of the canonical event stream,
 * one buffer PER SESSION (project key), so concurrent background sessions each
 * record into their own `transcripts/<key>.jsonl` and never bleed into the
 * foreground. record() routes by the event's `sessionKey`; replay/search/clear/
 * replace/truncate operate on the currently-active (viewed) session.
 *
 * Streamed assistant text/thinking deltas are COALESCED per buffer so replay
 * rebuilds clean bubbles instead of thousands of fragments.
 */
const KEEP = new Set([
  'user_echo', 'assistant_text', 'assistant_thinking', 'tool_call', 'tool_result',
  'permission_resolved', 'permission_denied', 'compact', 'result',
  'file_widget', // inline file viewers (e.g. screenshots) persist across reload
  'apks', // build-artifact widgets persist for the session that produced them
]);
const MAX_RECORDS = 1500;

export class TranscriptStore {
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'transcripts');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    this.activeKey = null;
    this.buffers = new Map(); // key -> { events, pendText, pendThink }
  }

  _file(key) { return key != null ? path.join(this.dir, `${safe(key)}.jsonl`) : null; }

  _load(key) {
    const f = this._file(key);
    if (!f || !fs.existsSync(f)) return [];
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      // Parse per-line and skip corrupt records — a process killed mid-append leaves
      // a partial last line that must not discard the whole transcript on reload.
      const out = [];
      for (const l of lines.slice(-MAX_RECORDS)) {
        try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
      }
      return out;
    } catch { return []; }
  }

  _bufFor(key) {
    if (key == null) key = this.activeKey;
    if (key == null) return null;
    let b = this.buffers.get(key);
    if (!b) { b = { key, events: this._load(key), pendText: null, pendThink: null }; this.buffers.set(key, b); }
    return b;
  }

  /** Set which session the UI is viewing (its buffer is what replay() returns). */
  setProject(key) {
    if (key === this.activeKey) return;
    const cur = this.activeKey != null ? this.buffers.get(this.activeKey) : null;
    if (cur) this._flush(cur);
    this.activeKey = key;
    this._bufFor(key); // lazy-load
  }

  /** Record one canonical event into ITS session's buffer (coalescing text). */
  record(ev) {
    if (!ev || !ev.type) return;
    const key = ev.sessionKey != null ? ev.sessionKey : this.activeKey;
    const b = this._bufFor(key);
    if (!b) return;
    if (ev.type === 'assistant_text') {
      // A reply run ends any open thinking run — flush it FIRST so replay keeps the
      // real think→text→think interleave order (else all thinking sorts before all
      // text and reappears in the wrong place after a reload).
      this._flushThink(b);
      if (b.pendText && b.pendText.parentToolUseId === (ev.parentToolUseId || null)) {
        b.pendText.delta += ev.delta || '';
      } else {
        this._flushText(b);
        // Keep the FIRST delta's ts so replay stamps the bubble with the reply's
        // own start time (not the preceding event's). Coalesced deltas share it.
        b.pendText = { type: 'assistant_text', delta: ev.delta || '', parentToolUseId: ev.parentToolUseId || null, ts: ev.ts };
      }
      return;
    }
    if (ev.type === 'assistant_thinking') {
      // Symmetric to text: a new thinking run ends any open reply run, so each
      // contiguous run commits as its own record in chronological order.
      this._flushText(b);
      if (b.pendThink && b.pendThink.parentToolUseId === (ev.parentToolUseId || null)) {
        b.pendThink.delta += ev.delta || '';
      } else {
        this._flushThink(b);
        b.pendThink = { type: 'assistant_thinking', delta: ev.delta || '', parentToolUseId: ev.parentToolUseId || null, ts: ev.ts };
      }
      return;
    }
    // Transient bookkeeping events (status/context/usage/session_meta/permission_*
    // request) are NOT recorded and must NOT flush the streaming buffers — the real
    // engine interleaves them between thinking/text deltas, and flushing here would
    // shatter one reasoning/reply run into many tiny records (the mock never emits
    // them mid-stream, so this only bites against the real CLI). Only a KEPT event is
    // a genuine run boundary.
    if (!KEEP.has(ev.type)) return;
    this._flushText(b);
    this._flushThink(b);
    this._commit(b, ev);
  }

  _flushText(b) { if (b.pendText && b.pendText.delta) this._commit(b, b.pendText); b.pendText = null; }
  _flushThink(b) { if (b.pendThink && b.pendThink.delta) this._commit(b, b.pendThink); b.pendThink = null; }
  _flush(b) { this._flushText(b); this._flushThink(b); }

  _commit(b, rec) {
    b.events.push(rec);
    if (b.events.length > MAX_RECORDS) b.events = b.events.slice(-MAX_RECORDS);
    const f = this._file(b.key);
    if (f) { try { fs.appendFileSync(f, JSON.stringify(rec) + '\n'); } catch { /* ignore */ } }
  }

  /** Replayable array for the ACTIVE session (commits pending text first). */
  replay() {
    const b = this._bufFor(this.activeKey);
    if (!b) return [];
    this._flush(b);
    return b.events.slice();
  }

  /** Commit pending streamed text/thinking for EVERY session buffer to disk (not
   *  just the active one) — used on shutdown so a background session's in-flight
   *  reply isn't lost. */
  flushAll() { for (const b of this.buffers.values()) this._flush(b); }

  clear() {
    const b = this._bufFor(this.activeKey);
    if (!b) return;
    b.events = []; b.pendText = null; b.pendThink = null;
    const f = this._file(b.key);
    if (f) { try { fs.writeFileSync(f, ''); } catch { /* ignore */ } }
  }

  /** Replace the active session's transcript wholesale (resume from .jsonl). */
  replace(events) {
    const b = this._bufFor(this.activeKey);
    if (!b) return [];
    b.pendText = null; b.pendThink = null;
    b.events = (events || []).filter((e) => e && KEEP.has(e.type)).slice(-MAX_RECORDS);
    this._rewrite(b);
    return b.events.slice();
  }

  /** Drop the active session's user_echo with this turnId and everything after
   *  (a revert). Rewrites the .jsonl. Returns records removed, or null if absent. */
  truncateBefore(turnId) {
    const b = this._bufFor(this.activeKey);
    if (!b) return null;
    this._flush(b);
    const idx = b.events.findIndex((e) => e.type === 'user_echo' && e.turnId === turnId);
    if (idx === -1) return null;
    const removed = b.events.length - idx;
    b.events = b.events.slice(0, idx);
    this._rewrite(b);
    return removed;
  }

  _rewrite(b) {
    const f = this._file(b.key);
    if (f) { try { fs.writeFileSync(f, b.events.map((e) => JSON.stringify(e)).join('\n') + (b.events.length ? '\n' : '')); } catch { /* ignore */ } }
  }

  /** Search the active session's conversation (case-insensitive). */
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

function safe(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }
