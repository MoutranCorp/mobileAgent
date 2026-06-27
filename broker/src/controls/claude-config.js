import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';

/**
 * ClaudeConfig — read/write the Claude Code harness config that lives in
 * `.claude/` directories, so the UI can offer first-class managers for:
 *   - skills    (.claude/skills/<name>/SKILL.md)
 *   - agents    (.claude/agents/<name>.md)
 *   - commands  (.claude/commands/<name>.md)
 *   - memory    (CLAUDE.md / CLAUDE.local.md across scopes)
 *   - settings  (.claude/settings.json — permissions allow/deny/ask)
 *   - sessions  (~/.claude/projects/<proj>/*.jsonl transcripts)
 *
 * scope is 'project' (the active project's .claude) or 'user' (~/.claude).
 * See docs/claude-code-surface.md for the authoritative file formats.
 */
export class ClaudeConfig {
  constructor({ getProjectDir, getProjects, stateDir } = {}) {
    this.getProjectDir = getProjectDir;
    this.getProjects = getProjects || (() => []); // [{ id, dir }] for session<->project mapping
    this._titlesFile = stateDir ? path.join(stateDir, 'session-titles.json') : null;
  }

  // --- session title overrides (sidecar; Claude owns the .jsonl) --------------
  _readTitles() {
    try { if (this._titlesFile && fs.existsSync(this._titlesFile)) return JSON.parse(read(this._titlesFile)); } catch { /* ignore */ }
    return {};
  }
  _writeTitles(map) {
    if (!this._titlesFile) return;
    try { ensureDir(path.dirname(this._titlesFile)); fs.writeFileSync(this._titlesFile, JSON.stringify(map, null, 2)); } catch { /* ignore */ }
  }
  renameSession(sessionId, title) {
    const t = this._readTitles();
    if (title && title.trim()) t[sessionId] = title.trim().slice(0, 120); else delete t[sessionId];
    this._writeTitles(t);
    return { ok: true };
  }

  // --- session <-> project resolution -----------------------------------------
  // Re-encode every known project dir the way Claude encodes cwd, so a session's
  // encoded folder maps back to a real project id. Ambiguous encodings -> null.
  _projectIndex() {
    const byEnc = new Map();
    const seen = new Set();
    for (const p of this.getProjects()) {
      if (!p || !p.dir) continue;
      const enc = encodeCwd(p.dir);
      if (byEnc.has(enc)) { byEnc.set(enc, null); seen.add(enc); } // collision -> unknown
      else if (!seen.has(enc)) byEnc.set(enc, p.id);
    }
    return byEnc;
  }
  _dirForProject(projectId) {
    if (!projectId) return null;
    const p = this.getProjects().find((x) => x.id === projectId);
    return p && p.dir ? path.join(os.homedir(), '.claude', 'projects', encodeCwd(p.dir)) : null;
  }
  sessionsDirForProject(projectId) { return this._dirForProject(projectId); }

