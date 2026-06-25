import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { ClaudeConfig } from '../src/controls/claude-config.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function bootBroker() {
  const projects = await tmpDir('l4-proj-');
  const state = await tmpDir('l4-state-');
  const projDir = path.join(projects, 'demo');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '*' } }));
  // git repo so per-turn checkpoints + turn_changes work
  spawnSync('git', ['init'], { cwd: projDir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: projDir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: projDir });
  spawnSync('git', ['add', '-A'], { cwd: projDir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: projDir });
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  return { server, port: server.httpServer.address().port, projDir };
}

function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 10000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  return { ws, events, ready, waitFor };
}

test('ClaudeConfig output-styles CRUD', async () => {
  const proj = await tmpDir('os-');
  const cc = new ClaudeConfig({ getProjectDir: () => proj });
  cc.write('output-styles', 'terse', 'project', { fields: { description: 'Short and direct' }, body: 'Be terse. Bullet points only.' });
  const list = cc.list('output-styles', 'project');
  assert.ok(list.some((s) => s.name === 'terse' && s.description === 'Short and direct'));
  const read = cc.read('output-styles', 'terse', 'project');
  assert.match(read.body, /Bullet points/);
  const file = await fs.readFile(path.join(proj, '.claude', 'output-styles', 'terse.md'), 'utf8');
  assert.match(file, /description: Short and direct/);
  cc.delete('output-styles', 'terse', 'project');
  assert.equal(cc.list('output-styles', 'project').length, 0);
});

test('e2e: turn_changes summarises files changed in a turn', async () => {
  const { server, port } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); if (ev.type === 'permission_request') ws.send(JSON.stringify({ type: 'approve', id: ev.id })); });
  ws.send(JSON.stringify({ type: 'user_message', text: 'build a profile screen' }));
  const tc = await waitFor((e) => e.type === 'turn_changes');
  assert.ok(tc.files.length >= 1, 'should list the file the agent wrote');
  assert.ok(tc.files.some((f) => /\.tsx$/.test(f.path)));
  assert.ok(tc.checkpointId);
  ws.close();
  await server.stop();
});

test('e2e: output-styles via config over WS', async () => {
  const { server, port, projDir } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({ type: 'config_write', kind: 'output-styles', name: 'teacher', scope: 'project', fields: { description: 'Explains as it goes' }, body: 'Teach while doing.' }));
  const cfg = await waitFor((e) => e.type === 'config' && e.kind === 'output-styles');
  assert.ok(cfg.items.some((s) => s.name === 'teacher'));
  const file = await fs.readFile(path.join(projDir, '.claude', 'output-styles', 'teacher.md'), 'utf8');
  assert.match(file, /Teach while doing/);
  ws.close();
  await server.stop();
});
