import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EngineAdapter } from './base.js';
import { JsonLineBuffer } from '../jsonl.js';
import { PermissionBridge } from '../mcp/permission-bridge.js';
import { EventType, StatusState, CommandType } from '../protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERMISSION_SERVER = path.join(__dirname, '..', 'mcp', 'permission-server.js');

// Permission modes that gate via our MCP permission-prompt tool (UI approval).
// The other modes (acceptEdits/plan/bypassPermissions/auto/dontAsk) pass straight
// through to the CLI which enforces them itself.
const GATED_MODES = new Set(['default', 'gated']);

/**
 * claude-code adapter — drives the Claude Code CLI in headless stream-json mode.
 *
 *   claude --print --input-format stream-json --output-format stream-json
 *          --verbose --include-partial-messages --replay-user-messages
 *          [--model X] [--resume ID] --permission-mode <mode>
 *          [--permission-prompt-tool mcp__broker__permission_prompt --mcp-config FILE]
 *
 * The CLI authenticates with the user's Max subscription (OAuth) — no API key,
 * no metered billing. All stream-json parsing is confined to THIS file; only
 * canonical events cross the boundary (protocol.js). See docs/claude-code-surface.md.
 */
export class ClaudeCodeEngine extends EngineAdapter {
  constructor(opts) {
    super(opts);
    this.bin = opts.claudeBin || 'claude';
    this.permissionMode = opts.permissionMode || this.profile?.permissionMode || 'default';
    this.effort = opts.effort || null; // low|medium|high|xhigh|max
    this.resumeId = opts.resumeId || null;
    this.proc = null;
    this.buffer = new JsonLineBuffer();
    this.bridge = null;
    this._pendingPermissions = new Map();
    this._permSeq = 0;
    this._ctrlSeq = 0;
    this._toolNames = new Map(); // tool_use_id -> tool name (for result mapping)
    this._mcpConfigFile = null;
    // Per-message streaming state.
    this._blocks = new Map(); // content-block index -> { type, ... }
    this._sawTextDeltas = false;
    this._sawThinkingDeltas = false;
    this._lastParent = null; // parent_tool_use_id for subagent nesting
    this._inputTokens = 0;
    this._windowTokens = windowForModel(this.model);
  }

