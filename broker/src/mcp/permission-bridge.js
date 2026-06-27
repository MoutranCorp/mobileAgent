import net from 'node:net';

/**
 * PermissionBridge — the broker-side endpoint of the permission MCP server.
 *
 * Hosts a localhost TCP server (ephemeral port). The permission-server.js that
 * Claude Code spawns connects here and forwards each `permission_prompt` call as
 * a newline-delimited JSON request: { id, kind:'permission', tool_name, input }.
 *
 * The bridge invokes `onRequest({ toolName, input })`, which must resolve to a
 * decision: { decision: 'allow'|'deny', updatedInput?, message? }. The result is
 * written back over the socket keyed by the same id.
 *
 * One bridge per claude-code engine instance keeps permission routing isolated.
 */
export class PermissionBridge {
  constructor({ host = '127.0.0.1', token = null, onRequest, onQuestion, log } = {}) {
    this.host = host;
    this.token = token; // shared secret the permission-server must present
    this.onRequest = onRequest || (async () => ({ decision: 'allow' }));
    // Resolve to { text } (the user's answer) or { cancelled: true }.
    this.onQuestion = onQuestion || (async () => ({ cancelled: true }));
    this.log = log || (() => {});
    this.server = null;
    this.port = 0;
    this._sockets = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._onConnection(socket));
      this.server.on('error', reject);
      // port 0 -> OS assigns a free ephemeral port.
      this.server.listen(0, this.host, () => {
        this.port = this.server.address().port;
        this.log(`permission bridge listening on ${this.host}:${this.port}`);
        resolve(this.port);
      });
    });
  }

  _onConnection(socket) {
    this._sockets.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', async (data) => {
      buf += data;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        if (req.kind !== 'permission' && req.kind !== 'question') continue;
        // Reject anything that doesn't present the shared secret — fail closed.
        if (this.token && req.token !== this.token) {
          this.log(`bridge: rejected ${req.kind} request with bad/missing token`);
          const rej = req.kind === 'question' ? { id: req.id, cancelled: true } : { id: req.id, decision: 'deny', message: 'unauthorized' };
          try { socket.write(JSON.stringify(rej) + '\n'); } catch { /* ignore */ }
          continue;
        }
        let out;
        if (req.kind === 'question') {
          let res;
          try { res = await this.onQuestion({ questions: req.questions || [] }); }
          catch (e) { res = { cancelled: true, message: e.message }; }
          out = { id: req.id, text: res.text, cancelled: !!res.cancelled };
        } else {
          let decision;
          try { decision = await this.onRequest({ toolName: req.tool_name, input: req.input }); }
          catch (e) { decision = { decision: 'deny', message: e.message }; }
          out = { id: req.id, decision: decision.decision || 'allow', updatedInput: decision.updatedInput, message: decision.message };
        }
        try {
          socket.write(JSON.stringify(out) + '\n');
        } catch {
          /* socket may have closed */
        }
      }
    });
    socket.on('close', () => this._sockets.delete(socket));
    socket.on('error', () => this._sockets.delete(socket));
  }

  async stop() {
    for (const s of this._sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    this._sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}
