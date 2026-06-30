import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { EventType, event } from '../protocol.js';
import { labelFor } from './model-resolver.js';
import { resolveCodexLaunch } from '../engines/codex-app-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_FALLBACK_FILE = path.join(__dirname, 'catalogs', 'codex-app-server.json');

export class EngineOptionsResolver {
  constructor({ config, profiles, secrets, session, modelResolver, getActiveProject, log = () => {} }) {
    this.config = config;
    this.profiles = profiles;
    this.secrets = secrets;
    this.session = session;
    this.modelResolver = modelResolver;
    this.getActiveProject = getActiveProject;
    this.log = log;
    this.cache = new Map();
  }

  async eventForActive({ refresh = false, includeHidden = false } = {}) {
    const profile = this.profiles.get(this.session.activeProfileId);
    const meta = this.session._activeMeta || {};
    const selected = {
      model: this.session.currentModel || profile?.model || null,
      effort: this.session.effort || null,
      serviceTier: this.session.serviceTier,
    };
    if (!profile) return event(EventType.ENGINE_OPTIONS, normalizedCatalog({ selected }));

    let catalog = null;
    const engine = this.session.engine;
    if (!refresh && engine?.profile?.id === profile.id && typeof engine.listControlOptions === 'function') {
      try { catalog = await engine.listControlOptions({ includeHidden }); } catch (e) { this.log(`live engine options failed: ${e.message}`); }
    }

    if (!catalog && profile.harness === 'codex-app-server') {
      catalog = await this._codexCatalog(profile, { refresh, includeHidden });
    }
    if (!catalog) {
      catalog = profileCatalog(profile, this.modelResolver?.cache || {}, { selected, source: 'profile' });
    }

    return event(EventType.ENGINE_OPTIONS, normalizedCatalog({
      ...catalog,
      profileId: profile.id,
      harness: profile.harness,
      // The cached/probed catalog can contain the selection from when it was
      // fetched. The live session selection must win, especially for explicit
      // Standard speed (`serviceTier: null`) over a catalog default like Fast.
      selected: { ...(catalog.selected || {}), ...selected },
      activeKey: this.session.activeKey,
      sessionKey: this.session.activeKey,
      stale: !!catalog.stale,
    }));
  }

  async _codexCatalog(profile, { refresh = false, includeHidden = false } = {}) {
    const key = `${profile.id}:${includeHidden ? 'all' : 'visible'}`;
    const cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.value;

    const cwd = this.getActiveProject()?.dir || this.config.projectsDir;
    const env = this.secrets.envForProfile(profile);
    let value = null;
    try {
      const raw = await probeCodexModelList({
        bin: profile.codexBin || this.config.codexBin || 'codex',
        args: profile.codexArgs || ['app-server', '--stdio'],
        env,
        cwd,
        includeHidden,
        timeoutMs: 15_000,
      });
      value = codexCatalog(raw, {
        profile,
        selected: {
          model: this.session.currentModel || profile.model || null,
          effort: this.session.effort || null,
          serviceTier: this.session.serviceTier,
        },
        source: 'dynamic',
      });
    } catch (e) {
      this.log(`codex model/list failed: ${e.message}`);
      value = codexCatalog(loadCodexFallback(), {
        profile,
        selected: {
          model: this.session.currentModel || profile.model || null,
          effort: this.session.effort || null,
          serviceTier: this.session.serviceTier,
        },
        source: 'fallback',
        stale: true,
      });
    }
    this.cache.set(key, { ts: Date.now(), value });
    return value;
  }
}

export function profileCatalog(profile, cache = {}, { selected = {}, source = 'profile' } = {}) {
  const aliases = profile?.models?.length ? profile.models : profile?.model ? [profile.model] : [];
  const models = aliases.map((alias) => {
    const id = cache[alias] || alias;
    return {
      id,
      model: alias,
      label: labelFor(alias, cache[alias]),
      description: '',
      hidden: false,
      isDefault: alias === profile?.model,
      custom: false,
      defaultEffort: defaultEffortForHarness(profile?.harness),
      efforts: effortOptionsForHarness(profile?.harness, alias),
      serviceTiers: [],
      defaultServiceTier: null,
      inputModalities: ['text'],
      upgrade: null,
      availabilityMessage: null,
    };
  });
  return { source, profileId: profile?.id || null, harness: profile?.harness || null, selected, models };
}

export function codexCatalog(rawModels, { profile, selected = {}, source = 'dynamic', stale = false } = {}) {
  const models = [];
  const seen = new Set();
  for (const raw of rawModels || []) {
    const model = normalizeCodexModel(raw);
    if (!model || seen.has(model.model)) continue;
    seen.add(model.model);
    models.push(model);
  }
  const customModels = new Set([profile?.model, ...(Array.isArray(profile?.models) ? profile.models : []), selected.model].filter(Boolean).map(String));
  for (const custom of customModels) {
    if (seen.has(custom)) continue;
    seen.add(custom);
    models.push(customCodexModel(custom, custom === profile?.model));
  }
  return { source, stale, profileId: profile?.id || null, harness: profile?.harness || 'codex-app-server', selected, models };
}

