/*
 * managers.js — the management surface that makes this more than a chat client:
 * first-class editors for Skills, Agents, Commands, Memory, Permissions, plus a
 * Sessions browser, Projects, a live Context inspector, and an MCP/Plugins view.
 * Talks to the broker via window.Agent.send and renders 'config'/'capabilities'
 * events relayed from app.js.
 */
(function () {
  'use strict';
  const A = window.Agent;
  const send = (c) => A.send(c);
  const esc = A.esc;
  const root = document.getElementById('managerModal');

  const TABS = [
    { id: 'update', label: '↻ Update' },
    { id: 'files', label: 'Files' },
    { id: 'fileman', label: '🗂 File Manager' },
    { id: 'scripts', label: 'Scripts' },
    { id: 'git', label: 'Git' },
    { id: 'checkpoints', label: 'Checkpoints' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'skills', label: 'Skills', kind: 'skills' },
    { id: 'agents', label: 'Agents', kind: 'agents' },
    { id: 'commands', label: 'Commands', kind: 'commands' },
    { id: 'output-styles', label: 'Output styles', kind: 'output-styles' },
    { id: 'memory', label: 'Memory', kind: 'memory' },
    { id: 'permissions', label: 'Permissions', kind: 'settings' },
    { id: 'engine', label: 'Engine' },
    { id: 'system', label: 'System' },
    { id: 'hooks', label: 'Hooks' },
    { id: 'sessions', label: 'Sessions', kind: 'sessions' },
    { id: 'projects', label: 'Projects' },
    { id: 'context', label: 'Context' },
    { id: 'usage', label: 'Usage' },
    { id: 'mcp', label: 'MCP / Plugins' },
  ];

  const m = {
    tab: 'files',
    scope: 'project',
    items: {}, // kind -> items
    loaded: new Set(), // data keys whose first response has arrived (else: show "Loading…")
    caps: null,
    projects: [],
    profiles: [],
    lastContext: null,
    editing: null, // { kind, name, fields, body }
    filePath: '.',
    fileEntries: null,
    changed: [],
    openFile: null, // { path, content }
    editingFile: false,
    diffView: null, // { path, before, after, status }
    grep: null, // { query, matches }
    checkpoints: { items: [], enabled: false },
    checkpointDiff: null, // { id, files, stat }
    prompts: [],
    scripts: { items: [], running: [] },
    autoverify: { enabled: false, command: 'npm test', maxIterations: 3 },
    usageStats: null,
    browse: null, // { path, parent, dirs } folder picker
    fsPath: null, // File Manager: current absolute dir (null = home on first open)
    fsList: null, // File Manager: last { path, parent, entries, truncated, error }
    tabOrder: [], // MRU order of manager pane ids (persisted in userSettings.manage.tabOrder)
    appVersion: null, // { sha, subject, when, branch, dirty }
    appUpdate: null, // last update result
    updating: false,
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- shell ---------------------------------------------------------------

  function open() {
    root.classList.remove('hidden');
    render();
    requestTabData();
  }
  function openTab(tabId) {
    if (TABS.some((t) => t.id === tabId)) { m.tab = tabId; m.editing = null; }
    open();
  }
  function close() { root.classList.add('hidden'); }
  // Escape closes the modal (desktop expectation; harmless on touch).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.classList.contains('hidden')) { e.stopPropagation(); close(); }
  });

  function render() {
    root.innerHTML = '';
    const card = el('div', 'modal-card mgr');
    const head = el('div', 'modal-head');
    head.appendChild(el('h2', '', 'Manage'));
    const x = el('button', 'icon-btn', '✕'); x.onclick = close;
    head.appendChild(x);
    card.appendChild(head);

    const layout = el('div', 'mgr-layout');
    // Glass "navbar" container holds the scrolling chip row; the row itself fades
    // its trailing edge so the offscreen chips read as scrollable.
    const tabsWrap = el('div', 'mgr-tabs-wrap');
    const tabs = el('div', 'mgr-tabs');
    renderChips(tabs);
    tabsWrap.appendChild(tabs);
    layout.appendChild(tabsWrap);

    const pane = el('div', 'mgr-pane');
    pane.id = 'mgrPane';
    layout.appendChild(pane);
    card.appendChild(layout);
    root.appendChild(card);
    root.onclick = (e) => { if (e.target === root) close(); };

    renderPane();
  }

  // ---- chip row: search + most-recently-used ordering ---------------------

  // (Re)build only the chip strip in place — never recreates the modal card, so
  // the sheet-up entry animation is NOT replayed on a tab switch.
  function renderChips(tabsEl) {
    tabsEl.innerHTML = '';
    tabsEl.appendChild(buildSearchChip(tabsEl)); // always first
    for (const t of orderedTabs()) {
      const b = el('button', 'mgr-tab' + (t.id === m.tab ? ' active' : ''), t.label);
      b.dataset.fmlabel = t.label.toLowerCase();
      b.onclick = () => selectTab(t.id);
      tabsEl.appendChild(b);
    }
  }

  // A user picked a chip: promote it (MRU) + switch panes, all WITHOUT rebuilding
  // the modal (which used to replay the springy sheet-up slide — the "pushes down
  // then snaps up" jank).
  function selectTab(id) {
    if (id !== m.tab) m.editing = null;
    m.tab = id;
    promoteTab(id);
    softSwitch(id);
    requestTabData();
  }

  // Switch the active pane in place: rebuild the chip strip (active + MRU order)
  // and swap the pane content with a quick cross-fade. Falls back to a full render
  // if the modal isn't built yet.
  function softSwitch(tab) {
    m.tab = tab;
    const tabsEl = document.querySelector('.mgr-tabs');
    if (!tabsEl) { render(); return; }
    renderChips(tabsEl);
    renderPane();
    const pane = document.getElementById('mgrPane');
    if (pane) { pane.classList.remove('pane-swap'); void pane.offsetWidth; pane.classList.add('pane-swap'); }
  }

  // TABS ordered by the persisted MRU list first (most-recent leftmost), then any
  // panes the user hasn't picked yet in their natural order. The search chip is
  // rendered separately and always sits before this list.
  function orderedTabs() {
    const byId = new Map(TABS.map((t) => [t.id, t]));
    const seen = new Set();
    const out = [];
    for (const id of (m.tabOrder || [])) { const t = byId.get(id); if (t && !seen.has(id)) { out.push(t); seen.add(id); } }
    for (const t of TABS) if (!seen.has(t.id)) out.push(t);
    return out;
  }
  // Move a pane to the front of the MRU order and persist — so a user's most-used
  // pages drift to the easy-to-reach left edge over time.
  function promoteTab(id) {
    const next = [id, ...(m.tabOrder || []).filter((x) => x !== id)];
    m.tabOrder = next;
    if (window.Agent && window.Agent.patchUserSettings) window.Agent.patchUserSettings({ manage: { tabOrder: next } });
  }

  // An icon button that expands into a live filter box. Typing hides chips whose
  // label doesn't match — without re-rendering, so the keyboard/focus is kept.
  function buildSearchChip(tabsEl) {
    const wrap = el('div', 'mgr-search');
    const btn = el('button', 'mgr-search-btn'); btn.type = 'button';
    btn.setAttribute('aria-label', 'Search panes'); btn.innerHTML = '🔍';
    const input = el('input', 'mgr-search-input');
    input.type = 'text'; input.placeholder = 'Search…'; input.setAttribute('aria-label', 'Filter panes');
    const applyFilter = () => {
      const q = input.value.trim().toLowerCase();
      tabsEl.querySelectorAll('.mgr-tab').forEach((c) => {
        c.classList.toggle('fm-hidden', !!q && !(c.dataset.fmlabel || '').includes(q));
      });
    };
    const open = () => { wrap.classList.add('open'); setTimeout(() => input.focus(), 60); };
    const close = () => { input.value = ''; applyFilter(); wrap.classList.remove('open'); };
    btn.onclick = () => { if (wrap.classList.contains('open')) close(); else open(); };
    input.oninput = applyFilter;
    input.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    input.onblur = () => { if (!input.value.trim()) wrap.classList.remove('open'); };
    wrap.appendChild(btn); wrap.appendChild(input);
    return wrap;
  }

  function onUserSettings(s) {
    const order = s && s.manage && Array.isArray(s.manage.tabOrder) ? s.manage.tabOrder : [];
    m.tabOrder = order.slice();
    if (!root.classList.contains('hidden')) render();
  }

  function requestTabData() {
    const t = TABS.find((x) => x.id === m.tab);
    if (!t) return;
    if (t.kind && ['skills', 'agents', 'commands', 'output-styles', 'memory', 'settings'].includes(t.kind)) {
      send({ type: 'config_list', kind: t.kind, scope: m.scope });
    } else if (m.tab === 'sessions') {
      send({ type: 'list_sessions', scope: 'all' });
      send({ type: 'list_live_sessions' });
    } else if (m.tab === 'projects') {
      send({ type: 'list_projects' });
    } else if (m.tab === 'fileman') {
      send({ type: 'fs_browse', path: m.fsPath || '~' });
    } else if (m.tab === 'files') {
      send({ type: 'files_list', path: m.filePath });
    } else if (m.tab === 'checkpoints') {
      send({ type: 'checkpoint_list' });
    } else if (m.tab === 'prompts') {
      send({ type: 'prompts_list' });
    } else if (m.tab === 'scripts') {
      send({ type: 'scripts_list' });
      send({ type: 'autoverify_get' });
    } else if (m.tab === 'usage') {
      send({ type: 'usage_summary' });
    } else if (m.tab === 'git') {
      send({ type: 'files_list', path: '.' }); // for the changed-files count
    } else if (m.tab === 'mcp') {
      send({ type: 'config_list', kind: 'mcp', scope: m.scope });
    } else if (m.tab === 'hooks') {
      send({ type: 'config_list', kind: 'hooks', scope: m.scope });
    } else if (m.tab === 'update') {
      send({ type: 'app_version' });
    }
  }

  // Empty-vs-loading: before a pane's first response arrives, an empty list means
  // "still loading", not "nothing here" — show a spinner-y placeholder so the UI
  // doesn't flash "No X yet" (and, after a scope switch, doesn't show stale data).
  function mgrEmpty(noun, key) {
    if (key && !m.loaded.has(key)) return el('div', 'mgr-empty', 'Loading…');
    return el('div', 'mgr-empty', noun);
  }

  function renderPane() {
    const pane = document.getElementById('mgrPane');
    if (!pane) return;
    pane.innerHTML = '';
    switch (m.tab) {
      case 'update': return renderUpdate(pane);
      case 'files': return renderFiles(pane);
      case 'fileman': return renderFileManager(pane);
      case 'scripts': return renderScripts(pane);
      case 'git': return renderGit(pane);
      case 'checkpoints': return renderCheckpoints(pane);
      case 'prompts': return renderPrompts(pane);
      case 'skills': return renderResourceList(pane, 'skills', 'skill');
      case 'agents': return renderResourceList(pane, 'agents', 'agent');
      case 'commands': return renderResourceList(pane, 'commands', 'command');
      case 'output-styles': return renderResourceList(pane, 'output-styles', 'output style');
      case 'memory': return renderMemory(pane);
      case 'permissions': return renderPermissions(pane);
      case 'engine': return renderEngine(pane);
      case 'system': return renderSystem(pane);
      case 'hooks': return renderHooks(pane);
      case 'sessions': return renderSessions(pane);
      case 'projects': return renderProjects(pane);
      case 'context': return renderContext(pane);
      case 'usage': return renderUsage(pane);
      case 'mcp': return renderMcp(pane);
    }
  }

  // ---- engine picker (relocated here from the old top context bar) ---------

  function renderEngine(pane) {
    const st = (window.Agent && window.Agent.state) || {};
    const profiles = (st.profiles && st.profiles.length ? st.profiles : m.profiles) || [];
    const active = st.activeProfileId || null;
    pane.appendChild(el('p', 'mgr-hint', 'Which agent engine drives your sessions (Claude Code, OpenCode, …).'));
    const list = el('div', 'engine-list');
    for (const p of profiles) {
      const row = el('button', 'engine-row' + (p.id === active ? ' active' : ''), '');
      row.appendChild(el('span', 'engine-name', p.label + (p.ready ? '' : ' ⚠')));
      if (p.id === active) row.appendChild(el('span', 'engine-check', '✓'));
      row.onclick = () => { send({ type: 'switch_engine', profileId: p.id }); setTimeout(renderPane, 120); };
      list.appendChild(row);
    }
    if (!profiles.length) list.appendChild(el('p', 'mgr-hint', 'No engines configured.'));
    pane.appendChild(list);
  }

  // ---- System: device RAM + live engines (off the RESOURCES stream) --------

  function fmtIdle(ms) {
    const s = Math.floor((ms || 0) / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  function renderSystem(pane) {
    const r = (window.Agent && window.Agent.state.resources) || null;
    if (!r) { pane.appendChild(el('p', 'mgr-hint', 'Gathering resource metrics…')); return; }
    const mem = r.mem || {};
    const card = el('div', 'sys-card');
    card.appendChild(el('div', 'sys-label', 'Device memory' + (r.hasProc ? '' : ' (approx — no /proc here)')));
    const bar = el('div', 'sys-bar');
    const fill = el('div', 'sys-bar-fill' + (mem.usedPct >= 88 ? ' hot' : mem.usedPct >= 70 ? ' warm' : ''));
    fill.style.width = Math.max(2, Math.min(100, mem.usedPct || 0)) + '%';
    bar.appendChild(fill); card.appendChild(bar);
    card.appendChild(el('div', 'sys-sub', `${mem.usedMb || 0} MB used · ${mem.availMb || 0} MB free · ${mem.totalMb || 0} MB total · ${mem.usedPct || 0}%`));
    const meta = el('div', 'sys-meta');
    meta.appendChild(el('span', '', `broker ${r.broker?.rssMb ?? '—'} MB`));
    meta.appendChild(el('span', '', `agents ${r.agentsRssMb ?? 0} MB`));
    if (r.cpu) meta.appendChild(el('span', '', `load ${r.cpu.load1}`));
    card.appendChild(meta);
    pane.appendChild(card);

    pane.appendChild(el('div', 'sys-heading', `Live agents (${(r.engines || []).length})`));
    const list = el('div', 'sys-engines');
    for (const e of r.engines || []) {
      const row = el('div', 'sys-engine' + (e.active ? ' active' : ''));
      const info = el('div', 'sys-engine-info');
      const pn = (m.projects || []).find((p) => p.id === e.projectId)?.name;
      const label = e.title || pn || e.projectId || (e.key === '__main__' || /^__main__/.test(e.key) ? 'No folder' : e.key);
      const name = el('div', 'sys-engine-name', label + (e.pinned ? ' 📌' : ''));
      const sub = el('div', 'sys-engine-sub',
        `${e.status === 'working' ? '● working' : '○ idle ' + fmtIdle(e.idleMs)} · ${e.rssMb != null ? e.rssMb + ' MB' : '—'}` + (e.active ? ' · focused' : ''));
      info.appendChild(name); info.appendChild(sub);
      const acts = el('div', 'sys-engine-acts');
      const pin = el('button', 'ghost small', e.pinned ? 'Unpin' : 'Pin');
      pin.title = e.pinned ? 'Allow idle eviction' : 'Keep warm (never idle-evict)';
      pin.onclick = () => send({ type: 'session_pin', key: e.key, pinned: !e.pinned });
      const stop = el('button', 'ghost small', 'Stop');
      stop.title = 'Free this agent’s process (transcript kept; resumes on use)';
      stop.disabled = !!e.active;
      stop.onclick = () => send({ type: 'session_stop', key: e.key });
      acts.appendChild(pin); acts.appendChild(stop);
      row.appendChild(info); row.appendChild(acts);
      list.appendChild(row);
    }
    if (!(r.engines || []).length) list.appendChild(el('p', 'mgr-hint', 'No live agents.'));
    pane.appendChild(list);
  }
  function onResources() { if (!root.classList.contains('hidden') && m.tab === 'system') renderPane(); }

  // ---- scope switch --------------------------------------------------------

  function scopeBar() {
    const bar = el('div', 'scope-bar');
    ['project', 'user'].forEach((s) => {
      const b = el('button', 'chip' + (m.scope === s ? ' on' : ''), s);
      b.onclick = () => {
        m.scope = s;
        // The current list is now stale for the new scope — drop its loaded flag so
        // renderPane shows "Loading…" until the new-scope response arrives (instead
        // of briefly showing the old scope's items).
        ['skills', 'agents', 'commands', 'output-styles', 'memory', 'settings', 'mcp', 'hooks'].forEach((k) => m.loaded.delete(k));
        renderPane(); requestTabData();
      };
      bar.appendChild(b);
    });
    return bar;
  }

  // ---- skills / agents / commands ------------------------------------------

  function renderResourceList(pane, kind, noun) {
    pane.appendChild(scopeBar());
    if (m.editing && m.editing.kind === kind) return renderEditor(pane, kind, noun);

    const items = m.items[kind] || [];
    const list = el('div', 'mgr-list');
    if (!items.length) list.appendChild(mgrEmpty(`No ${noun}s in ${m.scope} scope yet.`, kind));
    for (const it of items) {
      const row = el('div', 'mgr-row');
      const info = el('div', 'mgr-row-info');
      info.appendChild(el('div', 'mgr-row-name', it.name));
      info.appendChild(el('div', 'mgr-row-desc', it.description || it.command || it.model || ''));
      row.appendChild(info);
      const actions = el('div', 'mgr-row-actions');
      if (kind === 'skills' || kind === 'commands') {
        const run = el('button', 'ghost small', 'Run');
        run.onclick = () => { send({ type: 'slash_command', name: it.name }); close(); };
        actions.appendChild(run);
      }
      if (kind === 'agents') {
        const run = el('button', 'ghost small', 'Invoke');
        run.onclick = () => { send({ type: 'user_message', text: `@agent-${it.name} ` }); close(); };
        actions.appendChild(run);
      }
      if (kind === 'output-styles') {
        const use = el('button', 'ghost small', 'Use');
        use.onclick = () => { send({ type: 'slash_command', name: 'output-style', args: it.name }); close(); };
        actions.appendChild(use);
      }
      const edit = el('button', 'ghost small', 'Edit');
      edit.onclick = () => send({ type: 'config_read', kind, name: it.name, scope: m.scope });
      const del = el('button', 'ghost small', 'Delete');
      del.onclick = () => { if (confirm(`Delete ${noun} "${it.name}"?`)) send({ type: 'config_delete', kind, name: it.name, scope: m.scope }); };
      actions.appendChild(edit); actions.appendChild(del);
      row.appendChild(actions);
      list.appendChild(row);
    }
    pane.appendChild(list);
    const add = el('button', 'primary small', `+ New ${noun}`);
    add.onclick = () => { m.editing = { kind, name: '', fields: {}, body: defaultBody(kind), isNew: true }; renderPane(); };
    pane.appendChild(add);
  }

  function defaultBody(kind) {
    if (kind === 'skills') return 'Describe what this skill does and the steps to follow.\n';
    if (kind === 'agents') return 'You are a focused subagent. Describe the role and constraints here.\n';
    if (kind === 'output-styles') return 'Describe the tone and format the assistant should use (e.g. terse, bullet-first, teaching style).\n';
    return 'Command instructions. Use $ARGUMENTS for input.\n';
  }

  function renderEditor(pane, kind, noun) {
    const e = m.editing;
    const f = e.fields || {};
    const wrap = el('div', 'mgr-editor');
    // Name is editable only for a NEW resource (it's the file/dir name); editing
    // an existing one keeps the name fixed so Save updates rather than forks it.
    wrap.appendChild(field('Name', e.name, (v) => (e.name = v), e.isNew ? '' : null, !e.isNew));
    wrap.appendChild(field('Description', f.description || '', (v) => (f.description = v)));
    if (kind === 'skills') {
      wrap.appendChild(field('Allowed tools (comma-sep)', f.allowedTools || '', (v) => (f.allowedTools = v)));
      wrap.appendChild(field('Model (optional)', f.model || '', (v) => (f.model = v)));
    } else if (kind === 'agents') {
      wrap.appendChild(field('Tools (comma-sep)', f.tools || '', (v) => (f.tools = v)));
      wrap.appendChild(field('Model (sonnet/opus/haiku/inherit)', f.model || '', (v) => (f.model = v)));
    } else if (kind === 'mcp') {
      wrap.appendChild(field('Command (stdio) or URL (http)', f.command || '', (v) => (f.command = v), 'npx -y @scope/server  OR  https://host/mcp'));
      wrap.appendChild(field('Args (space-sep, stdio only)', f.args || '', (v) => (f.args = v)));
      wrap.appendChild(field('Transport (stdio | http | sse)', f.transport || 'stdio', (v) => (f.transport = v)));
    } else if (kind === 'output-styles') {
      /* description (above) + body only */
    } else {
      wrap.appendChild(field('Argument hint', f.argumentHint || '', (v) => (f.argumentHint = v)));
      wrap.appendChild(field('Allowed tools', f.allowedTools || '', (v) => (f.allowedTools = v)));
    }
    if (kind !== 'mcp') {
      const bodyLabel = kind === 'agents' ? 'System prompt' : kind === 'skills' ? 'Skill instructions'
        : kind === 'output-styles' ? 'Style instructions' : 'Command body';
      wrap.appendChild(textarea(bodyLabel, e.body || '', (v) => (e.body = v)));
    }

    const actions = el('div', 'mgr-editor-actions');
    const save = el('button', 'primary small', 'Save');
    save.onclick = () => {
      const raw = e.name.trim();
      if (!raw) return alert('Name is required');
      const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '-');
      // Don't silently rewrite the typed name — tell the user what it'll be saved as.
      if (safe !== raw && !confirm(`Names allow only letters, numbers, "-" and "_".\nSave as "${safe}"?`)) return;
      send({ type: 'config_write', kind, name: safe, scope: m.scope, fields: f, body: e.body });
      m.editing = null;
    };
    const cancel = el('button', 'ghost small', 'Cancel');
    cancel.onclick = () => { m.editing = null; renderPane(); };
    actions.appendChild(save); actions.appendChild(cancel);
    wrap.appendChild(actions);
    pane.appendChild(wrap);
  }

  // ---- memory --------------------------------------------------------------

  function renderMemory(pane) {
    const items = m.items.memory || [];
    pane.appendChild(el('p', 'mgr-hint', 'CLAUDE.md instructions loaded every session. Project scope is shared via git; Local is gitignored; User applies to all projects.'));
    for (const it of items) {
      const block = el('div', 'mem-block');
      const h = el('div', 'mem-head');
      h.appendChild(el('span', '', it.label + (it.exists ? ` · ${it.size} B` : ' · empty')));
      block.appendChild(h);
      const ta = el('textarea', 'mem-text');
      ta.value = it._content || '';
      ta.placeholder = '(empty — type to create)';
      ta.dataset.id = it.id;
      block.appendChild(ta);
      const save = el('button', 'primary small', 'Save');
      save.onclick = () => send({ type: 'config_write', kind: 'memory', name: it.id, content: ta.value });
      block.appendChild(save);
      pane.appendChild(block);
      // lazily fetch content
      if (it.exists && it._content == null) send({ type: 'config_read', kind: 'memory', name: it.id });
    }
  }

  // ---- permissions ---------------------------------------------------------

  function renderPermissions(pane) {
    const s = m.items.settings || { defaultMode: 'default', allow: [], deny: [], ask: [] };
    pane.appendChild(scopeBar());
    pane.appendChild(el('p', 'mgr-hint', 'Rules are evaluated deny → ask → allow. Specifiers: Bash(npm run test:*), Read(./src/**), WebFetch(domain:x.com), Agent(Explore), mcp__server__*.'));

    const modeRow = el('div', 'perm-mode-row');
    modeRow.appendChild(el('span', 'mgr-label', 'Default mode'));
    const sel = el('select', 'mgr-select');
    ['default', 'acceptEdits', 'plan', 'bypassPermissions'].forEach((mode) => {
      const o = document.createElement('option'); o.value = mode; o.textContent = mode;
      if (mode === s.defaultMode) o.selected = true; sel.appendChild(o);
    });
    modeRow.appendChild(sel);
    pane.appendChild(modeRow);

    const lists = {};
    ['deny', 'ask', 'allow'].forEach((bucket) => {
      const sec = el('div', 'perm-bucket');
      sec.appendChild(el('div', 'perm-bucket-title ' + bucket, bucket.toUpperCase()));
      const ul = el('div', 'perm-rules');
      lists[bucket] = [...(s[bucket] || [])];
      const redraw = () => {
        ul.innerHTML = '';
        lists[bucket].forEach((rule, i) => {
          const r = el('div', 'perm-rule');
          r.appendChild(el('code', '', rule));
          const rm = el('button', 'ghost small', '✕');
          rm.onclick = () => { lists[bucket].splice(i, 1); redraw(); };
          r.appendChild(rm);
          ul.appendChild(r);
        });
      };
      redraw();
      sec.appendChild(ul);
      const addRow = el('div', 'perm-add');
      const inp = el('input', 'mgr-input'); inp.placeholder = `add ${bucket} rule…`;
      const addBtn = el('button', 'ghost small', 'Add');
      addBtn.onclick = () => { if (inp.value.trim()) { lists[bucket].push(inp.value.trim()); inp.value = ''; redraw(); } };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.onclick(); } });
      addRow.appendChild(inp); addRow.appendChild(addBtn);
      sec.appendChild(addRow);
      pane.appendChild(sec);
    });

    const save = el('button', 'primary small', 'Save permission rules');
    save.onclick = () => send({
      type: 'config_write', kind: 'settings', scope: m.scope,
      defaultMode: sel.value, allow: lists.allow, deny: lists.deny, ask: lists.ask,
    });
    pane.appendChild(save);
  }

  // ---- hooks ---------------------------------------------------------------

  const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'Notification', 'SessionStart', 'PreCompact'];

  function renderHooks(pane) {
    pane.appendChild(scopeBar());
    pane.appendChild(el('p', 'mgr-hint', 'Shell commands the harness runs on lifecycle events (e.g. lint on PostToolUse). The matcher targets a tool (e.g. Bash, Edit) or is blank for all.'));
    const items = m.items.hooks || [];
    const list = el('div', 'mgr-list');
    if (!items.length) list.appendChild(mgrEmpty(`No hooks in ${m.scope} scope.`, 'hooks'));
    items.forEach((h) => {
      const row = el('div', 'mgr-row');
      const info = el('div', 'mgr-row-info');
      info.appendChild(el('div', 'mgr-row-name', `${h.event}${h.matcher ? ' · ' + h.matcher : ''}`));
      info.appendChild(el('div', 'mgr-row-desc', h.command));
      row.appendChild(info);
      const del = el('button', 'ghost small', 'Delete');
      del.onclick = () => { if (confirm(`Delete hook for "${h.event}"?\n${h.command || ''}`)) send({ type: 'config_delete', kind: 'hooks', name: h.name, scope: m.scope }); };
      row.appendChild(del);
      list.appendChild(row);
    });
    pane.appendChild(list);

    pane.appendChild(el('div', 'perm-bucket-title', 'ADD HOOK'));
    const f = { event: 'PostToolUse', matcher: '', command: '' };
    const add = el('div', 'mgr-editor');
    const ev = el('select', 'mgr-select');
    HOOK_EVENTS.forEach((e) => { const o = document.createElement('option'); o.value = e; o.textContent = e; ev.appendChild(o); });
    ev.value = f.event; ev.onchange = () => (f.event = ev.value);
    add.appendChild(labeled('Event', ev));
    const matcher = el('input', 'mgr-input'); matcher.placeholder = 'matcher (tool name, blank = all)'; matcher.oninput = () => (f.matcher = matcher.value);
    add.appendChild(labeled('Matcher', matcher));
    const cmd = el('input', 'mgr-input'); cmd.placeholder = 'shell command, e.g. npm run lint'; cmd.oninput = () => (f.command = cmd.value);
    add.appendChild(labeled('Command', cmd));
    const save = el('button', 'primary small', 'Add hook');
    save.onclick = () => { if (f.command.trim()) { send({ type: 'config_write', kind: 'hooks', name: f.event, scope: m.scope, fields: { ...f } }); matcher.value = ''; cmd.value = ''; f.matcher = ''; f.command = ''; } };
    add.appendChild(save);
    pane.appendChild(add);
  }
  function labeled(label, node) {
    const w = el('div', 'mgr-field');
    w.appendChild(el('label', '', label));
    w.appendChild(node);
    return w;
  }

  // ---- sessions ------------------------------------------------------------

  function relTime(ms) {
    const s = Math.max(1, Math.round((nowMs() - ms) / 1000));
    if (s < 60) return s + 's ago';
    const mn = Math.round(s / 60); if (mn < 60) return mn + 'm ago';
    const h = Math.round(mn / 60); if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  function nowMs() { return new Date().getTime(); }
  function workingDots() { const s = el('span', 'sess-dots'); s.innerHTML = '<i></i><i></i><i></i>'; return s; }
  function startRename(nameEl, s) {
    const input = el('input', 'mgr-input');
    input.value = s.summary || '';
    input.placeholder = 'Session title';
    input.style.flex = '1';
    nameEl.replaceWith(input);
    input.focus(); input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send({ type: 'session_rename', id: s.id, title: input.value.trim() }); }
      else if (e.key === 'Escape') { e.preventDefault(); renderPane(); }
    });
  }

  function renderSessions(pane) {
    pane.appendChild(el('p', 'mgr-hint', 'Your sessions, newest first, grouped by project. A pulsing dot means the agent is working there. Tap to open.'));
    const nb = el('button', 'accent small', '+ New session');
    nb.onclick = () => { send({ type: 'new_session' }); close(); };
    pane.appendChild(nb);

    // Overlay live state onto the history list, matched by session id (reliable —
    // unlike the lossy project-name grouping). Updated live via onSessions().
    const live = m.liveSessions || [];
    const busyById = new Map(); // sessionId -> busy
    const keyById = new Map();  // sessionId -> project key (to switch to a live bg session)
    const turnById = new Map(); // sessionId -> last prompt/response time (authoritative for live sessions)
    for (const s of live) if (s.sessionId) { busyById.set(s.sessionId, s.busy); keyById.set(s.sessionId, s.key); if (s.lastTurnTs) turnById.set(s.sessionId, s.lastTurnTs); }
    const activeId = (live.find((s) => s.active) || {}).sessionId || m.activeSessionId || null;

    const items = m.items.sessions || [];
    if (!items.length) { pane.appendChild(mgrEmpty('No sessions yet.', 'sessions')); return; }

    // Group by projectId (stable), not the display name — two distinct projects
    // that happen to share a folder name must not merge into one group. Fall back
    // to the encoded dir or name when no id is known.
    const groups = new Map();
    for (const s of items) {
      const k = s.projectId || s.projectDir || s.project || 'project';
      if (!groups.has(k)) groups.set(k, { label: s.project || k, sess: [] });
      groups.get(k).sess.push(s);
    }
    const order = [...groups.values()].sort((a, b) => (b.sess[0]?.mtime || 0) - (a.sess[0]?.mtime || 0));

    for (const { label: project, sess } of order) {
      const head = el('div', 'mgr-label');
      if (sess.some((s) => busyById.get(s.id))) head.appendChild(workingDots());
      head.appendChild(document.createTextNode('📁 ' + project));
      pane.appendChild(head);
      const list = el('div', 'mgr-list');
      for (const s of sess) {
        const busy = !!busyById.get(s.id);
        const isActive = s.id === activeId;
        const isLive = busyById.has(s.id); // a running engine owns this session
        const row = el('div', 'mgr-row' + (isActive ? ' active' : ''));
        const info = el('div', 'mgr-row-info');
        const name = el('div', 'mgr-row-name');
        if (busy) name.appendChild(workingDots());
        name.appendChild(document.createTextNode(s.summary || s.id));
        info.appendChild(name);
        const tag = isActive ? ' · viewing' : busy ? ' · working…' : isLive ? ' · live' : '';
        // The folder is already shown in the group header above; only flag the case
        // where resuming can't reopen the original folder (it's not a tracked project,
        // so --resume falls back to the active folder).
        const ts = turnById.get(s.id) || s.mtime; // live sessions: time since last prompt/response, not file mtime
        info.appendChild(el('div', 'mgr-row-desc', relTime(ts) + ' · ' + s.id.slice(0, 8) + tag + (!s.projectId && !isLive ? ' · opens in active folder' : '')));
        row.appendChild(info);

        const actions = el('div', 'mgr-row-actions');
        if (isActive) {
          actions.appendChild(el('span', 'badge flat', 'viewing'));
        } else {
          const open = el('button', 'ghost small', isLive ? 'Open' : 'Resume');
          open.onclick = () => {
            if (isLive && keyById.has(s.id)) send({ type: 'switch_session', key: keyById.get(s.id) });
            else send({ type: 'resume', sessionId: s.id, projectId: s.projectId || undefined, projectDir: s.projectDir });
            close();
          };
          actions.appendChild(open);
        }
        const editBtn = el('button', 'icon-mini', '✎'); editBtn.title = 'Rename';
        editBtn.onclick = () => startRename(name, s);
        actions.appendChild(editBtn);
        const del = el('button', 'icon-mini danger', '🗑'); del.title = 'Delete session';
        del.onclick = () => {
          if (confirm('Delete this session? Its conversation transcript is removed permanently. This can’t be undone.')) {
            send({ type: 'session_delete', id: s.id, projectId: s.projectId || undefined, projectDir: s.projectDir });
          }
        };
        actions.appendChild(del);
        row.appendChild(actions);
        list.appendChild(row);
      }
      pane.appendChild(list);
    }
  }

  // ---- projects ------------------------------------------------------------

  function renderProjects(pane) {
    pane.appendChild(el('div', 'perm-bucket-title', 'CURRENT & RECENT WORKSPACES'));
    const list = el('div', 'mgr-list');
    for (const p of m.projects) {
      const row = el('div', 'mgr-row' + (p.active ? ' active' : ''));
      const info = el('div', 'mgr-row-info');
      info.appendChild(el('div', 'mgr-row-name', (p.active ? '✓ ' : '') + p.name + (p.isExpo ? ' ⚛' : '')));
      info.appendChild(el('div', 'mgr-row-desc', (p.external ? p.dir : (p.hasGit ? 'git · ' : '') + 'metro :' + p.metroPort)));
      row.appendChild(info);
      const open = el('button', 'ghost small', p.active ? 'Active' : 'Open');
      if (!p.active) open.onclick = () => { send({ type: 'open_project', projectId: p.id }); close(); };
      row.appendChild(open);
      const del = el('button', 'icon-mini danger', '🗑');
      del.title = p.external ? 'Remove from list' : 'Delete project';
      del.onclick = () => {
        // Managed projects (under ~/projects) are deleted from disk; external
        // workspaces are only forgotten — never rm a folder the user opened.
        const msg = p.external
          ? `Remove “${p.name}” from your workspaces?\n\nThe folder on disk is left untouched — only this app forgets it.`
          : `Delete “${p.name}”?\n\nThis permanently deletes its folder, all its conversations and checkpoints from storage. This can’t be undone.`;
        if (confirm(msg)) send({ type: 'project_delete', id: p.id });
      };
      row.appendChild(del);
      list.appendChild(row);
    }
    if (!m.projects.length) list.appendChild(el('div', 'mgr-empty', 'No workspaces yet — open a folder below.'));
    pane.appendChild(list);

    // --- open any folder (filesystem browser) ---
    pane.appendChild(el('div', 'perm-bucket-title', 'OPEN A FOLDER'));
    if (!m.browse) send({ type: 'workspace_browse' }); // load home on first view
    const b = m.browse;
    if (b) {
      const crumb = el('div', 'mgr-hint'); crumb.textContent = '📂 ' + b.path;
      pane.appendChild(crumb);
      const fl = el('div', 'mgr-list');
      if (b.parent) {
        const up = el('div', 'mgr-row'); up.style.cursor = 'pointer';
        up.innerHTML = '<span class="mgr-row-name">⬆ ..</span>';
        up.onclick = () => send({ type: 'workspace_browse', path: b.parent });
        fl.appendChild(up);
      }
      (b.dirs || []).forEach((d) => {
        const row = el('div', 'mgr-row'); row.style.cursor = 'pointer';
        const child = b.path.replace(/\/$/, '') + '/' + d.name;
        row.innerHTML = `<span class="mgr-row-name">📁 ${esc(d.name)}${d.isProject ? ' ⚛' : ''}</span>`;
        row.onclick = () => send({ type: 'workspace_browse', path: child });
        fl.appendChild(row);
      });
      pane.appendChild(fl);
      const useBtn = el('button', 'primary small', `✓ Use this folder`);
      useBtn.onclick = () => { send({ type: 'open_path', path: b.path }); close(); };
      pane.appendChild(useBtn);
    }
    // manual path entry
    const pathRow = el('div', 'mgr-newproj');
    const pin = el('input', 'mgr-input'); pin.placeholder = 'or type a path, e.g. ~/myapp';
    const go = el('button', 'ghost small', 'Open');
    go.onclick = () => { if (pin.value.trim()) { send({ type: 'open_path', path: pin.value.trim() }); close(); } };
    pathRow.appendChild(pin); pathRow.appendChild(go);
    pane.appendChild(pathRow);

    // --- scaffold a new project under ~/projects ---
    pane.appendChild(el('div', 'perm-bucket-title', 'NEW PROJECT (under ~/projects)'));
    const add = el('div', 'mgr-newproj');
    const name = el('input', 'mgr-input'); name.placeholder = 'new-project-name';
    const tpl = el('select', 'mgr-select');
    ['expo', 'blank'].forEach((t) => { const o = document.createElement('option'); o.value = t; o.textContent = t; tpl.appendChild(o); });
    const create = el('button', 'primary small', 'Create');
    create.onclick = () => { if (name.value.trim()) { send({ type: 'create_project', name: name.value.trim(), template: tpl.value }); name.value = ''; } };
    add.appendChild(name); add.appendChild(tpl); add.appendChild(create);
    pane.appendChild(add);
  }

  // ---- context -------------------------------------------------------------

  function renderContext(pane) {
    const c = m.lastContext;
    pane.appendChild(el('p', 'mgr-hint', 'Live context-window usage. Compact summarizes history to reclaim space; Clear wipes it.'));
    const box = el('div', 'ctx-box');
    if (c) {
      const pct = Math.min(100, Math.round((c.usedTokens / c.windowTokens) * 100));
      box.appendChild(el('div', 'ctx-big', `${(c.usedTokens / 1000).toFixed(1)}k / ${(c.windowTokens / 1000).toFixed(0)}k tokens (${pct}%)`));
      const track = el('div', 'ctx-track big');
      const bar = el('div', 'ctx-bar' + (pct > 85 ? ' hot' : pct > 65 ? ' warm' : ''));
      bar.style.width = pct + '%';
      track.appendChild(bar);
      box.appendChild(track);
      box.appendChild(el('div', 'mgr-row-desc', 'model: ' + (c.model || '?')));
    } else {
      box.appendChild(el('div', 'mgr-empty', 'No context data yet — send a message first.'));
    }
    pane.appendChild(box);

    const focusRow = el('div', 'mgr-newproj');
    const focus = el('input', 'mgr-input'); focus.placeholder = 'compact focus (optional, e.g. "keep the auth work")';
    const compact = el('button', 'primary small', 'Compact');
    compact.onclick = () => {
      send({ type: 'compact', focus: focus.value.trim() || undefined });
      toast('Compacting conversation…');
      close();
    };
    focusRow.appendChild(focus); focusRow.appendChild(compact);
    pane.appendChild(focusRow);

    const ctxBtn = el('button', 'ghost small', '/context breakdown');
    ctxBtn.onclick = () => { send({ type: 'slash_command', name: 'context' }); close(); };
    const clearBtn = el('button', 'ghost small', 'Clear conversation');
    clearBtn.onclick = () => { if (confirm('Clear the conversation context?')) { send({ type: 'clear' }); close(); } };
    pane.appendChild(ctxBtn); pane.appendChild(clearBtn);
  }

  // ---- mcp / plugins -------------------------------------------------------

  function renderMcp(pane) {
    // Editable .mcp.json servers (CRUD) at the top…
    pane.appendChild(el('div', 'perm-bucket-title', 'CONFIGURED SERVERS (.mcp.json)'));
    renderResourceList(pane, 'mcp', 'MCP server');
    renderPluginInstall(pane);
    // …then the LIVE status from the running engine's capabilities.
    const caps = m.caps;
    if (!caps) { pane.appendChild(el('div', 'mgr-hint', 'Start a Claude engine to see live MCP status, tools and agents.')); return; }
    pane.appendChild(el('div', 'perm-bucket-title', 'LIVE (from engine)'));
    // section() now takes PLAIN text and escapes internally (it used to take raw
    // HTML — a footgun), so callers pass unescaped strings.
    section(pane, 'MCP servers', (caps.mcpServers || []).map((s) =>
      `${s.name || s} — ${s.status || 'unknown'}`), 'No MCP servers configured.');
    section(pane, 'Available tools', (caps.tools || []).map((t) => (typeof t === 'string' ? t : t.name)), 'No tools reported.');
    section(pane, 'Subagents', (caps.agents || []).map((a) => `${a.name || a}${a.description ? ' — ' + a.description : ''}`), 'No subagents.');
    section(pane, 'Slash commands', (caps.slashCommands || []).map((c) => (typeof c === 'string' ? c : c.name)), 'None.');
    if (caps.plugins && caps.plugins.length) section(pane, 'Plugins', caps.plugins.map((p) => p.name || p), 'None.');
    pane.appendChild(el('div', 'mgr-row-desc', `output style: ${esc(caps.outputStyle || 'default')} · auth: ${esc(caps.apiKeySource || 'oauth')}`));
  }
  function section(pane, title, lines, empty) {
    pane.appendChild(el('div', 'perm-bucket-title', title.toUpperCase()));
    const box = el('div', 'mgr-list');
    if (!lines.length) box.appendChild(el('div', 'mgr-empty', empty));
    // Build via textContent — section escapes internally now (takes plain text).
    lines.forEach((l) => { const d = el('div', 'mgr-row'); const code = document.createElement('code'); code.textContent = l; d.appendChild(code); box.appendChild(d); });
    pane.appendChild(box);
  }

  // Install Claude Code plugins via the CLI's own /plugin commands. Plugins are
  // read at session start, so after installing we reload (/reload-plugins, or a
  // session restart) to make them live. We only drive supported slash commands.
  function renderPluginInstall(pane) {
    pane.appendChild(el('div', 'perm-bucket-title', 'INSTALL A PLUGIN'));
    pane.appendChild(el('p', 'mgr-hint',
      '1) Add a marketplace (a git URL or owner/repo), 2) install a plugin from it, 3) reload. ' +
      'Installed plugins appear under LIVE below once reloaded.'));

    const mkRow = (placeholder, btnLabel, build) => {
      const row = el('div', 'mgr-row');
      const input = el('input', 'mgr-input');
      input.placeholder = placeholder;
      const btn = el('button', 'accent small', btnLabel);
      btn.onclick = () => {
        const v = input.value.trim();
        if (!v) return;
        send({ type: 'slash_command', name: 'plugin', args: build(v) });
        input.value = '';
        close(); // surface the turn so the user sees the result
      };
      row.appendChild(input); row.appendChild(btn);
      pane.appendChild(row);
    };
    mkRow('marketplace  e.g. anthropics/claude-code-plugins', 'Add marketplace', (v) => `marketplace add ${v}`);
    mkRow('plugin  e.g. my-plugin@marketplace', 'Install', (v) => `install ${v}`);

    const reload = el('button', 'ghost small', '↻ Reload plugins');
    reload.onclick = () => { send({ type: 'slash_command', name: 'reload-plugins' }); close(); };
    pane.appendChild(reload);
  }

  // ---- software update (git pull the app's own repo) -----------------------

  function renderUpdate(pane) {
    pane.appendChild(el('p', 'mgr-hint', 'Pull the latest build of the app from its git repo. UI changes apply on reload; broker changes need a broker restart.'));

    // Current version box.
    const v = m.appVersion;
    const box = el('div', 'ctx-box');
    box.appendChild(el('div', 'ctx-big', 'On-Device Agent'));
    if (v && v.ok) {
      box.appendChild(el('div', 'mgr-row-desc', `${v.subject || ''}`));
      box.appendChild(el('div', 'mgr-row-desc', `${v.sha} · ${v.branch}${v.when ? ' · ' + v.when : ''}${v.dirty ? ' · local changes' : ''}`));
    } else {
      box.appendChild(el('div', 'mgr-row-desc', v ? 'Not a git checkout — update unavailable.' : 'Reading current version…'));
    }
    pane.appendChild(box);

    // Update button.
    const btn = el('button', 'primary', m.updating ? 'Updating…' : 'Check for updates & install');
    btn.disabled = m.updating || (v && v.ok === false);
    btn.onclick = () => { m.updating = true; m.appUpdate = null; send({ type: 'app_update' }); renderPane(); };
    pane.appendChild(btn);

    // Last result.
    const r = m.appUpdate;
    if (r) {
      const res = el('div', 'ctx-box');
      res.style.marginTop = '14px';
      if (!r.ok) {
        res.appendChild(el('div', 'mgr-row-name', '⚠ Update failed'));
        res.appendChild(el('div', 'mgr-row-desc', r.message || 'git pull failed'));
      } else if (r.upToDate) {
        res.appendChild(el('div', 'mgr-row-name', '✓ Already up to date'));
      } else {
        res.appendChild(el('div', 'mgr-row-name', `✓ Updated to ${r.toSha}`));
        if (r.subject) res.appendChild(el('div', 'mgr-row-desc', r.subject));
        res.appendChild(el('div', 'mgr-row-desc', `${r.count} file${r.count === 1 ? '' : 's'} changed`));
        if (r.needsRestart) {
          res.appendChild(el('div', 'mgr-row-desc', 'Broker code changed — restart the broker (Ctrl-C, then re-run) to apply.'));
        } else if (r.needsReload) {
          const rl = el('button', 'accent small', 'Reload to apply');
          rl.style.marginTop = '8px';
          rl.onclick = () => location.reload();
          res.appendChild(rl);
        }
      }
      if (r.log) { const pre = el('pre', 'file-view'); pre.textContent = r.log; res.appendChild(pre); }
      pane.appendChild(res);
    }
  }

  // ---- files ---------------------------------------------------------------

  function renderFiles(pane) {
    // --- diff view ---
    if (m.diffView) {
      const back = el('button', 'ghost small', '← back');
      back.onclick = () => { m.diffView = null; renderPane(); };
      pane.appendChild(back);
      pane.appendChild(el('div', 'mgr-row-name', `${m.diffView.path} (${m.diffView.status})`));
      const box = el('div');
      box.innerHTML = window.DiffRender.renderDiff({ before: m.diffView.before, after: m.diffView.after });
      pane.appendChild(box);
      const discard = el('button', 'danger small', 'Discard changes');
      discard.onclick = () => { if (confirm(`Discard changes to ${m.diffView.path}?`)) { send({ type: 'git', op: 'discard', path: m.diffView.path }); m.diffView = null; send({ type: 'files_list', path: '.' }); } };
      pane.appendChild(discard);
      return;
    }
    // --- file view / inline edit ---
    if (m.openFile) {
      let ta = null; // the edit textarea, set in the editing branch below
      const dirty = () => m.editingFile && ta && ta.value !== m.openFile.content;
      const confirmDiscard = () => !dirty() || confirm(`Discard unsaved changes to ${m.openFile.path}?`);
      const back = el('button', 'ghost small', '← back');
      back.onclick = () => { if (!confirmDiscard()) return; m.openFile = null; m.editingFile = false; renderPane(); };
      pane.appendChild(back);
      pane.appendChild(el('div', 'mgr-row-name', m.openFile.path));
      if (m.editingFile) {
        ta = el('textarea', 'mgr-textarea file-edit');
        ta.value = m.openFile.content;
        pane.appendChild(ta);
        const save = el('button', 'primary small', 'Save');
        save.onclick = () => { send({ type: 'files_write', path: m.openFile.path, content: ta.value }); m.openFile.content = ta.value; m.editingFile = false; renderPane(); };
        const cancel = el('button', 'ghost small', 'Cancel');
        cancel.onclick = () => { if (!confirmDiscard()) return; m.editingFile = false; renderPane(); };
        pane.appendChild(save); pane.appendChild(cancel);
      } else {
        const pre = el('pre', 'file-view');
        pre.textContent = m.openFile.content + (m.openFile.truncated ? '\n… (truncated)' : '');
        pane.appendChild(pre);
        const edit = el('button', 'ghost small', 'Edit');
        edit.onclick = () => { m.editingFile = true; renderPane(); };
        const asTab = el('button', 'ghost small', '↗ Open as tab');
        asTab.onclick = () => { close(); if (window.Agent && window.Agent.openFileTab) window.Agent.openFileTab(m.openFile.path); };
        const ref = el('button', 'ghost small', 'Reference (@)');
        ref.onclick = () => { const inp = document.getElementById('input'); inp.value += (inp.value && !inp.value.endsWith(' ') ? ' ' : '') + '@' + m.openFile.path + ' '; close(); inp.focus(); };
        pane.appendChild(edit); pane.appendChild(asTab); pane.appendChild(ref);
      }
      return;
    }
    // --- content search ---
    const searchRow = el('div', 'mgr-newproj');
    const q = el('input', 'mgr-input'); q.placeholder = 'search file contents…'; q.id = 'grepInput';
    if (m.grep) q.value = m.grep.query;
    const go = el('button', 'ghost small', 'Search');
    const doGrep = () => { if (q.value.trim()) send({ type: 'files_grep', query: q.value.trim() }); };
    go.onclick = doGrep;
    q.onkeydown = (e) => { if (e.key === 'Enter') doGrep(); };
    searchRow.appendChild(q); searchRow.appendChild(go);
    pane.appendChild(searchRow);
    if (m.grep) {
      const clear = el('button', 'ghost small', `× clear results (${m.grep.matches.length})`);
      clear.onclick = () => { m.grep = null; renderPane(); };
      pane.appendChild(clear);
      // find & replace across the matched files
      const repRow = el('div', 'mgr-newproj');
      const rep = el('input', 'mgr-input'); rep.placeholder = `replace "${m.grep.query}" with…`;
      const repBtn = el('button', 'danger small', 'Replace all');
      repBtn.onclick = () => {
        if (confirm(`Replace every "${m.grep.query}" → "${rep.value}" across the project? A checkpoint is taken first so you can ↶ Undo.`)) {
          send({ type: 'files_replace', query: m.grep.query, replacement: rep.value });
          m.grep = null; close();
        }
      };
      repRow.appendChild(rep); repRow.appendChild(repBtn);
      pane.appendChild(repRow);
      const gl = el('div', 'mgr-list');
      if (!m.grep.matches.length) gl.appendChild(el('div', 'mgr-empty', 'No matches.'));
      m.grep.matches.forEach((mt) => {
        const row = el('div', 'mgr-row'); row.style.cursor = 'pointer';
        row.innerHTML = `<div class="mgr-row-info"><div class="mgr-row-name">${esc(mt.path)}:${mt.line}</div><code>${esc(mt.text)}</code></div>`;
        row.onclick = () => send({ type: 'files_read', path: mt.path });
        gl.appendChild(row);
      });
      pane.appendChild(gl);
      return;
    }
    // --- changed files + commit ---
    if (m.changed && m.changed.length) {
      pane.appendChild(el('div', 'perm-bucket-title', `CHANGES (${m.changed.length})`));
      const cl = el('div', 'mgr-list');
      m.changed.forEach((c) => {
        const row = el('div', 'mgr-row');
        row.innerHTML = `<code class="chg-${(c.status || '?')[0]}">${esc(c.status || '?')}</code> <span class="mgr-row-name">${esc(c.path)}</span>`;
        const diff = el('button', 'ghost small', 'Diff');
        diff.onclick = () => send({ type: 'files_diff', path: c.path });
        row.appendChild(diff);
        cl.appendChild(row);
      });
      pane.appendChild(cl);
      const commitRow = el('div', 'mgr-newproj');
      const msg = el('input', 'mgr-input'); msg.placeholder = 'commit message';
      const commit = el('button', 'primary small', 'Commit all');
      commit.onclick = () => {
        const message = msg.value.trim();
        if (!message) { msg.focus(); msg.placeholder = 'enter a commit message first'; return; } // don't send an empty/undefined message
        send({ type: 'git', op: 'commit', message }); msg.value = '';
      };
      commitRow.appendChild(msg); commitRow.appendChild(commit);
      pane.appendChild(commitRow);
    }
    // --- quick .env ---
    const envBtn = el('button', 'ghost small', 'Edit .env');
    envBtn.onclick = () => send({ type: 'files_read', path: '.env' });
    pane.appendChild(envBtn);
    // --- tree ---
    const crumb = el('div', 'mgr-hint');
    crumb.textContent = '📁 ' + (m.filePath === '.' ? '/' : '/' + m.filePath);
    pane.appendChild(crumb);
    const list = el('div', 'mgr-list');
    if (m.filePath !== '.') {
      const up = el('div', 'mgr-row'); up.style.cursor = 'pointer';
      up.innerHTML = '<span class="mgr-row-name">../</span>';
      up.onclick = () => { m.filePath = m.filePath.split('/').slice(0, -1).join('/') || '.'; send({ type: 'files_list', path: m.filePath }); };
      list.appendChild(up);
    }
    (m.fileEntries || []).forEach((e) => {
      const row = el('div', 'mgr-row'); row.style.cursor = 'pointer';
      row.innerHTML = `<span class="mgr-row-name">${e.dir ? '📁 ' : '📄 '}${esc(e.name)}</span>` +
        (e.dir ? '' : `<span class="mgr-row-desc">${e.size} B</span>`);
      row.onclick = () => {
        const child = m.filePath === '.' ? e.name : m.filePath + '/' + e.name;
        if (e.dir) { m.filePath = child; send({ type: 'files_list', path: child }); }
        else send({ type: 'files_read', path: child });
      };
      list.appendChild(row);
    });
    pane.appendChild(list);
  }

  function renderPrompts(pane) {
    pane.appendChild(el('p', 'mgr-hint', 'Saved prompts — tap to drop into the composer.'));
    const list = el('div', 'mgr-list');
    if (!m.prompts.length) list.appendChild(el('div', 'mgr-empty', 'No saved prompts.'));
    m.prompts.forEach((p) => {
      const row = el('div', 'mgr-row');
      const info = el('div', 'mgr-row-info'); info.style.cursor = 'pointer';
      info.appendChild(el('div', 'mgr-row-name', p.name));
      info.appendChild(el('div', 'mgr-row-desc', p.text));
      info.onclick = () => { const inp = document.getElementById('input'); inp.value = p.text; close(); inp.focus(); };
      row.appendChild(info);
      const del = el('button', 'ghost small', 'Delete');
      del.onclick = () => { if (confirm(`Delete saved prompt "${p.name}"?`)) send({ type: 'prompts_delete', name: p.name }); };
      row.appendChild(del);
      list.appendChild(row);
    });
    pane.appendChild(list);
    const add = el('div', 'mgr-editor');
    const name = el('input', 'mgr-input'); name.placeholder = 'prompt name';
    const text = el('textarea', 'mgr-textarea'); text.placeholder = 'prompt text…';
    const save = el('button', 'primary small', 'Save prompt');
    save.onclick = () => { if (name.value.trim() && text.value.trim()) { send({ type: 'prompts_save', name: name.value.trim(), text: text.value.trim() }); name.value = ''; text.value = ''; } };
    add.appendChild(name); add.appendChild(text); add.appendChild(save);
    pane.appendChild(add);
  }

  // ---- checkpoints ---------------------------------------------------------

  function renderCheckpoints(pane) {
    // changes-since-checkpoint review sub-view
    if (m.checkpointDiff) {
      const back = el('button', 'ghost small', '← back');
      back.onclick = () => { m.checkpointDiff = null; renderPane(); };
      pane.appendChild(back);
      pane.appendChild(el('div', 'mgr-row-name', `Changes since: ${m.checkpointDiff.label || m.checkpointDiff.id}`));
      if (m.checkpointDiff.stat) { const pre = el('pre', 'file-view'); pre.textContent = m.checkpointDiff.stat; pane.appendChild(pre); }
      const list = el('div', 'mgr-list');
      if (!m.checkpointDiff.files.length) list.appendChild(el('div', 'mgr-empty', 'No changes since this checkpoint.'));
      m.checkpointDiff.files.forEach((f) => {
        const row = el('div', 'mgr-row'); row.style.cursor = 'pointer';
        row.innerHTML = `<code class="chg-${(f.status || '?')[0]}">${esc(f.status || '?')}</code> <span class="mgr-row-name">${esc(f.path)}</span>`;
        row.onclick = () => send({ type: 'files_diff', path: f.path, checkpointId: m.checkpointDiff.id });
        list.appendChild(row);
      });
      pane.appendChild(list);
      return;
    }
    pane.appendChild(el('p', 'mgr-hint', 'A non-destructive snapshot is taken before every turn. Review changes since one, or Restore to rewind (reverting the agent\'s changes since).'));
    if (!m.checkpoints.enabled) {
      pane.appendChild(el('div', 'mgr-empty', 'Checkpoints need a git repo for this project.'));
      const enable = el('button', 'primary small', 'Enable checkpoints (git init)');
      enable.onclick = () => send({ type: 'checkpoints_enable' });
      pane.appendChild(enable);
      return;
    }
    const mk = el('button', 'ghost small', '+ Snapshot now');
    mk.onclick = () => send({ type: 'checkpoint_create', label: 'manual' });
    pane.appendChild(mk);
    const list = el('div', 'mgr-list');
    if (!m.checkpoints.items.length) list.appendChild(el('div', 'mgr-empty', 'No checkpoints yet.'));
    m.checkpoints.items.forEach((c, i) => {
      const row = el('div', 'mgr-row' + (i === 0 ? ' active' : ''));
      const info = el('div', 'mgr-row-info');
      info.appendChild(el('div', 'mgr-row-name', c.label));
      info.appendChild(el('div', 'mgr-row-desc', new Date(c.time).toLocaleString() + ' · ' + c.id));
      row.appendChild(info);
      const review = el('button', 'ghost small', 'Review');
      review.onclick = () => send({ type: 'checkpoint_diff', id: c.id });
      const restore = el('button', 'ghost small', 'Restore');
      restore.onclick = () => { if (confirm(`Rewind to "${c.label}"?`)) { send({ type: 'checkpoint_restore', id: c.id }); close(); } };
      row.appendChild(review); row.appendChild(restore);
      list.appendChild(row);
    });
    pane.appendChild(list);
  }

  // ---- scripts -------------------------------------------------------------

  function renderScripts(pane) {
    // --- auto-verify loop config ---
    const av = m.autoverify;
    pane.appendChild(el('div', 'perm-bucket-title', 'AUTO-VERIFY (self-healing loop)'));
    const avBox = el('div', 'mgr-editor');
    const toggle = el('label', 'av-toggle');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!av.enabled;
    toggle.appendChild(cb);
    toggle.appendChild(el('span', '', ' After each turn, run the verify command; on failure, feed the output back to the agent to fix.'));
    avBox.appendChild(toggle);
    const cmd = el('input', 'mgr-input'); cmd.value = av.command || 'npm test'; cmd.placeholder = 'verify command (e.g. npm test)';
    avBox.appendChild(cmd);
    const maxRow = el('div', 'mgr-newproj');
    const max = el('input', 'mgr-input'); max.type = 'number'; max.value = av.maxIterations || 3; max.style.maxWidth = '90px';
    maxRow.appendChild(el('span', 'mgr-label', 'max fix attempts'));
    maxRow.appendChild(max);
    const save = el('button', 'primary small', 'Save');
    save.onclick = () => send({ type: 'autoverify_set', enabled: cb.checked, command: cmd.value.trim() || 'npm test', maxIterations: Number(max.value) || 3 });
    maxRow.appendChild(save);
    avBox.appendChild(maxRow);
    pane.appendChild(avBox);

    pane.appendChild(el('div', 'perm-bucket-title', 'PACKAGE SCRIPTS'));
    pane.appendChild(el('p', 'mgr-hint', 'Output streams to the Terminal drawer.'));
    const list = el('div', 'mgr-list');
    if (!m.scripts.items.length) list.appendChild(el('div', 'mgr-empty', 'No scripts in package.json.'));
    m.scripts.items.forEach((s) => {
      const running = m.scripts.running.includes(s.name);
      const row = el('div', 'mgr-row' + (running ? ' active' : ''));
      const info = el('div', 'mgr-row-info');
      info.appendChild(el('div', 'mgr-row-name', s.name + (running ? ' • running' : '')));
      info.appendChild(el('div', 'mgr-row-desc', s.cmd));
      row.appendChild(info);
      if (running) {
        const stop = el('button', 'danger small', 'Stop');
        stop.onclick = () => send({ type: 'script_stop', name: s.name });
        row.appendChild(stop);
      } else {
        const run = el('button', 'accent small', '▶ Run');
        run.onclick = () => { send({ type: 'script_run', name: s.name }); toast(`Running npm run ${s.name} — see Terminal`); close(); };
        row.appendChild(run);
      }
      list.appendChild(row);
    });
    pane.appendChild(list);
  }

  function toast(msg) { if (window.Agent && window.Agent.toast) window.Agent.toast(msg); }

  // ---- git / github --------------------------------------------------------

  function renderGit(pane) {
    pane.appendChild(el('p', 'mgr-hint', 'Commit, push to GitHub, and open a PR. Output streams to the Terminal drawer.'));
    pane.appendChild(el('div', 'mgr-row-desc', `${(m.changed || []).length} changed file(s)`));

    section2(pane, 'Commit', () => {
      const msg = el('input', 'mgr-input'); msg.placeholder = 'commit message';
      const commit = el('button', 'primary small', 'Commit all');
      commit.onclick = () => { send({ type: 'git', op: 'commit', message: msg.value || undefined }); send({ type: 'files_list', path: '.' }); };
      return [msg, commit];
    });

    section2(pane, 'Push to GitHub', () => {
      const msg = el('input', 'mgr-input'); msg.placeholder = 'commit message (optional)';
      const push = el('button', 'accent small', 'Commit & Push');
      push.onclick = () => { send({ type: 'github_push', message: msg.value || undefined }); openTerminal(); };
      return [msg, push];
    });

    section2(pane, 'Open pull request', () => {
      const title = el('input', 'mgr-input'); title.placeholder = 'PR title (blank = autofill from commits)';
      const body = el('textarea', 'mgr-textarea'); body.placeholder = 'PR description (optional)';
      const pr = el('button', 'primary small', 'Create PR');
      pr.onclick = () => { send({ type: 'github_pr', title: title.value || undefined, body: body.value || undefined }); openTerminal(); };
      return [title, body, pr];
    });

    section2(pane, 'Set remote (origin)', () => {
      const url = el('input', 'mgr-input'); url.placeholder = 'git@github.com:you/repo.git';
      const set = el('button', 'ghost small', 'Set origin');
      set.onclick = () => { if (url.value.trim()) send({ type: 'git_remote_set', url: url.value.trim() }); };
      return [url, set];
    });
  }
  function section2(pane, title, build) {
    pane.appendChild(el('div', 'perm-bucket-title', title.toUpperCase()));
    const box = el('div', 'mgr-editor');
    build().forEach((n) => box.appendChild(n));
    pane.appendChild(box);
  }
  function openTerminal() {
    const t = document.getElementById('terminal');
    if (t && t.classList.contains('hidden')) document.getElementById('termBtn').click();
    close();
  }

  // ---- usage analytics -----------------------------------------------------

  function renderUsage(pane) {
    const s = m.usageStats;
    if (!s) { pane.appendChild(el('div', 'mgr-empty', 'No usage recorded yet.')); return; }
    const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
    const money = (c) => (c ? '$' + c.toFixed(2) : 'flat');
    const card = (title, v) => {
      const c = el('div', 'ctx-box');
      c.appendChild(el('div', 'mgr-row-desc', title));
      c.appendChild(el('div', 'ctx-big', `${fmt(v.in)} in · ${fmt(v.out)} out`));
      c.appendChild(el('div', 'mgr-row-desc', `${v.turns} turn(s) · ${money(v.cost)}`));
      return c;
    };
    pane.appendChild(card('Today', s.today));
    pane.appendChild(card('All time', s.total));
    pane.appendChild(el('div', 'perm-bucket-title', 'BY DAY'));
    const list = el('div', 'mgr-list');
    const maxIn = Math.max(1, ...s.days.map((d) => d.in + d.out));
    s.days.forEach((d) => {
      const row = el('div', 'mgr-row');
      const info = el('div', 'mgr-row-info');
      info.appendChild(el('div', 'mgr-row-name', d.date));
      const track = el('div', 'ctx-track'); track.style.width = '120px';
      const bar = el('div', 'ctx-bar'); bar.style.width = Math.round(((d.in + d.out) / maxIn) * 100) + '%';
      track.appendChild(bar);
      info.appendChild(track);
      row.appendChild(info);
      row.appendChild(el('div', 'mgr-row-desc', `${fmt(d.in + d.out)} tok · ${d.turns}t · ${money(d.cost)}`));
      list.appendChild(row);
    });
    pane.appendChild(list);
  }

  // ---- field helpers -------------------------------------------------------

  function field(label, value, onChange, placeholder, disabled) {
    const wrap = el('div', 'mgr-field');
    wrap.appendChild(el('label', '', label));
    const inp = el('input', 'mgr-input');
    inp.value = value || '';
    if (placeholder != null) inp.placeholder = placeholder;
    inp.disabled = !!disabled;
    inp.oninput = () => onChange(inp.value);
    wrap.appendChild(inp);
    return wrap;
  }
  function textarea(label, value, onChange) {
    const wrap = el('div', 'mgr-field');
    wrap.appendChild(el('label', '', label));
    const ta = el('textarea', 'mgr-textarea');
    ta.value = value || '';
    ta.oninput = () => onChange(ta.value);
    wrap.appendChild(ta);
    return wrap;
  }

  // ---- File Manager (whole device) ----------------------------------------

  const FM_ICON = { dir: '📁', html: '📱', svg: '🎨', image: '🖼️', markdown: '📄', archive: '🗜', code: '📜', text: '📄' };
  function fmKind(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (/^html?$/.test(ext)) return 'html';
    if (ext === 'svg') return 'svg';
    if (/^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(ext)) return 'image';
    if (/^(md|markdown)$/.test(ext)) return 'markdown';
    return null;
  }
  function isArchive(name) { return /\.(zip|tar|tar\.gz|tgz)$/i.test(name); }
  function fmFmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function fmJoin(dir, name) { return (dir.endsWith('/') ? dir : dir + '/') + name; }
  function fmGo(path) { m.fsPath = path; m.loaded.delete('fileman'); send({ type: 'fs_browse', path }); renderPane(); }

  function renderFileManager(pane) {
    const fl = m.fsList;
    // Path bar + Up + New folder.
    const bar = el('div', 'fm-bar');
    const cur = el('div', 'fm-path'); cur.textContent = fl ? fl.path : 'Loading…'; bar.appendChild(cur);
    pane.appendChild(bar);
    const nav = el('div', 'mgr-newproj');
    const home = el('button', 'ghost small', '🏠'); home.title = 'Home'; home.onclick = () => fmGo('~');
    nav.appendChild(home);
    const up = el('button', 'ghost small', '⬆ Up');
    up.disabled = !(fl && fl.parent);
    up.onclick = () => { if (fl && fl.parent) fmGo(fl.parent); };
    nav.appendChild(up);
    const mkdir = el('button', 'ghost small', '+ Folder');
    mkdir.onclick = () => {
      const name = prompt('New folder name:'); if (name && name.trim()) send({ type: 'fs_mkdir', path: fl.path, name: name.trim() });
    };
    nav.appendChild(mkdir);
    pane.appendChild(nav);

    if (fl && fl.error) { pane.appendChild(el('div', 'mgr-empty', '⚠ ' + fl.error)); return; }
    if (!fl) { pane.appendChild(mgrEmpty('Loading…', 'fileman')); return; }

    const list = el('div', 'mgr-list');
    if (!fl.entries.length) list.appendChild(el('div', 'mgr-empty', 'Empty folder.'));
    for (const e of fl.entries) {
      const full = fmJoin(fl.path, e.name);
      const kind = e.dir ? 'dir' : (fmKind(e.name) || (isArchive(e.name) ? 'archive' : 'text'));
      const row = el('div', 'mgr-row fm-row'); row.style.cursor = 'pointer';
      const info = el('div', 'mgr-row-info');
      info.appendChild(el('div', 'mgr-row-name', (FM_ICON[kind] || '📄') + ' ' + e.name + (e.symlink ? ' ↗' : '')));
      info.appendChild(el('div', 'mgr-row-desc', e.dir ? 'folder' : fmFmtSize(e.size)));
      row.appendChild(info);
      // Primary action on the WHOLE row (a bigger, touch-friendly target than the
      // left sub-area): open a folder in place, or a file as a tab in the app.
      row.onclick = () => {
        if (e.dir) fmGo(full);
        else { close(); if (window.Agent && window.Agent.openFileTab) window.Agent.openFileTab(full, fmKind(e.name) || undefined, { abs: true }); }
      };

      const acts = el('div', 'fm-acts');
      const mkBtn = (label, title, fn) => { const b = el('button', 'icon-mini', label); b.title = title; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; return b; };
      acts.appendChild(mkBtn('✎', 'Rename', () => {
        const nn = prompt('Rename to:', e.name); if (nn && nn.trim() && nn.trim() !== e.name) send({ type: 'fs_rename', path: full, name: nn.trim() });
      }));
      acts.appendChild(mkBtn('⧉', 'Clone', () => {
        // Warn + let the user name the clone (default "<stem> copy<ext>").
        const dot = e.dir ? -1 : e.name.lastIndexOf('.');
        const ext = dot > 0 ? e.name.slice(dot) : '';
        const stem = dot > 0 ? e.name.slice(0, dot) : e.name;
        const nn = prompt(`Clone “${e.name}” — name for the copy:`, `${stem} copy${ext}`);
        if (nn && nn.trim() && nn.trim() !== e.name) send({ type: 'fs_copy', path: full, dest: fmJoin(fl.path, nn.trim()) });
      }));
      acts.appendChild(mkBtn('➟', 'Move to…', () => {
        const dest = prompt('Move into folder (absolute path):', fl.path); if (dest && dest.trim()) send({ type: 'fs_move', path: full, dest: dest.trim() });
      }));
      if (isArchive(e.name)) acts.appendChild(mkBtn('📦', 'Extract', () => send({ type: 'fs_extract', path: full })));
      acts.appendChild(mkBtn('🗑', 'Delete', () => {
        if (confirm(`Delete “${e.name}”?\n\n${e.dir ? 'The folder and everything in it' : 'This file'} will be permanently removed from storage. This can’t be undone.`)) {
          send({ type: 'fs_delete', path: full });
        }
      }));
      row.appendChild(acts);
      list.appendChild(row);
    }
    pane.appendChild(list);
    if (fl.truncated) pane.appendChild(el('div', 'mgr-hint', 'Showing the first 1000 items in this folder.'));
    // Quick manual path entry.
    const jump = el('div', 'mgr-newproj');
    const pin = el('input', 'mgr-input'); pin.placeholder = 'go to path, e.g. /sdcard or ~/projects';
    const goBtn = el('button', 'ghost small', 'Go');
    goBtn.onclick = () => { if (pin.value.trim()) fmGo(pin.value.trim()); };
    pin.onkeydown = (ev) => { if (ev.key === 'Enter') goBtn.onclick(); };
    jump.appendChild(pin); jump.appendChild(goBtn);
    pane.appendChild(jump);
  }

  function onFsList(ev) {
    m.loaded.add('fileman');
    m.fsList = ev;
    if (ev && ev.path) m.fsPath = ev.path;
    if (!root.classList.contains('hidden') && m.tab === 'fileman') renderPane();
  }

  // ---- event intake from app.js -------------------------------------------

  function onConfig(ev) {
    if (ev.item) {
      // a config_read response
      if (ev.kind === 'memory') {
        const items = m.items.memory || [];
        const it = items.find((x) => x.id === ev.name);
        if (it) { it._content = ev.item.content || ''; if (m.tab === 'memory') renderPane(); }
        return;
      }
      m.editing = { kind: ev.kind, name: ev.item.name, fields: ev.item.fields || {}, body: ev.item.body || '' };
      if (root.classList.contains('hidden') === false) renderPane();
      return;
    }
    if (ev.kind === 'settings') { m.loaded.add('settings'); m.items.settings = ev; if (m.tab === 'permissions') renderPane(); return; }
    if (ev.kind === 'sessions') { m.sessionsLiveBusy = ev.liveBusy || {}; m.activeSessionId = ev.activeSessionId || null; }
    m.loaded.add(ev.kind);
    m.items[ev.kind] = ev.items || [];
    if ((m.tab === ev.kind) || (ev.kind === 'sessions' && m.tab === 'sessions')) renderPane();
  }
  function onSessions(ev) {
    m.liveSessions = ev.items || [];
    m.activeKey = ev.activeKey || null;
    if (m.tab === 'sessions' && !root.classList.contains('hidden')) renderPane();
  }
  function onCapabilities(ev) { m.caps = ev; if (m.tab === 'mcp') renderPane(); }
  function onContext(ev) { m.lastContext = ev; if (m.tab === 'context') renderPane(); }
  function onProjects(ev) { m.loaded.add('projects'); m.projects = ev.projects || []; if (m.tab === 'projects') renderPane(); }
  function onWorkspaceBrowse(ev) { m.browse = ev; if (!root.classList.contains('hidden') && m.tab === 'projects') renderPane(); }
  function onProfiles(ev) { m.profiles = ev.profiles || []; if (!root.classList.contains('hidden') && m.tab === 'engine') renderPane(); }
  function onCheckpoints(ev) { m.checkpoints = { items: ev.items || [], enabled: !!ev.enabled }; if (m.tab === 'checkpoints') renderPane(); }
  function onFiles(ev) {
    m.filePath = ev.path || '.';
    m.fileEntries = ev.entries || [];
    m.changed = ev.changed || [];
    // Don't clobber an open file/diff/grep view — a FILES refresh can arrive
    // from a background write/restore while the user is viewing something.
    if (m.tab === 'files' && !m.openFile && !m.diffView && !m.grep) renderPane();
  }
  function onFile(ev) {
    m.openFile = { path: ev.path, content: ev.content || '', truncated: ev.truncated };
    m.editingFile = false;
    m.diffView = null;
    m.grep = null;
    if (root.classList.contains('hidden')) return;
    softSwitch('files');
  }
  function onFileDiff(ev) {
    m.diffView = ev;
    m.openFile = null;
    if (root.classList.contains('hidden')) return;
    softSwitch('files');
  }
  function onFileGrep(ev) {
    m.grep = { query: ev.query, matches: ev.matches || [] };
    m.openFile = null; m.diffView = null;
    if (!root.classList.contains('hidden') && m.tab === 'files') renderPane();
  }
  function onPrompts(ev) { m.loaded.add('prompts'); m.prompts = ev.items || []; if (!root.classList.contains('hidden') && m.tab === 'prompts') renderPane(); }
  function onScripts(ev) { m.scripts = { items: ev.items || [], running: ev.running || [] }; if (!root.classList.contains('hidden') && m.tab === 'scripts') renderPane(); }
  function onAutoVerify(ev) {
    m.autoverify = { enabled: ev.enabled, command: ev.command, maxIterations: ev.maxIterations };
    if (!root.classList.contains('hidden') && m.tab === 'scripts') renderPane();
  }
  function onUsageStats(ev) { m.usageStats = ev.summary; if (!root.classList.contains('hidden') && m.tab === 'usage') renderPane(); }
  function onAppVersion(ev) { m.appVersion = ev; if (!root.classList.contains('hidden') && m.tab === 'update') renderPane(); }
  function onAppUpdate(ev) {
    if (ev.state === 'updating' && ev.ok === undefined) return; // progress ping; keep "Updating…"
    m.updating = false; m.appUpdate = ev;
    if (ev.ok && !ev.upToDate) send({ type: 'app_version' }); // refresh the version box
    if (!root.classList.contains('hidden') && m.tab === 'update') renderPane();
  }
  function onCheckpointDiff(ev) {
    m.checkpointDiff = { id: ev.id, label: ev.label, files: ev.files || [], stat: ev.stat || '' };
    if (root.classList.contains('hidden')) return;
    softSwitch('checkpoints');
  }

  window.Managers = {
    open, openTab, close, onConfig, onCapabilities, onContext, onProjects, onProfiles, onResources,
    onCheckpoints, onFiles, onFile, onFileDiff, onFileGrep, onPrompts, onScripts,
    onAutoVerify, onUsageStats, onCheckpointDiff, onWorkspaceBrowse,
    onAppVersion, onAppUpdate, onSessions, onFsList, onUserSettings,
  };
})();
