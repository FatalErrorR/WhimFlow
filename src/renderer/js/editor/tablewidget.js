// Tables you edit in place, like a spreadsheet: type in cells, Tab / Enter to move,
// right-click to add or remove rows and columns, drag the grips to reorder.
// Every change is written straight back to the Markdown table.
import { WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { splitRow, layout } from './table.js';
import { renderInline } from '../render.js';
import { live } from './widgets.js';
import { showMenu } from '../util.js';

const ALIGN_CSS = { l: 'left', c: 'center', r: 'right' };
const unesc = (s) => s.replace(/\\\|/g, '|');
const esc = (s) => s.replace(/\\?\|/g, '\\|');
const isMac = /Mac/.test(navigator.platform);

export function parseTable(src) {
  const lines = src.split('\n');
  const rows = lines.map(splitRow);
  const ncol = Math.max(...rows.map((r) => r.length));
  const delim = rows[1] || [];
  const aligns = Array.from({ length: ncol }, (_, i) => {
    const d = (delim[i] || '').trim();
    return d.startsWith(':') && d.endsWith(':') && d.length > 1 ? 'c' : d.endsWith(':') ? 'r' : d.startsWith(':') ? 'l' : '';
  });
  const body = [rows[0], ...rows.slice(2)].map((r) => Array.from({ length: ncol }, (_, i) => unesc(r[i] || '')));
  return { rows: body, aligns, indent: /^\s*/.exec(lines[0])[0] };
}

export function serializeTable(m) {
  const delim = m.aligns.map((a) => ({ l: ':--', c: ':-:', r: '--:' }[a] || '---'));
  const rows = m.rows.map((r) => r.map((c) => esc(c.replace(/\n/g, ' '))));
  return layout([rows[0], delim, ...rows.slice(1)]).lines.map((l) => m.indent + l).join('\n');
}

/** The document range of the table drawn by `dom`. */
function tableRange(view, dom) {
  let pos;
  try { pos = view.posAtDOM(dom); } catch (_) { return null; }
  let node = null;
  syntaxTree(view.state).iterate({ from: pos, to: Math.min(view.state.doc.length, pos + 1), enter: (n) => { if (n.name === 'Table') { node = n.node; return false; } } });
  if (!node) return null;
  const { doc } = view.state;
  return { from: doc.lineAt(node.from).from, to: doc.lineAt(node.to).to };
}

function cellAt(dom, r, c) { return dom.querySelector(`.mf-cell[data-r="${r}"][data-c="${c}"]`); }
function caretToEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
}
function focusCell(dom, r, c) {
  const m = dom._model;
  r = Math.max(0, Math.min(r, m.rows.length - 1)); c = Math.max(0, Math.min(c, m.rows[0].length - 1));
  const cell = cellAt(dom, r, c);
  if (!cell) return;
  cell.focus();
  caretToEnd(cell);
}

function render(dom) {
  const m = dom._model;
  const table = dom.querySelector('table');
  table.textContent = '';
  const thead = document.createElement('thead'), tbody = document.createElement('tbody');
  m.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach((text, c) => {
      const cell = document.createElement(r === 0 ? 'th' : 'td');
      cell.className = 'mf-cell';
      cell.dataset.r = r; cell.dataset.c = c;
      cell.contentEditable = 'plaintext-only';
      cell.spellcheck = false;
      if (m.aligns[c]) cell.style.textAlign = ALIGN_CSS[m.aligns[c]];
      cell.innerHTML = renderInline(text, { base: live.base }) || '';
      tr.append(cell);
    });
    (r === 0 ? thead : tbody).append(tr);
  });
  table.append(thead, tbody);
}

function commit(dom, structural = false) {
  const view = dom._view;
  const src = serializeTable(dom._model);
  if (src === dom._source) return;
  const range = tableRange(view, dom);
  if (!range) return;
  const old = view.state.sliceDoc(range.from, range.to);
  dom._source = src;
  let a = 0;
  while (a < old.length && a < src.length && old[a] === src[a]) a++;
  let b = 0;
  while (b < old.length - a && b < src.length - a && old[old.length - 1 - b] === src[src.length - 1 - b]) b++;
  // typing in a cell groups like normal typing; each structural change is its own undo step
  view.dispatch({ changes: { from: range.from + a, to: range.to - b, insert: src.slice(a, src.length - b) }, userEvent: structural ? 'input.table' : 'input.type',
    annotations: structural ? isolateHistory.of('full') : [] });
}

