import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_ENTRIES = 1000;     // cap a single directory listing
const MAX_READ_BYTES = 2_000_000; // cap the text we return for the in-app editor

/**
 * FileSystemManager — a deliberately UNSANDBOXED file browser for the device's
 * whole filesystem, backing the "File Manager" tab. The broker binds to loopback
 * only and the on-device WebView is the sole client, so arbitrary local access is
 * acceptable for this single-user tool; the UI gates destructive actions behind
 * confirms. All paths are absolute (with `~` expanded). Every method returns a
 * plain object — never throws — so the protocol layer can surface { error }.
 */
export class FileSystemManager {
  resolve(p) {
    const s = String(p == null || p === '' ? '~' : p);
    const expanded = s.replace(/^~(?=$|[/\\])/, os.homedir());
    return path.resolve(expanded);
  }

  /** List a directory: folders first, then files, each with light metadata. */
  browse(p) {
    const dir = this.resolve(p);
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return { path: dir, parent: this._parent(dir), entries: [], error: e.message }; }
    const entries = [];
    for (const d of dirents) {
      if (entries.length >= MAX_ENTRIES) break;
      const full = path.join(dir, d.name);
      let st = null;
      try { st = fs.lstatSync(full); } catch { /* ignore */ }
      const symlink = !!st && st.isSymbolicLink();
      // For a symlink, follow it to decide dir-ness (so it sorts/opens sensibly).
      let isDir = d.isDirectory();
      if (symlink) { try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; } }
      entries.push({
        name: d.name,
        dir: isDir,
        size: st && !isDir ? st.size : null,
        mtime: st ? st.mtimeMs : null,
        symlink,
      });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const truncated = dirents.length > entries.length;
    return { path: dir, parent: this._parent(dir), entries, truncated };
  }

  _parent(dir) {
    const parent = path.dirname(dir);
    return parent === dir ? null : parent;
  }

  /** Read a text file for the in-app editor. Refuses binaries + over-large files. */
  read(p) {
    const file = this.resolve(p);
    let st;
    try { st = fs.statSync(file); } catch (e) { return { error: e.message }; }
    if (st.isDirectory()) return { error: 'is a directory' };
    const truncated = st.size > MAX_READ_BYTES;
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return { error: e.message }; }
    const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
    if (slice.includes(0)) return { path: file, content: '', binary: true, size: st.size };
    return { path: file, content: slice.toString('utf8'), truncated, size: st.size };
  }

  write(p, content) {
    const file = this.resolve(p);
    try { fs.writeFileSync(file, content == null ? '' : String(content)); return { ok: true, path: file }; }
    catch (e) { return { error: e.message }; }
  }

  mkdir(parentPath, name) {
    const clean = this._leaf(name);
    if (!clean) return { error: 'invalid folder name' };
    const target = path.join(this.resolve(parentPath), clean);
    try { fs.mkdirSync(target, { recursive: false }); return { ok: true, path: target }; }
    catch (e) { return { error: e.message }; }
  }

  /** Rename in place (same parent directory). */
  rename(p, newName) {
    const src = this.resolve(p);
    const clean = this._leaf(newName);
    if (!clean) return { error: 'invalid name' };
    const dest = path.join(path.dirname(src), clean);
    if (fs.existsSync(dest)) return { error: 'a file with that name already exists' };
    try { fs.renameSync(src, dest); return { ok: true, path: dest }; }
    catch (e) { return { error: e.message }; }
  }

  /** Move into another directory (reorganize). */
  move(p, destDir) {
    const src = this.resolve(p);
    const dir = this.resolve(destDir);
    let dstat;
    try { dstat = fs.statSync(dir); } catch (e) { return { error: `destination: ${e.message}` }; }
    if (!dstat.isDirectory()) return { error: 'destination is not a folder' };
    const dest = path.join(dir, path.basename(src));
    if (path.resolve(dest) === src) return { ok: true, path: src };
    if (fs.existsSync(dest)) return { error: 'destination already has an item with that name' };
    try { fs.renameSync(src, dest); return { ok: true, path: dest }; }
    catch (e) {
      // Cross-device rename fails with EXDEV — fall back to copy+remove.
      if (e.code === 'EXDEV') {
        try { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); return { ok: true, path: dest }; }
        catch (e2) { return { error: e2.message }; }
      }
      return { error: e.message };
    }
  }

  /** Clone (duplicate). Defaults to a "<name> copy" sibling. */
  copy(p, destPath = null) {
    const src = this.resolve(p);
    const dest = destPath ? this.resolve(destPath) : this._uniqueCopyName(src);
    if (path.resolve(dest) === src) return { error: 'source and destination are the same' };
    try { fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false }); return { ok: true, path: dest }; }
    catch (e) { return { error: e.message }; }
  }

  remove(p) {
    const target = this.resolve(p);
    // Guard the truly catastrophic targets even though this tool is unsandboxed.
    if (target === path.parse(target).root || target === os.homedir()) {
      return { error: 'refusing to delete this directory' };
    }
    try { fs.rmSync(target, { recursive: true, force: true }); return { ok: true, path: target }; }
    catch (e) { return { error: e.message }; }
  }

  /** Extract a .zip / .tar / .tar.gz / .tgz into a new sibling folder. */
  extract(p) {
    const archive = this.resolve(p);
    if (!fs.existsSync(archive)) return { error: 'archive not found' };
    const lower = archive.toLowerCase();
    const base = path.basename(archive).replace(/\.(tar\.gz|tgz|tar|zip)$/i, '');
    const outDir = this._uniqueDir(path.join(path.dirname(archive), base || 'extracted'));
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { return { error: e.message }; }
    let cmd, args;
    if (lower.endsWith('.zip')) { cmd = 'unzip'; args = ['-o', archive, '-d', outDir]; }
    else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) { cmd = 'tar'; args = ['xzf', archive, '-C', outDir]; }
    else if (lower.endsWith('.tar')) { cmd = 'tar'; args = ['xf', archive, '-C', outDir]; }
    else { try { fs.rmdirSync(outDir); } catch { /* ignore */ } return { error: 'unsupported archive (use .zip, .tar, .tar.gz, .tgz)' }; }
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000 });
    if (r.error) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ } return { error: `${cmd} not available: ${r.error.message}` }; }
    if (r.status !== 0) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ } return { error: (r.stderr || `${cmd} exited ${r.status}`).trim().split('\n').pop() }; }
    return { ok: true, path: outDir };
  }

  /** A single path component — no separators, no traversal, not empty. */
  _leaf(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s || s === '.' || s === '..' || /[/\\]/.test(s)) return null;
    return s;
  }

  _uniqueCopyName(src) {
    const dir = path.dirname(src);
    const ext = path.extname(src);
    const stem = path.basename(src, ext);
    let candidate = path.join(dir, `${stem} copy${ext}`);
    let n = 2;
    while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem} copy ${n++}${ext}`);
    return candidate;
  }

  _uniqueDir(base) {
    let candidate = base; let n = 2;
    while (fs.existsSync(candidate)) candidate = `${base} ${n++}`;
    return candidate;
  }
}
