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

test('partial input mid-stream does not throw (unterminated fence)', () => {
  assert.doesNotThrow(() => MD.render('intro\n\n```js\nconst a ='));
  const h = MD.render('intro\n\n```js\nconst a =');
  assert.match(h, /<pre><code>/);
});
