import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EngineAdapter } from './base.js';
import { JsonLineBuffer } from '../jsonl.js';
import { PermissionBridge } from '../mcp/permission-bridge.js';
import { EventType, StatusState, CommandType } from '../protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERMISSION_SERVER = path.join(__dirname, '..', 'mcp', 'permission-server.js');

// How long an approval may wait on the UI before we fail-closed (auto-deny) so a
// closed tab / dropped socket can't block the CLI's permission-server forever.
const PERMISSION_TIMEOUT_MS = Number(process.env.BROKER_PERMISSION_TIMEOUT_MS) || 180000;

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
    this.ultracode = opts.ultracode || false; // opus/fable orchestration mode (xhigh + setting)
    this.resumeId = opts.resumeId || null;
    this.proc = null;
    this.buffer = new JsonLineBuffer();
    this.bridge = null;
    this._pendingPermissions = new Map();
    this._permSeq = 0;
    this._pendingQuestions = new Map(); // bridge-req-id -> { resolve }
    this._ctrlSeq = 0;
    this._toolNames = new Map(); // tool_use_id -> tool name (for result mapping)
    this._startedTools = new Set(); // tool_use_ids already surfaced live (block-start) this turn
    this._mcpConfigFile = null;
    // Capability warmup: the CLI now defers `system/init` (which carries
    // slash_commands/agents/tools) until it receives the FIRST user message, so a
    // freshly-spawned idle session has no slash-command palette. When enabled we
    // run a throwaway init probe to surface those before the user types. Disabled
    // for detached/background sessions (cron) — they send a prompt immediately.
    this.warmCaps = opts.warmCapabilities !== false;
    this._sawInit = false; // real init arrived → suppress a late probe result
    this._probeProc = null;
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
    // Ultracode = xhigh effort + autonomous workflow orchestration (Opus/Fable).
    // Additive --settings; a CLI that doesn't know the key ignores it (degrades to xhigh).
    if (this.ultracode) args.push('--settings', '{"ultracode":true}');
    if (this.resumeId) args.push('--resume', this.resumeId);

    // Always run the broker MCP server: it exposes `ask_user_question`
    // (AskUserQuestion) so the agent can ask the user structured questions — the
    // headless CLI does NOT expose the built-in one — in EVERY permission mode. In
    // gated mode it ALSO serves as the permission-prompt tool. A per-engine shared
    // secret authenticates the permission-server to the bridge, so another local
    // process can't inject decisions/answers or read pending inputs over loopback
    // (matters on shared-localhost Android).
    const ipcToken = crypto.randomBytes(16).toString('hex');
    this.bridge = new PermissionBridge({
      token: ipcToken,
      onRequest: (req) => this._onPermission(req),
      onQuestion: (req) => this._onQuestion(req),
      log: this.log,
    });
    const port = await this.bridge.start();
    const mcpConfig = JSON.stringify({
      mcpServers: {
        broker: {
          command: process.execPath, // node
          args: [PERMISSION_SERVER],
          env: { BROKER_IPC_PORT: String(port), BROKER_IPC_HOST: '127.0.0.1', BROKER_IPC_TOKEN: ipcToken },
        },
      },
    });
    // Write the config to a temp file (every CLI version accepts a file path;
    // inline-JSON support varies) with restrictive perms (it wires the IPC port).
    this._mcpConfigFile = path.join(os.tmpdir(), `agent-broker-mcp-${process.pid}-${port}.json`);
    fs.writeFileSync(this._mcpConfigFile, mcpConfig, { mode: 0o600 });
    args.push('--mcp-config', this._mcpConfigFile);
    if (gated) {
      // Proper approval flow via the permission MCP tool (UI approve/deny).
      args.push('--permission-mode', 'default', '--permission-prompt-tool', 'mcp__broker__permission_prompt');
    } else {
      // acceptEdits / plan / bypassPermissions / auto / dontAsk → CLI enforces.
      args.push('--permission-mode', this.permissionMode);
    }

    const env = {
      ...process.env,
      ...this.env,
      WATCHMAN_DISABLE: process.env.WATCHMAN_DISABLE ?? '1',
    };
    // Credentials file (written by `claude setup-token` / the native sign-in) is the
    // source of truth on the default endpoint. A leftover/empty CLAUDE_CODE_OAUTH_TOKEN
    // env var would OVERRIDE it and get sent as an invalid bearer token → 401
    // "Invalid bearer token". So when creds exist and we're not on an alt endpoint,
    // drop the env token and let the CLI read the file.
    try {
      const credsFile = path.join(env.HOME || os.homedir(), '.claude', '.credentials.json');
      if (!env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_AUTH_TOKEN && fs.existsSync(credsFile)) {
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        delete env.ANTHROPIC_API_KEY;
      }
    } catch { /* best-effort */ }
    // On Termux/proot the CLI runs as root, and `--permission-mode
    // bypassPermissions` refuses to start as root/sudo "for security reasons".
    // IS_SANDBOX=1 tells the CLI it's already in a sandbox, lifting that guard —
    // exactly the on-device case the user wants (the whole proot IS the sandbox).
    if (this.permissionMode === 'bypassPermissions') env.IS_SANDBOX = '1';

    this.log(`spawning: ${this.bin} ${args.join(' ')}`);
    this._spawnEnv = env; // reused by the capability-warmup probe
    this.proc = spawn(this.bin, args, {
      cwd: this.cwd || os.homedir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.emitEvent(EventType.PERMISSION_MODE, { mode: this.permissionMode });
    // Fire-and-forget: surface slash-commands/agents before the first message
    // (the CLI no longer emits init until then). No-op if already inited.
    if (this.warmCaps) this._warmCapabilities();

    this.proc.on('error', (err) => {
      this.emitError(
        `Failed to launch '${this.bin}': ${err.message}. ` +
          `Is Claude Code installed and on PATH? (npm i -g @anthropic-ai/claude-code)`,
        { fatal: true, code: 'spawn_failed' }
      );
    });

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    // Process any final line that lacked a trailing newline (legal in stream-json).
    this.proc.stdout.on('end', () => {
      const tail = this.buffer.flush((err, raw) => this.log(`stream-json parse error (flush): ${err.message} :: ${raw.slice(0, 200)}`));
      for (const msg of tail) this._handleStreamMessage(msg);
    });
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.log(`[claude stderr] ${text.trimEnd()}`);
    });

    this.proc.on('exit', (code, signal) => {
      this.log(`claude exited code=${code} signal=${signal}`);
      // A crash/exit bypasses _teardown — flush any in-flight approvals so the
      // permission-server (and the UI) never hang waiting on a dead engine.
      this._failPendingPermissions(`engine exited (${code ?? signal})`);
      this._failPendingQuestions(`engine exited (${code ?? signal})`);
      try { this.bridge?.stop(); } catch { /* ignore */ }
      this.emit('engine_state', 'stopped');
      this.state = 'stopped';
      this.emitStatus(StatusState.IDLE, `engine exited (${code ?? signal})`);
    });
  }

  /** Resolve every pending approval as a denial (engine gone / timed out) so no
   *  permission Promise can hang the CLI's permission-server forever. */
  _failPendingPermissions(reason) {
    for (const [id, p] of this._pendingPermissions) {
      if (p.timer) clearTimeout(p.timer);
      try { this.emitEvent(EventType.PERMISSION_RESOLVED, { id, decision: 'deny' }); } catch { /* ignore */ }
      p.resolve({ decision: 'deny', message: reason });
    }
    this._pendingPermissions.clear();
  }

  /**
   * Capability-warmup probe. The CLI defers `system/init` (which carries
   * slash_commands / agents / tools / output_style / plugins) until it reads the
   * FIRST user message, so an idle freshly-spawned session would have an empty
   * slash-command palette — the "typing / shows nothing" regression. Spawn a
   * short-lived claude, send a trivial message to trigger init, emit the
   * capability surface, then kill it the instant init arrives — which is BEFORE
   * the API request (verified: init precedes `status:requesting`), so it costs no
   * turn and no tokens. Self-cancels if the real engine inits first.
   */
  async _warmCapabilities() {
    if (this._sawInit) return;
    let probe;
    try {
      const args = ['--print', '--input-format', 'stream-json', '--output-format',
        'stream-json', '--verbose', '--permission-mode', this.permissionMode];
      if (this.model) args.push('--model', this.model);
      probe = spawn(this.bin, args, {
        cwd: this.cwd || os.homedir(),
        env: this._spawnEnv || process.env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch { return; }
    this._probeProc = probe;
    const buf = new JsonLineBuffer();
    const finish = () => {
      clearTimeout(timer);
      try { probe.kill('SIGKILL'); } catch { /* ignore */ }
      if (this._probeProc === probe) this._probeProc = null;
    };
    const timer = setTimeout(finish, 15000);
    probe.on('error', finish);
    probe.on('exit', () => { if (this._probeProc === probe) this._probeProc = null; });
    probe.stdout.on('data', (chunk) => {
      let msgs; try { msgs = buf.push(chunk, () => {}); } catch { return; }
      for (const msg of msgs) {
        if (msg?.type === 'system' && msg.subtype === 'init') {
          if (!this._sawInit) {
            this.emitEvent(EventType.CAPABILITIES, {
              slashCommands: msg.slash_commands || [],
              agents: msg.agents || [],
              mcpServers: msg.mcp_servers || [],
              tools: msg.tools || [],
              outputStyle: msg.output_style || null,
              permissionMode: this.permissionMode,
              apiKeySource: msg.apiKeySource || null,
              plugins: msg.plugins || [],
              cwd: msg.cwd || this.cwd,
              model: this.model || msg.model,
              warm: true, // provisional; the real init refines it after the first turn
            });
          }
          finish();
          return;
        }
      }
    });
    // Trigger init with a trivial message — killed at init, before it's processed.
    try { probe.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'); } catch { /* ignore */ }
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
      case 'assistant': {
        this._handleAssistant(msg.message, msg.parent_tool_use_id || this._lastParent);
        // Only fall back to THINKING for a message that actually had text/thinking —
        // a tool-only message already set RUNNING via _emitToolCall and THINKING here
        // would clobber it (status flicker).
        const c = msg.message?.content;
        const hadProse = Array.isArray(c) && c.some((b) => b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking');
        if (hadProse) this.emitStatus(StatusState.THINKING);
        break;
      }
      case 'user':
        this._handleUser(msg.message, msg.parent_tool_use_id || this._lastParent);
        break;
      case 'stream_event':
        this._handleStreamEvent(msg.event);
        break;
      case 'result':
        this._handleResult(msg);
        break;
      case 'control_request':
        // The CLI asks the host something mid-turn (e.g. AskUserQuestion / a
        // permission over the control channel). We don't yet implement the
        // response, but log the FULL payload verbatim so the exact wire shape can
        // be captured on-device and the answer-back wired correctly. (See
        // docs/claude-cli-behaviors.md.)
        this.log(`INBOUND control_request (unhandled) :: ${JSON.stringify(msg)}`);
        break;
      default:
        // Dump the whole object (not just the type) so any new/undocumented
        // stream-json message is recoverable from the log for diagnosis.
        this.log(`unhandled stream-json type: ${msg.type} :: ${JSON.stringify(msg).slice(0, 2000)}`);
    }
  }

  _handleSystem(msg) {
    if (msg.subtype === 'init') {
      this._sawInit = true; // authoritative caps are here; a pending probe must defer
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
      // Other system subtypes (status, thinking_tokens, post_turn_summary, …) are
      // routine protocol chatter — log for diagnostics only, never surface in chat.
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
        case 'web_search_tool_result': {
          const parsed = splitToolContent(block.content);
          this.emitEvent(EventType.TOOL_RESULT, {
            id: block.tool_use_id,
            name: 'WebSearch',
            status: block.is_error ? 'error' : 'ok',
            output: parsed.text,
            images: parsed.images.length ? parsed.images : undefined,
            parentToolUseId,
          });
          break;
        }
        default:
          this.log(`unhandled assistant block: ${block.type}`);
      }
    }
    this._resetMessageDeltaState();
  }

  /** Surface a tool call the moment its content block opens (with
   *  --include-partial-messages) so the card appears immediately and its input can
   *  stream. Ephemeral: the recorded copy is the finalize emitted from the terminal
   *  assistant message (_emitToolCall). */
  _emitToolCallStart(cb, index, parentToolUseId) {
    if (!cb || !cb.id || this._startedTools.has(cb.id)) return;
    this._startedTools.add(cb.id);
    this._toolNames.set(cb.id, cb.name);
    const b = this._blocks.get(index) || { type: cb.type };
    b.toolId = cb.id; b.jsonBuf = '';
    this._blocks.set(index, b);
    this.emitEvent(EventType.TOOL_CALL, {
      id: cb.id,
      name: cb.name,
      input: cb.input || {},
      kind: classifyTool(cb.name, cb.type),
      parentToolUseId,
      streaming: true,
      ephemeral: true,
    });
    this.emitStatus(StatusState.RUNNING, cb.name);
  }

  _emitToolCall(block, parentToolUseId) {
    // Already surfaced live at block-start — emit the authoritative (recorded)
    // finalize so the card swaps its streamed preview for the real input/diff.
    if (this._startedTools.has(block.id)) {
      this.emitEvent(EventType.TOOL_CALL, {
        id: block.id,
        name: block.name,
        input: block.input || {},
        kind: classifyTool(block.name, block.type),
        parentToolUseId,
      });
      return;
    }
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
        const parsed = splitToolContent(block.content);
        this.emitEvent(EventType.TOOL_RESULT, {
          id: block.tool_use_id,
          name: this._toolNames.get(block.tool_use_id),
          status: block.is_error ? 'error' : 'ok',
          output: parsed.text,
          images: parsed.images.length ? parsed.images : undefined,
          parentToolUseId,
        });
      } else if (block.type === 'text' && !parentToolUseId) {
        // Only a TOP-LEVEL user message is the human's prompt. A user-role text block
        // nested under a subagent (parentToolUseId set) is internal relay, not a
        // prompt — emitting it as USER_ECHO renders agent/relay text as a fake user
        // bubble. Guard it so only real prompts echo into the transcript.
        // Drop the --replay-user-messages echo of the prompt we already emitted up
        // front in _writeUser (else the prompt appears twice / misordered on reload).
        if (this._pendingEcho != null && block.text === this._pendingEcho) { this._pendingEcho = null; continue; }
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
      case 'content_block_start': {
        const cb = ev.content_block || {};
        this._blocks.set(ev.index, { type: cb.type });
        if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
          this._emitToolCallStart(cb, ev.index, this._lastParent);
        }
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta || {};
        if (d.type === 'text_delta') {
          this._sawTextDeltas = true;
          this.emitEvent(EventType.ASSISTANT_TEXT, { delta: d.text, parentToolUseId: this._lastParent });
        } else if (d.type === 'thinking_delta') {
          this._sawThinkingDeltas = true;
          this.emitEvent(EventType.ASSISTANT_THINKING, { delta: d.thinking, parentToolUseId: this._lastParent });
        } else if (d.type === 'input_json_delta') {
          // Live tool-input streaming: accumulate the partial JSON on the block and
          // push it so the tool card fills in as the model writes its arguments.
          const b = this._blocks.get(ev.index);
          if (b && b.toolId) {
            b.jsonBuf = (b.jsonBuf || '') + (d.partial_json || '');
            this.emitEvent(EventType.TOOL_DELTA, {
              id: b.toolId,
              jsonText: b.jsonBuf,
              parentToolUseId: this._lastParent,
              ephemeral: true,
            });
          }
        }
        // signature_delta / citations_delta accumulate on the block; the
        // authoritative copy arrives in the terminal assistant message.
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
        // Surface a non-ordinary stop so a truncated/refused/paused turn isn't silent.
        const sr = ev.delta?.stop_reason;
        if (sr && !['end_turn', 'tool_use', 'stop_sequence'].includes(sr)) {
          this.emitEvent(EventType.LOG, { level: 'warn', message: stopReasonNote(sr) });
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
    // The turn is over: tool_use→result mapping is done, so clear the id→name map
    // (it otherwise grows unbounded across a long session). Done at result, not
    // message_start, so a within-turn tool_result still resolves its name.
    this._toolNames.clear();
    this._startedTools.clear();
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
    // Echo the prompt NOW, up front, so it records ABOVE the agent's response and
    // replays in order. --replay-user-messages echoes it back too, but only AFTER
    // the model has begun thinking (mid-stream), which would sort the prompt below
    // the first thinking trace on reload. We drop that late duplicate in _handleUser.
    if (text) { this._pendingEcho = text; this.emitEvent(EventType.USER_ECHO, { text }); }
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
      // Fail-closed timeout: if the UI never answers (tab closed, socket dropped),
      // auto-deny after PERMISSION_TIMEOUT_MS so the CLI's permission-server isn't
      // blocked indefinitely.
      const timer = setTimeout(() => {
        if (!this._pendingPermissions.has(id)) return;
        this._pendingPermissions.delete(id);
        try { this.emitEvent(EventType.PERMISSION_RESOLVED, { id, decision: 'deny' }); } catch { /* ignore */ }
        resolve({ decision: 'deny', message: 'Approval timed out' });
        this.emitStatus(StatusState.THINKING);
      }, PERMISSION_TIMEOUT_MS);
      timer.unref?.();
      this._pendingPermissions.set(id, { resolve, input, timer });
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
    if (pending.timer) clearTimeout(pending.timer);
    this._pendingPermissions.delete(id);
    this.emitEvent(EventType.PERMISSION_RESOLVED, { id, decision });
    if (decision === 'allow' || decision === 'approve') {
      pending.resolve({ decision: 'allow', updatedInput: extra.updatedInput || pending.input });
    } else {
      pending.resolve({ decision: 'deny', message: extra.reason || 'Denied by user' });
    }
    this.emitStatus(StatusState.THINKING);
  }

  // The agent called the broker's ask_user_question MCP tool. Surface a question
  // form to the UI and resolve once the user answers (or the engine is gone).
  _onQuestion({ questions }) {
    const id = `ques-${++this._permSeq}`;
    return new Promise((resolve) => {
      this._pendingQuestions.set(id, { resolve });
      this.emitEvent(EventType.QUESTION_REQUEST, { id, questions: Array.isArray(questions) ? questions : [] });
      this.emitStatus(StatusState.WAITING, 'Waiting for your answer');
    });
  }

  // UI → answer for a pending question. `answers` is the structured form result;
  // we hand the MCP tool a readable summary the model can act on.
  respondQuestion(id, answers) {
    const pending = this._pendingQuestions.get(id);
    if (!pending) return;
    this._pendingQuestions.delete(id);
    this.emitEvent(EventType.QUESTION_RESOLVED, { id });
    if (!answers) { pending.resolve({ cancelled: true }); }
    else { pending.resolve({ text: formatAnswers(answers) }); }
    this.emitStatus(StatusState.THINKING);
  }

  _failPendingQuestions(reason) {
    for (const [id, p] of this._pendingQuestions) {
      try { this.emitEvent(EventType.QUESTION_RESOLVED, { id }); } catch { /* ignore */ }
      p.resolve({ cancelled: true, message: reason });
    }
    this._pendingQuestions.clear();
  }

  async _teardown() {
    this._failPendingPermissions('Engine stopped');
    this._failPendingQuestions('Engine stopped');
    if (this._probeProc) { try { this._probeProc.kill('SIGKILL'); } catch { /* ignore */ } this._probeProc = null; }
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
  const m = String(model).toLowerCase();
  // Match the 1M-context variants by an explicit, anchored token — the old
  // /1m/ substring also matched incidental "1m" anywhere in an id. The marker
  // appears as a "[1m]" suffix or a "-1m" segment on the model name.
  if (/\[1m\]|(^|[^a-z0-9])1m($|[^a-z0-9])/.test(m)) return 1000000;
  if (/(^|[^a-z0-9])500k($|[^a-z0-9])/.test(m)) return 500000;
  return 200000;
}

/** Split a tool_result's content into display text + any image data URLs, so an
 *  image-bearing result (screenshots, image reads, MCP image outputs) renders as
 *  a picture instead of a wall of base64 JSON. */
function splitToolContent(content) {
  const images = [];
  const imgUrl = (c) => {
    const src = c && c.source;
    if (!src) return null;
    if (src.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
    if (src.type === 'url' && src.url) return src.url;
    return null;
  };
  if (content == null) return { text: '', images };
  if (typeof content === 'string') return { text: content, images };
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (typeof c === 'string') { parts.push(c); continue; }
      if (c && c.type === 'image') { const u = imgUrl(c); if (u) { images.push(u); continue; } }
      if (c && typeof c.text === 'string') { parts.push(c.text); continue; }
      parts.push(JSON.stringify(c));
    }
    return { text: parts.join('\n'), images };
  }
  if (typeof content === 'object') {
    if (content.type === 'image') { const u = imgUrl(content); if (u) return { text: '', images: [u] }; }
    return { text: content.text ?? JSON.stringify(content), images };
  }
  return { text: String(content), images };
}

function stopReasonNote(sr) {
  switch (sr) {
    case 'max_tokens': return 'Response truncated — hit the max output length.';
    case 'refusal': return 'The model declined to continue (refusal).';
    case 'pause_turn': return 'Turn paused — the model will continue.';
    case 'model_context_window_exceeded': return 'Context window exceeded.';
    default: return `Turn stopped: ${sr}.`;
  }
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

/** Turn the UI's structured question answers into a readable string for the model. */
function formatAnswers(answers) {
  if (!Array.isArray(answers) || !answers.length) return 'No answer provided.';
  const lines = answers.map((a) => {
    const picks = [...(a.selected || [])];
    if (a.custom && String(a.custom).trim()) picks.push(String(a.custom).trim());
    const label = a.header || a.question || 'Answer';
    return `- ${label}: ${picks.length ? picks.join(', ') : '(no selection)'}`;
  });
  return `The user answered:\n${lines.join('\n')}`;
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
