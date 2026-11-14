// Reading document structure straight from the syntax tree: headings, the block
// under the caret, fenced-code details.
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { parseInfo, withInfo } from '../codemeta.js';

export const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/** Markdown inline source → plain text (for outline labels, word counts). */
export function plainInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/(\*\*|__|~~|==|\*|_|`|\$)/g, '')
    .trim();
}

export function fullTree(state, timeout = 200) {
  return ensureSyntaxTree(state, state.doc.length, timeout) || syntaxTree(state);
}

/** All headings in document order. `top` is true when not nested in a quote/list. */
export function headingsOf(state) {
  const out = [];
  fullTree(state).iterate({
    enter(n) {
      const m = /^(ATX|Setext)Heading(\d)$/.exec(n.name);
      if (m) {
        const line = state.doc.lineAt(n.from);
        let raw = m[1] === 'ATX'
          ? state.doc.sliceString(n.from, n.to).replace(/^#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, '')
          : line.text;
        out.push({ level: +m[2], text: plainInline(raw), raw: raw.trim(), from: n.from, to: n.to, line: line.number, top: n.node.parent && n.node.parent.name === 'Document', setext: m[1] === 'Setext' });
        return false;
      }
      if (!CONTAINERS.has(n.name)) return false;
    },
  });
  return out;
}

/** The top-level block containing `pos` (lists and quotes count as one block). */
export function topBlockAt(state, pos) {
  const tree = syntaxTree(state);
  for (const side of [1, -1]) {
    let node = tree.resolveInner(pos, side);
    while (node && node.parent && node.parent.name !== 'Document') node = node.parent;
    if (node && node.name !== 'Document' && node.from <= pos && node.to >= pos) return { from: node.from, to: node.to, name: node.name };
  }
  return null;
}

/** Language, options and text of a fenced block, and where its info string sits. */
export function fenceInfo(state, node) {
  let raw = '', infoFrom = -1, infoTo = -1, closed = false, codeFrom = null, codeTo = null;
  const first = node.firstChild;
  for (let c = first; c; c = c.nextSibling) {
    if (c.name === 'CodeInfo') { raw = state.sliceDoc(c.from, c.to); infoFrom = c.from; infoTo = c.to; }
    if (c.name === 'CodeText') { codeFrom = c.from; codeTo = c.to; }
    if (c.name === 'CodeMark' && c !== first && c.from > first.to) closed = state.doc.lineAt(c.from).number > state.doc.lineAt(first.from).number;
  }
  if (infoFrom < 0) infoFrom = infoTo = first ? first.to : node.from; // where one would be written
  const code = codeFrom == null ? '' : state.sliceDoc(codeFrom, codeTo);
  const meta = parseInfo(raw);
  const open = state.doc.lineAt(node.from).number, end = state.doc.lineAt(node.to).number;
  // body lines are open+1 … bodyLast (1-based document line numbers)
  return { lang: meta.lang, meta, raw, infoFrom, infoTo, closed, code, open, bodyLast: closed ? end - 1 : end };
}

/** The FencedCode node containing pos, if any. */
export function fenceAt(state, pos) {
  for (const side of [-1, 1]) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) if (n.name === 'FencedCode') return n;
  }
  return null;
}

// Footnote numbers (in order of first reference) and their text, per document version.
const fnCache = new WeakMap();
export function footnotesOf(state) {
  const doc = state.doc;
  if (fnCache.has(doc)) return fnCache.get(doc);
  const text = doc.toString(), nums = new Map(), defs = new Map();
  for (const m of text.matchAll(/^\[\^([^\]\s]+)\]:[ \t]?(.*)$/gm)) defs.set(m[1], plainInline(m[2]));
  let n = 0;
  for (const m of text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) if (!nums.has(m[1])) nums.set(m[1], ++n);
  for (const k of defs.keys()) if (!nums.has(k)) nums.set(k, ++n);
  const r = { nums, defs };
  fnCache.set(doc, r);
  return r;
}

/** Change a fenced block's options (title, highlighted lines, fold) as one edit. */
export function setFenceMeta(view, node, patch) {
  const info = fenceInfo(view.state, node);
  const insert = withInfo(info.raw, typeof patch === 'function' ? patch(info) : patch);
  if (insert === info.raw) return false;
  view.dispatch({ changes: { from: info.infoFrom, to: info.infoTo, insert }, userEvent: 'input.codemeta' });
  return true;
}