  async _spawn() {
    const gated = GATED_MODES.has(this.permissionMode);
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages', // real token-by-token deltas
      '--replay-user-messages',
    ];

    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.resumeId) args.push('--resume', this.resumeId);

    if (gated) {
      // Proper approval flow via the permission MCP tool (UI approve/deny).
      this.bridge = new PermissionBridge({
        onRequest: (req) => this._onPermission(req),
        log: this.log,
      });
      const port = await this.bridge.start();
      const mcpConfig = JSON.stringify({
        mcpServers: {
          broker: {
            command: process.execPath, // node
            args: [PERMISSION_SERVER],
            env: { BROKER_IPC_PORT: String(port), BROKER_IPC_HOST: '127.0.0.1' },
          },
        },
      });
      // Write the config to a temp file (every CLI version accepts a file path;
      // inline-JSON support varies) with restrictive perms (it wires the IPC port).
      this._mcpConfigFile = path.join(os.tmpdir(), `agent-broker-mcp-${process.pid}-${port}.json`);
      fs.writeFileSync(this._mcpConfigFile, mcpConfig, { mode: 0o600 });
      args.push(
        '--permission-mode',
        'default',
        '--permission-prompt-tool',
        'mcp__broker__permission_prompt',
        '--mcp-config',
        this._mcpConfigFile
      );
    } else {
      // acceptEdits / plan / bypassPermissions / auto / dontAsk → CLI enforces.
      args.push('--permission-mode', this.permissionMode);
    }

    const env = {
      ...process.env,
      ...this.env,
      WATCHMAN_DISABLE: process.env.WATCHMAN_DISABLE ?? '1',
    };
    // On Termux/proot the CLI runs as root, and `--permission-mode
    // bypassPermissions` refuses to start as root/sudo "for security reasons".
    // IS_SANDBOX=1 tells the CLI it's already in a sandbox, lifting that guard —
    // exactly the on-device case the user wants (the whole proot IS the sandbox).
    if (this.permissionMode === 'bypassPermissions') env.IS_SANDBOX = '1';

    this.log(`spawning: ${this.bin} ${args.join(' ')}`);
    this.proc = spawn(this.bin, args, {
      cwd: this.cwd || os.homedir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.emitEvent(EventType.PERMISSION_MODE, { mode: this.permissionMode });

    this.proc.on('error', (err) => {
      this.emitError(
        `Failed to launch '${this.bin}': ${err.message}. ` +
          `Is Claude Code installed and on PATH? (npm i -g @anthropic-ai/claude-code)`,
        { fatal: true, code: 'spawn_failed' }
      );
    });

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.log(`[claude stderr] ${text.trimEnd()}`);
    });

    this.proc.on('exit', (code, signal) => {
      this.log(`claude exited code=${code} signal=${signal}`);
      this.emit('engine_state', 'stopped');
      this.state = 'stopped';
      this.emitStatus(StatusState.IDLE, `engine exited (${code ?? signal})`);
    });
  }

  _onStdout(chunk) {
    const messages = this.buffer.push(chunk, (err, raw) => {
      this.log(`stream-json parse error: ${err.message} :: ${raw.slice(0, 200)}`);
    });
    for (const msg of messages) this._handleStreamMessage(msg);
  }

  /** Translate one stream-json object into canonical events. */
  _handleStreamMessage(msg) {
    // Track subagent nesting: assistant/user messages carry parent_tool_use_id.
    if (msg.parent_tool_use_id !== undefined) this._lastParent = msg.parent_tool_use_id || null;

    switch (msg.type) {
      case 'system':
        this._handleSystem(msg);
        break;
      case 'assistant':
        this._handleAssistant(msg.message, msg.parent_tool_use_id || this._lastParent);
        this.emitStatus(StatusState.THINKING);
        break;
      case 'user':
        this._handleUser(msg.message, msg.parent_tool_use_id || this._lastParent);
        break;
      case 'stream_event':
        this._handleStreamEvent(msg.event);
        break;
      case 'result':
        this._handleResult(msg);
        break;
      default:
        this.log(`unhandled stream-json type: ${msg.type}`);
    }
  }

  _handleSystem(msg) {
    if (msg.subtype === 'init') {
      if (msg.model) {
        this.model = msg.model;
        this._windowTokens = windowForModel(msg.model);
      }
      this.setSession(msg.session_id);
      if (msg.permissionMode) {
        this.permissionMode = msg.permissionMode;
        this.emitEvent(EventType.PERMISSION_MODE, { mode: msg.permissionMode });
      }
      // Forward the full capability surface so the UI can populate slash-command
      // palettes, agent/MCP lists, the tool inventory, output style, etc.
      this.emitEvent(EventType.CAPABILITIES, {
        slashCommands: msg.slash_commands || [],
        agents: msg.agents || [],
        mcpServers: msg.mcp_servers || [],
        tools: msg.tools || [],
        outputStyle: msg.output_style || null,
        permissionMode: msg.permissionMode || this.permissionMode,
        apiKeySource: msg.apiKeySource || null,
        plugins: msg.plugins || [],
        cwd: msg.cwd || this.cwd,
        model: this.model,
      });
      this.emitStatus(StatusState.IDLE);
    } else if (msg.subtype === 'compact_boundary') {
      const meta = msg.compact_metadata || msg.compactMetadata || {};
      this.emitEvent(EventType.COMPACT, {
        trigger: meta.trigger || 'auto',
        preTokens: meta.pre_tokens ?? meta.preTokens ?? null,
      });
    } else if (msg.subtype === 'api_retry') {
      this.emitEvent(EventType.LOG, {
        level: 'warn',
        message: `API retry ${msg.attempt}/${msg.max_retries}: ${msg.error || ''}`,
      });
    } else {
      this.log(`unhandled system subtype: ${msg.subtype}`);
    }
  }

  /**
   * Terminal assistant message — authoritative for block structure. Text/thinking
   * were already streamed via stream_event, so re-emit them ONLY if no deltas were
   * seen (older CLI without --include-partial-messages). Tool/server/mcp blocks are
   * emitted here (deduped by id) tagged with the subagent parent for nesting.
   */
  _handleAssistant(message, parentToolUseId) {
    if (!message?.content) {
      this._resetMessageDeltaState();
      return;
    }
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: String(message.content) }];
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (!this._sawTextDeltas) this.emitEvent(EventType.ASSISTANT_TEXT, { delta: block.text, parentToolUseId });
          break;
        case 'thinking':
          if (!this._sawThinkingDeltas)
            this.emitEvent(EventType.ASSISTANT_THINKING, {
              delta: block.thinking || block.text || '',
              signature: block.signature,
              parentToolUseId,
            });
          break;
        case 'redacted_thinking':
          this.emitEvent(EventType.ASSISTANT_THINKING, { delta: '[redacted thinking]', parentToolUseId });
          break;
        case 'tool_use':
        case 'server_tool_use':
        case 'mcp_tool_use':
          this._emitToolCall(block, parentToolUseId);
          break;
        case 'web_search_tool_result':
          this.emitEvent(EventType.TOOL_RESULT, {
            id: block.tool_use_id,
            name: 'WebSearch',
            status: block.is_error ? 'error' : 'ok',
            output: normalizeToolOutput(block.content),
            parentToolUseId,
          });
          break;
        default:
          this.log(`unhandled assistant block: ${block.type}`);
      }
    }
    this._resetMessageDeltaState();
  }

  _emitToolCall(block, parentToolUseId) {
    if (this._toolNames.has(block.id)) return; // dedupe
    this._toolNames.set(block.id, block.name);
    this.emitEvent(EventType.TOOL_CALL, {
      id: block.id,
      name: block.name,
      input: block.input || {},
      kind: classifyTool(block.name, block.type),
      parentToolUseId,
    });
    this.emitStatus(StatusState.RUNNING, block.name);
  }

  _handleUser(message, parentToolUseId) {
    if (!message?.content) return;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        this.emitEvent(EventType.TOOL_RESULT, {
          id: block.tool_use_id,
          name: this._toolNames.get(block.tool_use_id),
          status: block.is_error ? 'error' : 'ok',
          output: normalizeToolOutput(block.content),
          parentToolUseId,
        });
      } else if (block.type === 'text') {
        this.emitEvent(EventType.USER_ECHO, { text: block.text });
      }
    }
  }

  /** Partial token streaming (with --include-partial-messages). */
  _handleStreamEvent(ev) {
    if (!ev) return;
    switch (ev.type) {
      case 'message_start':
        this._resetMessageDeltaState();
        this._blocks.clear();
        this._inputTokens = ev.message?.usage?.input_tokens ?? this._inputTokens;
        break;
      case 'content_block_start':
        this._blocks.set(ev.index, { type: ev.content_block?.type });
        break;
      case 'content_block_delta': {
        const d = ev.delta || {};
        if (d.type === 'text_delta') {
          this._sawTextDeltas = true;
          this.emitEvent(EventType.ASSISTANT_TEXT, { delta: d.text, parentToolUseId: this._lastParent });
        } else if (d.type === 'thinking_delta') {
          this._sawThinkingDeltas = true;
          this.emitEvent(EventType.ASSISTANT_THINKING, { delta: d.thinking, parentToolUseId: this._lastParent });
        }
        // input_json_delta / signature_delta / citations_delta accumulate on the
        // block; the authoritative copy arrives in the terminal assistant message.
        break;
      }
      case 'message_delta': {
        const out = ev.usage?.output_tokens;
        if (out != null) {
          this.emitEvent(EventType.CONTEXT, {
            usedTokens: this._inputTokens + out,
            windowTokens: this._windowTokens,
            model: this.model,
          });
        }
        break;
      }
      case 'content_block_stop':
      case 'message_stop':
      case 'ping':
        break;
      case 'error':
        this.emitError(ev.error?.message || 'stream error', { code: ev.error?.type });
        break;
      default:
        break;
    }
  }

  _handleResult(msg) {
    this.emitEvent(EventType.RESULT, {
      subtype: msg.subtype,
      durationMs: msg.duration_ms,
      isError: !!msg.is_error,
      numTurns: msg.num_turns,
    });
    for (const denial of msg.permission_denials || []) {
      this.emitEvent(EventType.PERMISSION_DENIED, {
        toolName: denial.tool_name || denial.toolName || 'tool',
        reason: denial.message || denial.reason || 'denied',
      });
    }
    if (msg.usage) {
      const used = (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0);
      this.emitEvent(EventType.USAGE, {
        inTok: msg.usage.input_tokens,
        outTok: msg.usage.output_tokens,
        cacheReadTok: msg.usage.cache_read_input_tokens,
        cacheWriteTok: msg.usage.cache_creation_input_tokens,
        cost: msg.total_cost_usd ?? null,
      });
      this.emitEvent(EventType.CONTEXT, {
        usedTokens: used,
        windowTokens: this._windowTokens,
        model: this.model,
      });
    }
    if (msg.is_error) {
      const auth = /login|unauthor|expired|oauth|credit|quota/i.test(msg.result || '');
      this.emitError(msg.result || `Turn ended: ${msg.subtype}`, {
        code: auth ? 'auth' : msg.subtype,
        fatal: false,
      });
    }
    this.emitStatus(StatusState.IDLE);
  }

  _resetMessageDeltaState() {
    this._sawTextDeltas = false;
    this._sawThinkingDeltas = false;
  }

  // --- commands ---------------------------------------------------------------

  async send(cmd) {
    if (cmd.type !== CommandType.USER_MESSAGE) return;
    this._writeUser(cmd.text || '', cmd.images);
  }

  _writeUser(text, images) {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      this.emitError('Engine not running; cannot send message.');
      return;
    }
    // Multimodal: prepend base64 image blocks (Claude is vision-capable), then text.
    const content = [];
    for (const img of images || []) {
      if (!img || !img.dataBase64) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mime || 'image/png', data: img.dataBase64 },
      });
    }
    // The API rejects empty text blocks; only include text when present (an
    // image-only message is valid). Fall back to a single space if somehow empty.
    if (text) content.push({ type: 'text', text });
    if (!content.length) content.push({ type: 'text', text: ' ' });
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    this.proc.stdin.write(line + '\n');
    this.emitStatus(StatusState.THINKING);
  }

  interrupt() {
    // Stream-json input mode is long-lived: SIGINT would kill the whole CLI.
    // Send a control_request to cancel only the current turn.
    if (this.proc && this.proc.stdin && this.proc.stdin.writable) {
      const ctrl = JSON.stringify({
        type: 'control_request',
        request_id: `interrupt-${++this._ctrlSeq}`,
        request: { subtype: 'interrupt' },
      });
      try {
        this.proc.stdin.write(ctrl + '\n');
        this.emitStatus(StatusState.IDLE, 'interrupted');
        return;
      } catch {
        /* fall through to SIGINT */
      }
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGINT');
      } catch {
        /* ignore */
      }
    }
    this.emitStatus(StatusState.IDLE, 'interrupted');
  }

  // --- permissions ------------------------------------------------------------

  _onPermission({ toolName, input }) {
    const id = `perm-${++this._permSeq}`;
    return new Promise((resolve) => {
      this._pendingPermissions.set(id, { resolve, input });
      this.emitEvent(EventType.PERMISSION_REQUEST, {
        id,
        action: classifyTool(toolName),
        detail: describeTool(toolName, input),
        toolName,
        input,
      });
      this.emitStatus(StatusState.WAITING, describeTool(toolName, input));
    });
  }

  respondPermission(id, decision, extra = {}) {
    const pending = this._pendingPermissions.get(id);
    if (!pending) return;
    this._pendingPermissions.delete(id);
    this.emitEvent(EventType.PERMISSION_RESOLVED, { id, decision });
    if (decision === 'allow' || decision === 'approve') {
      pending.resolve({ decision: 'allow', updatedInput: extra.updatedInput || pending.input });
    } else {
      pending.resolve({ decision: 'deny', message: extra.reason || 'Denied by user' });
    }
    this.emitStatus(StatusState.THINKING);
  }

  async _teardown() {
    for (const p of this._pendingPermissions.values()) {
      p.resolve({ decision: 'deny', message: 'Engine stopped' });
    }
    this._pendingPermissions.clear();
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      await endProcess(this.proc);
      this.proc = null;
    }
    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
    }
    if (this._mcpConfigFile) {
      try {
        fs.unlinkSync(this._mcpConfigFile);
      } catch {
        /* ignore */
      }
      this._mcpConfigFile = null;
    }
  }
}

