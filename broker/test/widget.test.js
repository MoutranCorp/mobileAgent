import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function boot(projectDir) {
  const projects = await tmpDir('wg-proj-');
  const state = await tmpDir('wg-state-');
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
  ws.send(JSON.stringify({ type: 'open_path', path: projectDir }));
  await waitFor((e) => e.type === 'projects' && e.activeProjectId);
  return { server, port, ws, events, waitFor };
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('/widget emits a file_widget event for an existing project file', async () => {
  const dir = await tmpDir('wg-shot-');
  await fs.mkdir(path.join(dir, 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(dir, 'screenshots', 'shot.png'), Buffer.from('\x89PNG\r\n\x1a\n', 'binary'));

  const { server, ws, port, waitFor } = await boot(dir);
  try {
    const widgetEv = waitFor((e) => e.type === 'file_widget');
    const resp = await get(port, '/widget?path=screenshots/shot.png&kind=image');
    assert.equal(resp.status, 200);
    const json = JSON.parse(resp.body);
    assert.equal(json.ok, true);
    assert.equal(json.path, 'screenshots/shot.png');
    const ev = await widgetEv;
    assert.equal(ev.path, 'screenshots/shot.png');
    assert.equal(ev.kind, 'image');
  } finally {
    ws.close();
    await server.stop();
  }
});

test('/widget rejects path traversal and missing files', async () => {
  const dir = await tmpDir('wg-guard-');
  const { server, ws, port } = await boot(dir);
  try {
    // Leading ../ gets stripped by the sanitizer → resolves inside project → not found
    const trav = await get(port, '/widget?path=../../etc/passwd');
    assert.equal(trav.status, 404);
    const missing = await get(port, '/widget?path=nope.png');
    assert.equal(missing.status, 404);
    const empty = await get(port, '/widget');
    assert.equal(empty.status, 400);
  } finally {
    ws.close();
    await server.stop();
  }
});
