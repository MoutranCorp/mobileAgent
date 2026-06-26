import fs from 'node:fs/promises';
import path from 'node:path';
import { EngineAdapter } from './base.js';
import { EventType, StatusState, CommandType } from '../protocol.js';

/**
 * Mock engine — a fully self-contained fake harness.
 *
 * Why this exists: the real `claude-code` engine needs the claude CLI logged in
 * with a Max subscription, running inside proot on the phone. The mock engine
 * emits the exact same canonical events, so the ENTIRE rest of the stack — the
 * WebSocket protocol, the web UI, tool cards, diff rendering, approval flow, the
 * Test loop — can be built, run and demoed on any laptop with zero credentials.
 *
 * It also genuinely touches the filesystem (creates/edits files in the project
 * dir) so the "files change in ~/projects/<app>" acceptance criteria is real.
 */
export class MockEngine extends EngineAdapter {
  constructor(opts) {
    super(opts);
    this._pendingPermissions = new Map();
    this._interrupted = false;
    this._turn = 0;
    this._seq = 0;
  }

  async _spawn() {
    // Simulate the system/init handshake of a real harness.
    await delay(120);
    this.setSession(`mock-${this.profile?.id || 'session'}-${this._stableId()}`);
    // Mirror the claude-code capability surface so the UI's managers/palettes work offline.
    this.emitEvent(EventType.CAPABILITIES, {
      slashCommands: ['/compact', '/clear', '/init', '/review', '/help'],
      agents: [
        { name: 'Explore', description: 'Read-only search agent' },
        { name: 'Plan', description: 'Implementation planner' },
        { name: 'general-purpose', description: 'Full-capability agent' },
      ],
      mcpServers: [{ name: 'broker', status: 'connected' }],
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Skill', 'WebSearch'],
      outputStyle: 'default',
      permissionMode: this.permissionMode || 'default',
      model: this.model,
    });
    this.emitEvent(EventType.PERMISSION_MODE, { mode: this.permissionMode || 'default' });
    this.emitEvent(EventType.CONTEXT, { usedTokens: 3200, windowTokens: 200000, model: this.model });
    this.emitStatus(StatusState.IDLE);
  }

  _stableId() {
    // Deterministic-ish id without Date.now()/Math.random (kept reproducible).
    this._seq += 1;
    return `${this.profile?.id || 'x'}${this._seq}`;
  }

  async send(cmd) {
    switch (cmd.type) {
      case CommandType.USER_MESSAGE:
        await this._handleUserMessage(cmd.text || '', cmd.images);
        break;
      default:
        // Mock ignores other commands silently.
        break;
    }
  }

  interrupt() {
    this._interrupted = true;
    this.emitStatus(StatusState.IDLE, 'interrupted');
  }

  respondPermission(id, decision) {
    const pending = this._pendingPermissions.get(id);
    if (!pending) return;
    this._pendingPermissions.delete(id);
    this.emitEvent(EventType.PERMISSION_RESOLVED, { id, decision });
    pending.resolve(decision);
  }

  async _teardown() {
    for (const p of this._pendingPermissions.values()) p.resolve('deny');
    this._pendingPermissions.clear();
  }

  // --- the simulated turn -----------------------------------------------------

