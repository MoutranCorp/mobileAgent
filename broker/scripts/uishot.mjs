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

const browser = await chromium.launch();
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

await page.fill('#input', 'Build a polished counter screen with a + button');
await page.dispatchEvent('#input', 'input');
await sleep(400);
console.log('CHECK has-text:', await page.evaluate(() => document.querySelector('.composer')?.classList.contains('has-text')));
await shot('02-composer');

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

try { await page.click('#menuBtn'); await sleep(700); await shot('04-sheet');
  const skills = page.locator('.mgr-tab', { hasText: 'Skills' });
  if (await skills.count()) { await skills.first().click(); await sleep(500); await shot('05-sheet-skills'); }
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

await browser.close();
if (errors.length) { console.error('\n*** JS ERRORS ***'); errors.forEach((e) => console.error('  -', e)); process.exit(1); }
console.log('\nNo JS console errors. ->', OUT);
