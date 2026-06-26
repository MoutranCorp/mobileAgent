---
name: webshot
description: Capture a screenshot of any website (or scrape/test a web app) with headless Chromium, on-device. Use when the user asks to screenshot a URL, see what a site looks like, scrape rendered page content, or test a web app in a real browser. The screenshot auto-renders inline in the app.
---

# webshot — on-device browser screenshots & scraping

Drives headless Chromium locally (ARM64, under proot/Termux) via Playwright. A
captured screenshot is dropped into the active project and **auto-rendered inline**
in the broker UI through the `/widget` endpoint — no Write/Edit round-trip.

## Take a screenshot

Run from the project directory (so the file lands where the UI can serve it):

```bash
node ~/.agent-tools/webshot/webshot.js <url>
```

The shot is saved to `screenshots/<host>-<timestamp>.png` and a viewer card appears
in the transcript automatically. The command prints a JSON line with `path` and the
page `title`.

### Options

| Flag | Meaning |
|---|---|
| `--out <path>` | output PNG path (relative to cwd) |
| `--full` | full-page screenshot (default: viewport only) |
| `--selector <css>` | screenshot only the matching element |
| `--width <n>` / `--height <n>` | viewport size (default 1280×800) |
| `--wait load\|domcontentloaded\|networkidle` | when to capture (default `networkidle`) |
| `--no-widget` | just write the file, don't render a card |

Example — full page of a specific element:

```bash
node ~/.agent-tools/webshot/webshot.js https://example.com --full --out screenshots/example.png
```

## Scrape / test a web app

For richer automation (read text, fill forms, assert behavior), write a short
Playwright script and require the same engine:

```js
const { chromium } = require('/root/.agent-tools/webshot/node_modules/playwright-core');
const b = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await b.newPage();
await page.goto('https://example.com');
console.log(await page.title(), await page.locator('h1').innerText());
await b.close();
```

## Notes & limits

- **`--no-sandbox` is required** under proot (no Linux user namespaces). Fine for
  normal sites; avoid loading untrusted/hostile pages with the sandbox off.
- **One browser at a time** — Chromium is RAM-heavy on a phone. Reuse pages; don't
  fan out many instances.
- **Bot-protected sites** (Cloudflare, etc.) may block headless. That's a Playwright
  reality, not a phone limit.
- If Chromium is missing: `apt-get install -y chromium` (or run the installer at
  `tools/webshot/install.sh` in the mobileAgent repo). Override the binary with
  `CHROMIUM_PATH`.