  /** Delete a session .jsonl, most precisely by its literal encoded folder. */
  deleteSession(sessionId, { projectId = null, projectDir = null } = {}) {
    // Guard against path traversal in caller-supplied values: a session id is a
    // UUID-ish token; an encoded projectDir is a single folder name (Claude encodes
    // separators as '-'), so neither may contain path separators or '..'.
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId))) return { error: 'invalid session id' };
    if (projectDir != null && (/[\\/]/.test(String(projectDir)) || String(projectDir).includes('..'))) {
      return { error: 'invalid project dir' };
    }
    let base = null;
    if (projectDir) base = path.join(os.homedir(), '.claude', 'projects', projectDir);
    else base = this._dirForProject(projectId) || this._sessionsDir();
    const file = path.join(base, `${sessionId}.jsonl`);
    // Final containment check: never delete outside ~/.claude/.
    const claudeRoot = path.join(os.homedir(), '.claude');
    if (!path.resolve(file).startsWith(claudeRoot + path.sep)) return { error: 'refused: outside the claude dir' };
    try {
      if (!fs.existsSync(file)) return { error: 'session file not found' };
      fs.rmSync(file, { force: true });
    } catch (e) { return { error: e.message }; }
    const t = this._readTitles();
    if (t[sessionId]) { delete t[sessionId]; this._writeTitles(t); }
    return { ok: true, file };
  }

  _baseFor(scope) {
    if (scope === 'user') return path.join(os.homedir(), '.claude');
    const dir = this.getProjectDir();
    return path.join(dir || os.homedir(), '.claude');
  }

  _projectDir() {
    return this.getProjectDir() || os.homedir();
  }

  // --- list -------------------------------------------------------------------

  list(kind, scope = 'project') {
    switch (kind) {
      case 'skills':
        return this._listSkills(scope);
      case 'agents':
        return this._listAgents(scope);
      case 'commands':
        return this._listCommands(scope);
      case 'output-styles':
        return this._listOutputStyles(scope);
      case 'memory':
        return this._listMemory();
      case 'settings':
        return this._readSettings(scope);
      case 'sessions':
        return this._listSessions();
      case 'mcp':
        return this._listMcp(scope);
      case 'hooks':
        return this._listHooks(scope);
      default:
        return [];
    }
  }

  // --- Hooks (.claude/settings.json `hooks`) ----------------------------------

  _settingsPath(scope) {
    return path.join(this._baseFor(scope), 'settings.json');
  }
  _readSettingsRaw(scope) {
    try {
      const f = this._settingsPath(scope);
      if (fs.existsSync(f)) return JSON.parse(read(f));
    } catch {
      /* ignore */
    }
    return {};
  }
  _writeSettingsRaw(scope, json) {
    const f = this._settingsPath(scope);
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(json, null, 2));
    } catch {
      /* ignore */
    }
  }
  _listHooks(scope) {
    const hooks = this._readSettingsRaw(scope).hooks || {};
    const out = [];
    for (const [eventName, groups] of Object.entries(hooks)) {
      (groups || []).forEach((group, gi) => {
        (group.hooks || []).forEach((h, hi) => {
          out.push({
            name: `${eventName}#${gi}#${hi}`,
            event: eventName,
            matcher: group.matcher || '',
            type: h.type || 'command',
            command: h.command || '',
            scope,
          });
        });
      });
    }
    return out;
  }

  // --- MCP servers (.mcp.json project / ~/.claude.json user) ------------------

  _mcpFile(scope) {
    if (scope === 'user') return path.join(os.homedir(), '.claude.json');
    return path.join(this._projectDir(), '.mcp.json');
  }
  _readMcpServers(scope) {
    const file = this._mcpFile(scope);
    try {
      if (fs.existsSync(file)) return JSON.parse(read(file)).mcpServers || {};
    } catch {
      /* ignore */
    }
    return {};
  }
  _writeMcpServers(scope, servers) {
    const file = this._mcpFile(scope);
    let json = {};
    try {
      if (fs.existsSync(file)) json = JSON.parse(read(file));
    } catch {
      /* start fresh */
    }
    json.mcpServers = servers;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json, null, 2));
    } catch {
      /* ignore */
    }
  }
  _listMcp(scope) {
    const servers = this._readMcpServers(scope);
    return Object.entries(servers).map(([name, cfg]) => ({
      name,
      command: cfg.command || cfg.url || '',
      args: Array.isArray(cfg.args) ? cfg.args.join(' ') : '',
      transport: cfg.type || cfg.transport || (cfg.url ? 'http' : 'stdio'),
      scope,
    }));
  }

  _listSkills(scope) {
    const dir = path.join(this._baseFor(scope), 'skills');
    if (!fs.existsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md')))
      .map((n) => {
        const { data } = parseFrontmatter(read(path.join(dir, n, 'SKILL.md')));
        return {
          name: n,
          description: data.description || '',
          model: data.model || '',
          allowedTools: data['allowed-tools'] || data.allowedTools || '',
          userInvocable: data['user-invocable'] !== false,
          scope,
        };
      });
  }

  _listAgents(scope) {
    const dir = path.join(this._baseFor(scope), 'agents');
    if (!fs.existsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => {
        const { data } = parseFrontmatter(read(path.join(dir, n)));
        return {
          name: n.replace(/\.md$/, ''),
          description: data.description || '',
          tools: data.tools || '',
          model: data.model || '',
          scope,
        };
      });
  }

  _listCommands(scope) {
    const dir = path.join(this._baseFor(scope), 'commands');
    if (!fs.existsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => {
        const { data } = parseFrontmatter(read(path.join(dir, n)));
        return {
          name: n.replace(/\.md$/, ''),
          description: data.description || '',
          argumentHint: data['argument-hint'] || '',
          model: data.model || '',
          scope,
        };
      });
  }

  _listOutputStyles(scope) {
    const dir = path.join(this._baseFor(scope), 'output-styles');
    if (!fs.existsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => {
        const { data } = parseFrontmatter(read(path.join(dir, n)));
        return { name: n.replace(/\.md$/, ''), description: data.description || '', scope };
      });
  }

  _listMemory() {
    const proj = this._projectDir();
    const home = os.homedir();
    const files = [
      { id: 'project', label: 'Project (./CLAUDE.md)', file: path.join(proj, 'CLAUDE.md') },
      { id: 'project-dot', label: 'Project (.claude/CLAUDE.md)', file: path.join(proj, '.claude', 'CLAUDE.md') },
      { id: 'local', label: 'Local (./CLAUDE.local.md, gitignored)', file: path.join(proj, 'CLAUDE.local.md') },
      { id: 'user', label: 'User (~/.claude/CLAUDE.md)', file: path.join(home, '.claude', 'CLAUDE.md') },
    ];
    return files.map((f) => ({
      ...f,
      exists: fs.existsSync(f.file),
      size: fs.existsSync(f.file) ? fs.statSync(f.file).size : 0,
    }));
  }

  _readSettings(scope) {
    const file = path.join(this._baseFor(scope), 'settings.json');
    let json = {};
    try {
      if (fs.existsSync(file)) json = JSON.parse(read(file));
    } catch {
      /* ignore */
    }
    const perms = json.permissions || {};
    return {
      file,
      defaultMode: perms.defaultMode || 'default',
      allow: perms.allow || [],
      deny: perms.deny || [],
      ask: perms.ask || [],
      additionalDirectories: perms.additionalDirectories || [],
    };
  }

  _sessionsDir() {
    const proj = this._projectDir();
    // Claude stores transcripts under ~/.claude/projects/<cwd with sep -> ->.
    return path.join(os.homedir(), '.claude', 'projects', encodeCwd(proj));
  }

  _listSessions() {
    const dir = this._sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const titles = this._readTitles();
    return safeReaddir(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => {
        const full = path.join(dir, n);
        const stat = fs.statSync(full);
        const id = n.replace(/\.jsonl$/, '');
        return {
          id,
          summary: titles[id] || firstUserText(full),
          titled: !!titles[id],
          mtime: stat.mtimeMs,
          size: stat.size,
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);
  }

  /**
   * Sessions across ALL projects (for the management screen). Enumerates
   * ~/.claude/projects/<encoded-cwd>/*.jsonl, derives a readable project name
   * from the encoded directory (best-effort; the encoding is lossy), and returns
   * them newest-first with the project name attached so the UI can group them.
   */
  listAllSessions({ max = 120 } = {}) {
    const root = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return [];
    const byEnc = this._projectIndex();
    const titles = this._readTitles();
    const out = [];
    for (const enc of safeReaddir(root)) {
      const dir = path.join(root, enc);
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* ignore */ }
      if (!isDir) continue;
      const projectId = byEnc.get(enc) || null;
      // Prefer the real project's name; else best-effort from the encoded folder.
      const known = projectId && this.getProjects().find((p) => p.id === projectId);
      const project = (known && (known.name || known.id)) || enc.split('-').filter(Boolean).pop() || enc;
      for (const n of safeReaddir(dir)) {
        if (!n.endsWith('.jsonl')) continue;
        const full = path.join(dir, n);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        const id = n.replace(/\.jsonl$/, '');
        out.push({ id, summary: titles[id] || firstUserText(full), titled: !!titles[id],
          mtime: stat.mtimeMs, size: stat.size, project, projectDir: enc, projectId });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, max);
  }

  /**
   * Parse a stored session .jsonl into canonical transcript records (the same
   * shapes TranscriptStore persists), so resuming a session can REPLAY history.
   * Claude's `--resume` restores context for the model but does NOT re-emit past
   * turns to the stream, so without this a resumed session shows up blank.
   */
  readSessionTranscript(sessionId, { max = 1500, dir = null } = {}) {
    const file = path.join(dir || this._sessionsDir(), `${sessionId}.jsonl`);
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const out = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj?.message;
      if (!msg) continue;
      const parent = obj.parentToolUseId || obj.parent_tool_use_id || null;
      if (obj.type === 'user') {
        const content = msg.content;
        if (typeof content === 'string') {
          if (content.trim()) out.push({ type: 'user_echo', text: content });
        } else if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'text' && b.text?.trim()) out.push({ type: 'user_echo', text: b.text });
            else if (b.type === 'tool_result') {
              out.push({
                type: 'tool_result',
                id: b.tool_use_id,
                status: b.is_error ? 'error' : 'ok',
                output: blockText(b.content),
                parentToolUseId: parent,
              });
            }
          }
        }
      } else if (obj.type === 'assistant') {
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const b of content) {
          if (b.type === 'text' && b.text) out.push({ type: 'assistant_text', delta: b.text, parentToolUseId: parent });
          else if (b.type === 'thinking' && b.thinking) out.push({ type: 'assistant_thinking', delta: b.thinking, parentToolUseId: parent });
          else if (b.type === 'tool_use') out.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input || {}, parentToolUseId: parent });
        }
      }
    }
    return out.slice(-max);
  }

  // --- read -------------------------------------------------------------------

  read(kind, name, scope = 'project') {
    if (kind === 'skills') {
      const file = path.join(this._baseFor(scope), 'skills', name, 'SKILL.md');
      const { data, body } = parseFrontmatter(read(file));
      return { name, scope, fields: data, body, file };
    }
    if (kind === 'agents' || kind === 'commands' || kind === 'output-styles') {
      const file = path.join(this._baseFor(scope), kind, `${name}.md`);
      const { data, body } = parseFrontmatter(read(file));
      return { name, scope, fields: data, body, file };
    }
    if (kind === 'memory') {
      const entry = this._listMemory().find((m) => m.id === name);
      return { name, file: entry?.file, content: entry && entry.exists ? read(entry.file) : '' };
    }
    if (kind === 'settings') return this._readSettings(scope);
    if (kind === 'mcp') {
      const cfg = this._readMcpServers(scope)[name] || {};
      return {
        name, scope,
        fields: {
          command: cfg.command || cfg.url || '',
          args: Array.isArray(cfg.args) ? cfg.args.join(' ') : '',
          transport: cfg.type || cfg.transport || (cfg.url ? 'http' : 'stdio'),
        },
      };
    }
    return null;
  }

  // --- write ------------------------------------------------------------------

  write(kind, name, scope = 'project', payload = {}) {
    if (kind === 'skills') {
      const fields = payload.fields || {};
      const fm = compact({
        name: name,
        description: fields.description,
        model: fields.model,
        'allowed-tools': fields.allowedTools,
        'disallowed-tools': fields.disallowedTools,
        'argument-hint': fields.argumentHint,
        'user-invocable': fields.userInvocable,
        'disable-model-invocation': fields.disableModelInvocation,
      });
      const file = path.join(this._baseFor(scope), 'skills', name, 'SKILL.md');
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, stringifyFrontmatter(fm, payload.body || ''));
      return { ok: true, file };
    }
    if (kind === 'agents') {
      const fields = payload.fields || {};
      const fm = compact({
        name,
        description: fields.description,
        tools: fields.tools,
        disallowedTools: fields.disallowedTools,
        model: fields.model,
        permissionMode: fields.permissionMode,
      });
      const file = path.join(this._baseFor(scope), 'agents', `${name}.md`);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, stringifyFrontmatter(fm, payload.body || ''));
      return { ok: true, file };
    }
    if (kind === 'commands') {
      const fields = payload.fields || {};
      const fm = compact({
        description: fields.description,
        'argument-hint': fields.argumentHint,
        'allowed-tools': fields.allowedTools,
        model: fields.model,
      });
      const file = path.join(this._baseFor(scope), 'commands', `${name}.md`);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, stringifyFrontmatter(fm, payload.body || ''));
      return { ok: true, file };
    }
    if (kind === 'output-styles') {
      const fields = payload.fields || {};
      const fm = compact({ name, description: fields.description });
      const file = path.join(this._baseFor(scope), 'output-styles', `${name}.md`);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, stringifyFrontmatter(fm, payload.body || ''));
      return { ok: true, file };
    }
    if (kind === 'memory') {
      const entry = this._listMemory().find((m) => m.id === name);
      if (!entry) return { error: `unknown memory scope ${name}` };
      ensureDir(path.dirname(entry.file));
      fs.writeFileSync(entry.file, payload.content || '');
      return { ok: true, file: entry.file };
    }
    if (kind === 'hooks') {
      const f = payload.fields || {};
      const event = f.event || 'PreToolUse';
      const json = this._readSettingsRaw(scope);
      json.hooks ||= {};
      json.hooks[event] ||= [];
      json.hooks[event].push({
        matcher: f.matcher || '',
        hooks: [{ type: f.type || 'command', command: f.command || '' }],
      });
      this._writeSettingsRaw(scope, json);
      return { ok: true, file: this._settingsPath(scope) };
    }
    if (kind === 'mcp') {
      const fields = payload.fields || {};
      const servers = this._readMcpServers(scope);
      const isHttp = (fields.transport || 'stdio') !== 'stdio' || /^https?:\/\//.test(fields.command || '');
      servers[name] = isHttp
        ? { type: fields.transport || 'http', url: fields.command }
        : { command: fields.command, args: (fields.args || '').split(/\s+/).filter(Boolean) };
      this._writeMcpServers(scope, servers);
      return { ok: true, file: this._mcpFile(scope) };
    }
    if (kind === 'settings') {
      const file = path.join(this._baseFor(scope), 'settings.json');
      let json = {};
      try {
        if (fs.existsSync(file)) json = JSON.parse(read(file));
      } catch {
        /* start fresh */
      }
      json.permissions = {
        ...(json.permissions || {}),
        defaultMode: payload.defaultMode ?? json.permissions?.defaultMode ?? 'default',
        allow: payload.allow ?? json.permissions?.allow ?? [],
        deny: payload.deny ?? json.permissions?.deny ?? [],
        ask: payload.ask ?? json.permissions?.ask ?? [],
      };
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(json, null, 2));
      return { ok: true, file };
    }
    return { error: `unknown kind ${kind}` };
  }

  delete(kind, name, scope = 'project') {
    if (kind === 'mcp') {
      const servers = this._readMcpServers(scope);
      delete servers[name];
      this._writeMcpServers(scope, servers);
      return { ok: true };
    }
    if (kind === 'hooks') {
      // name = `event#groupIndex#hookIndex`
      const [event, gi] = String(name).split('#');
      const json = this._readSettingsRaw(scope);
      if (json.hooks && json.hooks[event]) {
        json.hooks[event].splice(Number(gi), 1);
        if (!json.hooks[event].length) delete json.hooks[event];
        this._writeSettingsRaw(scope, json);
      }
      return { ok: true };
    }
    let target;
    if (kind === 'skills') target = path.join(this._baseFor(scope), 'skills', name);
    else if (kind === 'agents' || kind === 'commands' || kind === 'output-styles')
      target = path.join(this._baseFor(scope), kind, `${name}.md`);
    else return { error: `cannot delete kind ${kind}` };
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  }
}

// How Claude encodes a cwd into its ~/.claude/projects/<dir> folder name. Used to
// map a session's folder back to a known project (and vice-versa).
function encodeCwd(dir) {
  return String(dir).replace(/[/\\:]+/g, '-').replace(/^-+/, '-');
}
function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
}
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== '') out[k] = v;
  return out;
}
/** Flatten a Claude content value (string | block[]) to plain text. */
function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : b?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}
function firstUserText(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 40);
    for (const line of head) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      const content = obj?.message?.content;
      if (obj.type === 'user' && content) {
        const text = typeof content === 'string'
          ? content
          : (content.find?.((b) => b.type === 'text')?.text || '');
        // Strip Claude's slash-command XML wrappers (<command-name>…) so the
        // session summary reads cleanly instead of showing raw markup.
        const clean = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (clean) return clean.slice(0, 80);
      }
    }
  } catch {
    /* ignore */
  }
  return '(session)';
}
