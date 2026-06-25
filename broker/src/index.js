#!/usr/bin/env node
/**
 * On-device agent broker — entry point.
 *
 * Usage:
 *   node src/index.js [--port 8765] [--host 127.0.0.1]
 *                     [--engine mock] [--profile claude-max]
 *                     [--projects ~/projects] [--state ~/.agent-broker]
 *                     [--verbose]
 *
 * The broker exposes a localhost WebSocket speaking the canonical protocol and
 * serves a web UI on the same port. On the phone it runs inside proot; on a dev
 * box `--engine mock` runs the whole stack with no credentials.
 */
import { loadConfig } from './config.js';
import { BrokerServer } from './server.js';

async function main() {
  const config = loadConfig();
  const server = new BrokerServer(config);
  await server.start();

  // Auto-start the engine so the UI is live immediately. For the mock profile
  // this needs nothing; for claude-max it requires a logged-in CLI.
  if (process.env.BROKER_AUTOSTART !== '0') {
    server.session.ensureEngine().catch((e) => {
      process.stderr.write(`[broker] engine autostart failed: ${e.message}\n`);
    });
  }

  const shutdown = async (sig) => {
    process.stderr.write(`\n[broker] ${sig} received, shutting down…\n`);
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`[broker] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
