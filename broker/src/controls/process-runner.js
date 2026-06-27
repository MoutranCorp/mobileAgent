import { spawn } from 'node:child_process';
import { EventType, event } from '../protocol.js';

/**
 * Run external dev tools (git, expo/metro, eas, arbitrary commands) and stream
 * their output to the UI as canonical control_output events, keyed by a logical
 * `channel` (e.g. 'git', 'metro:app1', 'run', 'eas'). Long-running processes
 * (Metro) are tracked so they can be stopped and survive turn boundaries.
 */
export class ProcessRunner {
  constructor({ emit, log } = {}) {
    this.emit = emit || (() => {});
    this.log = log || (() => {});
    this.running = new Map(); // channel -> child
  }

  isRunning(channel) {
    return this.running.has(channel);
  }

  /**
   * Spawn a command, streaming output on `channel`. Resolves with
   * { code, stdout, stderr } when it exits. Use `track:true` for long-running
   * processes you intend to stop later.
   */
  run(channel, command, { cwd, env, track = false, shell = true } = {}) {
    return this._spawnStream(channel, command, null, command, { cwd, env, track, shell });
  }

  /**
   * Like run(), but spawns `file` with an explicit `args` array and NO shell, so
   * user-supplied values (commit messages, paths, URLs, PR titles) can never be
   * interpreted as shell syntax (`$()`, backticks, `;`, `&&`). Prefer this for any
   * command that includes caller/agent-controlled strings.
   */
  runArgs(channel, file, args = [], { cwd, env, track = false } = {}) {
    const display = [file, ...args].join(' ');
    return this._spawnStream(channel, file, args, display, { cwd, env, track, shell: false });
  }

  _spawnStream(channel, fileOrCommand, args, display, { cwd, env, track = false, shell = true } = {}) {
    this.emit(event(EventType.CONTROL_STATUS, { channel, state: 'running', detail: display }));
    this.log(`[${channel}] $ ${display}`);

    const child = args
      ? spawn(fileOrCommand, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true })
      : spawn(fileOrCommand, { cwd, env: { ...process.env, ...env }, shell, windowsHide: true });

    if (track) this.running.set(channel, child);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => {
      const data = d.toString('utf8');
      stdout += data;
      this.emit(event(EventType.CONTROL_OUTPUT, { channel, stream: 'stdout', data }));
    });
    child.stderr?.on('data', (d) => {
      const data = d.toString('utf8');
      stderr += data;
      this.emit(event(EventType.CONTROL_OUTPUT, { channel, stream: 'stderr', data }));
    });

    return new Promise((resolve) => {
      child.on('error', (err) => {
        this.emit(
          event(EventType.CONTROL_OUTPUT, {
            channel,
            stream: 'stderr',
            data: `spawn error: ${err.message}\n`,
          })
        );
        this.emit(event(EventType.CONTROL_STATUS, { channel, state: 'error', detail: err.message }));
        if (track) this.running.delete(channel);
        resolve({ code: -1, stdout, stderr, error: err });
      });
      child.on('exit', (code, signal) => {
        if (track) this.running.delete(channel);
        this.emit(
          event(EventType.CONTROL_STATUS, {
            channel,
            state: code === 0 ? 'done' : 'exited',
            detail: `code=${code ?? signal}`,
          })
        );
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  /** Start a tracked, long-running process and return immediately. */
  start(channel, command, opts = {}) {
    if (this.running.has(channel)) {
      return { alreadyRunning: true, child: this.running.get(channel) };
    }
    // Fire-and-forget; output streams via events. We keep the promise so the
    // exit handler still runs, but callers don't await it.
    const promise = this.run(channel, command, { ...opts, track: true });
    return { alreadyRunning: false, promise, child: this.running.get(channel) };
  }

  stop(channel) {
    const child = this.running.get(channel);
    if (!child) return false;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    // Hard-kill fallback.
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 3000);
    // Remove from `running` only when the process actually exits — deleting eagerly
    // made isRunning() return false while the child was still alive, so a quick
    // restart could spawn a second instance (e.g. two Metros) on the same channel.
    child.once('exit', () => { clearTimeout(t); this.running.delete(channel); });
    this.emit(event(EventType.CONTROL_STATUS, { channel, state: 'stopped' }));
    return true;
  }

  stopAll() {
    for (const channel of Array.from(this.running.keys())) this.stop(channel);
  }
}
