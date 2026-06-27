import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

  /** Run `git pull --ff-only` and classify what changed. */
  async update() {
    const top = await this._toplevel();
    const before = (await this._git(['rev-parse', 'HEAD'], { cwd: top })).stdout;
    const pull = await this._git(['pull', '--ff-only'], { cwd: top, timeout: 90000 });
    const after = (await this._git(['rev-parse', 'HEAD'], { cwd: top })).stdout;
    const log = [pull.stdout, pull.stderr].filter(Boolean).join('\n');

    if (pull.code !== 0) {
      return { ok: false, message: firstLine(pull.stderr || pull.stdout) || 'git pull failed', log, top };
    }
    if (before === after) {
      return { ok: true, upToDate: true, fromSha: short(before), toSha: short(after), changed: [], log, top };
    }
    const diff = await this._git(['diff', '--name-only', before, after], { cwd: top });
    const changed = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const cls = classifyChanges(changed);
    const subject = (await this._git(['log', '-1', '--format=%s', after], { cwd: top })).stdout;
    return {
      ok: true, upToDate: false, fromSha: short(before), toSha: short(after), subject,
      changed, count: changed.length, ...cls, log, top,
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
