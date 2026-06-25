import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MockEngine } from '../src/engines/mock.js';
import { EventType } from '../src/protocol.js';

function collect(engine) {
  const events = [];
  engine.on('event', (e) => events.push(e));
  return events;
}

async function tmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-proj-'));
  return dir;
}

test('mock engine emits session_meta on start', async () => {
  const cwd = await tmpProject();
  const engine = new MockEngine({ profile: { id: 'mock', harness: 'mock', model: 'mock-1' }, cwd });
  const events = collect(engine);
  await engine.start();
  const meta = events.find((e) => e.type === EventType.SESSION_META);
  assert.ok(meta, 'expected session_meta');
  assert.equal(meta.engine, 'mock');
  assert.equal(meta.model, 'mock-1');
  await engine.stop();
});

test('mock engine streams text and ends with result for a plain message', async () => {
  const cwd = await tmpProject();
  const engine = new MockEngine({ profile: { id: 'mock', harness: 'mock' }, cwd });
  const events = collect(engine);
  await engine.start();
  await engine.send({ type: 'user_message', text: 'hello there' });
  const texts = events.filter((e) => e.type === EventType.ASSISTANT_TEXT);
  assert.ok(texts.length > 0, 'expected streamed assistant_text');
  const result = events.find((e) => e.type === EventType.RESULT);
  assert.ok(result, 'expected a result event');
  await engine.stop();
});

test('mock engine requests permission and writes a file on approve', async () => {
  const cwd = await tmpProject();
  const engine = new MockEngine({ profile: { id: 'mock', harness: 'mock' }, cwd });
  const events = collect(engine);

  // Auto-approve any permission request as soon as it appears.
  engine.on('event', (e) => {
    if (e.type === EventType.PERMISSION_REQUEST) engine.respondPermission(e.id, 'allow');
  });

  await engine.start();
  await engine.send({ type: 'user_message', text: 'build a profile screen' });

  const perm = events.find((e) => e.type === EventType.PERMISSION_REQUEST);
  assert.ok(perm, 'expected a permission_request');
  const resolved = events.find((e) => e.type === EventType.PERMISSION_RESOLVED);
  assert.equal(resolved.decision, 'allow');

  const toolResult = events.find(
    (e) => e.type === EventType.TOOL_RESULT && e.status === 'ok'
  );
  assert.ok(toolResult, 'expected a successful tool_result');

  // A real file should now exist in the project dir.
  const files = await fs.readdir(path.join(cwd, 'app'));
  assert.ok(files.some((f) => f.endsWith('.tsx')), 'expected a .tsx screen to be written');
  await engine.stop();
});

test('mock engine denies file write without creating it', async () => {
  const cwd = await tmpProject();
  const engine = new MockEngine({ profile: { id: 'mock', harness: 'mock' }, cwd });
  const events = collect(engine);
  engine.on('event', (e) => {
    if (e.type === EventType.PERMISSION_REQUEST) engine.respondPermission(e.id, 'deny');
  });
  await engine.start();
  await engine.send({ type: 'user_message', text: 'create a settings screen' });

  const denied = events.find(
    (e) => e.type === EventType.TOOL_RESULT && e.status === 'error'
  );
  assert.ok(denied, 'expected an error tool_result after deny');
  let appExists = true;
  try {
    await fs.readdir(path.join(cwd, 'app'));
  } catch {
    appExists = false;
  }
  assert.equal(appExists, false, 'no file should be written on deny');
  await engine.stop();
});
