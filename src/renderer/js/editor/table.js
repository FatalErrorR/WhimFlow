// Tables in source form: Tab / ⇧Tab move between cells and Enter moves down a row.
// Every move re-aligns the columns (CJK characters count double width).
import { syntaxTree } from '@codemirror/language';

const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const width = (s) => { let w = 0; for (const ch of s) w += wide.test(ch) ? 2 : 1; return w; };

function tableNode(state, pos) {
  for (const side of [-1, 1]) for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) if (n.name === 'Table') return n;
  return null;
}

export function splitRow(text) {
  let s = text.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Which cell of `text` holds column offset `off`. */
function cellIndex(text, off) {
  const lead = /^\s*\|/.test(text);
  let col = 0;
  for (let i = 0; i < off && i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '|') col++;
  }
  return Math.max(0, lead ? col - 1 : col);
}

/** Re-align `rows`; returns the new lines and, per row, the offset just after each cell's text. */
export function layout(rows) {
  const ncol = Math.max(...rows.map((r) => r.length));
  const delim = rows[1] || [];
  const align = Array.from({ length: ncol }, (_, i) => {
    const d = (delim[i] || '').trim();
    return d.startsWith(':') && d.endsWith(':') && d.length > 1 ? 'c' : d.endsWith(':') ? 'r' : d.startsWith(':') ? 'l' : '';
  });
  const widths = Array.from({ length: ncol }, (_, i) => Math.max(3, ...rows.map((r, ri) => (ri === 1 ? 3 : width(r[i] || '')))));
  const ends = [];
  const lines = rows.map((r, ri) => {
    let line = '|';
    const rowEnds = [];
    for (let i = 0; i < ncol; i++) {
      line += ' ';
      if (ri === 1) {
        const a = align[i], w = widths[i];
        line += (a === 'l' || a === 'c' ? ':' : '-') + '-'.repeat(w - 2) + (a === 'r' || a === 'c' ? ':' : '-');
        rowEnds.push(line.length);
      } else {
        const c = r[i] || '', pad = widths[i] - width(c);
        const left = align[i] === 'r' ? pad : align[i] === 'c' ? pad >> 1 : 0;
        line += ' '.repeat(left) + c;
        rowEnds.push(line.length);
        line += ' '.repeat(pad - left);
      }
      line += ' |';
    }
    ends.push(rowEnds);
    return line;
  });
  return { lines, ends, ncol };
}

function moveInTable(view, how) {
  const { state } = view, sel = state.selection.main;
  if (!sel.empty) return false;
  const node = tableNode(state, sel.head);
  if (!node) return false;
  const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
  const cur = state.doc.lineAt(sel.head);
  const texts = [];
  for (let n = first.number; n <= last.number; n++) texts.push(state.doc.line(n).text);
  if (texts.length < 2 || !texts.every((t) => t.includes('|'))) return false;
  const prefix = /^\s*/.exec(texts[0])[0];
  const rows = texts.map(splitRow);
  let row = cur.number - first.number, col = cellIndex(cur.text, sel.head - cur.from);
  const ncol = Math.max(...rows.map((r) => r.length));
  if (how === 'next') {
    col++;
    if (col >= ncol) { col = 0; row++; if (row === 1) row = 2; }
  } else if (how === 'prev') {
    col--;
    if (col < 0) { row--; if (row === 1) row = 0; col = ncol - 1; }
    if (row < 0) { row = 0; col = 0; }
  } else if (how === 'down') {
    row++; if (row === 1) row = 2;
  }
  if (row >= rows.length) rows.push(Array(ncol).fill(''));
  col = Math.min(col, ncol - 1);
  const { lines, ends } = layout(rows);
  const text = lines.map((l) => prefix + l).join('\n');
  let anchor = first.from;
  for (let i = 0; i < row; i++) anchor += lines[i].length + prefix.length + 1;
  anchor += prefix.length + ends[row][col];
  view.dispatch({ changes: { from: first.from, to: last.to, insert: text }, selection: { anchor }, scrollIntoView: true, userEvent: 'input.table' });
  return true;
}

export const tableKeymap = [
  { key: 'Tab', run: (v) => moveInTable(v, 'next') },
  { key: 'Shift-Tab', run: (v) => moveInTable(v, 'prev') },
  { key: 'Enter', run: (v) => moveInTable(v, 'down') },
];
