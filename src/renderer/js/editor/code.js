// Fenced code blocks: language autocompletion on the fence line, auto-closing
// the fence on Enter, and ⌘↩ to step out of a block.
import { startCompletion } from '@codemirror/autocomplete';
import { EditorSelection, EditorState } from '@codemirror/state';
import { matchLanguages } from './lang.js';
import { fenceAt, fenceInfo, setFenceMeta } from './structure.js';
import { parseInfo, withInfo, toRanges, linesOf, canFold } from '../codemeta.js';
import { live } from './widgets.js';

// the language may be followed by options: ```python title="a.py" {2,4} fold
const OPEN_RE = /^(\s*(?:>\s?)*)(`{3,}|~{3,})([^`\s]*)(?:\s[^`]*)?$/;

const recent = () => { try { return JSON.parse(localStorage.getItem('mf-langs') || '[]'); } catch (_) { return []; } };
function remember(id) {
  try { localStorage.setItem('mf-langs', JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 6))); } catch (_) { /* private mode */ }
}

/** Is `line` the opening fence of a code block (not a closing one)? */
function openingFence(state, line) {
  const m = OPEN_RE.exec(line.text);
  if (!m) return null;
  const node = fenceAt(state, line.from + m[1].length);
  if (node && state.doc.lineAt(node.from).number !== line.number) return null;
  return { prefix: m[1], fence: m[2], info: m[3], node };
}

/** Make sure the block has a closing fence and put the caret on its first line. */
export function enterFence(view) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const open = openingFence(state, line);
  if (!open) return false;
  const node = fenceAt(state, line.from + open.prefix.length);
  const info = node ? fenceInfo(state, node) : { closed: false };
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const nextIsClose = next && info.closed && node && next.to >= node.to;
  if (!info.closed) {
    view.dispatch({ changes: { from: line.to, insert: `\n${open.prefix}\n${open.prefix}${open.fence}` }, selection: { anchor: line.to + 1 + open.prefix.length }, scrollIntoView: true, userEvent: 'input' });
  } else if (nextIsClose) {
    view.dispatch({ changes: { from: line.to, insert: `\n${open.prefix}` }, selection: { anchor: line.to + 1 + open.prefix.length }, scrollIntoView: true, userEvent: 'input' });
  } else {
    view.dispatch({ selection: { anchor: next.from + Math.min(next.text.length, open.prefix.length) }, scrollIntoView: true });
  }
  return true;
}

export function fenceCompletion(context) {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const m = /^(\s*(?:>\s?)*)(`{3,}|~{3,})([^`\s]*)$/.exec(before);
  if (!m) return optionCompletion(context, line, before);
  if (line.text.slice(pos - line.from).trim()) return null;
  if (!openingFence(state, line)) return null;
  const from = pos - m[3].length;
  const items = matchLanguages(m[3], recent());
  if (!items.length) return null;
  return {
    from,
    filter: false,
    options: items.map(({ l, via }, i) => ({
      label: l.id,
      detail: l.kind === 'diagram' ? live.t('图表', 'diagram') : via || l.aliases.slice(0, 2).join(' '),
      boost: 99 - i,
      apply(view, _c, a, b) {
        view.dispatch({ changes: { from: a, to: b, insert: l.id }, selection: { anchor: a + l.id.length }, userEvent: 'input.complete' });
        remember(l.id);
        enterFence(view);
      },
    })),
  };
}

/** After the language: the options a fence understands, offered once a letter is typed. */
function optionCompletion(context, line, before) {
  const m = /^\s*(?:>\s?)*(?:`{3,}|~{3,})\S*\s(?:.*\s)?([a-z]+)$/.exec(before);
  if (!m || !openingFence(context.state, line)) return null;
  const meta = parseInfo(line.text.replace(/^\s*(?:>\s?)*(?:`{3,}|~{3,})/, '').slice(0, -m[1].length) + ' ' + line.text.slice(context.pos - line.from));
  const all = [
    !meta.title && { label: 'title=""', detail: live.t('文件名标题', 'file name'), caret: 7 },
    !meta.fold && { label: 'fold', detail: live.t('默认折叠', 'start folded'), caret: 4 },
  ].filter((o) => o && o.label.startsWith(m[1]));
  if (!all.length) return null;
  return {
    from: context.pos - m[1].length,
    filter: false,
    options: all.map((o) => ({
      label: o.label, detail: o.detail,
      apply(view, _c, a, b) { view.dispatch({ changes: { from: a, to: b, insert: o.label }, selection: { anchor: a + o.caret }, userEvent: 'input.complete' }); },
    })),
  };
}

/** Enter at the end of an opening fence: close the block and step inside. */
function enterOnFence(view) {
  const { state } = view, sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to || !openingFence(state, line)) return false;
  return enterFence(view);
}

/** ⌘↩ inside a code block: leave it and start a new paragraph below. */
function exitBlock(view) {
  const { state } = view;
  const node = fenceAt(state, state.selection.main.head);
  if (!node) return false;
  const info = fenceInfo(state, node);
  const open = openingFence(state, state.doc.lineAt(node.from));
  let insert = '\n\n', at = node.to;
  if (!info.closed) { const end = state.doc.lineAt(node.to); at = end.to; insert = `\n${open ? open.prefix + open.fence : '```'}\n\n`; }
  view.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at + insert.length), scrollIntoView: true, userEvent: 'input' });
  return true;
}

export const codeKeymap = [
  { key: 'Enter', run: enterOnFence },
  { key: 'Mod-Enter', run: exitBlock },
];

/** Insert a fenced block at the caret (or around the selected lines) and ask for its language. */
export function insertCodeBlock(view) {
  const { state } = view, sel = state.selection.main;
  if (fenceAt(state, sel.head)) return true;
  if (!sel.empty) {
    const a = state.doc.lineAt(sel.from), b = state.doc.lineAt(sel.to);
    const body = state.sliceDoc(a.from, b.to);
    const fence = /```/.test(body) ? '````' : '```';
    view.dispatch({ changes: { from: a.from, to: b.to, insert: `${fence}\n${body}\n${fence}` }, selection: { anchor: a.from + fence.length }, scrollIntoView: true, userEvent: 'input' });
  } else {
    const line = state.doc.lineAt(sel.head);
    const blank = !line.text.trim();
    const from = blank ? line.from : line.to, to = blank ? line.to : line.to;
    const lead = blank ? '' : '\n\n';
    const text = `${lead}\`\`\`\n\n\`\`\``;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + lead.length + 3 }, scrollIntoView: true, userEvent: 'input' });
  }
  view.focus();
  startCompletion(view);
  return true;
}

