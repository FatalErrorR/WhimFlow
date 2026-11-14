// Live preview: Markdown renders as you type, and the syntax of whatever the caret
// is in comes back so it can be edited. Two layers:
//  - an inline view plugin (only the visible part): hides marks, styles text,
//    swaps in bullets, checkboxes, images, inline formulas, code-block headers;
//  - a block state field: whole blocks drawn as rendered output (tables, $$
//    formulas, mermaid diagrams, [toc]) while the caret is elsewhere.
import { ViewPlugin, Decoration, EditorView } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { live, BulletWidget, CheckboxWidget, HrWidget, MathWidget, ImageWidget, CodeHeaderWidget, CodeFoldWidget, BlockWidget, FootnoteRefWidget, FootnoteBadgeWidget, FrontMatterWidget } from './widgets.js';
import { CONTAINERS, fenceInfo, headingsOf, topBlockAt, footnotesOf } from './structure.js';
import { TableWidget } from './tablewidget.js';
import { parseImgTag } from './images.js';
import { frontMatter } from '../render.js';
import { FOLD_KEEP, canFold, inRanges, diffKind, isDiffLang } from '../codemeta.js';

export const refreshLive = StateEffect.define();

const hidden = Decoration.replace({});
const touches = (sel, from, to) => sel.ranges.some((r) => r.from <= to && r.to >= from);
const lineSpan = (doc, from, to) => [doc.lineAt(from).from, doc.lineAt(to).to];
const HTML_PAIRS = new Set(['u', 'kbd', 'mark', 'sub', 'sup', 's', 'del', 'ins', 'b', 'strong', 'i', 'em']);
const INLINE_MARKS = { Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', Highlight: 'HighlightMark', Superscript: 'SuperscriptMark', Subscript: 'SubscriptMark' };

function listDepth(node) {
  let d = -1;
  for (let p = node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') d++;
  return Math.max(0, d);
}

function imageDeco(out, sel, from, to, img, mark) {
  if (!img || !img.src) return;
  if (touches(sel, from, to)) {
    mark(from, to, 'cm-image-src');
    out.push(Decoration.widget({ widget: new ImageWidget(img.src, img.alt, live.base, true, img.width, img.align), side: 1 }).range(to));
  } else out.push(Decoration.replace({ widget: new ImageWidget(img.src, img.alt, live.base, false, img.width, img.align) }).range(from, to));
}

// Text widths in the editor's own font, for hanging indents (cached per font).
const measureCtx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();
function textWidth(font, s) {
  const key = font + '\n' + s;
  if (!widthCache.has(key)) { if (widthCache.size > 2000) widthCache.clear(); measureCtx.font = font; widthCache.set(key, measureCtx.measureText(s).width); }
  return widthCache.get(key);
}

function buildInline(view) {
  const { state } = view, { doc } = state, sel = state.selection, out = [];
  const { from: vFrom, to: vTo } = view.viewport;
  const lineDeco = (pos, cls) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const hide = (a, b) => { if (b > a) out.push(hidden.range(a, b)); };
  const mark = (a, b, cls) => { if (b > a) out.push(Decoration.mark({ class: cls }).range(a, b)); };
  const lineActive = (pos) => { const l = doc.lineAt(pos); return touches(sel, l.from, l.to); };
  const tags = [];
  let fontInfo = null;
  const font = () => {
    if (!fontInfo) { const cs = getComputedStyle(view.contentDOM); fontInfo = { css: `${cs.fontSize} ${cs.fontFamily}`, em: parseFloat(cs.fontSize) || 16 }; }
    return fontInfo;
  };

  syntaxTree(state).iterate({
    from: vFrom, to: vTo,
    enter(ref) {
      const name = ref.name, node = ref.node;
      const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        lineDeco(ref.from, `cm-h cm-h${heading[2]}`);
        if (heading[1] === 'Setext') {
          const last = doc.lineAt(ref.to);
          lineDeco(last.from, 'cm-setext-mark');
        }
        return true;
      }
      switch (name) {
        case 'HeaderMark': {
          if (lineActive(ref.from)) { mark(ref.from, ref.to, 'cm-mark'); return false; }
          const line = doc.lineAt(ref.from);
          if (node.parent && /^Setext/.test(node.parent.name)) return false;
          if (ref.from === line.from + (line.text.length - line.text.trimStart().length)) {
            let e = ref.to; while (doc.sliceString(e, e + 1) === ' ') e++; hide(ref.from, e);
          } else {
            let s = ref.from; while (s > line.from && doc.sliceString(s - 1, s) === ' ') s--; hide(s, ref.to);
          }
          return false;
        }
        case 'Blockquote': {
          const a = Math.max(ref.from, vFrom), b = Math.min(ref.to, vTo);
          for (let p = a; p <= b;) { const l = doc.lineAt(p); lineDeco(l.from, 'cm-quote'); p = l.to + 1; }
          return true;
        }
        case 'QuoteMark': {
          if (!lineActive(ref.from)) { let e = ref.to; if (doc.sliceString(e, e + 1) === ' ') e++; hide(ref.from, e); }
          else mark(ref.from, ref.to, 'cm-mark');
          return false;
        }
        case 'ListMark': {
          const item = node.parent;
          const list = item && item.parent;
          const isTask = item && item.getChild('Task');
          const near = sel.ranges.some((r) => r.from >= ref.from && r.from <= ref.to + 1 && r.empty);
          if (list && list.name === 'BulletList' && !near) {
            let e = ref.to;
            if (isTask) { while (doc.sliceString(e, e + 1) === ' ') e++; hide(ref.from, e); }
            else out.push(Decoration.replace({ widget: new BulletWidget(listDepth(item)) }).range(ref.from, ref.to));
          } else mark(ref.from, ref.to, 'cm-listmark');
          // Hanging indent: wrapped lines of an item line up under its text, not its marker,
          // and each nesting level steps in a little further than the raw spaces would.
          let inQuote = false;
          for (let p = item; p; p = p.parent) if (p.name === 'Blockquote') inQuote = true;
          if (!inQuote) {
            const f = font(), line = doc.lineAt(ref.from), raw = doc.sliceString(ref.from, ref.to);
            let w = textWidth(f.css, doc.sliceString(line.from, ref.from)) + textWidth(f.css, ' ');
            if (list && list.name === 'BulletList' && !near) w += isTask ? 1.07 * f.em : 0.9 * f.em;
            else w += textWidth(f.css, raw);
            if (isTask && (near || !(list && list.name === 'BulletList'))) w += 1.07 * f.em + textWidth(f.css, ' ');
            const step = listDepth(item) * 0.7 * f.em;
            out.push(Decoration.line({ attributes: { style: `padding-left:${(w + step).toFixed(1)}px;text-indent:-${w.toFixed(1)}px` } }).range(line.from));
          }
          return false;
        }
        case 'TaskMarker': {
          const checked = /x/i.test(doc.sliceString(ref.from, ref.to));
          const inside = sel.ranges.some((r) => r.from > ref.from && r.from < ref.to);
          if (!inside) out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(ref.from, ref.to));
          if (checked) lineDeco(ref.from, 'cm-task-done');
          return false;
        }
        case 'HorizontalRule': {
          lineDeco(ref.from, 'cm-hr-line');
          if (!lineActive(ref.from)) out.push(Decoration.replace({ widget: new HrWidget() }).range(ref.from, ref.to));
          return false;
        }
        case 'FencedCode': {
          const first = doc.lineAt(ref.from), last = doc.lineAt(ref.to);
          const active = touches(sel, first.from, last.to);
          const info = fenceInfo(state, node);
          if (info.lang === 'mermaid' && !active) return false; // drawn by the block field
          const a = Math.max(first.number, doc.lineAt(vFrom).number), b = Math.min(last.number, doc.lineAt(vTo).number);
          const bodyLast = info.bodyLast, bodyCount = Math.max(0, bodyLast - first.number);
          const foldable = info.closed && canFold(bodyCount);
          const diff = isDiffLang(info.lang);
          const picked = live.pick >= ref.from && live.pick <= ref.to;
          for (let n = a; n <= b; n++) {
            let cls = 'cm-cb';
            if (n === first.number) cls += ' cm-cb-open' + (info.meta.title && !active ? ' cm-cb-titled' : '');
            else if (n === last.number && info.closed) cls += ' cm-cb-close';
            if (n === first.number + 1) cls += ' cm-cb-first';
            if (n === bodyLast && n > first.number) cls += ' cm-cb-last';
            if (active) cls += ' cm-cb-active';
            if (picked) cls += ' cm-cb-picked';
            const k = n - first.number; // 1-based line within the code
            if (k >= 1 && n <= bodyLast) {
              if (inRanges(info.meta.hl, k)) cls += ' cm-cb-hl';
              if (diff) { const kind = diffKind(doc.line(n).text); if (kind) cls += ' cm-cb-' + kind; }
            }
            out.push(Decoration.line({ class: cls }).range(doc.line(n).from));
          }
          const head = { lang: info.lang, title: info.meta.title, lines: bodyCount, foldable, fold: info.meta.fold };
          if (!active) {
            if (first.to > first.from && first.number >= a) out.push(Decoration.replace({ widget: new CodeHeaderWidget(head, false) }).range(first.from, first.to));
            if (info.closed && last.to > last.from && last.number <= b) hide(last.from, last.to);
          } else if (first.number >= a) out.push(Decoration.widget({ widget: new CodeHeaderWidget(head, true), side: 1 }).range(first.to));
          return false;
        }
        case 'CodeBlock': {
          for (let p = Math.max(ref.from, vFrom); p <= Math.min(ref.to, vTo);) { const l = doc.lineAt(p); lineDeco(l.from, 'cm-cb cm-cb-indented'); p = l.to + 1; }
          return false;
        }
        case 'Table': case 'MathBlock': {
          const [a, b] = lineSpan(doc, ref.from, ref.to);
          if (touches(sel, a, b)) for (let p = Math.max(a, vFrom); p <= Math.min(b, vTo);) { const l = doc.lineAt(p); lineDeco(l.from, name === 'Table' ? 'cm-table-src' : 'cm-math-src'); p = l.to + 1; }
          return false;
        }
        case 'HTMLBlock': {
          const text = doc.sliceString(ref.from, ref.to), m = /^(\s*)(<img\b[^>]*>)\s*$/i.exec(text);
          if (m) { const a = ref.from + m[1].length; imageDeco(out, sel, a, a + m[2].length, parseImgTag(m[2]), mark); return false; }
          for (let p = Math.max(ref.from, vFrom); p <= Math.min(ref.to, vTo);) { const l = doc.lineAt(p); lineDeco(l.from, 'cm-raw'); p = l.to + 1; }
          return false;
        }
        case 'FrontMatter': {
          const [a, b] = lineSpan(doc, ref.from, ref.to);
          if (!touches(sel, a, b)) return false; // drawn as a card by the block field
          for (let p = a; p <= Math.min(b, vTo);) {
            const l = doc.lineAt(p);
            lineDeco(l.from, 'cm-fm-src');
            const k = /^([\w-][\w .-]*?):/.exec(l.text);
            if (k && l.number > 1) mark(l.from, l.from + k[1].length, 'cm-fm-key');
            p = l.to + 1;
          }
          return false;
        }
        case 'FootnoteRef': {
          const label = doc.sliceString(ref.from + 2, ref.to - 1), fn = footnotesOf(state);
          if (touches(sel, ref.from, ref.to)) mark(ref.from, ref.to, 'cm-fn-src');
          else out.push(Decoration.replace({ widget: new FootnoteRefWidget(label, fn.nums.get(label), fn.defs.has(label) ? fn.defs.get(label) : null) }).range(ref.from, ref.to));
          return false;
        }
        case 'FootnoteDefinition': {
          for (let p = Math.max(ref.from, vFrom); p <= Math.min(ref.to, vTo);) { const l = doc.lineAt(p); lineDeco(l.from, 'cm-fn-def'); p = l.to + 1; }
          return true;
        }
        case 'FootnoteMark': {
          const label = /^\[\^([^\]]+)\]/.exec(doc.sliceString(ref.from, ref.to));
          if (lineActive(ref.from) || !label) mark(ref.from, ref.to, 'cm-mark');
          else out.push(Decoration.replace({ widget: new FootnoteBadgeWidget(label[1], footnotesOf(state).nums.get(label[1])) }).range(ref.from, ref.to));
          return false;
        }
        case 'CommentBlock': case 'LinkReference': {
          for (let p = Math.max(ref.from, vFrom); p <= Math.min(ref.to, vTo);) { const l = doc.lineAt(p); lineDeco(l.from, 'cm-raw'); p = l.to + 1; }
          return false;
        }
        case 'InlineCode': {
          const active = touches(sel, ref.from, ref.to);
          const marks = node.getChildren('CodeMark');
          if (!active && marks.length === 2) { hide(marks[0].from, marks[0].to); hide(marks[1].from, marks[1].to); mark(marks[0].to, marks[1].from, 'cm-inline-code'); }
          else mark(ref.from, ref.to, 'cm-inline-code active');
          return false;
        }
        case 'InlineMath': {
          if (touches(sel, ref.from, ref.to)) mark(ref.from, ref.to, 'cm-math-src');
          else out.push(Decoration.replace({ widget: new MathWidget(doc.sliceString(ref.from + 1, ref.to - 1)) }).range(ref.from, ref.to));
          return false;
        }
        case 'Image': {
          const url = node.getChild('URL');
          const alt = /^!\[([^\]]*)\]/.exec(doc.sliceString(ref.from, ref.to));
          const src = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : '';
          imageDeco(out, sel, ref.from, ref.to, { src, alt: alt ? alt[1] : '', width: '', align: '' }, mark);
          return false;
        }
        case 'Link': {
          const marks = node.getChildren('LinkMark');
          const text = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
          const foot = text.startsWith('^');
          if (touches(sel, ref.from, ref.to) || marks.length < 2) { mark(ref.from, ref.to, foot ? 'cm-footref active' : 'cm-link-src'); return true; }
          hide(marks[0].from, marks[0].to);
          hide(marks[1].from, ref.to);
          mark(marks[0].to, marks[1].from, foot ? 'cm-footref' : 'cm-link');
          if (foot) hide(marks[0].to, marks[0].to + 1);
          return true;
        }
        case 'Autolink': {
          const marks = node.getChildren('LinkMark');
          if (!touches(sel, ref.from, ref.to)) for (const m of marks) hide(m.from, m.to);
          mark(ref.from, ref.to, 'cm-link');
          return false;
        }
        case 'URL': {
          if (node.parent && node.parent.name === 'Paragraph') mark(ref.from, ref.to, 'cm-link');
          return false;
        }
        case 'Escape': {
          if (!touches(sel, ref.from, ref.to)) hide(ref.from, ref.from + 1);
          return false;
        }
        case 'HTMLTag': {
          const tagText = doc.sliceString(ref.from, ref.to);
          if (/^<img\b/i.test(tagText)) { imageDeco(out, sel, ref.from, ref.to, parseImgTag(tagText), mark); return false; }
          const m = /^<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>$/i.exec(tagText);
          if (m && !m[3] && HTML_PAIRS.has(m[2].toLowerCase())) tags.push({ from: ref.from, to: ref.to, name: m[2].toLowerCase(), close: !!m[1], parent: node.parent ? node.parent.from : -1 });
          else mark(ref.from, ref.to, 'cm-mark');
          return false;
        }
        default:
          if (INLINE_MARKS[name]) {
            if (name === 'Highlight') mark(ref.from, ref.to, 'cm-highlight');
            if (!touches(sel, ref.from, ref.to)) for (const m of node.getChildren(INLINE_MARKS[name])) hide(m.from, m.to);
            return true;
          }
          return CONTAINERS.has(name) || name === 'Paragraph' || name === 'Task' || name === 'TableRow' || name === 'TableCell' || name === 'TableHeader';
      }
    },
  });

  // blank lines between blocks become slim gaps; the one with the caret keeps its height
  const tree = syntaxTree(state);
  for (let pos = vFrom; pos <= vTo;) {
    const l = doc.lineAt(pos);
    if (!l.text.trim() && !touches(sel, l.from, l.to) && CONTAINERS.has(tree.resolveInner(l.from, 1).name)) lineDeco(l.from, 'cm-gap');
    pos = l.to + 1;
  }

  // pair inline HTML like <u>…</u> and <kbd>…</kbd>: style the content, hide the tags
  const open = [];
  for (const tg of tags) {
    if (!tg.close) { open.push(tg); continue; }
    for (let i = open.length - 1; i >= 0; i--) {
      const o = open[i];
      if (o.name !== tg.name || o.parent !== tg.parent) continue;
      open.splice(i, 1);
      mark(o.to, tg.from, `cm-html-${tg.name}`);
      if (touches(sel, o.from, tg.to)) { mark(o.from, o.to, 'cm-mark'); mark(tg.from, tg.to, 'cm-mark'); }
      else { hide(o.from, o.to); hide(tg.from, tg.to); }
      break;
    }
  }
  for (const o of open) mark(o.from, o.to, 'cm-mark');
  return Decoration.set(out, true);
}

const inlinePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildInline(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState) ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLive)))) this.decorations = buildInline(u.view);
  }
}, { decorations: (v) => v.decorations });

function buildBlocks(state) {
  const sel = state.selection, out = [];
  let headingsJson = null;
  syntaxTree(state).iterate({
    enter(ref) {
      const name = ref.name;
      if (CONTAINERS.has(name)) return true;
      let kind = null, payload = null;
      if (name === 'Table' || name === 'FrontMatter') {
        const [a, b] = lineSpan(state.doc, ref.from, ref.to);
        if (!touches(sel, a, b)) {
          const widget = name === 'Table' ? new TableWidget(state.sliceDoc(a, b)) : new FrontMatterWidget(frontMatter(state.sliceDoc(0, b) + '\n').meta || {});
          out.push(Decoration.replace({ widget, block: true }).range(a, b));
        }
        return false;
      }
      else if (name === 'MathBlock') {
        kind = 'math';
        payload = state.sliceDoc(ref.from, ref.to).replace(/^\s*\$\$/, '').replace(/\$\$\s*$/, '').trim();
      } else if (name === 'FencedCode') {
        const info = fenceInfo(state, ref.node);
        if (info.lang === 'mermaid' && info.code.trim()) { kind = 'mermaid'; payload = info.code; }
        else if (info.meta.fold && info.closed && canFold(info.bodyLast - info.open)) {
          // a folded block keeps its first lines; the rest hide behind one bar until the caret comes in
          const a = state.doc.line(info.open).from, b = state.doc.lineAt(ref.to).to;
          if (!touches(sel, a, b)) {
            const from = state.doc.line(info.open + FOLD_KEEP + 1).from, to = state.doc.line(info.bodyLast).to;
            out.push(Decoration.replace({ widget: new CodeFoldWidget(info.bodyLast - info.open - FOLD_KEEP), block: true }).range(from, to));
          }
          return false;
        }
      } else if (name === 'Paragraph' && /^\s*\[toc\]\s*$/i.test(state.sliceDoc(ref.from, ref.to))) {
        kind = 'toc';
        payload = headingsJson || (headingsJson = JSON.stringify(headingsOf(state).map((h) => ({ level: h.level, text: h.text }))));
      }
      if (kind) {
        const [a, b] = lineSpan(state.doc, ref.from, ref.to);
        if (!touches(sel, a, b)) out.push(Decoration.replace({ widget: new BlockWidget(kind, payload, live.base), block: true }).range(a, b));
        else if (kind === 'math' || kind === 'mermaid') out.push(Decoration.widget({ widget: new BlockWidget(kind, payload, live.base, true), block: true, side: 1 }).range(b));
      }
      return false;
    },
  });
  return Decoration.set(out, true);
}

