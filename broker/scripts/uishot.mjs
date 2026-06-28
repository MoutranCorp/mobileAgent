/*
 * Visual + smoke harness for the web UI. Drives the live mock-broker UI through
 * its key states at iPhone dimensions, screenshots each, and fails loud on any
 * JS console/page error. Used to verify the UI looks and works after changes.
 *
 *   1) start a mock broker:  node src/index.js --engine mock --port 8799
 *   2) run:                   node scripts/uishot.mjs [outPrefix]
 *      env: UI_URL (default http://127.0.0.1:8799), SCHEME=light|dark, OUT_DIR
 *
 * Exits non-zero if any console error occurs, so it can gate CI.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.UI_URL || 'http://127.0.0.1:8799';
const PREFIX = process.argv[2] || 'shot';
const OUT = process.env.OUT_DIR || '.uishots';
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 393, height: 852 }; // iPhone 15 Pro logical size
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Allow pointing at a pre-installed Chromium (e.g. a CI/cloud image that ships one
// at a fixed path) instead of Playwright's own download, which may not be present.
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
const ctx = await browser.newContext({
  viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  colorScheme: process.env.SCHEME === 'light' ? 'light' : 'dark',
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const shot = async (n) => { await page.screenshot({ path: `${OUT}/${PREFIX}-${n}.png` }); console.log('shot', n); };

await page.goto(URL, { waitUntil: 'networkidle' });
await sleep(900);
await shot('01-empty');

// Tabbed shell: strip under the title bar; folder/access moved into the composer.
console.log('CHECK tab strip present:', await page.evaluate(() => !!document.getElementById('tabStrip')));
console.log('CHECK folder pill in composer:', await page.evaluate(() => !!document.querySelector('.composer #folderPill')));
console.log('CHECK access pill in composer:', await page.evaluate(() => !!document.querySelector('.composer .access-pill #permModeSelect')));
console.log('CHECK old context-bar removed:', await page.evaluate(() => !document.querySelector('.context-bar')));
// Folder switcher sheet (folder pill tap).
try {
  await page.click('#folderPill'); await sleep(400);
  console.log('CHECK folder sheet opens:', await page.evaluate(() => !document.getElementById('folderSheet').classList.contains('hidden')));
  await shot('01b-folder-sheet');
  await page.click('#folderSheetScrim'); await sleep(250);
} catch (e) { console.log('folder-sheet err', e.message); }
// System tab (RESOURCES panel).
try {
  await page.click('#menuBtn'); await sleep(400);
  const sys = page.locator('.mgr-tab', { hasText: 'System' });
  if (await sys.count()) {
    await sys.first().click(); await sleep(500);
    console.log('CHECK system RAM bar:', await page.evaluate(() => !!document.querySelector('.sys-bar-fill')));
    console.log('CHECK system engines listed:', await page.evaluate(() => document.querySelectorAll('.sys-engine').length));
    await shot('01c-system-tab');
  }
  await page.evaluate(() => document.getElementById('managerModal')?.classList.add('hidden'));
} catch (e) { console.log('system-tab err', e.message); }

// Tab long-press menu (Phase 4): hold a tab -> menu with rename, colours, close actions.
try {
  const tb = await page.locator('#tabs .tab').first().boundingBox();
  if (tb) {
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down(); await sleep(600); await page.mouse.up();
    console.log('CHECK tab long-press menu:', await page.evaluate(() => !!document.getElementById('tabMenu')));
    console.log('CHECK menu has rename + swatches:', await page.evaluate(() => !!document.querySelector('#tabMenu .tab-menu-rename') && document.querySelectorAll('#tabMenu .tab-swatch').length > 0));
    await shot('01e-tab-menu');
    await page.evaluate(() => document.body.click());
  }
} catch (e) { console.log('tab-menu err', e.message); }

await page.fill('#input', 'Build a polished counter screen with a + button');
await page.dispatchEvent('#input', 'input');
await sleep(400);
console.log('CHECK has-text:', await page.evaluate(() => document.querySelector('.composer')?.classList.contains('has-text')));
console.log('CHECK model pill in composer:', await page.evaluate(() => !!document.querySelector('.composer-card .model-pill #modelSelect')));
console.log('CHECK transcript inset reserved:', await page.evaluate(() => parseInt(getComputedStyle(document.getElementById('transcript')).paddingBottom) > 60));
await shot('02-composer');

// Expand button + fullscreen editor (appears once the draft passes ~5 lines).
await page.fill('#input', 'line1\nline2\nline3\nline4\nline5\nline6 of a long prompt');
await page.dispatchEvent('#input', 'input');
await sleep(300);
console.log('CHECK expand button visible:', await page.evaluate(() => { const b = document.getElementById('expandBtn'); return !!b && !b.classList.contains('hidden'); }));
await shot('02c-expand-affordance');
await page.click('#expandBtn');
await sleep(400);
console.log('CHECK fullscreen editor open:', await page.evaluate(() => { const f = document.getElementById('fullEditor'); return !!f && !f.classList.contains('hidden'); }));
console.log('CHECK fullscreen carries text:', await page.evaluate(() => (document.getElementById('fullEditorText').value || '').includes('line6')));
await shot('02d-fullscreen');
await page.click('#fullEditorClose');
await sleep(250);
await page.fill('#input', 'Build a polished counter screen with a + button');
await page.dispatchEvent('#input', 'input');
await sleep(200);

await page.click('#sendBtn');
await sleep(120);
console.log('CHECK activity row present in gap:', await page.evaluate(() => !!document.getElementById('activityRow')));
await shot('02a-dots'); // typing dots fill the pre-response gap
await sleep(500);
console.log('CHECK busy after send:', await page.evaluate(() => document.querySelector('.composer')?.classList.contains('busy')));
await shot('02b-working'); // thinking trace + Stop button
await sleep(2800);
await page.evaluate(() => { const t = document.getElementById('transcript'); if (t) t.scrollTop = t.scrollHeight; });
await sleep(300);
await shot('03-convo');

// resolve any pending approval so the next message can send (send is blocked while busy/waiting)
const approve = page.locator('.approval-actions button.accent');
if (await approve.count()) { await approve.first().click(); await sleep(1500); }

// markdown rendering check (mock emits a rich-markdown reply for this prompt)
await page.fill('#input', 'explain how markdown formatting renders');
await page.dispatchEvent('#input', 'input');
await page.click('#sendBtn');
await sleep(2600);
await page.evaluate(() => { const t = document.getElementById('transcript'); if (t) t.scrollTop = t.scrollHeight; });
await sleep(300);
await shot('03b-markdown');
await page.evaluate(() => { const t = document.getElementById('transcript'); if (t) t.scrollTop = Math.max(0, t.scrollHeight - 1700); });
await sleep(200);
await shot('03c-markdown-mid');

// bubble action menu (long-press equiv via contextmenu)
try {
  await page.locator('.msg.user').last().dispatchEvent('contextmenu');
  await sleep(400); await shot('07b-bubble-menu-user');
  await page.keyboard.press('Escape');
  await page.locator('.msg.assistant .bubble').last().dispatchEvent('contextmenu');
  await sleep(400); await shot('07c-bubble-menu-assistant');
  await page.keyboard.press('Escape');
} catch (e) { console.log('bubble menu err', e.message); }

try { await page.click('#menuBtn'); await sleep(700); await shot('04-sheet');
  const skills = page.locator('.mgr-tab', { hasText: 'Skills' });
  if (await skills.count()) { await skills.first().click(); await sleep(500); await shot('05-sheet-skills'); }
  const sess = page.locator('.mgr-tab', { hasText: 'Sessions' });
  if (await sess.count()) { await sess.first().click(); await sleep(700); await shot('05d-sessions'); }
  const upd = page.locator('.mgr-tab', { hasText: 'Update' });
  if (await upd.count()) {
    await upd.first().click(); await sleep(700); await shot('05b-update');
    if (process.env.UISHOT_UPDATE === '1') { // runs a real `git pull` — opt-in only
      await page.locator('.mgr-pane button.primary').click(); await sleep(2500); await shot('05c-update-result');
    }
  }
  await page.evaluate(() => document.getElementById('managerModal')?.classList.add('hidden'));
} catch (e) { console.log('sheet err', e.message); }

try { await page.click('#paletteBtn'); await sleep(500); await shot('06-palette'); await page.keyboard.press('Escape'); }
catch (e) { console.log('palette err', e.message); }

try { await page.click('#termBtn'); await sleep(500); await shot('07-terminal'); await page.click('#termClose'); }
catch (e) { console.log('term err', e.message); }

// HTML microapp widget (needs an active project so /preview can serve the file)
try {
  await page.evaluate(() => window.Agent.send({ type: 'open_project', projectId: 'demo' }));
  await sleep(1000);
  await page.fill('#input', 'build me an html microapp');
  await page.dispatchEvent('#input', 'input');
  await page.click('#sendBtn');
  await sleep(1600);
  const ap = page.locator('.approval-actions button.accent');
  if (await ap.count()) await ap.first().click();
  await sleep(2600);
  // Widgets default to collapsed now — click Show to reveal the iframe.
  const showBtn = page.locator('.html-app-actions .ghost.small', { hasText: 'Show' });
  if (await showBtn.count()) { await showBtn.first().click(); await sleep(900); }
  await page.evaluate(() => { const a = document.querySelector('.html-app'); if (a) a.scrollIntoView({ block: 'center' }); });
  await sleep(800);
  console.log('CHECK html-app iframe present:', await page.evaluate(() => !!document.querySelector('.html-app .html-app-iframe')));
  console.log('CHECK html-app height:', await page.evaluate(() => { const a = document.querySelector('.html-app'); return a ? Math.round(a.getBoundingClientRect().height) : 0; }));
  await shot('08-html-app');
  // View-source toggle on the HTML widget.
  const codeBtn = page.locator('.html-app-actions .ghost.small', { hasText: 'Code' });
  if (await codeBtn.count()) {
    await codeBtn.first().click(); await sleep(700);
    console.log('CHECK html-app source shown:', await page.evaluate(() => { const c = document.querySelector('.html-app-code'); return !!c && !c.classList.contains('hidden') && (c.querySelector('code')?.textContent || '').length > 10; }));
    await page.evaluate(() => { const a = document.querySelector('.html-app'); if (a) a.scrollIntoView({ block: 'center' }); });
    await shot('08b-html-code');
  }
} catch (e) { console.log('html-app err', e.message); }

// SVG / image / markdown inline viewer (mock writes icon.svg for an "svg icon" prompt)
try {
  await page.fill('#input', 'create an svg icon for the app');
  await page.dispatchEvent('#input', 'input');
  await page.click('#sendBtn');
  await sleep(1400);
  const ap2 = page.locator('.approval-actions button.accent');
  if (await ap2.count()) await ap2.first().click();
  await sleep(2200);
  await page.evaluate(() => { const imgs = [...document.querySelectorAll('.html-app')]; const a = imgs[imgs.length - 1]; if (a) a.scrollIntoView({ block: 'center' }); });
  await sleep(700);
  const svgCardOf = () => `[...document.querySelectorAll('.html-app')].find(c => c.querySelector('.html-app-name')?.textContent === 'icon.svg')`;
  // Reveal the collapsed svg widget first.
  await page.evaluate(`(() => { const card = ${svgCardOf()}; const btn = [...(card?.querySelectorAll('.html-app-actions .ghost.small')||[])].find(b => /Show/.test(b.textContent)); btn && btn.click(); })()`);
  await sleep(700);
  console.log('CHECK svg viewer img present:', await page.evaluate(`(${svgCardOf()})?.querySelector('.html-app-body.media img.html-app-img') ? true : false`));
  console.log('CHECK svg viewer checker bg:', await page.evaluate(`(${svgCardOf()})?.querySelector('.html-app-body.media.checker') ? true : false`));
  console.log('CHECK svg viewer loaded ok:', await page.evaluate(`(() => { const i = (${svgCardOf()})?.querySelector('img.html-app-img'); return !!i && i.complete && i.naturalWidth > 0; })()`));
  await shot('10-svg-viewer');
  // Click View source on the icon.svg card specifically (state replay can add others).
  await page.evaluate(`(() => { const card = ${svgCardOf()}; const btn = [...(card?.querySelectorAll('.html-app-actions .ghost.small')||[])].find(b => /Code/.test(b.textContent)); btn && btn.click(); })()`);
  await sleep(1000);
  console.log('CHECK svg source shown:', await page.evaluate(`(() => { const card = ${svgCardOf()}; const panel = card?.querySelector('.html-app-code'); return !!panel && !panel.classList.contains('hidden') && (panel.querySelector('code')?.textContent || '').includes('<svg'); })()`));
  await page.evaluate(`(${svgCardOf()})?.scrollIntoView({ block: 'center' })`);
  await shot('10b-svg-code');
  // File tab (Phase 3): open the svg as an editable tab via the widget Tab button.
  const editBtn = page.locator('.html-app-actions .ghost.small', { hasText: 'Tab' });
  if (await editBtn.count()) {
    await editBtn.last().click(); await sleep(800);
    console.log('CHECK file view opens:', await page.evaluate(() => !document.getElementById('fileView').classList.contains('hidden')));
    console.log('CHECK file tab in strip:', await page.evaluate(() => document.querySelectorAll('#tabs .tab.file-tab').length > 0));
    await shot('10c-file-tab');
    await page.click('#fvSource'); await sleep(600);
    console.log('CHECK file source editable:', await page.evaluate(() => { const t = document.querySelector('#fvBody .fv-source'); return !!t && !t.disabled; }));
    await page.click('#fvClose'); await sleep(400);
    console.log('CHECK back to chat after close:', await page.evaluate(() => document.getElementById('transcript').style.display !== 'none'));
  }
} catch (e) { console.log('svg-viewer err', e.message); }

// Markdown file viewer (mock writes NOTES.md for a "readme" prompt)
try {
  await page.fill('#input', 'write a readme for this project');
  await page.dispatchEvent('#input', 'input');
  await page.click('#sendBtn');
  await sleep(1400);
  const ap3 = page.locator('.approval-actions button.accent');
  if (await ap3.count()) await ap3.first().click();
  await sleep(2200);
  // Reveal the collapsed markdown widget first.
  await page.evaluate(() => { const a = [...document.querySelectorAll('.html-app')].pop(); const btn = [...(a?.querySelectorAll('.html-app-actions .ghost.small')||[])].find(b => /Show/.test(b.textContent)); btn && btn.click(); });
  await sleep(700);
  await page.evaluate(() => { const a = [...document.querySelectorAll('.html-app')].pop(); if (a) a.scrollIntoView({ block: 'center' }); });
  await sleep(700);
  console.log('CHECK md viewer rendered:', await page.evaluate(() => !!document.querySelector('.html-app-body.mdbody .bubble.md h1')));
  await shot('11-md-viewer');
} catch (e) { console.log('md-viewer err', e.message); }

// APK build widget (mock writes android/.../app-release.apk for a build prompt)
try {
  await page.fill('#input', 'build the release apk');
  await page.dispatchEvent('#input', 'input');
  await page.click('#sendBtn');
  await sleep(2600);
  await page.evaluate(() => { const a = document.querySelector('.apk-app'); if (a) a.scrollIntoView({ block: 'center' }); });
  await sleep(500);
  console.log('CHECK apk widget present:', await page.evaluate(() => !!document.querySelector('.apk-app')));
  console.log('CHECK apk save button:', await page.evaluate(() => { const b = document.querySelector('.apk-app .primary'); return b ? b.textContent : null; }));
  await shot('09-apk');
} catch (e) { console.log('apk err', e.message); }

await browser.close();
if (errors.length) { console.error('\n*** JS ERRORS ***'); errors.forEach((e) => console.error('  -', e)); process.exit(1); }
console.log('\nNo JS console errors. ->', OUT);