function windowForModel(model) {
  if (!model) return 200000;
  return /\[1m\]|1m|-1m/i.test(model) ? 1000000 : 200000;
}

function normalizeToolOutput(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c.text ?? JSON.stringify(c)))
      .join('\n');
  }
  if (typeof content === 'object') return content.text ?? JSON.stringify(content);
  return String(content);
}

function classifyTool(name, blockType) {
  if (blockType === 'server_tool_use' || /^(WebFetch|WebSearch)$/.test(name)) return 'network';
  if (blockType === 'mcp_tool_use' || /^mcp__/.test(name)) return 'mcp';
  if (/^(Agent|Task)$/.test(name)) return 'subagent';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return 'write_file';
  if (/^Bash$/.test(name)) return 'run_command';
  if (/^Skill$/.test(name)) return 'skill';
  return 'tool';
}

function describeTool(name, input) {
  if (!input) return name;
  if (input.command) return `${name}: ${truncate(input.command, 80)}`;
  if (input.file_path) return `${name}: ${input.file_path}`;
  if (input.url) return `${name}: ${input.url}`;
  if (input.pattern) return `${name}: ${input.pattern}`;
  if (input.subagent_type || input.agent_type)
    return `${name}: ${input.subagent_type || input.agent_type}`;
  return name;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function endProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 2500);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}
