/**
 * Canonical protocol — the single stable contract between the UI and any engine.
 *
 * This is a superset of Claude Code's stream-json (the richest format we target),
 * so the claude-code adapter maps almost 1:1. Every adapter MUST translate its
 * native protocol into these shapes; raw harness shapes must never leak to the UI.
 *
 * Wire format: newline-delimited JSON is NOT used on the socket — instead each
 * message is a single JSON object: { "type": <string>, ...fields }.
 */

/** Event types emitted engine -> UI (and broker -> UI for control output). */
export const EventType = Object.freeze({
  // Engine / session lifecycle
  SESSION_META: 'session_meta', // { sessionId, engine, model, profileId, cwd }
  CAPABILITIES: 'capabilities', // full system/init metadata (see below)
  STATUS: 'status', // { state: 'idle'|'thinking'|'running'|'waiting'|'error', detail? }
  // Conversation
  ASSISTANT_TEXT: 'assistant_text', // { delta, parentToolUseId? }  (token-by-token)
  ASSISTANT_THINKING: 'assistant_thinking', // { delta, signature?, parentToolUseId? }
  USER_ECHO: 'user_echo', // { text }  (replayed user turns)
  // Tools  (parentToolUseId links subagent/Task nested tools to their parent)
  TOOL_CALL: 'tool_call', // { id, name, input, kind?, parentToolUseId? }
  TOOL_RESULT: 'tool_result', // { id, status: 'ok'|'error', output, parentToolUseId? }
  // Permissions
  PERMISSION_REQUEST: 'permission_request', // { id, action, detail, toolName?, input? }
  PERMISSION_RESOLVED: 'permission_resolved', // { id, decision }
  // Agent → user questions (via the broker's ask_user_question MCP tool)
  QUESTION_REQUEST: 'question_request', // { id, questions: [{ question, header?, multiSelect?, options:[{label,description?}] }] }
  QUESTION_RESOLVED: 'question_resolved', // { id } the question was answered/cancelled (clear the form)
  PERMISSION_DENIED: 'permission_denied', // { toolName, reason } from result.permission_denials
  PERMISSION_MODE: 'permission_mode', // { mode } effective permission mode
  MODELS: 'models', // { items: [{ alias, id, label }], resolvedModel }
  EFFORT: 'effort', // { level } current reasoning effort
  // Accounting / context
  USAGE: 'usage', // { inTok, outTok, cacheReadTok?, cacheWriteTok?, cost? }
  CONTEXT: 'context', // { usedTokens, windowTokens, model } live context-window meter
  COMPACT: 'compact', // { trigger, preTokens } context was summarized
  // Errors / system
  ERROR: 'error', // { message, fatal?, code? }
  RESULT: 'result', // { subtype, durationMs?, isError?, ... } end-of-turn marker

  // Broker-level (not from an engine) — control surface
  CONTROL_OUTPUT: 'control_output', // { channel, stream: 'stdout'|'stderr', data }
  CONTROL_STATUS: 'control_status', // { channel, state, detail? }
  METRO_STATUS: 'metro_status', // { running, port, url, projectId }
  APKS: 'apks', // { items: [{ rel, name, size, mtime }] } built Android artifacts (.apk/.aab)
  RESOURCES: 'resources', // { mem:{totalMb,availMb,usedMb,usedPct}, broker:{rssMb}, agentsRssMb, engines:[{key,projectId,sessionId,pid,rssMb,status,idleMs,pinned,title}], cpu:{load1,cores}, hasProc } device/process sample
  GIT_STATUS: 'git_status', // { ... }
  PROJECTS: 'projects', // { projects: [...], activeProjectId }
  WORKSPACE_BROWSE: 'workspace_browse', // { path, parent, dirs: [{name, isProject}] }
  PROFILES: 'profiles', // { profiles: [...], activeProfileId }
  ENGINE_STATE: 'engine_state', // { state: 'stopped'|'starting'|'ready'|'stopping' }
  SESSIONS: 'sessions', // { items: [{ key, projectId, profileId, model, busy, lastStatus, active }], activeKey } live sessions
  // Harness config surfaces (skills/agents/commands/memory/settings/sessions)
  CONFIG: 'config', // { kind: 'skills'|'agents'|'commands'|'memory'|'settings'|'sessions', scope?, items|content }
  // Durability / power features
  TRANSCRIPT: 'transcript', // { events: [...] } replay of recorded conversation
  CHECKPOINTS: 'checkpoints', // { items: [{id,label,time,filesChanged?}], enabled }
  CHECKPOINT_RESTORED: 'checkpoint_restored', // { id }
  FILES: 'files', // { path, entries: [{name,dir,size}], changed: [...] }
  FILE: 'file', // { path, content, truncated }
  FILE_SEARCH: 'file_search', // { query, matches: [paths] }
  FILE_DIFF: 'file_diff', // { path, before, after, status }
  FILE_GREP: 'file_grep', // { query, matches: [{path, line, text}], truncated }
  FILE_REPLACE: 'file_replace', // { query, replacement, filesChanged, replacements }
  // Whole-filesystem File Manager (absolute paths, not project-scoped).
  FS_LIST: 'fs_list', // { path, parent, entries: [{name,dir,size,mtime,symlink}], truncated?, error? }
  FS_FILE: 'fs_file', // { path, content, truncated?, binary?, error? }  a file read for opening as a tab
  TRANSCRIPT_SEARCH_RESULT: 'transcript_search', // { query, matches: [{type, text}] }
  PROMPTS: 'prompts', // { items: [{name, text}] }
  SCRIPTS: 'scripts', // { items: [{name, cmd}], running: [names] }
  GITHUB: 'github', // { ok, url?, message, op }
  AUTOVERIFY: 'autoverify', // { enabled, command, maxIterations, state?, iteration? }
  USAGE_STATS: 'usage_stats', // { summary: { today, days, total } }
  CRON_JOBS: 'cron_jobs', // { jobs: [{ id, name, prompt, projectId, schedule:{cron,label,source}, sessionMode, enabled, lastRun, lastStatus, lastSessionKey, lastSessionId, nextRun }] }
  CHECKPOINTS_DIFF: 'checkpoints_diff', // { id, files: [{status, path}], stat }
  TURN_CHANGES: 'turn_changes', // { checkpointId, files: [{status, path}], stat } what the agent changed this turn
  NATIVE_CHANGE: 'native_change', // { deps } native deps changed — offer rebuild
  FILE_WIDGET: 'file_widget', // { path, kind?, title? } render a generated project file inline (e.g. a Playwright screenshot) without a Write/Edit tool event
  LOG: 'log', // { level, message }  broker diagnostics
  TOAST: 'toast', // { message, level? }  transient user-facing notice
  USER_SETTINGS: 'user_settings', // { settings }  persisted per-user UI/engine prefs (sent in the snapshot)
  APP_VERSION: 'app_version', // { sha, subject, when, branch, dirty }  current app build
  APP_UPDATE: 'app_update', // { state?: 'updating', ok, upToDate?, fromSha, toSha, needsReload, needsRestart, ... }
  REVERTED: 'reverted', // { ok, checkpointId, removed, restoredFiles, text, message? } result of a revert
  ACK: 'ack', // { ofType, ok, message? }  acknowledges a received command
  PONG: 'pong', // {}  reply to a PING keepalive
  ack: 'ack', // deprecated alias for ACK — kept so existing references don't break
});

