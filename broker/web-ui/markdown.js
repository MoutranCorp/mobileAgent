/*
 * markdown.js — a small, dependency-free, XSS-safe Markdown -> HTML renderer for
 * assistant messages. It escapes all HTML first, then layers Markdown on top, so
 * model output can never inject markup. Covers the elements chat replies use:
 * headings, bold/italic/strike, inline + fenced code, ordered/unordered lists
 * (one nesting level), blockquotes, links/autolinks, horizontal rules, GFM pipe
 * tables (with column alignment), paragraphs and line breaks. Tolerant of
 * partial input so it works mid-stream
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
  // Escape for an HTML attribute value; encode newlines so the raw text round-trips
  // exactly through dataset (used by code-block copy buttons).
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\r/g, '').replace(/\n/g, '&#10;');
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

  // ---- GFM pipe tables --------------------------------------------------
  // Split a table row into cell strings, honoring \| escapes and dropping the
  // optional leading/trailing pipes.
  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    var cells = [];
    var cur = '';
    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === '\\' && s.charAt(k + 1) === '|') { cur += '|'; k++; continue; }
      if (ch === '|') { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells;
  }
  // A delimiter row is all dash-cells with optional alignment colons (| :--- | -: |).
  function isDelimiterRow(line) {
    if (line.indexOf('|') === -1 && !/^\s*:?-+:?\s*$/.test(line)) return false;
    var cells = splitRow(line);
    if (!cells.length) return false;
    return cells.every(function (c) { return /^:?-+:?$/.test(c.trim()); });
  }
  // A table starts where a header line (containing a pipe) is followed by a
  // delimiter row with a matching column count.
  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    if (lines[i].indexOf('|') === -1) return false;
    if (!isDelimiterRow(lines[i + 1])) return false;
    return splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
  }
  function renderTable(lines, start) {
    var heads = splitRow(lines[start]);
    var aligns = splitRow(lines[start + 1]).map(function (d) {
      d = d.trim();
      var l = d.charAt(0) === ':', r = d.charAt(d.length - 1) === ':';
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    function cell(tag, text, c) {
      var a = aligns[c] ? ' style="text-align:' + aligns[c] + '"' : '';
      return '<' + tag + a + '>' + inline(escapeHtml(String(text).trim())) + '</' + tag + '>';
    }
    var html = '<div class="md-table-wrap"><table><thead><tr>';
    for (var c = 0; c < heads.length; c++) html += cell('th', heads[c], c);
    html += '</tr></thead><tbody>';
    var i = start + 2;
    while (i < lines.length && lines[i].indexOf('|') !== -1 &&
           !/^\s*$/.test(lines[i]) && !isDelimiterRow(lines[i])) {
      var cells = splitRow(lines[i]);
      html += '<tr>';
      for (var d = 0; d < heads.length; d++) html += cell('td', cells[d] == null ? '' : cells[d], d);
      html += '</tr>';
      i++;
    }
    html += '</tbody></table></div>';
    return { html: html, next: i };
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
        var raw = blocks[+m[1]];
        html += '<div class="code-block"><button class="code-copy" type="button" data-copy="' + escapeAttr(raw) + '">Copy</button>' +
          '<pre><code>' + escapeHtml(raw) + '</code></pre></div>'; i++; continue;
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
      if (isTableStart(lines, i)) { var rt = renderTable(lines, i); html += rt.html; i = rt.next; continue; }

      // paragraph — gather until a blank line or the next block element
      var p = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i]) && !isTableStart(lines, i)) { p.push(lines[i]); i++; }
      html += '<p>' + inline(escapeHtml(p.join('\n'))).replace(/\n/g, '<br>') + '</p>';
    }
    return html;
  }

  window.MD = { render: render, escapeHtml: escapeHtml, escapeAttr: escapeAttr };
})();
