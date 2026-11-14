// Comparing two code blocks: choose one (its header button, or the command), click
// another, and see them side by side with what changed between them.
import { t, toast, hideToast } from '../util.js';
import { diffLines, diffWordsWithSpace } from 'diff';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const linesOf = (value) => value.replace(/\n$/, '').split('\n');
const KEEP = 3; // unchanged lines kept around each change

/** Paired rows for a side-by-side view: { kind, a, b, la, lb } (null = nothing on that side). */
export function diffRows(aText, bText) {
  const parts = diffLines(aText.replace(/\n?$/, '\n'), bText.replace(/\n?$/, '\n'));
  const rows = [];
  let la = 1, lb = 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], lines = linesOf(p.value);
    if (p.removed && parts[i + 1] && parts[i + 1].added) {
      const add = linesOf(parts[++i].value);
      for (let k = 0; k < Math.max(lines.length, add.length); k++) {
        const a = k < lines.length ? lines[k] : null, b = k < add.length ? add[k] : null;
        rows.push({ kind: a == null ? 'add' : b == null ? 'del' : 'chg', a, b, la: a == null ? null : la++, lb: b == null ? null : lb++ });
      }
    } else if (p.removed) for (const l of lines) rows.push({ kind: 'del', a: l, b: null, la: la++, lb: null });
    else if (p.added) for (const l of lines) rows.push({ kind: 'add', a: null, b: l, la: null, lb: lb++ });
    else for (const l of lines) rows.push({ kind: 'ctx', a: l, b: l, la: la++, lb: lb++ });
  }
  return rows;
}

/** The same comparison as the text of a ```diff block. */
export function diffText(aText, bText) {
  const out = [];
  for (const p of diffLines(aText.replace(/\n?$/, '\n'), bText.replace(/\n?$/, '\n'))) {
    for (const l of linesOf(p.value)) out.push((p.added ? '+' : p.removed ? '-' : ' ') + l);
  }
  return out.join('\n');
}

/** A changed line pair with the differing words marked; plain when the lines barely resemble each other. */
function wordMarks(a, b) {
  const parts = diffWordsWithSpace(a, b);
  const same = parts.reduce((n, p) => n + (p.added || p.removed ? 0 : p.value.trim().length), 0);
  if (same < Math.max(a.trim().length, b.trim().length) * 0.3) return [esc(a), esc(b)];
  let left = '', right = '';
  for (const p of parts) {
    if (p.added) right += `<ins>${esc(p.value)}</ins>`;
    else if (p.removed) left += `<del>${esc(p.value)}</del>`;
    else { left += esc(p.value); right += esc(p.value); }
  }
  return [left, right];
}

