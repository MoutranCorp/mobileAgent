import fs from 'node:fs';
import path from 'node:path';
import { EventType, event } from '../protocol.js';

/**
 * DevTools — the control surface the UI's buttons map to: Metro lifecycle, git,
 * EAS cloud builds, and arbitrary command execution. All output streams through
 * the ProcessRunner as canonical control_output events; nothing here blocks the
 * agent loop.
 */
export class DevTools {
  constructor({ config, runner, projects, emit }) {
    this.config = config;
    this.runner = runner;
    this.projects = projects;
    this.emit = emit;
    this._metro = new Map(); // projectId -> { port, url }
  }

  _resolveProject(projectId) {
    if (projectId) return this.projects.get(projectId);
    return this.projects.getActive();
  }

  // --- Metro ------------------------------------------------------------------

  metroChannel(projectId) {
    return `metro:${projectId}`;
  }

  startMetro(projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return this._err('No active project to start Metro for.');
    const channel = this.metroChannel(project.id);
    const port = project.metroPort;

    if (this.runner.isRunning(channel)) {
      const info = this._metro.get(project.id) || { port, url: `exp://127.0.0.1:${port}` };
      this._emitMetro(project.id, true, info.port, info.url);
      return info;
    }

    // --localhost binds 127.0.0.1; --dev-client targets the custom dev client.
    const cmd = `npx --yes expo start --localhost --dev-client --port ${port}`;
    const env = {
      // Metro file-watching is flaky under proot; fall back to Node's watcher.
      WATCHMAN_DISABLE: '1',
      CI: '0',
      EXPO_NO_TELEMETRY: '1',
    };
    this.runner.start(channel, cmd, { cwd: project.dir, env });

    const url = `exp://127.0.0.1:${port}`;
    const info = { port, url };
    this._metro.set(project.id, info);
    this._emitMetro(project.id, true, port, url);
    return info;
  }

  stopMetro(projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return;
    const channel = this.metroChannel(project.id);
    this.runner.stop(channel);
    this._metro.delete(project.id);
    this._emitMetro(project.id, false, project.metroPort, null);
  }

  isMetroRunning(projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return false;
    return this.runner.isRunning(this.metroChannel(project.id));
  }

  metroInfo(projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return null;
    const running = this.runner.isRunning(this.metroChannel(project.id));
    const info = this._metro.get(project.id) || {
      port: project.metroPort,
      url: `exp://127.0.0.1:${project.metroPort}`,
    };
    return { running, projectId: project.id, ...info };
  }

  _emitMetro(projectId, running, port, url) {
    this.emit(event(EventType.METRO_STATUS, { running, port, url, projectId }));
  }

  // --- git --------------------------------------------------------------------

  async git(op, args = {}, projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return this._err('No active project for git.');
    const cwd = project.dir;
    const channel = 'git';
    // Run git with an explicit argv (NO shell) so caller/agent-supplied values
    // (paths, messages, URLs) can never be interpreted as shell syntax.
    const git = (a) => this.runner.runArgs(channel, 'git', a, { cwd });
    let res;
    switch (op) {
      case 'init': res = await git(['init']); break;
      case 'status': res = await git(['status', '--short', '--branch']); break;
      case 'diff': res = await git(args.staged ? ['diff', '--cached'] : ['diff']); break;
      case 'log': res = await git(['log', '--oneline', '-n', String(Number(args.n) || 20)]); break;
      case 'add': {
        const paths = Array.isArray(args.paths) ? args.paths : (args.paths ? [String(args.paths)] : null);
        res = await git(['add', ...(paths || ['-A'])]);
        break;
      }
      case 'discard': {
        // Revert a tracked file to HEAD, then remove it if untracked. Scoped to the
        // single path so nothing else is touched.
        const co = await git(['checkout', 'HEAD', '--', String(args.path)]);
        const cl = await git(['clean', '-fq', '--', String(args.path)]);
        res = { code: co.code || cl.code, stdout: (co.stdout || '') + (cl.stdout || ''), stderr: (co.stderr || '') + (cl.stderr || '') };
        break;
      }
      case 'commit': {
        const msg = args.message || 'Update from on-device agent';
        const add = await git(['add', '-A']);
        const ci = await git(['commit', '-m', msg]);
        res = { code: add.code || ci.code, stdout: (add.stdout || '') + (ci.stdout || ''), stderr: (add.stderr || '') + (ci.stderr || '') };
        break;
      }
      case 'push': res = await git(['push', args.remote || 'origin', args.branch || 'HEAD']); break;
      case 'remote-add': res = await git(['remote', 'add', args.name || 'origin', String(args.url)]); break;
      default:
        return this._err(`Unknown git op: ${op}`);
    }
    this.emit(event(EventType.GIT_STATUS, { op, code: res.code, output: res.stdout || res.stderr }));
    return res;
  }

  // --- EAS (cloud build) ------------------------------------------------------

