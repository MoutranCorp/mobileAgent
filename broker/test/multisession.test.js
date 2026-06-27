import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

// Boot a broker with the named project folders created under the projects dir.
async function boot(names) {
  const projects = await tmpDir('ms-proj-');
  const state = await tmpDir('ms-state-');
  for (const n of names) await fs.mkdir(path.join(projects, n), { recursive: true });
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 9000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  // Only matches events that arrive AFTER subscription (ignores stale snapshots).
  const waitNext = (pred, ms = 9000) => new Promise((resolve, reject) => {
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const open = async (projectId) => {
    const p = waitNext((e) => e.type === 'sessions' && e.activeKey === projectId); // subscribe before send
    send({ type: 'open_project', projectId });
    await p;
  };
  return { server, ws, port, events, waitFor, waitNext, send, open, projectsDir: projects };
}

test('multiple live sessions per folder: new_session keeps the first alive, distinct keys, same project', async () => {
  const { server, ws, send, waitFor, open } = await boot(['projA']);
  try {
    await open('projA');
    assert.equal(server.session.activeKey, 'projA'); // first session key === projectId (back-compat)
    send({ type: 'new_session' });
    await waitFor((e) => e.type === 'sessions' && e.items.length === 2);
    const keys = server.session.liveSessions().map((s) => s.key).sort();
    assert.deepEqual(keys, ['projA', 'projA#1']);
    const pids = server.session.liveSessions().map((s) => s.projectId);
    assert.deepEqual(pids, ['projA', 'projA'], 'both sessions in the same folder');
    assert.equal(server.session.engines.size, 2, 'both engines live concurrently');
    assert.equal(server.session.activeKey, 'projA#1', 'the new session is focused');
  } finally { ws.close(); await server.stop(); }
});

test('_projectForKey resolves a suffixed session key to its folder via meta', async () => {
  const { server, ws, send, waitFor, open } = await boot(['projA']);
  try {
    await open('projA');
    send({ type: 'new_session' });
    await waitFor((e) => e.type === 'sessions' && e.items.length === 2);
    // 'projA#2' is not a projectId — old code would return null.
    assert.equal(server._projectForKey('projA#1')?.id, 'projA');
    assert.equal(server._projectForKey('projA')?.id, 'projA'); // first session still resolves
  } finally { ws.close(); await server.stop(); }
});

test('liveSessions() carries the resource/lifecycle fields the sampler needs', async () => {
  const { server, ws, open } = await boot(['projA']);
  try {
    await open('projA');
    const s = server.session.liveSessions()[0];
    for (const k of ['key', 'projectId', 'sessionId', 'busy', 'active', 'pid', 'status', 'idleMs', 'pinned', 'title']) {
      assert.ok(k in s, `liveSessions item has ${k}`);
    }
    assert.ok(['working', 'idle'].includes(s.status));
    assert.equal(typeof s.idleMs, 'number');
    assert.equal(s.active, true);
  } finally { ws.close(); await server.stop(); }
});

test('RESOURCES is emitted on connect with a valid shape', async () => {
  const { server, ws, waitFor } = await boot(['projA']);
  try {
    const r = await waitFor((e) => e.type === 'resources');
    for (const k of ['mem', 'broker', 'agentsRssMb', 'engines', 'cpu', 'hasProc']) assert.ok(k in r, `resources has ${k}`);
    assert.ok(r.mem.totalMb > 0 && r.mem.usedPct >= 0 && r.mem.usedPct <= 100);
    assert.ok(Array.isArray(r.engines));
  } finally { ws.close(); await server.stop(); }
});

test('SESSION_STOP tears down a background engine but keeps its meta (resume hint)', async () => {
  const { server, ws, send, waitNext, open } = await boot(['projA', 'projB']);
  try {
    await open('projA');
    await open('projB'); // active = projB, projA in the background
    assert.equal(server.session.engines.size, 2);
    // A stopped session now stays in the list as SLEEPING (kept in the workspace as a
    // dormant tab) rather than vanishing — its engine is gone but meta survives.
    const p = waitNext((e) => e.type === 'sessions' && e.items.some((s) => s.key === 'projA' && s.sleeping));
    send({ type: 'session_stop', key: 'projA' });
    await p;
    assert.equal(server.session.engines.has('projA'), false, 'engine torn down');
    assert.equal(server.session.meta.has('projA'), true, 'meta (transcript/resume hint) retained');
    assert.ok(server.session.uiSessions().some((s) => s.key === 'projA' && s.sleeping), 'reported as sleeping, not dropped');
  } finally { ws.close(); await server.stop(); }
});

test('idle eviction respects pinned + active, and cold-resume restarts in the session OWN folder', async () => {
  const { server, ws, open } = await boot(['projA', 'projB', 'projC']);
  try {
    await open('projA');
    await open('projB');
    await open('projC'); // active = projC; projA, projB idle in the background
    assert.equal(server.session.engines.size, 3);

    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    server.session.setPinned('projA', true);          // pinned -> never evicted
    server.session.meta.get('projA').lastActivityTs = sixMinAgo;
    server.session.meta.get('projB').lastActivityTs = sixMinAgo; // idle + unpinned -> evictable
    // projC is active -> never evicted

    server._lifecycleTick(); // one deterministic lifecycle pass

    assert.equal(server.session.engines.has('projB'), false, 'idle/unpinned/background evicted');
    assert.equal(server.session.engines.has('projA'), true, 'pinned survives');
    assert.equal(server.session.engines.has('projC'), true, 'active survives');
    assert.equal(server.session.meta.has('projB'), true, 'evicted session keeps its meta for cold-resume');

    // Cold-resume the evicted background session — must spawn in projB's folder,
    // not the globally-active projC.
    await server.session.ensureEngine('projB');
    const cwd = String(server.session.engines.get('projB').cwd);
    assert.ok(cwd.includes('projB') && !cwd.includes('projC'), `cold-resumed in own folder (${cwd})`);
  } finally { ws.close(); await server.stop(); }
});

test('resume into a different folder does NOT clobber the currently-active session (key guard)', async () => {
  const { server, ws, open } = await boot(['projA', 'projB']);
  try {
    await open('projA');
    await open('projB'); // active = projB; both engines live
    const origProjB = server.session.engines.get('projB');
    // RESUME's effect: activate projA's folder, then resume — without updating activeKey.
    server.projects.setActive('projA');
    await server.session.resume('fake-resume-id');
    // projB's live background session must be untouched (not stopped/replaced).
    assert.equal(server.session.engines.get('projB'), origProjB, 'projB engine instance unchanged');
    assert.notEqual(origProjB.state, 'stopped', 'projB engine still running');
    assert.equal(server.session.meta.get('projB').projectId, 'projB', 'projB meta not corrupted');
    // The resume targeted projA in projA's folder.
    assert.equal(server.session.activeKey, 'projA');
    assert.ok(String(server.session.engines.get('projA').cwd).includes('projA'));
  } finally { ws.close(); await server.stop(); }
});

test('cold-resume after the project folder is deleted stays in its OWN folder (meta.cwd), not the active one', async () => {
  const { server, ws, open, projectsDir } = await boot(['projA', 'projB']);
  try {
    await open('projA');
    await open('projB'); // active = projB; projA in the background
    await server.session.stopEngineKeepTranscript('projA'); // evict projA (meta + cwd kept)
    await fs.rm(path.join(projectsDir, 'projA'), { recursive: true, force: true }); // delete its folder
    assert.equal(server.projects.get('projA'), null, 'project no longer on disk');
    await server.session.ensureEngine('projA'); // cold-resume the evicted session
    const cwd = String(server.session.engines.get('projA').cwd);
    assert.ok(cwd.includes('projA') && !cwd.includes('projB'), `resumed in its own folder, not the active one (${cwd})`);
    assert.equal(server.session.meta.get('projA').projectId, 'projA', 'projectId preserved despite deletion');
  } finally { ws.close(); await server.stop(); }
});

test('SWITCH_SESSION keeps projects.activeId synced to the focused session project', async () => {
  const { server, ws, send, waitNext, open } = await boot(['projA', 'projB']);
  try {
    await open('projA');
    const p1 = waitNext((e) => e.type === 'sessions' && e.items.length === 2);
    send({ type: 'new_session' });           // projA#1 in projA
    await p1;
    await open('projB');                      // now active projB
    const p2 = waitNext((e) => e.type === 'sessions' && e.activeKey === 'projA#1');
    send({ type: 'switch_session', key: 'projA#1' });
    await p2;
    assert.equal(server.session.activeKey, 'projA#1');
    assert.equal(server.projects.activeId, server.session.meta.get('projA#1').projectId, 'activeId tracks the focused session folder');
    assert.equal(server.projects.activeId, 'projA');
  } finally { ws.close(); await server.stop(); }
});
