import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ProjectManager — a "project" is a working directory. By default it discovers
 * the immediate subdirectories of <projectsDir>, but you can also OPEN ANY FOLDER
 * on the device as a workspace (tracked in `workspaces`). Tracks the active
 * project and a stable Metro port per project.
 */
export class ProjectManager {
  constructor({ config, runner, emit }) {
    this.config = config;
    this.runner = runner;
    this.emit = emit;
    this.activeId = null;
    this._stateFile = path.join(config.stateDir, 'projects.json');
    this._meta = this._loadMeta();
    const list = this.list();
    this.activeId = this._meta.activeId && list.find((p) => p.id === this._meta.activeId)
      ? this._meta.activeId
      : list[0]?.id || null;
  }

  _loadMeta() {
    try {
      if (fs.existsSync(this._stateFile))
        return JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
    } catch {
      /* ignore */
    }
    return { activeId: null, order: [], workspaces: [] };
  }

  _saveMeta() {
    try {
      fs.writeFileSync(
        this._stateFile,
        JSON.stringify({ activeId: this.activeId, order: this._meta.order || [], workspaces: this._meta.workspaces || [] }, null, 2)
      );
    } catch {
      /* ignore */
    }
  }

  /** Projects = subdirectories of projectsDir + any opened workspace folders. */
  list() {
    let entries = [];
    try {
      entries = fs
        .readdirSync(this.config.projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      entries = [];
    }
    entries.sort();
    const discovered = entries.map((name, i) => this._describe(name, i));
    const discoveredDirs = new Set(discovered.map((p) => p.dir));
    // Opened folders that live OUTSIDE projectsDir (arbitrary workspaces).
    const extras = (this._meta.workspaces || [])
      .filter((p) => p && fs.existsSync(p) && !discoveredDirs.has(p))
      .map((abs, i) => this._describePath(abs, entries.length + i));
    return [...discovered, ...extras];
  }

  _describe(name, index) {
    const dir = path.join(this.config.projectsDir, name);
    return this._descriptor(name, dir, index);
  }
  _describePath(abs, index) {
    return this._descriptor(abs, abs, index); // id = absolute path for external folders
  }
  _underProjects(dir) {
    const root = this.config.projectsDir;
    return dir === root || dir.startsWith(root + path.sep);
  }
  _descriptor(id, dir, index) {
    return {
      id,
      name: path.basename(dir) || dir,
      dir,
      external: !this._underProjects(dir),
      metroPort: this.config.metroBasePort + index,
      isExpo: this._looksLikeExpo(dir),
      hasGit: fs.existsSync(path.join(dir, '.git')),
      active: id === this.activeId,
    };
  }

  /** Open an arbitrary folder as the active workspace. */
  openPath(p) {
    if (!p) return { error: 'no path' };
    const abs = path.resolve(p.replace(/^~(?=$|\/|\\)/, os.homedir()));
    let stat;
    try { stat = fs.statSync(abs); } catch { return { error: `not found: ${abs}` }; }
    if (!stat.isDirectory()) return { error: `not a folder: ${abs}` };
    this._meta.workspaces = this._meta.workspaces || [];
    if (!this._meta.workspaces.includes(abs) && !abs.startsWith(this.config.projectsDir)) {
      this._meta.workspaces.unshift(abs);
      this._meta.workspaces = this._meta.workspaces.slice(0, 20);
    }
    this.activeId = abs.startsWith(this.config.projectsDir) ? path.basename(abs) : abs;
    this._saveMeta();
    return { project: this.getActive() };
  }

  /** List subdirectories of `p` (default: home) for the folder picker. */
  browse(p) {
    const start = p ? path.resolve(p.replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir();
    let dirs = [];
    try {
      dirs = fs.readdirSync(start, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.git'))
        .map((d) => ({ name: d.name, isProject: fs.existsSync(path.join(start, d.name, 'package.json')) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 300);
    } catch (e) {
      return { path: start, parent: path.dirname(start), dirs: [], error: e.message };
    }
    const parent = path.dirname(start);
    return { path: start, parent: parent === start ? null : parent, dirs };
  }

  _looksLikeExpo(dir) {
    try {
      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return !!(deps.expo || deps['expo-router'] || deps['react-native']);
    } catch {
      return false;
    }
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  getActive() {
    if (!this.activeId) return null;
    return this.get(this.activeId);
  }

  setActive(id) {
    const p = this.get(id);
    if (!p) return null;
    this.activeId = id;
    this._saveMeta();
    return p;
  }

  /**
   * Create a project. If template === 'expo', scaffolds with create-expo-app;
   * 'blank' just makes a directory with a starter file. Streams output on the
   * 'create' channel. Returns the new project descriptor.
   */
  async create(name, template = 'expo') {
    const safe = name.replace(/[^a-zA-Z0-9-_]/g, '-');
    const dir = path.join(this.config.projectsDir, safe);
    if (fs.existsSync(dir)) {
      return { error: `Project '${safe}' already exists`, project: this.get(safe) };
    }

    if (template === 'expo') {
      const cmd = `npx --yes create-expo-app@latest ${safe}`;
      const res = await this.runner.run(`create:${safe}`, cmd, { cwd: this.config.projectsDir });
      if (res.code !== 0) {
        return { error: `create-expo-app exited with ${res.code}`, project: null };
      }
      // Ensure dev-client is available for the test loop.
      await this.runner.run(`create:${safe}`, `npx --yes expo install expo-dev-client`, { cwd: dir });
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'README.md'),
        `# ${safe}\n\nCreated by the on-device agent broker.\n`
      );
    }

    this.setActive(safe);
    return { project: this.get(safe) };
  }

  snapshot() {
    return { projects: this.list(), activeProjectId: this.activeId };
  }
}