/** Structural edits: change the model, redraw, write back, put the caret somewhere sensible. */
function restructure(dom, fn, focus) {
  const active = document.activeElement && document.activeElement.closest && document.activeElement.closest('.mf-cell');
  if (active) active.blur();
  fn(dom._model);
  render(dom);
  commit(dom, true);
  if (focus) focusCell(dom, focus[0], focus[1]);
}
const ops = {
  addRow: (dom, at) => restructure(dom, (m) => m.rows.splice(at, 0, Array(m.rows[0].length).fill('')), [at, 0]),
  delRow: (dom, r) => { if (r > 0) restructure(dom, (m) => m.rows.splice(r, 1), [r - 1, 0]); },
  addCol: (dom, at) => restructure(dom, (m) => { m.rows.forEach((row) => row.splice(at, 0, '')); m.aligns.splice(at, 0, ''); }, [0, at]),
  delCol: (dom, c) => {
    if (dom._model.rows[0].length === 1) { ops.delTable(dom); return; }
    restructure(dom, (m) => { m.rows.forEach((row) => row.splice(c, 1)); m.aligns.splice(c, 1); }, [0, Math.max(0, c - 1)]);
  },
  align: (dom, c, a) => restructure(dom, (m) => { m.aligns[c] = m.aligns[c] === a ? '' : a; }),
  moveRow: (dom, from, to) => restructure(dom, (m) => { const [row] = m.rows.splice(from, 1); m.rows.splice(to, 0, row); }),
  moveCol: (dom, from, to) => restructure(dom, (m) => {
    m.rows.forEach((row) => { const [x] = row.splice(from, 1); row.splice(to, 0, x); });
    const [al] = m.aligns.splice(from, 1); m.aligns.splice(to, 0, al);
  }),
  delTable(dom) {
    const view = dom._view, range = tableRange(view, dom);
    if (!range) return;
    const to = Math.min(view.state.doc.length, range.to + 1);
    view.dispatch({ changes: { from: range.from, to }, selection: { anchor: range.from }, userEvent: 'delete' });
    view.focus();
  },
};

/** Leave the table with the caret in the text just before or after it. */
function leave(dom, where) {
  const view = dom._view, range = tableRange(view, dom);
  if (!range) return;
  const { doc } = view.state;
  if (where === 'before') {
    if (range.from === 0) view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 } });
    else view.dispatch({ selection: { anchor: range.from - 1 } });
  } else if (range.to >= doc.length) view.dispatch({ changes: { from: doc.length, insert: '\n' }, selection: { anchor: doc.length + 1 } });
  else view.dispatch({ selection: { anchor: range.to + 1 } });
  view.focus();
}

