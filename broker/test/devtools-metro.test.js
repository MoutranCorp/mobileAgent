import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { DevTools } from '../src/controls/devtools.js';

async function tmpDir(p) { return fsp.mkdtemp(path.join(os.tmpdir(), p)); }
const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout');
};

function stubRunner() {
  const running = new Set();
  return {
    running, calls: [],
    isRunning(ch) { return running.has(ch); },
    start(ch, cmd, opts) {
      this.calls.push({ ch, cmd, opts });
      running.add(ch);
      return { alreadyRunning: false, promise: new Promise(() => {}) }; // long-lived
    },
  };
}

function mkDevTools(project, settings = null) {
  const events = [];
  const projects = { get: () => project, getActive: () => project };
  const runner = stubRunner();
  const userSettings = settings ? { get: () => settings } : undefined;
  const dt = new DevTools({ config: {}, runner, projects, emit: (e) => events.push(e), userSettings });
  return { dt, events, runner, metro: () => events.filter((e) => e.type === 'metro_status') };
}

test('_resolveExpoDir finds an Expo project at the root, in a subfolder, or not at all', async () => {
  const root = await tmpDir('expo-root-');
  const { dt } = mkDevTools({ id: 'p', dir: root, metroPort: 8081 });

  // none yet
  assert.equal(dt._resolveExpoDir(root), null);

  // app.json at the root
  await fsp.writeFile(path.join(root, 'app.json'), '{}');
  assert.equal(dt._resolveExpoDir(root), root);

  // a project whose Expo app is in a subfolder (create-expo-app demo → demo/)
  const sub = await tmpDir('expo-sub-');
  const app = path.join(sub, 'demo');
  await fsp.mkdir(app);
  await fsp.writeFile(path.join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '^51' } }));
  assert.equal(dt._resolveExpoDir(sub), app);
});

test('startMetro reports an error (and does NOT spawn) when there is no Expo project', async () => {
  const dir = await tmpDir('no-expo-');
  const { dt, runner, metro } = mkDevTools({ id: 'p', dir, metroPort: 8081 });
  dt.startMetro('p');
  assert.equal(runner.calls.length, 0, 'must not spawn expo when there is no project');
  const last = metro().at(-1);
  assert.equal(last.running, false);
  assert.match(last.error || '', /No Expo project/i);
});

test('startMetro spawns in the Expo app dir and reports "starting" (not running) until ready', async () => {
  const root = await tmpDir('expo-start-');
  const app = path.join(root, 'demo');
  await fsp.mkdir(app);
  await fsp.writeFile(path.join(app, 'app.json'), '{}');
  const { dt, runner, metro } = mkDevTools({ id: 'p', dir: root, metroPort: 8099 });
  dt.startMetro('p');
  assert.equal(runner.calls.length, 1, 'spawned expo');
  assert.equal(runner.calls[0].opts.cwd, app, 'runs in the subfolder that holds the Expo app');
  assert.match(runner.calls[0].cmd, /expo start/);
  assert.match(runner.calls[0].cmd, /--go/, 'defaults to Expo Go (the no-build, store-installed client)');
  assert.doesNotMatch(runner.calls[0].cmd, /--dev-client/);
  const first = metro()[0];
  assert.equal(first.running, false);
  assert.equal(first.starting, true, 'reports starting, not running — the client must not open yet');
});

test('expo.mode = dev-client switches the start flag to --dev-client', async () => {
  const root = await tmpDir('expo-mode-');
  await fsp.writeFile(path.join(root, 'app.json'), '{}');
  const { dt, runner } = mkDevTools({ id: 'p', dir: root, metroPort: 8097 }, { expo: { mode: 'dev-client' } });
  dt.startMetro('p');
  assert.match(runner.calls[0].cmd, /--dev-client/);
  assert.doesNotMatch(runner.calls[0].cmd, /--go/);
});

test('metroInfo reports starting while booting and running once ready', async () => {
  const root = await tmpDir('expo-info-');
  await fsp.writeFile(path.join(root, 'app.json'), '{}');
  const { dt } = mkDevTools({ id: 'p', dir: root, metroPort: 8096 });
  dt.startMetro('p'); // stub runner stays "alive" but never ready (no real metro)
  let info = dt.metroInfo('p');
  assert.equal(info.starting, true);
  assert.equal(info.running, false, 'alive-but-not-ready is "starting", not "running"');
  // Simulate readiness, as _awaitReady would once /status answers.
  dt._metro.get('p').ready = true;
  info = dt.metroInfo('p');
  assert.equal(info.running, true);
  assert.equal(info.starting, false);
});

test('_probeMetro is true only when Metro answers /status with packager-status:running', async () => {
  const { dt } = mkDevTools({ id: 'p', dir: '/x', metroPort: 1 });
  const server = http.createServer((req, res) => {
    if (req.url === '/status') res.end('packager-status:running');
    else res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // A deterministically-closed port: bind one, read it, close it, then probe it.
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const closedPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  try {
    assert.equal(await dt._probeMetro(port), true);
    assert.equal(await dt._probeMetro(closedPort), false, 'closed port → false');
  } finally { server.close(); }
});

test('startMetro flips to running once Metro actually answers on the port', async () => {
  const root = await tmpDir('expo-ready-');
  await fsp.writeFile(path.join(root, 'app.json'), '{}');
  // Fake Metro on the project's metro port.
  const server = http.createServer((req, res) => {
    if (req.url === '/status') res.end('packager-status:running'); else res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const { dt, metro } = mkDevTools({ id: 'p', dir: root, metroPort: port });
  try {
    dt.startMetro('p');
    const ready = await waitFor(() => metro().find((e) => e.running === true));
    assert.equal(ready.running, true);
    assert.equal(ready.port, port);
    assert.match(ready.url, /^exp:\/\/127\.0\.0\.1:/);
  } finally { server.close(); }
});
