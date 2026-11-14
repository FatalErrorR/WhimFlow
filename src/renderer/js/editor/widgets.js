// Small DOM pieces the live preview draws in place of Markdown syntax.
import { WidgetType } from '@codemirror/view';
import { renderMath, renderMarkdown, cachedMermaid, renderMermaidSource, resolveSrc } from '../render.js';
import { fenceAt, fenceInfo, setFenceMeta } from './structure.js';
import { imageAt, imageMarkup } from './images.js';

export const live = {
  base: '',                      // file:// URL of the document's folder, for relative images
  t: (zh, en) => en,
  copy: (text) => navigator.clipboard.writeText(text),
  reveal: () => {},
  compare: () => {},             // start comparing the code block at this position
  pick: -1,                      // position of the block chosen for comparison, if any
  jumpToHeading: () => {},
  focusMode: false,
  island: false,
  epoch: 0,                      // bumped on theme change so diagrams re-render
};

export class BulletWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(o) { return o.depth === this.depth; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = ['•', '◦', '▪'][this.depth % 3];
    return s;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'cm-task' + (this.checked ? ' done' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      if (!/^\[[ xX]\]$/.test(view.state.sliceDoc(pos, pos + 3))) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.toggle' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

export class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-hr'; s.textContent = '·  ·  ·'; return s; }
}

export class MathWidget extends WidgetType {
  constructor(tex) { super(); this.tex = tex; }
  eq(o) { return o.tex === this.tex; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-math'; s.innerHTML = renderMath(this.tex, false); return s; }
}

export class ImageWidget extends WidgetType {
  constructor(src, alt, base, preview, width = '', align = '') { super(); Object.assign(this, { src, alt, base, preview, width, align }); }
  eq(o) { return ['src', 'alt', 'base', 'preview', 'width', 'align'].every((k) => o[k] === this[k]); }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-image' + (this.preview ? ' preview' : '') + (this.align ? ' aligned' : '');
    if (this.align) wrap.style.textAlign = this.align;
    const frame = document.createElement('span');
    frame.className = 'cm-image-frame';
    if (this.width) frame.style.width = this.width;
    const img = document.createElement('img');
    img.alt = this.alt;
    img.onload = () => view.requestMeasure();
    img.onerror = () => { wrap.classList.add('broken'); wrap.dataset.alt = this.alt || this.src; view.requestMeasure(); };
    img.src = resolveSrc(this.src, this.base);
    frame.append(img);
    wrap.append(frame);
    if (!this.preview) imageTools(view, wrap, frame, this);
    return wrap;
  }
  ignoreEvent(e) { return !!(e.target && e.target.closest && e.target.closest('.cm-img-bar, .cm-img-handle')); }
  get estimatedHeight() { return 200; }
}

/** Hover toolbar (size, alignment, reveal) and a corner handle to drag the width. */
function imageTools(view, wrap, frame, w) {
  const t = live.t;
  const apply = (patch) => {
    const img = imageAt(view.state, view.posAtDOM(wrap));
    if (!img) return;
    view.dispatch({ changes: { from: img.from, to: img.to, insert: imageMarkup({ ...img, ...patch }) }, userEvent: 'input.image' });
  };
  const bar = document.createElement('span');
  bar.className = 'cm-img-bar';
  const btn = (label, tip, on, run) => {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.tip = tip;
    if (on) b.className = 'on';
    b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); run(); });
    bar.append(b);
  };
  const cur = w.width || '100%';
  for (const p of ['25%', '50%', '75%', '100%']) btn(p, t('宽度 ', 'Width ') + p, cur === p, () => apply({ width: p === '100%' ? '' : p }));
  const sep = () => { const s = document.createElement('i'); bar.append(s); };
  sep();
  btn('⇤', t('靠左', 'Left'), w.align === 'left', () => apply({ align: w.align === 'left' ? '' : 'left' }));
  btn('↔', t('居中', 'Center'), w.align === 'center', () => apply({ align: w.align === 'center' ? '' : 'center' }));
  btn('⇥', t('靠右', 'Right'), w.align === 'right', () => apply({ align: w.align === 'right' ? '' : 'right' }));
  if (/^(file:|\.|\/|[^:]+$)/.test(w.src)) { sep(); btn('↗', t('在文件夹中显示', 'Show in folder'), false, () => live.reveal(resolveSrc(w.src, w.base))); }
  const handle = document.createElement('span');
  handle.className = 'cm-img-handle';
  handle.dataset.tip = t('拖动调整大小', 'Drag to resize');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const full = view.contentDOM.querySelector('.cm-line') ? view.contentDOM.querySelector('.cm-line').clientWidth : view.contentDOM.clientWidth;
    const start = frame.getBoundingClientRect().width, x0 = e.clientX;
    let pct = Math.round(start / full * 100);
    wrap.classList.add('resizing');
    const move = (ev) => {
      pct = Math.max(10, Math.min(100, Math.round((start + ev.clientX - x0) / full * 100)));
      frame.style.width = pct + '%';
      handle.dataset.pct = pct + '%';
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      wrap.classList.remove('resizing');
      apply({ width: pct >= 100 ? '' : pct + '%' });
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  frame.append(handle);
  wrap.append(bar);
}

