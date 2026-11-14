// Show the characters you cannot normally see, Notepad++ style but quieter:
// a dot for each space, an arrow for each tab, a return mark at each line end,
// and outlines for the easily-missed full-width and non-breaking spaces.
import { ViewPlugin, Decoration, WidgetType, MatchDecorator, EditorView, highlightWhitespace } from '@codemirror/view';

class EolWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-eol'; s.textContent = '↵'; s.setAttribute('aria-hidden', 'true'); return s; }
  ignoreEvent() { return false; }
}
const eol = Decoration.widget({ widget: new EolWidget(), side: 1 });

const lineEnds = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const { doc } = view.state, out = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        if (line.number < doc.lines) out.push(eol.range(line.to)); // the last line has no line break after it
        pos = line.to + 1;
      }
    }
    return Decoration.set(out);
  }
}, { decorations: (v) => v.decorations });

const oddSpaces = new MatchDecorator({
  regexp: /[\u3000\u00a0]/g,
  decoration: (m) => Decoration.mark({ class: m[0] === '\u3000' ? 'cm-ws-wide' : 'cm-ws-nbsp' }),
});
const oddSpacePlugin = ViewPlugin.define((view) => ({
  decorations: oddSpaces.createDeco(view),
  update(u) { this.decorations = oddSpaces.updateDeco(u, this.decorations); },
}), { decorations: (v) => v.decorations });

export const invisibles = [highlightWhitespace(), lineEnds, oddSpacePlugin, EditorView.editorAttributes.of({ class: 'cm-show-ws' })];
