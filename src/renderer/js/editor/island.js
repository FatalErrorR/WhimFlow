// The block under the caret becomes a small raised card. Drawn as an editor layer,
// so it scrolls with the text, and glides from block to block.
import { layer } from '@codemirror/view';
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
    const s = view.scrollDOM.getBoundingClientRect(), c = view.contentDOM.getBoundingClientRect();
    const cs = getComputedStyle(view.contentDOM);
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const baseLeft = s.left - view.scrollDOM.scrollLeft, baseTop = s.top - view.scrollDOM.scrollTop;
    const top = view.lineBlockAt(blk.from).top, bottom = view.lineBlockAt(blk.to).bottom;
    const padX = 14, padY = 4;
    return [new IslandMarker(
      Math.round(c.left + padL - baseLeft - padX),
      Math.round(view.documentTop - baseTop + top - padY),
      Math.round(c.width - padL - padR + padX * 2),
      Math.round(bottom - top + padY * 2),
    )];
  },
});
