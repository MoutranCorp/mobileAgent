import fs from 'node:fs';
import path from 'node:path';

/**
 * SecretStore — resolves provider auth tokens for a profile and builds the env
 * to inject into the engine process at spawn.
 *
 * On Android the canonical source is the Keystore: the Kotlin app injects
 * secrets as environment variables into the proot/broker process. The broker
 * therefore reads from process.env first. For dev/standalone use it also reads
 * <stateDir>/secrets.json (which MUST be gitignored — never commit keys, never
 * write them into a project .env).
 */
export class SecretStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'secrets.json');
    this._fileSecrets = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* ignore */
    }
    return {};
  }

  /** Resolve a named secret: env wins, then secrets.json. */
  resolve(name) {
    if (!name) return null;
    return process.env[name] ?? this._fileSecrets[name] ?? null;
  }

  has(name) {
    return this.resolve(name) != null;
  }

  set(name, value) {
    this._fileSecrets[name] = value;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this._fileSecrets, null, 2), { mode: 0o600 });
      return { ok: true };
    } catch (e) {
      // Report the failure instead of silently dropping the secret — the caller
      // (and the user) should know the key didn't persist.
      console.warn(`[secrets] failed to persist ${name}: ${e?.message || e}`);
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * Build the environment to inject for a given profile. For alt endpoints the
   * Claude Code CLI reads ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN; the default
   * Claude (Max) profile uses OAuth and needs neither.
   */
  envForProfile(profile) {
    const env = {};
    if (!profile) return env;
    if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl;
    if (profile.authRef) {
      const token = this.resolve(profile.authRef);
      if (token) env.ANTHROPIC_AUTH_TOKEN = token;
    }
    return env;
  }

  /** True if the profile can authenticate (has its key, or uses OAuth). */
  isReady(profile) {
    if (!profile) return false;
    if (!profile.authRef) return true; // OAuth or none
    return this.has(profile.authRef);
  }
}
