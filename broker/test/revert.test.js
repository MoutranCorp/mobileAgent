import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { TranscriptStore } from '../src/controls/transcript.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('TranscriptStore.truncateBefore drops the turn and everything after, and rewrites disk', async () => {
  const state = await tmpDir('rv-state-');
  const store = new TranscriptStore(state);
  store.setProject('proj-1');
  store.replace([
    { type: 'user_echo', text: 'first', turnId: 't1' },
    { type: 'assistant_text', delta: 'reply one' },
    { type: 'user_echo', text: 'second', turnId: 't2' },
    { type: 'assistant_text', delta: 'reply two' },
  ]);
  const removed = store.truncateBefore('t2');
  assert.equal(removed, 2, 'the t2 echo + its reply are removed');
  assert.deepEqual(store.replay().map((r) => r.type), ['user_echo', 'assistant_text']);
  assert.equal(store.truncateBefore('nope'), null, 'unknown turn -> null');
  // a fresh store reading the same file sees the truncated state (disk rewritten)
  const reopened = new TranscriptStore(state);
  reopened.setProject('proj-1');
  assert.equal(reopened.replay().length, 2);
});

test('e2e: revert restores the conversation to before a user message', async () => {
  const projects = await tmpDir('rv-proj-');
  const stateDir = await tmpDir('rv-st-');
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', stateDir]);
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
  const countResults = () => events.filter((e) => e.type === 'result').length;
  const waitResults = (n) => waitFor(() => countResults() >= n);

  ws.send(JSON.stringify({ type: 'user_message', text: 'first message' }));
  const echo1 = await waitFor((e) => e.type === 'user_echo' && e.text === 'first message');
  assert.ok(echo1.turnId, 'user_echo carries a turnId for revert');
  await waitResults(1);
  ws.send(JSON.stringify({ type: 'user_message', text: 'second message' }));
  await waitFor((e) => e.type === 'user_echo' && e.text === 'second message');
  await waitResults(2);

  // Revert to before the FIRST message — conversation-only (temp dir isn't a git repo).
  ws.send(JSON.stringify({ type: 'revert', turnId: echo1.turnId, checkpointId: null, text: 'first message' }));
  const reverted = await waitFor((e) => e.type === 'reverted');
  assert.equal(reverted.ok, true);
  assert.equal(reverted.text, 'first message', 'echoes the text back for the composer');

  // The TRANSCRIPT reset after revert must no longer contain either user message.
  const resets = events.filter((e) => e.type === 'transcript' && e.reset);
  const last = resets[resets.length - 1];
  const texts = (last.events || []).filter((r) => r.type === 'user_echo').map((r) => r.text);
  assert.ok(!texts.includes('first message') && !texts.includes('second message'), 'reverted both turns');

  ws.close();
  await server.stop();
});
