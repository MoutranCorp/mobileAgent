import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerEngine, resolveCodexLaunch } from '../src/engines/codex-app-server.js';
import { EventType, StatusState } from '../src/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs');

function collect(engine, { autoApprove = true } = {}) {
  const events = [];
  engine.on('event', (e) => {
    events.push(e);
    if (autoApprove && e.type === EventType.PERMISSION_REQUEST) {
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

test('codex app-server maps real approval request names and response shapes', async () => {
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
  assert.equal(text, 'Hello from Codex accepted');

  const thinking = events
    .filter((e) => e.type === EventType.ASSISTANT_THINKING)
    .map((e) => e.delta)
    .join('');
  assert.equal(thinking, 'Thinking. ');

  const permission = events.find((e) => e.type === EventType.PERMISSION_REQUEST);
  assert.equal(permission.action, 'command');
  assert.equal(permission.toolName, 'Shell');
  assert.equal(permission.input.command, 'npm test');

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

test('codex app-server maps tool user input through the question flow', async () => {
  const cwd = await tmpProject();
  const engine = makeEngine(cwd, { env: { FAKE_CODEX_MODE: 'toolInput' } });
  const events = collect(engine, { autoApprove: false });

  await engine.start();
  const question = waitForEvent(engine, (e) => e.type === EventType.QUESTION_REQUEST);
  const done = waitForEvent(engine, (e) => e.type === EventType.RESULT);
  await engine.send({ type: 'user_message', text: 'ask me' });
  const q = await question;
  assert.equal(q.id, 'tool-input-1');
  assert.equal(q.questions[0].question, 'Pick a color');

  engine.respondQuestion(q.id, [{ header: 'Color', question: 'Pick a color', selected: ['Blue'], custom: 'teal' }]);
  await done;

  const resolved = events.find((e) => e.type === EventType.QUESTION_RESOLVED);
  assert.equal(resolved.id, 'tool-input-1');
  const text = events.filter((e) => e.type === EventType.ASSISTANT_TEXT).map((e) => e.delta).join('');
  assert.match(text, /q-color/);
  assert.match(text, /Blue/);
  assert.match(text, /teal/);

  await engine.stop();
});

test('codex app-server converts broker attachments instead of dropping them', async () => {
  const cwd = await tmpProject();
  const engine = makeEngine(cwd, { env: { FAKE_CODEX_MODE: 'inputEcho' } });
  const events = collect(engine);

  await engine.start();
  const done = waitForEvent(engine, (e) => e.type === EventType.RESULT);
  await engine.send({
    type: 'user_message',
    text: 'see attachments',
    attachments: [
      { name: 'pixel.png', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' },
      { name: 'notes.txt', mime: 'text/plain', dataBase64: Buffer.from('hello notes').toString('base64') },
    ],
  });
  await done;

  const text = events.filter((e) => e.type === EventType.ASSISTANT_TEXT).map((e) => e.delta).join('');
  assert.match(text, /localImage:path/);
  assert.match(text, /Attached file notes\.txt/);
  assert.match(text, /hello notes/);

  await engine.stop();
});

test('codex app-server interrupts with turn/interrupt and the active turn id', async () => {
  const cwd = await tmpProject();
  const engine = makeEngine(cwd, { env: { FAKE_CODEX_MODE: 'interrupt' } });
  const events = collect(engine);

  await engine.start();
  await engine.send({ type: 'user_message', text: 'stop me' });
  const done = waitForEvent(engine, (e) => e.type === EventType.RESULT);
  engine.interrupt();
  await done;

  const result = events.find((e) => e.type === EventType.RESULT);
  assert.equal(result.subtype, 'interrupted');

  await engine.stop();
});

test('codex config warnings are logged instead of shown as toasts', async () => {
  const cwd = await tmpProject();
  const engine = makeEngine(cwd);
  const events = collect(engine);

  engine._mapNotification('configWarning', { message: 'This session was recorded with another model.' });

  assert.equal(events.some((e) => e.type === EventType.TOAST), false);
  const log = events.find((e) => e.type === EventType.LOG);
  assert.equal(log.level, 'warn');
  assert.match(log.message, /Codex config warning/);
});

test('codex launch resolver uses the npm package JS on Windows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-launch-'));
  const js = path.join(root, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await fs.mkdir(path.dirname(js), { recursive: true });
  await fs.writeFile(js, '#!/usr/bin/env node\n');

  const launch = resolveCodexLaunch('codex', ['app-server', '--stdio'], { APPDATA: root }, 'win32');

  assert.equal(launch.command, process.execPath);
  assert.equal(launch.args[0], js);
  assert.deepEqual(launch.args.slice(1), ['app-server', '--stdio']);
});
