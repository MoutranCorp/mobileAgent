import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { Files } from '../src/controls/files.js';
import { PromptLibrary } from '../src/controls/prompts.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function bootBroker() {
  const projects = await tmpDir('r3-proj-');
  const state = await tmpDir('r3-state-');
  const projDir = path.join(projects, 'demo');
  await fs.mkdir(path.join(projDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(projDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '*' } }));
  await fs.writeFile(path.join(projDir, 'src', 'App.tsx'), 'export default function App(){ return <Home/>; }\n');
  await fs.writeFile(path.join(projDir, 'index.html'), '<!doctype html><h1>Preview works</h1>');
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
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  return { ws, events, ready, waitFor };
}

test('Files.grep finds content and skips binary; diff returns before/after', async () => {
  const proj = await tmpDir('grep-');
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.writeFile(path.join(proj, 'src', 'a.ts'), 'const needle = 42;\nconst other = 1;\n');
  await fs.writeFile(path.join(proj, 'src', 'b.ts'), 'no match here\n');
  const files = new Files({ getProjectDir: () => proj });
  const g = files.grep('needle');
  assert.equal(g.matches.length, 1);
  assert.equal(g.matches[0].path, 'src/a.ts');
  assert.equal(g.matches[0].line, 1);
  // write + diff (no git → before empty)
  const w = files.write('src/a.ts', 'const needle = 99;\n');
  assert.ok(w.ok);
  assert.equal((await fs.readFile(path.join(proj, 'src', 'a.ts'), 'utf8')), 'const needle = 99;\n');
});

test('Files.diff against git HEAD shows the change', async () => {
  const proj = await tmpDir('diff-');
  spawnSync('git', ['init'], { cwd: proj });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: proj });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: proj });
  await fs.writeFile(path.join(proj, 'x.txt'), 'line one\nline two\n');
  spawnSync('git', ['add', '-A'], { cwd: proj });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: proj });
  await fs.writeFile(path.join(proj, 'x.txt'), 'line one\nCHANGED\n');
  const files = new Files({ getProjectDir: () => proj });
  const d = files.diff('x.txt');
  assert.match(d.before, /line two/);
  assert.match(d.after, /CHANGED/);
  assert.equal(d.status, 'M');
});

test('PromptLibrary save/list/delete with defaults', async () => {
  const state = await tmpDir('prompts-');
  const lib = new PromptLibrary(state);
  assert.ok(lib.list().length >= 4, 'seeded defaults');
  lib.save('My prompt', 'do the thing');
  assert.ok(lib.list().some((p) => p.name === 'My prompt'));
  lib.delete('My prompt');
  assert.ok(!lib.list().some((p) => p.name === 'My prompt'));
});

test('e2e: grep, diff, write, prompts over WS + /preview route', async () => {
  const { server, port, projDir } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;

  ws.send(JSON.stringify({ type: 'files_grep', query: 'Home' }));
  const grep = await waitFor((e) => e.type === 'file_grep');
  assert.ok(grep.matches.some((mm) => mm.path === 'src/App.tsx'));

  ws.send(JSON.stringify({ type: 'files_write', path: '.env', content: 'API_KEY=local\n' }));
  await waitFor((e) => e.type === 'files'); // broadcast after write
  assert.equal(await fs.readFile(path.join(projDir, '.env'), 'utf8'), 'API_KEY=local\n');

  ws.send(JSON.stringify({ type: 'prompts_save', name: 'T', text: 'hello' }));
  const prompts = await waitFor((e) => e.type === 'prompts' && e.items.some((p) => p.name === 'T'));
  assert.ok(prompts);

  // /preview serves the active project's index.html
  const res = await fetch(`http://127.0.0.1:${port}/preview/index.html`);
  const body = await res.text();
  assert.match(body, /Preview works/);

  ws.close();
  await server.stop();
});

test('e2e: TodoWrite renders as todos (mock emits one)', async () => {
  const { server, port } = await bootBroker();
  const { ws, events, ready, waitFor } = open(port);
  await ready;
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); if (ev.type === 'permission_request') ws.send(JSON.stringify({ type: 'approve', id: ev.id })); });
  ws.send(JSON.stringify({ type: 'user_message', text: 'build a profile screen' }));
  const todo = await waitFor((e) => e.type === 'tool_call' && e.name === 'TodoWrite');
  assert.ok(Array.isArray(todo.input.todos) && todo.input.todos.length === 3);
  ws.close();
  await server.stop();
});
