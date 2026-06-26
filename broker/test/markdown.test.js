import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// markdown.js is browser code that assigns window.MD; shim a global window then
// import it so we can unit-test the pure renderer in node.
let MD;
before(async () => {
  globalThis.window = {};
  await import('../web-ui/markdown.js');
  MD = globalThis.window.MD;
});

test('renders the common block + inline elements', () => {
  const h = MD.render('## Title\n\nText with **bold**, *italic*, ~~no~~ and `code`.');
  assert.match(h, /<h2>Title<\/h2>/);
  assert.match(h, /<strong>bold<\/strong>/);
  assert.match(h, /<em>italic<\/em>/);
  assert.match(h, /<del>no<\/del>/);
  assert.match(h, /<code>code<\/code>/);
});

test('ordered + unordered lists and links', () => {
  const ol = MD.render('1. one\n2. two');
  assert.match(ol, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  const ul = MD.render('- a\n- b');
  assert.match(ul, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  const link = MD.render('see [docs](https://x.com)');
  assert.match(link, /<a href="https:\/\/x\.com" target="_blank" rel="noopener">docs<\/a>/);
});

test('fenced code blocks escape HTML and are not formatted', () => {
  const h = MD.render('```js\nconst x = 1 < 2 && a > b;\n```');
  assert.match(h, /<pre><code>const x = 1 &lt; 2 &amp;&amp; a &gt; b;<\/code><\/pre>/);
});

test('blockquote and horizontal rule', () => {
  assert.match(MD.render('> hi'), /<blockquote><p>hi<\/p><\/blockquote>/);
  assert.match(MD.render('---'), /<hr>/);
});

test('is XSS-safe: HTML is escaped and dangerous URLs are neutralized', () => {
  const h = MD.render('<img src=x onerror=alert(1)> and **safe**');
  assert.ok(!/<img/.test(h), 'raw HTML must be escaped');
  assert.match(h, /&lt;img/);
  assert.match(h, /<strong>safe<\/strong>/);
  const link = MD.render('[x](javascript:alert(1))');
  assert.ok(!/javascript:/.test(link), 'javascript: URLs must be dropped');
});

test('fenced code blocks get a copy button whose data-copy round-trips the raw text', () => {
  const code = 'npm run build && echo "done"\nrm -rf <dir> & sleep 1';
  const h = MD.render('```sh\n' + code + '\n```');
  assert.match(h, /<button class="code-copy"[^>]*data-copy="/);
  // Extract the data-copy attribute and decode the entities escapeAttr produced.
  const m = h.match(/data-copy="([^"]*)"/);
  assert.ok(m, 'data-copy present and quote-safe');
  const decoded = m[1]
    .replace(/&#10;/g, '\n').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(decoded, code, 'copy text equals the original including quotes, &, <> and newlines');
});

test('renders a GFM pipe table with header, body and a scroll wrapper', () => {
  const h = MD.render('| Name | Age |\n| --- | --- |\n| Ann | 30 |\n| Bob | 25 |');
  assert.match(h, /<div class="md-table-wrap"><table>/);
  assert.match(h, /<thead><tr><th>Name<\/th><th>Age<\/th><\/tr><\/thead>/);
  assert.match(h, /<tbody><tr><td>Ann<\/td><td>30<\/td><\/tr><tr><td>Bob<\/td><td>25<\/td><\/tr><\/tbody>/);
});

test('table column alignment from the delimiter row becomes text-align', () => {
  const h = MD.render('| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |');
  assert.match(h, /<th style="text-align:left">L<\/th>/);
  assert.match(h, /<th style="text-align:center">C<\/th>/);
  assert.match(h, /<th style="text-align:right">R<\/th>/);
  assert.match(h, /<td style="text-align:center">b<\/td>/);
});

test('table cells render inline markdown and stay XSS-safe', () => {
  const h = MD.render('| a | b |\n|---|---|\n| **bold** | <img src=x> |');
  assert.match(h, /<td><strong>bold<\/strong><\/td>/);
  assert.ok(!/<img/.test(h), 'HTML inside cells must be escaped');
  assert.match(h, /&lt;img/);
});

test('tolerates ragged rows and missing/extra leading pipes', () => {
  // header has 3 cols; rows are short / long / pipe-less-edges — must not throw
  const h = MD.render('| a | b | c |\n| - | - | - |\nx | y\n| p | q | r | s |');
  assert.doesNotThrow(() => MD.render('| a | b |\n| - | - |\n| 1 |'));
  assert.match(h, /<td>x<\/td><td>y<\/td><td><\/td>/); // short row padded
});

test('a pipe line without a delimiter row is NOT a table', () => {
  const h = MD.render('use a | b in prose\nand more text');
  assert.ok(!/<table>/.test(h), 'plain text with pipes stays a paragraph');
  assert.match(h, /<p>/);
});

test('partial input mid-stream does not throw (unterminated fence)', () => {
  assert.doesNotThrow(() => MD.render('intro\n\n```js\nconst a ='));
  const h = MD.render('intro\n\n```js\nconst a =');
  assert.match(h, /<pre><code>/);
});
