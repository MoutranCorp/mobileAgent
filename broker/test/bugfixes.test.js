import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { ClaudeConfig, encodeCwd } from '../src/controls/claude-config.js';
import { TranscriptStore } from '../src/controls/transcript.js';
import { labelFor, familyMatches, ModelResolver } from '../src/controls/model-resolver.js';
import { MockEngine } from '../src/engines/mock.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

// --- Bug 1: dynamic model version labels ------------------------------------
test('labelFor derives a friendly version from the resolved id (never hardcoded)', () => {
  assert.equal(labelFor('opus', 'claude-opus-4-8'), 'Opus 4.8');
  assert.equal(labelFor('haiku', 'claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(labelFor('sonnet', 'claude-sonnet-4-6'), 'Sonnet 4.6');
  // Unknown id -> fall back to a capitalized alias, no crash.
  assert.equal(labelFor('opus', null), 'Opus');
  assert.equal(labelFor('glm-5.2', 'glm-5.2'), 'Glm-5.2');
});

test('family validation: a non-Opus account reporting a Sonnet id for opus never mislabels', () => {
  // The exact screenshot bug: opus resolved to a sonnet id -> must NOT become "Sonnet 4.6".
  assert.equal(labelFor('opus', 'claude-sonnet-4-6'), 'Opus');
  assert.equal(labelFor('opus', 'claude-opus-4-8'), 'Opus 4.8');
  assert.equal(familyMatches('opus', 'claude-sonnet-4-6'), false);
  assert.equal(familyMatches('sonnet', 'claude-sonnet-4-6'), true);
  // Family-less aliases (GLM, mock) resolve verbatim.
  assert.equal(familyMatches('glm-5.2', 'glm-5.2'), true);
  assert.equal(labelFor('glm-5.2', 'glm-5.2'), 'Glm-5.2');
});

test('ModelResolver.observe rejects a cross-family id (no cache poisoning)', () => {
  const r = new ModelResolver({ stateDir: os.tmpdir(), claudeBin: 'claude' });
  r.cache = {};
  r.observe('opus', 'claude-sonnet-4-6'); // wrong family -> ignored
  assert.equal(r.cache.opus, undefined);
  r.observe('opus', 'claude-opus-4-8'); // correct family -> cached
  assert.equal(r.cache.opus, 'claude-opus-4-8');
});

test('engine honors the per-call model override (base.js no longer ignores opts.model)', () => {
  const profile = { id: 'mock', harness: 'mock', model: 'mock-1' };
  const eng = new MockEngine({ profile, cwd: os.tmpdir(), env: {}, model: 'mock-override', log() {} });
  assert.equal(eng.model, 'mock-override', 'switchModel must actually change the spawned model');
  const dflt = new MockEngine({ profile, cwd: os.tmpdir(), env: {}, log() {} });
  assert.equal(dflt.model, 'mock-1', 'falls back to profile default when no override');
});

// --- Bug 5: resume replays the conversation from Claude's own .jsonl --------
test('readSessionTranscript parses a Claude .jsonl into canonical records', async () => {
  const proj = await tmpDir('rt-proj-');
  // Claude stores transcripts under ~/.claude/projects/<encoded cwd>/<id>.jsonl.
  const home = os.homedir();
  const encoded = proj.replace(/[/\\:]+/g, '-').replace(/^-+/, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  const id = 'sess-test-1234';
  const T_USER = '2024-01-02T03:04:05.000Z';
  const T_ASST = '2024-01-02T03:04:09.000Z';
  const T_RESULT = '2024-01-02T03:04:11.000Z';
  const lines = [
    { type: 'user', timestamp: T_USER, message: { role: 'user', content: 'hello there' } },
    { type: 'assistant', timestamp: T_ASST, message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'Hi! Reading a file.' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/x' } },
    ] } },
    { type: 'user', timestamp: T_RESULT, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: 'file body' },
    ] } },
  ];
  await fs.writeFile(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const cc = new ClaudeConfig({ getProjectDir: () => proj });
  const recs = cc.readSessionTranscript(id);
  try {
    const types = recs.map((r) => r.type);
    assert.deepEqual(types, ['user_echo', 'assistant_thinking', 'assistant_text', 'tool_call', 'tool_result']);
    assert.equal(recs[0].text, 'hello there');
    assert.equal(recs[3].name, 'Read');
    assert.equal(recs[4].id, 'tu_1');
    assert.equal(recs[4].status, 'ok');
    assert.equal(recs[4].output, 'file body');
    // Each replayed record carries the ORIGINAL message time from the .jsonl, so a
    // reopened conversation shows when messages actually fired (not the reopen time).
    assert.equal(recs[0].ts, T_USER, 'user_echo keeps its original timestamp');
    assert.equal(recs[1].ts, T_ASST, 'assistant_thinking keeps the assistant turn time');
    assert.equal(recs[2].ts, T_ASST, 'assistant_text keeps the assistant turn time');
    assert.equal(recs[3].ts, T_ASST, 'tool_call keeps the assistant turn time');
    assert.equal(recs[4].ts, T_RESULT, 'tool_result keeps the result turn time');
    // unknown session -> empty, no throw
    assert.deepEqual(cc.readSessionTranscript('nope'), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TranscriptStore.replace persists and is replayed verbatim', async () => {
  const state = await tmpDir('ts-state-');
  const store = new TranscriptStore(state);
  store.setProject('proj-1');
  const recs = [
    { type: 'user_echo', text: 'hi' },
    { type: 'assistant_text', delta: 'hello', parentToolUseId: null },
    { type: 'session_meta', sessionId: 'x' }, // not in KEEP -> dropped
  ];
  const seeded = store.replace(recs);
  assert.equal(seeded.length, 2, 'non-conversation events filtered out');
  // A fresh store reading the same project file sees the same two records.
  const reopened = new TranscriptStore(state);
  reopened.setProject('proj-1');
  assert.deepEqual(reopened.replay().map((r) => r.type), ['user_echo', 'assistant_text']);
});

// --- Bug 2 + snapshot: effort + models surface over the wire ----------------
test('e2e: effort + models flow over WebSocket', async () => {
  const projects = await tmpDir('bf-proj-');
  const state = await tmpDir('bf-state-');
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });

  // Snapshot includes an EFFORT event (default high) and a MODELS event.
  const eff = await waitFor((e) => e.type === 'effort');
  assert.equal(eff.level, 'high');
  const models = await waitFor((e) => e.type === 'models');
  assert.ok(Array.isArray(models.items));
  assert.ok(models.items.some((m) => m.alias === 'mock-1'));

  // Changing effort is acknowledged and echoed back.
  ws.send(JSON.stringify({ type: 'set_effort', level: 'max' }));
  const eff2 = await waitFor((e) => e.type === 'effort' && e.level === 'max');
  assert.equal(eff2.level, 'max');
  assert.equal(server.session.effort, 'max');
  // ...and it does NOT silently revert the model (currentModel persists).
  assert.equal(server.session.currentModel, 'mock-1');

  ws.close();
  await server.stop();
});

