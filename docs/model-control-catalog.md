# Engine Model, Effort, and Speed Catalog Plan

Status: implemented for the broker/WebUI Codex path. Remaining follow-up: a
larger bottom-sheet selector can replace the current compact select controls if
the UI needs more room for descriptions and upgrade copy.

Goal: the composer model selector should be engine-aware and should match the
Codex desktop/app-server model picker as closely as the app-server protocol
allows. It must dynamically discover Codex models, supported reasoning efforts,
and speed/service-tier options when possible, and fall back to a checked-in
snapshot only when dynamic discovery fails.

This is a multi-engine plan. Do not solve it with Codex-only UI conditionals.

## Current Problem

The current selector path is still shaped by Claude Code:

- `broker/src/controls/model-resolver.js` probes Claude aliases by spawning the
  Claude CLI and reading `system/init.model`.
- `broker/src/profiles.js` stores a static `profile.models` array.
- `broker/src/server.js` emits `MODELS` as `{ items: [{ alias, id, label }] }`.
- `broker/web-ui/app.js` renders a small `<select>` from aliases and applies a
  Claude-only `ultracode` rule for effort.
- Codex currently advertises only `gpt-5.5` in the built-in profile, so the UI
  cannot expose the actual Codex model picker, per-model efforts, or speed
  options.

This is why Codex model/effort/speed selection feels broken even when turns can
run.

## Verified Codex Sources

Use these sources in this order.

### 1. Live app-server `model/list`

The installed Codex app-server protocol exposes:

```json
{ "method": "model/list", "params": { "limit": 100, "includeHidden": false } }
```

The generated schema says each model includes:

- `id`
- `model`
- `displayName`
- `description`
- `hidden`
- `isDefault`
- `defaultReasoningEffort`
- `supportedReasoningEfforts`
- `serviceTiers`
- `defaultServiceTier`
- `inputModalities`
- `upgrade`
- `upgradeInfo`
- `availabilityNux`

The same schema shows:

- `thread/start` accepts `model`, `modelProvider`, and `serviceTier`.
- `turn/start` accepts `model`, `effort`, and `serviceTier`.

This is the source of truth for Codex UI controls.

### 2. Live app-server `config/read`

Use `config/read` to understand the effective default selections where needed:

- `model`
- `model_reasoning_effort`
- `service_tier`
- `model_provider`
- feature flags such as `fast_mode`, if exposed in the effective config

Do not parse `~/.codex/config.toml` directly in shared broker code unless
app-server does not expose the required information.

### 3. Profile/user customizations

Preserve user customizations:

- Profile `model` remains a preferred default.
- Profile `models` remains a custom/pinned list, especially for non-Codex
  providers or manually-entered model ids.
- A selected custom model that is not in the dynamic catalog should still be
  selectable and should be labeled as custom.

Dynamic catalog entries should not delete user profile edits.

### 4. Checked-in fallback snapshot

If dynamic Codex discovery fails because the CLI is missing, auth is broken, the
app-server is too old, or the device is offline, use a checked-in fallback
catalog.

A local probe against the installed Codex app-server returned:

```json
[
  {
    "id": "gpt-5.5",
    "model": "gpt-5.5",
    "displayName": "GPT-5.5",
    "description": "Frontier model for complex coding, research, and real-world work.",
    "isDefault": true,
    "defaultReasoningEffort": "xhigh",
    "supportedReasoningEfforts": ["low", "medium", "high", "xhigh"],
    "serviceTiers": [
      { "id": "priority", "name": "Fast", "description": "1.5x speed, increased usage" }
    ],
    "defaultServiceTier": "priority"
  },
  {
    "id": "gpt-5.4",
    "model": "gpt-5.4",
    "displayName": "GPT-5.4",
    "description": "Strong model for everyday coding.",
    "isDefault": false,
    "upgrade": "gpt-5.5",
    "defaultReasoningEffort": "medium",
    "supportedReasoningEfforts": ["low", "medium", "high", "xhigh"],
    "serviceTiers": [
      { "id": "priority", "name": "Fast", "description": "1.5x speed, increased usage" }
    ],
    "defaultServiceTier": "priority"
  },
  {
    "id": "gpt-5.4-mini",
    "model": "gpt-5.4-mini",
    "displayName": "GPT-5.4-Mini",
    "description": "Small, fast, and cost-efficient model for simpler coding tasks.",
    "isDefault": false,
    "defaultReasoningEffort": "medium",
    "supportedReasoningEfforts": ["low", "medium", "high", "xhigh"],
    "serviceTiers": [],
    "defaultServiceTier": null
  }
]
```

