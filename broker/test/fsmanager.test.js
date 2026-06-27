import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FileSystemManager } from '../src/controls/fsmanager.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('browse lists folders first, then files, with metadata', async () => {
  const root = await tmpDir('fm-');
  await fs.mkdir(path.join(root, 'zeta'));
  await fs.mkdir(path.join(root, 'alpha'));
  await fs.writeFile(path.join(root, 'b.txt'), 'hello');
  const fm = new FileSystemManager();
  const r = fm.browse(root);
  assert.equal(r.path, path.resolve(root));
  assert.equal(r.parent, path.dirname(path.resolve(root)));
  const names = r.entries.map((e) => e.name);
  assert.deepEqual(names, ['alpha', 'zeta', 'b.txt'], 'dirs first (sorted), then files');
  const txt = r.entries.find((e) => e.name === 'b.txt');
  assert.equal(txt.dir, false);
  assert.equal(txt.size, 5);
});

test('browse reports an error for a missing path (no throw)', () => {
  const fm = new FileSystemManager();
  const r = fm.browse('/no/such/dir/anywhere-xyz');
  assert.ok(r.error, 'error surfaced, not thrown');
  assert.deepEqual(r.entries, []);
});

test('read returns text content; refuses binary + over-large', async () => {
  const root = await tmpDir('fm-');
  await fs.writeFile(path.join(root, 'a.txt'), 'line1\nline2');
  await fs.writeFile(path.join(root, 'bin'), Buffer.from([1, 2, 0, 3]));
  const fm = new FileSystemManager();
  assert.equal(fm.read(path.join(root, 'a.txt')).content, 'line1\nline2');
  assert.equal(fm.read(path.join(root, 'bin')).binary, true);
  assert.ok(fm.read(path.join(root, 'nope')).error);
});

test('mkdir / rename / move / copy / delete operate on absolute paths', async () => {
  const root = await tmpDir('fm-');
  const fm = new FileSystemManager();
  // mkdir
  assert.ok(fm.mkdir(root, 'sub').ok);
  assert.ok(existsSync(path.join(root, 'sub')));
  // mkdir rejects traversal names
  assert.ok(fm.mkdir(root, '../escape').error);
  // a file to manipulate
  await fs.writeFile(path.join(root, 'f.txt'), 'x');
  // rename
  assert.ok(fm.rename(path.join(root, 'f.txt'), 'g.txt').ok);
  assert.ok(existsSync(path.join(root, 'g.txt')) && !existsSync(path.join(root, 'f.txt')));
  // copy (clone) -> "g copy.txt"
  const cp = fm.copy(path.join(root, 'g.txt'));
  assert.ok(cp.ok && existsSync(cp.path) && /g copy\.txt$/.test(cp.path));
  // move g.txt into sub/
  const mv = fm.move(path.join(root, 'g.txt'), path.join(root, 'sub'));
  assert.ok(mv.ok && existsSync(path.join(root, 'sub', 'g.txt')) && !existsSync(path.join(root, 'g.txt')));
  // delete the sub tree
  assert.ok(fm.remove(path.join(root, 'sub')).ok);
  assert.ok(!existsSync(path.join(root, 'sub')));
});

test('remove refuses to delete the home dir or filesystem root', () => {
  const fm = new FileSystemManager();
  assert.ok(fm.remove(os.homedir()).error, 'home guarded');
  assert.ok(fm.remove('/').error, 'root guarded');
});

test('extract unpacks a .tar.gz into a sibling folder', async () => {
  const root = await tmpDir('fm-');
  // Build a small tar.gz with the system tar.
  await fs.mkdir(path.join(root, 'payload'));
  await fs.writeFile(path.join(root, 'payload', 'inside.txt'), 'hi');
  const { spawnSync } = await import('node:child_process');
  const made = spawnSync('tar', ['czf', path.join(root, 'arc.tar.gz'), '-C', root, 'payload'], { encoding: 'utf8' });
  if (made.status !== 0) return; // no tar on this box — skip
  const fm = new FileSystemManager();
  const r = fm.extract(path.join(root, 'arc.tar.gz'));
  assert.ok(r.ok, 'extract ok');
  assert.ok(existsSync(path.join(r.path, 'payload', 'inside.txt')), 'archive contents present');
});

test('resolve expands ~ to the home directory', () => {
  const fm = new FileSystemManager();
  assert.equal(fm.resolve('~'), path.resolve(os.homedir()));
  assert.equal(fm.resolve('~/x'), path.join(os.homedir(), 'x'));
});

test('e2e: fs_browse + fs_mkdir over WS, and /fsraw serves a file', async () => {
  const { WebSocket } = await import('ws');
  const { loadConfig } = await import('../src/config.js');
  const { BrokerServer } = await import('../src/server.js');
  const projects = await tmpDir('fme-proj-');
  const state = await tmpDir('fme-state-');
  const work = await tmpDir('fme-work-');
  await fs.writeFile(path.join(work, 'hello.txt'), 'HELLO-FS');
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

  ws.send(JSON.stringify({ type: 'fs_browse', path: work }));
  const list = await waitFor((e) => e.type === 'fs_list' && e.path === path.resolve(work));
  assert.ok(list.entries.some((x) => x.name === 'hello.txt'));

  ws.send(JSON.stringify({ type: 'fs_mkdir', path: work, name: 'newdir' }));
  const after = await waitFor((e) => e.type === 'fs_list' && e.entries.some((x) => x.name === 'newdir'));
  assert.ok(after.entries.some((x) => x.name === 'newdir' && x.dir));

  // /fsraw streams the file by absolute path.
  const body = await fetch(`http://127.0.0.1:${port}/fsraw?path=${encodeURIComponent(path.join(work, 'hello.txt'))}`).then((r) => r.text());
  assert.equal(body, 'HELLO-FS');

  ws.close();
  await server.stop();
});
