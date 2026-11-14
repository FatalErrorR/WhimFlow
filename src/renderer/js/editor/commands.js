// Formatting commands. They all edit Markdown text directly, so every one of them
// is a single undoable step.
import { EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { undo, redo } from '@codemirror/commands';
import { insertCodeBlock, toggleLineHighlight, toggleFold } from './code.js';
import { fenceAt } from './structure.js';

const INLINE = {
  bold: { open: '**', node: 'StrongEmphasis', mark: 'EmphasisMark' },
  italic: { open: '*', node: 'Emphasis', mark: 'EmphasisMark' },
  strike: { open: '~~', node: 'Strikethrough', mark: 'StrikethroughMark' },
  mark: { open: '==', node: 'Highlight', mark: 'HighlightMark' },
  'inline-code': { open: '`', node: 'InlineCode', mark: 'CodeMark' },
  'inline-math': { open: '$', node: 'InlineMath', mark: 'MathMark' },
  underline: { open: '<u>', close: '</u>' },
};

function enclosing(state, range, nodeName) {
  for (let n = syntaxTree(state).resolveInner(range.from, 1); n; n = n.parent) {
    if (n.name === nodeName && n.from <= range.from && n.to >= range.to) return n;
  }
  return null;
}

function toggleInline(view, kind) {
  const spec = INLINE[kind], open = spec.open, close = spec.close || spec.open;
  const { state } = view;
  view.dispatch(state.update(state.changeByRange((range) => {
    const node = spec.node && enclosing(state, range, spec.node);
    if (node) {
      const marks = node.getChildren(spec.mark);
      if (marks.length >= 2) {
        const a = marks[0], b = marks[marks.length - 1];
        const shift = (p) => (p > a.to ? p - (a.to - a.from) : p > a.from ? a.from : p);
        return {
          changes: [{ from: a.from, to: a.to }, { from: b.from, to: b.to }],
          range: EditorSelection.range(shift(range.anchor), shift(Math.min(range.head, b.from))),
        };
      }
    }
    if (state.sliceDoc(range.from - open.length, range.from) === open && state.sliceDoc(range.to, range.to + close.length) === close) {
      return { changes: [{ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + close.length }], range: EditorSelection.range(range.from - open.length, range.to - open.length) };
    }
    return { changes: [{ from: range.from, insert: open }, { from: range.to, insert: close }], range: EditorSelection.range(range.from + open.length, range.to + open.length) };
  }), { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
}

function selectedLines(state) {
  const seen = new Set(), lines = [];
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) if (!seen.has(n)) { seen.add(n); lines.push(state.doc.line(n)); }
  }
  return lines;
}

const QUOTE_RE = /^(\s*)>\s?/;
const LIST_RE = /^(\s*)([-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/;
const HEADING_RE = /^(\s*(?:>\s?)*)(#{1,6})[ \t]+/;

function editLines(view, fn) {
  const { state } = view;
  const changes = [];
  selectedLines(state).forEach((line, i, all) => {
    const next = fn(line.text, i, all);
    if (next != null && next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  });
  if (!changes.length) return true;
  // a caret keeps its distance from the end of its line, so it stays by the same text,
  // and on an empty line it ends up after the new marker ("- [ ] |"), ready to type
  const sel = state.selection.main;
  let selection;
  if (sel.empty) {
    const line = state.doc.lineAt(sel.head);
    const c = changes.find((x) => x.from === line.from);
    if (c) {
      const before = changes.filter((x) => x.from < line.from).reduce((n, x) => n + x.insert.length - (x.to - x.from), 0);
      selection = { anchor: line.from + before + Math.max(0, c.insert.length - (line.to - sel.head)) };
    }
  }
  view.dispatch(state.update({ changes, selection, scrollIntoView: true, userEvent: 'input.format' }));
  return true;
}

function setHeading(view, level) {
  return editLines(view, (text) => {
    const m = HEADING_RE.exec(text);
    const prefix = m ? m[1] : (/^(\s*(?:>\s?)*)/.exec(text)[1]);
    const body = m ? text.slice(m[0].length) : text.slice(prefix.length);
    return prefix + (level ? '#'.repeat(level) + ' ' : '') + body;
  });
}

export function headingLevelAt(state) {
  const m = HEADING_RE.exec(state.doc.lineAt(state.selection.main.head).text);
  return m ? m[2].length : 0;
}

function toggleList(view, kind) {
  const { state } = view;
  const lines = selectedLines(state);
  const has = (t) => {
    const m = LIST_RE.exec(t);
    if (!m) return false;
    if (kind === 'check') return /\[[ xX]\]/.test(m[2]);
    if (kind === 'ordered-list') return /^\d/.test(m[2]);
    return /^[-*+]/.test(m[2]) && !/\[[ xX]\]/.test(m[2]);
  };
  // already a list of this kind (blank lines in between don't count, but blank lines alone are not a list)
  const all = lines.some((l) => l.text.trim()) && lines.every((l) => !l.text.trim() || has(l.text));
  let n = 0;
  return editLines(view, (text) => {
    if (!text.trim() && lines.length > 1) return text;
    const m = LIST_RE.exec(text);
    const indent = m ? m[1] : /^\s*/.exec(text)[0];
    const body = m ? text.slice(m[0].length) : text.slice(indent.length);
    if (all) return indent + body;
    const prefix = kind === 'check' ? '- [ ] ' : kind === 'ordered-list' ? `${++n}. ` : '- ';
    return indent + prefix + body;
  });
}

function toggleQuote(view) {
  const lines = selectedLines(view.state);
  const all = lines.every((l) => QUOTE_RE.test(l.text));
  return editLines(view, (text) => (all ? text.replace(QUOTE_RE, '$1') : '> ' + text));
}

/** Put a block on its own lines at the caret; `caret` is the offset inside `text`. */
function insertBlock(view, text, caret, selectLen = 0) {
  const { state } = view, line = state.doc.lineAt(state.selection.main.head);
  const blank = !line.text.trim();
  const lead = blank ? '' : '\n\n';
  const from = blank ? line.from : line.to;
  const anchor = from + lead.length + caret;
  view.dispatch({ changes: { from, to: line.to, insert: lead + text }, selection: { anchor, head: anchor + selectLen }, scrollIntoView: true, userEvent: 'input' });
  view.focus();
  return true;
}

function link(view) {
  const { state } = view, r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to);
  if (/^https?:\/\/\S+$/.test(text)) {
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `[](${text})` }, selection: { anchor: r.from + 1 }, userEvent: 'input.format' });
  } else {
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `[${text}]()` }, selection: { anchor: r.from + text.length + 3 }, userEvent: 'input.format' });
  }
  return true;
}

