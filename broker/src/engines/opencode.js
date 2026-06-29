import { spawn } from 'node:child_process';
import os from 'node:os';
import { EngineAdapter } from './base.js';
import { EventType, StatusState, CommandType } from '../protocol.js';

/**
 * opencode adapter — the conformance test for the engine abstraction.
 *
 * opencode is a genuinely different harness (not Claude Code). It runs a local
 * server (`opencode serve`) exposing an HTTP API plus an SSE event stream. This
 * adapter spawns that server, opens a session, subscribes to the event stream,
 * and normalizes opencode's events into the SAME canonical events the UI already
 * renders for claude-code. If the UI renders an opencode session identically,
 * the abstraction is proven (Section 3).
 *
 * opencode's exact event field names have drifted across versions, so every
 * mapping here is defensive: unknown shapes are logged, never thrown. The seam
 * is the contract; this file is the only place that knows opencode exists.
 */
export class OpencodeEngine extends EngineAdapter {
  static features = {
    thinking: true,
    models: true,
  };

  constructor(opts) {
    super(opts);
    this.bin = opts.opencodeBin || 'opencode';
    this.proc = null;
    this.baseUrl = null;
    this.opencodeSessionId = null;
    this._abort = null;
    this._toolNames = new Map();
  }

  async _spawn() {
    const port = this.profile?.serverPort || Number(process.env.OPENCODE_PORT) || 4096;
    // If something is already serving on this port it may be a stale opencode (or a
    // foreign server we'd mistakenly drive). Warn so the conflict is diagnosable.
    if (await portInUse(port)) this.log(`[opencode] warning: port ${port} already in use — reusing it; set OPENCODE_PORT to avoid a conflict`);
    const env = { ...process.env, ...this.env };
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
    this.log(`spawning: ${this.bin} ${args.join(' ')}`);
    this.proc = spawn(this.bin, args, {
      cwd: this.cwd || os.homedir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.on('error', (err) => {
      this.emitError(
        `Failed to launch '${this.bin}': ${err.message}. Is opencode installed?`,
        { fatal: true, code: 'spawn_failed' }
      );
    });
    this.proc.stderr.on('data', (c) => this.log(`[opencode] ${c.toString().trimEnd()}`));

    this.baseUrl = `http://127.0.0.1:${port}`;
    await this._waitForServer();
    // Subscribe BEFORE opening the session (and await the connection) so events
    // emitted during session creation aren't missed by a late subscriber.
    await this._subscribeEvents();
    await this._openSession();
  }

  async _waitForServer(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const r = await fetch(`${this.baseUrl}/app`, { method: 'GET' });
        if (r.ok || r.status === 404) return; // server is up
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('opencode server did not start in time');
      await delay(250);
    }
  }

  async _openSession() {
    // Create a session (opencode: POST /session).
    const r = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await safeJson(r);
    this.opencodeSessionId = data?.id || data?.sessionID || data?.session?.id || 'opencode';
    this.setSession(this.opencodeSessionId);
    this.emitCapabilities({
      tools: [],
      model: this.model,
    });
    this.emitStatus(StatusState.IDLE);
  }

  async _subscribeEvents() {
    // SSE stream of all events (opencode: GET /event). Await only the CONNECTION
    // here; consume the stream in the background so the caller can proceed once
    // it's established (without blocking forever on the read loop).
    this._abort = new AbortController();
    const r = await fetch(`${this.baseUrl}/event`, {
      headers: { accept: 'text/event-stream' },
      signal: this._abort.signal,
    });
    if (!r.body) return;
    this._readSse(r.body).catch((e) => { if (e.name !== 'AbortError') this.log(`SSE error: ${e.message}`); });
  }

  async _readSse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this._onSseFrame(frame);
      }
    }
  }

  _onSseFrame(frame) {
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) return;
    let payload;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    this._mapEvent(payload);
  }

  /** Normalize an opencode event into canonical events. */
  _mapEvent(ev) {
    const type = ev.type || ev.event;
    const props = ev.properties || ev.data || ev;
    switch (type) {
      case 'message.part.updated':
      case 'message.part.delta': {
        const part = props.part || props;
        if (part.type === 'text') this.emitText(part.text || part.delta || '');
        else if (part.type === 'reasoning') this.emitThinking(part.text || '');
        else if (part.type === 'tool' || part.type === 'tool-invocation') {
          this._mapToolPart(part);
        }
        break;
      }
      case 'message.updated':
        this.emitStatus(StatusState.THINKING);
        break;
      case 'session.idle':
        this.emitEvent(EventType.RESULT, { subtype: 'success', isError: false });
        this.emitStatus(StatusState.IDLE);
        break;
      case 'session.error':
        this.emitError(props.error?.message || props.message || 'opencode error');
        break;
      default:
        this.log(`unhandled opencode event: ${type}`);
    }
  }

  _mapToolPart(part) {
    const id = part.id || part.toolCallId || part.callID || 'tool';
    const name = part.tool || part.name || 'tool';
    const state = part.state?.status || part.status;
    if (state === 'running' || state === 'pending' || state === 'call') {
      this._toolNames.set(id, name);
      this.emitEvent(EventType.TOOL_CALL, {
        id,
        name,
        input: part.state?.input || part.args || part.input || {},
      });
      this.emitStatus(StatusState.RUNNING, name);
    } else if (state === 'completed' || state === 'result' || state === 'error') {
      this.emitEvent(EventType.TOOL_RESULT, {
        id,
        name: this._toolNames.get(id) || name,
        status: state === 'error' ? 'error' : 'ok',
        output: stringifyOutput(part.state?.output ?? part.result ?? part.output),
      });
    }
  }

  async send(cmd) {
    if (cmd.type !== CommandType.USER_MESSAGE) return;
    this.emitEvent(EventType.USER_ECHO, { text: cmd.text });
    this.emitStatus(StatusState.THINKING);
    try {
      const r = await fetch(`${this.baseUrl}/session/${this.opencodeSessionId}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: cmd.text }],
          model: this.model || undefined,
        }),
      });
      // A non-2xx POST silently looked like success before — surface it.
      if (!r.ok) this.emitError(`opencode send failed: HTTP ${r.status} ${r.statusText || ''}`.trim());
    } catch (e) {
      this.emitError(`opencode send failed: ${e.message}`);
    }
  }

  interrupt() {
    if (!this.baseUrl) return;
    fetch(`${this.baseUrl}/session/${this.opencodeSessionId}/abort`, { method: 'POST' }).catch(
      () => {}
    );
    this.emitStatus(StatusState.IDLE, 'interrupted');
  }

  async _teardown() {
    if (this._abort) {
      try {
        this._abort.abort();
      } catch {
        /* ignore */
      }
    }
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    // Await the process actually exiting (SIGTERM, then SIGKILL after a grace
    // window) — returning before it dies left the port bound, so the next spawn
    // bound the wrong/old server.
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(t); resolve(); } };
      p.once('exit', finish);
      try { p.kill('SIGTERM'); } catch { finish(); }
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } finish(); }, 3000);
    });
  }
}

/** Best-effort check: does something already answer on 127.0.0.1:<port>? */
async function portInUse(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/app`, { method: 'GET', signal: AbortSignal.timeout(500) });
    return true; // got a response -> something is listening
  } catch {
    return false; // refused/timed out -> free (or unreachable)
  }
}

async function safeJson(r) {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

function stringifyOutput(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  return JSON.stringify(o, null, 2);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
