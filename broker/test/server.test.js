import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { EventType } from '../src/protocol.js';

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Boot a broker on an ephemeral port with the mock engine. */
async function bootBroker() {
  const projects = await tmpDir('broker-proj-');
  const state = await tmpDir('broker-state-');
  const projDir = path.join(projects, 'demo');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(
    path.join(projDir, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { expo: '*' } })
  );

  const config = loadConfig([
    '--profile', 'mock',
    '--port', '0',
    '--projects', projects,
    '--state', state,
  ]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;
  return { server, port, projDir };
}

/**
 * Open a client. CRITICAL: the 'message' listener is attached synchronously at
 * socket creation — on loopback the server's snapshot frames can arrive in the
 * same tick as 'open', so attaching after `await ready` would miss them. Real
 * UIs also send `hello` on open to defensively re-request a snapshot.
 */
function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    events.push(ev);
    for (const l of [...listeners]) l(ev);
  });
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const waitFor = (predicate, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const existing = events.find(predicate);
      if (existing) return resolve(existing);
      const l = (ev) => {
        if (predicate(ev)) {
          clearTimeout(t);
          listeners.delete(l);
          resolve(ev);
        }
      };
      const t = setTimeout(() => {
        listeners.delete(l);
        reject(new Error('timeout waiting for event'));
      }, timeoutMs);
      listeners.add(l);
    });
  return { ws, events, ready, waitFor };
}

test('full flow: snapshot, user message, approve, file written, result', async () => {
  const { server, port, projDir } = await bootBroker();
  const { ws, events, ready, waitFor } = open(port);
  await ready;

  await waitFor((e) => e.type === EventType.PROFILES);
  await waitFor((e) => e.type === EventType.PROJECTS);

  // Auto-approve any permission requests.
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    if (ev.type === EventType.PERMISSION_REQUEST) {
      ws.send(JSON.stringify({ type: 'approve', id: ev.id }));
    }
  });

  ws.send(JSON.stringify({ type: 'user_message', text: 'build a home screen' }));

  await waitFor((e) => e.type === EventType.PERMISSION_REQUEST);
  await waitFor((e) => e.type === EventType.TOOL_RESULT && e.status === 'ok');
  const result = await waitFor((e) => e.type === EventType.RESULT);
  assert.equal(result.isError, false);

  assert.ok(
    events.some((e) => e.type === EventType.ASSISTANT_TEXT),
    'expected streamed assistant text'
  );

  const appFiles = await fs.readdir(path.join(projDir, 'app'));
  assert.ok(appFiles.some((f) => f.endsWith('.tsx')), 'a screen file should be written');

  ws.close();
  await server.stop();
});

test('control endpoint: git init runs and reports status', async () => {
  const { server, port } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  await waitFor((e) => e.type === EventType.PROJECTS);

  ws.send(JSON.stringify({ type: 'git', op: 'init' }));
  const git = await waitFor((e) => e.type === EventType.GIT_STATUS);
  assert.equal(git.op, 'init');

  ws.close();
  await server.stop();
});

test('ping/pong and hello snapshot', async () => {
  const { server, port } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;

  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitFor((e) => e.type === 'pong');
  assert.ok(pong);

  // hello re-requests a full snapshot.
  ws.send(JSON.stringify({ type: 'hello' }));
  const profiles = await waitFor((e) => e.type === EventType.PROFILES);
  assert.ok(Array.isArray(profiles.profiles));

  ws.close();
  await server.stop();
});
