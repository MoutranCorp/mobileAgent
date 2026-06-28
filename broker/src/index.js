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
import { restoreIfFresh, backupNow, backupEnabled } from './controls/backup.js';

async function main() {
  const config = loadConfig();

  // BEFORE anything scans projects/sessions: on a fresh install, restore the user's
  // projects, sessions and Claude login from the shared-storage backup (survives an
  // app uninstall). Non-destructive — only runs when the live data is empty.
  try {
    const r = restoreIfFresh(config);
    if (r.restored) process.stderr.write(`[broker] restored backup (${r.items.join(', ')})\n`);
  } catch (e) { process.stderr.write(`[broker] restore skipped: ${e.message}\n`); }

  const server = new BrokerServer(config);
  await server.start();
  server.startLifecycle(); // periodic resource sampling + idle-session eviction (real runtime only)

  // Periodically mirror data to shared storage so an uninstall / "clear data" / new
  // phone doesn't lose work. Async copy (doesn't block the loop); manual "Back up
  // now" is also available from the UI. BACKUP_INTERVAL_MIN=0 disables it.
  const bkMin = Number(process.env.BACKUP_INTERVAL_MIN ?? 30);
  if (bkMin > 0 && backupEnabled()) {
    const t = setInterval(() => { backupNow(config).catch(() => {}); }, bkMin * 60 * 1000);
    t.unref();
  }

  // Auto-start the engine so the UI is live immediately. For the mock profile
  // this needs nothing; for claude-max it requires a logged-in CLI.
  if (process.env.BROKER_AUTOSTART !== '0') {
    server.session.ensureEngine().catch((e) => {
      process.stderr.write(`[broker] engine autostart failed: ${e.message}\n`);
    });
  }

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) { process.exit(0); return; } // a second Ctrl-C exits now
    shuttingDown = true;
    process.stderr.write(`\n[broker] ${sig} received, shutting down…\n`);
    // Hard backstop: exit even if something refuses to close cleanly.
    const force = setTimeout(() => {
      process.stderr.write('[broker] forced exit\n');
      process.exit(0);
    }, 3000);
    force.unref();
    try {
      await server.stop();
    } catch {
      /* ignore */
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
