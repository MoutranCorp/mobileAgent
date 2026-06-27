import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Files } from '../src/controls/files.js';
import { ClaudeConfig } from '../src/controls/claude-config.js';
import { loadConfig } from '../src/config.js';

async function tmpDir(p) { return fsp.mkdtemp(path.join(os.tmpdir(), p)); }

test('Files._safe rejects symlink escape out of the project', async () => {
  const proj = await tmpDir('sec-proj-');
  const outside = await tmpDir('sec-out-');
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'TOPSECRET');
  // A symlink inside the project pointing outside it.
  try { fs.symlinkSync(outside, path.join(proj, 'evil')); } catch { return; /* no symlink support */ }
  const files = new Files({ getProjectDir: () => proj });
  const r = files.read('evil/secret.txt');
  assert.ok(r.error, 'symlinked read is rejected');
  assert.ok(!String(r.content || '').includes('TOPSECRET'), 'secret not leaked');
  // A normal file still reads fine.
  await fsp.writeFile(path.join(proj, 'ok.txt'), 'hello');
  assert.match(files.read('ok.txt').content, /hello/);
});

test('ClaudeConfig.deleteSession refuses path traversal', () => {
  const cc = new ClaudeConfig({ getProjectDir: () => os.tmpdir(), getProjects: () => [], stateDir: os.tmpdir() });
  assert.ok(cc.deleteSession('../../../../etc/passwd').error, 'traversal in id rejected');
  assert.ok(cc.deleteSession('ok-id', { projectDir: '../../../etc' }).error, 'traversal in projectDir rejected');
  assert.ok(cc.deleteSession('bad/../id').error, 'separator in id rejected');
});

test('loadConfig rejects an out-of-range port but accepts 0 (OS-assigned)', () => {
  assert.throws(() => loadConfig(['--port', '70000']), /Invalid --port/);
  assert.throws(() => loadConfig(['--port', 'foo']), /Invalid --port/);
  assert.throws(() => loadConfig(['--port', '-1']), /Invalid --port/);
  assert.equal(loadConfig(['--port', '0']).port, 0, 'port 0 is allowed (ephemeral)');
  assert.equal(loadConfig(['--port', '8765']).port, 8765);
});
