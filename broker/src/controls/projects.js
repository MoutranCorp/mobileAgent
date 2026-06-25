import fs from 'node:fs';
import path from 'node:path';

/**
 * ProjectManager — each project is a directory under <projectsDir>. Tracks the
 * active project and assigns a stable Metro port per project (base + index) so
 * multiple projects can run side by side (Phase 5).
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
    return { activeId: null, order: [] };
  }

  _saveMeta() {
    try {
      fs.writeFileSync(
        this._stateFile,
        JSON.stringify({ activeId: this.activeId, order: this._meta.order || [] }, null, 2)
      );
    } catch {
      /* ignore */
    }
  }

  /** All projects = immediate subdirectories of projectsDir. */
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
    // Preserve a stable order so port assignment is deterministic.
    entries.sort();
    return entries.map((name, i) => this._describe(name, i));
  }

  _describe(name, index) {
    const dir = path.join(this.config.projectsDir, name);
    return {
      id: name,
      name,
      dir,
      metroPort: this.config.metroBasePort + index,
      isExpo: this._looksLikeExpo(dir),
      hasGit: fs.existsSync(path.join(dir, '.git')),
      active: name === this.activeId,
    };
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
