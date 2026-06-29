import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { EngineAdapter, DEFAULT_ENGINE_FEATURES } from '../src/engines/base.js';
import { createEngine, knownHarnesses } from '../src/engines/index.js';
import { ClaudeCodeEngine } from '../src/engines/claude-code.js';
import { MockEngine } from '../src/engines/mock.js';
import { OpencodeEngine } from '../src/engines/opencode.js';
import { EventType } from '../src/protocol.js';

function collect(engine) {
  const events = [];
  engine.on('event', (e) => events.push(e));
  return events;
}

function profileFor(harness) {
  return {
    id: harness,
    label: harness,
    harness,
    model: harness === 'mock' ? 'mock-1' : null,
    billing: 'none',
  };
}

class MinimalEngine extends EngineAdapter {
  async _spawn() {}
  async send() {}
  interrupt() {}
}

test('every registered engine exposes a complete features object', () => {
  for (const harness of knownHarnesses()) {
    const engine = createEngine(profileFor(harness), {
      cwd: os.tmpdir(),
      env: {},
      log() {},
    });
    assert.equal(typeof engine.features, 'object', `${harness} features`);
    for (const key of Object.keys(DEFAULT_ENGINE_FEATURES)) {
      assert.equal(typeof engine.features[key], 'boolean', `${harness}.${key}`);
    }
  }
});

test('base optional permission and question handlers resolve visibly', () => {
  const engine = new MinimalEngine({
    profile: { id: 'minimal', harness: 'minimal' },
    cwd: os.tmpdir(),
    env: {},
  });
  const events = collect(engine);

  engine.respondPermission('perm-1', 'allow');
  engine.respondQuestion('question-1', [{ selected: ['A'] }]);

  const permission = events.find((e) => e.type === EventType.PERMISSION_RESOLVED);
  assert.equal(permission.id, 'perm-1');
  assert.equal(permission.decision, 'deny');
  assert.equal(permission.requestedDecision, 'allow');
  assert.equal(permission.unsupported, true);

  const question = events.find((e) => e.type === EventType.QUESTION_RESOLVED);
  assert.equal(question.id, 'question-1');
  assert.equal(question.unsupported, true);
  assert.equal(question.cancelled, true);

  assert.equal(events.filter((e) => e.type === EventType.LOG).length, 2);
});

test('mock capabilities keep existing fields and include feature declaration', async () => {
  const engine = new MockEngine({
    profile: { id: 'mock', harness: 'mock', model: 'mock-1' },
    cwd: os.tmpdir(),
    env: {},
  });
  const events = collect(engine);
  await engine.start();

  const caps = events.find((e) => e.type === EventType.CAPABILITIES);
  assert.ok(Array.isArray(caps.slashCommands));
  assert.ok(Array.isArray(caps.agents));
  assert.ok(Array.isArray(caps.tools));
  assert.equal(caps.model, 'mock-1');
  assert.equal(caps.features.permissions, true);
  assert.equal(caps.features.questions, true);

  await engine.stop();
});

test('claude init capabilities keep existing fields and include feature declaration', () => {
  const engine = new ClaudeCodeEngine({
    profile: { id: 'claude-max', harness: 'claude-code', model: 'opus' },
    cwd: os.tmpdir(),
    env: {},
    warmCapabilities: false,
    log() {},
  });
  const events = collect(engine);

  engine._handleSystem({
    subtype: 'init',
    session_id: 'claude-session',
    model: 'claude-opus',
    slash_commands: ['/compact'],
    agents: [{ name: 'general-purpose' }],
    mcp_servers: [{ name: 'broker', status: 'connected' }],
    tools: ['Read', 'Write'],
    output_style: 'default',
    plugins: [],
    cwd: os.tmpdir(),
  });

  const caps = events.find((e) => e.type === EventType.CAPABILITIES);
  assert.deepEqual(caps.slashCommands, ['/compact']);
  assert.deepEqual(caps.tools, ['Read', 'Write']);
  assert.equal(caps.outputStyle, 'default');
  assert.equal(caps.features.thinking, true);
  assert.equal(caps.features.permissions, true);
  assert.equal(caps.features.questions, true);
  assert.equal(caps.features.effort, true);
});

test('opencode unsupported responses are resolved instead of silently dropped', () => {
  const engine = new OpencodeEngine({
    profile: { id: 'opencode', harness: 'opencode' },
    cwd: os.tmpdir(),
    env: {},
    opencodeBin: 'opencode',
    log() {},
  });
  const events = collect(engine);

  engine.respondPermission('perm-opencode', 'allow');
  engine.respondQuestion('question-opencode', []);

  const permission = events.find((e) => e.type === EventType.PERMISSION_RESOLVED);
  assert.equal(permission.id, 'perm-opencode');
  assert.equal(permission.decision, 'deny');
  assert.equal(permission.unsupported, true);

  const question = events.find((e) => e.type === EventType.QUESTION_RESOLVED);
  assert.equal(question.id, 'question-opencode');
  assert.equal(question.unsupported, true);
});
