// The block under the caret becomes a small raised card. Drawn as an editor layer,
// so it scrolls with the text, and glides from block to block.
import { layer, ViewPlugin } from '@codemirror/view';
import { topBlockAt } from './structure.js';
import { live } from './widgets.js';
import { refreshLive } from './live.js';

class IslandMarker {
  constructor(x, y, w, h) { this.x = x; this.y = y; this.w = w; this.h = h; }
  draw() { const d = document.createElement('div'); d.className = 'cm-island'; this.place(d); return d; }
  update(dom) { this.place(dom); return true; }
  place(d) { d.style.transform = `translate(${this.x}px, ${this.y}px)`; d.style.width = this.w + 'px'; d.style.height = this.h + 'px'; }
  eq(o) { return o.x === this.x && o.y === this.y && o.w === this.w && o.h === this.h; }
}

const PAD_X = 14; // how far the card reaches past the text, each side

/** The text column with the card's margin, in the layers' coordinates (they scroll with the text): [left, right]. */
function textColumn(view) {
  const s = view.scrollDOM.getBoundingClientRect(), c = view.contentDOM.getBoundingClientRect();
  const cs = getComputedStyle(view.contentDOM);
  const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
  const baseLeft = s.left - view.scrollDOM.scrollLeft;
  return [Math.round(c.left + padL - baseLeft - PAD_X), Math.round(c.right - padR - baseLeft + PAD_X)];
}

/**
 * A selected whole line is drawn by CodeMirror out to the editor's outer edge, past its padding,
 * so it stuck out of the card on both sides. The selection is clipped to the card's column
 * (--sel-l / --sel-r, used in editor.css), with or without the card.
 */
export const selectionClip = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.measure(); }
  update(u) { if (u.geometryChanged || u.viewportChanged || u.docChanged) this.measure(); }
  measure() {
    this.view.requestMeasure({
      key: this,
      read: (view) => textColumn(view),
      write: ([l, r], view) => { view.dom.style.setProperty('--sel-l', l + 'px'); view.dom.style.setProperty('--sel-r', r + 'px'); },
    });
  }
});

export const islandLayer = layer({
  above: false,
  class: 'cm-island-layer',
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.focusChanged ||
    u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLive))),
  markers(view) {
    if (!live.island) return [];
    const { state } = view;
    const blk = topBlockAt(state, state.selection.main.head);
    if (!blk) return [];
    const s = view.scrollDOM.getBoundingClientRect();
    const baseTop = s.top - view.scrollDOM.scrollTop;
    const top = view.lineBlockAt(blk.from).top, bottom = view.lineBlockAt(blk.to).bottom;
    const padY = 4;
    const [left, right] = textColumn(view);
    return [new IslandMarker(left, Math.round(view.documentTop - baseTop + top - padY), right - left, Math.round(bottom - top + padY * 2))];
  },
});
