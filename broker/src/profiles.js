import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Profile
 * @property {string} id            stable id, e.g. 'claude-max'
 * @property {string} label         display name
 * @property {string} harness       'claude-code' | 'opencode' | 'mock'
 * @property {string} [baseUrl]     ANTHROPIC_BASE_URL override (alt endpoints)
 * @property {string} [authRef]     name of a secret holding the auth token
 * @property {string} [model]       default model for this profile
 * @property {string[]} [models]    selectable models
 * @property {'flat'|'metered'|'self-hosted'|'none'} billing
 * @property {string} [permissionMode] default permission mode for this profile
 * @property {number} [serverPort]  for server-based harnesses (opencode)
 */

/** The built-in profiles from Section 3 of the plan. */
export const DEFAULT_PROFILES = [
  {
    id: 'claude-max',
    label: 'Claude (Max)',
    harness: 'claude-code',
    baseUrl: null,
    authRef: null, // OAuth via `claude /login` — no key
    model: 'opus',
    models: ['opus', 'sonnet', 'haiku'],
    billing: 'flat',
    permissionMode: 'default',
  },
  {
    id: 'glm-zai',
    label: 'GLM 5.2 (Z.ai)',
    harness: 'claude-code',
    baseUrl: 'https://api.z.ai/api/anthropic',
    authRef: 'ZAI_AUTH_TOKEN',
    model: 'glm-5.2',
    models: ['glm-5.2', 'glm-5.2[1m]'],
    billing: 'flat',
    permissionMode: 'default',
  },
  {
    id: 'opencode',
    label: 'opencode',
    harness: 'opencode',
    baseUrl: null,
    authRef: null,
    model: null,
    billing: 'metered',
    serverPort: 4096,
  },
  {
    id: 'mock',
    label: 'Mock engine (offline demo)',
    harness: 'mock',
    baseUrl: null,
    authRef: null,
    model: 'mock-1',
    models: ['mock-1'],
    billing: 'none',
  },
];

/**
 * ProfileStore — loads profiles from <stateDir>/profiles.json if present,
 * otherwise seeds it from DEFAULT_PROFILES. Users (and the Android settings UI)
 * can edit the file to add engines without code changes.
 */
export class ProfileStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'profiles.json');
    this.profiles = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw) && raw.length) return raw;
      }
    } catch {
      /* fall through to defaults */
    }
    this._save(DEFAULT_PROFILES);
    return DEFAULT_PROFILES.slice();
  }

  _save(profiles) {
    try {
      fs.writeFileSync(this.file, JSON.stringify(profiles, null, 2));
    } catch {
      /* state dir might be read-only in some setups */
    }
  }

  list() {
    return this.profiles;
  }

  get(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  upsert(profile) {
    const i = this.profiles.findIndex((p) => p.id === profile.id);
    if (i >= 0) this.profiles[i] = { ...this.profiles[i], ...profile };
    else this.profiles.push(profile);
    this._save(this.profiles);
  }
}
