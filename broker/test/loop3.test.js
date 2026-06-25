import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { Files } from '../src/controls/files.js';
import { TranscriptStore } from '../src/controls/transcript.js';
import { ClaudeConfig } from '../src/controls/claude-config.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function bootBroker() {
  const projects = await tmpDir('l3-proj-');
  const state = await tmpDir('l3-state-');
  const projDir = path.join(projects, 'demo');
  await fs.mkdir(path.join(projDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(projDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '*' } }));
  await fs.writeFile(path.join(projDir, 'src', 'a.ts'), 'const oldName = 1;\nuse(oldName);\n');
  await fs.writeFile(path.join(projDir, 'src', 'b.ts'), 'import { oldName } from "./a";\n');
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
  const waitFor = (pred, ms = 9000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  return { ws, events, ready, waitFor };
}

test('Files.replaceAll replaces across files and counts', async () => {
  const proj = await tmpDir('rep-');
  await fs.mkdir(path.join(proj, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(proj, 'node_modules', 'x.js'), 'oldName everywhere oldName');
  await fs.writeFile(path.join(proj, 'a.ts'), 'oldName here and oldName again');
  await fs.writeFile(path.join(proj, 'b.ts'), 'no match');
  const files = new Files({ getProjectDir: () => proj });
  const res = files.replaceAll('oldName', 'newName');
  assert.equal(res.filesChanged, 1);       // node_modules skipped
  assert.equal(res.replacements, 2);
  assert.match(await fs.readFile(path.join(proj, 'a.ts'), 'utf8'), /newName here and newName again/);
  // node_modules untouched
  assert.match(await fs.readFile(path.join(proj, 'node_modules', 'x.js'), 'utf8'), /oldName/);
});

test('TranscriptStore.search finds recorded text', async () => {
  const dir = await tmpDir('tsrch-');
  const ts = new TranscriptStore(dir);
  ts.setProject('p1');
  ts.record({ type: 'user_echo', text: 'please add a login screen' });
  ts.record({ type: 'assistant_text', delta: 'Sure, creating the LoginScreen now.' });
  const hits = ts.search('login');
  assert.ok(hits.length >= 2);
  assert.ok(hits.some((h) => /login/i.test(h.text)));
});

test('ClaudeConfig hooks add/list/delete in settings.json', async () => {
  const proj = await tmpDir('hooks-');
  const cc = new ClaudeConfig({ getProjectDir: () => proj });
  cc.write('hooks', 'PostToolUse', 'project', { fields: { event: 'PostToolUse', matcher: 'Edit', command: 'npm run lint' } });
  const list = cc.list('hooks', 'project');
  assert.equal(list.length, 1);
  assert.equal(list[0].event, 'PostToolUse');
  assert.equal(list[0].command, 'npm run lint');
  const settings = JSON.parse(await fs.readFile(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'Edit');
  cc.delete('hooks', list[0].name, 'project');
  assert.equal(cc.list('hooks', 'project').length, 0);
});

test('e2e: files_replace checkpoints + replaces; transcript_search; hooks via config', async () => {
  const { server, port, projDir } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;

  ws.send(JSON.stringify({ type: 'files_replace', query: 'oldName', replacement: 'newName' }));
  const rep = await waitFor((e) => e.type === 'file_replace');
  assert.equal(rep.replacements, 3); // a.ts x2 + b.ts x1
  assert.match(await fs.readFile(path.join(projDir, 'src', 'a.ts'), 'utf8'), /newName/);

  // record a conversation turn then search it
  ws.send(JSON.stringify({ type: 'user_message', text: 'investigate the navigation' }));
  await waitFor((e) => e.type === 'result');
  ws.send(JSON.stringify({ type: 'transcript_search', query: 'navigation' }));
  const sr = await waitFor((e) => e.type === 'transcript_search');
  assert.ok(sr.matches.length >= 1);

  // hooks via config_write
  ws.send(JSON.stringify({ type: 'config_write', kind: 'hooks', name: 'PreToolUse', scope: 'project', fields: { event: 'PreToolUse', matcher: 'Bash', command: 'echo guard' } }));
  const cfg = await waitFor((e) => e.type === 'config' && e.kind === 'hooks');
  assert.ok(cfg.items.some((h) => h.event === 'PreToolUse' && h.command === 'echo guard'));

  ws.close();
  await server.stop();
});
