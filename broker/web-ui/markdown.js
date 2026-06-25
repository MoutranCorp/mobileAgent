/*
 * markdown.js — a small, dependency-free, XSS-safe Markdown -> HTML renderer for
 * assistant messages. It escapes all HTML first, then layers Markdown on top, so
 * model output can never inject markup. Covers the elements chat replies use:
 * headings, bold/italic/strike, inline + fenced code, ordered/unordered lists
 * (one nesting level), blockquotes, links/autolinks, horizontal rules,
 * paragraphs and line breaks. Tolerant of partial input so it works mid-stream
 * (an unterminated ``` fence renders as an open code block).
 *
 * Exposed as window.MD.render(src) -> html string.
 */
(function () {
  'use strict';

  var FENCE = String.fromCharCode(1); // sentinel wrapping a fenced-code-block index
  var CODE = String.fromCharCode(0);  // sentinel wrapping an inline-code index

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function safeUrl(u) {
    // Allow http(s), mailto and relative/anchor links; block javascript: etc.
    return /^(https?:\/\/|mailto:|\/|#)/i.test(u) ? u : '#';
  }

  // Inline spans. Input is already HTML-escaped. Inline code is protected first
  // so formatting/URL rules never touch code contents.
  function inline(text) {
    var codes = [];
    text = text.replace(/`([^`]+)`/g, function (_m, c) { codes.push(c); return CODE + (codes.length - 1) + CODE; });

    text = text
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, t, u) { return '<a href="' + safeUrl(u) + '" target="_blank" rel="noopener">' + t + '</a>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_m, p, u) { return p + '<a href="' + safeUrl(u) + '" target="_blank" rel="noopener">' + u + '</a>'; });

    return text.replace(new RegExp(CODE + '(\\d+)' + CODE, 'g'), function (_m, i) { return '<code>' + codes[+i] + '</code>'; });
  }

  function isBlockStart(line) {
    return /^\s*$/.test(line) ||
      /^(#{1,6})\s+/.test(line) ||
      /^\s*([-*_])\1\1+\s*$/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line) ||
      line.indexOf(FENCE) !== -1;
  }

  // Group consecutive list lines into <ul>/<ol>, supporting one indented level.
  function renderList(lines, start, ordered) {
    var re = ordered ? /^(\s*)\d+[.)]\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
    var i = start;
    var html = ordered ? '<ol>' : '<ul>';
    var openSub = false;
    while (i < lines.length) {
      var m = lines[i].match(re);
      if (!m) break;
      var indented = m[1].length >= 2;
      if (indented && !openSub) { html += ordered ? '<ol>' : '<ul>'; openSub = true; }
      else if (!indented && openSub) { html += ordered ? '</ol>' : '</ul>'; openSub = false; }
      html += '<li>' + inline(escapeHtml(m[2])) + '</li>';
      i++;
    }
    if (openSub) html += ordered ? '</ol>' : '</ul>';
    html += ordered ? '</ol>' : '</ul>';
    return { html: html, next: i };
  }

  function render(src) {
    src = String(src == null ? '' : src).replace(/\r\n/g, '\n');

    // Pull out fenced code blocks first (escaped, never further processed).
    var blocks = [];
    src = src.replace(/```[^\n`]*\n([\s\S]*?)```/g, function (_m, code) {
      blocks.push(code.replace(/\n$/, ''));
      return '\n' + FENCE + (blocks.length - 1) + FENCE + '\n';
    });
    // Tolerate an unterminated fence while streaming.
    var open = src.indexOf('```');
    if (open !== -1) {
      var rest = src.slice(open + 3).replace(/^[^\n`]*\n?/, '');
      blocks.push(rest);
      src = src.slice(0, open) + '\n' + FENCE + (blocks.length - 1) + FENCE + '\n';
    }

    var lines = src.split('\n');
    var html = '';
    var i = 0;
    var fenceRe = new RegExp('^' + FENCE + '(\\d+)' + FENCE + '$');
    while (i < lines.length) {
      var line = lines[i];
      var m;

      if ((m = line.match(fenceRe))) {
        html += '<pre><code>' + escapeHtml(blocks[+m[1]]) + '</code></pre>'; i++; continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { html += '<hr>'; i++; continue; }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        html += '<h' + m[1].length + '>' + inline(escapeHtml(m[2])) + '</h' + m[1].length + '>'; i++; continue;
      }
      if (/^\s*>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += '<blockquote>' + render(q.join('\n')) + '</blockquote>'; continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) { var ru = renderList(lines, i, false); html += ru.html; i = ru.next; continue; }
      if (/^\s*\d+[.)]\s+/.test(line)) { var ro = renderList(lines, i, true); html += ro.html; i = ro.next; continue; }

      // paragraph — gather until a blank line or the next block element
      var p = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { p.push(lines[i]); i++; }
      html += '<p>' + inline(escapeHtml(p.join('\n'))).replace(/\n/g, '<br>') + '</p>';
    }
    return html;
  }

  window.MD = { render: render, escapeHtml: escapeHtml };
})();
