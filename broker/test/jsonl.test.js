import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonLineBuffer } from '../src/jsonl.js';

test('parses complete single line', () => {
  const b = new JsonLineBuffer();
  const out = b.push('{"a":1}\n');
  assert.deepEqual(out, [{ a: 1 }]);
  assert.equal(b.pending, 0);
});

test('assembles a JSON object split across two chunks', () => {
  const b = new JsonLineBuffer();
  assert.deepEqual(b.push('{"type":"sys'), []); // partial, nothing yet
  assert.equal(b.pending > 0, true);
  const out = b.push('tem","ok":true}\n');
  assert.deepEqual(out, [{ type: 'system', ok: true }]);
});

test('handles multiple objects plus a partial trailing one in one chunk', () => {
  const b = new JsonLineBuffer();
  const out = b.push('{"n":1}\n{"n":2}\n{"n":3');
  assert.deepEqual(out, [{ n: 1 }, { n: 2 }]);
  const rest = b.push('}\n');
  assert.deepEqual(rest, [{ n: 3 }]);
});

test('ignores blank lines', () => {
  const b = new JsonLineBuffer();
  const out = b.push('\n\n{"x":1}\n\n');
  assert.deepEqual(out, [{ x: 1 }]);
});

test('reports malformed complete lines via onError, keeps going', () => {
  const b = new JsonLineBuffer();
  const errors = [];
  const out = b.push('not json\n{"ok":1}\n', (e, raw) => errors.push(raw));
  assert.deepEqual(out, [{ ok: 1 }]);
  assert.deepEqual(errors, ['not json']);
});

test('accepts Buffer chunks', () => {
  const b = new JsonLineBuffer();
  const out = b.push(Buffer.from('{"buf":true}\n', 'utf8'));
  assert.deepEqual(out, [{ buf: true }]);
});
