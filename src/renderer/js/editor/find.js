// Find & replace over the Markdown text. Matches are decorations; replacing all
// is one transaction, so a single undo brings everything back.
import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { SearchCursor } from '@codemirror/search';

const setQuery = StateEffect.define();
const setIndex = StateEffect.define();
const LIMIT = 5000;

function compute(state, query, cs) {
  const out = [];
  if (!query) return out;
  const cursor = new SearchCursor(state.doc, query, 0, state.doc.length, cs ? undefined : (s) => s.toLowerCase());
  while (!cursor.next().done && out.length < LIMIT) out.push({ from: cursor.value.from, to: cursor.value.to });
  return out;
}
const matchMark = Decoration.mark({ class: 'cm-find' });
const currentMark = Decoration.mark({ class: 'cm-find cm-find-current' });
function make(query, cs, matches, idx) {
  const deco = Decoration.set(matches.map((m, i) => (i === idx ? currentMark : matchMark).range(m.from, m.to)));
  return { query, cs, matches, idx, deco };
}

export const findField = StateField.define({
  create: () => make('', false, [], -1),
  update(v, tr) {
    let { query, cs, idx } = v, matches = v.matches, dirty = false;
    for (const e of tr.effects) {
      if (e.is(setQuery)) { query = e.value.query; cs = e.value.cs; idx = -1; dirty = true; }
      if (e.is(setIndex)) { idx = e.value; return make(query, cs, matches, idx); }
    }
    if (tr.docChanged && query) dirty = true;
    if (!dirty) return v;
    matches = compute(tr.state, query, cs);
    if (idx >= matches.length) idx = matches.length - 1;
    return make(query, cs, matches, idx);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function findApi(view) {
  const field = () => view.state.field(findField);
  const status = () => { const v = field(); return { count: v.matches.length, index: v.idx, capped: v.matches.length >= LIMIT }; };
  const select = (i) => {
    const m = field().matches[i];
    if (!m) return;
    view.dispatch({ effects: [setIndex.of(i), EditorView.scrollIntoView(m.from, { y: 'center' })], selection: { anchor: m.from, head: m.to } });
  };
  return {
    status,
    set(query, cs) {
      view.dispatch({ effects: setQuery.of({ query, cs }) });
      const { matches } = field();
      if (matches.length) {
        const head = view.state.selection.main.from;
        const i = matches.findIndex((m) => m.from >= head);
        select(i < 0 ? 0 : i);
      }
      return status();
    },
    step(d) {
      const { matches, idx } = field();
      if (!matches.length) return status();
      select(((idx < 0 ? (d > 0 ? -1 : 0) : idx) + d + matches.length) % matches.length);
      return status();
    },
    replaceOne(rep) {
      const { matches, idx } = field();
      const m = matches[idx];
      if (!m) return status();
      view.dispatch({ changes: { from: m.from, to: m.to, insert: rep }, userEvent: 'input.replace' });
      const after = field().matches;
      if (after.length) {
        const i = after.findIndex((x) => x.from >= m.from + rep.length);
        select(i < 0 ? 0 : i);
      }
      return status();
    },
    replaceAll(rep) {
      const { matches } = field();
      if (!matches.length) return 0;
      view.dispatch({ changes: matches.map((m) => ({ from: m.from, to: m.to, insert: rep })), userEvent: 'input.replace.all' });
      return matches.length;
    },
    clear() { view.dispatch({ effects: setQuery.of({ query: '', cs: false }) }); },
  };
}