export class FootnoteRefWidget extends WidgetType {
  constructor(label, num, text) { super(); Object.assign(this, { label, num, text }); }
  eq(o) { return o.label === this.label && o.num === this.num && o.text === this.text; }
  toDOM(view) {
    const s = document.createElement('sup');
    s.className = 'cm-fn-ref' + (this.text == null ? ' missing' : '');
    s.textContent = this.num || '?';
    s.dataset.tip = this.text == null ? live.t('还没有写这个脚注', 'This footnote has no text yet') : this.text;
    s.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const re = new RegExp('^\\[\\^' + this.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]:', 'm');
      const m = re.exec(view.state.doc.toString());
      if (m) { view.dispatch({ selection: { anchor: m.index + m[0].length + 1 }, scrollIntoView: true }); view.focus(); }
    });
    return s;
  }
  ignoreEvent() { return true; }
}

export class FootnoteBadgeWidget extends WidgetType {
  constructor(label, num) { super(); this.label = label; this.num = num; }
  eq(o) { return o.label === this.label && o.num === this.num; }
  toDOM(view) {
    const s = document.createElement('span');
    s.className = 'cm-fn-badge';
    s.textContent = this.num || '?';
    s.dataset.tip = live.t('回到正文中的引用', 'Back to the reference');
    s.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const i = view.state.doc.toString().search(new RegExp('\\[\\^' + this.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\](?!:)'));
      if (i >= 0) { view.dispatch({ selection: { anchor: i + this.label.length + 3 }, scrollIntoView: true }); view.focus(); }
    });
    return s;
  }
  ignoreEvent() { return true; }
}

export class FrontMatterWidget extends WidgetType {
  constructor(meta) { super(); this.meta = meta; }
  eq(o) { return JSON.stringify(o.meta) === JSON.stringify(this.meta); }
  toDOM(view) {
    const d = document.createElement('div');
    d.className = 'cm-frontmatter';
    const head = document.createElement('div');
    head.className = 'cm-fm-head';
    head.textContent = live.t('文档属性', 'Properties');
    d.append(head);
    const grid = document.createElement('div');
    grid.className = 'cm-fm-grid';
    const entries = Object.entries(this.meta || {});
    if (!entries.length) { const e = document.createElement('span'); e.className = 'cm-fm-empty'; e.textContent = live.t('（空）', '(empty)'); grid.append(e); }
    for (const [k, v] of entries) {
      const a = document.createElement('span'); a.className = 'cm-fm-k'; a.textContent = k;
      const b = document.createElement('span'); b.className = 'cm-fm-val'; b.textContent = v;
      grid.append(a, b);
    }
    d.append(grid);
    d.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); view.dispatch({ selection: { anchor: 4 } }); view.focus(); });
    return d;
  }
  ignoreEvent() { return true; }
}

