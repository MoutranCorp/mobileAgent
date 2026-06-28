import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventType, event } from '../protocol.js';

/**
 * DevTools — the control surface the UI's buttons map to: Metro lifecycle, git,
 * EAS cloud builds, and arbitrary command execution. All output streams through
 * the ProcessRunner as canonical control_output events; nothing here blocks the
 * agent loop.
 */
export class DevTools {
  constructor({ config, runner, projects, emit, userSettings }) {
    this.config = config;
    this.runner = runner;
    this.projects = projects;
    this.emit = emit;
    this.userSettings = userSettings; // for the Expo target (Go vs dev-client)
    this._metro = new Map(); // projectId -> { port, url, ready }
  }

  /** Expo client target. Default 'go' (Expo Go — installed from the store, no build);
   *  'dev-client' targets a custom development build. User-settable (expo.mode). */
  _expoFlag() {
    const mode = this.userSettings?.get?.()?.expo?.mode;
    return mode === 'dev-client' ? '--dev-client' : '--go';
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
    // Use `localhost`, not `127.0.0.1`: `expo start --localhost` binds whatever
    // `localhost` resolves to (often IPv6 `::1` in the Debian guest), so an IPv4
    // exp:// URL is refused. `localhost` resolves the same way on the device, so
    // Expo Go reaches the same socket Metro bound.
    const url = `exp://localhost:${port}`;

    if (this.runner.isRunning(channel)) {
      const info = this._metro.get(project.id) || { port, url };
      // Already alive — re-probe so we report ready (badge + Open) only if it truly is.
      this._awaitReady(project.id, port, url);
      return info;
    }

    // Metro must run IN the Expo app dir. Agents often scaffold into a subfolder
    // (`create-expo-app demo` → demo/), so search the project + its immediate
    // children. No Expo project → tell the user instead of spawning a doomed start.
    const expoDir = this._resolveExpoDir(project.dir);
    if (!expoDir) {
      this._emitMetro(project.id, false, port, null,
        'No Expo project found in this folder or its subfolders. Create one first ' +
        '(e.g. ask the agent to run `npx create-expo-app .`), then press Test.');
      return this._err('No Expo project found.');
    }

    // --localhost binds 127.0.0.1; the client flag picks Expo Go vs a dev build.
    const cmd = `npx --yes expo start --localhost ${this._expoFlag()} --port ${port}`;
    const env = {
      // Metro file-watching is flaky under proot; fall back to Node's watcher.
      WATCHMAN_DISABLE: '1',
      CI: '0',
      EXPO_NO_TELEMETRY: '1',
    };
    const { promise } = this.runner.start(channel, cmd, { cwd: expoDir, env });
    this._metro.set(project.id, { port, url, ready: false });
    // Print the Expo Go URL into the terminal. Expo's QR code + "Press a │ open
    // Android" menu only render when it's attached to a real TTY; run headlessly
    // (piped) it stays silent, so surface the deep link ourselves — the Test button
    // opens it, or paste it into Expo Go → "Enter URL manually".
    this.emit(event(EventType.CONTROL_OUTPUT, {
      channel, stream: 'stdout',
      data: `\n▶ Open in Expo Go: ${url}  (Test opens this for you; or paste it into Expo Go → Enter URL manually)\n`,
    }));
    // Report STARTING (not running) — the UI shows progress and only opens the dev
    // client once Metro is actually ready (see _awaitReady). Reporting running too
    // early was the "Test does nothing" bug: the dev client opened before Metro was
    // listening, so it connected to nothing.
    this._emitMetro(project.id, false, port, url, null, /* starting */ true);

    // Surface an early crash (not an Expo app, missing deps, port in use, …) — the
    // process exit otherwise left the UI stuck on a stale "starting" with no reason.
    if (promise) {
      promise.then((r) => {
        const info = this._metro.get(project.id);
        const wasReady = !!(info && info.ready);
        this._metro.delete(project.id);
        this._emitMetro(project.id, false, port, null,
          wasReady ? null
            : `Metro exited (code ${r.code ?? r.signal}). Open the Terminal for the reason ` +
              '(common fixes: run `npm install` in the app, or check the Expo SDK).');
      });
    }

    // Flip to running only when Metro actually answers — this is what the UI waits on.
    this._awaitReady(project.id, port, url);
    return { port, url, starting: true };
  }