test('e2e: creating a skill via the UI triggers a hot-reload toast', async () => {
  const projects = await tmpDir('sk-proj-');
  const state = await tmpDir('sk-state-');
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });

  ws.send(JSON.stringify({ type: 'config_write', kind: 'skills', name: 'greet', scope: 'project', fields: { description: 'say hi' }, body: 'Say hello.' }));
  const toast = await waitFor((e) => e.type === 'toast');
  assert.match(toast.message, /greet/);
  // The skill file landed in the project's .claude (where the CLI scans).
  assert.ok(fssync.existsSync(path.join(projects, '.claude', 'skills', 'greet', 'SKILL.md')));

  ws.close();
  await server.stop();
});

test('TranscriptStore skips a torn last line instead of dropping the whole file', async () => {
  const state = await tmpDir('ts-torn-');
  const ts = new TranscriptStore(state);
  ts.setProject('p1');
  ts.record({ type: 'user_echo', text: 'hi' });
  ts.record({ type: 'assistant_text', delta: 'ok' });
  ts.replay(); // flush pending text to disk
  // Simulate a process killed mid-append: a partial JSON line at the end.
  const f = path.join(state, 'transcripts', 'p1.jsonl');
  fssync.appendFileSync(f, '{"type":"user_echo","text":"tor');
  const reopened = new TranscriptStore(state);
  reopened.setProject('p1');
  const types = reopened.replay().map((e) => e.type);
  assert.ok(types.includes('user_echo'), 'valid records survive');
  assert.ok(types.includes('assistant_text'), 'valid records survive');
  assert.equal(types.filter((t) => t === 'user_echo').length, 1, 'torn line skipped, not parsed');
});

test('ClaudeConfig hook delete removes only the targeted hook, not the whole group', async () => {
  const proj = await tmpDir('hk-proj-');
  fssync.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fssync.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'A' }, { type: 'command', command: 'B' }] }] },
  }));
  const cc = new ClaudeConfig({ getProjectDir: () => proj, getProjects: () => [], stateDir: proj });
  cc.delete('hooks', 'PreToolUse#0#0', 'project');
  const after = JSON.parse(fssync.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  const cmds = after.hooks.PreToolUse[0].hooks.map((h) => h.command);
  assert.deepEqual(cmds, ['B'], 'only hook A removed; B survives');
});

test('encodeCwd matches Claude\'s real ~/.claude/projects folder encoding', () => {
  // Every non-alphanumeric char -> '-', per character, NO run-collapsing. Verified
  // char-for-char against real folder names produced by the claude CLI on disk.
  assert.equal(encodeCwd('/home/user/mobileAgent'), '-home-user-mobileAgent');
  // Leading '/-' yields a double dash (runs not collapsed).
  assert.equal(
    encodeCwd('/tmp/claude-0/-home-user-x/abc-123/scratchpad'),
    '-tmp-claude-0--home-user-x-abc-123-scratchpad'
  );
  // Dots and underscores are encoded too (the old regex left these intact and
  // collapsed runs, so these paths mapped to the wrong folder -> "folder unknown").
  assert.equal(encodeCwd('/home/user/my.app_v2'), '-home-user-my-app-v2');
  assert.equal(encodeCwd('/a//b'), '-a--b');
});