function wrapSelection(cell, open, close) {
  const s = getSelection();
  if (!s.rangeCount || !cell.contains(s.anchorNode)) return false;
  const r = s.getRangeAt(0);
  const pre = document.createRange(); pre.selectNodeContents(cell); pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length, text = cell.textContent, end = start + r.toString().length;
  const sel = text.slice(start, end);
  const unwrap = text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close;
  const next = unwrap ? text.slice(0, start - open.length) + sel + text.slice(end + close.length) : text.slice(0, start) + open + sel + close + text.slice(end);
  cell.textContent = next;
  const caret = unwrap ? start - open.length + sel.length : start + open.length + sel.length;
  const node = cell.firstChild || cell;
  const nr = document.createRange(); nr.setStart(node, Math.min(caret, node.length || 0)); nr.collapse(true);
  s.removeAllRanges(); s.addRange(nr);
  cell.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function showGrips(dom, cell) {
  const rowGrip = dom.querySelector('.mf-grip-row'), colGrip = dom.querySelector('.mf-grip-col');
  const r = +cell.dataset.r, c = +cell.dataset.c;
  const base = dom.getBoundingClientRect(), tr = cell.parentElement.getBoundingClientRect(), cr = cell.getBoundingClientRect();
  if (r > 0) { rowGrip.style.display = 'block'; rowGrip.dataset.r = r; rowGrip.style.top = tr.top - base.top + tr.height / 2 - 10 + 'px'; }
  else rowGrip.style.display = 'none';
  colGrip.style.display = 'block';
  colGrip.dataset.c = c;
  colGrip.style.left = cr.left - base.left + cr.width / 2 - 12 + 'px';
}

function dragGrip(dom, e, axis) {
  e.preventDefault(); e.stopPropagation();
  const grip = e.currentTarget, from = +(axis === 'row' ? grip.dataset.r : grip.dataset.c);
  const ind = dom.querySelector('.mf-drop');
  const base = dom.getBoundingClientRect();
  const slots = axis === 'row'
    ? [...dom.querySelectorAll('tbody tr')].map((tr, i) => ({ i: i + 1, rect: tr.getBoundingClientRect() }))
    : [...dom.querySelectorAll('thead th')].map((th, i) => ({ i, rect: th.getBoundingClientRect() }));
  let to = from;
  dom.classList.add('mf-dragging');
  const src = axis === 'row' ? dom.querySelectorAll('tbody tr')[from - 1] : null;
  if (src) src.classList.add('mf-lifted');
  const colCells = axis === 'col' ? [...dom.querySelectorAll(`.mf-cell[data-c="${from}"]`)] : [];
  colCells.forEach((c) => c.classList.add('mf-lifted'));
  const move = (ev) => {
    let best = slots[0];
    for (const s of slots) { const mid = axis === 'row' ? s.rect.top + s.rect.height / 2 : s.rect.left + s.rect.width / 2; if ((axis === 'row' ? ev.clientY : ev.clientX) > mid) best = s; }
    const first = slots[0];
    const before = (axis === 'row' ? ev.clientY < first.rect.top + first.rect.height / 2 : ev.clientX < first.rect.left + first.rect.width / 2);
    to = before ? first.i : best.i;
    const s = slots.find((x) => x.i === to);
    ind.style.display = 'block';
    if (axis === 'row') {
      const y = to <= from ? s.rect.top : s.rect.bottom;
      Object.assign(ind.style, { left: s.rect.left - base.left + 'px', width: s.rect.width + 'px', top: y - base.top - 1 + 'px', height: '2px' });
    } else {
      const x = to <= from ? s.rect.left : s.rect.right;
      const tb = dom.querySelector('table').getBoundingClientRect();
      Object.assign(ind.style, { top: tb.top - base.top + 'px', height: tb.height + 'px', left: x - base.left - 1 + 'px', width: '2px' });
    }
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    ind.style.display = 'none';
    dom.classList.remove('mf-dragging');
    if (src) src.classList.remove('mf-lifted');
    colCells.forEach((c) => c.classList.remove('mf-lifted'));
    if (to !== from) (axis === 'row' ? ops.moveRow : ops.moveCol)(dom, from, to);
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

function menuFor(dom, cell, x, y) {
  const t = live.t, r = +cell.dataset.r, c = +cell.dataset.c, m = dom._model;
  showMenu([
    { label: t('在上方插入行', 'Insert Row Above'), run: () => ops.addRow(dom, Math.max(1, r)), disabled: r === 0 },
    { label: t('在下方插入行', 'Insert Row Below'), run: () => ops.addRow(dom, r + 1), hint: isMac ? '⌘↩' : 'Ctrl+↩' },
    { label: t('在左侧插入列', 'Insert Column Left'), run: () => ops.addCol(dom, c) },
    { label: t('在右侧插入列', 'Insert Column Right'), run: () => ops.addCol(dom, c + 1) },
    '-',
    { label: t('左对齐', 'Align Left'), run: () => ops.align(dom, c, 'l'), hint: m.aligns[c] === 'l' ? '✓' : '' },
    { label: t('居中', 'Align Center'), run: () => ops.align(dom, c, 'c'), hint: m.aligns[c] === 'c' ? '✓' : '' },
    { label: t('右对齐', 'Align Right'), run: () => ops.align(dom, c, 'r'), hint: m.aligns[c] === 'r' ? '✓' : '' },
    '-',
    { label: t('删除行', 'Delete Row'), run: () => ops.delRow(dom, r), disabled: r === 0 || m.rows.length < 2 },
    { label: t('删除列', 'Delete Column'), run: () => ops.delCol(dom, c) },
    { label: t('拷贝为 Markdown', 'Copy as Markdown'), run: () => live.copy(serializeTable(m)) },
    { label: t('删除表格', 'Delete Table'), run: () => ops.delTable(dom), danger: true },
  ], x, y);
}

function setup(dom, view) {
  dom._view = view;
  dom.className = 'cm-table-widget';
  const table = document.createElement('table');
  table.className = 'mf-table';
  const rowGrip = document.createElement('div'); rowGrip.className = 'mf-grip mf-grip-row'; rowGrip.textContent = '⋮⋮';
  const colGrip = document.createElement('div'); colGrip.className = 'mf-grip mf-grip-col'; colGrip.textContent = '⋯';
  const drop = document.createElement('div'); drop.className = 'mf-drop';
  const addRow = document.createElement('button'); addRow.className = 'mf-add mf-add-row'; addRow.textContent = '+';
  const addCol = document.createElement('button'); addCol.className = 'mf-add mf-add-col'; addCol.textContent = '+';
  addRow.dataset.tip = live.t('添加一行', 'Add row');
  addCol.dataset.tip = live.t('添加一列', 'Add column');
  dom.append(table, rowGrip, colGrip, drop, addRow, addCol);
  // the add buttons hug the table, however wide the editor is (CSS reads --tw)
  new ResizeObserver(() => dom.style.setProperty('--tw', table.offsetWidth + 'px')).observe(table);

  addRow.addEventListener('mousedown', (e) => { e.preventDefault(); ops.addRow(dom, dom._model.rows.length); });
  addCol.addEventListener('mousedown', (e) => { e.preventDefault(); ops.addCol(dom, dom._model.rows[0].length); });
  rowGrip.addEventListener('pointerdown', (e) => dragGrip(dom, e, 'row'));
  colGrip.addEventListener('pointerdown', (e) => dragGrip(dom, e, 'col'));
  dom.addEventListener('mouseover', (e) => { const cell = e.target.closest('.mf-cell'); if (cell && !dom.classList.contains('mf-dragging')) showGrips(dom, cell); });

  // a click beside the table (not on a cell) goes to the nearest cell of that row,
  // rather than dropping the editor's caret into the table source
  dom.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.mf-cell, .mf-grip, .mf-add')) return;
    e.preventDefault();
    const rows = [...dom.querySelectorAll('tr')];
    let r = rows.findIndex((tr) => e.clientY <= tr.getBoundingClientRect().bottom);
    if (r < 0) r = rows.length - 1;
    const cells = [...rows[r].children];
    let c = cells.findIndex((td) => e.clientX <= td.getBoundingClientRect().right);
    focusCell(dom, r, c < 0 ? cells.length - 1 : c);
  });
  dom.addEventListener('focusin', (e) => {
    const cell = e.target.closest('.mf-cell');
    if (!cell) return;
    cell.textContent = dom._model.rows[+cell.dataset.r][+cell.dataset.c];
    caretToEnd(cell);
    dom.classList.add('mf-editing');
    // keep the editor's own caret out of the table so it stays drawn as a table
    const range = tableRange(view, dom), sel = view.state.selection.main;
    if (range && sel.from <= range.to && sel.to >= range.from) view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, range.to + 1) } });
  });
  dom.addEventListener('focusout', (e) => {
    const cell = e.target.closest('.mf-cell');
    if (!cell || !cell.isConnected) return;
    cell.innerHTML = renderInline(dom._model.rows[+cell.dataset.r][+cell.dataset.c], { base: live.base }) || '';
    if (!dom.contains(e.relatedTarget)) dom.classList.remove('mf-editing');
  });
  const onInput = (e) => {
    const cell = e.target.closest('.mf-cell');
    if (!cell || e.isComposing) return;
    dom._model.rows[+cell.dataset.r][+cell.dataset.c] = cell.textContent.replace(/\n/g, ' ');
    commit(dom);
  };
  dom.addEventListener('input', onInput);
  dom.addEventListener('compositionend', onInput);
  dom.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('.mf-cell');
    if (!cell) return;
    e.preventDefault();
    menuFor(dom, cell, e.clientX, e.clientY);
  });
  dom.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.mf-cell');
    if (!cell || e.isComposing) return;
    const r = +cell.dataset.r, c = +cell.dataset.c, m = dom._model, R = m.rows.length, C = m.rows[0].length;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Tab') {
      stop();
      if (!e.shiftKey) { if (c < C - 1) focusCell(dom, r, c + 1); else if (r < R - 1) focusCell(dom, r + 1, 0); else ops.addRow(dom, R); }
      else if (c > 0) focusCell(dom, r, c - 1); else if (r > 0) focusCell(dom, r - 1, C - 1);
    } else if (e.key === 'Enter') {
      stop();
      if (mod) { ops.addRow(dom, r + 1); focusCell(dom, r + 1, c); }
      else if (e.shiftKey) document.execCommand('insertText', false, '<br>');
      else if (r < R - 1) focusCell(dom, r + 1, c);
      else { ops.addRow(dom, R); focusCell(dom, R, c); }
    } else if (e.key === 'ArrowUp' && !e.shiftKey) { stop(); if (r > 0) focusCell(dom, r - 1, c); else leave(dom, 'before'); }
    else if (e.key === 'ArrowDown' && !e.shiftKey) { stop(); if (r < R - 1) focusCell(dom, r + 1, c); else leave(dom, 'after'); }
    else if (e.key === 'Escape') { stop(); leave(dom, 'after'); }
    else if (mod && !e.altKey) {
      const k = e.code;
      const wraps = { KeyB: ['**', '**'], KeyI: ['*', '*'], KeyU: ['<u>', '</u>'] };
      if (wraps[k] && !e.shiftKey) { stop(); wrapSelection(cell, ...wraps[k]); }
      else if (k === 'KeyH' && e.shiftKey) { stop(); wrapSelection(cell, '==', '=='); }
      else if (k === 'KeyK' && !e.shiftKey) { stop(); wrapSelection(cell, '[', ']()'); }
    } else if (e.ctrlKey && e.code === 'Backquote') { stop(); wrapSelection(cell, e.shiftKey ? '~~' : '`', e.shiftKey ? '~~' : '`'); }
  });
}