const icon = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CODE_ICONS = {
  copy: icon('<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>'),
  done: icon('<path d="m3.5 8.5 3 3 6-7"/>'),
  fold: icon('<path d="m4.5 6.5 3.5-3 3.5 3M4.5 9.5l3.5 3 3.5-3"/>'),
  unfold: icon('<path d="m4.5 3.5 3.5 3 3.5-3M4.5 12.5l3.5-3 3.5 3"/>'),
  compare: icon('<rect x="2" y="3" width="4.6" height="10" rx="1.2"/><rect x="9.4" y="3" width="4.6" height="10" rx="1.2"/><path d="M7.2 8h1.6"/>'),
  file: icon('<path d="M4 2.2h5l3 3v8.6H4z"/><path d="M9 2.2v3h3"/>'),
};

/** The strip at the top of a code block: file name, language, and the block's tools. */
export class CodeHeaderWidget extends WidgetType {
  constructor(head, active) { super(); this.head = head; this.active = active; }
  eq(o) {
    const a = this.head, b = o.head;
    return o.active === this.active && a.lang === b.lang && a.title === b.title && a.lines === b.lines && a.foldable === b.foldable && a.fold === b.fold;
  }
  toDOM(view) {
    const { head, active } = this;
    const wrap = document.createElement('span');
    wrap.className = 'cm-cb-head';
    const blockNode = () => fenceAt(view.state, view.posAtDOM(wrap));
    if (head.title && !active) {
      const title = document.createElement('span');
      title.className = 'cm-cb-title';
      title.innerHTML = CODE_ICONS.file;
      title.append(head.title);
      wrap.append(title);
    }
    const tools = document.createElement('span');
    tools.className = 'cm-cb-header';
    const acts = document.createElement('span');
    acts.className = 'cm-cb-actions';
    const button = (name, tip, run) => {
      const b = document.createElement('button');
      b.className = 'cm-cb-btn cm-cb-' + name;
      b.innerHTML = CODE_ICONS[name];
      b.dataset.tip = tip;
      b.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const node = blockNode();
        if (node) run(node, b);
      });
      acts.append(b);
      return b;
    };
    button('compare', live.t('与另一个代码块对比', 'Compare with another block'), (node) => live.compare(node.from));
    if (head.foldable && !active) {
      button(head.fold ? 'unfold' : 'fold', head.fold ? live.t('展开', 'Expand') : live.t(`折叠（共 ${head.lines} 行）`, `Fold (${head.lines} lines)`),
        (node) => setFenceMeta(view, node, { fold: !head.fold }));
    }
    button('copy', live.t('拷贝代码', 'Copy code'), (node, b) => {
      live.copy(fenceInfo(view.state, node).code);
      b.innerHTML = CODE_ICONS.done; b.classList.add('done');
      setTimeout(() => { b.innerHTML = CODE_ICONS.copy; b.classList.remove('done'); }, 1200);
    });
    tools.append(acts);
    if (!active && head.lang) {
      const lang = document.createElement('span');
      lang.className = 'cm-cb-lang';
      lang.textContent = head.lang;
      tools.append(lang);
    }
    wrap.append(tools);
    return wrap;
  }
  ignoreEvent(e) { return !!(e.target && e.target.closest && e.target.closest('.cm-cb-actions')); }
}