Keep this snapshot in a data file, not scattered through UI code. Recommended:

- `broker/src/controls/catalogs/codex-app-server.json`

Refresh this snapshot with a script whenever Codex CLI behavior changes.

## Product Contract

The composer should show:

- Active engine.
- Active model display name.
- Active reasoning effort, using only efforts supported by the selected model.
- Active speed/service tier when the selected model advertises service tiers.

For Codex:

- Model options come from `model/list`.
- Effort options come from the selected model's `supportedReasoningEfforts`.
- Speed options come from the selected model's `serviceTiers`.
- The UI should include an implicit Standard speed option that means "no
  additional service tier override" and advertised tiers such as Fast. Verify the
  exact app-server clearing behavior before treating `null` as a persisted
  standard override.
- Hidden models are not shown by default. If a hidden/custom model is already
  selected, keep it visible as the selected custom value.
- Upgrade/NUX copy may be shown in the expanded selector sheet, but not as noisy
  chat output.

For Claude:

- Preserve current alias behavior until a Claude catalog provider replaces it.
- Efforts remain Claude-specific.
- `ultracode` stays Claude-only and must not appear for Codex unless a future
  Codex catalog explicitly advertises it.

For unknown engines:

- If the engine declares no catalog support, show the profile default and hide
  unsupported controls.
- Do not show Codex or Claude controls based only on hardcoded harness checks in
  the web UI.

## Protocol Shape

Add an engine-neutral catalog event. Recommended:

```js
EventType.ENGINE_OPTIONS = 'engine_options'
CommandType.ENGINE_OPTIONS_LIST = 'engine_options_list'
CommandType.SET_SERVICE_TIER = 'set_service_tier'
```

Recommended event payload:

```js
{
  profileId: 'codex-app-server',
  harness: 'codex-app-server',
  source: 'dynamic', // dynamic | cache | fallback | profile
  stale: false,
  selected: {
    model: 'gpt-5.5',
    effort: 'xhigh',
    serviceTier: 'priority'
  },
  models: [
    {
      id: 'gpt-5.5',
      model: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      hidden: false,
      isDefault: true,
      custom: false,
      defaultEffort: 'xhigh',
      efforts: [
        { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
        { id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { id: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
        { id: 'xhigh', label: 'Extra High', description: 'Extra high reasoning depth for complex problems' }
      ],
      serviceTiers: [
        { id: null, label: 'Standard', description: 'Default speed and usage' },
        { id: 'priority', label: 'Fast', description: '1.5x speed, increased usage' }
      ],
      defaultServiceTier: 'priority',
      inputModalities: ['text', 'image'],
      upgrade: null,
      availabilityMessage: null
    }
  ]
}
```

Keep the existing `MODELS` event temporarily for backwards compatibility, but
move composer rendering to `ENGINE_OPTIONS`. Once every UI surface uses
`ENGINE_OPTIONS`, `MODELS` can become a compatibility shim or be retired in a
separate cleanup.

## Engine Contract

Extend `EngineAdapter` with a catalog method:

```js
async listControlOptions(_opts = {}) {
  return null;
}
```

Extend feature declarations:

```js
features = {
  models: false,
  effort: false,
  speed: false,
  dynamicModelCatalog: false,
  customModel: false
}
```

Rules:

- Engine adapters return raw engine-specific catalog data normalized to the
  broker event shape.
- Shared UI reads only the normalized event shape.
- Engines with no dynamic catalog fall back to profile data.

## Codex Implementation Plan

### Live engine path

In `broker/src/engines/codex-app-server.js`:

- Add `listControlOptions({ refresh, includeHidden })`.
- If the app-server process is already initialized, call paginated
  `model/list`.
- Optionally call `config/read` to determine effective defaults.
- Normalize `displayName` to `label`, `supportedReasoningEfforts` to `efforts`,
  and `serviceTiers` to speed options.
- Cache the normalized result on the engine instance.

### Probe path before a session exists

Add a resolver that can query Codex without starting a model thread:

- Recommended file: `broker/src/controls/engine-options.js`
- For Codex, spawn `codex app-server --stdio`, call `initialize`, send
  `initialized`, request `model/list`, then terminate.
- Use `resolveCodexLaunch()` so Windows uses `node .../codex.js` and
  Android/proot-Debian can use the normal `codex` executable.
- Use `spawn` with argument arrays and `shell: false`.
- Use the active project cwd when available, but never fall back to the app repo
  cwd as the project context.
- Timeout quickly, for example 10-15 seconds, and fall back without blocking the
  composer forever.

### Fallback path

- Load `broker/src/controls/catalogs/codex-app-server.json`.
- Mark the event as `{ source: 'fallback', stale: true }`.
- Append any profile custom models that are not already in the fallback.

### Passing selections to Codex

In `CodexAppServerEngine`:

- Store `this.serviceTier` from `opts.serviceTier`.
- Include `serviceTier` in `_threadStartParams()`.
- Include `serviceTier` in `turn/start`.
- Keep `model` and `effort` in both `thread/start` and `turn/start` as they are
  today.
- Add tests proving model, effort, and serviceTier are sent on fresh threads and
  subsequent turns.

Open question to verify during implementation:

- How does app-server clear a previously selected Fast service tier back to
  Standard for an existing thread? Test whether `serviceTier: null`, omitting the
  field, or another value is required. Do not guess.

## Session and Settings State

Add per-session metadata:

```js
{
  model,
  effort,
  serviceTier
}
```

Persist user defaults:

```json
{
  "engine": {
    "model": "gpt-5.5",
    "effort": "xhigh",
    "serviceTier": "priority"
  }
}
```

Update:

- `broker/src/session.js`
- `broker/src/server.js`
- `broker/src/controls/user-settings.js`
- Cron/job model override surfaces if they should support speed.

Rules:

- On model change, if the current effort is unsupported by the new model, switch
  to the model's `defaultReasoningEffort`.
- On model change, if the current service tier is unsupported by the new model,
  switch to that model's `defaultServiceTier` or Standard.
- Do not carry Claude-only aliases such as `opus`, `sonnet`, `haiku`, or
  `ultracode` into Codex.
- Do not carry Codex service tiers into Claude.

## UI Plan

The current two tiny selects are not enough for Codex parity. Replace or augment
them with a compact composer pill that opens a bottom sheet.

Composer collapsed state:

```text
Codex | GPT-5.5 | XHigh | Fast
```

Expanded selector sheet:

- Model list with display name and short description.
- Upgrade or availability note for a model when present.
- Reasoning effort segmented control based on the selected model.
- Speed segmented control with Standard plus advertised service tiers.
- Custom model entry for profiles that allow custom model ids.

Phone constraints:

- Keep the collapsed pill short and ellipsized.
- The sheet should scroll vertically.
- Avoid wide tables.
- Do not render docs-like explanatory paragraphs in the normal composer.

Windows constraints:

- The same web UI must work in desktop browsers.
- Do not use Android-only WebView APIs for catalog selection.

## Implementation Phases

### Phase 1: Protocol and Normalizer

Files:

- `broker/src/protocol.js`
- `broker/src/engines/base.js`
- `broker/src/controls/engine-options.js`
- `broker/src/controls/catalogs/codex-app-server.json`
- `broker/test/engine-options.test.js`

Tasks:

- Add the event/command constants.
- Add the base adapter `listControlOptions` method and feature flags.
- Implement normalizers for:
  - Codex `model/list` response.
  - Profile-only fallback data.
  - Custom profile model append.
- Add the checked-in Codex fallback catalog from the local app-server probe.

Acceptance:

- Normalized Codex fixture includes GPT-5.5, GPT-5.4, and GPT-5.4-Mini with the
  right effort/service-tier options.
- Profile custom models are appended once.
- Unknown engines produce a profile-source catalog without crashing.

### Phase 2: Codex Dynamic Discovery

Files:

- `broker/src/engines/codex-app-server.js`
- `broker/src/controls/engine-options.js`
- `broker/test/codex-app-server*.test.js`

Tasks:

- Implement live `model/list` on an initialized Codex engine.
- Implement short-lived probe discovery when no live engine exists.
- Add paginated `model/list` support.
- Add fallback on timeout/error.
- Cache catalog results by `{ harness, auth identity if available, codex version }`
  or at minimum by harness with a short TTL.