  async _handleUserMessage(text, images) {
    this._interrupted = false;
    this._turn += 1;
    this.emitEvent(EventType.USER_ECHO, { text });
    this.emitStatus(StatusState.THINKING);
    await delay(200);

    // A short reasoning trace so the UI's thinking panel + live indicator show.
    for (const chunk of ['Let me think about what they need. ', 'I should read the relevant context first, ', 'then make the change cleanly and verify it.']) {
      if (this._interrupted) return this._finish(true);
      this.emitEvent(EventType.ASSISTANT_THINKING, { delta: chunk });
      await delay(120);
    }

    if (images && images.length) {
      await this._streamText(`I can see the ${images.length === 1 ? 'image' : images.length + ' images'} you attached. `);
    }

    // A rich-markdown sample so the UI's markdown rendering can be exercised.
    if (/\b(markdown|format|render|explain)\b/i.test(text)) {
      await this._streamText(MARKDOWN_SAMPLE);
      return this._finish(false);
    }

    const wantsApk = /\b(apk|aab|gradle|sideload|android build|release build|assemble)\b/i.test(text);
    const wantsHtml = /\b(html|website|web ?app|micro ?app|landing|web ?page)\b/i.test(text);
    const wantsScreen = /\b(screen|component|button|build|make|create|add)\b/i.test(text);
    const wantsRun = /\b(run|test|start|install|npm|expo)\b/i.test(text);
    const wantsAgent = /\b(research|explore|investigate|agent|subagent|audit)\b/i.test(text);

    // 1) Stream some assistant reasoning text.
    await this._streamText(
      wantsHtml
        ? `I'll build a self-contained HTML microapp you can run right here.\n\n`
        : wantsScreen
          ? `I'll build that for you. Let me create a new screen component and wire it in.\n\n`
          : `Got it. Let me take a look and respond.\n\n`
    );

    if (this._interrupted) return this._finish(true);

    if (wantsAgent) {
      await this._simulateSubagent(text);
    } else if (wantsApk) {
      await this._simulateApkBuild(text);
    } else if (wantsHtml) {
      await this._simulateHtmlWrite(text);
    } else if (wantsScreen) {
      await this._simulateTodos();
      await this._simulateFileWrite(text);
    } else {
      // A read tool call to feel like a real agent inspecting the project.
      await this._simulateFileRead();
    }

    if (this._interrupted) return this._finish(true);

    if (wantsRun) {
      await this._simulateBash('echo "Metro can be started from the Test button"');
    }

    await this._streamText(
      wantsScreen
        ? `\nDone. The screen is written — tap **Test** to see it live-reload on the phone.`
        : `\nLet me know what you'd like to build.`
    );

    const inTok = 1200 + this._turn * 40;
    const outTok = 320 + this._turn * 25;
    this.emitEvent(EventType.USAGE, {
      inTok,
      outTok,
      cacheReadTok: 800,
      cost: null, // null = covered by flat subscription
    });
    this.emitEvent(EventType.CONTEXT, {
      usedTokens: 3200 + this._turn * 600,
      windowTokens: 200000,
      model: this.model,
    });

    this._finish(false);
  }

  /** Simulate the agent's TodoWrite tool so the UI's live checklist demos. */
  async _simulateTodos() {
    const id = `tool_${this._stableId()}`;
    const todos = [
      { content: 'Create the screen component', status: 'in_progress', activeForm: 'Creating the screen component' },
      { content: 'Wire it into navigation', status: 'pending', activeForm: 'Wiring navigation' },
      { content: 'Verify it renders', status: 'pending', activeForm: 'Verifying' },
    ];
    this.emitEvent(EventType.TOOL_CALL, { id, name: 'TodoWrite', kind: 'tool', input: { todos } });
    this.emitEvent(EventType.TOOL_RESULT, { id, name: 'TodoWrite', status: 'ok', output: 'Todos updated' });
    await delay(80);
  }

  /** Simulate a subagent (Agent/Task) with nested, indented activity. */
  async _simulateSubagent(text) {
    const taskId = `tool_${this._stableId()}`;
    this.emitEvent(EventType.TOOL_CALL, {
      id: taskId,
      name: 'Agent',
      kind: 'subagent',
      input: { subagent_type: 'Explore', description: text.slice(0, 60) },
    });
    this.emitStatus(StatusState.RUNNING, 'Agent: Explore');
    await delay(120);
    // Nested sub-events tagged with the parent so the UI indents them.
    this.emitEvent(EventType.ASSISTANT_TEXT, {
      delta: 'Searching the project for relevant files…',
      parentToolUseId: taskId,
    });
    const subRead = `tool_${this._stableId()}`;
    this.emitEvent(EventType.TOOL_CALL, {
      id: subRead,
      name: 'Grep',
      kind: 'tool',
      input: { pattern: 'export default' },
      parentToolUseId: taskId,
    });
    await delay(120);
    this.emitEvent(EventType.TOOL_RESULT, {
      id: subRead,
      name: 'Grep',
      status: 'ok',
      output: 'app/index.tsx:1\napp/Counter.tsx:4',
      parentToolUseId: taskId,
    });
    await delay(120);
    this.emitEvent(EventType.TOOL_RESULT, {
      id: taskId,
      name: 'Agent',
      status: 'ok',
      output: 'Found 2 screens. Summary: the app exports index and Counter screens.',
    });
  }

  _finish(interrupted) {
    this.emitEvent(EventType.RESULT, {
      subtype: interrupted ? 'interrupted' : 'success',
      isError: false,
    });
    this.emitStatus(StatusState.IDLE);
  }

  async _streamText(full) {
    // Token-ish streaming: split on words, keep punctuation attached.
    const parts = full.match(/\S+\s*|\s+/g) || [full];
    for (const p of parts) {
      if (this._interrupted) return;
      this.emitText(p);
      await delay(18);
    }
  }