// ---- highlighted lines: ```js {2,4-6} ----

/** Toggle the highlight on the selected lines of the code block under the caret. */
export function toggleLineHighlight(view) {
  const { state } = view, sel = state.selection.main;
  const node = fenceAt(state, sel.head);
  if (!node) return false;
  const info = fenceInfo(state, node);
  const a = Math.max(1, state.doc.lineAt(sel.from).number - info.open), b = Math.min(info.bodyLast, state.doc.lineAt(sel.to).number) - info.open;
  if (b < a) return true; // the caret is on a fence line
  const lines = linesOf(info.meta.hl);
  let all = true;
  for (let k = a; k <= b; k++) if (!lines.has(k)) all = false;
  for (let k = a; k <= b; k++) { if (all) lines.delete(k); else lines.add(k); }
  setFenceMeta(view, node, { hl: toRanges([...lines]) });
  return true;
}

/** Fold or unfold the code block under the caret. Returns 'folded', 'unfolded', 'short' or null. */
export function toggleFold(view) {
  const node = fenceAt(view.state, view.state.selection.main.head);
  if (!node) return null;
  const info = fenceInfo(view.state, node);
  if (!info.closed || !canFold(info.bodyLast - info.open)) return 'short';
  setFenceMeta(view, node, { fold: !info.meta.fold });
  return info.meta.fold ? 'unfolded' : 'folded';
}

// Highlighted line numbers follow the code: add or remove a line above a highlighted
// one and its number moves with it, so {…} keeps pointing at the same code.
export const keepHighlights = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.isUserEvent('input.codemeta')) return tr;
  let count = 0, c = null;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { count++; c = { fromA, toA, inserted }; });
  if (count !== 1) return tr;
  const st = tr.startState, la = st.doc.lineAt(c.fromA), lb = st.doc.lineAt(c.toA);
  const added = c.inserted.lines - 1, removed = lb.number - la.number;
  if (added === removed) return tr; // no line was added or removed: nothing moves
  const node = fenceAt(st, c.fromA);
  if (!node) return tr;
  const info = fenceInfo(st, node);
  if (!info.meta.hl.length || !info.closed) return tr;
  if (la.number <= info.open || lb.number > info.bodyLast) return tr; // the edit must stay inside the code
  const old = linesOf(info.meta.hl), next = new Set();
  const a = la.number - info.open, b = lb.number - info.open, delta = added - removed;
  // whole lines inserted or deleted (the edit starts and ends at line starts)…
  const whole = c.fromA === la.from && c.toA === lb.from && (c.inserted.length === 0 || c.inserted.line(c.inserted.lines).length === 0);
  if (whole) {
    for (const k of old) { if (k < a) next.add(k); else if (k >= b) next.add(k + delta); }
    if (old.has(a - 1) && old.has(b)) for (let i = 0; i < added; i++) next.add(a + i); // inside a highlighted run
  } else { // …or a line split / joined somewhere in the middle
    for (const k of old) { if (k <= a) next.add(k); else if (k > b) next.add(k + delta); }
    if (old.has(a) && old.has(b + 1)) for (let i = 1; i <= added; i++) next.add(a + i);
  }
  const insert = withInfo(info.raw, { hl: toRanges([...next]) });
  if (insert === info.raw) return tr;
  return [tr, { changes: { from: info.infoFrom, to: info.infoTo, insert } }];
});