export class TableWidget extends WidgetType {
  constructor(source) { super(); this.source = source; }
  eq(o) { return o.source === this.source; }
  get estimatedHeight() { return this.source.split('\n').length * 38 + 16; }
  toDOM(view) {
    const dom = document.createElement('div');
    setup(dom, view);
    dom._model = parseTable(this.source);
    dom._source = this.source;
    render(dom);
    return dom;
  }
  updateDOM(dom) {
    if (dom._source === this.source) return true; // our own edit: the cells already show it
    const active = document.activeElement && dom.contains(document.activeElement) && document.activeElement.closest('.mf-cell');
    const at = active ? [+active.dataset.r, +active.dataset.c] : null;
    dom._model = parseTable(this.source);
    dom._source = this.source;
    render(dom);
    if (at) focusCell(dom, ...at);
    return true;
  }
  ignoreEvent() { return true; }
}

/** From the line above / below a table, the arrow keys step into its cells. */
function enterTable(view, dir) {
  if (!view.dom.classList.contains('cm-live')) return false;
  const { state } = view, sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  // only when the caret is about to leave its line (a wrapped paragraph moves within itself first)
  if (state.doc.lineAt(view.moveVertically(sel, dir > 0).head).number === line.number) return false;
  const n = line.number + dir;
  if (n < 1 || n > state.doc.lines) return false;
  const target = state.doc.line(n);
  const el = [...view.contentDOM.querySelectorAll('.cm-table-widget')].find((d) => {
    const r = tableRange(view, d);
    return r && (dir > 0 ? r.from === target.from : r.to === target.to);
  });
  if (!el) return false;
  focusCell(el, dir > 0 ? 0 : el._model.rows.length - 1, 0);
  return true;
}
export const tableNavKeymap = [
  { key: 'ArrowDown', run: (v) => enterTable(v, 1) },
  { key: 'ArrowUp', run: (v) => enterTable(v, -1) },
];