/** Command types accepted UI -> broker. */
export const CommandType = Object.freeze({
  // Conversation
  USER_MESSAGE: 'user_message', // { text, images?: [{ mime, dataBase64 }] }
  SLASH_COMMAND: 'slash_command', // { name, args? } convenience for /cmd
  INTERRUPT: 'interrupt', // {}
  // Permissions
  APPROVE: 'approve', // { id, mode? }
  DENY: 'deny', // { id, reason? }
  SET_PERMISSION_MODE: 'set_permission_mode', // { mode } default|acceptEdits|plan|bypassPermissions
  QUESTION_RESPONSE: 'question_response', // { id, answers: [{ header?, question?, selected:[label], custom? }], sessionKey? }  answer an ask_user_question
  // Cron / scheduled jobs
  CRON_CREATE: 'cron_create', // { name?, prompt, projectId?, schedule:{cron|source/preset}, sessionMode?, enabled? }
  CRON_UPDATE: 'cron_update', // { id, ...patch }
  CRON_DELETE: 'cron_delete', // { id }
  CRON_TOGGLE: 'cron_toggle', // { id, enabled? }
  CRON_RUN_NOW: 'cron_run_now', // { id } fire immediately
  // Session / engine
  RESUME: 'resume', // { sessionId }
  NEW_SESSION: 'new_session', // {}
  SWITCH_ENGINE: 'switch_engine', // { profileId }
  SWITCH_MODEL: 'switch_model', // { model }
  MODELS_LIST: 'models_list', // { refresh? } resolve alias -> version
  SET_EFFORT: 'set_effort', // { level } low|medium|high|xhigh|max|ultracode
  LIST_SESSIONS: 'list_sessions', // { scope?: 'all' } on-disk session list
  LIST_LIVE_SESSIONS: 'list_live_sessions', // {} currently-running engines
  SWITCH_SESSION: 'switch_session', // { key } bring a live session to the foreground (no engine stop)
  SESSION_DELETE: 'session_delete', // { id, projectId?, projectDir? } delete a session transcript
  SESSION_RENAME: 'session_rename', // { id, title } set a custom title (sidecar override)
  SESSION_STOP: 'session_stop', // { key } tear down a live engine (idle/manual eviction), keep its transcript
  SESSION_PIN: 'session_pin', // { key, pinned } keep-warm override — exempt a session from idle eviction
  COMPACT: 'compact', // { focus? }
  CLEAR: 'clear', // {}
  // Projects
  LIST_PROJECTS: 'list_projects', // {}
  CREATE_PROJECT: 'create_project', // { name, template? }
  OPEN_PROJECT: 'open_project', // { projectId }
  OPEN_PATH: 'open_path', // { path }  open an arbitrary folder as the workspace
  PROJECT_DELETE: 'project_delete', // { id }  delete a project (managed -> from disk; external -> forget) + its sessions/checkpoints
  WORKSPACE_BROWSE: 'workspace_browse', // { path? }  list subdirs for the folder picker
  // Harness config (skills / agents / commands / memory / settings)
  CONFIG_LIST: 'config_list', // { kind, scope? }
  CONFIG_READ: 'config_read', // { kind, name, scope? }
  CONFIG_WRITE: 'config_write', // { kind, name, scope?, content|fields }
  CONFIG_DELETE: 'config_delete', // { kind, name, scope? }
  // Checkpoints / rewind
  CHECKPOINT_LIST: 'checkpoint_list', // {}
  CHECKPOINT_CREATE: 'checkpoint_create', // { label? }
  CHECKPOINT_RESTORE: 'checkpoint_restore', // { id }
  CHECKPOINTS_ENABLE: 'checkpoints_enable', // {} git init the project
  // Files
  FILES_LIST: 'files_list', // { path? }
  FILES_READ: 'files_read', // { path }
  FILES_SEARCH: 'files_search', // { query }  (path fuzzy match for @-mentions)
  FILES_GREP: 'files_grep', // { query }  (content search)
  FILES_REPLACE: 'files_replace', // { query, replacement }  (find & replace across files)
  FILES_DIFF: 'files_diff', // { path }  (working tree vs HEAD)
  FILES_WRITE: 'files_write', // { path, content }  (inline edit / .env)
  // Whole-filesystem File Manager commands (absolute paths; '~' allowed).
  FS_BROWSE: 'fs_browse', // { path }
  FS_READ: 'fs_read', // { path }  read a file to open as a tab
  FS_WRITE: 'fs_write', // { path, content }  save an absolute-path file tab
  FS_MKDIR: 'fs_mkdir', // { path, name }  new folder under path
  FS_RENAME: 'fs_rename', // { path, name }  rename in place
  FS_MOVE: 'fs_move', // { path, dest }  move into dest folder
  FS_COPY: 'fs_copy', // { path, dest? }  clone (default: "<name> copy")
  FS_DELETE: 'fs_delete', // { path }  delete file/folder (recursive)
  FS_EXTRACT: 'fs_extract', // { path }  extract .zip/.tar/.tar.gz/.tgz into a sibling folder
  USER_SETTINGS_PATCH: 'user_settings_patch', // { patch }  deep-merge + persist user settings
  TRANSCRIPT_SEARCH: 'transcript_search', // { query }  (search the conversation)
  // Prompt library
  PROMPTS_LIST: 'prompts_list', // {}
  PROMPTS_SAVE: 'prompts_save', // { name, text }
  PROMPTS_DELETE: 'prompts_delete', // { name }
  // npm scripts
  SCRIPTS_LIST: 'scripts_list', // {}
  SCRIPT_RUN: 'script_run', // { name }
  SCRIPT_STOP: 'script_stop', // { name }
  // GitHub / publish
  GITHUB_PUSH: 'github_push', // { commit?, message? } commit (optional) + push
  GITHUB_PR: 'github_pr', // { title, body, base? }
  GIT_REMOTE_SET: 'git_remote_set', // { url }
  // Auto-verify loop
  AUTOVERIFY_GET: 'autoverify_get', // {}
  AUTOVERIFY_SET: 'autoverify_set', // { enabled, command, maxIterations }
  // Usage analytics
  USAGE_SUMMARY: 'usage_summary', // {}
  // Checkpoint review
  CHECKPOINT_DIFF: 'checkpoint_diff', // { id } changes since a checkpoint
  // Controls
  LIST_APKS: 'list_apks', // {} scan the project for built .apk/.aab artifacts
  START_METRO: 'start_metro', // { projectId? }
  STOP_METRO: 'stop_metro', // { projectId? }
  GIT: 'git', // { op: 'status'|'commit'|'push'|'log'|'diff'|'init', ...args }
  EAS_BUILD: 'eas_build', // { profile?, platform? }
  RUN: 'run', // { command, cwd? }  arbitrary command, streamed
  // Self-update (git pull the app's own repo)
  APP_VERSION: 'app_version', // {} — request current build info
  APP_UPDATE: 'app_update', // {} — git pull --ff-only the app repo
  REVERT: 'revert', // { turnId, checkpointId?, text } — restore files + truncate convo to before a user message
  // Meta
  PING: 'ping', // {}
  HELLO: 'hello', // {} — client requests a full state snapshot
});

/** Build a canonical event object. */
export function event(type, fields = {}) {
  return { type, ts: nowIso(), ...fields };
}

/**
 * A monotonic-ish ISO timestamp. The broker runs in proot where Date is fine;
 * kept in one place so tests can stub it.
 */
export function nowIso() {
  return new Date().toISOString();
}

/** Valid status states. */
export const StatusState = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  RUNNING: 'running',
  WAITING: 'waiting',
  ERROR: 'error',
});
