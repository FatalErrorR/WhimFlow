// Numbered lists keep their numbers in order. Enter already numbers the items after a new one,
// but indenting an item (Tab), outdenting it, deleting one or pasting did not: "1. 2. 3." with
// the second item indented read "1. / 2. / 3. 4." in the text. After any typed change, the numbered
// lists it touches are numbered again, in the same step (one ⌘Z undoes both):
//   - a list at the top keeps its first number (a list may start at 5), then counts on
//   - a list inside an item (made by indenting) counts from 1
// Undo, redo and text from elsewhere (reloading the file, sync) are left as they are.
import { EditorState } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';

const typed = (tr) => ['input', 'delete', 'move'].some((e) => tr.isUserEvent(e)) && !tr.isUserEvent('input.format.renumber');

/** The number changes that put the numbered lists around `ranges` (in `state`) in order. */
export function renumberChanges(state, ranges) {
  if (!ranges.length) return [];
  const doc = state.doc;
  const lo = Math.max(0, doc.lineAt(Math.min(...ranges.map((r) => r[0]))).from - 1);
  const hi = Math.min(doc.length, doc.lineAt(Math.max(...ranges.map((r) => r[1]))).to + 1);
  const tree = ensureSyntaxTree(state, Math.min(doc.length, hi + 1000), 50) || syntaxTree(state);
  const lists = new Map(); // from -> node
  tree.iterate({
    from: lo, to: hi,
    enter: (n) => { if (n.name === 'OrderedList') lists.set(n.from, n.node); },
  });
  const changes = [];
  for (const list of lists.values()) {
    let nested = false;
    for (let p = list.parent; p; p = p.parent) if (p.name === 'ListItem') { nested = true; break; }
    let want = null;
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const mark = item.getChild('ListMark');
      if (!mark) continue;
      const m = /^(\d+)/.exec(doc.sliceString(mark.from, mark.to));
      if (!m) continue;
      if (want == null) want = nested ? 1 : +m[1];
      if (+m[1] !== want) changes.push({ from: mark.from, to: mark.from + m[1].length, insert: String(want) });
      want++;
    }
  }
  return changes;
}

export const renumberLists = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !typed(tr)) return tr;
  const ranges = [];
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => ranges.push([fromB, toB]));
  const changes = renumberChanges(tr.state, ranges);
  if (!changes.length) return tr;
  return [tr, { changes, sequential: true, userEvent: 'input.format.renumber' }];
});
