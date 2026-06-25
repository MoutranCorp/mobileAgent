import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';

async function tmpDir(p) {
  return fs.mkdtemp(path.join(os.tmpdir(), p));
}

async function bootBroker() {
  const projects = await tmpDir('cfg-proj-');
  const state = await tmpDir('cfg-state-');
  const projDir = path.join(projects, 'demo');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '*' } }));
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  return { server, port: server.httpServer.address().port, projDir };
}

function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    events.push(ev);
    for (const l of [...listeners]) l(ev);
  });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 8000) =>
    new Promise((resolve, reject) => {
      const ex = events.find(pred);
      if (ex) return resolve(ex);
      const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
      const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
      listeners.add(l);
    });
  return { ws, events, ready, waitFor };
}

test('mock engine emits capabilities + permission_mode + context', async () => {
  const { server, port } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({ type: 'user_message', text: 'hello' }));
  const caps = await waitFor((e) => e.type === 'capabilities');
  assert.ok(Array.isArray(caps.slashCommands) && caps.slashCommands.length > 0);
  assert.ok(Array.isArray(caps.agents));
  await waitFor((e) => e.type === 'permission_mode');
  await waitFor((e) => e.type === 'context' && e.windowTokens > 0);
  ws.close();
  await server.stop();
});

test('subagent prompt produces nested Agent tool with parentToolUseId', async () => {
  const { server, port } = await bootBroker();
  const { ws, events, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({ type: 'user_message', text: 'research the navigation setup' }));
  const agentCall = await waitFor((e) => e.type === 'tool_call' && e.name === 'Agent');
  const nested = await waitFor((e) => e.type === 'tool_call' && e.parentToolUseId === agentCall.id);
  assert.equal(nested.parentToolUseId, agentCall.id);
  await waitFor((e) => e.type === 'tool_result' && e.id === agentCall.id);
  ws.close();
  await server.stop();
});

test('config_write creates a skill on disk and lists it', async () => {
  const { server, port, projDir } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({
    type: 'config_write', kind: 'skills', name: 'deploy', scope: 'project',
    fields: { description: 'Deploy the app', allowedTools: 'Bash' },
    body: 'Run the deploy steps using $ARGUMENTS.',
  }));
  const cfg = await waitFor((e) => e.type === 'config' && e.kind === 'skills' && Array.isArray(e.items));
  assert.ok(cfg.items.some((s) => s.name === 'deploy'), 'skill should be listed');
  const file = path.join(projDir, '.claude', 'skills', 'deploy', 'SKILL.md');
  const content = await fs.readFile(file, 'utf8');
  assert.match(content, /description: Deploy the app/);
  assert.match(content, /\$ARGUMENTS/);
  ws.close();
  await server.stop();
});

test('config_write + read roundtrip for an agent', async () => {
  const { server, port } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({
    type: 'config_write', kind: 'agents', name: 'reviewer', scope: 'user',
    fields: { description: 'Reviews code', tools: 'Read, Grep', model: 'sonnet' },
    body: 'You are a meticulous reviewer.',
  }));
  await waitFor((e) => e.type === 'config' && e.kind === 'agents');
  ws.send(JSON.stringify({ type: 'config_read', kind: 'agents', name: 'reviewer', scope: 'user' }));
  const read = await waitFor((e) => e.type === 'config' && e.item && e.item.name === 'reviewer');
  assert.equal(read.item.fields.description, 'Reviews code');
  assert.match(read.item.body, /meticulous reviewer/);
  ws.close();
  await server.stop();
});

test('set_permission_mode broadcasts the new mode', async () => {
  const { server, port } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'acceptEdits' }));
  const pm = await waitFor((e) => e.type === 'permission_mode' && e.mode === 'acceptEdits');
  assert.equal(pm.mode, 'acceptEdits');
  ws.close();
  await server.stop();
});

test('settings permission rules write + list', async () => {
  const { server, port, projDir } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({
    type: 'config_write', kind: 'settings', scope: 'project',
    defaultMode: 'acceptEdits', allow: ['Bash(npm run test:*)'], deny: ['Bash(rm -rf *)'], ask: [],
  }));
  await waitFor((e) => e.type === 'config' && e.kind === 'settings');
  const settingsFile = path.join(projDir, '.claude', 'settings.json');
  const json = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(json.permissions.defaultMode, 'acceptEdits');
  assert.deepEqual(json.permissions.allow, ['Bash(npm run test:*)']);
  ws.close();
  await server.stop();
});