Acceptance:

- A fake app-server fixture returning `model/list` drives the normalized catalog.
- If `model/list` errors, the fallback catalog is returned with `source:
  'fallback'`.
- No test assumes POSIX paths.

### Phase 3: Session State and Codex Params

Files:

- `broker/src/session.js`
- `broker/src/server.js`
- `broker/src/controls/user-settings.js`
- `broker/src/engines/codex-app-server.js`
- Tests around session switching/model switching.

Tasks:

- Add `serviceTier` to per-session meta.
- Add `SET_SERVICE_TIER`.
- Persist selected service tier in user settings.
- Send `serviceTier` through Codex `thread/start` and `turn/start`.
- On `SWITCH_MODEL`, validate current effort/speed against the selected model.

Acceptance:

- Codex fresh thread params contain selected model/effort/serviceTier.
- Codex turn params contain selected model/effort/serviceTier.
- Switching from GPT-5.5 Fast to GPT-5.4-Mini drops Fast if unsupported.
- Claude sessions ignore Codex service tiers.

### Phase 4: Web UI Selector

Files:

- `broker/web-ui/index.html`
- `broker/web-ui/app.js`
- `broker/web-ui/styles.css`
- `broker/web-ui/managers.js` if cron/job selectors need the same catalog.

Tasks:

- Render from `ENGINE_OPTIONS`, not profile aliases.
- Add the compact composer pill and model/settings sheet.
- Render effort choices from selected model metadata.
- Render speed choices from service tiers.
- Keep existing selects or hidden form controls only as implementation details.
- Request `ENGINE_OPTIONS_LIST` on profile change, tab focus, and explicit refresh.

Acceptance:

- Codex selector shows GPT-5.5, GPT-5.4, and GPT-5.4-Mini from the catalog.
- Effort list changes per selected model.
- Fast appears only for models whose catalog has a service tier.
- No `ultracode` appears for Codex.
- `npm run uishot` passes with no console errors.

### Phase 5: Docs and Android Verification

Files:

- `docs/features.md`
- `docs/architecture.md`
- `docs/codex-app-server.md`
- `docs/development.md` if commands change.
- `dist/app-debug.apk` only if Android native code or bundled broker startup
  assets changed.

Tasks:

- Document that Codex model/effort/speed is discovered through app-server
  `model/list`.
- Document fallback behavior.
- Test on Windows.
- Test on Android/proot-Debian with the phone's installed Codex CLI and auth.

Acceptance:

- `cd broker && npm test`
- `cd broker && npm run uishot`
- Real phone smoke:
  - Open Codex profile.
  - Model sheet shows dynamic catalog.
  - Select GPT-5.4-Mini.
  - Verify effort defaults to Medium.
  - Verify Fast is not offered if the catalog has no service tier.
  - Select GPT-5.5 Fast/XHigh.
  - Send a prompt and verify `turn/start` uses the selected cwd/model/effort/speed.

## Delegation Prompt

Use this prompt for the implementation agent:

```text
Implement docs/model-control-catalog.md. Start with Phases 1-3: add an engine-neutral ENGINE_OPTIONS catalog event, normalize Codex app-server model/list responses, add the checked-in Codex fallback catalog, dynamically probe Codex through app-server when possible, store per-session serviceTier, and pass model/effort/serviceTier to Codex thread/start and turn/start. Preserve Claude behavior and keep Windows plus Android/proot-Debian portability. Add focused node:test coverage before UI work.
```

Then hand off UI work with:

```text
Implement Phase 4 from docs/model-control-catalog.md. Replace the composer's Claude-shaped model/effort selects with an engine catalog-driven model/settings sheet. Codex options must come from ENGINE_OPTIONS, effort must be per selected model, speed must come from serviceTiers, and ultracode must remain Claude-only. Run npm run uishot.
```

## Review Checklist

- Dynamic `model/list` is the primary source.
- Fallback catalog is data, not scattered literals.
- UI reads normalized catalog data, not Codex-specific schema.
- Effort and speed are validated when model changes.
- Service tier is per session, not global.
- No POSIX-only process/path assumptions.
- No Android-only browser APIs in shared UI.
- Claude behavior remains unchanged.
- Codex `thread/start` and `turn/start` receive cwd/model/effort/serviceTier.
