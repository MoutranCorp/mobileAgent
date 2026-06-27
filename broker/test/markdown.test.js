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
  assert.match(h, /<pre><code class="language-js">const x = 1 &lt; 2 &amp;&amp; a &gt; b;<\/code><\/pre>/);
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

test('partial input mid-stream does not throw (unterminated fence)', () => {
  assert.doesNotThrow(() => MD.render('intro\n\n```js\nconst a ='));
  const h = MD.render('intro\n\n```js\nconst a =');
  assert.match(h, /<pre><code class="language-js">/);
});

test('link/autolink URLs cannot break out of the href attribute (XSS)', () => {
  // A double-quote in the URL must not start a new attribute (regression for the
  // confirmed onmouseover-injection PoC).
  const h = MD.render('[x](https://a"onmouseover="alert(1)) and https://b"onmouseover="alert(2) end');
  // No event-handler attribute may appear in any opening <a> tag. (`[^>]*` is bounded
  // by the first `>`, so this inspects only attributes, not the harmless link text.)
  assert.doesNotMatch(h, /<a [^>]*\son\w+=/, 'no injected event-handler attribute in the tag');
  // Every " inside a URL must be escaped to &quot; so it can't close the href.
  assert.match(h, /href="https:\/\/a&quot;onmouseover=&quot;alert\(1"/, 'link quote escaped inside href');
  assert.match(h, /href="https:\/\/b&quot;onmouseover=&quot;alert\(2"/, 'autolink quote escaped inside href');
  // Disallowed schemes still neutralized.
  assert.match(MD.render('[x](javascript:alert(1))'), /href="#"/);
  // Ampersands in a normal URL are not double-escaped.
  assert.match(MD.render('[x](https://e.com/?a=1&b=2)'), /href="https:\/\/e\.com\/\?a=1&amp;b=2"/);
});

test('GFM tables render with headers, rows, and column alignment', () => {
  const md = [
    '| Name | Age | City |',
    '|:-----|:---:|-----:|',
    '| Ann  | 30  | NYC  |',
    '| Bob  | 25  | LA   |',
  ].join('\n');
  const h = MD.render(md);
  assert.match(h, /<table>/);
  assert.match(h, /<th[^>]*>Name<\/th>/);
  assert.match(h, /<th style="text-align:center">Age<\/th>/, 'center alignment from :--:');
  assert.match(h, /<th style="text-align:right">City<\/th>/, 'right alignment from --:');
  assert.match(h, /<td[^>]*>Ann<\/td>/);
  assert.match(h, /<td style="text-align:right">LA<\/td>/);
  assert.match(h, /class="table-wrap"/, 'wrapped for horizontal scroll');
  // A '|' line with no delimiter row underneath is NOT a table.
  assert.doesNotMatch(MD.render('a | b\nc | d'), /<table>/);
});

test('fenced code captures the language as data-lang + language- class', () => {
  const h = MD.render('```python\nprint(1)\n```');
  assert.match(h, /data-lang="python"/);
  assert.match(h, /<code class="language-python">/);
  // No language -> no attributes, still renders.
  const plain = MD.render('```\nplain\n```');
  assert.doesNotMatch(plain, /data-lang=/);
  assert.match(plain, /<pre><code>plain<\/code><\/pre>/);
});

test('blockquote recursion is depth-capped (no stack blow-up)', () => {
  const deep = Array.from({ length: 200 }, (_, i) => '>'.repeat(i + 1) + ' x').join('\n');
  assert.doesNotThrow(() => MD.render(deep));
});

test('tab-indented sublist is treated as nested', () => {
  const h = MD.render('- a\n\t- b');
  // The nested item opens a second <ul> (tabs expanded to spaces).
  assert.match(h, /<ul><li>a<\/li><ul><li>b<\/li><\/ul>/);
});
