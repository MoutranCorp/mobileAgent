import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let mode = process.env.FAKE_CODEX_MODE || 'start';
let turnCount = 0;
let activeTurnId = null;

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
    const ok = msg.result.decision === 'accept' ||
      msg.result.decision === 'approved' ||
      !!msg.result.permissions;
    notify('item/agentMessage/delta', {
      delta: ok ? ' accepted' : ' denied',
    });
    notify('turn/completed', {
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    return;
  }

  if (msg.result && msg.id === 'question-1') {
    notify('item/agentMessage/delta', {
      delta: ` answers ${JSON.stringify(msg.result.answers)}`,
    });
    notify('turn/completed', { usage: { inputTokens: 3, outputTokens: 2 } });
    return;
  }

  if (!msg.method) return;

  switch (msg.method) {
    case 'initialize':
      if (!Object.prototype.hasOwnProperty.call(msg.params || {}, 'capabilities')) {
        respond(msg.id, null);
      } else {
        respond(msg.id, { serverInfo: { name: 'fake-codex-app-server' } });
      }
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
      activeTurnId = `turn-${turnCount}`;
      respond(msg.id, { turnId: activeTurnId });
      notify('turn/started', { turnId: activeTurnId });
      notify('item/reasoning/summaryTextDelta', { delta: 'Thinking. ' });
      notify('item/agentMessage/delta', { delta: 'Hello from Codex' });
      if (mode === 'inputEcho') {
        notify('item/agentMessage/delta', { delta: ` ${summarizeInput(msg.params.input)}` });
        notify('turn/completed', { usage: { inputTokens: 5, outputTokens: 5 } });
        break;
      }
      if (mode === 'toolInput') {
        send({
          jsonrpc: '2.0',
          id: 'question-1',
          method: 'item/tool/requestUserInput',
          params: {
            threadId: msg.params.threadId,
            turnId: activeTurnId,
            itemId: 'tool-input-1',
            questions: [
              {
                id: 'q-color',
                header: 'Color',
                question: 'Pick a color',
                isOther: true,
                isSecret: false,
                options: [{ label: 'Blue', description: 'Use blue' }],
              },
            ],
            autoResolutionMs: null,
          },
        });
        break;
      }
      if (mode === 'interrupt') break;
      send({
        jsonrpc: '2.0',
        id: 'approval-1',
        method: mode === 'permission'
          ? 'item/permissions/requestApproval'
          : 'item/commandExecution/requestApproval',
        params: {
          itemId: 'fake-approval-1',
          threadId: msg.params.threadId,
          turnId: activeTurnId,
          command: 'npm test',
          cwd: msg.params.cwd,
          reason: 'Run npm test',
          startedAtMs: Date.now(),
          environmentId: null,
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      });
      break;
    case 'turn/interrupt':
      respond(msg.id, { ok: true });
      notify('turn/completed', { subtype: 'interrupted', turnId: msg.params.turnId });
      break;
    default:
      respond(msg.id, { ok: true });
  }
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

function summarizeInput(input) {
  return (input || []).map((item) => {
    if (item.type === 'localImage') return 'localImage:path';
    if (item.type === 'image') return 'image:url';
    if (item.type === 'text') return item.text.slice(0, 500);
    return item.type;
  }).join('|');
}
