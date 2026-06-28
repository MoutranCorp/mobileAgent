import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Persist the user's valuable data to a location that survives an app uninstall.
 *
 * Everything the broker uses lives in the app's INTERNAL storage (the proot
 * rootfs), which Android wipes on uninstall. `/sdcard` (primary shared storage) is
 * bind-mounted into the guest and is NOT wiped on uninstall, so we mirror the few
 * things worth keeping there:
 *   - projects   (the user's code)
 *   - state      (broker state dir: sessions/transcripts, prompts, settings, usage)
 *   - credentials (~/.claude/.credentials.json, so the Claude login survives)
 *
 * The rootfs/toolchain still re-provisions on a fresh install (it can't live on the
 * FUSE sdcard — no exec/symlinks), but the user's work and login are restored.
 * Restore is non-destructive: it only runs when the live data is empty/fresh, so it
 * never clobbers an existing environment.
 */
const BACKUP_ROOT = process.env.BACKUP_DIR || '/sdcard/MobileAgentBackup';
const OK_MARKER = '.backup_ok';

function home() { return process.env.HOME || os.homedir(); }
function credsPath() { return path.join(home(), '.claude', '.credentials.json'); }

function spec(config) {
  return [
    { name: 'projects', src: config.projectsDir, dir: true },
    { name: 'state', src: config.stateDir, dir: true },
    { name: 'credentials', src: credsPath(), dir: false },
  ];
}

/** Is the shared-storage backup root usable (i.e. /sdcard is mounted + writable)? */
export function backupEnabled() {
  try {
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    fs.accessSync(BACKUP_ROOT, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

/** Read the last-backup manifest (for the UI), or null if there's no valid backup. */
export function backupInfo() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(BACKUP_ROOT, OK_MARKER), 'utf8'));
    return { ...m, dir: BACKUP_ROOT };
  } catch { return null; }
}

function nonEmptyDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; } catch { return false; }
}

/** "Fresh" = no projects AND no recorded sessions — safe to restore into. */
function isFresh(config) {
  const hasProjects = nonEmptyDir(config.projectsDir);
  const hasSessions = nonEmptyDir(path.join(config.stateDir, 'transcripts'));
  return !hasProjects && !hasSessions;
}

async function copyIntoAsync(src, dest, isDir) {
  if (!fs.existsSync(src)) return false;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.cp(src, dest, isDir ? { recursive: true } : {});
  return true;
}
function copyInto(src, dest, isDir) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isDir) fs.cpSync(src, dest, { recursive: true });
  else fs.cpSync(src, dest);
  return true;
}

/** Mirror the live data to the shared-storage backup. Async (so a periodic backup
 *  doesn't block the event loop) + atomic-ish: the OK marker is written LAST, so a
 *  partial/interrupted copy is never treated as valid on restore. */
export async function backupNow(config, { stamp = new Date().toISOString() } = {}) {
  if (!backupEnabled()) return { ok: false, error: 'shared storage not available' };
  const items = [];
  try {
    // Invalidate the previous marker first: while we overwrite, there's no valid
    // backup, so an interrupted run can't leave a half-written "valid" snapshot.
    try { await fs.promises.rm(path.join(BACKUP_ROOT, OK_MARKER), { force: true }); } catch { /* ignore */ }
    for (const s of spec(config)) {
      const dest = path.join(BACKUP_ROOT, s.name);
      try { await fs.promises.rm(dest, { recursive: true, force: true }); } catch { /* ignore */ }
      if (await copyIntoAsync(s.src, dest, s.dir)) items.push(s.name);
    }
    const manifest = { when: stamp, items, version: 1 };
    await fs.promises.writeFile(path.join(BACKUP_ROOT, OK_MARKER), JSON.stringify(manifest));
    return { ok: true, ...manifest, dir: BACKUP_ROOT };
  } catch (e) {
    return { ok: false, error: e.message, items };
  }
}

/** Restore from the shared-storage backup, but ONLY into a fresh (empty) install. */
export function restoreIfFresh(config) {
  const info = backupInfo();
  if (!info) return { restored: false, reason: 'no-backup' };
  if (!isFresh(config)) return { restored: false, reason: 'existing-data' };
  const items = [];
  try {
    for (const s of spec(config)) {
      const src = path.join(BACKUP_ROOT, s.name);
      if (copyInto(src, s.src, s.dir)) items.push(s.name);
    }
    return { restored: true, items, when: info.when };
  } catch (e) {
    return { restored: false, reason: 'error', error: e.message, items };
  }
}
