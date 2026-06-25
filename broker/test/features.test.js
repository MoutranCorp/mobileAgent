import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { TranscriptStore } from '../src/controls/transcript.js';
import { Checkpoints } from '../src/controls/checkpoints.js';
import { Files } from '../src/controls/files.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function bootBroker() {
  const projects = await tmpDir('feat-proj-');
  const state = await tmpDir('feat-state-');
  const projDir = path.join(projects, 'demo');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '*' } }));
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  return { server, port: server.httpServer.address().port, projDir, state };
}

function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  return { ws, events, ready, waitFor };
}

// ---- unit: TranscriptStore coalescing ----
test('TranscriptStore coalesces text deltas into one record', async () => {
  const dir = await tmpDir('ts-');
  const ts = new TranscriptStore(dir);
  ts.setProject('p1');
  ts.record({ type: 'user_echo', text: 'hi' });
  ts.record({ type: 'assistant_text', delta: 'Hello ' });
  ts.record({ type: 'assistant_text', delta: 'world' });
  ts.record({ type: 'tool_call', id: 't1', name: 'Bash' });
  const replay = ts.replay();
  const texts = replay.filter((e) => e.type === 'assistant_text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].delta, 'Hello world');
  assert.equal(replay[0].type, 'user_echo');
});

// ---- unit: Checkpoints snapshot + restore ----
test('Checkpoints snapshot, edit, restore reverts the change', async () => {
  const proj = await tmpDir('cp-proj-');
  const state = await tmpDir('cp-state-');
  spawnSync('git', ['init'], { cwd: proj });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: proj });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: proj });
  await fs.writeFile(path.join(proj, 'a.txt'), 'original');
  spawnSync('git', ['add', '-A'], { cwd: proj });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: proj });

  const cps = new Checkpoints({ stateDir: state });
  const cp = cps.snapshot('demo', proj, 'before turn');
  assert.ok(cp && cp.id, 'snapshot should produce a checkpoint');

  // agent edits an existing file and creates a new one
  await fs.writeFile(path.join(proj, 'a.txt'), 'MODIFIED');
  await fs.writeFile(path.join(proj, 'new.txt'), 'agent created this');

  const res = cps.restore('demo', proj, cp.id);
  assert.ok(res.ok, 'restore should succeed');
  assert.equal(await fs.readFile(path.join(proj, 'a.txt'), 'utf8'), 'original', 'edit reverted');
  let newExists = true;
  try { await fs.access(path.join(proj, 'new.txt')); } catch { newExists = false; }
  assert.equal(newExists, false, 'agent-created file removed on rewind');
});

// ---- unit: Files ----
test('Files lists, reads, searches and skips node_modules', async () => {
  const proj = await tmpDir('files-');
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.mkdir(path.join(proj, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(proj, 'src', 'App.tsx'), 'export default 1');
  await fs.writeFile(path.join(proj, 'README.md'), '# hi');
  const files = new Files({ getProjectDir: () => proj });
  const root = files.list('.');
  const names = root.entries.map((e) => e.name);
  assert.ok(names.includes('src') && names.includes('README.md'));
  assert.ok(!names.includes('node_modules'), 'node_modules skipped');
  const read = files.read('src/App.tsx');
  assert.match(read.content, /export default/);
  const search = files.search('App');
  assert.ok(search.matches.includes('src/App.tsx'));
  // path traversal rejected
  const bad = files.read('../../../etc/passwd');
  assert.ok(bad.error, 'traversal rejected');
});

// ---- e2e: transcript replay over WS ----
test('transcript persists and replays on a fresh connection', async () => {
  const { server, port } = await bootBroker();
  const c1 = open(port); await c1.ready;
  c1.ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); if (ev.type === 'permission_request') c1.ws.send(JSON.stringify({ type: 'approve', id: ev.id })); });
  c1.ws.send(JSON.stringify({ type: 'user_message', text: 'build a home screen' }));
  await c1.waitFor((e) => e.type === 'result');
  c1.ws.close();

  // fresh client should receive a transcript replay with the prior turn
  const c2 = open(port); await c2.ready;
  const t = await c2.waitFor((e) => e.type === 'transcript');
  assert.ok(t.events.length > 0, 'replay should contain prior events');
  assert.ok(t.events.some((e) => e.type === 'user_echo' || e.type === 'assistant_text'));
  c2.ws.close();
  await server.stop();
});

// ---- e2e: files + checkpoints over WS ----
test('files_list and checkpoint flow over WS', async () => {
  const { server, port } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({ type: 'files_list', path: '.' }));
  const files = await waitFor((e) => e.type === 'files');
  assert.ok(files.entries.some((e) => e.name === 'package.json'));

  ws.send(JSON.stringify({ type: 'checkpoints_enable' }));
  const cp = await waitFor((e) => e.type === 'checkpoints' && e.enabled === true);
  assert.equal(cp.enabled, true);
  ws.close();
  await server.stop();
});

// ---- e2e: image attachment acknowledged by mock ----
test('user_message with images is accepted (mock acknowledges)', async () => {
  const { server, port } = await bootBroker();
  const { ws, events, ready, waitFor } = open(port);
  await ready;
  const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  ws.send(JSON.stringify({ type: 'user_message', text: 'what is this?', images: [{ mime: 'image/png', dataBase64: onePixelPng }] }));
  await waitFor((e) => e.type === 'result');
  const text = events.filter((e) => e.type === 'assistant_text').map((e) => e.delta).join('');
  assert.match(text, /image/i, 'mock should acknowledge the image');
  ws.close();
  await server.stop();
});
