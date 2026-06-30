import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { UserSettings } from '../src/controls/user-settings.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('UserSettings exposes committed defaults (comments stripped)', async () => {
  const dir = await tmpDir('us-');
  const us = new UserSettings(dir);
  const g = us.get();
  assert.equal(g.version, 1);
  assert.equal(g.engine.effort, 'high');
  assert.equal(g.engine.permissionMode, 'bypassPermissions');
  assert.deepEqual(g.manage.tabOrder, []);
  // $comment documentation keys never leak into the runtime object.
  assert.ok(!('$comment' in g));
  assert.ok(!('$comment' in g.engine));
});

test('patch deep-merges, persists, and round-trips (defaults preserved)', async () => {
  const dir = await tmpDir('us-');
  const us = new UserSettings(dir);
  us.patch({ engine: { effort: 'max' }, manage: { tabOrder: ['files', 'git'] } });
  us.flush();
  assert.ok(existsSync(path.join(dir, 'user-settings.json')), 'live file written');

  const reopened = new UserSettings(dir);
  const g = reopened.get();
  assert.equal(g.engine.effort, 'max', 'patched value persists');
  assert.equal(g.engine.permissionMode, 'bypassPermissions', 'untouched default preserved');
  assert.deepEqual(g.manage.tabOrder, ['files', 'git']);
});

test('a corrupt live file falls back to defaults without throwing', async () => {
  const dir = await tmpDir('us-');
  await fs.writeFile(path.join(dir, 'user-settings.json'), '{ not json');
  const us = new UserSettings(dir);
  assert.equal(us.get().engine.effort, 'high');
});

test('e2e: snapshot carries user_settings; a patch persists across reconnect', async () => {
  const projects = await tmpDir('use-proj-');
  const state = await tmpDir('use-state-');
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;

  const connect = async () => {
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
    return { ws, waitFor, send: (o) => ws.send(JSON.stringify(o)) };
  };

  try {
    // 1) The connect snapshot includes a user_settings event with defaults.
    const a = await connect();
    const us1 = await a.waitFor((e) => e.type === 'user_settings');
    assert.equal(us1.settings.engine.effort, 'high');
    assert.deepEqual(us1.settings.manage.tabOrder, []);

    // 2) Patch the manage tab order; the broker persists it.
    a.send({ type: 'user_settings_patch', patch: { manage: { tabOrder: ['usage', 'git'] } } });
    await new Promise((r) => setTimeout(r, 500)); // let the debounced save land
    a.ws.close();

    // 3) A fresh connection sees the persisted order in its snapshot.
    const b = await connect();
    const us2 = await b.waitFor((e) => e.type === 'user_settings');
    assert.deepEqual(us2.settings.manage.tabOrder, ['usage', 'git']);
    b.ws.close();
  } finally { await server.stop(); }
});

test('e2e: set_effort persists into user settings (survives restart)', async () => {
  const projects = await tmpDir('use2-proj-');
  const state = await tmpDir('use2-state-');
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  let server = new BrokerServer(config);
  await server.start();
  let port = server.httpServer.address().port;
  let ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'set_effort', level: 'max' }));
  await new Promise((r) => setTimeout(r, 500));
  ws.close();
  await server.stop(); // flushes user settings

  // New broker over the SAME state dir re-applies the persisted effort.
  const config2 = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  server = new BrokerServer(config2);
  assert.equal(server.session.effort, 'max', 'effort re-applied from user settings at startup');
  await server.start();
  port = server.httpServer.address().port;
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = await new Promise((resolve, reject) => {
    ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); if (ev.type === 'effort') resolve(ev); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
  assert.equal(got.level, 'max', 'snapshot reports the restored effort');
  ws.close();
  await server.stop();
});

test('saved compatible custom model is honored on first engine start', async () => {
  const projects = await tmpDir('use3-proj-');
  const state = await tmpDir('use3-state-');
  await fs.writeFile(path.join(state, 'user-settings.json'), JSON.stringify({
    engine: { model: 'mock-special', effort: 'high', permissionMode: 'default' },
  }, null, 2));

  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  try {
    await server.start();
    const engine = await server.session.ensureEngine();
    assert.equal(engine.model, 'mock-special');
    assert.equal(server.session.currentModel, 'mock-special');
  } finally {
    await server.stop();
  }
});
