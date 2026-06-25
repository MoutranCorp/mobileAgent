import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { TranscriptStore } from '../src/controls/transcript.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('TranscriptStore routes interleaved records to separate per-session buffers/files', async () => {
  const state = await tmpDir('cc-state-');
  const store = new TranscriptStore(state);
  store.setProject('A');
  store.record({ type: 'user_echo', text: 'hello A', sessionKey: 'A' });
  store.record({ type: 'user_echo', text: 'hello B', sessionKey: 'B' }); // background session
  store.record({ type: 'assistant_text', delta: 'reply A', sessionKey: 'A' });
  // Active (A) buffer must NOT contain B's content.
  const aTexts = store.replay().map((r) => r.text || r.delta);
  assert.ok(aTexts.includes('hello A') && aTexts.includes('reply A'));
  assert.ok(!aTexts.includes('hello B'), 'B did not leak into A');
  // B recorded to its own file.
  const bFile = path.join(state, 'transcripts', 'B.jsonl');
  assert.ok(fssync.existsSync(bFile));
  assert.match(fssync.readFileSync(bFile, 'utf8'), /hello B/);
  assert.doesNotMatch(fssync.readFileSync(path.join(state, 'transcripts', 'A.jsonl'), 'utf8'), /hello B/);
});

test('e2e: switching projects keeps the previous session alive and isolates transcripts', async () => {
  const projects = await tmpDir('cc-proj-');
  const state = await tmpDir('cc-st-');
  await fs.mkdir(path.join(projects, 'projA'));
  await fs.mkdir(path.join(projects, 'projB'));
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

  ws.send(JSON.stringify({ type: 'open_project', projectId: 'projA' }));
  await waitFor((e) => e.type === 'sessions' && e.activeKey === 'projA');
  ws.send(JSON.stringify({ type: 'user_message', text: 'work in A' }));
  await waitFor((e) => e.type === 'user_echo' && e.text === 'work in A');

  // Switch to B WITHOUT waiting for A to finish.
  ws.send(JSON.stringify({ type: 'open_project', projectId: 'projB' }));
  await waitFor((e) => e.type === 'sessions' && e.activeKey === 'projB');

  // Both engines are alive (A kept running in the background).
  assert.equal(server.session.engines.size, 2, 'both A and B engines live');
  assert.equal(server.session.activeKey, 'projB');
  const live = server.session.liveSessions();
  assert.ok(live.some((s) => s.key === 'projA'), 'A still listed as a live session');

  // Let A finish, then assert transcript isolation on disk.
  await waitFor((e) => e.type === 'sessions' && (e.items.find((s) => s.key === 'projA')?.busy === false));
  await new Promise((r) => setTimeout(r, 200));
  const aFile = path.join(state, 'transcripts', 'projA.jsonl');
  const bFile = path.join(state, 'transcripts', 'projB.jsonl');
  assert.match(fssync.readFileSync(aFile, 'utf8'), /work in A/, "A's turn recorded to A");
  if (fssync.existsSync(bFile)) assert.doesNotMatch(fssync.readFileSync(bFile, 'utf8'), /work in A/, "A did not leak into B");

  ws.close();
  await server.stop();
});
