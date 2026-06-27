/* Minimal LCS line diff for rendering Write/Edit tool cards. */
(function (global) {
  function lineDiff(before, after) {
    const a = (before || '').split('\n');
    const b = (after || '').split('\n');
    const m = a.length;
    const n = b.length;
    // LCS DP table.
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        rows.push({ type: 'ctx', text: a[i], aNum: i + 1, bNum: j + 1 });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        rows.push({ type: 'del', text: a[i], aNum: i + 1 });
        i++;
      } else {
        rows.push({ type: 'add', text: b[j], bNum: j + 1 });
        j++;
      }
    }
    while (i < m) rows.push({ type: 'del', text: a[i], aNum: ++i });
    while (j < n) rows.push({ type: 'add', text: b[j], bNum: ++j });
    return rows;
  }

  /** Collapse long runs of unchanged context to keep diffs readable. */
  function compact(rows, context = 3) {
    const keep = new Array(rows.length).fill(false);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].type !== 'ctx') {
        for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
          keep[k] = true;
        }
      }
    }
    const out = [];
    let hid = 0;
    for (let i = 0; i < rows.length; i++) {
      if (keep[i]) {
        if (hid > 0) { out.push({ type: 'gap', count: hid }); hid = 0; }
        out.push(rows[i]);
      } else {
        hid++;
      }
    }
    if (hid > 0) out.push({ type: 'gap', count: hid });
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  /** Render a diff (or a plain creation/edit) to an HTML string. */
  function renderDiff(input) {
    // Normalize inputs from various tool shapes.
    let before = input.before;
    let after = input.after;
    if (before == null && after == null) {
      if (input.old_string != null || input.new_string != null) {
        before = input.old_string || '';
        after = input.new_string || '';
      } else if (input.content != null) {
        before = '';
        after = input.content;
      }
    }
    if (before == null && after == null) {
      return `<pre>${escapeHtml(JSON.stringify(input, null, 2))}</pre>`;
    }
    // Size guard: the LCS table is O(m*n) Int32 cells; even ~1.5M cells (~6MB) is a
    // GC spike mid-stream on a phone. Keep the table well under a megabyte — above
    // ~400k cells (or 3000 total lines) show a plain view instead of a diff.
    const aLines = (before || '').split('\n').length;
    const bLines = (after || '').split('\n').length;
    if (aLines * bLines > 400000 || aLines + bLines > 3000) {
      const text = (after || before || '').split('\n').slice(0, 400).join('\n');
      return `<div class="diff"><div class="meta">large file — showing first 400 lines</div><pre>${escapeHtml(text)}</pre></div>`;
    }
    const rows = compact(lineDiff(before || '', after || ''));
    let adds = 0, dels = 0;
    const html = rows
      .map((r) => {
        if (r.type === 'gap') return `<div class="row"><span class="gutter">⋯</span><span class="sign"></span>… ${r.count} unchanged</div>`;
        if (r.type === 'add') adds++;
        if (r.type === 'del') dels++;
        const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
        const num = r.type === 'add' ? r.bNum : r.aNum;
        return `<div class="row ${r.type}"><span class="gutter">${num || ''}</span><span class="sign">${sign}</span>${escapeHtml(r.text)}</div>`;
      })
      .join('');
    const meta = `<div class="meta">+${adds} −${dels}</div>`;
    return `<div class="diff">${meta}${html}</div>`;
  }

  global.DiffRender = { lineDiff, renderDiff, escapeHtml };
})(window);
