import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMemInfo, parseStatusRss, readMemInfo, brokerRssMb, cpuLoad,
  sampleResources, evictionCandidates,
} from '../src/controls/resources.js';

const MEMINFO = [
  'MemTotal:        8048576 kB',
  'MemFree:          512000 kB',
  'MemAvailable:    4096000 kB',
  'Buffers:          100000 kB',
].join('\n');

test('parseMemInfo uses MemAvailable (not MemFree) for the device numbers', () => {
  const m = parseMemInfo(MEMINFO);
  assert.equal(m.totalMb, Math.round(8048576 / 1024)); // 7860
  assert.equal(m.availMb, Math.round(4096000 / 1024)); // 4000
  assert.equal(m.usedMb, m.totalMb - m.availMb);
  assert.ok(m.usedPct > 40 && m.usedPct < 60, `usedPct ~49, got ${m.usedPct}`);
});

test('parseMemInfo returns null on missing fields', () => {
  assert.equal(parseMemInfo('MemTotal: 100 kB'), null);
  assert.equal(parseMemInfo('garbage'), null);
});

test('parseStatusRss reads VmRSS in MB', () => {
  const status = 'Name:\tclaude\nVmPeak:\t  900000 kB\nVmRSS:\t  204800 kB\nThreads:\t10\n';
  assert.equal(parseStatusRss(status), Math.round(204800 / 1024)); // 200
  assert.equal(parseStatusRss('no rss here'), null);
});

test('readMemInfo + brokerRssMb + cpuLoad return sane shapes on any platform', () => {
  const m = readMemInfo();
  assert.ok(m.totalMb > 0 && m.availMb >= 0 && m.usedPct >= 0 && m.usedPct <= 100);
  assert.ok(['proc', 'os'].includes(m.source));
  assert.ok(brokerRssMb() > 0);
  const c = cpuLoad();
  assert.ok(c.cores >= 1 && typeof c.load1 === 'number');
});

test('sampleResources summarizes the live engines', () => {
  const s = sampleResources([
    { key: 's1', projectId: 'p1', sessionId: 'abc', pid: 999999, status: 'working', idleMs: 0, title: 'Counter' },
    { key: 's2', projectId: 'p1', sessionId: 'def', pid: 999998, status: 'idle', idleMs: 120000, pinned: true },
  ]);
  assert.equal(s.engines.length, 2);
  assert.equal(s.engines[0].key, 's1');
  assert.equal(s.engines[1].pinned, true);
  assert.ok(s.broker.rssMb > 0);
  assert.equal(typeof s.agentsRssMb, 'number'); // rssMb null off-proc -> 0 sum
  assert.equal(typeof s.hasProc, 'boolean');
});

test('evictionCandidates: only idle, unpinned, non-active; LRU first; gated on pressure', () => {
  const engines = [
    { key: 'work', status: 'working', idleMs: 0 },
    { key: 'focused', status: 'idle', idleMs: 300000, active: true },
    { key: 'pinned', status: 'idle', idleMs: 300000, pinned: true },
    { key: 'old', status: 'idle', idleMs: 600000 },
    { key: 'recent', status: 'idle', idleMs: 60000 },
  ];
  // Not under pressure -> nothing evicted.
  assert.deepEqual(evictionCandidates({ mem: { usedPct: 50 }, engines }), []);
  // Under pressure -> only idle/unpinned/non-active, most-idle first.
  const evict = evictionCandidates({ mem: { usedPct: 95 }, engines }, { maxEvict: 5 });
  assert.deepEqual(evict, ['old', 'recent']);
});

test('evictionCandidates: recency grace keeps a just-used session warm below the critical threshold', () => {
  const engines = [
    { key: 'old', status: 'idle', idleMs: 600000 },   // 10 min idle
    { key: 'recent', status: 'idle', idleMs: 30000 },  // unfocused 30s ago — within the 90s grace
  ];
  // Between low (88) and critical (95): keep the recent one, evict only the stale one.
  assert.deepEqual(
    evictionCandidates({ mem: { usedPct: 90 }, engines }, { maxEvict: 5 }), ['old'],
    'a session used 30s ago is protected by the recency grace under moderate pressure');
  // At/above critical (95): OOM risk overrides recency — evict both.
  assert.deepEqual(
    evictionCandidates({ mem: { usedPct: 95 }, engines }, { maxEvict: 5 }), ['old', 'recent'],
    'critical pressure ignores the grace');
  // Past the grace window (2 min idle) it is evictable even below critical.
  assert.deepEqual(
    evictionCandidates({ mem: { usedPct: 90 }, engines: [{ key: 'a', status: 'idle', idleMs: 120000 }] }), ['a']);
  // A working session (e.g. inTurn) is never a candidate, even at critical pressure.
  assert.deepEqual(
    evictionCandidates({ mem: { usedPct: 99 }, engines: [{ key: 'w', status: 'working', idleMs: 0 }] }), []);
});