const blockField = StateField.define({
  create: buildBlocks,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.effects.some((e) => e.is(refreshLive))) return buildBlocks(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Focus mode: everything but the block under the caret fades. */
const focusPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLive)))) this.decorations = this.build(u.view); }
  build(view) {
    if (!live.focusMode) return Decoration.none;
    const { state } = view, out = [];
    const blk = topBlockAt(state, state.selection.main.head);
    const cur = blk ? [state.doc.lineAt(blk.from).number, state.doc.lineAt(blk.to).number] : [state.doc.lineAt(state.selection.main.head).number, -1];
    for (let n = state.doc.lineAt(view.viewport.from).number; n <= state.doc.lineAt(view.viewport.to).number; n++) {
      if (n >= cur[0] && n <= Math.max(cur[0], cur[1])) continue;
      out.push(Decoration.line({ class: 'cm-dim' }).range(state.doc.line(n).from));
    }
    return Decoration.set(out);
  }
}, { decorations: (v) => v.decorations });

// A code block's tools (copy, fold, compare) show while the pointer is anywhere over the block.
let shown = null;
function showTools(target) {
  let line = target && target.closest ? target.closest('.cm-cb, .cm-cb-folded') : null;
  while (line && !line.classList.contains('cm-cb-open')) { line = line.previousElementSibling; if (line && !line.classList.contains('cm-cb') && !line.classList.contains('cm-cb-folded')) line = null; }
  const tools = line ? line.querySelector('.cm-cb-header') : null;
  if (tools === shown) return;
  if (shown) shown.classList.remove('show');
  shown = tools;
  if (shown) shown.classList.add('show');
}
const codeHover = EditorView.domEventHandlers({
  mousemove(e) { showTools(e.target); return false; },
  mouseleave() { showTools(null); return false; },
});

export const livePreview = [inlinePlugin, blockField, codeHover];
export { focusPlugin };
