import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', '.expo', 'dist', 'build', '.next', '.gradle', 'ios/Pods']);
const MAX_FILE = 256 * 1024;

/**
 * Files — a read-only project browser for the UI: tree listing, file read
 * (size-capped), fuzzy path search (for @-mentions), and the git changed-files
 * list. Heavy/generated dirs are skipped. Everything is confined to the project
 * dir (path traversal is rejected).
 */
export class Files {
  constructor({ getProjectDir }) {
    this.getProjectDir = getProjectDir;
  }

  _root() {
    return this.getProjectDir();
  }
  _safe(rel) {
    const root = this._root();
    if (!root) return null;
    const abs = path.resolve(root, rel || '.');
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  list(rel = '.') {
    const abs = this._safe(rel);
    if (!abs) return { path: rel, entries: [], error: 'bad path' };
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((d) => !(d.isDirectory() && SKIP.has(d.name)))
        .map((d) => ({
          name: d.name,
          dir: d.isDirectory(),
          size: d.isDirectory() ? 0 : safeSize(path.join(abs, d.name)),
        }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    } catch (e) {
      return { path: rel, entries: [], error: e.message };
    }
    return { path: normRel(this._root(), abs), entries, changed: this.changed() };
  }

  read(rel) {
    const abs = this._safe(rel);
    if (!abs) return { path: rel, content: '', error: 'bad path' };
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE) {
        const fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(MAX_FILE);
        fs.readSync(fd, buf, 0, MAX_FILE, 0);
        fs.closeSync(fd);
        return { path: rel, content: buf.toString('utf8'), truncated: true };
      }
      return { path: rel, content: fs.readFileSync(abs, 'utf8'), truncated: false };
    } catch (e) {
      return { path: rel, content: '', error: e.message };
    }
  }

  search(query, limit = 40) {
    const root = this._root();
    if (!root || !query) return { query, matches: [] };
    const q = query.toLowerCase();
    const matches = [];
    const walk = (abs, rel, depth) => {
      if (matches.length >= limit || depth > 8) return;
      let dirents = [];
      try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const d of dirents) {
        if (matches.length >= limit) return;
        if (d.isDirectory() && SKIP.has(d.name)) continue;
        if (d.name.startsWith('.git')) continue;
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(path.join(abs, d.name), childRel, depth + 1);
        else if (childRel.toLowerCase().includes(q)) matches.push(childRel);
      }
    };
    walk(root, '', 0);
    return { query, matches };
  }

  changed() {
    const root = this._root();
    if (!root || !fs.existsSync(path.join(root, '.git'))) return [];
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return [];
    return (r.stdout || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }))
      .slice(0, 200);
  }

  /**
   * Working-tree diff for one file as {before, after} for the renderer. `ref`
   * defaults to HEAD; pass a checkpoint commit to review changes since it.
   */
  diff(rel, ref = 'HEAD') {
    const root = this._root();
    const abs = this._safe(rel);
    if (!root || !abs) return { path: rel, before: '', after: '', error: 'bad path' };
    const isRepo = fs.existsSync(path.join(root, '.git'));
    let after = '';
    let exists = true;
    try { after = fs.readFileSync(abs, 'utf8'); } catch { exists = false; }
    let before = '';
    if (isRepo) {
      const r = spawnSync('git', ['show', `${ref}:${rel}`], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (r.status === 0) before = r.stdout;
    }
    const status = !before && exists ? 'A' : before && !exists ? 'D' : 'M';
    return { path: rel, before, after, status, ref };
  }

  /** Content search across the project (literal, case-insensitive). */
  grep(query, { maxResults = 120, maxFiles = 4000 } = {}) {
    const root = this._root();
    if (!root || !query) return { query, matches: [], truncated: false };
    const q = query.toLowerCase();
    const matches = [];
    let filesScanned = 0;
    let truncated = false;
    const walk = (abs, rel, depth) => {
      if (truncated || depth > 10) return;
      let dirents = [];
      try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const d of dirents) {
        if (matches.length >= maxResults || filesScanned >= maxFiles) { truncated = true; return; }
        if (d.isDirectory() && SKIP.has(d.name)) continue;
        if (d.name.startsWith('.git')) continue;
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        const childAbs = path.join(abs, d.name);
        if (d.isDirectory()) { walk(childAbs, childRel, depth + 1); continue; }
        filesScanned++;
        let content;
        try {
          const st = fs.statSync(childAbs);
          if (st.size > MAX_FILE) continue;
          content = fs.readFileSync(childAbs, 'utf8');
        } catch { continue; }
        if (content.indexOf(String.fromCharCode(0)) !== -1) continue; // NUL byte -> binary, skip
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            matches.push({ path: childRel, line: i + 1, text: lines[i].slice(0, 200).trim() });
            if (matches.length >= maxResults) { truncated = true; return; }
          }
        }
      }
    };
    walk(root, '', 0);
    return { query, matches, truncated };
  }

  /** Write a file within the project (inline edit / .env). Creates parent dirs. */
  write(rel, content) {
    const abs = this._safe(rel);
    if (!abs) return { path: rel, error: 'bad path' };
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content == null ? '' : String(content));
      return { path: rel, ok: true };
    } catch (e) {
      return { path: rel, error: e.message };
    }
  }

  /**
   * Literal find & replace across the project. Returns {filesChanged, replacements,
   * files}. Skips heavy/binary files. The caller should checkpoint first.
   */
  replaceAll(query, replacement, { maxFiles = 4000 } = {}) {
    const root = this._root();
    if (!root || !query) return { query, replacement, filesChanged: 0, replacements: 0, files: [] };
    let filesChanged = 0, replacements = 0, scanned = 0;
    const files = [];
    const NUL = String.fromCharCode(0);
    const walk = (abs, rel, depth) => {
      if (depth > 10 || scanned >= maxFiles) return;
      let dirents = [];
      try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const d of dirents) {
        if (scanned >= maxFiles) return;
        if (d.isDirectory() && SKIP.has(d.name)) continue;
        if (d.name.startsWith('.git')) continue;
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        const childAbs = path.join(abs, d.name);
        if (d.isDirectory()) { walk(childAbs, childRel, depth + 1); continue; }
        scanned++;
        let content;
        try {
          if (fs.statSync(childAbs).size > MAX_FILE) continue;
          content = fs.readFileSync(childAbs, 'utf8');
        } catch { continue; }
        if (content.indexOf(NUL) !== -1 || !content.includes(query)) continue;
        const count = content.split(query).length - 1;
        const next = content.split(query).join(replacement == null ? '' : replacement);
        try { fs.writeFileSync(childAbs, next); } catch { continue; }
        filesChanged++; replacements += count; files.push({ path: childRel, count });
      }
    };
    walk(root, '', 0);
    return { query, replacement, filesChanged, replacements, files };
  }

  /** package.json scripts for the active project. */
  scripts() {
    const root = this._root();
    if (!root) return [];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return Object.entries(pkg.scripts || {}).map(([name, cmd]) => ({ name, cmd: String(cmd) }));
    } catch {
      return [];
    }
  }
}

function safeSize(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}
function normRel(root, abs) {
  const r = path.relative(root, abs).split(path.sep).join('/');
  return r || '.';
}
