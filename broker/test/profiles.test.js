import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProfileStore } from '../src/profiles.js';

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('ProfileStore backfills new built-in profiles into existing profiles.json', async () => {
  const state = await tmpDir('profiles-state-');
  const file = path.join(state, 'profiles.json');
  const stale = [
    {
      id: 'claude-max',
      label: 'Claude Custom Label',
      harness: 'claude-code',
      model: 'sonnet',
      billing: 'flat',
    },
    {
      id: 'custom-local',
      label: 'Custom Local',
      harness: 'mock',
      model: 'local-1',
      billing: 'none',
    },
  ];
  await fs.writeFile(file, JSON.stringify(stale, null, 2));

  const store = new ProfileStore(state);

  assert.equal(store.get('codex-app-server')?.harness, 'codex-app-server');
  assert.equal(store.get('claude-max')?.label, 'Claude Custom Label');
  assert.equal(store.get('claude-max')?.models?.includes('opus'), true);
  assert.equal(store.get('custom-local')?.label, 'Custom Local');

  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(saved.some((p) => p.id === 'codex-app-server'));
  assert.ok(saved.some((p) => p.id === 'custom-local'));
});

test('ProfileStore backfills missing built-in model fields on existing profiles', async () => {
  const state = await tmpDir('profiles-state-');
  const file = path.join(state, 'profiles.json');
  const stale = [
    {
      id: 'codex-app-server',
      label: 'Codex (app-server)',
      harness: 'codex-app-server',
      model: null,
      billing: 'metered',
      permissionMode: 'default',
    },
  ];
  await fs.writeFile(file, JSON.stringify(stale, null, 2));

  const store = new ProfileStore(state);
  const codex = store.get('codex-app-server');

  assert.equal(codex.model, 'gpt-5.5');
  assert.deepEqual(codex.models, ['gpt-5.5']);

  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const savedCodex = saved.find((p) => p.id === 'codex-app-server');
  assert.equal(savedCodex.model, 'gpt-5.5');
  assert.deepEqual(savedCodex.models, ['gpt-5.5']);
});
