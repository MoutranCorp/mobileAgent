import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Checkpoints — lets you trust an autonomous agent by snapshotting the project
 * BEFORE each turn and rewinding if you don't like the result.
 *
 * Snapshots are NON-DESTRUCTIVE: we stage the full working tree into a TEMP git
 * index and `commit-tree` it, so neither HEAD, the real index, nor the working
 * tree are touched. Restore rolls tracked files back to the snapshot and removes
 * non-ignored files the agent created since (confined to the project dir; never
 * touches gitignored paths like node_modules). Requires the project to be a git
 * repo (one-tap `enable` runs `git init`).
 */
export class Checkpoints {
  constructor({ stateDir }) {
    this.dir = path.join(stateDir, 'checkpoints');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
  }

  _store(projectId) {
    return path.join(this.dir, `${safe(projectId)}.json`);
  }
  _list(projectId) {
    try { return JSON.parse(fs.readFileSync(this._store(projectId), 'utf8')); } catch { return []; }
  }
  _save(projectId, items) {
    try { fs.writeFileSync(this._store(projectId), JSON.stringify(items.slice(-40), null, 2)); } catch { /* ignore */ }
  }

  isRepo(dir) {
    return !!dir && fs.existsSync(path.join(dir, '.git'));
  }

  enable(dir) {
    if (this.isRepo(dir)) return { ok: true, already: true };
    const r = git(['init'], dir);
    return r.code === 0 ? { ok: true } : { error: r.stderr || 'git init failed' };
  }

  /** Snapshot the working tree without touching HEAD/index/worktree. */
  snapshot(projectId, dir, label) {
    if (!this.isRepo(dir)) return null;
    const idx = path.join(this.dir, `${safe(projectId)}.index`);
    try { fs.rmSync(idx, { force: true }); } catch { /* ignore */ }
    const env = { GIT_INDEX_FILE: idx };
    if (git(['add', '-A'], dir, env).code !== 0) return null;
    const tree = git(['write-tree'], dir, env).stdout.trim();
    if (!tree) return null;
    const head = git(['rev-parse', 'HEAD'], dir).stdout.trim();
    const args = ['commit-tree', tree];
    if (head) args.push('-p', head);
    args.push('-m', label || 'checkpoint');
    const commit = git(args, dir, IDENTITY).stdout.trim();
    try { fs.rmSync(idx, { force: true }); } catch { /* ignore */ }
    if (!commit) return null;
    const items = this._list(projectId);
    const cp = { id: commit.slice(0, 12), commit, tree, label: label || 'checkpoint', time: Date.now() };
    // Avoid consecutive identical snapshots (no changes since last).
    if (items.length && items[items.length - 1].tree === tree) return items[items.length - 1];
    items.push(cp);
    this._save(projectId, items);
    return cp;
  }

  list(projectId, dir) {
    return { items: this._list(projectId).slice().reverse(), enabled: this.isRepo(dir) };
  }

  /** What changed between a checkpoint and the current working tree. */
  changesSince(projectId, dir, id) {
    if (!this.isRepo(dir)) return { id, files: [], stat: '' };
    const cp = this._list(projectId).find((c) => c.id === id || c.commit.startsWith(id));
    if (!cp) return { id, files: [], stat: 'checkpoint not found' };
    // Compare the snapshot tree against the working tree (includes untracked).
    const idx = path.join(this.dir, `${safe(projectId)}.diffindex`);
    try { fs.rmSync(idx, { force: true }); } catch { /* ignore */ }
    git(['add', '-A'], dir, { GIT_INDEX_FILE: idx });
    const nameStatus = git(['diff', '--name-status', '--cached', cp.commit], dir, { GIT_INDEX_FILE: idx });
    const stat = git(['diff', '--stat', '--cached', cp.commit], dir, { GIT_INDEX_FILE: idx });
    try { fs.rmSync(idx, { force: true }); } catch { /* ignore */ }
    const files = nameStatus.stdout.split('\n').filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status.trim(), path: rest.join('\t').trim() };
    });
    return { id: cp.id, label: cp.label, files, stat: stat.stdout.trim() };
  }

  /** HEAD-relative blob content at a checkpoint, for the diff renderer. */
  show(projectId, dir, id, rel) {
    const cp = this._list(projectId).find((c) => c.id === id || c.commit.startsWith(id));
    if (!cp) return '';
    const r = git(['show', `${cp.commit}:${rel}`], dir);
    return r.code === 0 ? r.stdout : '';
  }

  resolve(projectId, id) {
    const cp = this._list(projectId).find((c) => c.id === id || c.commit.startsWith(id));
    return cp ? cp.commit : null;
  }

  /** Roll the working tree back to a checkpoint (safe; never removes ignored files). */
  restore(projectId, dir, id) {
    if (!this.isRepo(dir)) return { error: 'not a git repo' };
    const cp = this._list(projectId).find((c) => c.id === id || c.commit.startsWith(id));
    if (!cp) return { error: 'checkpoint not found' };
    // 1) roll tracked file contents back to the snapshot.
    git(['checkout', cp.commit, '--', '.'], dir);
    // 2) remove non-ignored files that exist now but weren't in the snapshot
    //    (i.e. files the agent created during the turn).
    const snapFiles = new Set(
      git(['ls-tree', '-r', '--name-only', cp.commit], dir).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    );
    const tracked = git(['ls-files'], dir).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const untracked = git(['ls-files', '--others', '--exclude-standard'], dir).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    let removed = 0;
    const rootAbs = path.resolve(dir);
    for (const rel of [...tracked, ...untracked]) {
      if (snapFiles.has(rel)) continue;
      const abs = path.resolve(dir, rel);
      // Defense-in-depth: never delete outside the project dir (require a path
      // separator so a sibling like `proj-secrets` can't match `proj`).
      if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) continue;
      try { fs.rmSync(abs, { force: true }); removed++; } catch { /* ignore */ }
    }
    return { ok: true, id: cp.id, removed };
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'on-device-agent', GIT_AUTHOR_EMAIL: 'agent@localhost',
  GIT_COMMITTER_NAME: 'on-device-agent', GIT_COMMITTER_EMAIL: 'agent@localhost',
};

function git(args, cwd, extraEnv) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...(extraEnv || {}) }, windowsHide: true,
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}