  async _simulateFileRead() {
    const id = `tool_${this._stableId()}`;
    const target = 'app/(tabs)/index.tsx';
    this.emitEvent(EventType.TOOL_CALL, {
      id,
      name: 'Read',
      input: { file_path: target },
    });
    this.emitStatus(StatusState.RUNNING, `Reading ${target}`);
    await delay(180);
    let snippet = 'export default function HomeScreen() { /* ... */ }';
    try {
      const full = path.join(this.cwd, target);
      snippet = (await fs.readFile(full, 'utf8')).split('\n').slice(0, 20).join('\n');
    } catch {
      /* file may not exist in a fresh dir; snippet stays */
    }
    this.emitEvent(EventType.TOOL_RESULT, { id, status: 'ok', output: snippet });
  }

  async _simulateBash(command) {
    const id = `tool_${this._stableId()}`;
    this.emitEvent(EventType.TOOL_CALL, { id, name: 'Bash', input: { command } });
    this.emitStatus(StatusState.RUNNING, command);
    await delay(150);
    this.emitEvent(EventType.TOOL_RESULT, {
      id,
      status: 'ok',
      output: 'Metro can be started from the Test button',
    });
  }

  async _simulateFileWrite(userText) {
    const id = `tool_${this._stableId()}`;
    const screenName = deriveScreenName(userText);
    const rel = path.join('app', `${screenName}.tsx`);
    const abs = path.join(this.cwd, rel);

    let before = '';
    try {
      before = await fs.readFile(abs, 'utf8');
    } catch {
      before = '';
    }
    const after = renderScreen(screenName, userText);

    // Surface as a gated tool call requiring approval (real approval flow).
    this.emitEvent(EventType.TOOL_CALL, {
      id,
      name: before ? 'Edit' : 'Write',
      input: { file_path: rel, before, after },
    });
    const decision = await this._requestPermission(
      'write_file',
      `${before ? 'Edit' : 'Create'} ${rel}`,
      { toolName: before ? 'Edit' : 'Write', input: { file_path: rel } }
    );
    if (decision === 'deny') {
      this.emitEvent(EventType.TOOL_RESULT, { id, status: 'error', output: 'Denied by user' });
      return;
    }

    this.emitStatus(StatusState.RUNNING, `Writing ${rel}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, after, 'utf8');
    await delay(120);
    this.emitEvent(EventType.TOOL_RESULT, {
      id,
      status: 'ok',
      output: `Wrote ${after.split('\n').length} lines to ${rel}`,
    });
  }

  /** Write a self-contained interactive HTML microapp (for the inline-app widget). */
  async _simulateHtmlWrite(userText) {
    const id = `tool_${this._stableId()}`;
    const rel = 'microapp.html';
    const abs = path.join(this.cwd, rel);
    let before = '';
    try { before = await fs.readFile(abs, 'utf8'); } catch { before = ''; }
    const after = renderHtmlApp(userText);
    // Use the ABSOLUTE path in file_path (real claude-code does), so the inline
    // microapp widget exercises its project-relative URL mapping.
    this.emitEvent(EventType.TOOL_CALL, { id, name: before ? 'Edit' : 'Write', input: { file_path: abs, before, after } });
    const decision = await this._requestPermission(
      'write_file', `${before ? 'Edit' : 'Create'} ${rel}`, { toolName: before ? 'Edit' : 'Write', input: { file_path: abs } }
    );
    if (decision === 'deny') { this.emitEvent(EventType.TOOL_RESULT, { id, status: 'error', output: 'Denied by user' }); return; }
    this.emitStatus(StatusState.RUNNING, `Writing ${rel}`);
    await fs.writeFile(abs, after, 'utf8');
    await delay(120);
    this.emitEvent(EventType.TOOL_RESULT, { id, status: 'ok', output: `Wrote ${after.split('\n').length} lines to ${rel}` });
    await this._streamText(`\nDone — your **${rel}** microapp is ready. Run it in the widget above, or open it in a new window.`);
  }

  /** Simulate a release build that drops an .apk artifact (for the APK widget). */
  async _simulateApkBuild(userText) {
    const id = `tool_${this._stableId()}`;
    const rel = 'android/app/build/outputs/apk/release/app-release.apk';
    const abs = path.join(this.cwd, rel);
    this.emitEvent(EventType.TOOL_CALL, { id, name: 'Bash', input: { command: './gradlew assembleRelease' } });
    this.emitEvent(EventType.CONTROL_STATUS, { channel: 'build', state: 'running', detail: 'assembleRelease' });
    this.emitStatus(StatusState.RUNNING, 'Building release APK');
    await delay(220);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // A small fake binary so the scan + download + widget have a real artifact.
    const bytes = Buffer.concat([Buffer.from('PK\x03\x04mock-apk\n'), Buffer.alloc(2048, 7)]);
    await fs.writeFile(abs, bytes);
    await delay(80);
    this.emitEvent(EventType.TOOL_RESULT, { id, status: 'ok', output: `BUILD SUCCESSFUL in 12s\nAPK: ${rel} (${bytes.length} bytes)` });
    this.emitEvent(EventType.CONTROL_STATUS, { channel: 'build', state: 'done', detail: rel });
    await this._streamText(`\nBuild succeeded — **${rel.split('/').pop()}** is ready. Tap **Save to Downloads** in the widget above.`);
  }

  _requestPermission(action, detail, extra = {}) {
    const id = `perm_${this._stableId()}`;
    // Register the resolver BEFORE emitting: emit() is synchronous, so a
    // synchronous auto-approving listener could otherwise call
    // respondPermission(id) before the pending entry exists and hang forever.
    return new Promise((resolve) => {
      this._pendingPermissions.set(id, { resolve });
      this.emitEvent(EventType.PERMISSION_REQUEST, { id, action, detail, ...extra });
      this.emitStatus(StatusState.WAITING, detail);
    });
  }
}

function deriveScreenName(text) {
  const m = text.match(/\b(\w+)\s+screen\b/i);
  if (m) return capitalize(m[1]);
  const verb = text.match(/\b(?:build|make|create|add)\s+(?:a|an|the)?\s*(\w+)/i);
  if (verb) return capitalize(verb[1]);
  return 'Generated';
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderScreen(name, prompt) {
  const safePrompt = (prompt || '').replace(/`/g, "'").slice(0, 120);
  return `import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useState } from 'react';

// Generated by the on-device agent for: ${safePrompt}
export default function ${name}Screen() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>${name}</Text>
      <Pressable style={styles.button} onPress={() => setCount((c) => c + 1)}>
        <Text style={styles.buttonText}>Tapped {count} times</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { fontSize: 28, fontWeight: '700' },
  button: { backgroundColor: '#4f46e5', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
});
`;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A self-contained, interactive single-file HTML microapp. */
function renderHtmlApp(prompt) {
  const title = (prompt || 'Microapp').replace(/[<>]/g, '').slice(0, 48);
  const lines = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Microapp</title>',
    '<style>',
    '  *{box-sizing:border-box} body{margin:0;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#2a96ff,#5e5ce6 60%,#bf5af2);color:#fff}',
    '  .card{background:rgba(255,255,255,.14);backdrop-filter:blur(12px);padding:30px 34px;border-radius:22px;text-align:center;box-shadow:0 14px 50px rgba(0,0,0,.35)}',
    '  h1{margin:0 0 4px;font-size:20px;font-weight:680} p{margin:0 0 16px;opacity:.85;font-size:13px}',
    '  #clock{font-size:42px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px;margin:6px 0 18px}',
    '  button{background:#fff;color:#0a6bff;border:none;border-radius:14px;padding:13px 26px;font-size:16px;font-weight:700;cursor:pointer;transition:transform .1s}',
    '  button:active{transform:scale(.95)} #n{font-size:26px;font-weight:800;margin-top:16px}',
    '</style></head><body>',
    '  <div class="card">',
    '    <h1>' + title + '</h1>',
    '    <p>a live single-file microapp</p>',
    '    <div id="clock">--:--:--</div>',
    '    <button id="b">Tap me</button>',
    '    <div id="n">0 taps</div>',
    '  </div>',
    '  <script>',
    '    var pad=function(x){return String(x).padStart(2,"0")};',
    '    setInterval(function(){var d=new Date();document.getElementById("clock").textContent=pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds())},250);',
    '    var n=0;document.getElementById("b").onclick=function(){n++;document.getElementById("n").textContent=n+" tap"+(n===1?"":"s")};',
    '  </script>',
    '</body></html>',
  ];
  return lines.join('\n');
}

// A rich-markdown reply used to exercise the UI's markdown rendering.
const MARKDOWN_SAMPLE = [
  '## How rendering works',
  '',
  "Here's how **bold**, *italic*, ~~strikethrough~~ and `inline code` should look.",
  '',
  '### A few steps',
  '1. First **item** with some `code`',
  '2. Second item linking to [the docs](https://example.com)',
  '3. Third item',
  '',
  '### Bullets',
  '- Alpha',
  '- Beta',
  '- Gamma',
  '',
  '> A blockquote calling out something important.',
  '',
  '```js',
  'function greet(name) {',
  '  return `Hi, ${name}!`;',
  '}',
  '```',
  '',
  'And a final paragraph below a divider.',
  '',
  '---',
  '',
  'Done — that covers the common elements.',
].join('\n');