  /** Poll the dev-server port until it answers an HTTP request (see _probeMetro),
   *  then emit running=true. Version-robust (independent of expo's log wording).
   *  Gives up quietly if the process exits (exit handler reports it) or on timeout. */
  async _awaitReady(projectId, port, url, timeoutMs = 150000) {
    const channel = this.metroChannel(projectId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.runner.isRunning(channel)) return; // exited → exit handler emits the error
      const host = await this._probeMetro(port);
      if (host) {
        const info = this._metro.get(projectId);
        if (info) info.ready = true;
        this._emitMetro(projectId, true, port, url);
        this._diagnoseExpoManifest(this.metroChannel(projectId), port, host); // log what Expo Go would receive
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Still alive but slow — leave it running, just stop claiming "starting".
    this._emitMetro(projectId, false, port, url,
      'Metro is taking longer than expected — watch the Terminal, then press Open when it’s ready.');
  }

  /** Returns the host (`127.0.0.1` or `::1`) the dev server answers on, or null if
   *  not up yet. We try BOTH families because `expo start --localhost` binds whatever
   *  `localhost` resolves to — often IPv6 `::1` in the guest — so an IPv4-only probe
   *  hung forever ("Starting" with no diag). We hit the MANIFEST endpoint Expo Go uses
   *  (GET / + expo-platform), not /status (Expo leaves that hanging). Any HTTP
   *  response = up. */
  _probeMetro(port) {
    const tryHost = (host) => new Promise((resolve) => {
      const req = http.get({
        host, port, path: '/', timeout: 5000,
        headers: { 'expo-platform': 'android', Accept: 'application/expo+json,application/json' },
      }, (res) => { res.resume(); resolve(host); });
      req.on('error', () => resolve(null)); // ECONNREFUSED on this family
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    return Promise.all(['127.0.0.1', '::1'].map(tryHost)).then((hosts) => hosts.find(Boolean) || null);
  }

  /** Fetch the manifest exactly as Expo Go (Android) would and log the verdict to the
   *  terminal — so we can see WHY Expo Go fails even when a browser loads the page.
   *  HTML back = the server only has a web/dev-build target (Expo Go can't run it);
   *  a JSON manifest = good, and we surface its bundle URL + SDK/runtime. Diagnostic
   *  only; never affects the running state. */
  _diagnoseExpoManifest(channel, port, host = '127.0.0.1') {
    const log = (data) => this.emit(event(EventType.CONTROL_OUTPUT, { channel, stream: 'stdout', data }));
    const req = http.get({
      host, port, path: '/', timeout: 6000,
      headers: { 'expo-platform': 'android', Accept: 'application/expo+json,application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString('utf8'); });
      res.on('end', () => {
        const ct = String(res.headers['content-type'] || '');
        if (/text\/html/i.test(ct)) {
          log(`\n[diag] ⚠ Dev server returned WEB HTML to an Expo Go (Android) manifest request ` +
              `(HTTP ${res.statusCode}). Expo Go can't run this — it needs a native manifest. ` +
              `Likely the app is web-only or requires a development build, OR the Expo SDK doesn't ` +
              `match your installed Expo Go.\n`);
          return;
        }
        let m; try { m = JSON.parse(body); } catch { /* not json */ }
        if (m) {
          const bundle = m?.launchAsset?.url || m?.bundleUrl || null;
          const sdk = m?.extra?.expoClient?.sdkVersion || m?.sdkVersion || m?.runtimeVersion || '(unknown)';
          log(`\n[diag] ✓ Native manifest served (HTTP ${res.statusCode}). SDK/runtime ${sdk}; ` +
              `bundle ${bundle || '(unknown)'}. Now build-testing the native bundle (what Expo Go fetches next)…\n`);
          // The real test: does the NATIVE JS bundle actually BUILD in this guest?
          // A browser only exercises the web bundle; Expo Go fetches this one, and a
          // build failure here (missing native lib / arch-mismatched tool in proot)
          // is exactly the "Something went wrong" Expo Go shows.
          if (bundle) this._probeBundle(channel, bundle, host, port);
        } else {
          log(`\n[diag] ? Manifest request returned HTTP ${res.statusCode}, content-type "${ct}", ` +
              `not parseable as a manifest. First bytes: ${body.slice(0, 120).replace(/\s+/g, ' ')}\n`);
        }
      });
    });
    req.on('error', (e) => log(`\n[diag] manifest probe failed: ${e.message}\n`));
    req.on('timeout', () => { req.destroy(); });
  }

  /** Build-test the NATIVE JS bundle (the URL from the manifest) the way Expo Go
   *  would, and report the result. HTTP 200 = it builds (Expo Go should load it); a
   *  non-200 means Metro failed to bundle — we surface the error body, which is the
   *  actual reason Expo Go shows "Something went wrong" even though the web/manifest
   *  worked. We reach the bundle on the host that answered the probe (the manifest's
   *  own host may be a family this guest can't reach). */
  _probeBundle(channel, bundleUrl, host, port) {
    const log = (data) => this.emit(event(EventType.CONTROL_OUTPUT, { channel, stream: 'stdout', data }));
    let target;
    try { target = new URL(bundleUrl); target.hostname = host; target.port = String(port); }
    catch { log(`\n[diag] couldn't parse bundle URL: ${bundleUrl}\n`); return; }
    const req = http.get(target, { timeout: 180000 }, (res) => {
      if (res.statusCode === 200) {
        log(`\n[diag] ✓ Native bundle BUILDS (HTTP 200). Expo Go should load it — if it still ` +
            `errors, screenshot the Expo Go error.\n`);
        res.destroy(); // don't pull the whole multi-MB bundle; we only needed the status
        return;
      }
      let body = '';
      res.on('data', (d) => { if (body.length < 4000) body += d.toString('utf8'); });
      res.on('end', () => {
        log(`\n[diag] ⚠ Native bundle FAILED to build (HTTP ${res.statusCode}). THIS is why Expo Go ` +
            `fails. Metro's error:\n${body.slice(0, 1500)}\n`);
      });
    });
    req.on('error', (e) => log(`\n[diag] bundle build request errored: ${e.message}\n`));
    req.on('timeout', () => { req.destroy(); log(`\n[diag] native bundle build timed out (>180s) — it may be too slow in the guest.\n`); });
  }

  /** Find the directory the Expo app actually lives in: the project root if it's an
   *  Expo project, else its first immediate subdirectory that is. null if none. */
  _resolveExpoDir(dir) {
    const isExpo = (d) => {
      try {
        if (fs.existsSync(path.join(d, 'app.json')) ||
            fs.existsSync(path.join(d, 'app.config.js')) ||
            fs.existsSync(path.join(d, 'app.config.ts'))) return true;
        const pkgPath = path.join(d, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          if (deps.expo || deps['expo-router'] || pkg.expo) return true;
        }
      } catch { /* ignore */ }
      return false;
    };
    if (!dir) return null;
    if (isExpo(dir)) return dir;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const SKIP = new Set(['node_modules', '.git', '.expo', 'ios', 'android', '.gradle', 'dist', 'build']);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      if (isExpo(sub)) return sub;
    }
    return null;
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
    const alive = this.runner.isRunning(this.metroChannel(project.id));
    const info = this._metro.get(project.id) || {
      port: project.metroPort,
      url: `exp://localhost:${project.metroPort}`,
    };
    // running only once it has answered (ready); alive-but-not-ready = starting. This
    // keeps a tab switch from reporting a still-booting Metro as openable.
    const ready = info.ready === true;
    return { running: alive && ready, starting: alive && !ready, projectId: project.id, port: info.port, url: info.url };
  }

  _emitMetro(projectId, running, port, url, error = null, starting = false) {
    this.emit(event(EventType.METRO_STATUS, { running, port, url, projectId, error, starting }));
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

  run(command, { cwd, projectId } = {}) {
    // A 'run' command while one is already live = stdin to that process (so the
    // terminal can drive interactive CLIs like `claude` login). Otherwise start a
    // TRACKED process so it persists for stdin / can be stopped.
    if (this.runner.isRunning('run')) {
      this.runner.sendInput('run', command.endsWith('\n') ? command : command + '\n');
      return { sentInput: true };
    }
    const project = this._resolveProject(projectId);
    const dir = cwd || project?.dir || this.config.projectsDir;
    return this.runner.start('run', this._maybePty(command), { cwd: dir });
  }

  /** Interactive CLIs (notably `claude` / `claude setup-token` for login) need a
   *  TTY: over a plain pipe they block-buffer stdout (the login URL never prints)
   *  and refuse interactive prompts. Allocate a real PTY with util-linux `script`
   *  for `claude` commands so on-device login works; other commands run as-is. */
  _maybePty(command) {
    const cmd = command.trim();
    if (!/^claude(\s|$)/.test(cmd)) return command;
    const esc = `'${cmd.replace(/'/g, `'\\''`)}'`;
    // `script -qec <cmd> /dev/null`: quiet, exit-code of child, run <cmd>, no typescript
    // file. Fall back to the raw command if `script` isn't installed.
    return `if command -v script >/dev/null 2>&1; then script -qec ${esc} /dev/null; else ${cmd}; fi`;
  }

  /** Raw keystrokes/lines to the running `run` command's stdin (no echo, no newline
   *  added — the client controls framing). */
  runInput(data) {
    return { ok: this.runner.sendInput('run', String(data ?? '')) };
  }

  runStop() {
    return { ok: this.runner.stop('run') };
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
