#!/usr/bin/env node
/**
 * webshot — capture a screenshot of any URL with headless Chromium and (by
 * default) auto-render it inline in the agent broker UI.
 *
 * Built for the on-device stack: runs the system Chromium under proot/Termux
 * (ARM64), so it needs --no-sandbox + headless (no X display). After writing the
 * PNG into the active project, it pings the broker's /widget endpoint so the shot
 * renders as an inline card in the transcript — no Write/Edit tool event needed.
 *
 * Usage:
 *   node webshot.js <url> [options]
 *
 * Options:
 *   --out <path>      output PNG path (default: screenshots/<host>-<ts>.png, relative to cwd)
 *   --full            full-page screenshot (default: viewport only)
 *   --selector <css>  screenshot just the element matching this selector
 *   --width <n>       viewport width  (default 1280)
 *   --height <n>      viewport height (default 800)
 *   --wait <state>    waitUntil: load | domcontentloaded | networkidle (default networkidle)
 *   --timeout <ms>    navigation timeout (default 60000)
 *   --no-widget       don't notify the broker (just write the file)
 *   --broker <url>    broker base URL (default $BROKER_URL or http://127.0.0.1:8765)
 *
 * Exit code 0 on success; prints a JSON line { ok, path, title, url } to stdout.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');

function parseArgs(argv) {
  const o = { full: false, widget: true, width: 1280, height: 800, wait: 'networkidle', timeout: 60000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') o.full = true;
    else if (a === '--no-widget') o.widget = false;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--selector') o.selector = argv[++i];
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--height') o.height = Number(argv[++i]);
    else if (a === '--wait') o.wait = argv[++i];
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--broker') o.broker = argv[++i];
    else if (a.startsWith('--')) { /* ignore unknown flag */ }
    else rest.push(a);
  }
  o.url = rest[0];
  return o;
}

// Find a usable Chromium/Chrome binary on this machine.
function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/data/data/com.termux/files/usr/bin/chromium',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function tsStamp() {
  // Date is available in the broker/proot runtime (unlike workflow scripts).
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

// Ping the broker so the screenshot auto-renders inline. Best-effort.
function notifyBroker(brokerUrl, relPath) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/widget', brokerUrl); } catch { return resolve(false); }
    u.searchParams.set('path', relPath);
    u.searchParams.set('kind', 'image');
    const req = http.get(u, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.url) {
    console.error('usage: node webshot.js <url> [--out p] [--full] [--selector css] [--width n] [--height n]');
    process.exit(2);
  }
  if (!/^https?:\/\//i.test(o.url)) o.url = 'https://' + o.url;

  const exe = findChromium();
  if (!exe) {
    console.error('No Chromium found. Install it: apt-get install -y chromium  (or set CHROMIUM_PATH)');
    process.exit(3);
  }

  let host = 'page';
  try { host = new URL(o.url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
  const outRel = o.out || path.join('screenshots', `${host}-${tsStamp()}.png`);
  const outAbs = path.resolve(outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  let title = '';
  try {
    const page = await browser.newPage({ viewport: { width: o.width, height: o.height } });
    await page.goto(o.url, { waitUntil: o.wait, timeout: o.timeout });
    title = await page.title();
    if (o.selector) {
      const elt = await page.waitForSelector(o.selector, { timeout: o.timeout });
      await elt.screenshot({ path: outAbs });
    } else {
      await page.screenshot({ path: outAbs, fullPage: o.full });
    }
  } finally {
    await browser.close();
  }

  let rendered = false;
  if (o.widget) {
    const brokerUrl = o.broker || process.env.BROKER_URL || 'http://127.0.0.1:8765';
    // /widget resolves the path relative to the ACTIVE PROJECT dir; pass the path
    // relative to cwd, which is the project dir when the engine runs the agent.
    rendered = await notifyBroker(brokerUrl, outRel.split(path.sep).join('/'));
  }
  console.log(JSON.stringify({ ok: true, path: outRel, title, url: o.url, rendered }));
}

main().catch((e) => { console.error('webshot error:', e.message); process.exit(1); });