export function runCommand(view, name, arg, t) {
  // inside a code block, "highlight" marks whole lines rather than wrapping text in ==
  if (name === 'mark' && fenceAt(view.state, view.state.selection.main.head)) return toggleLineHighlight(view);
  if (INLINE[name]) return toggleInline(view, name);
  switch (name) {
    case 'code-highlight': return toggleLineHighlight(view);
    case 'code-fold': return toggleFold(view);
    case 'undo': return undo(view);
    case 'redo': return redo(view);
    case 'heading': return setHeading(view, arg);
    case 'heading-up': { const l = headingLevelAt(view.state); return setHeading(view, l ? Math.max(1, l - 1) : 6); }
    case 'heading-down': { const l = headingLevelAt(view.state); return l ? setHeading(view, l >= 6 ? 0 : l + 1) : true; }
    case 'quote': return toggleQuote(view);
    case 'list': case 'ordered-list': case 'check': return toggleList(view, name);
    case 'code-block': return insertCodeBlock(view);
    case 'math-block': return insertBlock(view, '$$\n\n$$', 3);
    case 'table': {
      const h = t('列', 'Column');
      return insertBlock(view, `| ${h} 1 | ${h} 2 | ${h} 3 |\n| --- | --- | --- |\n|  |  |  |`, 2, `${h} 1`.length);
    }
    case 'line': return insertBlock(view, '---\n\n', 5);
    case 'toc': return insertBlock(view, '[toc]\n\n', 7);
    case 'footnote': {
      // a numbered reference at the caret, its definition at the end of the document
      const { state } = view, text = state.doc.toString(), r = state.selection.main;
      const used = new Set([...text.matchAll(/\[\^(\d+)\]/g)].map((m) => +m[1]));
      let n = 1;
      while (used.has(n)) n++;
      const ref = `[^${n}]`;
      const lead = /\n\[\^[^\]]+\]:[^\n]*\n?$/.test(text) ? (text.endsWith('\n') ? '' : '\n') : (text.endsWith('\n') ? '\n' : '\n\n');
      const def = `${lead}[^${n}]: `;
      view.dispatch({ changes: [{ from: r.to, insert: ref }, { from: state.doc.length, insert: def }], selection: { anchor: state.doc.length + ref.length + def.length }, scrollIntoView: true, userEvent: 'input' });
      view.focus();
      return true;
    }
    case 'link': return link(view);
    case 'image': {
      const r = view.state.selection.main;
      const ins = `![](${arg})`;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: ins }, selection: { anchor: r.from + ins.length }, userEvent: 'input' });
      return true;
    }
    default: return false;
  }
}
