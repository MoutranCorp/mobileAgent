import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

async function boot(names) {
  const projects = await tmpDir('cron-proj-');
  const state = await tmpDir('cron-state-');
  for (const n of names) await fs.mkdir(path.join(projects, n), { recursive: true });
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const open = (projectId) => new Promise((resolve) => {
    const onMsg = (raw) => { const ev = JSON.parse(raw.toString()); if (ev.type === 'sessions' && ev.activeKey === projectId) { ws.off('message', onMsg); resolve(); } };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'open_project', projectId }));
  });
  return { server, ws, open };
}

const waitFor = async (fn, ms = 9000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout');
};

test('a due cron job fires a background session without disturbing the foreground', async () => {
  const { server, ws, open } = await boot(['projA']);
  try {
    await open('projA');
    assert.equal(server.session.activeKey, 'projA');

    const job = server.cron.create({ name: 'Nightly', prompt: 'do the scheduled task', projectId: 'projA',
      schedule: { cron: '*/5 * * * *' }, sessionMode: 'fresh' });
    job.createdAt = Date.now() - 10 * 60 * 1000; // make it overdue
    assert.equal(server.cron.due(Date.now()).length, 1);

    await server._cronTick();

    // A new background session was spawned in projA, and the FOREGROUND is unchanged.
    assert.equal(server.session.activeKey, 'projA', 'foreground active session preserved');
    assert.equal(server.session._activeKeyByProject.get('projA'), 'projA', 'foreground project binding NOT hijacked by cron');
    const j = server.cron.get(job.id);
    assert.ok(j.lastSessionKey && j.lastSessionKey !== 'projA', 'cron used its own session key, not the foreground');
    assert.ok(['running', 'ok'].includes(j.lastStatus), 'job marked running/ok');
    assert.ok(j.lastRun, 'lastRun stamped');

    // The mock finishes the turn → the job is marked ok and its session id captured.
    await waitFor(() => server.cron.get(job.id).lastStatus === 'ok');
    assert.ok(server.cron.get(job.id).lastSessionId, 'captured the run session id');
    assert.equal(server.cron.due(Date.now()).length, 0, 'not immediately due again after running');
  } finally { ws.close(); await server.stop(); }
});

test('run-now fires immediately regardless of schedule; persistent mode reuses a stable key', async () => {
  const { server, ws, open } = await boot(['projB']);
  try {
    await open('projB');
    const job = server.cron.create({ prompt: 'persistent task', projectId: 'projB',
      schedule: { cron: '0 0 1 1 *' }, sessionMode: 'persistent' }); // Jan 1 — far off
    assert.equal(server.cron.due(Date.now()).length, 0, 'not due by schedule');

    await server._fireCronJob(server.cron.get(job.id));
    assert.equal(server.cron.get(job.id).lastSessionKey, `cron:${job.id}`, 'persistent job uses a stable cron:<id> key');
    await waitFor(() => server.cron.get(job.id).lastStatus === 'ok');
    assert.ok(server.session.activeKey === 'projB', 'foreground preserved through a persistent run');
  } finally { ws.close(); await server.stop(); }
});

test('cron job applies per-job model/effort overrides and notifies on completion', async () => {
  const { server, ws, open } = await boot(['projD']);
  try {
    await open('projD');
    const savedEffort = server.session.effort;
    // Listen for the completion notification (a toast flagged notify:true).
    const doneToast = new Promise((resolve) => {
      const onMsg = (raw) => { const ev = JSON.parse(raw.toString());
        if (ev.type === 'toast' && ev.notify && /finished|failed/i.test(ev.message || '')) { ws.off('message', onMsg); resolve(ev); } };
      ws.on('message', onMsg);
    });
    const job = server.cron.create({ prompt: 'task', projectId: 'projD',
      schedule: { cron: '0 0 1 1 *' }, sessionMode: 'fresh', model: 'mock-special', effort: 'low' });

    await server._fireCronJob(server.cron.get(job.id));
    const key = server.cron.get(job.id).lastSessionKey;
    assert.ok(key && key !== 'projD', 'cron used its own session key');
    assert.equal(server.session.meta.get(key).model, 'mock-special', 'per-job model override applied to the cron session');
    assert.equal(server.session.effort, savedEffort, 'the global effort pref is NOT mutated by a cron run');

    const t = await doneToast;
    assert.match(t.title || '', /scheduled job/i);
    assert.equal(t.notify, true, 'completion fires a notify-flagged toast');
  } finally { ws.close(); await server.stop(); }
});

test('cron CRUD over the wire broadcasts cron_jobs', async () => {
  const { server, ws, open } = await boot(['projC']);
  try {
    await open('projC');
    const got = new Promise((resolve) => {
      const onMsg = (raw) => { const ev = JSON.parse(raw.toString()); if (ev.type === 'cron_jobs' && ev.jobs.some((j) => j.name === 'Wire')) { ws.off('message', onMsg); resolve(ev); } };
      ws.on('message', onMsg);
    });
    ws.send(JSON.stringify({ type: 'cron_create', name: 'Wire', prompt: 'x', projectId: 'projC', schedule: { source: 'preset', preset: { every: 'hours', n: 6 } } }));
    const ev = await got;
    const j = ev.jobs.find((x) => x.name === 'Wire');
    assert.equal(j.schedule.cron, '0 */6 * * *');
    assert.ok(j.nextRun > Date.now(), 'nextRun computed for the client');
  } finally { ws.close(); await server.stop(); }
});
