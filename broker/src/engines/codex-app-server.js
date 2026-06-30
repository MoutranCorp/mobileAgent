import { spawn } from 'node:child_process';
import os from 'node:os';
import { EngineAdapter } from './base.js';
import { CommandType, EventType, StatusState } from '../protocol.js';

export class CodexAppServerEngine extends EngineAdapter {
  static features = {
    thinking: true,
    permissions: true,
    questions: true,
    resume: true,
    models: true,
    effort: true,
    appServer: true,
  };

  constructor(opts) {
    super(opts);
    this.bin = opts.codexBin || this.profile?.codexBin || 'codex';
    this.args = opts.codexArgs || this.profile?.codexArgs || ['app-server', '--stdio'];
    this.resumeId = opts.resumeId || null;
    this.proc = null;
    this._buf = '';
    this._nextId = 1;
    this._pending = new Map();
    this._pendingApprovals = new Map();
    this._toolNames = new Map();
  }

  async _spawn() {
    const env = { ...process.env, ...this.env };
    this.proc = spawn(this.bin, this.args, {
      cwd: this.cwd || os.homedir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.proc.on('error', (err) => {
      this.emitError(`Failed to launch '${this.bin}': ${err.message}`, {
        fatal: true,
        code: 'spawn_failed',
      });
      this._rejectPending(err);
    });
    this.proc.on('exit', (code, signal) => {
      const reason = signal || (code ?? 'unknown');
      this._rejectPending(new Error(`codex app-server exited (${reason})`));
    });
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => this.log(`[codex-app-server] ${chunk.toString().trimEnd()}`));

    const init = await this._request('initialize', {
      clientInfo: { name: 'mobile-agent-broker', version: '0.1.0' },
    });
    this._notify('initialized', {});

    const thread = this.resumeId
      ? await this._request('thread/resume', this._threadResumeParams())
      : await this._request('thread/start', this._threadStartParams());
    const threadId = pickThreadId(thread) || this.resumeId || init?.threadId || init?.thread?.id;
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    this.setSession(threadId);
    this.emitCapabilities({ tools: [], model: this.model });
    this.emitEvent(EventType.PERMISSION_MODE, { mode: this.permissionMode || 'default' });
    this.emitStatus(StatusState.IDLE);
  }

  async send(cmd) {
    if (cmd.type !== CommandType.USER_MESSAGE) return;
    if (!this.sessionId) throw new Error('codex thread is not initialized');
    this.emitEvent(EventType.USER_ECHO, { text: cmd.text || '' });
    this.emitStatus(StatusState.THINKING);
    try {
      await this._request('turn/start', {
        threadId: this.sessionId,
        input: toUserInput(cmd.text || '', cmd.attachments || cmd.images || []),
        cwd: this.cwd,
        model: this.model || undefined,
        effort: this.effort || undefined,
        approvalPolicy: mapApprovalPolicy(this.permissionMode),
      });
    } catch (e) {
      this.emitError(`codex turn failed: ${e.message}`);
    }
  }

  respondPermission(id, decision, extra = {}) {
    const pending = this._pendingApprovals.get(id);
    if (!pending) return;
    this._pendingApprovals.delete(id);
    const approved = decision === 'allow' || decision === 'approve';
    try {
      this._respond(pending.rpcId, {
        approved,
        decision: approved ? 'approved' : 'denied',
        reason: extra?.reason || null,
      });
    } catch (e) {
      this.log(`[codex-app-server] approval response dropped: ${e.message}`);
    }
    this.emitEvent(EventType.PERMISSION_RESOLVED, {
      id,
      decision: approved ? 'allow' : 'deny',
    });
  }

  interrupt() {
    if (this.sessionId) {
      this._notify('turn/cancel', { threadId: this.sessionId });
    }
    this.emitStatus(StatusState.IDLE, 'interrupted');
  }

  async _teardown() {
    for (const [id, pending] of this._pendingApprovals) {
      this._respond(pending.rpcId, { approved: false, decision: 'denied', reason: 'engine stopped' });
      this.emitEvent(EventType.PERMISSION_RESOLVED, { id, decision: 'deny' });
    }
    this._pendingApprovals.clear();
    this._rejectPending(new Error('engine stopped'));
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.stdin?.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      p.once('exit', finish);
      try { p.kill('SIGTERM'); } catch { finish(); }
      const timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch { /* ignore */ }
        try { p.stdout?.destroy(); p.stderr?.destroy(); p.stdin?.destroy(); } catch { /* ignore */ }
        finish();
      }, 3000);
    });
  }

  _threadStartParams() {
    return {
      cwd: this.cwd,
      model: this.model || undefined,
      effort: this.effort || undefined,
      approvalPolicy: mapApprovalPolicy(this.permissionMode),
    };
  }

  _threadResumeParams() {
    return {
      threadId: this.resumeId,
      cwd: this.cwd,
      model: this.model || undefined,
      effort: this.effort || undefined,
      approvalPolicy: mapApprovalPolicy(this.permissionMode),
    };
  }

  _request(method, params = {}) {
    const id = this._nextId++;
    this._write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
    });
  }

  _notify(method, params = {}) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  _respond(id, result) {
    this._write({ jsonrpc: '2.0', id, result });
  }

  _write(message) {
    if (!this.proc?.stdin?.writable) throw new Error('codex app-server stdin is not writable');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _onStdout(chunk) {
    this._buf += chunk.toString('utf8');
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.log(`[codex-app-server] invalid JSON-RPC line: ${e.message}`);
        continue;
      }
      this._onRpcMessage(msg);
    }
  }

  _onRpcMessage(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && (msg.result !== undefined || msg.error)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || String(msg.error)));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      this._handleServerRequest(msg);
      return;
    }

    if (msg.method) this._mapNotification(msg.method, msg.params || {});
  }

  _handleServerRequest(msg) {
    const method = msg.method;
    const params = msg.params || {};
    if (method.includes('approval') || method.includes('permission') || method.includes('exec')) {
      const id = String(params.id || params.approvalId || msg.id);
      this._pendingApprovals.set(id, { rpcId: msg.id, method, params });
      this.emitEvent(EventType.PERMISSION_REQUEST, {
        id,
        action: params.action || params.kind || method,
        detail: params.detail || params.command || params.description || 'Codex requests approval',
        toolName: params.toolName || params.tool || undefined,
        input: params.input || params,
      });
      this.emitStatus(StatusState.WAITING, 'Waiting for approval');
      return;
    }

    if (method.includes('input') || method.includes('elicitation') || method.includes('question')) {
      this._respond(msg.id, { cancelled: true });
      this.emitEvent(EventType.QUESTION_REQUEST, {
        id: String(params.id || msg.id),
        questions: params.questions || [{ question: params.prompt || params.message || 'Codex requests input' }],
      });
      this.emitEvent(EventType.QUESTION_RESOLVED, { id: String(params.id || msg.id), cancelled: true });
      return;
    }

    this._respond(msg.id, { error: 'unsupported' });
  }

  _mapNotification(method, params) {
    switch (method) {
      case 'thread/started': {
        const threadId = pickThreadId(params);
        if (threadId && threadId !== this.sessionId) this.setSession(threadId);
        break;
      }
      case 'turn/started':
        this.emitStatus(StatusState.RUNNING);
        break;
      case 'item/agentMessage/delta':
      case 'agent_message_delta':
        this.emitText(params.delta ?? params.text ?? '');
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'reasoning_delta':
        this.emitThinking(params.delta ?? params.text ?? '');
        break;
      case 'item/started':
        this._mapItemStarted(params);
        break;
      case 'item/completed':
        this._mapItemCompleted(params);
        break;
      case 'command/exec/outputDelta':
      case 'process/outputDelta':
        this.emitEvent(EventType.TOOL_DELTA, {
          id: params.id || params.itemId || 'codex-output',
          jsonText: params.delta ?? params.text ?? params.output ?? '',
          ephemeral: true,
        });
        break;
      case 'thread/tokenUsage/updated':
        this.emitEvent(EventType.USAGE, normalizeUsage(params));
        break;
      case 'turn/completed':
        if (params.usage) this.emitEvent(EventType.USAGE, normalizeUsage(params.usage));
        this.emitEvent(EventType.RESULT, {
          subtype: params.subtype || (params.error ? 'error' : 'success'),
          isError: !!params.error,
          durationMs: params.durationMs,
        });
        this.emitStatus(StatusState.IDLE);
        break;
      case 'error':
        this.emitError(params.message || params.error || 'codex app-server error');
        break;
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
        this.emitEvent(EventType.TOAST, {
          level: 'warn',
          message: params.message || params.warning || method,
        });
        break;
      default:
        this.log(`[codex-app-server] unhandled notification: ${method}`);
    }
  }

  _mapItemStarted(params) {
    const item = params.item || params;
    const id = item.id || params.id || 'codex-item';
    const name = item.name || item.toolName || item.command || item.type || 'Codex';
    this._toolNames.set(id, name);
    if (isToolish(item)) {
      this.emitEvent(EventType.TOOL_CALL, {
        id,
        name,
        kind: item.kind || item.type,
        input: item.input || item.args || item,
      });
      this.emitStatus(StatusState.RUNNING, name);
    }
  }

  _mapItemCompleted(params) {
    const item = params.item || params;
    const id = item.id || params.id || 'codex-item';
    if (!isToolish(item)) return;
    this.emitEvent(EventType.TOOL_RESULT, {
      id,
      name: this._toolNames.get(id) || item.name || item.type || 'Codex',
      status: item.error || item.status === 'error' ? 'error' : 'ok',
      output: stringify(item.output ?? item.result ?? item.error ?? ''),
    });
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
  }
}

function toUserInput(text, attachments) {
  const input = [{ type: 'text', text, text_elements: [] }];
  for (const a of attachments || []) {
    if (a?.path) input.push({ type: 'localImage', path: a.path });
    else if (a?.url) input.push({ type: 'image', url: a.url });
  }
  return input;
}

function pickThreadId(value) {
  return value?.threadId || value?.id || value?.thread?.id || value?.thread?.threadId || null;
}

function mapApprovalPolicy(mode) {
  if (mode === 'bypassPermissions') return 'never';
  if (mode === 'plan') return 'on-request';
  return 'on-request';
}

function normalizeUsage(value) {
  return {
    inTok: value.inTok ?? value.inputTokens ?? value.input_tokens ?? value.promptTokens ?? null,
    outTok: value.outTok ?? value.outputTokens ?? value.output_tokens ?? value.completionTokens ?? null,
    cacheReadTok: value.cacheReadTok ?? value.cachedInputTokens ?? value.cache_read_tokens ?? undefined,
    cost: value.cost ?? null,
  };
}

function isToolish(item) {
  const type = String(item.type || item.kind || '').toLowerCase();
  return type.includes('tool') || type.includes('command') || type.includes('exec') || item.command || item.toolName;
}

function stringify(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
