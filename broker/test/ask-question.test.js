import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PermissionBridge } from '../src/mcp/permission-bridge.js';

// Connect a raw socket (as permission-server.js would) and exchange one
// newline-delimited JSON request/response.
function rpc(port, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) { sock.end(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('rpc timeout')), 4000);
  });
}

test('bridge routes kind:question to onQuestion and returns the answer text', async () => {
  let seen = null;
  const bridge = new PermissionBridge({
    token: 'sek',
    onQuestion: async ({ questions }) => { seen = questions; return { text: 'The user chose A.' }; },
  });
  const port = await bridge.start();
  try {
    const res = await rpc(port, { id: 'q1', kind: 'question', token: 'sek', questions: [{ question: 'Pick', options: [{ label: 'A' }] }] });
    assert.equal(res.id, 'q1');
    assert.equal(res.text, 'The user chose A.');
    assert.equal(res.cancelled, false);
    assert.equal(seen.length, 1, 'onQuestion received the questions');
  } finally { await bridge.stop(); }
});

test('bridge rejects a question with a bad token (cancelled, onQuestion not called)', async () => {
  let called = false;
  const bridge = new PermissionBridge({ token: 'right', onQuestion: async () => { called = true; return { text: 'x' }; } });
  const port = await bridge.start();
  try {
    const res = await rpc(port, { id: 'q2', kind: 'question', token: 'wrong', questions: [] });
    assert.equal(res.cancelled, true, 'unauthorized → cancelled');
    assert.equal(called, false, 'handler never runs for a bad token');
  } finally { await bridge.stop(); }
});

test('bridge still handles kind:permission alongside questions', async () => {
  const bridge = new PermissionBridge({
    token: 't',
    onRequest: async ({ toolName }) => ({ decision: toolName === 'Bash' ? 'deny' : 'allow' }),
    onQuestion: async () => ({ text: 'ok' }),
  });
  const port = await bridge.start();
  try {
    const deny = await rpc(port, { id: 'p1', kind: 'permission', token: 't', tool_name: 'Bash', input: {} });
    assert.equal(deny.decision, 'deny');
    const q = await rpc(port, { id: 'q3', kind: 'question', token: 't', questions: [] });
    assert.equal(q.text, 'ok');
  } finally { await bridge.stop(); }
});