export function initCodeDiff(ctx) {
  const { editor, api } = ctx;
  let picking = null; // the first block, while waiting for the second
  let shown = null;   // { a, b } on screen
  let sheet = null;

  const label = (blk) => blk.title || `${blk.lang || t('代码', 'code')} · ${t(`第 ${blk.line} 行`, `line ${blk.line}`)}`;

  function stop() {
    if (!picking) return;
    picking = null;
    editor.setPick(-1);
    document.body.classList.remove('picking-code');
    hideToast();
  }
  /** Begin with the block at `pos` (default: the caret's block). */
  function start(pos) {
    const blk = editor.codeBlockAt(pos);
    if (!blk) { toast(t('先把光标放进一个代码块，或点代码块右上角的对比按钮', 'Put the caret in a code block first, or use the compare button on a block')); return; }
    picking = blk;
    editor.setPick(blk.from);
    document.body.classList.add('picking-code');
    toast(t('再点另一个代码块，与它对比　　esc 取消', 'Now click another code block to compare    esc cancels'), 0);
  }
  editor.view.dom.addEventListener('mousedown', (e) => {
    if (!picking || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const pos = editor.posAt(e.clientX, e.clientY);
    const blk = pos == null ? null : editor.codeBlockAt(pos);
    if (!blk) { stop(); return; }           // clicked outside any code: cancel
    if (blk.from === picking.from) return;  // the same block: keep waiting
    const first = editor.codeBlockAt(picking.from) || picking;
    stop();
    open(first, blk);
  }, true);
  editor.onChange(stop);
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!picking && !shown)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (picking) stop(); else close();
  }, true);

  function close() {
    if (sheet) sheet.remove();
    sheet = null; shown = null;
    editor.focus();
  }

  function open(a, b) {
    if (sheet) sheet.remove();
    shown = { a, b };
    const rows = diffRows(a.code, b.code);
    const add = rows.filter((r) => r.b != null && r.kind !== 'ctx').length, del = rows.filter((r) => r.a != null && r.kind !== 'ctx').length;
    sheet = document.createElement('div');
    sheet.id = 'codediff';
    const box = document.createElement('div');
    box.className = 'cd-sheet';
    box.tabIndex = -1;

    const top = document.createElement('div');
    top.className = 'cd-top';
    const stat = add + del ? `<b class="add">+${add}</b><b class="del">−${del}</b>` : '';
    top.innerHTML = `<span class="eyebrow">${esc(t('代码对比', 'Code comparison'))}</span><span class="cd-stat">${stat}</span><span class="cd-space"></span>`;
    const button = (text, run, cls = '') => {
      const el = document.createElement('button');
      el.className = cls; el.textContent = text; el.onclick = run;
      top.append(el);
      return el;
    };
    button(t('互换', 'Swap'), () => open(b, a));
    if (add + del) {
      button(t('拷贝差异', 'Copy diff'), () => { api.copyText(diffText(a.code, b.code)); toast(t('已拷贝差异', 'Diff copied')); });
      button(t('插入为 diff 代码块', 'Insert as diff block'), () => {
        const text = diffText(a.code, b.code);
        const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((x) => x.length + 1)));
        const last = a.to > b.to ? a : b;
        close();
        editor.insertBelow(last.to, `${fence}diff\n${text}\n${fence}`);
        ctx.refreshViews && ctx.refreshViews();
      }, 'primary');
    }
    button('✕', close, 'cd-close');

    const names = document.createElement('div');
    names.className = 'cd-names';
    names.innerHTML = `<span>${esc(label(a))}</span><span>${esc(label(b))}</span>`;

    const body = document.createElement('div');
    body.className = 'cd-body';
    if (!(add + del)) body.innerHTML = `<div class="cd-same">${esc(t('两段代码完全相同。', 'The two blocks are identical.'))}</div>`;
    else body.append(...render(rows));

    box.append(top, names, body);
    sheet.append(box);
    sheet.addEventListener('mousedown', (e) => { if (e.target === sheet) close(); });
    document.body.append(sheet);
    box.focus();
  }

  const cell = (n, html, kind) => `<span class="cd-n">${n == null ? '' : n}</span><span class="cd-t ${kind}">${html == null ? '' : html || ' '}</span>`;
  function rowEl(r) {
    const el = document.createElement('div');
    el.className = 'cd-row';
    let left = r.a == null ? null : esc(r.a), right = r.b == null ? null : esc(r.b);
    if (r.kind === 'chg') [left, right] = wordMarks(r.a, r.b);
    el.innerHTML = cell(r.la, left, r.a == null ? 'none' : r.kind === 'ctx' ? '' : 'del') + cell(r.lb, right, r.b == null ? 'none' : r.kind === 'ctx' ? '' : 'add');
    return el;
  }
  /** Rows as elements; long unchanged stretches fold into one line that opens on click. */
  function render(rows) {
    const out = [];
    for (let i = 0; i < rows.length;) {
      if (rows[i].kind !== 'ctx') { out.push(rowEl(rows[i++])); continue; }
      let j = i;
      while (j < rows.length && rows[j].kind === 'ctx') j++;
      const run = rows.slice(i, j), head = i === 0 ? 0 : KEEP, tail = j === rows.length ? 0 : KEEP;
      if (run.length <= head + tail + 2) out.push(...run.map(rowEl));
      else {
        out.push(...run.slice(0, head).map(rowEl));
        const hiddenRows = run.slice(head, run.length - tail);
        const gap = document.createElement('button');
        gap.className = 'cd-gap';
        gap.textContent = t(`${hiddenRows.length} 行相同`, `${hiddenRows.length} unchanged lines`);
        gap.onclick = () => gap.replaceWith(...hiddenRows.map(rowEl));
        out.push(gap, ...run.slice(run.length - tail).map(rowEl));
      }
      i = j;
    }
    return out;
  }

  return { start, stop, open, close, isPicking: () => !!picking, isOpen: () => !!shown };
}
