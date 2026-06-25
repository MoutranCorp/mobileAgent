#!/usr/bin/env node
/**
 * Tiny canonical-protocol client — connects to a running broker, sends a prompt,
 * auto-approves tool calls, and pretty-prints the event stream. Handy for seeing
 * exactly what the UI consumes.
 *
 *   node src/index.js --engine mock           # in one terminal
 *   node scripts/demo-client.mjs "build a counter screen"   # in another
 */
import { WebSocket } from 'ws';

const url = process.env.BROKER_URL || 'ws://127.0.0.1:8765';
const prompt = process.argv.slice(2).join(' ') || 'build a counter screen';

const ws = new WebSocket(url);
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(5);

ws.on('open', () => {
  console.log(`connected to ${url}\n→ "${prompt}"\n`);
  ws.send(JSON.stringify({ type: 'hello' }));
  ws.send(JSON.stringify({ type: 'user_message', text: prompt }));
});

let buf = '';
const ind = (p) => (p ? '    ' : ''); // indent nested subagent activity
ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  switch (ev.type) {
    case 'capabilities':
      console.log(`${ms()}  ⚙ caps: ${(ev.slashCommands || []).length} commands · ${(ev.agents || []).length} agents · ${(ev.mcpServers || []).length} mcp · mode=${ev.permissionMode}`);
      break;
    case 'permission_mode':
      console.log(`${ms()}  🔒 permission mode: ${ev.mode}`);
      break;
    case 'context':
      console.log(`${ms()}  🧮 context ${(ev.usedTokens / 1000).toFixed(1)}k/${(ev.windowTokens / 1000).toFixed(0)}k`);
      break;
    case 'assistant_text':
      if (ev.parentToolUseId) console.log(`${ms()}  ${ind(1)}💬 ${ev.delta.trim()}`);
      else buf += ev.delta;
      break;
    case 'tool_call':
      flush();
      console.log(`${ms()}  ${ind(ev.parentToolUseId)}🔧 ${ev.name}  ${target(ev.input)}`);
      break;
    case 'tool_result':
      console.log(`${ms()}  ${ind(ev.parentToolUseId)}✓  ${ev.name || 'tool'} → ${String(ev.output).split('\n')[0].slice(0, 60)}`);
      break;
    case 'permission_request':
      console.log(`${ms()}  ⚠  approve: ${ev.detail}`);
      ws.send(JSON.stringify({ type: 'approve', id: ev.id }));
      break;
    case 'permission_denied':
      console.log(`${ms()}  ⛔ ${ev.toolName} denied: ${ev.reason}`);
      break;
    case 'compact':
      console.log(`${ms()}  ↡ context compacted (${ev.trigger})`);
      break;
    case 'usage':
      console.log(`${ms()}  📊 ${ev.inTok} in / ${ev.outTok} out${ev.cost == null ? ' (flat)' : ''}`);
      break;
    case 'result':
      flush();
      console.log(`\n${ms()}  ● done (${ev.subtype})`);
      ws.close();
      process.exit(0);
      break;
    case 'error':
      console.log(`${ms()}  ✗ ERROR: ${ev.message}`);
      break;
  }
});

function flush() {
  if (buf.trim()) console.log(`${ms()}  💬 ${buf.trim()}`);
  buf = '';
}
function target(input) {
  return (input && (input.file_path || input.command || input.path || '')) || '';
}

ws.on('error', (e) => {
  console.error('connection failed:', e.message, '\nIs the broker running? `npm run dev`');
  process.exit(1);
});
setTimeout(() => { console.error('timeout'); process.exit(1); }, 30000);
