#!/usr/bin/env node
/**
 * MCP stdio server exposing a single `permission_prompt` tool.
 *
 * Claude Code (headless) is launched with:
 *   --permission-mode default
 *   --permission-prompt-tool mcp__broker__permission_prompt
 *   --mcp-config <config pointing 'broker' at THIS script>
 *
 * When the agent wants to use a gated tool, the CLI calls this tool with
 * { tool_name, input }. We forward that to the broker over a localhost TCP
 * socket (BROKER_IPC_PORT), wait for the user's allow/deny decision from the
 * UI, and return the MCP-format permission result the CLI expects:
 *   { behavior: "allow", updatedInput }  |  { behavior: "deny", message }
 *
 * This is a self-contained MCP server: it speaks JSON-RPC 2.0 over
 * newline-delimited stdio (the MCP stdio transport). It writes ONLY protocol
 * messages to stdout; all diagnostics go to stderr.
 */
import net from 'node:net';
import readline from 'node:readline';

const IPC_PORT = Number(process.env.BROKER_IPC_PORT || 0);
const IPC_HOST = process.env.BROKER_IPC_HOST || '127.0.0.1';
const PROTOCOL_VERSION = '2024-11-05';
// SECURITY: when the broker IPC link is unavailable we FAIL CLOSED (deny) by
// default — a dropped socket must not silently disable approval for an agent
// that can run Bash/Write. Set BROKER_FAIL_OPEN=1 to opt into allow-on-failure.
const FAIL_OPEN = process.env.BROKER_FAIL_OPEN === '1';

function log(...args) {
  process.stderr.write(`[permission-server] ${args.join(' ')}\n`);
}

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// --- IPC link to the broker -------------------------------------------------

let ipcSocket = null;
let ipcBuffer = '';
let ipcReqSeq = 0;
const ipcPending = new Map();

function connectIpc() {
  return new Promise((resolve) => {
    if (!IPC_PORT) {
      log(`no BROKER_IPC_PORT — permission requests will ${FAIL_OPEN ? 'auto-allow' : 'be DENIED'}`);
      return resolve(null);
    }
    const sock = net.createConnection({ host: IPC_HOST, port: IPC_PORT }, () => {
      log(`connected to broker IPC on ${IPC_HOST}:${IPC_PORT}`);
      resolve(sock);
    });
    sock.setEncoding('utf8');
    sock.on('data', (data) => {
      ipcBuffer += data;
      let nl;
      while ((nl = ipcBuffer.indexOf('\n')) !== -1) {
        const line = ipcBuffer.slice(0, nl).trim();
        ipcBuffer = ipcBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const pending = ipcPending.get(msg.id);
          if (pending) {
            ipcPending.delete(msg.id);
            pending(msg);
          }
        } catch (e) {
          log('bad IPC message:', e.message);
        }
      }
    });
    sock.on('error', (e) => {
      log('IPC error:', e.message);
      resolve(null);
    });
    sock.on('close', () => {
      ipcSocket = null;
    });
    ipcSocket = sock;
  });
}

function askBroker(toolName, input) {
  return new Promise((resolve) => {
    if (!ipcSocket) {
      // Broker link down → fail CLOSED unless explicitly opted into fail-open.
      if (FAIL_OPEN) return resolve({ behavior: 'allow', updatedInput: input });
      log(`broker unavailable — DENYING ${toolName} (set BROKER_FAIL_OPEN=1 to allow)`);
      return resolve({ behavior: 'deny', message: 'Broker approval channel unavailable' });
    }
    const id = `req-${++ipcReqSeq}`;
    ipcPending.set(id, (msg) => {
      if (msg.decision === 'allow') {
        resolve({ behavior: 'allow', updatedInput: msg.updatedInput || input });
      } else {
        resolve({ behavior: 'deny', message: msg.message || 'Denied by user' });
      }
    });
    ipcSocket.write(JSON.stringify({ id, kind: 'permission', tool_name: toolName, input }) + '\n');
  });
}

// --- MCP JSON-RPC handling --------------------------------------------------

const TOOL = {
  name: 'permission_prompt',
  description:
    'Approval gate. The host UI decides whether a tool call may proceed. ' +
    'Returns a permission decision in Claude Code permission-prompt format.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'broker-permission', version: '0.1.0' },
      });
    case 'tools/list':
      return reply(id, { tools: [TOOL] });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name !== 'permission_prompt') {
        return replyError(id, -32601, `Unknown tool: ${name}`);
      }
      const decision = await askBroker(args.tool_name, args.input || {});
      // The permission-prompt-tool contract: return the JSON decision as text.
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(decision) }],
      });
    }
    case 'ping':
      return reply(id, {});
    default:
      if (id === undefined) return; // notification, ignore
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

function reply(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function main() {
  await connectIpc();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log('bad JSON-RPC line:', e.message);
      return;
    }
    try {
      await handleRequest(msg);
    } catch (e) {
      log('handler error:', e.message);
      if (msg.id !== undefined) replyError(msg.id, -32603, e.message);
    }
  });
  rl.on('close', () => process.exit(0));
}

main();