/** The bar that stands in for the hidden part of a folded code block. */
export class CodeFoldWidget extends WidgetType {
  constructor(hidden) { super(); this.hidden = hidden; }
  eq(o) { return o.hidden === this.hidden; }
  get estimatedHeight() { return 26; }
  toDOM(view) {
    const d = document.createElement('div');
    d.className = 'cm-cb cm-cb-folded';
    const b = document.createElement('button');
    b.className = 'cm-cb-more';
    b.innerHTML = CODE_ICONS.unfold;
    b.append(live.t(`展开其余 ${this.hidden} 行`, `Show ${this.hidden} more lines`));
    d.append(b);
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const node = fenceAt(view.state, view.posAtDOM(d));
      if (node) setFenceMeta(view, node, { fold: false });
    });
    return d;
  }
  ignoreEvent() { return true; }
}

function tocHtml(items) {
  if (!items.length) return `<p class="cm-toc-empty">${live.t('目录会列出文档里的标题', 'The table of contents lists your headings')}</p>`;
  const min = Math.min(...items.map((h) => h.level));
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return '<nav class="toc">' + items.map((h, i) => `<a data-h="${i}" style="padding-left:${(h.level - min) * 1.1}em">${esc(h.text)}</a>`).join('') + '</nav>';
}

/** Where in the table source a click on a rendered cell should put the caret. */
function tableCellPos(state, from, target) {
  const cell = target.closest && target.closest('td, th');
  if (!cell) return from;
  const row = cell.parentElement;
  const rowIdx = row.parentElement.tagName === 'THEAD' ? 0 : [...row.parentElement.children].indexOf(row) + 2;
  const col = [...row.children].indexOf(cell);
  const first = state.doc.lineAt(from);
  if (first.number + rowIdx > state.doc.lines) return from;
  const line = state.doc.line(first.number + rowIdx);
  const pipes = [];
  for (let k = 0; k < line.text.length; k++) { if (line.text[k] === '\\') { k++; continue; } if (line.text[k] === '|') pipes.push(k); }
  const lead = /^\s*\|/.test(line.text);
  let start = lead ? pipes[col] + 1 : col === 0 ? 0 : pipes[col - 1] + 1;
  if (!Number.isFinite(start)) return line.from;
  while (line.text[start] === ' ') start++;
  let end = line.text.indexOf('|', start);
  if (end < 0) end = line.text.length;
  while (end > start && line.text[end - 1] === ' ') end--;
  return line.from + end;
}

/** A whole block drawn as rendered output: table, formula, diagram, table of contents. */
export class BlockWidget extends WidgetType {
  constructor(kind, source, base, below = false) { super(); this.kind = kind; this.source = source; this.base = base; this.below = below; this.epoch = live.epoch; }
  eq(o) { return o.kind === this.kind && o.source === this.source && o.base === this.base && o.below === this.below && o.epoch === this.epoch; }
  get estimatedHeight() { return this.kind === 'table' ? this.source.split('\n').length * 34 : this.kind === 'mermaid' ? 240 : 60; }
  toDOM(view) {
    const d = document.createElement('div');
    d.className = `cm-block cm-block-${this.kind} doc` + (this.below ? ' below' : '');
    if (this.kind === 'table') d.innerHTML = renderMarkdown(this.source, { base: this.base });
    else if (this.kind === 'math') d.innerHTML = renderMath(this.source, true);
    else if (this.kind === 'toc') d.innerHTML = tocHtml(JSON.parse(this.source));
    else if (this.kind === 'mermaid') {
      const cached = cachedMermaid(this.source);
      if (cached) d.innerHTML = cached;
      else {
        d.classList.add('loading');
        renderMermaidSource(this.source).then((svg) => { d.innerHTML = svg; d.classList.remove('loading'); view.requestMeasure(); });
      }
    }
    if (!this.below) {
      d.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const link = e.target.closest && e.target.closest('a[data-h]');
        if (link) { live.jumpToHeading(+link.dataset.h); return; }
        const from = view.posAtDOM(d);
        const anchor = this.kind === 'table' ? tableCellPos(view.state, from, e.target) : from;
        view.dispatch({ selection: { anchor }, scrollIntoView: false });
        view.focus();
      });
    }
    return d;
  }
  ignoreEvent() { return !this.below; }
}
