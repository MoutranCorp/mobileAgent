import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

// Helper: boot a broker with the given project opened as the active workspace.
async function boot(projectDir) {
  const projects = await tmpDir('dl-proj-');
  const state = await tmpDir('dl-state-');
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
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout waiting for event')); }, ms);
    listeners.add(l);
  });
  // Open the project as the active workspace.
  ws.send(JSON.stringify({ type: 'open_path', path: projectDir }));
  await waitFor((e) => e.type === 'projects' && e.activeProjectId);
  return { server, port, ws, events, waitFor };
}

test('list_apks scans the active project; /download serves the binary as an attachment', async () => {
  const dir = await tmpDir('dl-apk-');
  // A nested build artifact, like a real gradle/EAS output.
  const rel = 'android/app/build/outputs/apk/release/app-release.apk';
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const apkBytes = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(1024, 9)]);
  await fs.writeFile(abs, apkBytes);
  // node_modules artifacts must NOT be reported (skipped during the walk).
  await fs.mkdir(path.join(dir, 'node_modules', 'junk'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'junk', 'vendored.apk'), 'nope');

  const { server, ws, port, waitFor } = await boot(dir);
  try {
    ws.send(JSON.stringify({ type: 'list_apks' }));
    const apks = await waitFor((e) => e.type === 'apks');
    assert.equal(apks.items.length, 1, 'only the real artifact, not the node_modules one');
    const item = apks.items[0];
    assert.equal(item.rel, rel.split(path.sep).join('/'));
    assert.equal(item.name, 'app-release.apk');
    assert.equal(item.size, apkBytes.length);

    // Download it over HTTP — must be a byte-exact attachment.
    const res = await fetch(`http://127.0.0.1:${port}/download/${item.rel}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="app-release\.apk"/);
    const got = Buffer.from(await res.arrayBuffer());
    assert.ok(got.equals(apkBytes), 'downloaded bytes match the file exactly');
  } finally {
    ws.close();
    await server.stop();
  }
});

test('/download guards against path traversal outside the project', async () => {
  const dir = await tmpDir('dl-guard-');
  await fs.writeFile(path.join(dir, 'ok.txt'), 'hello');
  const { server, ws, port } = await boot(dir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/download/../../../../etc/passwd`);
    assert.ok(res.status === 403 || res.status === 404, `traversal blocked (got ${res.status})`);
  } finally {
    ws.close();
    await server.stop();
  }
});

test('a build that emits an .apk auto-broadcasts an APKS event after the turn', async () => {
  const dir = await tmpDir('dl-build-');
  const { server, ws, waitFor } = await boot(dir);
  try {
    // The mock writes android/.../app-release.apk for a "build the apk" prompt.
    ws.send(JSON.stringify({ type: 'user_message', text: 'build the release apk please' }));
    const apks = await waitFor((e) => e.type === 'apks' && e.items.some((i) => /\.apk$/.test(i.name)), 12000);
    assert.ok(apks.items.length >= 1);
    assert.ok(apks.items.some((i) => i.name === 'app-release.apk'));
  } finally {
    ws.close();
    await server.stop();
  }
});
