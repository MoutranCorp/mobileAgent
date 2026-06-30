import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { MAIN_KEY } from '../src/session.js';

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

test('Codex profile ignores stale Claude model preference on startup', async () => {
  const projects = await tmpDir('codex-model-proj-');
  const state = await tmpDir('codex-model-state-');
  await fs.writeFile(path.join(state, 'profiles.json'), JSON.stringify([
    {
      id: 'codex-app-server',
      label: 'Codex Stale',
      harness: 'codex-app-server',
      codexBin: process.execPath,
      codexArgs: [fixture],
      model: null,
      billing: 'none',
    },
  ], null, 2));
  await fs.writeFile(path.join(state, 'user-settings.json'), JSON.stringify({
    engine: { model: 'haiku', effort: 'xhigh', permissionMode: 'default' },
  }, null, 2));

  const config = loadConfig(['--profile', 'codex-app-server', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  try {
    await server.start();
    const engine = await server.session.ensureEngine();

    assert.ok(engine, 'engine started');
    assert.equal(engine.model, 'gpt-5.5');
    assert.equal(server.session.currentModel, 'gpt-5.5');
  } finally {
    await server.stop();
  }
});

test('Codex stale stored thread id is cleared and replaced with a fresh thread', async () => {
  const projects = await tmpDir('codex-stale-proj-');
  const state = await tmpDir('codex-stale-state-');
  await fs.writeFile(path.join(state, 'profiles.json'), JSON.stringify([
    {
      id: 'codex-app-server',
      label: 'Codex Stale Resume',
      harness: 'codex-app-server',
      codexBin: process.execPath,
      codexArgs: [fixture],
      model: 'gpt-5.5',
      models: ['gpt-5.5'],
      billing: 'none',
    },
  ], null, 2));
  await fs.writeFile(path.join(state, 'sessions.json'), JSON.stringify({
    [MAIN_KEY]: { resumeId: 'missing-thread-123', harness: 'codex-app-server', cwd: projects },
  }, null, 2));

  const oldMode = process.env.FAKE_CODEX_MODE;
  process.env.FAKE_CODEX_MODE = 'resumeMissing';
  const config = loadConfig(['--profile', 'codex-app-server', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  const events = [];
  const originalEmit = server._emitEvent.bind(server);
  server._emitEvent = (ev) => { events.push(ev); return originalEmit(ev); };
  try {
    await server.start();
    const engine = await server.session.ensureEngine();

    assert.ok(engine, 'engine started after stale resume fallback');
    assert.equal(engine.sessionId, 'thread-started-1');
    assert.deepEqual(server.session._sessionByProject[MAIN_KEY], {
      resumeId: 'thread-started-1',
      harness: 'codex-app-server',
      cwd: projects,
    });
    assert.equal(events.some((e) => e.type === 'error' && /failed to start engine/i.test(e.message)), false);
    assert.ok(events.some((e) => e.type === 'toast' && /fresh thread/i.test(e.message)));
  } finally {
    await server.stop();
    if (oldMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = oldMode;
  }
});

test('Codex legacy stored thread id without cwd is ignored before resume', async () => {
  const projects = await tmpDir('codex-legacy-cwd-proj-');
  const state = await tmpDir('codex-legacy-cwd-state-');
  await fs.writeFile(path.join(state, 'profiles.json'), JSON.stringify([
    {
      id: 'codex-app-server',
      label: 'Codex Legacy Resume',
      harness: 'codex-app-server',
      codexBin: process.execPath,
      codexArgs: [fixture],
      model: 'gpt-5.5',
      models: ['gpt-5.5'],
      billing: 'none',
    },
  ], null, 2));
  await fs.writeFile(path.join(state, 'sessions.json'), JSON.stringify({
    [MAIN_KEY]: { resumeId: 'legacy-thread-without-cwd', harness: 'codex-app-server' },
  }, null, 2));

  const oldMode = process.env.FAKE_CODEX_MODE;
  process.env.FAKE_CODEX_MODE = 'resumeMissing';
  const config = loadConfig(['--profile', 'codex-app-server', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  const events = [];
  const originalEmit = server._emitEvent.bind(server);
  server._emitEvent = (ev) => { events.push(ev); return originalEmit(ev); };
  try {
    await server.start();
    assert.equal(server.session._resumeIdFor(MAIN_KEY, 'codex-app-server', projects), null);
    const engine = await server.session.ensureEngine();

    assert.ok(engine, 'engine started without trying the legacy resume id');
    assert.equal(engine.sessionId, 'thread-started-1');
    assert.deepEqual(server.session._sessionByProject[MAIN_KEY], {
      resumeId: 'thread-started-1',
      harness: 'codex-app-server',
      cwd: projects,
    });
    assert.equal(events.some((e) => e.type === 'toast' && /fresh thread/i.test(e.message)), false);
  } finally {
    await server.stop();
    if (oldMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = oldMode;
  }
});

test('Codex stored thread id for another cwd is ignored before resume', async () => {
  const projects = await tmpDir('codex-mismatch-cwd-proj-');
  const state = await tmpDir('codex-mismatch-cwd-state-');
  const oldCwd = await tmpDir('codex-old-cwd-');
  await fs.writeFile(path.join(state, 'profiles.json'), JSON.stringify([
    {
      id: 'codex-app-server',
      label: 'Codex Mismatched Resume',
      harness: 'codex-app-server',
      codexBin: process.execPath,
      codexArgs: [fixture],
      model: 'gpt-5.5',
      models: ['gpt-5.5'],
      billing: 'none',
    },
  ], null, 2));
  await fs.writeFile(path.join(state, 'sessions.json'), JSON.stringify({
    [MAIN_KEY]: { resumeId: 'wrong-workspace-thread', harness: 'codex-app-server', cwd: oldCwd },
  }, null, 2));

  const oldMode = process.env.FAKE_CODEX_MODE;
  process.env.FAKE_CODEX_MODE = 'resumeMissing';
  const config = loadConfig(['--profile', 'codex-app-server', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  const events = [];
  const originalEmit = server._emitEvent.bind(server);
  server._emitEvent = (ev) => { events.push(ev); return originalEmit(ev); };
  try {
    await server.start();
    assert.equal(server.session._resumeIdFor(MAIN_KEY, 'codex-app-server', projects), null);
    const engine = await server.session.ensureEngine();

    assert.ok(engine, 'engine started without trying the wrong-cwd resume id');
    assert.equal(engine.sessionId, 'thread-started-1');
    assert.deepEqual(server.session._sessionByProject[MAIN_KEY], {
      resumeId: 'thread-started-1',
      harness: 'codex-app-server',
      cwd: projects,
    });
    assert.equal(events.some((e) => e.type === 'toast' && /fresh thread/i.test(e.message)), false);
  } finally {
    await server.stop();
    if (oldMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = oldMode;
  }
});

test('Codex fresh session opened from a project starts in that project cwd', async () => {
  const projects = await tmpDir('codex-cwd-proj-');
  const state = await tmpDir('codex-cwd-state-');
  const appDir = path.join(projects, 'demo-app');
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  await fs.writeFile(path.join(state, 'profiles.json'), JSON.stringify([
    {
      id: 'codex-app-server',
      label: 'Codex CWD',
      harness: 'codex-app-server',
      codexBin: process.execPath,
      codexArgs: [fixture, '--delay-thread-start=250'],
      model: 'gpt-5.5',
      models: ['gpt-5.5'],
      billing: 'none',
    },
  ], null, 2));

  const oldMode = process.env.FAKE_CODEX_MODE;
  process.env.FAKE_CODEX_MODE = 'inputEcho';
  const config = loadConfig(['--profile', 'codex-app-server', '--port', '0', '--projects', projects, '--state', state]);
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
    const active = waitFor((e) => e.type === 'sessions' && /^demo-app-[0-9a-f]+$/.test(e.activeKey));
    ws.send(JSON.stringify({ type: 'open_project', projectId: 'demo-app' }));
    ws.send(JSON.stringify({ type: 'new_session' }));
    await active;
    ws.send(JSON.stringify({ type: 'user_message', text: 'cwd smoke' }));
    await waitFor((e) => e.type === 'result');

    const text = events.filter((e) => e.type === 'assistant_text').map((e) => e.delta || '').join('');
    assert.match(text, /cwd smoke/);
    assert.ok(text.includes(`cwd:${appDir}`), `Codex turn cwd should be ${appDir}; saw ${text}`);
    assert.equal(path.resolve(server.session.engine.cwd), path.resolve(appDir));
  } finally {
    ws.close();
    await server.stop();
    if (oldMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = oldMode;
  }
});
