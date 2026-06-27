import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CronManager, parseCron, parseField, nextRun, presetToCron, isValidCron } from '../src/controls/cron.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('parseField handles *, steps, ranges, lists', () => {
  assert.deepEqual(parseField('*', 0, 3), [0, 1, 2, 3]);
  assert.deepEqual(parseField('*/15', 0, 59), [0, 15, 30, 45]);
  assert.deepEqual(parseField('1-3', 0, 9), [1, 2, 3]);
  assert.deepEqual(parseField('0,30', 0, 59), [0, 30]);
  assert.deepEqual(parseField('10-20/5', 0, 59), [10, 15, 20]);
  assert.throws(() => parseField('99', 0, 59), /unparseable|empty/);
});

test('parseCron rejects wrong field counts', () => {
  assert.throws(() => parseCron('* * * *'));
  assert.ok(parseCron('*/5 * * * *'));
  assert.equal(isValidCron('0 9 * * 1'), true);
  assert.equal(isValidCron('not a cron'), false);
});

test('nextRun computes the next minute-aligned fire (local time)', () => {
  // From 09:00:30, "every 15 min" → 09:15:00.
  const after = new Date(2026, 0, 1, 9, 0, 30);
  const n = new Date(nextRun('*/15 * * * *', after));
  assert.equal(n.getMinutes(), 15);
  assert.equal(n.getHours(), 9);
  assert.equal(n.getSeconds(), 0);
});

test('nextRun for a daily time rolls to the next day when already past', () => {
  const after = new Date(2026, 0, 1, 10, 0, 0); // 10:00
  const n = new Date(nextRun('30 9 * * *', after)); // 09:30 daily → tomorrow 09:30
  assert.equal(n.getHours(), 9);
  assert.equal(n.getMinutes(), 30);
  assert.equal(n.getDate(), 2);
});

test('nextRun honors day-of-week', () => {
  // 2026-01-01 is a Thursday (getDay 4). Next Monday (1) at 08:00.
  const after = new Date(2026, 0, 1, 12, 0, 0);
  const n = new Date(nextRun('0 8 * * 1', after));
  assert.equal(n.getDay(), 1);
  assert.equal(n.getHours(), 8);
});

test('presetToCron builds expected expressions', () => {
  assert.equal(presetToCron({ every: 'minutes', n: 30 }).cron, '*/30 * * * *');
  assert.equal(presetToCron({ every: 'hours', n: 2, minute: 5 }).cron, '5 */2 * * *');
  assert.equal(presetToCron({ every: 'days', n: 1, hour: 9, minute: 0 }).cron, '0 9 * * *');
  assert.equal(presetToCron({ every: 'weeks', weekday: 1, hour: 8, minute: 30 }).cron, '30 8 * * 1');
});

test('CronManager create/update/remove + persistence round-trip', async () => {
  const dir = await tmpDir('cron-');
  const cm = new CronManager(dir);
  const job = cm.create({ name: 'Nightly', prompt: 'summarize the repo', projectId: 'projA',
    schedule: { source: 'preset', preset: { every: 'days', n: 1, hour: 3, minute: 0 } }, sessionMode: 'persistent' });
  assert.ok(job.id);
  assert.equal(job.schedule.cron, '0 3 * * *');
  assert.equal(job.sessionMode, 'persistent');
  assert.ok(existsSync(path.join(dir, 'cron-jobs.json')), 'persisted to disk');

  cm.update(job.id, { name: 'Renamed', enabled: false });
  cm.toggle(job.id, true);

  const reopened = new CronManager(dir);
  const got = reopened.get(job.id);
  assert.equal(got.name, 'Renamed');
  assert.equal(got.enabled, true);
  assert.equal(got.prompt, 'summarize the repo');

  assert.equal(reopened.remove(job.id), true);
  assert.equal(reopened.get(job.id), null);
});

test('CronManager.create rejects an empty prompt and an invalid raw cron', async () => {
  const dir = await tmpDir('cron-');
  const cm = new CronManager(dir);
  assert.throws(() => cm.create({ prompt: '', schedule: { cron: '* * * * *' } }), /prompt/);
  assert.throws(() => cm.create({ prompt: 'hi', schedule: { source: 'cron', cron: 'nope' } }), /invalid cron/);
});

test('due() returns jobs whose fire time has passed; noteRun advances them', async () => {
  const dir = await tmpDir('cron-');
  const cm = new CronManager(dir);
  const job = cm.create({ prompt: 'tick', schedule: { cron: '*/5 * * * *' } });
  // Force its createdAt into the past so a 5-min schedule is already due.
  job.createdAt = Date.now() - 10 * 60 * 1000;
  assert.equal(cm.due(Date.now()).length, 1, 'overdue job is due');

  cm.noteRun(job.id, { status: 'running', sessionKey: 'projA#1', sessionId: 'sess-1' });
  assert.equal(cm.due(Date.now()).length, 0, 'after firing, not immediately due again');
  assert.equal(cm.get(job.id).lastStatus, 'running');
  assert.equal(cm.get(job.id).lastSessionId, 'sess-1');

  // Disabled jobs are never due.
  cm.toggle(job.id, false);
  job.lastRun = Date.now() - 10 * 60 * 1000;
  assert.equal(cm.due(Date.now()).length, 0, 'disabled job never fires');
});
