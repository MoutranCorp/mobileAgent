import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerEngine } from '../src/engines/codex-app-server.js';
import { EventType, StatusState } from '../src/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs');

function collect(engine) {
  const events = [];
  engine.on('event', (e) => {
    events.push(e);
    if (e.type === EventType.PERMISSION_REQUEST) {
      engine.respondPermission(e.id, 'allow');
    }
  });
  return events;
}

function waitForEvent(engine, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off('event', onEvent);
      reject(new Error('timed out waiting for event'));
    }, timeoutMs);
    const onEvent = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      engine.off('event', onEvent);
      resolve(event);
    };
    engine.on('event', onEvent);
  });
}

async function tmpProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-server-'));
}

function makeEngine(cwd, opts = {}) {
  return new CodexAppServerEngine({
    profile: {
      id: 'codex-app-server',
      harness: 'codex-app-server',
      model: 'gpt-test',
      billing: 'none',
    },
    cwd,
    env: { FAKE_CODEX_MODE: 'approval' },
    codexBin: process.execPath,
    codexArgs: [fixture],
    log() {},
    ...opts,
  });
}

test('codex app-server starts a thread through JSON-RPC stdio and declares features', async () => {
  const cwd = await tmpProject();
  const engine = makeEngine(cwd);
  const events = collect(engine);

  await engine.start();

  const meta = events.find((e) => e.type === EventType.SESSION_META);
  assert.equal(meta.sessionId, 'thread-started-1');
  assert.equal(meta.engine, 'codex-app-server');
  assert.equal(meta.cwd, cwd);

  const caps = events.find((e) => e.type === EventType.CAPABILITIES);
  assert.equal(caps.features.appServer, true);
  assert.equal(caps.features.permissions, true);
  assert.equal(caps.features.resume, true);

  await engine.stop();
});

test('codex app-server resumes an existing thread id', async () => {
  const cwd = await tmpProject();
  const engine = makeEngine(cwd, { resumeId: 'thread-resume-42' });
  const events = collect(engine);

  await engine.start();

  const meta = events.find((e) => e.type === EventType.SESSION_META);
  assert.equal(meta.sessionId, 'thread-resume-42');

  await engine.stop();
});

test('codex app-server maps one turn, streamed deltas, approval request, and completion', async () => {
  const cwd = await tmpProject();
  const engine = makeEngine(cwd);
  const events = collect(engine);

  await engine.start();
  const done = waitForEvent(engine, (e) => e.type === EventType.RESULT);
  await engine.send({ type: 'user_message', text: 'hello codex' });
  await done;

  const text = events
    .filter((e) => e.type === EventType.ASSISTANT_TEXT)
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Hello from Codex approved');

  const thinking = events
    .filter((e) => e.type === EventType.ASSISTANT_THINKING)
    .map((e) => e.delta)
    .join('');
  assert.equal(thinking, 'Thinking. ');

  const permission = events.find((e) => e.type === EventType.PERMISSION_REQUEST);
  assert.equal(permission.action, 'exec');
  assert.equal(permission.toolName, 'Bash');
  assert.deepEqual(permission.input, { command: 'npm test' });

  const resolved = events.find((e) => e.type === EventType.PERMISSION_RESOLVED);
  assert.equal(resolved.id, 'fake-approval-1');
  assert.equal(resolved.decision, 'allow');

  const usage = events.find((e) => e.type === EventType.USAGE);
  assert.equal(usage.inTok, 11);
  assert.equal(usage.outTok, 7);

  const result = events.find((e) => e.type === EventType.RESULT);
  assert.equal(result.subtype, 'success');
  assert.equal(result.isError, false);

  const idle = events.findLast((e) => e.type === EventType.STATUS);
  assert.equal(idle.state, StatusState.IDLE);

  await engine.stop();
});
