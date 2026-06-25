/* On-device agent — web UI client. Speaks the canonical protocol over WS. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = window.DiffRender.escapeHtml;

  const state = {
    ws: null,
    url: localStorage.getItem('brokerUrl') || defaultWsUrl(),
    connected: false,
    activeAssistant: null, // current streaming assistant bubble (top-level)
    activeThinking: null,
    toolCards: new Map(), // id -> { el, head, body, name, isDiff, nested }
    approvals: new Map(), // id -> el
    pendingSent: [], // normalized texts we optimistically rendered (dedupe echoes)
    profiles: [],
    activeProfileId: null,
    projects: [],
    activeProjectId: null,
    metro: null,
    capabilities: null,
    permissionMode: 'default',
    resolvedModel: null, // resolved id of the active model (e.g. claude-opus-4-8)
    models: [], // [{ alias, id, label }] resolved model list
    selectedModel: null, // alias currently active in the picker
    effort: 'high',
    attachments: [], // [{ mime, dataBase64, url, name }]
    checkpoints: [],
    reconnectTimer: null,
  };
  // exposed for managers.js (toast attached after its definition below)
  window.Agent = { send, state, esc };

  // Native bridge: inside the Android WebView, window.AndroidAgent is injected by
  // the Kotlin host. On desktop browsers it's absent and we use the web APIs.
  // This is what makes image-attach, file save, voice and notifications work on
  // the phone (a WebView doesn't support those web APIs).
  const NB = () => window.AndroidAgent;
  const native = {
    has: (m) => { const b = NB(); return !!(b && typeof b[m] === 'function'); },
    pickImage: () => NB().pickImage(),
    saveFile: (name, content) => NB().saveFile(name, content),
    notify: (title, body) => NB().notify(title, body),
    startVoice: () => NB().startVoice(),
    openExternal: (url) => NB().openExternal(url),
  };
  // Callbacks the native side invokes (via evaluateJavascript):
  window.onPickedImage = (base64, mime) => {
    if (!base64) return;
    state.attachments.push({ mime: mime || 'image/jpeg', dataBase64: base64, url: `data:${mime || 'image/jpeg'};base64,${base64}`, name: 'image' });
    renderAttachments();
  };
  window.onVoiceResult = (text) => {
    const ta = $('input'); if (text) { ta.value = (ta.value ? ta.value + ' ' : '') + text; autoGrow(); }
    $('voiceBtn').classList.remove('listening');
  };

  function defaultWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = location.host || '127.0.0.1:8765';
    return `${proto}://${host}`;
  }

  // ---- connection ----------------------------------------------------------

  function connect() {
    clearTimeout(state.reconnectTimer);
    try {
      state.ws = new WebSocket(state.url);
    } catch {
      scheduleReconnect();
      return;
    }
    state.ws.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
    state.ws.onopen = () => {
      setConnected(true);
      resetConversation(); // avoid desync: rebuild fresh, then re-request snapshot
      send({ type: 'hello' });
    };
    state.ws.onclose = () => { setConnected(false); scheduleReconnect(); };
    state.ws.onerror = () => {};
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connect, 1500);
  }

  function setConnected(on) {
    state.connected = on;
    $('connDot').classList.toggle('online', on);
    $('connDot').title = on ? 'Connected to broker' : 'Disconnected — reconnecting…';
    // Transport state lives on the dot ONLY; the status pill reflects engine status.
  }

  function send(cmd) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(cmd));
      return true;
    }
    toast('Not connected to broker', 'error');
    return false;
  }

  // ---- event handling ------------------------------------------------------

  function handleEvent(ev) {
    switch (ev.type) {
      case 'session_meta': onSessionMeta(ev); break;
      case 'capabilities': onCapabilities(ev); break;
      case 'status': setStatus(ev.state, ev.detail); break;
      case 'assistant_text': appendAssistant(ev.delta, ev.parentToolUseId); break;
      case 'assistant_thinking': appendThinking(ev.delta, ev.parentToolUseId); break;
      case 'user_echo': onUserEcho(ev.text); break;
      case 'tool_call': onToolCall(ev); break;
      case 'tool_result': onToolResult(ev); break;
      case 'permission_request': onPermissionRequest(ev); break;
      case 'permission_resolved': onPermissionResolved(ev); break;
      case 'permission_denied': onPermissionDenied(ev); break;
      case 'permission_mode': onPermissionMode(ev); break;
      case 'models': onModels(ev); break;
      case 'effort': onEffort(ev); break;
      case 'usage': onUsage(ev); break;
      case 'context': onContext(ev); break;
      case 'compact': onCompact(ev); break;
      case 'result': onResult(ev); break;
      case 'error': onError(ev); break;
      case 'control_output': onControlOutput(ev); break;
      case 'control_status': appendTerminalMeta(`[${ev.channel}] ${ev.state}${ev.detail ? ': ' + ev.detail : ''}`); break;
      case 'metro_status': onMetro(ev); break;
      case 'git_status': onGitStatus(ev); break;
      case 'projects': onProjects(ev); break;
      case 'profiles': onProfiles(ev); break;
      case 'engine_state': onEngineState(ev); break;
      case 'config': if (window.Managers) window.Managers.onConfig(ev); break;
      case 'transcript': applyTranscript(ev); break;
      case 'checkpoints': if (window.Managers) window.Managers.onCheckpoints(ev); onCheckpoints(ev); break;
      case 'checkpoint_restored': onCheckpointRestored(ev); break;
      case 'native_change': onNativeChange(ev); break;
      case 'files': if (window.Managers) window.Managers.onFiles(ev); break;
      case 'file': if (window.Managers) window.Managers.onFile(ev); break;
      case 'file_search': onFileSearch(ev); break;
      case 'file_diff': if (window.Managers) window.Managers.onFileDiff(ev); break;
      case 'file_grep': if (window.Managers) window.Managers.onFileGrep(ev); break;
      case 'prompts': if (window.Managers) window.Managers.onPrompts(ev); break;
      case 'scripts': if (window.Managers) window.Managers.onScripts(ev); break;
      case 'github': onGithub(ev); break;
      case 'autoverify': onAutoVerify(ev); break;
      case 'usage_stats': if (window.Managers) window.Managers.onUsageStats(ev); break;
      case 'checkpoints_diff': if (window.Managers) window.Managers.onCheckpointDiff(ev); break;
      case 'file_replace': onFileReplace(ev); break;
      case 'transcript_search': break; // handled where requested
      case 'turn_changes': onTurnChanges(ev); break;
      case 'workspace_browse': if (window.Managers) window.Managers.onWorkspaceBrowse(ev); break;
      case 'log': break;
      case 'toast': if (ev.message) toast(ev.message, ev.level || 'info'); break;
      case 'ack': if (!ev.ok && ev.message) toast(ev.message, 'error'); break;
      case 'pong': break;
      default: break;
    }
  }

  function onSessionMeta(ev) {
    finalizeAssistant();
    // ev.model is the RESOLVED id (e.g. claude-opus-4-8); don't set it as the
    // <select> value (it isn't an option), or the picker goes blank. Stash it and
    // re-render so the option labels can show the resolved version.
    if (ev.model) { state.resolvedModel = ev.model; renderModelOptions(); }
  }

  function onEngineState(ev) {
    if (ev.profileId) state.activeProfileId = ev.profileId;
    if (ev.requestedModel) state.selectedModel = ev.requestedModel;
    if (ev.model) state.resolvedModel = ev.model;
    if (ev.effort) { state.effort = ev.effort; const s = $('effortSelect'); if (s) s.value = ev.effort; }
    if (ev.permissionMode) onPermissionMode({ mode: ev.permissionMode });
    renderModelOptions();
  }

  function onCapabilities(ev) {
    state.capabilities = ev;
    if (window.Managers) window.Managers.onCapabilities(ev);
    if (ev.permissionMode) onPermissionMode({ mode: ev.permissionMode });
  }

  function resetConversation() {
    $('transcript').innerHTML = '';
    $('transcript').appendChild(buildEmptyState());
    finalizeAssistant();
    clearTodos();
    state.toolCards.clear();
    state.approvals.clear();
    state.pendingSent = [];
  }

  // ---- transcript: assistant text ------------------------------------------

  function hideEmpty() { const e = document.querySelector('.empty-state'); if (e) e.remove(); }

  function nestedContainerFor(parentId) {
    const parent = parentId && state.toolCards.get(parentId);
    if (!parent) return null;
    if (!parent.nested) {
      parent.nested = el('div', 'tool-nested');
      parent.body.appendChild(parent.nested);
      parent.body.classList.remove('collapsed');
    }
    return parent.nested;
  }

  function appendAssistant(delta, parentId) {
    if (!delta) return;
    hideEmpty();
    const host = nestedContainerFor(parentId);
    if (host) { // subagent narration → muted line in parent card
      let line = host.querySelector('.nested-text:last-child');
      if (!line || line.dataset.done) {
        line = el('div', 'nested-text');
        host.appendChild(line);
      }
      line.textContent += delta;
      scrollDown();
      return;
    }
    if (!state.activeAssistant) {
      const msg = el('div', 'msg assistant');
      msg.appendChild(el('div', 'role', 'Agent'));
      const bubble = el('div', 'bubble cursor');
      msg.appendChild(bubble);
      $('transcript').appendChild(msg);
      state.activeAssistant = bubble;
    }
    state.activeAssistant.textContent += delta;
    scrollDown();
  }

  function appendThinking(delta, parentId) {
    if (!delta) return;
    hideEmpty();
    if (parentId) return appendAssistant('💭 ' + delta, parentId);
    if (!state.activeThinking) {
      const det = document.createElement('details');
      det.className = 'thinking';
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking…';
      det.appendChild(sum);
      const body = el('div');
      det.appendChild(body);
      $('transcript').appendChild(det);
      state.activeThinking = body;
    }
    state.activeThinking.textContent += delta;
    scrollDown();
  }

  function finalizeAssistant() {
    if (state.activeAssistant) state.activeAssistant.classList.remove('cursor');
    state.activeAssistant = null;
    state.activeThinking = null;
    document.querySelectorAll('.nested-text:not([data-done])').forEach((n) => (n.dataset.done = '1'));
  }

  function onUserEcho(text) {
    if (text == null || text === '') return;
    const norm = text.trim();
    const i = state.pendingSent.indexOf(norm);
    if (i >= 0) { state.pendingSent.splice(i, 1); return; } // our optimistic copy
    addUserMessage(text);
  }

  function addUserMessage(text) {
    hideEmpty();
    finalizeAssistant();
    const msg = el('div', 'msg user');
    msg.appendChild(el('div', 'role', 'You'));
    msg.appendChild(el('div', 'bubble', text));
    $('transcript').appendChild(msg);
    scrollDown();
  }

  // ---- transcript: tool cards ----------------------------------------------

  const TOOL_ICONS = {
    Bash: '⌘', Read: '📄', Write: '✎', Edit: '✎', MultiEdit: '✎', Glob: '🔍', Grep: '🔍',
    WebFetch: '🌐', WebSearch: '🌐', Agent: '🤖', Task: '🤖', Skill: '✦', NotebookEdit: '✎',
  };
  function toolIcon(name, kind) {
    if (TOOL_ICONS[name]) return TOOL_ICONS[name];
    if (kind === 'mcp' || /^mcp__/.test(name || '')) return '🔌';
    if (kind === 'subagent') return '🤖';
    return '🔧';
  }

  function onToolCall(ev) {
    // TodoWrite drives the pinned live checklist instead of a tool card.
    if (ev.name === 'TodoWrite' && ev.input && Array.isArray(ev.input.todos)) {
      return renderTodos(ev.input.todos);
    }
    hideEmpty();
    if (!ev.parentToolUseId) finalizeAssistant();
    const card = el('div', 'tool-card' + (ev.kind === 'subagent' ? ' subagent' : ''));
    const isDiff = /^(Write|Edit|MultiEdit)$/.test(ev.name);

    const head = el('div', 'tool-head');
    head.innerHTML =
      `<span class="tool-icon">${toolIcon(ev.name, ev.kind)}</span>` +
      `<span class="tool-name">${esc(prettyToolName(ev.name))}</span>` +
      `<span class="tool-target">${esc(targetOf(ev.input))}</span>` +
      `<span class="tool-state running">running</span>`;
    card.appendChild(head);

    const body = el('div', 'tool-body');
    if (isDiff) {
      body.innerHTML = window.DiffRender.renderDiff(ev.input || {});
    } else if (ev.name === 'Bash') {
      body.appendChild(elHtml('div', 'tool-input', '$ ' + esc((ev.input && ev.input.command) || '')));
      const pre = el('pre', '', '…');
      body.appendChild(pre);
      card.__pre = pre;
    } else {
      const pre = el('pre', '', shortInput(ev.input));
      body.appendChild(pre);
      card.__pre = pre;
    }
    if (ev.kind === 'subagent') body.classList.remove('collapsed');
    card.appendChild(body);
    head.addEventListener('click', () => body.classList.toggle('collapsed'));

    const host = nestedContainerFor(ev.parentToolUseId) || $('transcript');
    host.appendChild(card);
    state.toolCards.set(ev.id, { el: card, head, body, name: ev.name, isDiff, nested: null });
    scrollDown();
  }

  function onToolResult(ev) {
    const card = state.toolCards.get(ev.id);
    if (!card) return;
    const pill = card.head.querySelector('.tool-state');
    pill.textContent = ev.status === 'error' ? 'error' : 'done';
    pill.className = 'tool-state ' + (ev.status === 'error' ? 'error' : 'ok');
    if (ev.output != null) {
      if (card.isDiff) {
        // Even for diffs, surface a failure reason.
        if (ev.status === 'error') {
          const errPre = el('pre', 'tool-error', String(ev.output));
          card.body.appendChild(errPre);
          card.body.classList.remove('collapsed');
        }
      } else if (card.el.__pre) {
        card.el.__pre.textContent = String(ev.output) || '(no output)';
      }
    }
    if (ev.status !== 'error' && !card.isDiff && card.name !== 'Agent') card.body.classList.add('collapsed');
    scrollDown();
  }

  // ---- approvals -----------------------------------------------------------

  function onPermissionRequest(ev) {
    hideEmpty();
    finalizeAssistant();
    notifyIfHidden('Approval needed', ev.detail || ev.toolName || '');
    // Plan mode: ExitPlanMode presents the plan for approval before proceeding.
    if (ev.toolName === 'ExitPlanMode' || ev.toolName === 'exit_plan_mode') {
      const card = el('div', 'approval plan');
      card.appendChild(el('div', 'ask', '📋 The agent finished planning. Review and approve to proceed:'));
      const plan = el('div', 'plan-body');
      plan.textContent = (ev.input && (ev.input.plan || ev.input.message)) || ev.detail || '(no plan text)';
      card.appendChild(plan);
      const actions = el('div', 'approval-actions');
      const go = el('button', 'accent', 'Approve plan & proceed');
      const keep = el('button', 'ghost', 'Keep planning');
      go.onclick = () => send({ type: 'approve', id: ev.id });
      keep.onclick = () => send({ type: 'deny', id: ev.id, reason: 'Keep planning' });
      actions.appendChild(go); actions.appendChild(keep);
      card.appendChild(actions);
      $('transcript').appendChild(card);
      state.approvals.set(ev.id, card);
      return scrollDown();
    }
    const card = el('div', 'approval');
    const verb = ev.action === 'write_file' ? 'edit a file' :
      ev.action === 'run_command' ? 'run a command' :
      ev.action === 'network' ? 'access the network' :
      ev.action === 'mcp' ? 'use an MCP tool' :
      ev.action === 'subagent' ? 'spawn a subagent' : 'use a tool';
    card.innerHTML =
      `<div class="ask">The agent wants to <b>${esc(verb)}</b>.</div>` +
      `<div class="detail">${esc(ev.detail || ev.toolName || '')}</div>`;
    const actions = el('div', 'approval-actions');
    const allow = el('button', 'accent', 'Approve');
    const deny = el('button', 'danger', 'Deny');
    allow.onclick = () => send({ type: 'approve', id: ev.id });
    deny.onclick = () => send({ type: 'deny', id: ev.id });
    actions.appendChild(allow); actions.appendChild(deny);
    card.appendChild(actions);
    $('transcript').appendChild(card);
    state.approvals.set(ev.id, card);
    scrollDown();
  }

  function onPermissionResolved(ev) {
    const card = state.approvals.get(ev.id);
    if (!card) return;
    card.classList.add('resolved');
    const actions = card.querySelector('.approval-actions');
    if (actions) actions.remove();
    card.appendChild(el('div', 'verdict ' + (ev.decision === 'allow' ? 'allow' : 'deny'),
      ev.decision === 'allow' ? '✓ Approved' : '✕ Denied'));
  }

  function onPermissionDenied(ev) {
    const div = el('div', 'denial', `⛔ ${ev.toolName} denied — ${ev.reason}`);
    $('transcript').appendChild(div);
    scrollDown();
  }

  function onPermissionMode(ev) {
    state.permissionMode = ev.mode;
    const sel = $('permModeSelect');
    if (sel && sel.value !== ev.mode) sel.value = ev.mode;
    const badge = $('permModeBadge');
    if (badge) {
      badge.textContent = ev.mode;
      badge.className = 'perm-badge ' + (ev.mode === 'bypassPermissions' ? 'danger' : ev.mode);
    }
  }

  // ---- status / usage / context --------------------------------------------

  function setStatus(stateName, detail) {
    const pill = $('statusPill');
    pill.className = 'status-pill ' + (stateName || 'idle');
    pill.textContent = stateName || 'idle';
    pill.title = detail || '';
  }

  function onUsage(ev) {
    const parts = [];
    if (ev.inTok != null) parts.push(`${fmt(ev.inTok)} in`);
    if (ev.outTok != null) parts.push(`${fmt(ev.outTok)} out`);
    if (ev.cost != null) parts.push(`$${ev.cost.toFixed(3)}`);
    else if (ev.cost === null) parts.push('flat');
    $('usage').textContent = parts.join(' · ');
  }

  function onContext(ev) {
    if (!ev.windowTokens) return;
    const pct = Math.min(100, Math.round((ev.usedTokens / ev.windowTokens) * 100));
    const meter = $('ctxMeter');
    const bar = $('ctxBar');
    const label = $('ctxLabel');
    if (meter) meter.classList.remove('hidden');
    if (bar) { bar.style.width = pct + '%'; bar.className = 'ctx-bar' + (pct > 85 ? ' hot' : pct > 65 ? ' warm' : ''); }
    if (label) label.textContent = `${fmt(ev.usedTokens)}/${fmt(ev.windowTokens)} (${pct}%)`;
    if (window.Managers) window.Managers.onContext(ev);
  }

  function onCompact(ev) {
    const div = el('div', 'compact-divider', `↡ context compacted (${ev.trigger}${ev.preTokens ? ', was ' + fmt(ev.preTokens) + ' tok' : ''})`);
    $('transcript').appendChild(div);
    scrollDown();
  }

  function onResult(ev) {
    finalizeAssistant();
    if (ev.isError) toast('Turn ended with an error', 'error');
    notifyIfHidden(ev.isError ? 'Agent hit an error' : 'Agent finished', 'Tap to return to the conversation');
  }

  // Title flash + Web Notification when the tab is backgrounded (e.g. you switched
  // to the dev client to test) and the agent needs you or finished.
  let _titleFlash = null;
  function notifyIfHidden(title, body) {
    // On Android, post a real native notification via the foreground service
    // (Web Notifications don't work in a WebView).
    if (native.has('notify')) { native.notify(title, body); return; }
    if (!document.hidden) return;
    if (window.Notification && Notification.permission === 'granted') {
      try { new Notification(title, { body }); } catch { /* ignore */ }
    }
    clearInterval(_titleFlash);
    let on = false;
    const orig = 'On-Device Agent';
    _titleFlash = setInterval(() => { document.title = (on = !on) ? `🔔 ${title}` : orig; }, 1000);
    const restore = () => { clearInterval(_titleFlash); document.title = orig; document.removeEventListener('visibilitychange', restore); };
    document.addEventListener('visibilitychange', restore);
  }
  let _notifyAsked = false;
  function requestNotify() {
    if (_notifyAsked || !window.Notification) return;
    _notifyAsked = true;
    if (Notification.permission === 'default') { try { Notification.requestPermission(); } catch { /* ignore */ } }
  }

  function onError(ev) {
    if (ev.fatal || ev.code === 'auth') {
      showBanner(ev.message || 'Error', ev.code === 'auth');
    } else {
      toast(ev.message || 'Error', 'error');
    }
  }

  function ensureBanner() {
    let banner = $('banner');
    if (!banner) {
      banner = el('div', 'banner');
      banner.id = 'banner';
      document.getElementById('app').prepend(banner);
    }
    return banner;
  }
  function showBanner(message, isAuth) {
    const banner = ensureBanner();
    banner.className = 'banner';
    banner.innerHTML = '';
    banner.appendChild(el('span', '', message));
    if (isAuth) {
      const help = el('span', 'banner-help', ' Open the terminal drawer and run `claude` then `/login` to re-authenticate.');
      banner.appendChild(help);
    }
    const x = el('button', 'banner-x', '✕');
    x.onclick = () => banner.remove();
    banner.appendChild(x);
  }

  // ---- transcript replay / checkpoints / native change --------------------

  function applyTranscript(ev) {
    if (ev.reset) resetConversation();
    for (const rec of ev.events || []) {
      if (rec.type === 'result') { finalizeAssistant(); continue; }
      handleEvent(rec);
    }
    finalizeAssistant();
  }

  function onCheckpoints(ev) {
    state.checkpoints = ev.items || [];
    const btn = $('undoBtn');
    if (btn) {
      btn.classList.toggle('hidden', !ev.enabled || !state.checkpoints.length);
      btn.title = state.checkpoints.length ? `Rewind to before: ${state.checkpoints[0].label}` : 'Rewind';
    }
  }
  function onCheckpointRestored(ev) {
    toast(`Rewound to checkpoint${ev.removed ? ` (removed ${ev.removed} new file${ev.removed === 1 ? '' : 's'})` : ''}`, 'info');
  }

  function onNativeChange(ev) {
    const deps = (ev.deps || []).join(', ');
    showBanner('', false);
    const banner = $('banner');
    banner.innerHTML = '';
    banner.classList.add('native');
    banner.appendChild(el('span', '', `Native deps changed${deps ? ' (' + deps + ')' : ''} — a new dev client build is needed for JS-only Fast Refresh to keep working.`));
    const rebuild = el('button', 'accent', 'Rebuild (EAS)');
    rebuild.onclick = () => { send({ type: 'eas_build', profile: 'development', platform: 'android' }); banner.remove(); toggleTerminal(); };
    const dismiss = el('button', 'banner-x', '✕');
    dismiss.onclick = () => banner.remove();
    banner.appendChild(rebuild); banner.appendChild(dismiss);
  }

  // ---- todos (pinned live checklist) ---------------------------------------

  function renderTodos(todos) {
    const panel = $('todoPanel');
    if (!todos || !todos.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
    const done = todos.filter((t) => t.status === 'completed').length;
    panel.innerHTML = '';
    const head = el('div', 'todo-head', `Plan — ${done}/${todos.length} done`);
    panel.appendChild(head);
    todos.forEach((t) => {
      const row = el('div', 'todo-item ' + (t.status || 'pending'));
      // The status marker is drawn by CSS (::before circle/check/spinner).
      row.textContent = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
      panel.appendChild(row);
    });
    panel.classList.remove('hidden');
  }
  function clearTodos() { renderTodos([]); }

  // ---- web preview ----------------------------------------------------------

  function togglePreview() {
    const p = $('preview');
    const showing = p.classList.toggle('hidden');
    if (!showing) {
      const f = $('previewFrame');
      if (!f.src || f.src === 'about:blank') loadPreview();
    }
  }
  function loadPreview() {
    const url = $('previewUrl').value.trim() || '/preview/index.html';
    $('previewFrame').src = url;
  }

  // ---- export to markdown ---------------------------------------------------

  function exportMarkdown() {
    let md = `# Conversation — ${new Date().toLocaleString()}\n\n`;
    for (const node of $('transcript').children) {
      if (node.classList.contains('msg')) {
        const role = node.classList.contains('user') ? 'You' : 'Agent';
        const text = node.querySelector('.bubble')?.textContent || '';
        md += `**${role}:** ${text}\n\n`;
      } else if (node.classList.contains('tool-card')) {
        const name = node.querySelector('.tool-name')?.textContent || 'tool';
        const target = node.querySelector('.tool-target')?.textContent || '';
        md += `\`🔧 ${name} ${target}\`\n\n`;
      } else if (node.classList.contains('approval')) {
        md += `> ⚠ ${node.querySelector('.detail')?.textContent || 'permission'} — ${node.querySelector('.verdict')?.textContent || 'pending'}\n\n`;
      } else if (node.classList.contains('compact-divider')) {
        md += `---\n_${node.textContent}_\n---\n\n`;
      }
    }
    const name = `conversation-${Date.now()}.md`;
    if (native.has('saveFile')) { native.saveFile(name, md); toast('Saved — choose where to share it', 'info'); return; }
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function onFileReplace(ev) {
    toast(`Replaced ${ev.replacements} occurrence(s) across ${ev.filesChanged} file(s) — ↶ Undo to revert`, 'info');
  }

  function onTurnChanges(ev) {
    if (!ev.files || !ev.files.length) return;
    const card = el('div', 'tool-card turn-changes');
    const head = el('div', 'tool-head');
    head.innerHTML = `<span class="tool-icon">✦</span><span class="tool-name">Changed this turn</span><span class="tool-target">${ev.files.length} file(s)</span><span class="tool-state ok">diff</span>`;
    card.appendChild(head);
    const body = el('div', 'tool-body collapsed');
    if (ev.stat) { const pre = el('pre', '', ev.stat); body.appendChild(pre); }
    const list = el('div', 'tc-list');
    ev.files.forEach((f) => {
      const row = el('div', 'tc-row');
      row.innerHTML = `<code class="chg-${(f.status || '?')[0]}">${esc(f.status || '?')}</code> <span>${esc(f.path)}</span>`;
      row.style.cursor = 'pointer';
      row.onclick = () => { if (window.Managers) window.Managers.open(); send({ type: 'files_diff', path: f.path, checkpointId: ev.checkpointId }); };
      list.appendChild(row);
    });
    body.appendChild(list);
    card.appendChild(body);
    head.addEventListener('click', () => body.classList.toggle('collapsed'));
    $('transcript').appendChild(card);
    scrollDown();
  }

  // ---- command palette (Ctrl-K) --------------------------------------------

  function paletteActions() {
    const a = [
      { label: 'New session', run: () => { send({ type: 'new_session' }); resetConversation(); } },
      { label: 'Interrupt current turn', run: () => send({ type: 'interrupt' }) },
      { label: 'Test (Metro + dev client)', run: onTest },
      { label: 'Preview project', run: togglePreview },
      { label: 'Find in conversation', run: () => { if ($('findBar').classList.contains('hidden')) toggleFind(); } },
      { label: 'Export conversation to Markdown', run: exportMarkdown },
      { label: 'Toggle terminal', run: toggleTerminal },
      { label: 'Compact context (/compact)', run: () => send({ type: 'compact' }) },
      { label: 'Clear conversation (/clear)', run: () => { send({ type: 'clear' }); resetConversation(); } },
      { label: 'Commit & Push to GitHub', run: () => { send({ type: 'github_push' }); toggleTerminal(); } },
      { label: 'Create pull request', run: () => { send({ type: 'github_pr' }); toggleTerminal(); } },
    ];
    ['files', 'scripts', 'git', 'checkpoints', 'prompts', 'usage', 'permissions', 'hooks', 'memory', 'sessions', 'mcp']
      .forEach((tab) => a.push({ label: `Open: ${tab}`, run: () => window.Managers && window.Managers.openTab(tab) }));
    for (const p of state.profiles) a.push({ label: `Engine → ${p.label}`, run: () => send({ type: 'switch_engine', profileId: p.id }) });
    const active = state.profiles.find((p) => p.id === state.activeProfileId);
    for (const mdl of (active && active.models) || []) a.push({ label: `Model → ${mdl}`, run: () => send({ type: 'switch_model', model: mdl }) });
    return a;
  }
  function openPalette() {
    const pal = $('palette');
    pal.classList.remove('hidden');
    const input = $('paletteInput');
    input.value = '';
    renderPalette('');
    input.focus();
  }
  function closePalette() { $('palette').classList.add('hidden'); }
  let _palItems = [];
  let _palIdx = 0;
  function renderPalette(q) {
    const all = paletteActions();
    const ql = q.toLowerCase();
    _palItems = ql ? all.filter((a) => a.label.toLowerCase().includes(ql)) : all;
    _palIdx = 0;
    const list = $('paletteList');
    list.innerHTML = '';
    _palItems.slice(0, 40).forEach((a, i) => {
      const row = el('div', 'palette-item' + (i === 0 ? ' sel' : ''), a.label);
      row.onclick = () => { a.run(); closePalette(); };
      list.appendChild(row);
    });
  }
  function movePalette(d) {
    const rows = $('paletteList').children;
    if (!rows.length) return;
    rows[_palIdx] && rows[_palIdx].classList.remove('sel');
    _palIdx = (_palIdx + d + rows.length) % rows.length;
    rows[_palIdx].classList.add('sel');
    rows[_palIdx].scrollIntoView({ block: 'nearest' });
  }

  // ---- conversation find bar ------------------------------------------------

  let _findHits = [];
  let _findIdx = -1;
  function clearFindMarks() {
    document.querySelectorAll('#transcript mark.find-hit').forEach((mk) => {
      const t = document.createTextNode(mk.textContent);
      mk.parentNode.replaceChild(t, mk);
    });
    _findHits = []; _findIdx = -1;
  }
  function runFind(q) {
    clearFindMarks();
    if (!q) { $('findCount').textContent = ''; return; }
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker($('transcript'), NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('script,style') ? NodeFilter.FILTER_REJECT
        : n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      const text = node.nodeValue; const frag = document.createDocumentFragment();
      let i = 0, idx;
      const low = text.toLowerCase();
      while ((idx = low.indexOf(needle, i)) !== -1) {
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
        const mk = document.createElement('mark'); mk.className = 'find-hit'; mk.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mk); _findHits.push(mk);
        i = idx + q.length;
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
      node.parentNode.replaceChild(frag, node);
    }
    $('findCount').textContent = _findHits.length ? `1/${_findHits.length}` : '0';
    if (_findHits.length) gotoFind(0);
  }
  function gotoFind(i) {
    if (!_findHits.length) return;
    if (_findIdx >= 0 && _findHits[_findIdx]) _findHits[_findIdx].classList.remove('current');
    _findIdx = (i + _findHits.length) % _findHits.length;
    const mk = _findHits[_findIdx];
    mk.classList.add('current');
    mk.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('findCount').textContent = `${_findIdx + 1}/${_findHits.length}`;
  }
  function toggleFind() {
    const bar = $('findBar');
    const showing = bar.classList.toggle('hidden');
    if (!showing) { $('findInput').focus(); $('findInput').select(); }
    else clearFindMarks();
  }

  // ---- terminal ------------------------------------------------------------

  function onControlOutput(ev) { appendTerminal(ev.data, ev.stream === 'stderr' ? 'stderr' : ''); }
  function appendTerminal(text, cls) {
    const body = $('termBody');
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    body.appendChild(span);
    body.scrollTop = body.scrollHeight;
  }
  function appendTerminalMeta(text) { appendTerminal(text + '\n', 'meta'); }

  // ---- metro / test --------------------------------------------------------

  function onMetro(ev) {
    state.metro = ev;
    const badge = $('metroBadge');
    if (ev.running) {
      badge.classList.remove('hidden');
      badge.textContent = `Metro :${ev.port}`;
      $('testBtn').textContent = '▶ Open';
      if (state._awaitingMetro) { state._awaitingMetro = false; openDevClient(); }
    } else {
      badge.classList.add('hidden');
      $('testBtn').textContent = '▶ Test';
    }
  }

  function onTest() {
    if (state.metro && state.metro.running) return openDevClient();
    state._awaitingMetro = true;
    send({ type: 'start_metro' });
    toast('Starting Metro…', 'info');
    // Safety net if no metro_status arrives.
    setTimeout(() => { if (state._awaitingMetro) { state._awaitingMetro = false; openDevClient(); } }, 8000);
  }
  function openDevClient() {
    const url = (state.metro && state.metro.url) || 'exp://127.0.0.1:8081';
    appendTerminalMeta('Opening dev client: ' + url);
    openExternal(url);
    toast('Opening ' + url, 'info');
  }
  // Reliably open a URL/scheme externally (native intent on Android; anchor on web).
  function openExternal(url) {
    if (native.has('openExternal')) { native.openExternal(url); return; }
    const a = document.createElement('a');
    a.href = url; if (/^https?:/.test(url)) a.target = '_blank';
    a.click();
  }

  function onGitStatus(ev) {
    appendTerminalMeta(`git ${ev.op} (exit ${ev.code})`);
    if (ev.output) appendTerminal(ev.output + '\n');
  }

  function onAutoVerify(ev) {
    state.autoverify = ev;
    if (window.Managers) window.Managers.onAutoVerify(ev);
    if (ev.state === 'running') toast(`Auto-verify: running \`${ev.command}\``, 'info');
    else if (ev.state === 'passed') toast('Auto-verify passed ✓', 'info');
    else if (ev.state === 'failed') toast(`Auto-verify failed — sending fix (attempt ${ev.iteration}/${ev.maxIterations})`, 'error');
    else if (ev.state === 'maxed') toast(`Auto-verify hit max attempts (${ev.maxIterations}) — stopping`, 'error');
  }

  function onGithub(ev) {
    if (ev.op === 'pr' && ev.ok && ev.url) {
      toast('PR created', 'info');
      const banner = ensureBanner();
      banner.className = 'banner native';
      banner.innerHTML = '';
      const a = el('button', 'ghost', '🔗 Open PR: ' + ev.url);
      a.onclick = () => openExternal(ev.url);
      banner.appendChild(a);
      const x = el('button', 'banner-x', '✕'); x.onclick = () => banner.remove();
      banner.appendChild(x);
    } else {
      toast(`GitHub ${ev.op}: ${ev.ok ? 'ok' : 'failed'} — ${ev.message || ''}`, ev.ok ? 'info' : 'error');
      if (!ev.ok && $('terminal').classList.contains('hidden')) toggleTerminal();
    }
  }

  // ---- projects / profiles -------------------------------------------------

  function onProjects(ev) {
    state.projects = ev.projects || [];
    state.activeProjectId = ev.activeProjectId;
    const sel = $('projectSelect');
    sel.innerHTML = '';
    for (const p of state.projects) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name + (p.isExpo ? ' ⚛' : '');
      if (p.id === ev.activeProjectId) o.selected = true;
      sel.appendChild(o);
    }
    if (!state.projects.length) {
      const o = document.createElement('option');
      o.textContent = '(no folder open)'; o.value = '';
      sel.appendChild(o);
    }
    // Always-present actions so workspace + session switching are reachable from the bar.
    const og = document.createElement('optgroup'); og.label = '—';
    [['__open__', '📂 Open folder…'], ['__sessions__', '🕘 Sessions…']].forEach(([v, label]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = label; og.appendChild(o);
    });
    sel.appendChild(og);
    if (window.Managers) window.Managers.onProjects(ev);
  }

  function onProfiles(ev) {
    state.profiles = ev.profiles || [];
    state.activeProfileId = ev.activeProfileId;
    const sel = $('engineSelect');
    sel.innerHTML = '';
    for (const p of state.profiles) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label + (p.ready ? '' : ' ⚠');
      if (p.id === ev.activeProfileId) o.selected = true;
      sel.appendChild(o);
    }
    renderModelOptions();
    if (window.Managers) window.Managers.onProfiles(ev);
  }

  function renderModelOptions() {
    const active = state.profiles.find((p) => p.id === state.activeProfileId);
    const sel = $('modelSelect');
    if (!sel) return;
    const aliases = (active && active.models) || (active && active.model ? [active.model] : []);
    // Prefer the broker's resolved list ([{alias,id,label}]); fall back to raw aliases.
    const resolved = new Map(state.models.map((m) => [m.alias, m]));
    const selected = state.selectedModel || (active && active.model) || aliases[0];
    sel.innerHTML = '';
    const seen = new Map(); // label -> count, to disambiguate any collisions
    for (const alias of aliases) {
      const o = document.createElement('option');
      o.value = alias;
      const r = resolved.get(alias);
      let label = (r && r.label) || labelFromAlias(alias);
      // Fallback: if this alias isn't resolved yet but it's the live one, borrow
      // the resolved id from session_meta — but only when its family matches the
      // alias, so 'opus' never shows a Sonnet version on a non-Opus account.
      if ((!r || !r.id) && alias === selected && state.resolvedModel && familyMatches(alias, state.resolvedModel)) {
        label = labelFromId(state.resolvedModel) || label;
      }
      // Safety net: never render two identical labels — disambiguate by alias.
      if (seen.has(label)) label = `${label} (${alias})`;
      seen.set(label, true);
      o.textContent = label;
      if (alias === selected) o.selected = true;
      sel.appendChild(o);
    }
  }

  function onModels(ev) {
    state.models = Array.isArray(ev.items) ? ev.items : [];
    if (ev.resolvedModel) state.resolvedModel = ev.resolvedModel;
    renderModelOptions();
  }

  let _modelsRequested = false;
  function resolveModelsOnce() {
    // If any alias is still unresolved, ask the broker to probe (free init spawn).
    if (_modelsRequested) return;
    const unresolved = !state.models.length || state.models.some((m) => !m.id);
    if (!unresolved) return;
    _modelsRequested = true;
    send({ type: 'models_list' });
  }

  function onEffort(ev) {
    if (!ev.level) return;
    state.effort = ev.level;
    const sel = $('effortSelect');
    if (sel) sel.value = ev.level;
  }

  // "claude-opus-4-8" -> "Opus 4.8"; falls back to null when unparseable.
  function labelFromId(id) {
    const m = String(id || '').match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
    return m ? `${cap(m[1])} ${m[2]}.${m[3]}` : null;
  }
  function labelFromAlias(a) { return cap(String(a || '')); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function familyOf(s) { const m = String(s || '').match(/opus|sonnet|haiku|fable/i); return m ? m[0].toLowerCase() : null; }
  // A known-family alias must match the id's family; family-less aliases (glm) pass.
  function familyMatches(alias, id) { const fa = familyOf(alias); return !fa || fa === familyOf(id); }

  // ---- helpers -------------------------------------------------------------

  function prettyToolName(name) {
    if (/^mcp__/.test(name)) return name.replace(/^mcp__/, '').replace(/__/g, ' · ');
    return name;
  }
  function targetOf(input) {
    if (!input) return '';
    return input.file_path || input.path || input.command || input.url || input.pattern ||
      input.subagent_type || input.agent_type || input.description || '';
  }
  function shortInput(input) { try { return JSON.stringify(input, null, 2); } catch { return String(input); } }
  function fmt(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function elHtml(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.innerHTML = html;
    return e;
  }
  const SUGGESTIONS = [
    'Build a counter screen with a + button',
    'Research how the navigation is set up',
    'Create a to-do list with add and delete',
  ];
  function buildEmptyState() {
    const d = el('div', 'empty-state');
    d.innerHTML =
      `<div class="hero-glyph"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
      `<path d="M12 2.5l1.9 4.9 4.9 1.9-4.9 1.9L12 16l-1.9-4.8L5.2 9.3l4.9-1.9L12 2.5z"/>` +
      `<path d="M18.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3z" opacity=".85"/></svg></div>` +
      `<h1>On-Device Agent</h1>` +
      `<p>Ask it to build something. It reads, edits and runs your code — tap <strong>Test</strong> to see it live on this phone.</p>`;
    const list = el('div', 'suggestions');
    SUGGESTIONS.forEach((text) => {
      const b = el('button', 'suggestion', text);
      b.onclick = () => { $('input').value = text; autoGrow(); $('input').focus(); };
      list.appendChild(b);
    });
    d.appendChild(list);
    return d;
  }
  function scrollDown() { const t = $('transcript'); t.scrollTop = t.scrollHeight; }
  function toast(msg, kind) {
    const t = el('div', 'toast ' + (kind || 'info'), msg);
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
  window.Agent.toast = toast;

  // ---- composer & controls -------------------------------------------------

  function doSend() {
    const input = $('input');
    const text = input.value.trim();
    const images = state.attachments.map((a) => ({ mime: a.mime, dataBase64: a.dataBase64 }));
    if (!text && !images.length) return;
    if (text) state.pendingSent.push(text); // only dedupe non-empty echoes
    addUserMessage(text + (images.length ? `\n📎 ${images.length} image${images.length === 1 ? '' : 's'}` : ''));
    send({ type: 'user_message', text, images: images.length ? images : undefined });
    input.value = '';
    clearAttachments();
    autoGrow();
    hideSlashPalette();
    hideMentionPalette();
  }

  // ---- image attachments ----------------------------------------------------

  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      const dataBase64 = dataUrl.slice(comma + 1);
      state.attachments.push({ mime: file.type, dataBase64, url: dataUrl, name: file.name });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
  function renderAttachments() {
    const tray = $('attachTray');
    tray.innerHTML = '';
    tray.classList.toggle('hidden', !state.attachments.length);
    state.attachments.forEach((a, i) => {
      const chip = el('div', 'attach-chip');
      const img = document.createElement('img');
      img.src = a.url; chip.appendChild(img);
      const x = el('button', 'attach-x', '✕');
      x.onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
      chip.appendChild(x);
      tray.appendChild(chip);
    });
    autoGrow(); // keep the send button state in sync with attachments
  }
  function clearAttachments() { state.attachments = []; renderAttachments(); }

  // ---- @-file mention -------------------------------------------------------

  let _mentionToken = null;
  function updateMentionPalette() {
    const ta = $('input');
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|\s)@([^\s]*)$/);
    if (!m) { _mentionToken = null; return hideMentionPalette(); }
    _mentionToken = m[2];
    send({ type: 'files_search', query: _mentionToken || '.' });
  }
  function onFileSearch(ev) {
    if (_mentionToken == null) return;
    const pal = $('mentionPalette');
    const matches = ev.matches || [];
    if (!matches.length) return hideMentionPalette();
    pal.innerHTML = '';
    matches.slice(0, 10).forEach((p) => {
      const item = el('div', 'slash-item', '@' + p);
      item.onclick = () => insertMention(p);
      pal.appendChild(item);
    });
    pal.classList.remove('hidden');
  }
  function insertMention(filePath) {
    const ta = $('input');
    const before = ta.value.slice(0, ta.selectionStart).replace(/@[^\s]*$/, '@' + filePath + ' ');
    const after = ta.value.slice(ta.selectionStart);
    ta.value = before + after;
    ta.focus();
    hideMentionPalette();
    autoGrow();
  }
  function hideMentionPalette() { $('mentionPalette').classList.add('hidden'); }

  // ---- voice input ----------------------------------------------------------

  function startVoice() {
    // On Android, use the native SpeechRecognizer (the Web Speech API isn't in a WebView).
    if (native.has('startVoice')) { $('voiceBtn').classList.add('listening'); native.startVoice(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Voice input not supported in this browser', 'error');
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    const base = $('input').value;
    $('voiceBtn').classList.add('listening');
    rec.onresult = (e) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      $('input').value = (base ? base + ' ' : '') + txt;
      autoGrow();
    };
    rec.onend = () => $('voiceBtn').classList.remove('listening');
    rec.onerror = () => $('voiceBtn').classList.remove('listening');
    rec.start();
  }

  function autoGrow() {
    const ta = $('input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    // Light up the circular send button when there's something to send (iMessage).
    const composer = document.querySelector('.composer');
    if (composer) composer.classList.toggle('has-text', !!ta.value.trim() || state.attachments.length > 0);
  }

  // slash command palette
  function updateSlashPalette() {
    const v = $('input').value;
    const pal = $('slashPalette');
    if (!v.startsWith('/') || v.includes(' ') || !state.capabilities) return hideSlashPalette();
    const q = v.slice(1).toLowerCase();
    const cmds = (state.capabilities.slashCommands || []).filter((c) =>
      String(c).replace(/^\//, '').toLowerCase().startsWith(q));
    if (!cmds.length) return hideSlashPalette();
    pal.innerHTML = '';
    cmds.slice(0, 8).forEach((c) => {
      const name = String(c).replace(/^\//, '');
      const item = el('div', 'slash-item', '/' + name);
      item.onclick = () => { $('input').value = '/' + name + ' '; hideSlashPalette(); $('input').focus(); };
      pal.appendChild(item);
    });
    pal.classList.remove('hidden');
  }
  function hideSlashPalette() { $('slashPalette').classList.add('hidden'); }

  function toggleTerminal() { $('terminal').classList.toggle('hidden'); }

  // ---- wire up -------------------------------------------------------------

  function init() {
    $('brokerUrl') && ($('brokerUrl').value = state.url);

    $('sendBtn').onclick = () => { requestNotify(); doSend(); };
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); requestNotify(); doSend(); }
      if (e.key === 'Escape') { hideSlashPalette(); hideMentionPalette(); }
    });
    $('input').addEventListener('input', () => { autoGrow(); updateSlashPalette(); updateMentionPalette(); });
    // Paste an image straight into the composer (screenshots).
    $('input').addEventListener('paste', (e) => {
      for (const item of e.clipboardData?.items || []) {
        if (item.type && item.type.startsWith('image/')) addImageFile(item.getAsFile());
      }
    });

    // Attach image: native picker in the WebView, file input on desktop.
    $('attachBtn').onclick = () => { if (native.has('pickImage')) native.pickImage(); else $('imageInput').click(); };
    $('imageInput').addEventListener('change', (e) => {
      for (const f of e.target.files || []) addImageFile(f);
      e.target.value = '';
    });
    $('voiceBtn').onclick = startVoice;

    // Drag & drop images onto the conversation.
    const dz = document.getElementById('app');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); });
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      for (const f of e.dataTransfer?.files || []) addImageFile(f);
    });

    $('undoBtn').onclick = () => {
      if (!state.checkpoints.length) return;
      if (confirm(`Rewind the project to before "${state.checkpoints[0].label}"? Files the agent changed this turn will be reverted.`)) {
        send({ type: 'checkpoint_restore', id: state.checkpoints[0].id });
      }
    };

    $('interruptBtn').onclick = () => send({ type: 'interrupt' });
    $('newBtn').onclick = () => { send({ type: 'new_session' }); resetConversation(); };
    $('testBtn').onclick = onTest;
    $('previewBtn').onclick = togglePreview;
    $('previewReload').onclick = loadPreview;
    $('previewClose').onclick = togglePreview;
    $('previewUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPreview(); });
    $('exportBtn').onclick = exportMarkdown;
    $('termBtn').onclick = toggleTerminal;
    $('termClose').onclick = toggleTerminal;
    $('termClear').onclick = () => { $('termBody').innerHTML = ''; };
    $('termInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = e.target.value.trim();
        if (cmd) { appendTerminalMeta('$ ' + cmd); send({ type: 'run', command: cmd }); }
        e.target.value = '';
      }
    });

    $('menuBtn').onclick = () => window.Managers && window.Managers.open();

    // Command palette button (touch entry point — Ctrl-K has no key on a phone)
    $('paletteBtn').onclick = openPalette;

    // Find-in-conversation
    $('findBtn').onclick = toggleFind;
    $('findClose').onclick = toggleFind;
    $('findNext').onclick = () => gotoFind(_findIdx + 1);
    $('findPrev').onclick = () => gotoFind(_findIdx - 1);
    let _findTimer = null;
    $('findInput').addEventListener('input', (e) => { clearTimeout(_findTimer); const v = e.target.value; _findTimer = setTimeout(() => runFind(v), 150); });
    $('findInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); gotoFind(_findIdx + (e.shiftKey ? -1 : 1)); }
      if (e.key === 'Escape') toggleFind();
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); if ($('findBar').classList.contains('hidden')) toggleFind(); else $('findInput').focus(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
    });

    // Command palette
    $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) closePalette(); });
    $('paletteInput').addEventListener('input', (e) => renderPalette(e.target.value));
    $('paletteInput').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePalette();
      else if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = _palItems[_palIdx]; if (it) { it.run(); closePalette(); } }
    });

    $('projectSelect').onchange = (e) => {
      const v = e.target.value;
      if (v === '__open__') { if (window.Managers) window.Managers.openTab('projects'); e.target.value = state.activeProjectId || ''; }
      else if (v === '__sessions__') { if (window.Managers) window.Managers.openTab('sessions'); e.target.value = state.activeProjectId || ''; }
      else if (v) send({ type: 'open_project', projectId: v });
    };
    $('engineSelect').onchange = (e) => send({ type: 'switch_engine', profileId: e.target.value });
    $('modelSelect').onchange = (e) => { state.selectedModel = e.target.value; send({ type: 'switch_model', model: e.target.value }); };
    // Resolve alias -> version labels lazily the first time the user opens the picker.
    $('modelSelect').addEventListener('mousedown', resolveModelsOnce);
    $('modelSelect').addEventListener('focus', resolveModelsOnce);
    const effortSel = $('effortSelect');
    if (effortSel) effortSel.onchange = (e) => { state.effort = e.target.value; send({ type: 'set_effort', level: e.target.value }); };
    $('permModeSelect').onchange = (e) => {
      const mode = e.target.value;
      if (mode === 'bypassPermissions' &&
          !confirm('Bypass ALL permission prompts? The agent can run any command or edit without asking. Continue?')) {
        e.target.value = state.permissionMode; return;
      }
      send({ type: 'set_permission_mode', mode });
    };

    document.querySelectorAll('.suggestion').forEach((s) => {
      s.onclick = () => { $('input').value = s.textContent; autoGrow(); $('input').focus(); };
    });

    connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
