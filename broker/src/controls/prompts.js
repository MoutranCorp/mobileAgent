import fs from 'node:fs';
import path from 'node:path';

/**
 * PromptLibrary — saved, reusable prompts/templates the user can insert with one
 * tap. Persisted at <stateDir>/prompts.json. Seeded with a few useful defaults.
 */
const DEFAULTS = [
  { name: 'Add tests', text: 'Add unit tests for the code we just wrote and run them.' },
  { name: 'Fix the error', text: 'Here is the error from the running app — find the cause and fix it.' },
  { name: 'Refactor for clarity', text: 'Refactor this for clarity and simplicity without changing behavior.' },
  { name: 'Explain', text: 'Explain how this part of the codebase works, with file references.' },
];

export class PromptLibrary {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'prompts.json');
    this.items = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(arr)) return arr;
      }
    } catch {
      /* ignore */
    }
    this._save(DEFAULTS);
    return DEFAULTS.slice();
  }

  _save(items) {
    try { fs.writeFileSync(this.file, JSON.stringify(items, null, 2)); } catch { /* ignore */ }
  }

  list() {
    return this.items;
  }

  save(name, text) {
    if (!name) return;
    const i = this.items.findIndex((p) => p.name === name);
    if (i >= 0) this.items[i] = { name, text };
    else this.items.push({ name, text });
    this._save(this.items);
  }

  delete(name) {
    this.items = this.items.filter((p) => p.name !== name);
    this._save(this.items);
  }
}
