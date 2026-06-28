import fs from 'node:fs';
import os from 'node:os';

/**
 * Resource metrics — what the multi-session lifecycle's memory backstop reads,
 * and what the System tab (Phase 2) displays.
 *
 * On the phone the broker runs in proot, so real Linux /proc is available:
 *   - device RAM   -> /proc/meminfo  (MemTotal / MemAvailable — "available", not
 *                     "free", because Android hoards RAM for cache and "free"
 *                     wildly understates what's actually usable)
 *   - per-engine   -> /proc/<pid>/status  (VmRSS = that agent's real footprint)
 * On the Windows/macOS dev box there is no /proc, so we fall back to the
 * cross-platform `os.*` numbers (coarser, but the broker still runs + tests pass).
 */

export const HAS_PROC =
  process.platform === 'linux' && (() => { try { return fs.existsSync('/proc/meminfo'); } catch { return false; } })();

function _kv(txt, key) {
  const m = String(txt).match(new RegExp('^' + key + ':\\s+(\\d+)', 'm'));
  return m ? Number(m[1]) : null; // value is in kB
}

/** Parse /proc/meminfo text -> device memory in MB. Pure (exported for tests). */
export function parseMemInfo(txt) {
  const totalKb = _kv(txt, 'MemTotal');
  const availKb = _kv(txt, 'MemAvailable');
  if (totalKb == null || availKb == null) return null;
  const totalMb = Math.round(totalKb / 1024);
  const availMb = Math.round(availKb / 1024);
  const usedMb = Math.max(0, totalMb - availMb);
  return { totalMb, availMb, usedMb, usedPct: totalMb ? Math.round((usedMb / totalMb) * 100) : 0 };
}

/** Parse a /proc/<pid>/status text -> RSS in MB. Pure (exported for tests). */
export function parseStatusRss(txt) {
  const m = String(txt).match(/^VmRSS:\s+(\d+)\s*kB/m);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

/** Device RAM (MB). Uses /proc/meminfo when present, else os.* fallback. */
export function readMemInfo() {
  if (HAS_PROC) {
    try {
      const parsed = parseMemInfo(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (parsed) return { ...parsed, source: 'proc' };
    } catch { /* fall through to os.* */ }
  }
  const totalMb = Math.round(os.totalmem() / 1048576);
  const availMb = Math.round(os.freemem() / 1048576); // ~free, understates real avail; fine for dev
  const usedMb = Math.max(0, totalMb - availMb);
  return { totalMb, availMb, usedMb, usedPct: totalMb ? Math.round((usedMb / totalMb) * 100) : 0, source: 'os' };
}

/** A child engine's resident memory (MB), or null when unknowable (no /proc). */
export function readRssMb(pid) {
  if (!pid || !HAS_PROC) return null;
  try { return parseStatusRss(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return null; }
}

export function brokerRssMb() { return Math.round(process.memoryUsage().rss / 1048576); }

export function cpuLoad() {
  const la = os.loadavg(); // [1m,5m,15m] — all 0 on Windows
  return { load1: Math.round((la[0] || 0) * 100) / 100, cores: (os.cpus() || []).length || 1 };
}

/**
 * Build one resource sample. `engines` is the live-session list from the
 * SessionManager: [{ key, projectId, sessionId, pid, status, idleMs, pinned, title }].
 */
export function sampleResources(engines = []) {
  const list = (engines || []).map((e) => ({
    key: e.key,
    projectId: e.projectId ?? null,
    sessionId: e.sessionId ?? null,
    title: e.title ?? null,
    pid: e.pid ?? null,
    rssMb: readRssMb(e.pid),
    status: e.status || 'idle',
    idleMs: e.idleMs || 0,
    pinned: !!e.pinned,
    active: !!e.active, // never evict the focused session
  }));
  const agentsRssMb = list.reduce((sum, e) => sum + (e.rssMb || 0), 0);
  return {
    mem: readMemInfo(),
    broker: { rssMb: brokerRssMb() },
    agentsRssMb,
    engines: list,
    cpu: cpuLoad(),
    hasProc: HAS_PROC,
  };
}

/**
 * Decide which idle engines to evict under memory pressure. Pure: caller supplies
 * the sample + candidates and applies the result. Never returns a working/focused/
 * pinned engine — only idle background ones, least-recently-used first.
 *
 * @returns {string[]} session keys to evict (possibly empty)
 */
export function evictionCandidates(sample, { lowMemPct = 88, criticalPct = 95, graceMs = 90000, maxEvict = 3 } = {}) {
  if (!sample?.mem || sample.mem.usedPct < lowMemPct) return [];
  const critical = sample.mem.usedPct >= criticalPct;
  const idle = (sample.engines || [])
    .filter((e) => e.status === 'idle' && !e.pinned && !e.active)
    // Recency grace: between the low and critical thresholds, KEEP a just-unfocused
    // session warm for `graceMs` so flipping between your few tabs doesn't sleep the
    // one you just left (the "instant 💤 on switch" bug). At/above the critical
    // threshold OOM risk outranks UX, so evict regardless of how recent it was.
    .filter((e) => critical || (e.idleMs || 0) >= graceMs)
    .sort((a, b) => (b.idleMs || 0) - (a.idleMs || 0)); // most-idle first
  return idle.slice(0, maxEvict).map((e) => e.key);
}
