import { ClaudeCodeEngine } from './claude-code.js';
import { OpencodeEngine } from './opencode.js';
import { MockEngine } from './mock.js';

/**
 * Map a harness name to its adapter class. Adding a new harness = adding one
 * entry here plus the adapter file. The UI never changes.
 */
const REGISTRY = {
  'claude-code': ClaudeCodeEngine,
  opencode: OpencodeEngine,
  mock: MockEngine,
};

export function createEngine(profile, opts) {
  const Cls = REGISTRY[profile.harness];
  if (!Cls) {
    throw new Error(
      `Unknown harness '${profile.harness}'. Known: ${Object.keys(REGISTRY).join(', ')}`
    );
  }
  return new Cls({ ...opts, profile });
}

export function knownHarnesses() {
  return Object.keys(REGISTRY);
}
