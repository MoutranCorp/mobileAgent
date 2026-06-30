import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineOptionsResolver, codexCatalog, normalizedCatalog, normalizeCodexModel, profileCatalog, probeCodexModelList } from '../src/controls/engine-options.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs');

test('normalizes Codex model/list response with effort and speed tiers', () => {
  const model = normalizeCodexModel({
    id: 'gpt-5.5',
    model: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Frontier',
    isDefault: true,
    defaultReasoningEffort: 'xhigh',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'xhigh', description: 'Deep' },
    ],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x' }],
    defaultServiceTier: 'priority',
    inputModalities: ['text', 'image'],
  });

  assert.equal(model.model, 'gpt-5.5');
  assert.equal(model.label, 'GPT-5.5');
  assert.deepEqual(model.efforts.map((e) => e.id), ['low', 'xhigh']);
  assert.deepEqual(model.serviceTiers.map((t) => t.id), [null, 'priority']);
  assert.equal(model.defaultServiceTier, 'priority');
});

test('Codex catalog appends selected custom profile models once', () => {
  const catalog = codexCatalog([
    {
      id: 'gpt-5.5',
      model: 'gpt-5.5',
      displayName: 'GPT-5.5',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
      serviceTiers: [],
    },
  ], {
    profile: { id: 'codex-app-server', harness: 'codex-app-server', model: 'custom-model', models: ['gpt-5.5', 'custom-model'] },
    selected: { model: 'another-custom' },
  });

  assert.deepEqual(catalog.models.map((m) => m.model), ['gpt-5.5', 'custom-model', 'another-custom']);
  assert.equal(catalog.models.find((m) => m.model === 'custom-model').custom, true);
});

test('normalized catalog uses default service tier only when selection is unset', () => {
  const catalog = {
    selected: { model: 'gpt-5.5', serviceTier: undefined },
    models: [{
      model: 'gpt-5.5',
      defaultServiceTier: 'priority',
      efforts: [{ id: 'high' }],
      defaultEffort: 'high',
      serviceTiers: [{ id: null }, { id: 'priority' }],
    }],
  };

  assert.equal(normalizedCatalog(catalog).selected.serviceTier, 'priority');
  assert.equal(normalizedCatalog({ ...catalog, selected: { model: 'gpt-5.5', serviceTier: null } }).selected.serviceTier, null);
});

test('engine options prefer active Standard speed over cached Codex Fast selection', async () => {
  const profile = { id: 'codex-app-server', harness: 'codex-app-server', model: 'gpt-5.5' };
  const session = {
    activeProfileId: profile.id,
    activeKey: 'demo',
    currentModel: 'gpt-5.5',
    effort: 'high',
    serviceTier: null,
    engine: null,
    _activeMeta: { serviceTier: null },
  };
  const resolver = new EngineOptionsResolver({
    config: { projectsDir: __dirname, codexBin: process.execPath },
    profiles: { get: () => profile },
    secrets: { envForProfile: () => ({}) },
    session,
    modelResolver: { cache: {} },
    getActiveProject: () => null,
  });
  resolver.cache.set(`${profile.id}:visible`, {
    ts: Date.now(),
    value: codexCatalog([
      {
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
        defaultServiceTier: 'priority',
      },
    ], {
      profile,
      selected: { model: 'gpt-5.5', effort: 'high', serviceTier: 'priority' },
    }),
  });

  const ev = await resolver.eventForActive();

  assert.equal(ev.selected.serviceTier, null);
});

test('profile catalog preserves Claude alias labels and effort options', () => {
  const catalog = profileCatalog(
    { id: 'claude-max', harness: 'claude-code', model: 'opus', models: ['opus', 'sonnet'] },
    { opus: 'claude-opus-4-8-20260101' },
    { selected: { model: 'opus' } },
  );

  assert.equal(catalog.models[0].label, 'Opus 4.8');
  assert.ok(catalog.models[0].efforts.some((e) => e.id === 'ultracode'));
  assert.equal(catalog.models[1].efforts.some((e) => e.id === 'ultracode'), false);
});

test('Codex model/list probe works against the fake app-server fixture', async () => {
  const models = await probeCodexModelList({
    bin: process.execPath,
    args: [fixture],
    cwd: __dirname,
    timeoutMs: 5000,
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].model, 'gpt-fake');
  assert.equal(models[0].serviceTiers[0].id, 'priority');
});