export function normalizeCodexModel(raw) {
  const id = String(raw?.id || raw?.model || '').trim();
  const model = String(raw?.model || raw?.id || '').trim();
  if (!id || !model) return null;
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts.map((e) => ({
      id: String(e?.reasoningEffort || e || '').trim(),
      label: effortLabel(e?.reasoningEffort || e),
      description: String(e?.description || ''),
    })).filter((e) => e.id)
    : [];
  const tiers = [
    { id: null, label: 'Standard', description: 'Default speed and usage' },
    ...(Array.isArray(raw.serviceTiers) ? raw.serviceTiers.map((t) => ({
      id: String(t?.id || '').trim() || null,
      label: String(t?.name || t?.id || '').trim() || 'Speed',
      description: String(t?.description || ''),
    })).filter((t) => t.id) : []),
  ];
  return {
    id,
    model,
    label: String(raw.displayName || model).trim(),
    description: String(raw.description || ''),
    hidden: !!raw.hidden,
    isDefault: !!raw.isDefault,
    custom: false,
    defaultEffort: raw.defaultReasoningEffort || efforts[0]?.id || null,
    efforts,
    serviceTiers: tiers,
    defaultServiceTier: raw.defaultServiceTier || null,
    inputModalities: Array.isArray(raw.inputModalities) ? raw.inputModalities : ['text'],
    upgrade: raw.upgrade || null,
    availabilityMessage: raw.availabilityNux?.message || raw.upgradeInfo?.upgradeCopy || null,
  };
}

export function normalizedCatalog(catalog = {}) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const selectedModel = catalog.selected?.model || models.find((m) => m.isDefault)?.model || models[0]?.model || null;
  const model = models.find((m) => m.model === selectedModel) || models[0] || null;
  const selectedEffort = selectSupported(catalog.selected?.effort, model?.efforts, model?.defaultEffort);
  const selectedServiceTier = selectSupported(catalog.selected?.serviceTier, model?.serviceTiers, model?.defaultServiceTier, true);
  return {
    profileId: catalog.profileId || null,
    harness: catalog.harness || null,
    source: catalog.source || 'profile',
    stale: !!catalog.stale,
    activeKey: catalog.activeKey,
    sessionKey: catalog.sessionKey,
    selected: {
      model: selectedModel,
      effort: selectedEffort,
      serviceTier: selectedServiceTier,
    },
    models,
  };
}

export async function probeCodexModelList({ bin = 'codex', args = ['app-server', '--stdio'], env = {}, cwd, includeHidden = false, timeoutMs = 15_000 } = {}) {
  const launch = resolveCodexLaunch(bin, args, { ...process.env, ...env });
  const child = spawn(launch.command, launch.args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  return await jsonRpcProbe(child, { includeHidden, timeoutMs });
}

export async function jsonRpcProbe(child, { includeHidden = false, timeoutMs = 15_000 } = {}) {
  let nextId = 1;
  let buf = '';
  const pending = new Map();
  const send = (method, params = {}) => {
    const id = nextId++;
    pending.set(id, method);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  };
  return await new Promise((resolve, reject) => {
    const finish = (err, value) => {
      clearTimeout(timer);
      try { child.kill(err ? 'SIGKILL' : 'SIGTERM'); } catch { /* ignore */ }
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('codex model/list timed out')), timeoutMs);
    timer.unref?.();
    child.on('error', (e) => finish(e));
    child.on('exit', (code, signal) => {
      if (pending.size) finish(new Error(`codex app-server exited before model/list (${signal || code})`));
    });
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!Object.prototype.hasOwnProperty.call(msg, 'id')) continue;
        const method = pending.get(msg.id);
        if (!method) continue;
        pending.delete(msg.id);
        if (msg.error) return finish(new Error(msg.error.message || String(msg.error)));
        if (method === 'initialize') {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          send('model/list', { limit: 100, includeHidden });
        } else if (method === 'model/list') {
          finish(null, Array.isArray(msg.result?.data) ? msg.result.data : []);
        }
      }
    });
    send('initialize', {
      clientInfo: { name: 'mobile-agent-broker', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  });
}

function loadCodexFallback() {
  try { return JSON.parse(fs.readFileSync(CODEX_FALLBACK_FILE, 'utf8')); } catch { return []; }
}

function customCodexModel(model, isDefault = false) {
  return {
    id: model,
    model,
    label: model,
    description: 'Custom model',
    hidden: false,
    isDefault,
    custom: true,
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id, label: effortLabel(id), description: '' })),
    serviceTiers: [{ id: null, label: 'Standard', description: 'Default speed and usage' }],
    defaultServiceTier: null,
    inputModalities: ['text'],
    upgrade: null,
    availabilityMessage: null,
  };
}

function selectSupported(wanted, options = [], fallback = null, allowNull = false) {
  const values = new Set((options || []).map((o) => o?.id ?? null));
  if (wanted !== undefined && (wanted !== null || allowNull) && values.has(wanted ?? null)) return wanted ?? null;
  if (fallback != null && values.has(fallback)) return fallback;
  if (allowNull && values.has(null)) return null;
  return options?.[0]?.id ?? fallback ?? null;
}

function defaultEffortForHarness(harness) {
  return harness === 'claude-code' ? 'high' : null;
}

function effortOptionsForHarness(harness, model) {
  if (harness !== 'claude-code') return [];
  const values = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/opus|fable/i.test(String(model || ''))) values.push('ultracode');
  return values.map((id) => ({ id, label: effortLabel(id), description: '' }));
}

function effortLabel(id) {
  const s = String(id || '');
  if (s === 'xhigh') return 'XHigh';
  if (s === 'ultracode') return 'Ultracode';
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
