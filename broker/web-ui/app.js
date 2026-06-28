/* On-device agent — web UI client. Speaks the canonical protocol over WS. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = window.DiffRender.escapeHtml;

  // Drive --vh from the real innerHeight: vh/dvh units misresolve (often to 0) in
  // the Compose-hosted Android WebView, which collapses modals/sheets/the terminal
  // drawer. All viewport-height CSS uses calc(N * var(--vh)).
  function setVh() {
    const h = window.innerHeight || document.documentElement.clientHeight || 0;
    if (h > 0) document.documentElement.style.setProperty('--vh', h / 100 + 'px');
  }
  setVh();
  window.addEventListener('resize', setVh);
  window.addEventListener('orientationchange', setVh);

  const state = {
    ws: null,
    url: localStorage.getItem('brokerUrl') || defaultWsUrl(),
    connected: false,
    activeAssistant: null, // current streaming assistant bubble (top-level)
    activeThinking: null,
    toolCards: new Map(), // id -> { el, head, body, name, isDiff, nested }
    approvals: new Map(), // id -> el
    pendingSent: [], // [{id,text}] optimistically-rendered sends, matched to echoes by id
    _sendSeq: 0,     // monotonic id for optimistic user bubbles (stamp the RIGHT one)
    profiles: [],
    activeProfileId: null,
    projects: [],
    activeProjectId: null,
    metroByProject: {}, // projectId -> latest metro_status (per-tab: tabs can be different apps)
    _awaitingMetro: null, // projectId we're waiting to open once Metro is ready
    capabilities: null,
    permissionMode: 'default',
    resolvedModel: null, // resolved id of the active model (e.g. claude-opus-4-8)
    models: [], // [{ alias, id, label }] resolved model list
    selectedModel: null, // alias currently active in the picker
    effort: 'high',
    attachments: [], // [{ mime, dataBase64, url, name }]
    checkpoints: [],
    reconnectTimer: null,
    activity: 'idle', // 'idle' | 'working' | 'waiting' — drives the live indicator
    activityLabel: 'Thinking…',
    sessions: [], // live sessions [{ key, busy, active, ... }]
    activeKey: null,
    tabs: [], // [{ id, kind:'session'|'file', key?, projectId?, filePath?, title, color, done }] persisted
    activeTabId: null, // the focused tab's id (a session key, or 'file:<path>') — decoupled from broker activeKey
    _prevBusy: {}, // key -> busy, to detect a background session finishing
    resources: null, // latest RESOURCES sample (device RAM + per-engine RSS) for the System tab
    recentSessionsByProject: {}, // projectId -> latest on-disk sessions (folder sheet)
    activeSessionId: null, // claude sessionId of the session being viewed (from CONFIG/sessions)
  };
  // exposed for managers.js (toast attached after its definition below)
  window.Agent = { send, state, esc, openFileTab, patchUserSettings: (p) => patchUserSettings(p) };

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
    copyText: (text) => NB().copyText(text),
  };

  // Copy text to the clipboard with a WebView-safe fallback chain:
  // navigator.clipboard (secure-context) -> native Android bridge -> execCommand.
  function copyToClipboard(text) {
    const ok = () => toast('Copied', 'info');
    const fallback = () => {
      if (native.has('copyText')) { try { native.copyText(text); return ok(); } catch { /* next */ } }
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        const done = document.execCommand('copy'); ta.remove();
        done ? ok() : toast('Copy not supported here', 'error');
      } catch { toast('Copy failed', 'error'); }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else {
      fallback();
    }
  }
  window.Agent.copy = copyToClipboard;

  // ---- bubble action menu (long-press / right-click) -----------------------

  function textOfBubble(msgEl) { const b = msgEl.querySelector('.bubble'); return b ? b.textContent : ''; }
  function rawOfBubble(msgEl, isUser) {
    const b = msgEl.querySelector('.bubble');
    if (isUser) return (msgEl.dataset.revertText != null ? msgEl.dataset.revertText : textOfBubble(msgEl));
    return (b && b.dataset.md) ? b.dataset.md : textOfBubble(msgEl); // assistant: raw markdown
  }
  function openBubbleMenu(msgEl, isUser) {
    closeBubbleMenu();
    const scrim = el('div', 'sheet-scrim');
    const sheet = el('div', 'action-sheet');
    const group = el('div', 'action-group');
    const copyBtn = el('button', 'action-item', 'Copy');
    copyBtn.onclick = () => { copyToClipboard(rawOfBubble(msgEl, isUser)); closeBubbleMenu(); };
    group.appendChild(copyBtn);
    const selBtn = el('button', 'action-item', 'Select text');
    selBtn.onclick = () => { closeBubbleMenu(); enableBubbleSelection(msgEl); };
    group.appendChild(selBtn);
    if (isUser && msgEl.dataset.turnId) {
      const rev = el('button', 'action-item danger', 'Revert to here');
      rev.onclick = () => { closeBubbleMenu(); revertFromBubble(msgEl); };
      group.appendChild(rev);
    }
    sheet.appendChild(group);
    const cancel = el('button', 'action-cancel', 'Cancel');
    cancel.onclick = closeBubbleMenu;
    sheet.appendChild(cancel);
    scrim.appendChild(sheet);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closeBubbleMenu(); });
    document.body.appendChild(scrim);
    state._bubbleMenu = scrim;
  }
  function closeBubbleMenu() { if (state._bubbleMenu) { state._bubbleMenu.remove(); state._bubbleMenu = null; } }

  // "Select text": flip the bubble into selectable mode and pre-select its contents
  // so the OS selection handles appear immediately — the user drags the handles to
  // narrow the selection, then copies with the native control. (Copy-all stays the
  // quick path; this is for grabbing a specific span.)
  function enableBubbleSelection(msgEl) {
    const b = msgEl.querySelector('.bubble');
    if (!b) return;
    document.querySelectorAll('.bubble.selecting').forEach((x) => x.classList.remove('selecting'));
    b.classList.add('selecting');
    try {
      const range = document.createRange();
      range.selectNodeContents(b);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* selection API unavailable — class alone still enables manual select */ }
    toast('Drag the handles to select, then copy', 'info');
  }

  function buildRevertWarning(restoresFiles) {
    const files = restoresFiles
      ? 'Your files will be restored to the snapshot from right before this message — edits the agent made after it (including new files it created) will be undone.'
      : 'This workspace has no checkpoints, so your files will NOT change — only the conversation is rewound.';
    return 'Revert to before this message?\n\n' + files +
      '\n\nThis message and everything after it are removed, and the agent starts a fresh session (it won’t remember this turn or anything after). The message text goes back in the box. This can’t be undone.';
  }
  function revertFromBubble(msgEl) {
    const turnId = msgEl.dataset.turnId;
    if (!turnId) { toast('This message can’t be reverted', 'error'); return; }
    if (state.activity !== 'idle') { toast('Let the agent finish, then revert', 'error'); return; }
    const checkpointId = msgEl.dataset.checkpointId || null;
    const text = msgEl.dataset.revertText || '';
    if (!confirm(buildRevertWarning(!!checkpointId))) return;
    send({ type: 'revert', turnId, checkpointId, text });
  }
  function onReverted(ev) {
    if (!ev.ok) { toast(ev.message || 'Revert failed', 'error'); return; }
    setActivity('idle');
    const input = $('input');
    if (ev.text) { input.value = ev.text; autoGrow(); input.focus(); }
    const parts = [];
    if (ev.removed) parts.push(`removed ${ev.removed} message${ev.removed === 1 ? '' : 's'}`);
    if (ev.restoredFiles != null) parts.push('files restored');
    toast('Reverted' + (parts.length ? ' · ' + parts.join(' · ') : ''), 'info');
  }
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
      state._reconnectAttempts = 0;
      hideDisconnectBanner();
      setConnected(true);
      // First connect: blank to a clean slate. Reconnect: DON'T eagerly blank
      // (that flickered the empty state) — the snapshot's reset:true transcript,
      // now always sent, rebuilds the conversation in place when it arrives.
      if (!state._everConnected) resetConversation();
      state._everConnected = true;
      send({ type: 'hello' });
    };
    state.ws.onclose = () => { setConnected(false); scheduleReconnect(); };
    state.ws.onerror = () => {};
  }

  // Reconnect with exponential backoff + jitter (was a flat 1.5s retry that hammered
  // the broker and the phone's wake-lock when it stayed down). After a few failures
  // surface a persistent banner with a manual Reconnect button.
  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    const n = (state._reconnectAttempts = (state._reconnectAttempts || 0) + 1);
    const delay = Math.min(1500 * Math.pow(2, n - 1), 30000) + Math.floor(Math.random() * 500);
    if (n >= 5) showDisconnectBanner();
    state.reconnectTimer = setTimeout(connect, delay);
  }
  function showDisconnectBanner() {
    if (document.getElementById('disconnBanner')) return;
    const el2 = el('div', 'disconn-banner');
    el2.id = 'disconnBanner';
    el2.innerHTML = '<span>⚠ Lost connection to the broker — retrying…</span>';
    const btn = el('button', 'accent small', 'Reconnect now');
    btn.onclick = () => { state._reconnectAttempts = 0; clearTimeout(state.reconnectTimer); connect(); };
    el2.appendChild(btn);
    document.body.appendChild(el2);
  }
  function hideDisconnectBanner() { const b = document.getElementById('disconnBanner'); if (b) b.remove(); }

  function setConnected(on) {
    state.connected = on;
    $('connDot').classList.toggle('online', on);
    const label = on ? 'Connected to broker' : 'Disconnected — reconnecting…';
    $('connDot').title = label;
    $('connDot').setAttribute('aria-label', label); // announced via aria-live
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
    if (ev && ev.ts) state._lastEventTs = ev.ts; // newest server timestamp, for message stamps
    switch (ev.type) {
      case 'session_meta': onSessionMeta(ev); break;
      case 'capabilities': onCapabilities(ev); break;
      case 'status': setStatus(ev.state, ev.detail); break;
      case 'assistant_text': appendAssistant(ev.delta, ev.parentToolUseId); break;
      case 'assistant_thinking': appendThinking(ev.delta, ev.parentToolUseId); break;
      case 'user_echo': onUserEcho(ev); break;
      case 'reverted': onReverted(ev); break;
      case 'tool_call': onToolCall(ev); break;
      case 'tool_delta': onToolDelta(ev); break;
      case 'tool_result': onToolResult(ev); break;
      case 'permission_request': onPermissionRequest(ev); break;
      case 'permission_resolved': onPermissionResolved(ev); break;
      case 'question_request': onQuestionRequest(ev); break;
      case 'question_resolved': onQuestionResolved(ev); break;
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
      case 'control_status':
        appendTerminalMeta(`[${ev.channel}] ${ev.state}${ev.detail ? ': ' + ev.detail : ''}`);
        if (ev.channel === 'run') onRunStatus(ev.state);
        break;
      case 'claude_auth': if (ev.signedIn) { const b = $('banner'); if (b) b.remove(); } break;
      case 'backup_status': if (window.Managers) window.Managers.onBackupStatus(ev); break;
      case 'metro_status': onMetro(ev); break;
      case 'apks': onApks(ev); break;
      case 'resources': state.resources = ev; if (window.Managers) window.Managers.onResources(ev); break;
      case 'git_status': onGitStatus(ev); break;
      case 'projects': onProjects(ev); break;
      case 'profiles': onProfiles(ev); break;
      case 'engine_state': onEngineState(ev); break;
      case 'sessions': onSessions(ev); break;
      case 'config':
        if (window.Managers) window.Managers.onConfig(ev);
        if (ev.kind === 'sessions' && Array.isArray(ev.items)) onSessionList(ev);
        break;
      case 'transcript': applyTranscript(ev); break;
      case 'checkpoints': if (window.Managers) window.Managers.onCheckpoints(ev); onCheckpoints(ev); break;
      case 'checkpoint_restored': onCheckpointRestored(ev); break;
      case 'native_change': onNativeChange(ev); break;
      case 'files': if (window.Managers) window.Managers.onFiles(ev); break;
      case 'file': if (window.Managers) window.Managers.onFile(ev); break;
      case 'fs_list': if (window.Managers) window.Managers.onFsList(ev); break;
      case 'file_search': onFileSearch(ev); break;
      case 'file_diff': if (window.Managers) window.Managers.onFileDiff(ev); break;
      case 'file_grep': if (window.Managers) window.Managers.onFileGrep(ev); break;
      case 'prompts': if (window.Managers) window.Managers.onPrompts(ev); break;
      case 'cron_jobs': if (window.Managers) window.Managers.onCronJobs(ev); break;
      case 'scripts': if (window.Managers) window.Managers.onScripts(ev); break;
      case 'github': onGithub(ev); break;
      case 'autoverify': onAutoVerify(ev); break;
      case 'usage_stats': if (window.Managers) window.Managers.onUsageStats(ev); break;
      case 'checkpoints_diff': if (window.Managers) window.Managers.onCheckpointDiff(ev); break;
      case 'file_replace': onFileReplace(ev); break;
      case 'transcript_search': break; // handled where requested
      case 'turn_changes': onTurnChanges(ev); break;
      case 'workspace_browse': if (window.Managers) window.Managers.onWorkspaceBrowse(ev); break;
      case 'log': onLog(ev); break;
      case 'file_widget': onFileWidget(ev); break;
      case 'toast':
        if (ev.message) {
          toast(ev.message, ev.level || 'info');
          // notify=true → also fire a real OS notification (native always posts; web
          // only when backgrounded). Used for cron-job completion.
          if (ev.notify) notifyIfHidden(ev.title || 'On-Device Agent', ev.message);
        }
        break;
      case 'user_settings': onUserSettings(ev); break;
      case 'app_version': if (window.Managers) window.Managers.onAppVersion(ev); break;
      case 'app_update': onAppUpdate(ev); if (window.Managers) window.Managers.onAppUpdate(ev); break;
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

  function onSessions(ev) {
    const prev = state._prevBusy || {};
    state.sessions = ev.items || [];
    if (ev.activeKey) state.activeKey = ev.activeKey;
    // The focused session is never "dismissed" — re-surface it if it was.
    undismissSession(state.activeKey);
    // Only (re)surface tabs the user actually has open — refresh the project/title on
    // existing tabs and always keep one for the ACTIVE session. Do NOT auto-open a tab
    // for every session the broker remembers (live + sleeping): that flooded the strip
    // with background sessions the user never opened on reconnect. Other sessions live
    // in the folder sheet (tap to open one), not forced into the tab strip.
    for (const s of state.sessions) {
      const open = state.tabs.some((t) => t.kind !== 'file' && t.key === s.key);
      if (s.key === state.activeKey || open) ensureTab({ key: s.key, projectId: s.projectId, title: s.title });
    }
    const act = state.sessions.find((s) => s.key === state.activeKey);
    if (!act && state.activeKey) ensureTab({ key: state.activeKey, projectId: state.activeProjectId });
    // Keep the focused tab synced to the broker's active session — unless the user is
    // currently on a FILE tab (a client-only view; don't yank them back to chat).
    // Clear an in-flight switch once the broker confirms it as active.
    if (state._pendingActiveKey && state.activeKey === state._pendingActiveKey) state._pendingActiveKey = null;
    const curTab = state.activeTabId ? tabById(state.activeTabId) : null;
    // Don't override the focused tab while a user-initiated switch is still in
    // flight (its ACK hasn't arrived) — that caused a visible wrong-tab flash.
    if ((!curTab || curTab.kind !== 'file') && !state._pendingActiveKey) { state.activeTabId = state.activeKey; applyViewMode(); }
    // "Done" nudge: a background session that finished a turn (busy -> idle) while
    // unfocused. (working/waiting indicators are derived live in renderTabs.)
    const nowBusy = {};
    for (const s of state.sessions) {
      nowBusy[s.key] = s.busy;
      const t = state.tabs.find((x) => x.key === s.key);
      if (!t || s.key === state.activeKey) continue;
      if (prev[s.key] && !s.busy && s.lastStatus !== 'waiting') t.done = true;
    }
    state._prevBusy = nowBusy;
    const at = state.tabs.find((x) => x.key === state.activeKey);
    if (at) at.done = false; // focusing a tab clears its "done" nudge
    // Keep the global activity cue in sync with the ACTIVE session — a background
    // session's stream (incl. its RESULT) is suppressed, so switching tabs must
    // reconcile here or the indicator gets stuck "thinking".
    if (act) {
      const idleOk = Date.now() > (state._optimisticUntil || 0) && !awaitingActive();
      // Nav status pill = the ACTIVE session's engine status. Background statuses are
      // suppressed, so without this it stays stuck (e.g. "thinking") after a switch.
      const ps = act.busy ? (act.lastStatus || 'thinking') : (idleOk ? 'idle' : null);
      if (ps) { const pill = $('statusPill'); if (pill) { pill.className = 'status-pill ' + ps; pill.textContent = ps; } }
      const want = act.busy ? (act.lastStatus === 'waiting' ? 'waiting' : 'working') : 'idle';
      if (want !== state.activity && (want !== 'idle' || idleOk)) setActivity(want);
    }
    renderTabs();
    updateFolderPill();
    if (folderSheetOpen()) renderFolderSheet();
    updateSessionsBadge();
    if (window.Managers) window.Managers.onSessions(ev);
  }

  // ---- session tabs ---------------------------------------------------------
  const TAB_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#D4537E', '#BA7517', '#639922', '#5DCAA5'];
  function tabColorFor(projectId) {
    const s = String(projectId || 'main');
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return TAB_COLORS[h % TAB_COLORS.length];
  }
  function projectName(projectId) {
    const p = state.projects.find((x) => x.id === projectId);
    return p ? p.name : null;
  }
  function tabTitleFor(key, projectId, title) {
    if (title) return title;
    // renderTabs numbers tabs per folder ("demo", "demo 2") independent of the key,
    // so just return the folder base here (the opaque key suffix isn't user-facing).
    return projectName(projectId) || (projectId ? String(projectId) : 'Session');
  }
  // Sessions the user explicitly closed (✕). Persisted so a reload doesn't re-add
  // their tabs from the SESSIONS list. They stay on disk (resumable via Sessions).
  function dismissedSet() { if (!state.dismissed) { try { state.dismissed = new Set(JSON.parse(localStorage.getItem('agentDismissed') || '[]')); } catch { state.dismissed = new Set(); } } return state.dismissed; }
  function saveDismissed() { try { localStorage.setItem('agentDismissed', JSON.stringify([...dismissedSet()])); } catch { /* ignore */ } }
  function isDismissed(key) { return dismissedSet().has(key); }
  function dismissSession(key) { dismissedSet().add(key); saveDismissed(); }
  function undismissSession(key) { if (dismissedSet().delete(key)) saveDismissed(); }
  function loadTabs() { try { return JSON.parse(localStorage.getItem('agentTabs') || '[]'); } catch { return []; } }
  function serializeTabs() {
    return state.tabs.map((t) => t.kind === 'file'
      ? { kind: 'file', id: t.id, filePath: t.filePath, fileKind: t.fileKind, abs: !!t.abs, title: t.userTitle || null, userColor: t.userColor || null }
      : { kind: 'session', key: t.key, projectId: t.projectId, title: t.userTitle || null, userColor: t.userColor || null });
  }
  function saveTabs() {
    const tabs = serializeTabs();
    // localStorage is the instant local cache; userSettings is the durable device
    // store (survives a localStorage clear and loads with the app).
    try { localStorage.setItem('agentTabs', JSON.stringify(tabs)); } catch { /* ignore */ }
    patchUserSettings({ workspace: { tabs, activeTabId: state.activeTabId || null } });
  }
  // Deep-merge a partial into the persisted user settings (broker = source of truth).
  function patchUserSettings(partial) {
    if (!partial) return;
    state.userSettings = deepMergeSettings(state.userSettings || {}, partial);
    send({ type: 'user_settings_patch', patch: partial });
  }
  function deepMergeSettings(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      out[k] = (pv && typeof pv === 'object' && !Array.isArray(pv)) ? deepMergeSettings(out[k], pv) : pv;
    }
    return out;
  }
  // The broker's persisted user settings arrived (in the connect snapshot). Engine
  // prefs (model/effort/permission) are already re-applied broker-side and flow
  // through their own events; here we adopt the durable workspace/manage state.
  function onUserSettings(ev) {
    const s = (ev && ev.settings) || {};
    state.userSettings = s;
    // Hand the Manage screen its persisted MRU tab order.
    if (window.Managers && window.Managers.onUserSettings) window.Managers.onUserSettings(s);
    // Migration / recovery: if this client has no local tabs (fresh device or a
    // cleared localStorage) but the durable store has some, hydrate from it.
    try {
      const local = JSON.parse(localStorage.getItem('agentTabs') || '[]');
      const durable = (s.workspace && Array.isArray(s.workspace.tabs)) ? s.workspace.tabs : [];
      if ((!local || !local.length) && durable.length && !state._tabsHydrated) {
        localStorage.setItem('agentTabs', JSON.stringify(durable));
        state._tabsHydrated = true;
        if (!state.tabs.length) restoreTabs();
      }
    } catch { /* ignore */ }
  }

  function ensureTab({ key, projectId, title }) {
    let t = state.tabs.find((x) => x.kind !== 'file' && x.key === key);
    if (!t) {
      t = { id: key, key, kind: 'session', projectId: projectId ?? null, userTitle: title || null, title: '', color: tabColorFor(projectId), done: false, attn: false };
      state.tabs.push(t);
    } else if (projectId != null && t.projectId == null) {
      t.projectId = projectId; t.color = tabColorFor(projectId);
    }
    if (title) t.userTitle = title;
    t.title = tabTitleFor(t.key, t.projectId, t.userTitle);
    saveTabs();
    return t;
  }
  function tabById(id) { return state.tabs.find((t) => t.id === id) || state.tabs.find((t) => t.key === id); }
  function switchTab(id) {
    const t = tabById(id); if (!t) return;
    t.done = false;
    state.activeTabId = t.id;
    if (t.kind === 'file') { applyViewMode(); renderFileView(t); renderTabs(); return; } // client-only, no broker switch
    state._optimisticUntil = 0; // show the destination tab's real state immediately
    clearAwaiting(); // a pending "waking" latch belongs to the tab we just left
    applyViewMode();
    // Reflect the destination tab's folder in the composer IMMEDIATELY from the tab
    // itself — don't wait on the broker's PROJECTS broadcast (ordering/edge cases left
    // the pill showing the previous tab's folder). The broker confirms/corrects it.
    if (t.projectId && t.projectId !== state.activeProjectId) {
      state.activeProjectId = t.projectId;
      updateFolderPill();
      renderMetro();
    }
    if (t.key !== state.activeKey) {
      // Mark the switch in-flight: until the broker's SESSIONS reports this key as
      // active, onSessions must not yank activeTabId back to the old session (which
      // flashed the wrong tab).
      state._pendingActiveKey = t.key;
      send({ type: 'switch_session', key: t.key });
    } else renderTabs();
  }
  function closeTab(id) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const t = state.tabs[idx];
    state.tabs.splice(idx, 1);
    saveTabs();
    if (t.kind !== 'file') {
      dismissSession(t.key); // user explicitly removed it — don't let SESSIONS re-add the tab
      send({ type: 'session_stop', key: t.key }); // free the process; transcript kept (resumable via Sessions)
    }
    if (t.id === state.activeTabId) {
      if (state.tabs.length) switchTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
      else { state.activeTabId = null; applyViewMode(); send({ type: 'new_session' }); }
    } else { renderTabs(); applyViewMode(); }
  }
  function renderTabs() {
    const host = $('tabs'); if (!host) return;
    // A background `sessions` heartbeat must not nuke-and-rebuild the strip while the
    // user is mid drag/long-press — it would detach the element the gesture holds and
    // leave the gesture (and pointer capture) stuck. Defer the re-render until the
    // gesture ends.
    if (_tabGesture && (_tabGesture.mode === 'drag' || _tabGesture.mode === 'pending')) { state._tabsDirty = true; return; }
    // Title session tabs by their folder, numbered sequentially PER FOLDER ("demo",
    // "demo 2", "demo 3") — independent of the internal key suffix, so closing/reopening
    // never shows a weird climbing counter. File tabs keep their own (file)name.
    const seen = {};
    for (const t of state.tabs) {
      if (t.kind === 'file') continue;
      const k = t.projectId || 'main'; seen[k] = (seen[k] || 0) + 1;
      const base = projectName(t.projectId) || (t.projectId ? String(t.projectId) : 'Session');
      t.title = t.userTitle || (seen[k] > 1 ? `${base} ${seen[k]}` : base); // first = "demo", rest = "demo 2"…
    }
    host.innerHTML = '';
    for (const t of state.tabs) {
      const isActive = t.id === state.activeTabId;
      const tab = el('div', 'tab' + (isActive ? ' active' : '') + (t.kind === 'file' ? ' file-tab' : ''));
      tab.title = t.title;
      const ind = document.createElement('span');
      if (t.kind === 'file') { ind.className = 'tab-ico'; ind.textContent = KIND_ICON[t.fileKind] || '📄'; }
      else {
        const live = state.sessions.find((s) => s.key === t.key);
        const waiting = live && live.lastStatus === 'waiting';
        const working = live && live.busy && !waiting;
        // Sleeping = the broker reports it dormant, or it's not in the live set at all
        // (idle-evicted / pre-reconnect). Dimmed 💤 — tapping it cold-resumes.
        const sleeping = (live && live.sleeping) || (!live && t.key !== state.activeKey);
        if (waiting) { ind.className = 'tab-attn'; ind.textContent = '!'; } // needs you (approval) — over the spinner
        else if (working) ind.className = 'tab-spin';
        else if (t.done) { ind.className = 'tab-done'; ind.textContent = '✓'; }
        else if (sleeping) { ind.className = 'tab-sleep'; ind.textContent = '💤'; }
        else { ind.className = 'tab-dot'; ind.style.background = t.color; }
        tab.classList.toggle('sleeping', !!sleeping && !isActive);
      }
      const title = el('span', 'tab-title', t.title);
      const close = aria(el('button', 'tab-close', '✕'), 'Close tab');
      close.title = 'Close tab';
      tab.appendChild(ind); tab.appendChild(title); tab.appendChild(close);
      tab.onclick = (e) => {
        if (e.target === close || (e.target.closest && e.target.closest('.tab-close'))) return;
        if (tab._suppress) { tab._suppress = false; return; } // a long-press/drag just happened
        switchTab(t.id);
      };
      close.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
      wireTabGesture(tab, t); // long-press menu + drag-to-reorder
      host.appendChild(tab);
    }
    // Bring the active tab into view when it changes, so it (and its ✕) is reachable.
    if (state.activeTabId !== state._lastTabScroll) {
      state._lastTabScroll = state.activeTabId;
      const a = host.querySelector('.tab.active');
      if (a && a.scrollIntoView) a.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }
  function restoreTabs() {
    state.tabs = loadTabs().map((t) => t.kind === 'file'
      ? { id: t.id || ((t.abs ? 'fsfile:' : 'file:') + t.filePath), kind: 'file', abs: !!t.abs, filePath: t.filePath, fileKind: t.fileKind || fileKind(t.filePath),
          userTitle: t.title || null, title: t.title || String(t.filePath).split(/[\\/]/).pop(), userColor: t.userColor || null, color: t.userColor || '#8a8a8a' }
      : { id: t.key, key: t.key, kind: 'session', projectId: t.projectId ?? null, userTitle: t.title || null,
          title: '', userColor: t.userColor || null, color: t.userColor || tabColorFor(t.projectId), done: false });
    renderTabs();
    applyViewMode();
  }

  // ---- file tabs (Phase 3): open a project file as a tab, view + edit + save -
  function openFileTab(filePath, kind, opts) {
    hideEmpty();
    const abs = !!(opts && opts.abs); // File Manager: address by absolute path via /fsraw
    const id = (abs ? 'fsfile:' : 'file:') + (abs ? filePath : projectRelPath(filePath));
    const fname = String(filePath).split(/[\\/]/).pop();
    let t = state.tabs.find((x) => x.id === id);
    if (!t) {
      t = { id, kind: 'file', abs, filePath, fileKind: kind || fileKind(filePath), userTitle: null, title: fname, color: '#8a8a8a' };
      state.tabs.push(t); saveTabs();
    }
    t._content = null; t._dirty = false; // reload fresh each open
    state.activeTabId = id;
    applyViewMode();
    renderFileView(t);
    renderTabs();
  }
  function applyViewMode() {
    const t = state.activeTabId ? tabById(state.activeTabId) : null;
    const fileMode = !!(t && t.kind === 'file');
    const tr = $('transcript'), comp = document.querySelector('.composer'), fv = $('fileView');
    if (tr) tr.style.display = fileMode ? 'none' : '';
    if (comp) comp.style.display = fileMode ? 'none' : '';
    if (fv) fv.classList.toggle('hidden', !fileMode);
  }
  function renderFileView(t) {
    if (!t || t.kind !== 'file') return;
    const fk = t.fileKind;
    const canRender = fk === 'html' || fk === 'svg' || fk === 'image' || fk === 'markdown';
    const canSource = fk !== 'image';
    if (!t._mode) t._mode = canRender ? 'rendered' : 'source';
    if (!canRender) t._mode = 'source';
    if (!canSource) t._mode = 'rendered';
    $('fvName').textContent = t.title;
    $('fvRendered').classList.toggle('hidden', !canRender);
    $('fvSource').classList.toggle('hidden', !canSource);
    $('fvRendered').classList.toggle('active', t._mode === 'rendered');
    $('fvSource').classList.toggle('active', t._mode === 'source');
    $('fvSave').classList.toggle('hidden', t._mode !== 'source');
    $('fvSave').classList.toggle('dirty', !!t._dirty);
    const body = $('fvBody'); body.className = 'fv-body'; body.innerHTML = '';
    const url = t.abs ? fsRawUrl(t.filePath) : htmlAppUrl(t.filePath);
    if (t._mode === 'rendered') {
      if (fk === 'html') {
        const f = document.createElement('iframe'); f.className = 'fv-iframe';
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox');
        f.src = _bust(url); body.appendChild(f);
      } else if (fk === 'svg' || fk === 'image') {
        const wrap = el('div', 'fv-rendered media'); const img = document.createElement('img');
        img.className = 'fv-img'; img.alt = t.title; img.src = _bust(url); wrap.appendChild(img); body.appendChild(wrap);
      } else if (fk === 'markdown') {
        const wrap = el('div', 'fv-rendered fv-md'); wrap.innerHTML = '<div class="fv-empty">Loading…</div>'; body.appendChild(wrap);
        fetch(_bust(url), { cache: 'no-store' }).then((r) => r.text()).then((txt) => {
          wrap.innerHTML = '<div class="bubble md">' + ((window.MD && window.MD.render) ? window.MD.render(txt) : esc(txt)) + '</div>';
        }).catch(() => { wrap.innerHTML = '<div class="fv-empty">Could not load.</div>'; });
      }
    } else {
      const ta = document.createElement('textarea'); ta.className = 'fv-source'; ta.spellcheck = false;
      if (t._content != null) { ta.value = t._content; } else { ta.value = ''; ta.placeholder = 'Loading…'; ta.disabled = true; }
      body.appendChild(ta);
      if (t._content == null) {
        fetch(_bust(url), { cache: 'no-store' }).then((r) => r.text()).then((txt) => {
          t._content = txt; ta.value = txt; ta.disabled = false;
        }).catch(() => { ta.value = '(could not load file)'; ta.disabled = false; });
      }
      ta.oninput = () => { t._content = ta.value; t._dirty = true; $('fvSave').classList.add('dirty'); };
    }
  }
  function saveFileTab(t) {
    if (!t || t.kind !== 'file' || t._content == null) return;
    if (t.abs) send({ type: 'fs_write', path: t.filePath, content: t._content });
    else send({ type: 'files_write', path: projectRelPath(t.filePath), content: t._content });
    t._dirty = false; $('fvSave').classList.remove('dirty');
    toast('Saved ' + t.title, 'info');
  }
  function activeFileTab() { const t = state.activeTabId ? tabById(state.activeTabId) : null; return t && t.kind === 'file' ? t : null; }

  // ---- Phase 4: long-press menu + customize (color/rename) + drag-reorder ----
  let _tabGesture = null;
  function wireTabGesture(tabEl, tab) {
    // Tabs are touch-action:none, so this gesture owns the whole touch and routes
    // it to one of: tap (switch) · pre-hold slide (scroll the strip) · long-press
    // (menu) · post-hold slide (drag-reorder). Pointer capture keeps moves flowing
    // to this tab even when the finger leaves it.
    tabEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('.tab-close')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      closeTabMenu();
      tabEl._suppress = false; // a fresh press always taps clean — clear any stale suppress
      // (e.g. a long-press whose trailing click never fired on touch would otherwise eat it)
      try { tabEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const g = (_tabGesture = { tab, tabEl, sx: e.clientX, lastX: e.clientX, pid: e.pointerId, mode: 'pending', timer: null });
      g.timer = setTimeout(() => {
        if (_tabGesture === g && g.mode === 'pending') { g.mode = 'menu'; tabEl._suppress = true; showTabMenu(tab, tabEl); }
      }, 450);
    });
    tabEl.addEventListener('pointermove', (e) => {
      const g = _tabGesture; if (!g || g.tabEl !== tabEl) return;
      const dx = e.clientX - g.lastX; g.lastX = e.clientX;
      if (g.mode === 'drag') return updateDrag(g, e.clientX);
      if (g.mode === 'scroll') { const host = $('tabs'); if (host) host.scrollLeft -= dx; return; }
      if (Math.abs(e.clientX - g.sx) > 8) {
        clearTimeout(g.timer);
        tabEl._suppress = true; // a slide is never a tap-to-switch
        if (g.mode === 'menu') { closeTabMenu(); g.mode = 'drag'; startDrag(g); }
        else { g.mode = 'scroll'; const host = $('tabs'); if (host) host.scrollLeft -= dx; } // slide before the hold = scroll the strip
      }
    });
    const finish = () => {
      const g = _tabGesture; if (!g || g.tabEl !== tabEl) return;
      clearTimeout(g.timer);
      try { tabEl.releasePointerCapture(g.pid); } catch { /* ignore */ }
      if (g.mode === 'drag') endDrag(g);
      if (g.mode !== 'menu') _tabGesture = null; // keep ref while the menu is open
      // Apply any session update that arrived (and was deferred) during the gesture.
      if (!_tabGesture && state._tabsDirty) { state._tabsDirty = false; renderTabs(); }
    };
    tabEl.addEventListener('pointerup', finish);
    tabEl.addEventListener('pointercancel', finish);
  }
  function startDrag(g) {
    g.tabEl.classList.add('dragging'); g.fromIdx = state.tabs.indexOf(g.tab);
    try { g.tabEl.setPointerCapture(g.pid); } catch { /* ignore */ }
  }
  function updateDrag(g, x) {
    g.tabEl.style.transform = `translateX(${Math.round(x - g.sx)}px)`;
    let idx = state.tabs.length;
    const kids = [...$('tabs').children];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === g.tabEl) continue;
      const r = kids[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) { idx = i; break; }
    }
    g.toIdx = idx;
  }
  function endDrag(g) {
    g.tabEl.style.transform = ''; g.tabEl.classList.remove('dragging');
    const cur = state.tabs.indexOf(g.tab);
    if (g.toIdx != null && cur >= 0) {
      let to = g.toIdx > cur ? g.toIdx - 1 : g.toIdx;
      if (to !== cur && to >= 0) { const [m] = state.tabs.splice(cur, 1); state.tabs.splice(to, 0, m); saveTabs(); }
    }
    _tabGesture = null;
    renderTabs();
  }
  function closeTabMenu() { const m = document.getElementById('tabMenu'); if (m) m.remove(); document.removeEventListener('pointerdown', _menuOutside, true); }
  function _menuOutside(e) { const m = document.getElementById('tabMenu'); if (m && !m.contains(e.target)) closeTabMenu(); }
  function renameTabInline(tab, value) {
    tab.userTitle = (value || '').trim() || null;
    if (tab.kind === 'file') tab.title = tab.userTitle || String(tab.filePath).split(/[\\/]/).pop();
    saveTabs(); renderTabs();
  }
  // Close a set of tabs at once (bulk actions), reconciling the active tab once.
  function closeTabs(toClose) {
    if (!toClose.length) return;
    const set = new Set(toClose);
    const closingActive = toClose.some((t) => t.id === state.activeTabId);
    for (const t of toClose) if (t.kind !== 'file') send({ type: 'session_stop', key: t.key });
    state.tabs = state.tabs.filter((t) => !set.has(t));
    saveTabs();
    if (closingActive) {
      if (state.tabs.length) switchTab(state.tabs[state.tabs.length - 1].id);
      else { state.activeTabId = null; applyViewMode(); send({ type: 'new_session' }); }
    } else { renderTabs(); applyViewMode(); }
  }
  function showTabMenu(tab, tabEl) {
    closeTabMenu();
    const menu = el('div', 'tab-menu'); menu.id = 'tabMenu';
    const idx = state.tabs.indexOf(tab);
    const ren = document.createElement('input');
    ren.className = 'tab-menu-rename'; ren.value = tab.userTitle || tab.title; ren.placeholder = 'Tab name'; ren.spellcheck = false;
    ren.onkeydown = (e) => { if (e.key === 'Enter') { renameTabInline(tab, ren.value); closeTabMenu(); } };
    menu.appendChild(ren);
    const colors = el('div', 'tab-menu-colors');
    for (const c of TAB_COLORS) {
      const sw = el('button', 'tab-swatch' + (tab.color === c ? ' on' : '')); sw.style.background = c;
      sw.onclick = () => { tab.userColor = c; tab.color = c; saveTabs(); renderTabs(); [...colors.children].forEach((x) => x.classList.remove('on')); sw.classList.add('on'); };
      colors.appendChild(sw);
    }
    menu.appendChild(colors);
    menu.appendChild(el('div', 'tab-menu-sep'));
    const item = (label, fn, cls) => { const b = el('button', 'tab-menu-item' + (cls ? ' ' + cls : ''), label); b.onclick = () => { closeTabMenu(); fn(); }; menu.appendChild(b); };
    item('Close', () => closeTab(tab.id));
    if (state.tabs.length > 1) {
      item('Close others', () => closeTabs(state.tabs.filter((t) => t !== tab)));
      if (idx > 0) item('Close to the left', () => closeTabs(state.tabs.slice(0, idx)));
      if (idx < state.tabs.length - 1) item('Close to the right', () => closeTabs(state.tabs.slice(idx + 1)));
      item('Close all', () => closeTabs([...state.tabs]), 'tmenu-danger');
    }
    document.body.appendChild(menu);
    const r = tabEl.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (r.bottom + 5) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', _menuOutside, true), 0);
  }

  // ---- folder switcher sheet (folder pill tap · + long-press) ---------------
  function updateFolderPill() {
    const name = projectName(state.activeProjectId) || state.activeProjectId || 'folder';
    const e = $('folderPillName'); if (e) e.textContent = name;
  }
  function openFolderSheet() { send({ type: 'list_sessions', scope: 'all' }); renderFolderSheet(); $('folderSheet').classList.remove('hidden'); }
  function closeFolderSheet() { const s = $('folderSheet'); if (s) s.classList.add('hidden'); }
  function folderSheetOpen() { const s = $('folderSheet'); return s && !s.classList.contains('hidden'); }
  // On-disk session list (list_sessions scope:all) → latest 3 per folder for the sheet.
  function onSessionList(ev) {
    if (ev.scope !== 'all') return; // only the comprehensive list feeds the folder sheet (a per-project list would drop the rest)
    state.activeSessionId = ev.activeSessionId || null;
    state._sessionListLoaded = true;
    const by = {};
    for (const s of ev.items) { const pid = s.projectId || '_unknown'; (by[pid] = by[pid] || []).push(s); }
    for (const pid in by) by[pid] = by[pid].sort((a, b) => ((b.lastTs || b.mtime) || 0) - ((a.lastTs || a.mtime) || 0)).slice(0, 3);
    state.recentSessionsByProject = by;
    if (folderSheetOpen()) renderFolderSheet();
  }
  function relTime(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function renderFolderSheet() {
    const body = $('folderSheetBody'); if (!body) return;
    body.innerHTML = '';
    const keyBySid = new Map(); // claude sessionId -> live session key (is it running now?)
    for (const s of state.sessions) if (s.sessionId) keyBySid.set(s.sessionId, s.key);
    // One recent-session row: live → switch to its tab, historical → resume from disk.
    const sessionRow = (s, projectId) => {
      const liveKey = keyBySid.get(s.id);
      const live = liveKey ? state.sessions.find((x) => x.key === liveKey) : null;
      const openAsTab = !!liveKey; // this session has a tab in the strip (live or sleeping)
      const row = el('div', 'fs-session' + (s.id === state.activeSessionId ? ' active' : ''));
      const dot = el('span', 'fs-session-dot' + (live && live.busy ? ' busy' : ''));
      // A session open as a tab gets its folder's color (busy keeps its orange pulse).
      if (openAsTab && projectId && !(live && live.busy)) dot.style.background = tabColorFor(projectId);
      row.appendChild(dot);
      const info = el('div', 'fs-session-info');
      info.appendChild(el('span', 'fs-session-name', s.summary || s.id.slice(0, 8)));
      // Time of the latest MESSAGE in the session (parsed from the session log's last
      // real user/assistant entry — `lastTs`). NOT the file mtime (claude --resume
      // rewrites the file on open) and NOT lastTurnTs (bumped on any status change),
      // both of which made a just-opened session read "just now".
      const ts = s.lastTs || s.mtime || (live && live.lastTurnTs) || null;
      info.appendChild(el('span', 'fs-session-meta', relTime(ts) + (live ? ' · live' : '')));
      row.appendChild(info);
      row.onclick = () => {
        if (liveKey) { ensureTab({ key: liveKey, projectId }); switchTab(liveKey); }
        else send({ type: 'resume', sessionId: s.id, projectId: s.projectId || undefined, projectDir: s.projectDir });
        closeFolderSheet();
      };
      return row;
    };
    // Folders ordered most-recently-touched first, by the latest activity across their
    // sessions (live "last turn" time, else newest transcript mtime).
    const folderRecency = (pid) => {
      // Newest message across the folder's sessions (last-message time), so a folder
      // doesn't jump to the top merely because you opened one of its sessions.
      const recents = state.recentSessionsByProject[pid] || [];
      return (recents[0] && (recents[0].lastTs || recents[0].mtime)) || 0;
    };
    const sortedProjects = state.projects.filter((x) => x.id).slice()
      .sort((a, b) => folderRecency(b.id) - folderRecency(a.id));
    for (const p of sortedProjects) {
      const folder = el('div', 'fs-folder');
      const head = el('div', 'fs-folder-head' + (p.id === state.activeProjectId ? ' current' : ''));
      const dot = el('span', 'fs-dot'); dot.style.background = tabColorFor(p.id);
      head.appendChild(dot);
      head.appendChild(el('span', 'fs-folder-name', p.name + (p.isExpo ? ' ⚛' : '')));
      // "+ New" lives on the folder header itself (saves a whole row per folder).
      const nw = el('button', 'fs-new-inline', '+ New');
      nw.title = 'New chat in this folder';
      nw.onclick = (e) => { e.stopPropagation(); send({ type: 'open_project', projectId: p.id }); setTimeout(() => send({ type: 'new_session' }), 80); closeFolderSheet(); };
      head.appendChild(nw);
      head.onclick = () => { send({ type: 'open_project', projectId: p.id }); closeFolderSheet(); };
      folder.appendChild(head);
      // The 3 most-recent sessions of this folder (from disk), live ones flagged.
      const recents = state.recentSessionsByProject[p.id] || [];
      for (const s of recents) folder.appendChild(sessionRow(s, p.id));
      if (!recents.length) folder.appendChild(el('div', 'fs-session fs-empty', state._sessionListLoaded ? 'No sessions yet' : 'Loading…'));
      const all = el('div', 'fs-session fs-viewall', '↗ View all sessions');
      all.onclick = () => { closeFolderSheet(); if (window.Managers) window.Managers.openTab('sessions'); };
      folder.appendChild(all);
      body.appendChild(folder);
    }
    // Sessions whose folder couldn't be resolved (ambiguous on-disk encoding) — still reachable.
    const orphans = state.recentSessionsByProject['_unknown'] || [];
    if (orphans.length) {
      const folder = el('div', 'fs-folder');
      const head = el('div', 'fs-folder-head');
      head.appendChild(el('span', 'fs-dot')); head.appendChild(el('span', 'fs-folder-name', 'Folder unknown'));
      folder.appendChild(head);
      for (const s of orphans) folder.appendChild(sessionRow(s, null));
      body.appendChild(folder);
    }
    if (!state.projects.filter((x) => x.id).length) body.appendChild(el('p', 'mgr-hint', 'No folders open yet.'));
    const open = el('button', 'fs-open', '📂 Open another folder…');
    open.onclick = () => { closeFolderSheet(); if (window.Managers) window.Managers.openTab('projects'); };
    body.appendChild(open);
  }
  // Pointer-based long-press (unified touch + mouse); a move past threshold cancels it.
  function onLongPress(elm, onLong, onTap) {
    let timer = null, moved = false, sx = 0, sy = 0;
    elm.addEventListener('pointerdown', (e) => {
      moved = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { timer = null; onLong(); }, 500);
    });
    elm.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) { moved = true; clearTimeout(timer); timer = null; }
    });
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    elm.addEventListener('pointerup', () => { if (timer) { clearTimeout(timer); timer = null; if (!moved && onTap) onTap(); } });
    elm.addEventListener('pointercancel', cancel);
    elm.addEventListener('pointerleave', cancel);
  }
  // Show a "background sessions working" indicator in the nav when another session
  // (not the one you're viewing) has a turn in progress.
  function updateSessionsBadge() {
    const badge = $('bgSessions');
    if (!badge) return;
    const busyBg = state.sessions.filter((s) => s.busy && !s.active).length;
    badge.classList.toggle('hidden', busyBg === 0);
    const c = badge.querySelector('.bg-count'); if (c) c.textContent = String(busyBg);
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
    state.activity = 'idle';
    $('transcript').innerHTML = '';
    $('transcript').appendChild(buildEmptyState());
    finalizeAssistant();
    clearTodos();
    state.toolCards.clear();
    state.approvals.clear();
    if (typeof fileWidgets !== 'undefined') fileWidgets.clear();
    if (typeof apkWidgets !== 'undefined') apkWidgets.clear();
    state.pendingSent = [];
    applyActivity();
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
    clearAwaiting();
    hideEmpty();
    const host = nestedContainerFor(parentId);
    if (host) { // subagent narration → muted line in parent card
      let line = host.querySelector('.nested-text:last-child');
      if (!line || line.dataset.done) {
        line = el('div', 'nested-text');
        line._md = '';
        host.appendChild(line);
      }
      line._md += delta;
      scheduleMd(line);
      return;
    }
    if (!state.activeAssistant) {
      closeThinking(); // a reply run ends the open thinking run (keeps think/text in order)
      const msg = el('div', 'msg assistant');
      msg.dataset.ts = state._lastEventTs || nowIso();
      msg.appendChild(el('div', 'role', 'Agent'));
      const bubble = el('div', 'bubble md cursor');
      bubble._md = '';
      msg.appendChild(bubble);
      $('transcript').appendChild(msg);
      state.activeAssistant = bubble;
      applyActivity(); // streaming text replaces the typing dots
    }
    state.activeAssistant._md += delta;
    scheduleMd(state.activeAssistant);
  }

  // Render an element's accumulated Markdown to HTML. We keep the raw source on
  // dataset.md so search/export can read the original syntax. Throttled to one
  // render per animation frame so long streaming replies stay smooth.
  function renderMd(b, final) {
    // Only stamp the raw source onto dataset.md when finalizing — duplicating a
    // large string into the DOM every streaming frame was pure waste (search/
    // export of a finished bubble still read it; a live one falls back to text).
    if (final) b.dataset.md = b._md || '';
    b.innerHTML = window.MD ? window.MD.render(b._md || '') : esc(b._md || '');
  }
  function scheduleMd(b) {
    if (b._mdPending) return;
    b._mdPending = requestAnimationFrame(() => { b._mdPending = 0; renderMd(b, false); scrollDown(); });
  }
  function flushMd(b) {
    if (!b) return;
    if (b._mdPending) { cancelAnimationFrame(b._mdPending); b._mdPending = 0; }
    if (b._md != null) renderMd(b, true);
  }

  function appendThinking(delta, parentId) {
    if (!delta) return;
    clearAwaiting();
    hideEmpty();
    if (parentId) return appendAssistant('💭 ' + delta, parentId);
    if (!state.activeThinking) {
      closeAssistant(); // a new thinking run ends the open reply run (separate, ordered cards)
      const det = document.createElement('details');
      det.className = 'thinking live';
      det.open = true; // visible live; collapsible afterward
      const sum = document.createElement('summary');
      sum.innerHTML = '<span class="think-dot"></span><span class="think-title">Thinking…</span>';
      det.appendChild(sum);
      const body = el('div', 'think-body md');
      body._md = '';
      det.appendChild(body);
      $('transcript').appendChild(det);
      det._body = body;
      state.activeThinking = det;
      applyActivity(); // the thinking card replaces the typing dots
    }
    state.activeThinking._body._md += delta;
    scheduleMd(state.activeThinking._body);
    scrollDown();
  }

  // Close the open reply bubble (a run ended). Idempotent.
  function closeAssistant() {
    if (!state.activeAssistant) return;
    flushMd(state.activeAssistant); state.activeAssistant.classList.remove('cursor');
    const msg = state.activeAssistant.closest('.msg');
    if (msg) appendTime(msg, msg.dataset.ts); // ts is fixed at the reply's first delta (replay-safe)
    state.activeAssistant = null;
  }
  // Close the open thinking card (collapse + relabel). Idempotent.
  function closeThinking() {
    if (!state.activeThinking) return;
    const det = state.activeThinking;
    if (det._body) flushMd(det._body);
    det.classList.remove('live');
    const title = det.querySelector('.think-title');
    if (title) title.textContent = 'Thought process';
    det.open = false; // auto-collapse the finished trace (one tap to reopen) so long convos stay scannable
    state.activeThinking = null;
  }

  function finalizeAssistant() {
    closeAssistant();
    closeThinking();
    document.querySelectorAll('.nested-text:not([data-done])').forEach((n) => { flushMd(n); n.dataset.done = '1'; });
    applyActivity();
  }

  // ---- live activity indicator ---------------------------------------------
  // The single source of truth for "is the agent working", so the user always
  // gets instant, visible feedback — a typing indicator the moment they send,
  // a labelled activity row during tool use, and a Stop affordance.

  function setActivity(kind, label) {
    state.activity = kind;
    if (label) state.activityLabel = label;
    applyActivity();
    // A queued reply (e.g. an answered question form) sends once the turn settles.
    if (kind === 'idle' && state.queuedReply) flushQueuedReply();
  }
  // After sending, we optimistically show "working" and LATCH it until the engine
  // actually produces a real event — so waking a cold/idle-evicted session (proot +
  // claude init takes a few seconds) doesn't flicker idle before "thinking" appears.
  function awaitingActive() { return !!state._awaitingFirstEvent && Date.now() < (state._awaitingUntil || 0); }
  function clearAwaiting() { state._awaitingFirstEvent = false; }
  function beginAwaiting(wakeMs) {
    state._awaitingFirstEvent = true;
    state._awaitingUntil = Date.now() + 60000; // safety cap if the engine never responds
    state._optimisticUntil = Date.now() + (wakeMs || 2000);
  }
  function applyActivity() {
    const working = state.activity === 'working';
    const composer = document.querySelector('.composer');
    if (composer) composer.classList.toggle('busy', working); // Stop button only while actively working
    // Freeze the plan's in-progress spinner when not actively working, so a paused/
    // abandoned plan doesn't keep implying live progress.
    const tp = $('todoPanel'); if (tp && !tp.classList.contains('hidden')) tp.classList.toggle('idle', !working);
    // The typing dots only fill the pure gap — once a thinking trace or assistant
    // text is streaming, those are the "alive" cue and the dots would be redundant.
    const showRow = working && !state.activeAssistant && !state.activeThinking;
    let row = $('activityRow');
    if (showRow) {
      if (!row) row = buildActivityRow();
      $('transcript').appendChild(row); // keep pinned at the bottom
      const l = row.querySelector('.activity-label');
      if (l) l.textContent = state.activityLabel;
      scrollDown();
    } else if (row) {
      row.remove();
    }
  }
  function buildActivityRow() {
    const msg = el('div', 'msg assistant');
    msg.id = 'activityRow';
    const a = el('div', 'activity');
    a.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="activity-label"></span>';
    msg.appendChild(a);
    return msg;
  }
  function toolActivityLabel(ev) {
    const verbs = { Read: 'Reading', Write: 'Writing', Edit: 'Editing', MultiEdit: 'Editing', Bash: 'Running',
      Glob: 'Searching', Grep: 'Searching', WebFetch: 'Fetching', WebSearch: 'Searching', Task: 'Delegating', Agent: 'Delegating' };
    const verb = verbs[ev.name] || (/^mcp__/.test(ev.name || '') ? 'Calling' : 'Working');
    const t = targetOf(ev.input);
    const tail = t ? ' ' + String(t).split(/[\\/]/).pop().slice(0, 40) : '';
    return verb + tail + '…';
  }

  // Minimize/expand every thinking trace and tool card at once.
  function setAllCollapsed(collapsed) {
    document.querySelectorAll('.thinking').forEach((d) => { d.open = !collapsed; });
    document.querySelectorAll('.tool-card .tool-body').forEach((b) => {
      b.classList.toggle('collapsed', collapsed);
      const head = b.parentElement && b.parentElement.querySelector('.tool-head');
      if (head) head.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  function onUserEcho(ev) {
    const text = typeof ev === 'string' ? ev : (ev && ev.text);
    const meta = ev && typeof ev === 'object' ? ev : {};
    if (text == null || text === '') return;
    const norm = String(text).trim();
    const i = state.pendingSent.findIndex((e) => e.text === norm);
    if (i >= 0) { // our optimistic copy — keep it, just stamp the revert ids onto it
      const { id } = state.pendingSent[i];
      state.pendingSent.splice(i, 1);
      // Stamp the bubble for THIS send (by id), not whatever bubble is last.
      const bubble = id && $('transcript').querySelector('.msg.user[data-pending-id="' + id + '"]');
      stampUserBubble(bubble || lastUserBubble(), meta);
      if (bubble) delete bubble.dataset.pendingId;
      return;
    }
    addUserMessage(text, meta);
  }

  function lastUserBubble() {
    const msgs = $('transcript').querySelectorAll('.msg.user');
    return msgs.length ? msgs[msgs.length - 1] : null;
  }
  function stampUserBubble(msgEl, meta) {
    if (!msgEl || !meta) return;
    if (meta.turnId) msgEl.dataset.turnId = meta.turnId;
    msgEl.dataset.checkpointId = meta.checkpointId || '';
    if (meta.text != null) msgEl.dataset.revertText = meta.text;
    if (meta.ts) { // replace the optimistic client-clock stamp with the authoritative server ts
      msgEl.dataset.ts = meta.ts;
      const t = formatTime(meta.ts);
      const existing = [...msgEl.children].find((c) => c.classList && c.classList.contains('msg-time'));
      if (existing) { if (t) existing.textContent = t; } else appendTime(msgEl, meta.ts);
    }
  }

  function addUserMessage(text, meta, pendingId) {
    hideEmpty();
    finalizeAssistant();
    const msg = el('div', 'msg user');
    const ts = (meta && meta.ts) || nowIso();
    msg.dataset.ts = ts;
    if (pendingId) msg.dataset.pendingId = pendingId;
    msg.appendChild(el('div', 'role', 'You'));
    msg.appendChild(el('div', 'bubble', text));
    appendTime(msg, ts);
    $('transcript').appendChild(msg);
    stampUserBubble(msg, meta || { text });
    scrollDown();
  }
  // ---- message timestamps ---------------------------------------------------
  function nowIso() { try { return new Date().toISOString(); } catch { return ''; } }
  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function appendTime(msgEl, ts) {
    if (!msgEl) return;
    if ([...msgEl.children].some((c) => c.classList && c.classList.contains('msg-time'))) return;
    const s = formatTime(ts); if (!s) return;
    msgEl.appendChild(el('div', 'msg-time', s));
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
    clearAwaiting(); // a tool starting means the engine is live
    // TodoWrite drives the pinned live checklist instead of a tool card.
    if (ev.name === 'TodoWrite' && ev.input && Array.isArray(ev.input.todos)) {
      return renderTodos(ev.input.todos);
    }
    // The agent asking via the broker's MCP tool surfaces as a question_request
    // event (the real path); the raw mcp__broker__AskUserQuestion tool card is
    // suppressed so we don't double-render. The legacy built-in tool_use (not
    // exposed by the headless CLI, but kept for safety) still renders a form here.
    if (/__AskUserQuestion$/.test(ev.name)) return; // mcp__broker__AskUserQuestion → driven by question_request
    if (ev.name === 'AskUserQuestion' && ev.input && Array.isArray(ev.input.questions)) {
      hideEmpty();
      if (!ev.parentToolUseId) finalizeAssistant();
      setActivity('working', 'Waiting for your answers…');
      renderQuestionForm(ev.input.questions, (answers) => queueReply(answersToText(answers)), ev.parentToolUseId);
      return;
    }
    hideEmpty();
    if (!ev.parentToolUseId) finalizeAssistant();

    // A tool that was surfaced live at its block-start is now finalizing: the card
    // already exists — swap its streamed preview for the authoritative input.
    const existing = state.toolCards.get(ev.id);
    if (existing) { finalizeToolCard(existing, ev); return; }

    setActivity('working', toolActivityLabel(ev)); // show what the agent is doing
    const card = el('div', 'tool-card' + (ev.kind === 'subagent' ? ' subagent' : ''));
    const isDiff = /^(Write|Edit|MultiEdit)$/.test(ev.name);

    const head = el('div', 'tool-head');
    // It's a real toggle: expose it as a keyboard-operable button to assistive tech.
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-label', `${prettyToolName(ev.name)} ${targetOf(ev.input)} — toggle details`);
    head.innerHTML =
      `<span class="tool-icon">${toolIcon(ev.name, ev.kind)}</span>` +
      `<span class="tool-name">${esc(prettyToolName(ev.name))}</span>` +
      `<span class="tool-target">${esc(targetOf(ev.input))}</span>` +
      `<span class="tool-state running">running</span>` +
      `<span class="tool-caret" aria-hidden="true">▸</span>`;
    card.appendChild(head);

    const body = el('div', 'tool-body');
    if (ev.streaming) {
      // Live block-start: show the input as it streams in; finalizeToolCard swaps
      // this for the rendered diff / command once the full input arrives.
      const pre = el('pre', 'tool-stream', '…');
      body.appendChild(pre); card.__stream = pre;
    } else {
      fillToolBody(card, body, ev.name, ev.input, isDiff);
    }
    if (ev.kind === 'subagent') body.classList.remove('collapsed');
    card.appendChild(body);
    const toggleBody = () => { const collapsed = body.classList.toggle('collapsed'); head.setAttribute('aria-expanded', String(!collapsed)); };
    head.setAttribute('aria-expanded', String(!body.classList.contains('collapsed')));
    head.addEventListener('click', toggleBody);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBody(); } });

    const host = nestedContainerFor(ev.parentToolUseId) || $('transcript');
    host.appendChild(card);
    const filePath = (ev.input && ev.input.file_path) || '';
    state.toolCards.set(ev.id, {
      el: card, head, body, name: ev.name, isDiff, nested: null,
      // Any generated viewable file (html/svg/image/markdown) gets an inline viewer.
      filePath, fileKind: isDiff ? fileKind(filePath) : null,
    });
    scrollDown();
  }

  // Build a tool card's body for a known (complete) input.
  function fillToolBody(card, body, name, input, isDiff) {
    body.innerHTML = '';
    if (isDiff) {
      body.innerHTML = window.DiffRender.renderDiff(input || {});
    } else if (name === 'Bash') {
      body.appendChild(elHtml('div', 'tool-input', '$ ' + esc((input && input.command) || '')));
      const pre = el('pre', '', '…');
      body.appendChild(pre);
      card.__pre = pre;
    } else {
      const pre = el('pre', '', shortInput(input));
      body.appendChild(pre);
      card.__pre = pre;
    }
  }

  // Live partial tool input (input_json_delta): grow the streamed preview in place.
  function onToolDelta(ev) {
    const rec = state.toolCards.get(ev.id);
    if (!rec || !rec.el.__stream) return;
    rec.el.__stream.textContent = ev.jsonText || '…';
    if (state._pinBottom) scrollDown();
  }

  // Swap a streamed card's raw preview for the authoritative input once it lands.
  function finalizeToolCard(rec, ev) {
    rec.name = ev.name;
    rec.isDiff = /^(Write|Edit|MultiEdit)$/.test(ev.name);
    const filePath = (ev.input && ev.input.file_path) || '';
    rec.filePath = filePath;
    rec.fileKind = rec.isDiff ? fileKind(filePath) : null;
    rec.el.__stream = null;
    fillToolBody(rec.el, rec.body, ev.name, ev.input, rec.isDiff);
    const tgt = rec.head.querySelector('.tool-target');
    if (tgt) tgt.textContent = targetOf(ev.input);
    scrollDown();
  }

  // Interactive form: each question becomes a fieldset with single- or
  // multi-select options plus a free-fill custom answer. `onSubmit` receives the
  // structured answers [{ header, question, selected:[label], custom }]. Returns
  // the card element so the caller can finalize it (e.g. on question_resolved).
  function renderQuestionForm(questions, onSubmit, parentToolUseId) {
    questions = questions || [];
    const answers = questions.map((q) => ({ header: q.header || '', question: q.question || '', selected: new Set(), custom: '' }));
    const card = el('div', 'qform');
    card.appendChild(el('div', 'qform-title', questions.length > 1 ? 'The agent has a few questions' : 'The agent has a question'));

    const submit = el('button', 'qform-submit accent', 'Send answers');
    const answered = (qi) => answers[qi].selected.size > 0 || answers[qi].custom.trim().length > 0;
    const refresh = () => { submit.disabled = !questions.every((_, qi) => answered(qi)); };

    questions.forEach((q, qi) => {
      const fs = el('div', 'qform-q');
      if (q.header) fs.appendChild(el('span', 'qform-h', q.header));
      fs.appendChild(el('div', 'qform-text', q.question || ''));
      const multi = !!q.multiSelect;
      if (multi) fs.appendChild(el('div', 'qform-hint', 'Choose any that apply'));
      const opts = el('div', 'qform-opts');
      (q.options || []).forEach((o) => {
        const label = typeof o === 'string' ? o : (o.label || '');
        const desc = (o && typeof o === 'object' && o.description) || '';
        const opt = el('button', 'qform-opt'); opt.type = 'button';
        opt.appendChild(el('span', 'qform-opt-label', label));
        if (desc) opt.appendChild(el('span', 'qform-opt-desc', desc));
        opt.onclick = () => {
          if (multi) {
            if (answers[qi].selected.has(label)) { answers[qi].selected.delete(label); opt.classList.remove('on'); }
            else { answers[qi].selected.add(label); opt.classList.add('on'); }
          } else {
            answers[qi].selected.clear();
            opts.querySelectorAll('.qform-opt').forEach((x) => x.classList.remove('on'));
            answers[qi].selected.add(label); opt.classList.add('on');
          }
          refresh();
        };
        opts.appendChild(opt);
      });
      fs.appendChild(opts);
      const custom = el('input', 'qform-custom'); custom.type = 'text';
      custom.placeholder = 'Or type your own answer…';
      custom.oninput = () => { answers[qi].custom = custom.value; refresh(); };
      fs.appendChild(custom);
      card.appendChild(fs);
    });

    submit.disabled = true;
    submit.onclick = () => {
      const out = answers.map((a) => ({ header: a.header, question: a.question, selected: [...a.selected], custom: a.custom.trim() }));
      card.classList.add('answered');
      card.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
      submit.textContent = 'Answer sent ✓';
      onSubmit(out);
    };
    card.appendChild(submit);

    const host = nestedContainerFor(parentToolUseId) || $('transcript');
    host.appendChild(card);
    scrollDown();
    return card;
  }

  // The agent asked via the broker's MCP tool: render the form and send the
  // structured answer straight back (the MCP tool result IS the answer — no extra
  // user turn needed).
  function onQuestionRequest(ev) {
    hideEmpty();
    finalizeAssistant();
    setActivity('working', 'Waiting for your answer…');
    const card = renderQuestionForm(ev.questions, (answers) => {
      send({ type: 'question_response', id: ev.id, answers, sessionKey: ev.sessionKey });
    }, null);
    if (ev.id) (state.questionCards || (state.questionCards = new Map())).set(ev.id, card);
  }
  // The engine resolved/cancelled a question (answered elsewhere, or engine gone):
  // finalize a still-open form so it can't be submitted twice.
  function onQuestionResolved(ev) {
    const map = state.questionCards;
    const card = map && map.get(ev.id);
    if (card && !card.classList.contains('answered')) {
      card.classList.add('answered');
      card.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
    }
    if (map) map.delete(ev.id);
  }
  function answersToText(answers) {
    return (answers || []).map((a) => {
      const picks = [...(a.selected || [])];
      if (a.custom) picks.push(a.custom);
      return `**${a.header || a.question || 'Answer'}:** ${picks.join(', ')}`;
    }).join('\n');
  }

  // Send a reply as the next user turn, but wait until the current turn settles
  // (the CLI has to resolve its pending tool first) so the API's tool_use→result
  // ordering isn't violated.
  function queueReply(text) {
    state.queuedReply = text;
    flushQueuedReply();
  }
  function flushQueuedReply() {
    if (!state.queuedReply || state.activity !== 'idle') return;
    const text = state.queuedReply; state.queuedReply = null;
    const pendingId = 'p' + (++state._sendSeq);
    state.pendingSent.push({ id: pendingId, text });
    addUserMessage(text, null, pendingId);
    setActivity('working', 'Thinking…');
    beginAwaiting(2000);
    send({ type: 'user_message', text });
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
    // Image results (screenshots, image reads, MCP image output) render as pictures.
    const hasImages = Array.isArray(ev.images) && ev.images.length;
    if (hasImages) {
      let wrap = card.body.querySelector('.tool-images');
      if (!wrap) { wrap = el('div', 'tool-images'); card.body.appendChild(wrap); }
      wrap.innerHTML = '';
      for (const src of ev.images) {
        const img = document.createElement('img');
        img.className = 'tool-img'; img.loading = 'lazy'; img.src = src;
        wrap.appendChild(img);
      }
    }
    // Once a tool call finishes cleanly, collapse it (diffs included) so completed
    // actions don't take up conversation space. Subagents keep their nested view
    // open, and an image result stays expanded so the picture is visible.
    if (ev.status !== 'error' && card.name !== 'Agent' && !hasImages) {
      card.body.classList.add('collapsed');
      card.head.setAttribute('aria-expanded', 'false');
    }
    // A generated viewable file becomes an inline viewer (html app / svg / image / md).
    if (card.fileKind && ev.status !== 'error' && card.filePath) addFileWidget(card.filePath, card.fileKind);
    scrollDown();
  }

  // ---- inline file viewer --------------------------------------------------
  // When the agent generates a viewable file, show a card that renders it inline
  // (served from the project via /preview): html runs in a sandboxed iframe, svg/
  // images render as <img>, markdown renders rich. Each gets View source / Download
  // / Open-full controls. See [[implemented-features]] HTML microapp widget.
  const fileWidgets = new Map(); // projectRelPath -> widget state (normalized key)
  // A file_widget event renders a viewer for a file already on disk (e.g. a
  // Playwright screenshot dropped via the /widget endpoint) — no Write/Edit needed.
  function onFileWidget(ev) {
    if (!ev || !ev.path) return;
    const kind = ev.kind || fileKind(ev.path);
    if (!kind) return;
    addFileWidget(ev.path, kind);
  }
  // What renderer a generated file maps to (null = not viewable).
  function fileKind(filePath) {
    const ext = (String(filePath).split('.').pop() || '').toLowerCase();
    if (/^html?$/.test(ext)) return 'html';
    if (ext === 'svg') return 'svg';
    if (/^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(ext)) return 'image';
    if (/^(md|markdown)$/.test(ext)) return 'markdown';
    return null;
  }

  // Agents often write an ABSOLUTE file_path (e.g. /root/projects/Test/index.html);
  // /preview and /download serve RELATIVE to the active project dir, so strip it.
  function projectRelPath(filePath) {
    let p = String(filePath).replace(/\\/g, '/');
    const proj = state.projects.find((x) => x.id === state.activeProjectId) || state.projects.find((x) => x.active);
    const dir = proj && proj.dir ? String(proj.dir).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (dir && (p === dir || p.startsWith(dir + '/'))) p = p.slice(dir.length).replace(/^\/+/, '');
    return p.replace(/^[.]\/+/, '');
  }
  function _previewish(prefix, filePath) {
    const rel = projectRelPath(filePath);
    const abs = rel.startsWith('/'); // unmatched absolute — let the broker's resolve guard it
    return prefix + (abs ? '/' : '') + rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }
  function htmlAppUrl(filePath) { return _previewish('/preview/', filePath); }
  // Absolute-path file URL (File Manager tabs): served by /fsraw, not /preview.
  function fsRawUrl(absPath) { return '/fsraw?path=' + encodeURIComponent(absPath); }
  function downloadFile(filePath, name) {
    const url = _previewish('/download/', filePath);
    const fname = name || String(filePath).split(/[\\/]/).pop();
    if (native.has('openExternal')) { native.openExternal(location.origin + url); toast('Opening to download…', 'info'); return; }
    const a = document.createElement('a'); a.href = url; a.download = fname || ''; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  const KIND_ICON = { html: '📱', svg: '🎨', image: '🖼️', markdown: '📄' };
  function addFileWidget(filePath, kind) {
    kind = kind || fileKind(filePath);
    if (!kind) return;
    hideEmpty();
    const url = htmlAppUrl(filePath); // /preview/<rel>
    // Key by the project-relative path so an absolute and a relative reference to
    // the SAME file collapse onto one card instead of producing duplicates.
    const wkey = projectRelPath(filePath);
    let w = fileWidgets.get(wkey);
    if (w) { // file re-written: refresh in place + bump to the bottom
      w.url = url; w.kind = kind;
      $('transcript').appendChild(w.card);
      if (w.collapsed) { w._dirty = true; }            // re-render lazily the next time it's shown
      else { renderFileBody(w); if (w.codeShown) refreshFileCode(w); }
      w.card.classList.remove('flash'); void w.card.offsetWidth; w.card.classList.add('flash');
      scrollDown();
      return;
    }
    const fname = String(filePath).split(/[\\/]/).pop();
    const card = el('div', 'html-app');
    const head = el('div', 'html-app-head');
    const icon = el('span', 'html-app-icon', KIND_ICON[kind] || '📄');
    const name = el('span', 'html-app-name', fname);
    const actions = el('div', 'html-app-actions');
    head.appendChild(icon); head.appendChild(name); head.appendChild(actions);
    const bodyEl = el('div', 'html-app-body');
    const codeEl = el('div', 'html-app-code hidden');
    card.appendChild(head); card.appendChild(bodyEl); card.appendChild(codeEl);
    $('transcript').appendChild(card);
    w = { card, body: bodyEl, code: codeEl, url, filePath, fname, kind, running: false, frame: null, codeShown: false, collapsed: true, _rendered: false, _dirty: false };
    fileWidgets.set(wkey, w);

    // Hide/Show toggle — consistent across every artifact kind. Widgets start
    // collapsed (header only) so generated files don't flood the transcript.
    const hideBtn = el('button', 'ghost small', 'Show'); hideBtn.title = 'Show / hide preview'; w.hideBtn = hideBtn;
    hideBtn.onclick = () => setFileCollapsed(w, !w.collapsed);
    actions.appendChild(hideBtn);
    // View source for text-based kinds (binary images have no useful source).
    if (kind === 'html' || kind === 'svg' || kind === 'markdown') {
      const codeBtn = el('button', 'ghost small', '</> Code'); codeBtn.title = 'View source'; w.codeBtn = codeBtn;
      codeBtn.onclick = () => toggleFileCode(w);
      actions.appendChild(codeBtn);
    }
    const dlBtn = el('button', 'ghost small', '⬇'); dlBtn.title = 'Download';
    dlBtn.onclick = () => downloadFile(filePath, fname);
    actions.appendChild(dlBtn);
    const tabBtn = el('button', 'ghost small', '⧉ Tab'); tabBtn.title = 'Open the file in a new tab';
    tabBtn.onclick = () => openFileTab(filePath, kind);
    actions.appendChild(tabBtn);
    const openBtn = el('button', 'primary small', '⤢ Open'); openBtn.title = 'Open full screen';
    openBtn.onclick = () => {
      const full = location.origin + w.url;
      if (native.has('openExternal')) native.openExternal(full); else window.open(full, '_blank', 'noopener');
    };
    actions.appendChild(openBtn);

    setFileCollapsed(w, true); // start hidden — the body renders lazily on first Show
    scrollDown();
  }
  function _bust(url) { return url + (url.includes('?') ? '&' : '?') + 'r=' + Date.now(); }
  // Collapse/expand a file widget's preview. Widgets default to collapsed so
  // generated artifacts don't take over the transcript; the body (and the html
  // iframe) is built lazily on first expand and torn down again on collapse.
  function setFileCollapsed(w, collapsed) {
    w.collapsed = collapsed;
    w.body.classList.toggle('hidden', collapsed);
    if (w.hideBtn) { w.hideBtn.textContent = collapsed ? 'Show' : 'Hide'; w.hideBtn.classList.toggle('on', !collapsed); }
    if (collapsed) {
      w.code.classList.add('hidden'); w.codeShown = false; if (w.codeBtn) w.codeBtn.classList.remove('on');
      // Stop the running app. We discard the iframe, so mark it unrendered — the
      // next Show must rebuild it (otherwise the body re-opens empty).
      if (w.kind === 'html' && w.frame) { w.body.innerHTML = ''; w.frame = null; w.running = false; w._rendered = false; }
    } else if (!w._rendered || w._dirty) {
      renderFileBody(w); w._rendered = true; w._dirty = false;
    }
  }
  function renderFileBody(w) {
    w.body.className = 'html-app-body'; // reset; each kind re-applies its own modifiers
    if (w.kind === 'html') { runHtmlApp(w); return; }
    if (w.kind === 'svg' || w.kind === 'image') {
      // <img> renders svg WITHOUT executing its scripts — safe for agent output.
      w.body.classList.add('media', 'checker');
      const img = document.createElement('img');
      img.className = 'html-app-img'; img.alt = w.fname; img.loading = 'lazy';
      // Guard against a stale detached <img> firing error after a re-render replaced it.
      img.onerror = () => { if (w.body.querySelector('img') === img) { w.body.classList.remove('checker'); w.body.innerHTML = '<div class="html-app-empty">Could not load ' + esc(w.fname) + '</div>'; } };
      img.src = _bust(w.url);
      w.body.innerHTML = ''; w.body.appendChild(img);
      return;
    }
    if (w.kind === 'markdown') {
      w.body.className = 'html-app-body mdbody';
      w.body.innerHTML = '<div class="html-app-empty">Loading…</div>';
      fetch(_bust(w.url), { cache: 'no-store' }).then((r) => r.text()).then((t) => {
        const html = (window.MD && window.MD.render) ? window.MD.render(t) : esc(t);
        w.body.innerHTML = '<div class="bubble md">' + html + '</div>';
      }).catch((e) => { w.body.innerHTML = '<div class="html-app-empty">Could not load source: ' + esc(e.message || String(e)) + '</div>'; });
      return;
    }
  }
  async function toggleFileCode(w) {
    if (w.collapsed) setFileCollapsed(w, false); // viewing source implies expanding the widget
    if (w.codeShown) { w.code.classList.add('hidden'); w.codeShown = false; w.codeBtn.classList.remove('on'); return; }
    w.codeShown = true; w.codeBtn.classList.add('on'); w.code.classList.remove('hidden');
    await refreshFileCode(w);
    scrollDown();
  }
  async function refreshFileCode(w) {
    w.code.innerHTML = '<button class="code-copy" type="button">Copy</button><pre><code></code></pre>';
    const codeNode = w.code.querySelector('code');
    codeNode.textContent = 'Loading…';
    try {
      const r = await fetch(_bust(w.url), { cache: 'no-store' });
      const text = await r.text();
      codeNode.textContent = text;
      // Reuse the delegated .code-copy handler (it reads dataset.copy verbatim).
      w.code.querySelector('.code-copy').dataset.copy = text;
    } catch (e) { codeNode.textContent = '(could not load source: ' + (e.message || e) + ')'; }
  }
  function runHtmlApp(w) {
    const f = document.createElement('iframe');
    f.className = 'html-app-iframe';
    // The microapp is the user's own local file; sandbox keeps it from touching
    // the broker UI while still allowing scripts/forms/storage to make it work.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('allow', 'autoplay; clipboard-write');
    f.src = w.url + (w.url.includes('?') ? '&' : '?') + 'r=' + Date.now();
    w.body.innerHTML = ''; w.body.appendChild(f);
    w.frame = f; w.running = true;
  }

  // ---- APK / build-artifact widget ----------------------------------------
  // Files live in the proot rootfs (invisible to the phone's Files app). When a
  // build produces an .apk/.aab, surface a one-tap "Save to Downloads" — the
  // browser's download lands it in the real Downloads folder the user can see.
  const apkWidgets = new Map(); // rel -> { card, mtime, sub }
  function humanSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function onApks(ev) { for (const a of (ev.items || [])) addApkWidget(a); }
  function addApkWidget(a) {
    hideEmpty();
    let w = apkWidgets.get(a.rel);
    if (w) {
      if (w.mtime === a.mtime) return; // unchanged — don't churn the UI
      w.mtime = a.mtime;
      w.sub.textContent = humanSize(a.size) + ' · updated · ' + a.rel;
      $('transcript').appendChild(w.card); // bump a rebuilt artifact to the bottom
      w.card.classList.remove('flash'); void w.card.offsetWidth; w.card.classList.add('flash');
      scrollDown();
      return;
    }
    const card = el('div', 'apk-app flash');
    const icon = el('span', 'apk-icon', '📦');
    const info = el('div', 'apk-info');
    const name = el('div', 'apk-name', a.name);
    const sub = el('div', 'apk-sub', humanSize(a.size) + ' · ' + a.rel);
    info.appendChild(name); info.appendChild(sub);
    const dl = el('button', 'primary small', '⬇ Save to Downloads');
    dl.onclick = () => downloadFile(a.rel, a.name);
    card.appendChild(icon); card.appendChild(info); card.appendChild(dl);
    $('transcript').appendChild(card);
    apkWidgets.set(a.rel, { card, mtime: a.mtime, sub });
    scrollDown();
  }

  // ---- approvals -----------------------------------------------------------

  function onPermissionRequest(ev) {
    hideEmpty();
    finalizeAssistant();
    setActivity('waiting'); // paused on the user — the approval card is the cue
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
      go.onclick = () => { setActivity('working', 'Working…'); send({ type: 'approve', id: ev.id, sessionKey: ev.sessionKey }); };
      keep.onclick = () => { setActivity('working', 'Working…'); send({ type: 'deny', id: ev.id, reason: 'Keep planning', sessionKey: ev.sessionKey }); };
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
    allow.onclick = () => { setActivity('working', 'Working…'); send({ type: 'approve', id: ev.id, sessionKey: ev.sessionKey }); };
    deny.onclick = () => { setActivity('working', 'Working…'); send({ type: 'deny', id: ev.id, sessionKey: ev.sessionKey }); };
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
    // Drive the live activity indicator off the engine's own status.
    if (stateName === 'thinking') { clearAwaiting(); setActivity('working', 'Thinking…'); }
    else if (stateName === 'running') { clearAwaiting(); setActivity('working', detail || 'Working…'); }
    else if (stateName === 'waiting') { clearAwaiting(); setActivity('waiting'); }
    else if (stateName === 'error') { clearAwaiting(); setActivity('idle'); }
    // A just-woken engine emits an init 'idle' before it starts the queued turn —
    // ignore it while we're still awaiting, so the "Waking up…" cue doesn't blink off.
    else if (stateName === 'idle') { if (awaitingActive()) return; setActivity('idle'); }
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

  // Curated, user-facing notices only (api_retry, unusual stop reasons) — a dim
  // inline note so a stall/retry isn't silent. Routine engine diagnostics arrive at
  // level "debug"/"info" (session._log) and would FLOOD the chat — they belong in
  // the broker/runtime log, never the transcript.
  function onLog(ev) {
    if (!ev || !ev.message) return;
    if (ev.level !== 'warn' && ev.level !== 'error') return;
    finalizeAssistant();
    const div = el('div', 'sys-note ' + ev.level, ev.message);
    $('transcript').appendChild(div);
    scrollDown();
  }

  function onResult(ev) {
    setActivity('idle');
    clearAwaiting();
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
    clearAwaiting();
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
      const help = el('span', 'banner-help', ' You need to sign in to Claude.');
      banner.appendChild(help);
      const open = aria(el('button', 'banner-act', 'Sign in'), 'Sign in to Claude');
      open.onclick = () => { openClaudeSignin(); banner.remove(); };
      banner.appendChild(open);
    }
    const x = aria(el('button', 'banner-x', '✕'), 'Dismiss');
    x.onclick = () => banner.remove();
    banner.appendChild(x);
  }

  // ---- Claude sign-in ------------------------------------------------------
  // Reliable login UX wrapping the two working paths: (A) paste a token/key that we
  // inject into the engine env (applies next message, no restart); (B) on-device
  // `claude setup-token` (PTY) — open the link, approve, paste the code back.
  function openClaudeSignin() {
    const prev = $('signinModal'); if (prev) prev.remove();
    const back = el('div', 'modal'); back.id = 'signinModal';
    const close = () => back.remove();
    back.onclick = (e) => { if (e.target === back) close(); };
    const card = el('div', 'modal-card'); card.style.maxWidth = 'min(560px, 94vw)';

    const head = el('div', 'mgr-head');
    head.appendChild(el('h3', '', 'Sign in to Claude'));
    const x = aria(el('button', 'ghost small', '✕'), 'Close'); x.onclick = close; head.appendChild(x);
    card.appendChild(head);

    const body = el('div', 'mgr-body'); body.style.padding = '14px';

    body.appendChild(el('p', 'mgr-hint', 'Paste a Claude OAuth token (from `claude setup-token`) or an Anthropic API key. Applies to your next message — no restart.'));
    const tok = el('input', 'mgr-input'); tok.type = 'password';
    tok.placeholder = 'CLAUDE_CODE_OAUTH_TOKEN or sk-ant-…'; tok.autocapitalize = 'off'; tok.autocomplete = 'off'; tok.spellcheck = false;
    body.appendChild(tok);
    const save = el('button', 'primary', 'Save & sign in'); save.style.marginTop = '8px';
    save.onclick = () => {
      const v = tok.value.trim(); if (!v) return;
      const name = v.startsWith('sk-ant-') ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
      send({ type: 'set_secret', name, value: v });
      toast('Signed in — applies to your next message'); close();
    };
    body.appendChild(save);

    body.appendChild(el('hr', 'mgr-sep'));
    body.appendChild(el('p', 'mgr-hint', 'Or do it on this device: run setup-token, open the link, approve, then paste the code it shows you.'));
    const runBtn = el('button', 'ghost small', 'Run claude setup-token');
    runBtn.onclick = () => { send({ type: 'run', command: 'claude setup-token' }); if ($('terminal')) $('terminal').classList.remove('hidden'); toast('Running — watch the Terminal for a link'); };
    body.appendChild(runBtn);
    const codeRow = el('div', ''); codeRow.style.cssText = 'margin-top:8px;display:flex;gap:6px';
    const code = el('input', 'mgr-input'); code.placeholder = 'paste the code here'; code.style.flex = '1';
    const sendCode = el('button', 'ghost small', 'Send code');
    sendCode.onclick = () => { const c = code.value.trim(); if (!c) return; send({ type: 'run_input', data: c + '\n' }); appendTerminalMeta('(code sent)'); code.value = ''; toast('Code sent'); };
    codeRow.appendChild(code); codeRow.appendChild(sendCode); body.appendChild(codeRow);

    card.appendChild(body);
    back.appendChild(card);
    document.getElementById('app').appendChild(back);
    tok.focus();
  }
  window.openClaudeSignin = openClaudeSignin;

  // ---- transcript replay / checkpoints / native change --------------------

  function applyTranscript(ev) {
    if (ev.reset) resetConversation();
    // Replay flag: suppress the per-record scroll churn (setActivity/scrollDown
    // fire for every replayed record); we scroll once after the loop.
    state._replaying = true;
    try {
      for (const rec of ev.events || []) {
        if (rec.type === 'result') { finalizeAssistant(); continue; }
        handleEvent(rec);
      }
    } finally {
      state._replaying = false;
    }
    finalizeAssistant();
    scrollDown(true);
    // A replay is historical — replayed tool_call records call setActivity('working'),
    // which would leave the UI stuck "working" (Stop button, send blocked). Reset to
    // idle; live status events for the (re)started engine drive the real state.
    setActivity('idle');
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
    const dismiss = aria(el('button', 'banner-x', '✕'), 'Dismiss');
    dismiss.onclick = () => banner.remove();
    banner.appendChild(rebuild); banner.appendChild(dismiss);
  }

  // ---- todos (pinned live checklist) ---------------------------------------

  function renderTodos(todos) {
    const panel = $('todoPanel');
    // An explicit call (TodoWrite/clear) updates the model; a no-arg call just
    // re-renders the current plan (e.g. when the agent goes idle, to freeze the
    // in-progress spinner so an abandoned plan stops implying active work).
    if (todos !== undefined) {
      state._todos = (todos && todos.length) ? todos : null;
      const allDone = state._todos && state._todos.every((t) => t.status === 'completed');
      state._todoCollapsed = !!allDone; // expand an active plan; auto-collapse a finished one
    }
    const list = state._todos;
    if (!list || !list.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
    const done = list.filter((t) => t.status === 'completed').length;
    const collapsed = !!state._todoCollapsed;
    panel.innerHTML = '';
    const head = el('div', 'todo-head');
    head.innerHTML = `<span class="todo-caret">${collapsed ? '▸' : '▾'}</span> Plan — ${done}/${list.length} done`;
    head.onclick = () => { state._todoCollapsed = !state._todoCollapsed; renderTodos(); };
    panel.appendChild(head);
    if (!collapsed) {
      list.forEach((t) => {
        const row = el('div', 'todo-item ' + (t.status || 'pending'));
        // The status marker is drawn by CSS (::before circle/check/spinner).
        row.textContent = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
        panel.appendChild(row);
      });
    }
    panel.classList.toggle('done', done === list.length);
    panel.classList.toggle('idle', state.activity !== 'working'); // freezes the in-progress spinner
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
        const bubble = node.querySelector('.bubble');
        // Prefer the original Markdown source (assistant bubbles render to HTML).
        const text = (bubble && (bubble.dataset.md ?? bubble.textContent)) || '';
        md += `**${role}:** ${text}\n\n`;
      } else if (node.classList.contains('thinking')) {
        // Include the reasoning trace as a blockquote (source kept on the body's _md).
        const body = node.querySelector('.think-body');
        const text = (body && (body.dataset.md ?? body.textContent)) || '';
        if (text.trim()) md += `> 💭 ${text.trim().replace(/\n/g, '\n> ')}\n\n`;
      } else if (node.classList.contains('html-app')) {
        const name = node.querySelector('.html-app-name')?.textContent || 'file';
        md += `\`📎 ${name}\` _(generated file)_\n\n`;
      } else if (node.classList.contains('apk-app')) {
        const name = node.querySelector('.apk-name')?.textContent || 'artifact';
        md += `\`📦 ${name}\` _(build artifact)_\n\n`;
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
    // Some WebViews ignore a click on an unattached anchor — attach it. Revoke
    // generously later so a slow save isn't cut off mid-write.
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
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
      { label: 'Sign in to Claude', run: openClaudeSignin },
      { label: 'Collapse all thinking & actions', run: () => setAllCollapsed(true) },
      { label: 'Expand all thinking & actions', run: () => setAllCollapsed(false) },
      { label: 'Update app (git pull)', run: () => { send({ type: 'app_update' }); toast('Checking for updates…', 'info'); } },
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
    const parents = new Set();
    document.querySelectorAll('#transcript mark.find-hit').forEach((mk) => {
      const p = mk.parentNode;
      parents.add(p);
      p.replaceChild(document.createTextNode(mk.textContent), mk);
    });
    // Merge the now-adjacent text nodes back into whole nodes — otherwise a node
    // like "hello" stays split as "he","l","lo" and multi-char searches (which
    // would span those fragments) stop matching after the first single-char hit.
    parents.forEach((p) => p && p.normalize());
    _findHits = []; _findIdx = -1;
  }
  function runFind(q) {
    clearFindMarks();
    if (!q) { $('findCount').textContent = ''; return; }
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker($('transcript'), NodeFilter.SHOW_TEXT, {
      // Never mark inside a still-streaming bubble/thinking card: the next RAF
      // render overwrites it (wasting the mark) and the replaceChild can mis-route
      // that render. Find only over settled content.
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('script,style,.bubble.cursor,.thinking.live') ? NodeFilter.FILTER_REJECT
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

  // True while the `run` channel has a live process. When set, the terminal input
  // routes keystrokes to its stdin (interactive CLIs: `claude` login, REPLs) and
  // the Stop button appears.
  let runActive = false;
  function onRunStatus(stateStr) {
    runActive = stateStr === 'running';
    const input = $('termInput');
    if (input) input.placeholder = runActive
      ? 'type input for the running command… (Enter to send)'
      : 'run a command in the project…';
    const stop = $('termStop');
    if (stop) stop.classList.toggle('hidden', !runActive);
  }

  // Strip ANSI escape sequences (cursor moves, colors, OSC) — interactive CLIs run
  // under a PTY (for on-device `claude` login) emit them and our plain terminal
  // can't interpret them, so they'd show as garbage like "[1m" / "[?25l".
  function stripAnsi(s) {
    return String(s)
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (e.g. window title)
      .replace(/\x1b[@-Z\\-_]/g, '')                   // single-char ESC sequences
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')       // CSI (colors, cursor)
      .replace(/\r(?!\n)/g, '\n');                     // bare CR → newline
  }
  function onControlOutput(ev) { appendTerminal(stripAnsi(ev.data), ev.stream === 'stderr' ? 'stderr' : ''); }
  const TERM_MAX_SPANS = 2000;
  function appendTerminal(text, cls) {
    const body = $('termBody');
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    body.appendChild(span);
    // Cap scroll-back: a long build (npm install / gradle) emits thousands of lines
    // and would grow the DOM unbounded. Drop the oldest spans past the cap.
    let over = body.childElementCount - TERM_MAX_SPANS;
    while (over-- > 0 && body.firstChild) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }
  function appendTerminalMeta(text) { appendTerminal(text + '\n', 'meta'); }

  // ---- metro / test --------------------------------------------------------

  // Metro is per PROJECT (each folder gets its own port), and tabs can be different
  // projects → different Expo apps. So track status per projectId and render the
  // ACTIVE tab's project; the broker re-emits the active project's status on switch.
  function activeMetro() { return state.metroByProject[state.activeProjectId] || null; }

  function onMetro(ev) {
    const pid = ev.projectId || state.activeProjectId;
    if (pid) state.metroByProject[pid] = ev;
    // A failure (no Expo project, crashed start, missing deps, …): if it's the
    // project we were starting, stop waiting and surface the reason.
    if (ev.error && state._awaitingMetro === pid) {
      state._awaitingMetro = null;
      clearTimeout(state._metroWait);
      toast('Metro: ' + ev.error, 'error');
      if ($('terminal').classList.contains('hidden')) toggleTerminal();
    }
    // Open the Expo client only for the project we're actively waiting on, and only
    // once Metro truly answers (running) — never on a blind timer.
    if (ev.running && state._awaitingMetro === pid) {
      state._awaitingMetro = null;
      clearTimeout(state._metroWait);
      openDevClient(pid);
    }
    renderMetro();
  }

  // Paint the badge + Test button from the ACTIVE project's Metro status.
  function renderMetro() {
    const m = activeMetro();
    const badge = $('metroBadge');
    const btn = $('testBtn');
    if (!badge || !btn) return;
    if (m && m.running) { badge.classList.remove('hidden'); badge.textContent = `Metro :${m.port}`; btn.textContent = '▶ Open'; }
    else if (m && m.starting) { badge.classList.remove('hidden'); badge.textContent = 'Metro starting…'; btn.textContent = '⏳ Starting'; }
    else { badge.classList.add('hidden'); btn.textContent = '▶ Test'; }
  }

  function onTest() {
    const pid = state.activeProjectId;
    const m = activeMetro();
    if (m && m.running) return openDevClient(pid);
    state._awaitingMetro = pid; // wait for THIS tab's project, not whatever ran last
    send({ type: 'start_metro', projectId: pid || undefined });
    toast('Starting Metro… first run can take a minute (it bundles the app).', 'info');
    // Fallback ONLY for a totally silent broker. We no longer blind-open on a timer —
    // that opened before Metro was up. The broker reports real readiness/failure.
    clearTimeout(state._metroWait);
    state._metroWait = setTimeout(() => {
      if (state._awaitingMetro === pid) {
        state._awaitingMetro = null;
        toast('Metro hasn’t reported ready — watch the Terminal, then press Open.', 'error');
        if ($('terminal').classList.contains('hidden')) toggleTerminal();
      }
    }, 180000);
  }
  function openDevClient(projectId) {
    const m = (projectId && state.metroByProject[projectId]) || activeMetro();
    const url = (m && m.url) || 'exp://127.0.0.1:8081';
    appendTerminalMeta('Opening Expo: ' + url);
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
      const x = aria(el('button', 'banner-x', '✕'), 'Dismiss'); x.onclick = () => banner.remove();
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
    // The old <select> folder picker is gone (replaced by the composer folder pill +
    // folder sheet, which read state.projects); just refresh the surfaces that show it.
    renderTabs(); // project names just arrived -> refresh tab titles
    updateFolderPill();
    renderMetro(); // active project may have changed -> reflect its Metro status
    if (folderSheetOpen()) renderFolderSheet();
    if (window.Managers) window.Managers.onProjects(ev);
  }

  function onProfiles(ev) {
    state.profiles = ev.profiles || [];
    state.activeProfileId = ev.activeProfileId;
    // Engine switching now lives in ☰ → Engine (reads state.profiles, sends switch_engine).
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
    updateEffortOptions();
  }

  // Ultracode only does anything on Opus/Fable — hide the option otherwise, and
  // if it was selected on a now-unsupported model, fall back to xhigh.
  function updateEffortOptions() {
    const opt = $('ultracodeOpt');
    if (!opt) return;
    const fam = familyOf(state.selectedModel) || familyOf(state.resolvedModel);
    const supported = fam === 'opus' || fam === 'fable';
    opt.hidden = !supported;
    opt.disabled = !supported;
    if (!supported && state.effort === 'ultracode') {
      state.effort = 'xhigh';
      const sel = $('effortSelect'); if (sel) sel.value = 'xhigh';
      send({ type: 'set_effort', level: 'xhigh' });
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
  // Give an emoji/symbol-only control an accessible name (otherwise screen
  // readers announce just the glyph, e.g. "✕").
  function aria(e, label) { if (e) { e.setAttribute('aria-label', label); if (!e.title) e.title = label; } return e; }
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
  // Only auto-scroll when the user is already pinned to the bottom, so reading
  // earlier content while the agent streams doesn't keep yanking them down. A user
  // action (sending a message) re-pins via scrollDown(true).
  function scrollDown(force) {
    const t = $('transcript');
    // During a bulk replay we suppress per-record scrolling and jump once at the
    // end (hundreds of intermediate scrolls were wasted layout work).
    if (state._replaying && !force) return;
    if (force) state._pinBottom = true;
    if (state._pinBottom !== false) {
      // Jump INSTANTLY (the transcript has CSS scroll-behavior:smooth) so the
      // auto-scroll doesn't animate through intermediate positions — those frames
      // re-fire the scroll handler and made the jump button flicker / lag.
      const prev = t.style.scrollBehavior; t.style.scrollBehavior = 'auto';
      t.scrollTop = t.scrollHeight;
      t.style.scrollBehavior = prev;
    } else maybeShowJumpButton();
  }
  function nearBottom() { const t = $('transcript'); return t.scrollHeight - t.scrollTop - t.clientHeight < 120; }
  function onTranscriptScroll() {
    state._pinBottom = nearBottom();
    if (state._pinBottom) { const j = document.getElementById('jumpBtn'); if (j) j.remove(); }
    else maybeShowJumpButton(); // show "jump to latest" whenever the user is scrolled up
  }
  function maybeShowJumpButton() {
    if (document.getElementById('jumpBtn')) return;
    const j = el('button', 'jump-btn', '↓ New messages');
    j.id = 'jumpBtn';
    j.onclick = () => { j.remove(); scrollDown(true); };
    document.body.appendChild(j);
  }
  function toast(msg, kind, action) {
    const t = el('div', 'toast ' + (kind || 'info'));
    t.appendChild(el('span', '', msg));
    if (action && action.label) {
      const b = el('button', 'toast-action', action.label);
      b.onclick = () => { t.remove(); action.fn && action.fn(); };
      t.appendChild(b);
    }
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), action ? 15000 : 4000); // give actions time to be tapped
  }
  window.Agent.toast = toast;

  // Result of an in-app self-update (git pull). Web-UI changes apply on reload;
  // broker-code changes need a broker restart (we can't restart ourselves).
  function onAppUpdate(ev) {
    if (ev.state === 'updating' && ev.ok === undefined) return; // progress ping
    if (!ev.ok) { toast(ev.message || 'Update failed', 'error'); return; }
    if (ev.upToDate) { toast('You’re on the latest version', 'info'); return; }
    const ver = ev.toSha ? ` (${ev.toSha})` : '';
    if (ev.needsRestart) {
      toast(`Updated${ver} — restart the broker (Ctrl-C, then re-run) to apply`, 'info');
    } else if (ev.needsReload) {
      toast(`Update ready${ver}`, 'info', { label: 'Reload', fn: () => location.reload() });
    } else {
      toast(`Updated${ver}`, 'info');
    }
  }

  // ---- composer & controls -------------------------------------------------

  function doSend() {
    if (state.activity !== 'idle') return; // a turn is in flight or awaiting approval
    state._pinBottom = true; // sending re-pins to the bottom so you see your message + reply
    const j = document.getElementById('jumpBtn'); if (j) j.remove();
    const input = $('input');
    const text = input.value.trim();
    const images = state.attachments.map((a) => ({ mime: a.mime, dataBase64: a.dataBase64 }));
    if (!text && !images.length) return;
    // Tag this send so its server echo stamps THIS bubble, not whichever bubble
    // happens to be last (rapid double-send used to cross the wires).
    const pendingId = 'p' + (++state._sendSeq);
    if (text) state.pendingSent.push({ id: pendingId, text: text.trim() }); // only dedupe non-empty echoes
    // Paint the feedback FIRST — button -> Stop, typing dots — before serializing
    // and sending the (possibly large) payload, so big prompts still feel instant.
    addUserMessage(text + (images.length ? `\n📎 ${images.length} image${images.length === 1 ? '' : 's'}` : ''), null, pendingId);
    input.value = '';
    clearAttachments();
    autoGrow();
    hideSlashPalette();
    hideMentionPalette();
    // A session with no live engine (idle-evicted / sleeping) must be woken first —
    // tell the user that's happening instead of leaving the composer looking inert.
    const liveAct = state.sessions.find((s) => s.key === state.activeKey);
    const waking = !liveAct || liveAct.sleeping;
    setActivity('working', waking ? 'Waking up…' : 'Thinking…');
    beginAwaiting(waking ? 8000 : 2000); // latch the indicator until the engine responds
    const payload = { type: 'user_message', text, images: images.length ? images : undefined };
    requestAnimationFrame(() => send(payload)); // send after the UI has painted
  }

  // ---- fullscreen prompt editor --------------------------------------------

  function openFullEditor() {
    const fe = $('fullEditor');
    const fet = $('fullEditorText');
    fet.value = $('input').value;
    fe.classList.remove('hidden');
    setTimeout(() => { fet.focus(); try { fet.setSelectionRange(fet.value.length, fet.value.length); } catch {} }, 20);
  }
  // sendAfter=true: collapse, sync text back, and fire the send.
  function closeFullEditor(sendAfter) {
    const fe = $('fullEditor');
    $('input').value = $('fullEditorText').value;
    fe.classList.add('hidden');
    autoGrow();
    if (sendAfter) { requestNotify(); doSend(); }
    else $('input').focus();
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
      const x = aria(el('button', 'attach-x', '✕'), 'Remove attachment');
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
    ta.style.height = Math.min(ta.scrollHeight, 168) + 'px';
    // Light up the circular send button when there's something to send (iMessage).
    const composer = document.querySelector('.composer');
    if (composer) composer.classList.toggle('has-text', !!ta.value.trim() || state.attachments.length > 0);
    // Offer the fullscreen editor once the draft grows past ~5 lines.
    const expand = $('expandBtn');
    if (expand) expand.classList.toggle('hidden', (ta.value.match(/\n/g) || []).length < 5);
    syncSlashHighlight();
    syncComposerInset();
  }

  // Highlight a leading /slash-command in place. We mirror the textarea text into a
  // backdrop and colour just the command token; the backdrop is only shown (and the
  // textarea text made transparent) while the draft actually starts with a command,
  // so ordinary prose typing is completely untouched.
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function syncSlashHighlight() {
    const ta = $('input');
    const hl = $('inputHl');
    const wrap = ta && ta.closest('.composer-input-wrap');
    if (!ta || !hl || !wrap) return;
    const v = ta.value;
    const m = v.match(/^\/[\w:-]+/); // command token at the very start of the draft
    if (!m) { wrap.classList.remove('slash-active'); hl.textContent = ''; return; }
    const rest = v.slice(m[0].length);
    hl.innerHTML = '<span class="slash-tok">' + escapeHtml(m[0]) + '</span>' + escapeHtml(rest);
    wrap.classList.add('slash-active');
    hl.scrollTop = ta.scrollTop;
  }

  // The composer floats over the transcript; reserve room so the last message
  // can scroll clear of the card (which is taller when the draft/attachments grow).
  function syncComposerInset() {
    const dock = document.querySelector('.composer-dock');
    const tr = $('transcript');
    if (!dock || !tr) return;
    const inset = Math.round(dock.getBoundingClientRect().height) + 34; // + scrim
    tr.style.paddingBottom = inset + 'px';
    tr.style.scrollPaddingBottom = inset + 'px';
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
    state._pinBottom = true;
    $('transcript').addEventListener('scroll', onTranscriptScroll, { passive: true });

    // While the agent is working the send button becomes a Stop button.
    const sendOrStop = () => {
      if (state.activity === 'working') { send({ type: 'interrupt' }); setActivity('idle'); return; }
      requestNotify(); doSend();
    };
    $('sendBtn').onclick = sendOrStop;
    // Fullscreen editor (expand button appears once the draft passes ~5 lines).
    $('expandBtn').onclick = openFullEditor;
    $('fullEditorClose').onclick = () => closeFullEditor(false);
    $('fullEditorSend').onclick = () => closeFullEditor(true);
    $('fullEditorText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeFullEditor(true); }
      if (e.key === 'Escape') { e.preventDefault(); closeFullEditor(false); }
    });
    // Keep the transcript inset correct when the keyboard/viewport resizes.
    window.addEventListener('resize', syncComposerInset);
    $('input').addEventListener('keydown', (e) => {
      // Enter inserts a newline (phone keyboards have no Shift+Enter). Send is the
      // button; Ctrl/Cmd+Enter also sends for desktop keyboards.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); requestNotify(); doSend(); }
      if (e.key === 'Escape') { hideSlashPalette(); hideMentionPalette(); }
    });
    $('input').addEventListener('input', () => { autoGrow(); updateSlashPalette(); updateMentionPalette(); });
    // Keep the slash-command highlight backdrop aligned when the textarea scrolls.
    $('input').addEventListener('scroll', () => { const hl = $('inputHl'); if (hl) hl.scrollTop = $('input').scrollTop; });
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

    // Delegated copy for code blocks (survives the per-frame markdown re-render).
    $('transcript').addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.code-copy');
      if (!btn) return;
      e.stopPropagation();
      copyToClipboard(btn.dataset.copy || '');
      const prev = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 1200);
    });

    // Long-press (touch) / right-click (desktop) a message bubble -> action menu.
    const bubbleAt = (e) => {
      const m = e.target.closest && e.target.closest('.msg.user, .msg.assistant');
      if (!m || m.id === 'activityRow' || !m.querySelector('.bubble')) return null;
      if (m.querySelector('.bubble.selecting')) return null; // in text-select mode: let the OS handle the long-press
      return m;
    };
    // Drop text-select mode once the selection is cleared (user tapped away).
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) document.querySelectorAll('.bubble.selecting').forEach((x) => x.classList.remove('selecting'));
    });
    let _lp = null, _lpStart = null;
    const tr = $('transcript');
    tr.addEventListener('touchstart', (e) => {
      const m = bubbleAt(e); if (!m) return;
      _lpStart = e.touches[0];
      _lp = setTimeout(() => { _lp = null; if (navigator.vibrate) try { navigator.vibrate(8); } catch {} openBubbleMenu(m, m.classList.contains('user')); }, 500);
    }, { passive: true });
    tr.addEventListener('touchmove', (e) => {
      if (!_lp || !_lpStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - _lpStart.clientX) > 10 || Math.abs(t.clientY - _lpStart.clientY) > 10) { clearTimeout(_lp); _lp = null; }
    }, { passive: true });
    const cancelLp = () => { if (_lp) { clearTimeout(_lp); _lp = null; } };
    tr.addEventListener('touchend', cancelLp);
    tr.addEventListener('touchcancel', cancelLp);
    tr.addEventListener('contextmenu', (e) => {
      const m = bubbleAt(e); if (!m) return;
      e.preventDefault(); openBubbleMenu(m, m.classList.contains('user'));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBubbleMenu(); });

    $('undoBtn').onclick = () => {
      if (!state.checkpoints.length) return;
      if (confirm(`Rewind the project to before "${state.checkpoints[0].label}"? Files the agent changed this turn will be reverted.`)) {
        send({ type: 'checkpoint_restore', id: state.checkpoints[0].id });
      }
    };

    // (The dedicated Stop button was removed — the Send button becomes Stop while
    //  the agent is working. The command palette still offers "Interrupt".)
    $('interruptBtn') && ($('interruptBtn').onclick = () => { send({ type: 'interrupt' }); setActivity('idle'); });
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
    $('termCopy').onclick = () => {
      const text = $('termBody').innerText || $('termBody').textContent || '';
      copyToClipboard(text);
      toast(`Copied terminal output (${text.split('\n').length} lines)`, 'info');
    };
    // Ctrl-C: stop whatever's running from the terminal — the foreground `run`
    // command AND the active project's Metro (the "runtime"). Harmless if idle.
    $('termCtrlC').onclick = () => {
      send({ type: 'run_stop' });
      if (state.activeProjectId) send({ type: 'stop_metro', projectId: state.activeProjectId });
      appendTerminalMeta('^C — stopping the running command + Metro');
      toast('Sent ⌃C — stopping running command + Metro', 'info');
    };
    $('termInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const line = e.target.value;
        if (runActive) {
          // A command is live — send this line to its stdin so interactive CLIs
          // (e.g. `claude` then `/login`, or `claude setup-token`) can be driven
          // from the phone. Echo it locally since stdin isn't reflected back.
          appendTerminal(line + '\n', 'meta');
          send({ type: 'run_input', data: line + '\n' });
        } else {
          const cmd = line.trim();
          if (cmd) { appendTerminalMeta('$ ' + cmd); send({ type: 'run', command: cmd }); }
        }
        e.target.value = '';
      }
    });
    const termStop = $('termStop');
    if (termStop) termStop.onclick = () => send({ type: 'run_stop' });

    $('menuBtn').onclick = () => window.Managers && window.Managers.open();
    $('bgSessions') && ($('bgSessions').onclick = () => window.Managers && window.Managers.openTab('sessions'));

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

    $('modelSelect').onchange = (e) => { state.selectedModel = e.target.value; updateEffortOptions(); send({ type: 'switch_model', model: e.target.value }); };
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

    // + : tap = new session in current folder; long-press = folder switcher sheet.
    if ($('tabNew')) onLongPress($('tabNew'), openFolderSheet, () => send({ type: 'new_session' }));
    $('folderPill') && ($('folderPill').onclick = openFolderSheet);
    $('folderSheetScrim') && ($('folderSheetScrim').onclick = closeFolderSheet);
    // File-tab view toolbar.
    $('fvRendered') && ($('fvRendered').onclick = () => { const t = activeFileTab(); if (t) { t._mode = 'rendered'; renderFileView(t); } });
    $('fvSource') && ($('fvSource').onclick = () => { const t = activeFileTab(); if (t) { t._mode = 'source'; renderFileView(t); } });
    $('fvSave') && ($('fvSave').onclick = () => { const t = activeFileTab(); if (t) saveFileTab(t); });
    $('fvDownload') && ($('fvDownload').onclick = () => { const t = activeFileTab(); if (t) downloadFile(t.filePath, t.title); });
    $('fvClose') && ($('fvClose').onclick = () => { const t = activeFileTab(); if (t) closeTab(t.id); });
    restoreTabs(); // show persisted tabs immediately; SESSIONS reconciles liveness
    connect();
    // Reserve transcript space under the floating composer (after first layout).
    requestAnimationFrame(syncComposerInset);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
