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
import { Files } from '../src/controls/files.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function bootBroker() {
  const projects = await tmpDir('l1-proj-');
  const state = await tmpDir('l1-state-');
  const projDir = path.join(projects, 'demo');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'package.json'), JSON.stringify({
    name: 'demo', dependencies: { expo: '*' },
    scripts: { test: 'echo running-tests', lint: 'echo linting', start: 'expo start' },
  }));
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

test('Files.scripts reads package.json scripts', async () => {
  const proj = await tmpDir('scr-');
  await fs.writeFile(path.join(proj, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }));
  const files = new Files({ getProjectDir: () => proj });
  const s = files.scripts();
  assert.equal(s.length, 2);
  assert.ok(s.some((x) => x.name === 'build' && x.cmd === 'tsc'));
});

test('ClaudeConfig MCP CRUD writes .mcp.json', async () => {
  const proj = await tmpDir('mcp-');
  const cc = new ClaudeConfig({ getProjectDir: () => proj });
  cc.write('mcp', 'puppeteer', 'project', { fields: { command: 'npx -y @modelcontextprotocol/server-puppeteer', args: '--headless', transport: 'stdio' } });
  const list = cc.list('mcp', 'project');
  assert.ok(list.some((s) => s.name === 'puppeteer'));
  const file = JSON.parse(await fs.readFile(path.join(proj, '.mcp.json'), 'utf8'));
  assert.ok(file.mcpServers.puppeteer.command.includes('puppeteer'));
  assert.deepEqual(file.mcpServers.puppeteer.args, ['--headless']);
  // http transport stores a url
  cc.write('mcp', 'remote', 'project', { fields: { command: 'https://host/mcp', transport: 'http' } });
  const f2 = JSON.parse(await fs.readFile(path.join(proj, '.mcp.json'), 'utf8'));
  assert.equal(f2.mcpServers.remote.url, 'https://host/mcp');
  cc.delete('mcp', 'puppeteer', 'project');
  assert.ok(!cc.list('mcp', 'project').some((s) => s.name === 'puppeteer'));
});

test('e2e: scripts_list + script_run streams output; mcp via config over WS', async () => {
  const { server, port, projDir } = await bootBroker();
  const { ws, ready, waitFor } = open(port);
  await ready;

  ws.send(JSON.stringify({ type: 'scripts_list' }));
  const scripts = await waitFor((e) => e.type === 'scripts');
  assert.ok(scripts.items.some((s) => s.name === 'test'));

  ws.send(JSON.stringify({ type: 'script_run', name: 'test' }));
  const out = await waitFor((e) => e.type === 'control_output' && e.channel === 'script:test' && /running-tests/.test(e.data), 10000);
  assert.match(out.data, /running-tests/);

  // MCP add via config_write kind mcp
  ws.send(JSON.stringify({ type: 'config_write', kind: 'mcp', name: 'fs', scope: 'project', fields: { command: 'npx -y @modelcontextprotocol/server-filesystem', transport: 'stdio' } }));
  const cfg = await waitFor((e) => e.type === 'config' && e.kind === 'mcp' && Array.isArray(e.items));
  assert.ok(cfg.items.some((s) => s.name === 'fs'));
  const mcpFile = JSON.parse(await fs.readFile(path.join(projDir, '.mcp.json'), 'utf8'));
  assert.ok(mcpFile.mcpServers.fs);

  ws.close();
  await server.stop();
});

test('e2e: github_push surfaces a github event (no remote → fails gracefully)', async () => {
  const { server, port, projDir } = await bootBroker();
  // make it a git repo with a commit so push is the only failing step
  spawnSync('git', ['init'], { cwd: projDir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: projDir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: projDir });
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.send(JSON.stringify({ type: 'github_push', message: 'first' }));
  const gh = await waitFor((e) => e.type === 'github' && e.op === 'push', 12000);
  // no 'origin' remote configured → push fails, but the broker stays up and reports it
  assert.equal(gh.ok, false);
  assert.ok(typeof gh.message === 'string');
  ws.close();
  await server.stop();
});
