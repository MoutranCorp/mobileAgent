/**
 * Broker configuration. Resolved once at startup from (in priority order):
 *   1. CLI flags  (--port, --host, --engine, --projects, --state)
 *   2. Environment (BROKER_PORT, BROKER_HOST, BROKER_ENGINE, PROJECTS_DIR, STATE_DIR)
 *   3. Sensible defaults that work both on a dev box and inside proot.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

export function loadConfig(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home = os.homedir();

  const projectsDir = path.resolve(
    args.projects || process.env.PROJECTS_DIR || path.join(home, 'projects')
  );
  const stateDir = path.resolve(
    args.state || process.env.STATE_DIR || path.join(home, '.agent-broker')
  );

  // Bind to loopback only by default — the whole point is localhost-only.
  const host = args.host || process.env.BROKER_HOST || '127.0.0.1';
  const port = Number(args.port || process.env.BROKER_PORT || 8765);
  // Port 0 is valid — it asks the OS for any free ephemeral port (used in tests).
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port ${JSON.stringify(args.port || process.env.BROKER_PORT)} — must be an integer 0–65535`);
  }

  // Default engine profile id. `mock` lets the entire stack run with no
  // claude CLI / proot present (great for dev + CI on a laptop).
  const defaultProfile =
    args.profile || process.env.BROKER_PROFILE || (args.engine === 'mock' ? 'mock' : 'claude-max');

  const config = {
    host,
    port,
    projectsDir,
    stateDir,
    defaultProfile,
    // Where Metro's base port starts; each project gets base + offset.
    metroBasePort: Number(process.env.METRO_BASE_PORT || 8081),
    // Path to the claude binary (overridable for odd installs).
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    // Default permission mode for the claude-code engine. Bypass-all by default
    // (on-device the whole proot IS the sandbox; IS_SANDBOX=1 lifts the root guard).
    permissionMode: process.env.PERMISSION_MODE || 'bypassPermissions',
    // Default reasoning effort: low|medium|high|xhigh|max (CLI default is high).
    effort: process.env.EFFORT || 'high',
    // Verbose broker logging to stderr.
    verbose: !!(args.verbose || process.env.BROKER_VERBOSE),
  };

  ensureDir(config.projectsDir);
  ensureDir(config.stateDir);

  return config;
}

export function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
  return p;
}