  async easBuild({ profile = 'development', platform = 'android' } = {}, projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return this._err('No active project for EAS build.');
    const cmd = `npx --yes eas-cli build --profile ${profile} --platform ${platform} --non-interactive`;
    // EAS build is long; stream it on its own channel. The build URL appears in
    // stdout and the UI surfaces it for install.
    this.runner.start('eas', cmd, { cwd: project.dir });
    this.emit(
      event(EventType.CONTROL_STATUS, {
        channel: 'eas',
        state: 'running',
        detail: `eas build ${profile}/${platform}`,
      })
    );
    return { started: true };
  }

  // --- npm scripts ------------------------------------------------------------

  scriptChannel(name) {
    return `script:${name}`;
  }

  runScript(name, projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return this._err('No active project to run a script.');
    const channel = this.scriptChannel(name);
    if (this.runner.isRunning(channel)) return { alreadyRunning: true };
    // Long-running scripts (dev/start) are tracked so they can be stopped.
    this.runner.start(channel, `npm run ${name}`, {
      cwd: project.dir,
      env: { WATCHMAN_DISABLE: '1', EXPO_NO_TELEMETRY: '1', FORCE_COLOR: '0' },
    });
    return { started: true, channel };
  }

  stopScript(name) {
    return this.runner.stop(this.scriptChannel(name));
  }

  isScriptRunning(name) {
    return this.runner.isRunning(this.scriptChannel(name));
  }

  // --- GitHub / publish -------------------------------------------------------

  async githubPush({ commit = true, message } = {}, projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return this._err('No active project to push.');
    const cwd = project.dir;
    if (commit) {
      await this.runner.runArgs('github', 'git', ['add', '-A'], { cwd });
      await this.runner.runArgs('github', 'git', ['commit', '-m', message || 'Update from on-device agent'], { cwd });
    }
    const res = await this.runner.runArgs('github', 'git', ['push', '-u', 'origin', 'HEAD'], { cwd });
    this.emit(event(EventType.GITHUB, {
      op: 'push', ok: res.code === 0, message: (res.stderr || res.stdout || '').trim(),
    }));
    return res;
  }

  async githubPr({ title, body = '', base } = {}, projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return this._err('No active project for PR.');
    const cwd = project.dir;
    // Push first so the branch exists on the remote.
    await this.runner.runArgs('github', 'git', ['push', '-u', 'origin', 'HEAD'], { cwd });
    const prArgs = ['pr', 'create'];
    if (title) prArgs.push('--title', title, '--body', body || ''); else prArgs.push('--fill');
    if (base) prArgs.push('--base', base);
    const res = await this.runner.runArgs('github', 'gh', prArgs, { cwd });
    const url = (res.stdout || '').match(/https?:\/\/\S+/)?.[0] || null;
    this.emit(event(EventType.GITHUB, {
      op: 'pr', ok: res.code === 0, url,
      message: res.code === 0 ? (url || 'PR created') :
        ((res.stderr || res.stdout || '').trim() || 'gh pr create failed — is the GitHub CLI installed & authenticated?'),
    }));
    return res;
  }

  async gitRemoteSet({ url, name = 'origin' } = {}, projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return this._err('No active project.');
    const cwd = project.dir;
    let res = await this.runner.runArgs('github', 'git', ['remote', 'add', name, String(url)], { cwd });
    if (res.code !== 0) res = await this.runner.runArgs('github', 'git', ['remote', 'set-url', name, String(url)], { cwd });
    this.emit(event(EventType.GITHUB, { op: 'remote', ok: res.code === 0, message: `origin → ${url}` }));
    return res;
  }

  // --- arbitrary command ------------------------------------------------------

  async run(command, { cwd, projectId } = {}) {
    const project = this._resolveProject(projectId);
    const dir = cwd || project?.dir || this.config.projectsDir;
    return this.runner.run('run', command, { cwd: dir });
  }

  // --- native-dep change detection (Phase 4) ----------------------------------

  /**
   * Heuristic: a native rebuild is needed if app.json plugins or native deps in
   * package.json changed since the last dev-client build. We snapshot a hash of
   * the relevant fields; the UI prompts "native change detected — rebuild?".
   */
  nativeFingerprint(projectId) {
    const project = this._resolveProject(projectId);
    if (!project) return null;
    const pkgPath = path.join(project.dir, 'package.json');
    const appJsonPath = path.join(project.dir, 'app.json');
    let deps = {};
    let plugins = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      deps = pkg.dependencies || {};
    } catch {
      /* ignore */
    }
    try {
      const app = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      plugins = app.expo?.plugins || [];
    } catch {
      /* ignore */
    }
    // Native-ish deps: anything outside the pure-JS comfort zone.
    const nativeDeps = Object.keys(deps).filter((d) =>
      /^(react-native-|expo-|@react-native|@shopify\/react-native|react-native$)/.test(d)
    );
    return { nativeDeps: nativeDeps.sort(), plugins };
  }

  _err(message) {
    this.emit(event(EventType.ERROR, { message }));
    return { error: message };
  }
}
