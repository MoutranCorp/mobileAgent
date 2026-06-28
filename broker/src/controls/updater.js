import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_DIR = path.join(__dirname, '..', '..'); // .../broker
const SEP = String.fromCharCode(31); // unit separator for git --format fields

/**
 * Self-update: pulls the app's own git repo (the one this broker runs from) so
 * the user can update from inside the app instead of dropping to a shell. Web-UI
 * changes apply on a browser reload (the broker serves web-ui from disk); broker
 * source changes need a broker restart — we detect which and tell the UI.
 */
export class Updater {
  constructor({ cwd = BROKER_DIR } = {}) {
    this.cwd = cwd;
    this._top = null;
  }

  _git(args, { cwd, timeout = 20000 } = {}) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: cwd || this.cwd, timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      });
    });
  }

  async _toplevel() {
    if (this._top) return this._top;
    const r = await this._git(['rev-parse', '--show-toplevel']);
    // Cache ONLY a successful resolution — a transient failure (.git not yet present,
    // FS hiccup) must not permanently pin the toplevel to the cwd fallback.
    if (r.code === 0 && r.stdout) { this._top = r.stdout; return this._top; }
    return this.cwd;
  }

  /** Current version: short sha, subject, relative time, branch, dirty flag. */
  async version() {
    const top = await this._toplevel();
    const log = await this._git(['log', '-1', `--format=%h${SEP}%s${SEP}%cr`], { cwd: top });
    const branch = await this._git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top });
    const status = await this._git(['status', '--porcelain'], { cwd: top });
    const [sha = '', subject = '', when = ''] = log.stdout.split(SEP);
    return { ok: log.code === 0, sha, subject, when, branch: branch.stdout || 'HEAD', dirty: !!status.stdout, top };
  }

  /**
   * Update to the latest commit on the current branch. The broker runs from a
   * `git clone --depth 1` (shallow) delivery clone, and `git pull` on a shallow
   * clone is fragile — it can fail with "did not send all necessary objects", and a
   * half-finished pull corrupts the local object store ("bad object …"). So we
   * **fetch the branch tip at depth 1 and hard-reset to it**: no history
   * reconciliation, and it jumps straight to the new tip even if the old HEAD is
   * corrupt. If even the fetch fails (deeper corruption), we re-clone fresh.
   */
  async update() {
    const top = await this._toplevel();
    // Pre-check for a dirty tree: a hard reset would silently discard local edits.
    const dirty = await this._git(['status', '--porcelain'], { cwd: top });
    if (dirty.code === 0 && dirty.stdout.trim()) {
      return {
        ok: false,
        dirty: true,
        message: 'Local changes would be overwritten by update — commit, stash, or discard them first.',
        log: dirty.stdout,
        top,
      };
    }
    const branch = (await this._git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top })).stdout || 'main';
    const before = (await this._git(['rev-parse', 'HEAD'], { cwd: top })).stdout;
    const fetch = await this._git(['fetch', '--depth=1', 'origin', branch], { cwd: top, timeout: 120000 });
    if (fetch.code === 0) {
      const reset = await this._git(['reset', '--hard', 'FETCH_HEAD'], { cwd: top });
      if (reset.code === 0) {
        const after = (await this._git(['rev-parse', 'HEAD'], { cwd: top })).stdout;
        const log = [fetch.stdout, fetch.stderr, reset.stdout].filter(Boolean).join('\n');
        if (before && before === after) {
          return { ok: true, upToDate: true, fromSha: short(before), toSha: short(after), changed: [], log, top };
        }
        const diff = before ? await this._git(['diff', '--name-only', before, after], { cwd: top }) : { code: 1 };
        const changed = diff.code === 0 ? diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
        // If we couldn't diff (corrupt/absent old HEAD), assume the worst so the user restarts.
        const cls = diff.code === 0 ? classifyChanges(changed) : { needsReload: true, needsRestart: true, needsRebuild: false };
        const subject = (await this._git(['log', '-1', '--format=%s', after], { cwd: top })).stdout;
        return {
          ok: true, upToDate: false, fromSha: short(before), toSha: short(after), subject,
          changed, count: changed.length, ...cls, log, top,
        };
      }
    }
    // Fetch (or reset) failed — the local clone is likely corrupt. Re-clone fresh.
    return this._reclone(top, branch, [fetch.stdout, fetch.stderr].filter(Boolean).join('\n'));
  }

  /** Last-resort recovery: clone a fresh copy beside the broken clone and swap it in.
   *  The clone holds no user data (projects/sessions live outside it), so this is
   *  safe; the running broker keeps its open files until a restart picks up the new
   *  copy. Uses the existing origin URL + stored git credentials. */
  async _reclone(top, branch, priorLog = '') {
    let url = (await this._git(['remote', 'get-url', 'origin'], { cwd: top })).stdout;
    // If the clone is corrupt enough that even `git remote` fails, read the URL
    // straight out of .git/config (plain text, no objects needed).
    if (!url) {
      try { url = (fs.readFileSync(path.join(top, '.git', 'config'), 'utf8').match(/^\s*url\s*=\s*(.+)$/m) || [])[1]?.trim() || ''; } catch { /* ignore */ }
    }
    if (!url) return { ok: false, message: 'Update failed and no origin URL to re-clone from.', log: priorLog, top };
    const parent = path.dirname(top);
    const tmp = path.join(parent, path.basename(top) + '.new');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    const clone = await this._git(['clone', '--depth', '1', '--branch', branch, url, tmp], { cwd: parent, timeout: 180000 });
    if (clone.code !== 0) {
      return { ok: false, message: 'Re-clone failed: ' + (firstLine(clone.stderr || clone.stdout) || 'git clone error'), log: [priorLog, clone.stderr].filter(Boolean).join('\n'), top };
    }
    try {
      fs.rmSync(top, { recursive: true, force: true });
      fs.renameSync(tmp, top);
    } catch (e) {
      return { ok: false, message: 'Re-clone swap failed: ' + e.message, log: priorLog, top };
    }
    const after = (await this._git(['rev-parse', 'HEAD'], { cwd: top })).stdout;
    return {
      ok: true, recloned: true, upToDate: false, toSha: short(after), changed: [],
      needsReload: true, needsRestart: true,
      message: 'The local clone was corrupt — re-cloned a fresh copy. Stop & Start the runtime to apply.',
      log: [priorLog, 'Re-cloned ' + url].filter(Boolean).join('\n'), top,
    };
  }
}

/**
 * Decide what a set of changed repo paths requires to take effect:
 *   - web-ui changes apply on a browser reload (served from disk)
 *   - broker source / deps changes need a broker restart
 *   - android changes need an APK rebuild (informational)
 * Pure + exported so it's unit-testable without touching git.
 */
export function classifyChanges(paths) {
  const p = paths || [];
  const needsReload = p.some((f) => f.startsWith('broker/web-ui/'));
  const needsRestart = p.some((f) => /^broker\/src\//.test(f) || /^broker\/package(-lock)?\.json$/.test(f));
  const needsRebuild = p.some((f) => f.startsWith('android/'));
  return { needsReload, needsRestart, needsRebuild };
}

function short(sha) { return (sha || '').slice(0, 7); }
function firstLine(s) { return (s || '').split('\n')[0]; }
