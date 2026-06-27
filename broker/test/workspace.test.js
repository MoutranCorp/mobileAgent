import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync as fsExists } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { BrokerServer } from '../src/server.js';
import { ProjectManager } from '../src/controls/projects.js';

async function tmpDir(p) { return fs.mkdtemp(path.join(os.tmpdir(), p)); }

test('ProjectManager.openPath opens an arbitrary folder + browse lists subdirs', async () => {
  const projectsDir = await tmpDir('ws-projects-');
  const stateDir = await tmpDir('ws-state-');
  const outside = await tmpDir('ws-outside-');
  await fs.mkdir(path.join(outside, 'sub-a'), { recursive: true });
  await fs.writeFile(path.join(outside, 'package.json'), '{"name":"x"}');
  const pm = new ProjectManager({ config: { projectsDir, stateDir, metroBasePort: 8081 }, runner: {}, emit() {} });

  // browse the outside dir's parent → should include the folder
  const b = pm.browse(outside);
  assert.equal(b.path, path.resolve(outside));
  assert.ok(b.dirs.some((d) => d.name === 'sub-a'));

  // open it as the active workspace
  const res = pm.openPath(outside);
  assert.ok(res.project, 'should open');
  assert.equal(res.project.dir, path.resolve(outside));
  assert.equal(res.project.external, true);
  assert.equal(pm.getActive().dir, path.resolve(outside));
  // it now appears in the project list
  assert.ok(pm.list().some((p) => p.dir === path.resolve(outside)));
  // bad path rejected
  assert.ok(pm.openPath(path.join(outside, 'does-not-exist')).error);
});

test('e2e: workspace_browse + open_path over WS', async () => {
  const projects = await tmpDir('wse-proj-');
  const state = await tmpDir('wse-state-');
  const outside = await tmpDir('wse-outside-');
  await fs.mkdir(path.join(outside, 'myapp'), { recursive: true });
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });

  ws.send(JSON.stringify({ type: 'workspace_browse', path: outside }));
  const b = await waitFor((e) => e.type === 'workspace_browse');
  assert.ok(b.dirs.some((d) => d.name === 'myapp'));

  ws.send(JSON.stringify({ type: 'open_path', path: outside }));
  const proj = await waitFor((e) => e.type === 'projects' && e.activeProjectId);
  const active = proj.projects.find((p) => p.id === proj.activeProjectId);
  assert.equal(active.dir, path.resolve(outside));

  ws.close();
  await server.stop();
});

test('e2e: project_delete removes a managed project + its folder over WS', async () => {
  const projects = await tmpDir('pde-proj-');
  const state = await tmpDir('pde-state-');
  await fs.mkdir(path.join(projects, 'gamma'), { recursive: true });
  await fs.writeFile(path.join(projects, 'gamma', 'README.md'), '# gamma');
  await fs.mkdir(path.join(projects, 'delta'), { recursive: true });
  const config = loadConfig(['--profile', 'mock', '--port', '0', '--projects', projects, '--state', state]);
  const server = new BrokerServer(config);
  await server.start();
  const port = server.httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const listeners = new Set();
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); events.push(ev); for (const l of [...listeners]) l(ev); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const ex = events.find(pred); if (ex) return resolve(ex);
    const l = (ev) => { if (pred(ev)) { clearTimeout(t); listeners.delete(l); resolve(ev); } };
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout')); }, ms);
    listeners.add(l);
  });

  ws.send(JSON.stringify({ type: 'project_delete', id: 'gamma' }));
  const after = await waitFor((e) => e.type === 'projects' && !e.projects.some((p) => p.id === 'gamma'));
  assert.ok(!after.projects.some((p) => p.id === 'gamma'), 'gamma no longer listed');
  assert.equal(fsExists(path.join(projects, 'gamma')), false, 'gamma folder deleted from disk');
  assert.equal(fsExists(path.join(projects, 'delta')), true, 'sibling untouched');

  ws.close();
  await server.stop();
});

test('ProjectManager.deleteProject removes a managed project from disk', async () => {
  const projectsDir = await tmpDir('del-projects-');
  const stateDir = await tmpDir('del-state-');
  const pm = new ProjectManager({ config: { projectsDir, stateDir, metroBasePort: 8081 }, runner: {}, emit() {} });
  // Two managed projects on disk.
  await fs.mkdir(path.join(projectsDir, 'alpha'), { recursive: true });
  await fs.writeFile(path.join(projectsDir, 'alpha', 'README.md'), '# alpha');
  await fs.mkdir(path.join(projectsDir, 'beta'), { recursive: true });
  pm.setActive('alpha');
  const before = pm.list().map((p) => p.id).sort();
  assert.deepEqual(before, ['alpha', 'beta']);

  const res = pm.deleteProject('alpha');
  assert.ok(res.ok && res.dirDeleted, 'managed project deleted from disk');
  assert.equal(res.wasActive, true);
  assert.equal(res.newActiveId, 'beta', 'active re-points to a survivor');
  assert.equal(fsExists(path.join(projectsDir, 'alpha')), false, 'folder gone');
  assert.ok(!pm.list().some((p) => p.id === 'alpha'), 'no longer listed');
  assert.equal(pm.getActive().id, 'beta');
});

test('ProjectManager.deleteProject only forgets an EXTERNAL workspace (never rm its folder)', async () => {
  const projectsDir = await tmpDir('del2-projects-');
  const stateDir = await tmpDir('del2-state-');
  const outside = await tmpDir('del2-outside-');
  await fs.writeFile(path.join(outside, 'keep.txt'), 'precious');
  const pm = new ProjectManager({ config: { projectsDir, stateDir, metroBasePort: 8081 }, runner: {}, emit() {} });
  const opened = pm.openPath(outside).project;

  const res = pm.deleteProject(opened.id);
  assert.ok(res.ok, 'forgotten');
  assert.equal(res.dirDeleted, false, 'external folder is NOT deleted from disk');
  assert.equal(fsExists(path.join(outside, 'keep.txt')), true, 'user files left intact');
  assert.ok(!pm.list().some((p) => p.id === opened.id), 'removed from the list');
});

test('ProjectManager.deleteProject reports an error for an unknown id', async () => {
  const projectsDir = await tmpDir('del3-projects-');
  const stateDir = await tmpDir('del3-state-');
  const pm = new ProjectManager({ config: { projectsDir, stateDir, metroBasePort: 8081 }, runner: {}, emit() {} });
  assert.ok(pm.deleteProject('nope').error, 'unknown id -> error');
});
