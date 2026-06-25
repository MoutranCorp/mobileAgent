import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { UsageLedger } from '../src/controls/usage-ledger.js';
import { Checkpoints } from '../src/controls/checkpoints.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function bootBroker() {
  const projects = await tmpDir('l2-proj-');
  const state = await tmpDir('l2-state-');
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
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 12000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  return { ws, events, ready, waitFor };
}

test('UsageLedger aggregates by day and totals', async () => {
  const state = await tmpDir('usage-');
  const led = new UsageLedger(state);
  led.record({ inTok: 100, outTok: 50, cost: 0.01, profile: 'claude-max' });
  led.record({ inTok: 200, outTok: 70, cost: null, profile: 'claude-max' });
  const s = led.summary();
  assert.equal(s.total.in, 300);
  assert.equal(s.total.out, 120);
  assert.equal(s.total.turns, 2);
  assert.ok(s.days.length >= 1);
});

test('Checkpoints.changesSince lists files changed since a snapshot', async () => {
  const proj = await tmpDir('cpd-proj-');
  const state = await tmpDir('cpd-state-');
  spawnSync('git', ['init'], { cwd: proj });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: proj });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: proj });
  await fs.writeFile(path.join(proj, 'a.txt'), 'one');
  spawnSync('git', ['add', '-A'], { cwd: proj });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: proj });
  const cps = new Checkpoints({ stateDir: state });
  const cp = cps.snapshot('demo', proj, 'before');
  await fs.writeFile(path.join(proj, 'a.txt'), 'two');     // modify
  await fs.writeFile(path.join(proj, 'b.txt'), 'new file'); // add
  const ch = cps.changesSince('demo', proj, cp.id);
  const paths = ch.files.map((f) => f.path);
  assert.ok(paths.includes('a.txt'), 'modified file listed');
  assert.ok(paths.includes('b.txt'), 'new file listed');
  // show() returns the snapshot's version
  assert.equal(cps.show('demo', proj, cp.id, 'a.txt'), 'one');
});

test('e2e: auto-verify runs after a turn, fails, and re-prompts (bounded)', async () => {
  const { server, port } = await bootBroker();
  const { ws, events, ready, waitFor } = open(port);
  await ready;
  // A verify command that always fails, max 1 attempt → exactly one fix re-prompt.
  ws.send(JSON.stringify({ type: 'autoverify_set', enabled: true, command: 'node -e "process.exit(1)"', maxIterations: 1 }));
  await waitFor((e) => e.type === 'autoverify' && e.enabled === true);
  ws.send(JSON.stringify({ type: 'user_message', text: 'hello there' }));
  // first turn completes → verify runs → fails → state 'failed' (iteration 1)
  const failed = await waitFor((e) => e.type === 'autoverify' && e.state === 'failed');
  assert.equal(failed.iteration, 1);
  // the fix message is sent to the agent → next turn → verify again → maxed
  const maxed = await waitFor((e) => e.type === 'autoverify' && e.state === 'maxed');
  assert.ok(maxed);
  ws.close();
  await server.stop();
});

test('e2e: usage_summary reflects a turn, checkpoint_diff over WS', async () => {
  const { server, port, projDir } = await bootBroker();
  // make project a git repo so checkpoints work
  spawnSync('git', ['init'], { cwd: projDir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: projDir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: projDir });
  spawnSync('git', ['add', '-A'], { cwd: projDir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: projDir });
  const { ws, ready, waitFor } = open(port);
  await ready;
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); if (ev.type === 'permission_request') ws.send(JSON.stringify({ type: 'approve', id: ev.id })); });
  ws.send(JSON.stringify({ type: 'user_message', text: 'build a home screen' }));
  await waitFor((e) => e.type === 'usage'); // mock emits usage
  ws.send(JSON.stringify({ type: 'usage_summary' }));
  const stats = await waitFor((e) => e.type === 'usage_stats');
  assert.ok(stats.summary.total.turns >= 1);

  // a checkpoint was auto-created before the turn; review changes since it
  const cps = await waitFor((e) => e.type === 'checkpoints' && e.items.length > 0);
  ws.send(JSON.stringify({ type: 'checkpoint_diff', id: cps.items[0].id }));
  const diff = await waitFor((e) => e.type === 'checkpoints_diff');
  assert.ok(Array.isArray(diff.files));
  ws.close();
  await server.stop();
});
