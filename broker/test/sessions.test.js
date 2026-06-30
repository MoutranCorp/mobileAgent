import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { ClaudeConfig, encodeCwd } from '../src/controls/claude-config.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('claude-config: project mapping, rename sidecar, title override, delete', async () => {
  const projDir = await tmpDir('sess-proj-');
  const stateDir = await tmpDir('sess-state-');
  const enc = encodeCwd(projDir);
  const sessionsDir = path.join(os.homedir(), '.claude', 'projects', enc);
  await fs.mkdir(sessionsDir, { recursive: true });
  const id = 'sess-unit-test-1';
  const file = path.join(sessionsDir, `${id}.jsonl`);
  await fs.writeFile(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'original first message' } }) + '\n');

  const cc = new ClaudeConfig({
    getProjectDir: () => projDir,
    getProjects: () => [{ id: 'projX', dir: projDir, name: 'projX' }],
    stateDir,
  });
  try {
    // listAllSessions resolves the real projectId and the default summary.
    let all = cc.listAllSessions();
    const row = all.find((s) => s.id === id);
    assert.ok(row, 'session is listed');
    assert.equal(row.projectId, 'projX', 'mapped to the real project id via dir re-encoding');
    assert.equal(row.projectDir, enc);
    assert.match(row.summary, /original first message/);
    assert.equal(row.titled, false);

    // rename -> sidecar override applied in BOTH listings
    cc.renameSession(id, 'My Custom Title');
    assert.ok(fssync.existsSync(path.join(stateDir, 'session-titles.json')), 'sidecar written');
    all = cc.listAllSessions();
    const renamed = all.find((s) => s.id === id);
    assert.equal(renamed.summary, 'My Custom Title');
    assert.equal(renamed.titled, true);
    assert.equal(cc.list('sessions').find((s) => s.id === id).summary, 'My Custom Title', 'override also in per-project list');

    // sessionsDirForProject resolves the right dir
    assert.equal(cc.sessionsDirForProject('projX'), sessionsDir);

    // delete by the literal encoded projectDir (most precise)
    const res = cc.deleteSession(id, { projectDir: enc });
    assert.equal(res.ok, true);
    assert.ok(!fssync.existsSync(file), 'transcript file removed');
    assert.equal(cc.listAllSessions().find((s) => s.id === id), undefined, 'gone from the list');
    // deleting prunes the orphaned title
    const titles = JSON.parse(fssync.readFileSync(path.join(stateDir, 'session-titles.json'), 'utf8'));
    assert.equal(titles[id], undefined, 'title pruned on delete');
  } finally {
    await fs.rm(sessionsDir, { recursive: true, force: true });
  }
});

test('claude-config: deleteSession reports not-found instead of touching the wrong file', async () => {
  const stateDir = await tmpDir('sess-state2-');
  const cc = new ClaudeConfig({ getProjectDir: () => os.tmpdir(), getProjects: () => [], stateDir });
  const res = cc.deleteSession('does-not-exist', { projectDir: 'nope-encoded' });
  assert.equal(res.error, 'session file not found');
});
