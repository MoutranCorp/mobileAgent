import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let mode = process.env.FAKE_CODEX_MODE || 'start';
let turnCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params = {}) {
  send({ jsonrpc: '2.0', method, params });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.result && msg.id === 'approval-1') {
    notify('item/agentMessage/delta', {
      delta: msg.result.approved ? ' approved' : ' denied',
    });
    notify('turn/completed', {
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    return;
  }

  if (!msg.method) return;

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, { serverInfo: { name: 'fake-codex-app-server' } });
      break;
    case 'initialized':
      break;
    case 'thread/start':
      respond(msg.id, { thread: { id: 'thread-started-1' } });
      notify('thread/started', { thread: { id: 'thread-started-1' } });
      break;
    case 'thread/resume':
      respond(msg.id, { thread: { id: msg.params.threadId } });
      notify('thread/started', { thread: { id: msg.params.threadId } });
      break;
    case 'turn/start':
      turnCount += 1;
      respond(msg.id, { turnId: `turn-${turnCount}` });
      notify('turn/started', { turnId: `turn-${turnCount}` });
      notify('item/reasoning/summaryTextDelta', { delta: 'Thinking. ' });
      notify('item/agentMessage/delta', { delta: 'Hello from Codex' });
      send({
        jsonrpc: '2.0',
        id: 'approval-1',
        method: mode === 'permission' ? 'permission/request' : 'approval/request',
        params: {
          id: 'fake-approval-1',
          action: 'exec',
          command: 'npm test',
          detail: 'Run npm test',
          toolName: 'Bash',
          input: { command: 'npm test' },
        },
      });
      break;
    case 'turn/cancel':
      notify('turn/completed', { subtype: 'interrupted' });
      break;
    default:
      respond(msg.id, { ok: true });
  }
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
