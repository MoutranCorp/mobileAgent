import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { EventType } from '../src/protocol.js';
import { evictionCandidates } from '../src/controls/resources.js';

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
  return { server, ws, port, events, waitFor, waitNext, send, open, projectsDir: projects, state };
}

async function bootWithProfiles(names, profiles, defaultProfile = profiles[0].id) {
  const projects = await tmpDir('ms-proj-');
  const state = await tmpDir('ms-state-');
  for (const n of names) await fs.mkdir(path.join(projects, n), { recursive: true });
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, 'profiles.json'), JSON.stringify(profiles, null, 2));
  const config = loadConfig(['--profile', defaultProfile, '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitNext = (pred, ms = 9000) => new Promise((resolve, reject) => {
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const open = async (projectId) => {
    const p = waitNext((e) => e.type === 'sessions' && e.activeKey === projectId);
    send({ type: 'open_project', projectId });
    await p;
  };
  return { server, ws, events, waitNext, send, open, state };
}

test('multiple live sessions per folder: new_session keeps the first alive, distinct keys, same project', async () => {
  const { server, ws, send, waitFor, open } = await boot(['projA']);
  try {
    await open('projA');
    assert.equal(server.session.activeKey, 'projA'); // first session key === projectId (back-compat)
    send({ type: 'new_session' });
    await waitFor((e) => e.type === 'sessions' && e.items.length === 2);
    const keys = server.session.liveSessions().map((s) => s.key).sort();
    assert.equal(keys.length, 2);
    assert.ok(keys.includes('projA'), 'the first session keeps key === projectId');
    const fresh = keys.find((k) => k !== 'projA');
    assert.ok(/^projA-[0-9a-f]+$/.test(fresh), `the new session is a project-prefixed unique key, got ${fresh}`);
    const pids = server.session.liveSessions().map((s) => s.projectId);
    assert.deepEqual(pids, ['projA', 'projA'], 'both sessions in the same folder');
    assert.equal(server.session.engines.size, 2, 'both engines live concurrently');
    assert.equal(server.session.activeKey, fresh, 'the new session is focused');
  } finally { ws.close(); await server.stop(); }
});

// Regression: the "ago" label showed time-since-tab-open instead of time-since-last
// activity. lastTurnTs must advance on a real turn (prompt/response) but NOT on a tab
// focus (which still resets lastActivityTs, used only for idle eviction).
test('lastTurnTs tracks prompt/response, not tab focus', async () => {
  const { server, ws, open } = await boot(['projA', 'projB']);
  try {
    await open('projA');
    await open('projB'); // active = projB; projA backgrounded but live
    const past = Date.now() - 5 * 60 * 1000;
    server.session.meta.get('projA').lastTurnTs = past;
    // Focusing projA (a tab switch) must NOT count as conversation activity.
    await server.session.setActiveKey('projA');
    assert.equal(server.session.meta.get('projA').lastTurnTs, past, 'focus does not advance lastTurnTs');
    assert.ok(server.session.meta.get('projA').lastActivityTs > past, 'but focus does reset the idle timer');
    // A model result (a turn boundary) DOES advance it.
    server.session._onEngineEvent({ type: EventType.RESULT }, 'projA', 'projA');
    assert.ok(server.session.meta.get('projA').lastTurnTs > past, 'a result advances lastTurnTs');
    const live = server.session.liveSessions().find((s) => s.key === 'projA');
    assert.ok(live && typeof live.lastTurnTs === 'number', 'lastTurnTs surfaces in liveSessions');
  } finally { ws.close(); await server.stop(); }
});

test('_projectForKey resolves a suffixed session key to its folder via meta', async () => {
  const { server, ws, send, waitFor, open } = await boot(['projA']);
  try {
    await open('projA');
    send({ type: 'new_session' });
    await waitFor((e) => e.type === 'sessions' && e.items.length === 2);
    // The suffixed key (projA-<token>) is not a projectId — old code would return null.
    const fresh = server.session.liveSessions().map((s) => s.key).find((k) => k !== 'projA');
    assert.equal(server._projectForKey(fresh)?.id, 'projA');
    assert.equal(server._projectForKey('projA')?.id, 'projA'); // first session still resolves
  } finally { ws.close(); await server.stop(); }
});

test('liveSessions() carries the resource/lifecycle fields the sampler needs', async () => {
  const { server, ws, open } = await boot(['projA']);
  try {
    await open('projA');
    const s = server.session.liveSessions()[0];
    for (const k of ['key', 'projectId', 'sessionId', 'busy', 'active', 'pid', 'status', 'idleMs', 'lastTurnTs', 'pinned', 'title']) {
      assert.ok(k in s, `liveSessions item has ${k}`);
    }
    assert.ok(['working', 'idle'].includes(s.status));
    assert.equal(typeof s.idleMs, 'number');
    assert.equal(s.active, true);
  } finally { ws.close(); await server.stop(); }
});

test('inTurn marks a session working the instant a prompt is queued, protecting a background session from eviction', async () => {
  const { server, ws, open } = await boot(['projA', 'projB']);
  try {
    await open('projA');
    await open('projB'); // active = projB; projA is now a live BACKGROUND session
    // Queue a prompt into the background session but DON'T await the turn — inTurn is set
    // synchronously (before the first internal await / any engine status), so we can observe
    // the in-flight state. (Awaiting would let the mock reach RESULT, which clears inTurn.)
    const turn = server.session.sendTo('projA', 'hello');
    const live = server.session.liveSessions();
    const a = live.find((s) => s.key === 'projA');
    assert.equal(a.busy, true, 'background session is busy the instant its prompt is queued');
    assert.equal(a.status, 'working');
    assert.equal(a.idleMs, 0, 'a working session reports zero idle time');
    // Even under critical memory pressure it must NOT be an eviction candidate (a turn in
    // flight would be lost). Only a genuinely idle background session is evictable.
    const sample = { mem: { usedPct: 99 }, engines: live };
    assert.ok(!evictionCandidates(sample, { maxEvict: 5 }).includes('projA'),
      'an in-turn session is never evicted, even at critical pressure');
    await turn; // let the mock finish the turn so we don't leak a pending promise
  } finally { ws.close(); await server.stop(); }
});

test('sendUserMessage marks a COLD session working before its engine finishes spawning (no idle/💤 gap)', async () => {
  const { server, ws, open } = await boot(['projA']);
  try {
    await open('projA'); // active = projA, engine live
    await server.session.stopEngineKeepTranscript('projA'); // idle-evict -> cold; meta kept
    assert.equal(server.session.engines.has('projA'), false);
    let ui = server.session.uiSessions().find((s) => s.key === 'projA');
    assert.equal(ui.sleeping, true, 'evicted session is sleeping before we send');
    // Queue a prompt but DON'T await: inTurn is set synchronously BEFORE ensureEngine's
    // (multi-second) cold spawn, so the session must already read as working — not idle,
    // not 💤. (This is the bug the screenshot caught: inTurn used to be set AFTER the
    // await, leaving the whole cold-start window looking idle.)
    const turn = server.session.sendUserMessage('hello');
    ui = server.session.uiSessions().find((s) => s.key === 'projA');
    assert.equal(ui.busy, true, 'cold session is busy the instant the prompt is queued');
    assert.equal(ui.status, 'working');
    assert.equal(ui.sleeping, false, 'a waking session is never shown as sleeping');
    await turn; // let the cold-resume + turn complete
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
    send({ type: 'new_session' });           // a 2nd session (projA-<token>) in projA
    await p1;
    const fresh = server.session.liveSessions().map((s) => s.key).find((k) => k !== 'projA');
    await open('projB');                      // now active projB
    const p2 = waitNext((e) => e.type === 'sessions' && e.activeKey === fresh);
    send({ type: 'switch_session', key: fresh });
    await p2;
    assert.equal(server.session.activeKey, fresh);
    assert.equal(server.projects.activeId, server.session.meta.get(fresh).projectId, 'activeId tracks the focused session folder');
    assert.equal(server.projects.activeId, 'projA');
  } finally { ws.close(); await server.stop(); }
});

// Regression: two concurrent sessions in the SAME folder must each get their OWN
// Claude session id. The bug: a fresh tab fell back to _sessionByProject[projectId]
// and RESUMED the folder's first session, so every tab wrote into one .jsonl and
// only one session showed up in "All sessions".
test('concurrent sessions in the same folder get DISTINCT session ids (no resume collision)', async () => {
  const { server, ws, send, open, projectsDir } = await boot(['projA']);
  const waitState = async (fn, ms = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timeout waiting for state');
  };
  const liveKeys = () => server.session.liveSessions().map((s) => s.key);
  const freshKeys = () => liveKeys().filter((k) => k !== 'projA');
  try {
    await open('projA');
    await waitState(() => server.session.meta.get('projA')?.sessionId);
    const id1 = server.session.meta.get('projA').sessionId;

    send({ type: 'new_session' }); // fresh concurrent tab in the same folder
    await waitState(() => freshKeys().some((k) => server.session.meta.get(k)?.sessionId));
    const key2 = freshKeys()[0];
    const id2 = server.session.meta.get(key2).sessionId;

    assert.ok(id1 && id2, 'both sessions resolved a session id');
    assert.notEqual(id1, id2, 'concurrent fresh sessions must NOT share a Claude session id');

    // A third tab too — still distinct.
    send({ type: 'new_session' });
    await waitState(() => freshKeys().length === 2 && freshKeys().every((k) => server.session.meta.get(k)?.sessionId));
    const key3 = freshKeys().find((k) => k !== key2);
    const id3 = server.session.meta.get(key3).sessionId;
    assert.equal(new Set([id1, id2, id3]).size, 3, 'three tabs -> three distinct sessions');

    // The persisted resume map is keyed by session KEY, not the folder, so each
    // tab's id is recoverable independently.
    const expectResume = (key, id) => {
      const rec = server.session._sessionByProject[key];
      assert.equal(rec.resumeId, id);
      assert.equal(rec.harness, 'mock');
      assert.equal(path.resolve(rec.cwd), path.resolve(path.join(projectsDir, 'projA')));
    };
    expectResume('projA', id1);
    expectResume(key2, id2);
    expectResume(key3, id3);
  } finally { ws.close(); await server.stop(); }
});

test('sessions retain independent profile/model/effort/permission/status/capabilities across tab switches', async () => {
  const profiles = [
    { id: 'mock-a', label: 'Mock A', harness: 'mock', model: 'mock-a', models: ['mock-a'], billing: 'none' },
    { id: 'mock-b', label: 'Mock B', harness: 'mock', model: 'mock-b', models: ['mock-b'], billing: 'none' },
  ];
  const { server, ws, send, waitNext, open } = await bootWithProfiles(['projA', 'projB'], profiles, 'mock-a');
  try {
    await open('projA');
    send({ type: 'set_effort', level: 'low' });
    await waitNext((e) => e.type === 'effort' && e.level === 'low');
    send({ type: 'set_permission_mode', mode: 'acceptEdits' });
    await waitNext((e) => e.type === 'permission_mode' && e.mode === 'acceptEdits');

    await open('projB');
    send({ type: 'switch_engine', profileId: 'mock-b' });
    await waitNext((e) => e.type === 'profiles' && e.activeProfileId === 'mock-b');
    send({ type: 'set_effort', level: 'max' });
    await waitNext((e) => e.type === 'effort' && e.level === 'max');
    send({ type: 'set_permission_mode', mode: 'bypassPermissions' });
    await waitNext((e) => e.type === 'permission_mode' && e.mode === 'bypassPermissions');
    assert.equal(server.session.capabilitiesByKey.get('projB')?.model, 'mock-b');

    const a = server.session.meta.get('projA');
    const b = server.session.meta.get('projB');
    assert.equal(a.profileId, 'mock-a');
    assert.equal(a.model, 'mock-a');
    assert.equal(a.effort, 'low');
    assert.equal(a.permissionMode, 'acceptEdits');
    assert.equal(b.profileId, 'mock-b');
    assert.equal(b.model, 'mock-b');
    assert.equal(b.effort, 'max');
    assert.equal(b.permissionMode, 'bypassPermissions');
    assert.equal(server.session.capabilitiesByKey.get('projA').model, 'mock-a');
    assert.equal(server.session.capabilitiesByKey.get('projB').model, 'mock-b');

    const profileA = waitNext((e) => e.type === 'profiles' && e.activeProfileId === 'mock-a');
    const effortA = waitNext((e) => e.type === 'effort' && e.level === 'low');
    const permissionA = waitNext((e) => e.type === 'permission_mode' && e.mode === 'acceptEdits');
    const capsA = waitNext((e) => e.type === 'capabilities' && e.sessionKey === 'projA' && e.model === 'mock-a');
    send({ type: 'switch_session', key: 'projA' });
    await Promise.all([profileA, effortA, permissionA, capsA]);
    assert.equal(server.session.activeKey, 'projA');
    assert.equal(server.session.meta.get('projB').profileId, 'mock-b', 'background profile survives focus change');
    assert.equal(server.session.meta.get('projB').effort, 'max', 'background effort survives focus change');
    assert.equal(server.session.meta.get('projB').permissionMode, 'bypassPermissions', 'background permission survives focus change');
  } finally { ws.close(); await server.stop(); }
});

test('sessions.json persists resume ids with harness/cwd and refuses cross-harness resume lookup', async () => {
  const { server, ws, open, state, projectsDir } = await boot(['projA']);
  try {
    await open('projA');
    const waitState = async (fn, ms = 9000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
      throw new Error('timeout waiting for state');
    };
    await waitState(() => server.session.meta.get('projA')?.sessionId);
    server.session.flushSessionsFile();
    const id = server.session.meta.get('projA').sessionId;
    const stored = JSON.parse(fssync.readFileSync(path.join(state, 'sessions.json'), 'utf8'));
    assert.equal(stored.projA.resumeId, id);
    assert.equal(stored.projA.harness, 'mock');
    assert.equal(path.resolve(stored.projA.cwd), path.resolve(path.join(projectsDir, 'projA')));
    assert.equal(server.session._resumeIdFor('projA', 'mock'), id);
    assert.equal(server.session._resumeIdFor('projA', 'claude-code'), null);
    assert.equal(server.session._resumeIdFor('projA', 'opencode'), null);
  } finally { ws.close(); await server.stop(); }
});
