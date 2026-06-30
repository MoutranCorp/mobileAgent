import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
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
    this._pendingQuestions = new Map();
    this._toolNames = new Map();
    this._tempFiles = new Set();
    this._activeTurnId = null;
  }

  async _spawn() {
    const env = { ...process.env, ...this.env };
    const launch = resolveCodexLaunch(this.bin, this.args, env);
    this.proc = spawn(launch.command, launch.args, {
      cwd: this.cwd || os.homedir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.proc.on('error', (err) => {
      this.emitError(`Failed to launch '${launch.display}': ${err.message}`, {
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
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
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
      const turn = await this._request('turn/start', {
        threadId: this.sessionId,
        input: await this._toUserInput(cmd.text || '', cmd.attachments || cmd.images || []),
        cwd: this.cwd,
        model: this.model || undefined,
        effort: this.effort || undefined,
        approvalPolicy: mapApprovalPolicy(this.permissionMode),
        approvalsReviewer: 'user',
        sandboxPolicy: mapSandboxPolicy(this.permissionMode, this.cwd),
      });
      this._activeTurnId = pickTurnId(turn) || this._activeTurnId;
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
      this._respond(pending.rpcId, approvalResponse(pending, approved, extra));
    } catch (e) {
      this.log(`[codex-app-server] approval response dropped: ${e.message}`);
    }
    this.emitEvent(EventType.PERMISSION_RESOLVED, {
      id,
      decision: approved ? 'allow' : 'deny',
    });
  }

  respondQuestion(id, answers) {
    const pending = this._pendingQuestions.get(id);
    if (!pending) return;
    this._pendingQuestions.delete(id);
    try {
      this._respond(pending.rpcId, questionResponse(pending, answers));
    } catch (e) {
      this.log(`[codex-app-server] question response dropped: ${e.message}`);
    }
    this.emitEvent(EventType.QUESTION_RESOLVED, { id });
    this.emitStatus(StatusState.THINKING);
  }

  interrupt() {
    if (this.sessionId && this._activeTurnId) {
      this._request('turn/interrupt', { threadId: this.sessionId, turnId: this._activeTurnId })
        .catch((e) => this.log(`[codex-app-server] interrupt failed: ${e.message}`));
    }
    this.emitStatus(StatusState.IDLE, 'interrupted');
  }

  async _teardown() {
    for (const [id, pending] of this._pendingApprovals) {
      try { this._respond(pending.rpcId, approvalResponse(pending, false, { reason: 'engine stopped' })); }
      catch { /* ignore */ }
      this.emitEvent(EventType.PERMISSION_RESOLVED, { id, decision: 'deny' });
    }
    this._pendingApprovals.clear();
    for (const [id, pending] of this._pendingQuestions) {
      try { this._respond(pending.rpcId, questionResponse(pending, null)); }
      catch { /* ignore */ }
      this.emitEvent(EventType.QUESTION_RESOLVED, { id, cancelled: true });
    }
    this._pendingQuestions.clear();
    this._rejectPending(new Error('engine stopped'));
    this._cleanupTempFiles();
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
      approvalPolicy: mapApprovalPolicy(this.permissionMode),
      approvalsReviewer: 'user',
      sandbox: mapSandboxMode(this.permissionMode),
    };
  }

  _threadResumeParams() {
    return {
      threadId: this.resumeId,
      cwd: this.cwd,
      model: this.model || undefined,
      approvalPolicy: mapApprovalPolicy(this.permissionMode),
      approvalsReviewer: 'user',
      sandbox: mapSandboxMode(this.permissionMode),
    };
  }

  _request(method, params = {}) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  _notify(method, params = {}) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  _respond(id, result) {
    this._write({ jsonrpc: '2.0', id, result });
  }

  _respondError(id, message, code = -32601) {
    this._write({ jsonrpc: '2.0', id, error: { code, message } });
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
    const kind = approvalKind(method);
    if (kind) {
      const id = approvalId(kind, params, msg.id);
      this._pendingApprovals.set(id, { rpcId: msg.id, method, params, kind });
      this.emitEvent(EventType.PERMISSION_REQUEST, permissionEvent(kind, id, method, params));
      this.emitStatus(StatusState.WAITING, 'Waiting for approval');
      return;
    }

    const questionKind = questionKindFor(method);
    if (questionKind) {
      const id = String(params.itemId || params.elicitationId || msg.id);
      this._pendingQuestions.set(id, { rpcId: msg.id, method, params, kind: questionKind });
      this.emitEvent(EventType.QUESTION_REQUEST, {
        id,
        questions: normalizeQuestions(questionKind, params),
      });
      this.emitStatus(StatusState.WAITING, 'Waiting for your answer');
      return;
    }

    this._respondError(msg.id, `Unsupported Codex app-server request: ${method}`);
  }

  _mapNotification(method, params) {
    switch (method) {
      case 'thread/started': {
        const threadId = pickThreadId(params);
        if (threadId && threadId !== this.sessionId) this.setSession(threadId);
        break;
      }
      case 'turn/started':
        this._activeTurnId = pickTurnId(params) || this._activeTurnId;
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
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.emitEvent(EventType.TOOL_DELTA, {
          id: params.id || params.itemId || 'codex-output',
          jsonText: params.delta ?? params.text ?? params.output ?? '',
          ephemeral: true,
        });
        break;
      case 'item/fileChange/patchUpdated':
        this.emitEvent(EventType.TOOL_DELTA, {
          id: params.itemId || params.id || 'codex-file-change',
          jsonText: stringify(params.changes ?? params),
          ephemeral: true,
        });
        break;
      case 'thread/tokenUsage/updated':
        this.emitEvent(EventType.USAGE, normalizeUsage(params));
        break;
      case 'turn/completed':
        this._activeTurnId = null;
        if (params.usage) this.emitEvent(EventType.USAGE, normalizeUsage(params.usage));
        this.emitEvent(EventType.RESULT, {
          subtype: params.subtype || (params.error ? 'error' : 'success'),
          isError: !!params.error,
          durationMs: params.durationMs,
        });
        this.emitStatus(StatusState.IDLE);
        this._cleanupTempFiles();
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

  async _toUserInput(text, attachments) {
    const input = [{ type: 'text', text, text_elements: [] }];
    for (const a of attachments || []) {
      if (!a) continue;
      if (a.path) {
        input.push({ type: 'localImage', path: a.path });
      } else if (a.url) {
        input.push({ type: 'image', url: a.url });
      } else if (a.dataBase64) {
        const name = safeName(a.name || 'attachment');
        const mime = String(a.mime || 'application/octet-stream');
        const bytes = Buffer.from(a.dataBase64, 'base64');
        const tempPath = await this._writeTempAttachment(name, mime, bytes);
        if (mime.startsWith('image/')) {
          input.push({ type: 'localImage', path: tempPath });
        } else if (isTextLike(mime, name)) {
          const body = bytes.toString('utf8');
          input.push({
            type: 'text',
            text: `Attached file ${name} (${mime}) saved at ${tempPath}:\n\n${truncateText(body)}`,
            text_elements: [],
          });
        } else {
          input.push({
            type: 'text',
            text: `Attached file ${name} (${mime}, ${bytes.length} bytes) saved at ${tempPath}. Codex app-server accepts images directly; use the path if you need to inspect this binary file.`,
            text_elements: [],
          });
        }
      }
    }
    return input;
  }

  async _writeTempAttachment(name, mime, bytes) {
    const dir = path.join(os.tmpdir(), 'mobile-agent-codex-attachments');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${crypto.randomUUID()}${extensionFor(name, mime)}`);
    await fs.promises.writeFile(file, bytes);
    this._tempFiles.add(file);
    return file;
  }

  _cleanupTempFiles() {
    for (const file of this._tempFiles) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
    this._tempFiles.clear();
  }
}

function pickThreadId(value) {
  return value?.threadId || value?.id || value?.thread?.id || value?.thread?.threadId || null;
}

function pickTurnId(value) {
  return value?.turnId || value?.id || value?.turn?.id || null;
}

function mapApprovalPolicy(mode) {
  if (mode === 'bypassPermissions') return 'never';
  if (mode === 'plan') return 'on-request';
  return 'on-request';
}

function mapSandboxMode(mode) {
  if (mode === 'bypassPermissions') return 'danger-full-access';
  if (mode === 'plan') return 'read-only';
  return 'workspace-write';
}

function mapSandboxPolicy(mode, cwd) {
  if (mode === 'bypassPermissions') return { type: 'dangerFullAccess' };
  if (mode === 'plan') return { type: 'readOnly', networkAccess: true };
  return {
    type: 'workspaceWrite',
    writableRoots: cwd ? [cwd] : [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
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

function approvalKind(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval': return 'commandExecution';
    case 'item/fileChange/requestApproval': return 'fileChange';
    case 'item/permissions/requestApproval': return 'permissions';
    case 'execCommandApproval': return 'legacyExec';
    case 'applyPatchApproval': return 'legacyPatch';
    default: {
      const lower = String(method || '').toLowerCase();
      if (lower.includes('approval') || lower.includes('permission') || lower.includes('exec')) return 'legacy';
      return null;
    }
  }
}

function approvalId(kind, params, rpcId) {
  return String(
    params.approvalId ||
    params.itemId ||
    params.callId ||
    params.id ||
    `${kind}-${rpcId}`
  );
}

function permissionEvent(kind, id, method, params) {
  if (kind === 'commandExecution' || kind === 'legacyExec') {
    const command = Array.isArray(params.command) ? params.command.join(' ') : params.command;
    return {
      id,
      action: 'command',
      detail: params.reason || command || 'Codex wants to run a command',
      toolName: 'Shell',
      input: { command, cwd: params.cwd, reason: params.reason, actions: params.commandActions || params.parsedCmd },
    };
  }
  if (kind === 'fileChange' || kind === 'legacyPatch') {
    return {
      id,
      action: 'file_change',
      detail: params.reason || params.grantRoot || 'Codex wants to change files',
      toolName: 'File change',
      input: params.fileChanges || params.changes || params,
    };
  }
  if (kind === 'permissions') {
    return {
      id,
      action: 'permissions',
      detail: params.reason || 'Codex requests additional permissions',
      toolName: 'Permissions',
      input: params.permissions || params,
    };
  }
  return {
    id,
    action: params.action || params.kind || method,
    detail: params.detail || params.command || params.description || 'Codex requests approval',
    toolName: params.toolName || params.tool || undefined,
    input: params.input || params,
  };
}

function approvalResponse(pending, approved, extra = {}) {
  if (pending.kind === 'commandExecution') return { decision: approved ? 'accept' : 'decline' };
  if (pending.kind === 'fileChange') return { decision: approved ? 'accept' : 'decline' };
  if (pending.kind === 'permissions') {
    return {
      permissions: approved ? normalizeGrantedPermissions(pending.params.permissions) : {},
      scope: extra?.scope === 'session' ? 'session' : 'turn',
      strictAutoReview: false,
    };
  }
  if (pending.kind === 'legacyExec' || pending.kind === 'legacyPatch' || pending.kind === 'legacy') {
    return { decision: approved ? 'approved' : 'denied' };
  }
  return { decision: approved ? 'accept' : 'decline' };
}

function normalizeGrantedPermissions(requested) {
  const out = {};
  if (requested?.network) out.network = requested.network;
  if (requested?.fileSystem) out.fileSystem = requested.fileSystem;
  return out;
}

function questionKindFor(method) {
  if (method === 'item/tool/requestUserInput') return 'toolUserInput';
  if (method === 'mcpServer/elicitation/request') return 'mcpElicitation';
  const lower = String(method || '').toLowerCase();
  if (lower.includes('requestuserinput') || lower.includes('elicitation') || lower.includes('question')) return 'genericQuestion';
  return null;
}

function normalizeQuestions(kind, params) {
  if (kind === 'toolUserInput' && Array.isArray(params.questions)) {
    return params.questions.map((q) => ({
      header: q.header || '',
      question: q.question || 'Codex requests input',
      multiSelect: false,
      options: Array.isArray(q.options) ? q.options.map((o) => ({ label: o.label, description: o.description })) : [],
    }));
  }
  if (kind === 'mcpElicitation') {
    return [{
      header: params.serverName || 'MCP',
      question: params.url ? `${params.message || 'Codex requests input'}\n${params.url}` : (params.message || 'Codex requests input'),
      multiSelect: false,
      options: [
        { label: 'Accept', description: 'Send this answer back to the MCP server' },
        { label: 'Decline', description: 'Decline the request' },
        { label: 'Cancel', description: 'Cancel without answering' },
      ],
    }];
  }
  return params.questions || [{ question: params.prompt || params.message || 'Codex requests input' }];
}

function questionResponse(pending, answers) {
  if (!answers) return cancelQuestionResponse(pending);
  if (pending.kind === 'toolUserInput') {
    const response = { answers: {} };
    const questions = pending.params.questions || [];
    questions.forEach((q, i) => {
      response.answers[q.id || String(i)] = { answers: answerValues(answers[i]) };
    });
    return response;
  }
  if (pending.kind === 'mcpElicitation') {
    const values = answerValues(answers[0]);
    const first = String(values[0] || '').toLowerCase();
    if (first === 'decline') return { action: 'decline', content: null, _meta: null };
    if (first === 'cancel') return { action: 'cancel', content: null, _meta: null };
    return { action: 'accept', content: answersToObject(answers), _meta: null };
  }
  return { answers };
}

function cancelQuestionResponse(pending) {
  if (pending.kind === 'toolUserInput') return { answers: {} };
  if (pending.kind === 'mcpElicitation') return { action: 'cancel', content: null, _meta: null };
  return { cancelled: true };
}

function answerValues(answer) {
  if (!answer) return [];
  return [...(answer.selected || []), answer.custom || ''].map((s) => String(s).trim()).filter(Boolean);
}

function answersToObject(answers) {
  const out = {};
  for (const a of answers || []) {
    const key = a.header || a.question || `answer_${Object.keys(out).length + 1}`;
    out[key] = answerValues(a);
  }
  return out;
}

function isTextLike(mime, name) {
  return mime.startsWith('text/') ||
    /json|xml|yaml|csv|javascript|typescript|markdown|x-sh|shell|toml|ini/.test(mime) ||
    /\.(txt|md|json|js|ts|tsx|jsx|css|html|xml|yml|yaml|csv|sh|ps1|py|java|kt|rs|go|toml|ini)$/i.test(name);
}

function truncateText(text, limit = 200_000) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

function safeName(name) {
  return String(name).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 120) || 'attachment';
}

function extensionFor(name, mime) {
  const ext = path.extname(name);
  if (ext) return ext;
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'application/pdf') return '.pdf';
  if (mime.startsWith('text/')) return '.txt';
  return '.bin';
}

export function resolveCodexLaunch(bin = 'codex', args = ['app-server', '--stdio'], env = process.env, platform = process.platform) {
  const cleanArgs = Array.isArray(args) ? args : ['app-server', '--stdio'];
  if (platform === 'win32' && isCodexCommand(bin)) {
    const js = resolveWindowsCodexJs(bin, env);
    if (js) return { command: process.execPath, args: [js, ...cleanArgs], display: `node ${js}` };
  }
  return { command: bin, args: cleanArgs, display: [bin, ...cleanArgs].join(' ') };
}

function isCodexCommand(bin) {
  const base = path.basename(String(bin || '')).toLowerCase().replace(/\.(cmd|ps1|exe|bat)$/i, '');
  return base === 'codex';
}

function resolveWindowsCodexJs(bin, env) {
  const direct = candidateCodexJs(bin);
  if (direct) return direct;
  const appData = env.APPDATA || env.AppData;
  if (appData) {
    const p = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (exists(p)) return p;
  }
  const found = spawnSync('where.exe', [bin], { encoding: 'utf8', windowsHide: true });
  if (found.status === 0) {
    for (const line of found.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const p = candidateCodexJs(line);
      if (p) return p;
    }
  }
  return null;
}

function candidateCodexJs(binOrShim) {
  if (!binOrShim) return null;
  if (/codex\.js$/i.test(binOrShim) && exists(binOrShim)) return binOrShim;
  if (!/[\\/]/.test(binOrShim)) return null;
  const dir = path.dirname(binOrShim);
  const p = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return exists(p) ? p : null;
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}
