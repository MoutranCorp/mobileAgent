import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { Updater, classifyChanges } from '../src/controls/updater.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('classifyChanges maps repo paths to the right apply-action', () => {
  // web-ui only -> reload (the broker serves it from disk; no restart)
  assert.deepEqual(classifyChanges(['broker/web-ui/app.js', 'broker/web-ui/styles.css']),
    { needsReload: true, needsRestart: false, needsRebuild: false });
  // broker source -> restart
  assert.equal(classifyChanges(['broker/src/server.js']).needsRestart, true);
  // dependency change -> restart
  assert.equal(classifyChanges(['broker/package.json']).needsRestart, true);
  assert.equal(classifyChanges(['broker/package-lock.json']).needsRestart, true);
  // android -> rebuild (informational)
  assert.equal(classifyChanges(['android/app/src/Main.kt']).needsRebuild, true);
  // docs only -> nothing
  assert.deepEqual(classifyChanges(['README.md', 'ondevice-claude-code-plan.md']),
    { needsReload: false, needsRestart: false, needsRebuild: false });
  // mixed
  const mix = classifyChanges(['broker/web-ui/x.js', 'broker/src/y.js']);
  assert.equal(mix.needsReload, true);
  assert.equal(mix.needsRestart, true);
});

test('Updater.version reads the app build from its own repo', async () => {
  const v = await new Updater().version();
  assert.equal(v.ok, true, 'broker runs from a git checkout');
  assert.match(v.sha, /^[0-9a-f]{6,}$/, 'short sha');
  assert.equal(typeof v.branch, 'string');
});

test('e2e: app_version over WebSocket returns current build', async () => {
  const projects = await tmpDir('up-proj-');
  const state = await tmpDir('up-state-');
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });

  ws.send(JSON.stringify({ type: 'app_version' }));
  const v = await waitFor((e) => e.type === 'app_version');
  assert.equal(typeof v.sha, 'string');

  ws.close();
  await server.stop();
});
