import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs');

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('prompt waits for a Codex engine that is still starting after switch_engine', async () => {
  const projects = await tmpDir('codex-race-proj-');
  const state = await tmpDir('codex-race-state-');
  await fs.mkdir(path.join(projects, 'demo'), { recursive: true });
  await fs.writeFile(path.join(projects, 'demo', 'package.json'), JSON.stringify({ name: 'demo' }));
  await fs.writeFile(path.join(state, 'profiles.json'), JSON.stringify([
    {
      id: 'mock',
      label: 'Mock',
      harness: 'mock',
      model: 'mock-1',
      models: ['mock-1'],
      billing: 'none',
    },
    {
      id: 'codex-app-server',
      label: 'Codex Slow',
      harness: 'codex-app-server',
      codexBin: process.execPath,
      codexArgs: [fixture, '--delay-thread-start=400'],
      billing: 'none',
    },
  ], null, 2));

  const oldMode = process.env.FAKE_CODEX_MODE;
  process.env.FAKE_CODEX_MODE = 'inputEcho';
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    events.push(ev);
    for (const l of [...listeners]) l(ev);
  });

  const waitFor = (pred, ms = 9000) => new Promise((resolve, reject) => {
    const existing = events.find(pred);
    if (existing) return resolve(existing);
    const listener = (ev) => {
      if (!pred(ev)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(ev);
    };
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error('timeout'));
    }, ms);
    listeners.add(listener);
  });

  try {
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    await waitFor((e) => e.type === 'profiles' && e.profiles?.some((p) => p.id === 'codex-app-server'));

    const starting = waitFor((e) => e.type === 'engine_state' && e.profileId === 'codex-app-server' && e.state === 'starting');
    ws.send(JSON.stringify({ type: 'switch_engine', profileId: 'codex-app-server' }));
    await starting;
    ws.send(JSON.stringify({ type: 'user_message', text: 'race smoke' }));

    const result = await waitFor((e) => e.type === 'result');
    assert.equal(result.isError, false);
    const text = events.filter((e) => e.type === 'assistant_text').map((e) => e.delta || '').join('');
    assert.match(text, /race smoke/);
    assert.equal(events.some((e) => e.type === 'error' && /codex thread is not initialized/i.test(e.message)), false);
  } finally {
    ws.close();
    await server.stop();
    if (oldMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = oldMode;
  }
});
