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

/** The text column, plus `pad` on each side, in the layers' coordinates (they scroll with the text): [left, right]. */
function textColumn(view, pad = PAD_X) {
  const s = view.scrollDOM.getBoundingClientRect(), c = view.contentDOM.getBoundingClientRect();
  const cs = getComputedStyle(view.contentDOM);
  const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
  const baseLeft = s.left - view.scrollDOM.scrollLeft;
  return [Math.round(c.left + padL - baseLeft - pad), Math.round(c.right - padR - baseLeft + pad)];
}

/**
 * A selected whole line is drawn by CodeMirror out to the editor's outer edge, past its padding,
 * so it stuck out of the card on both sides. The selection is clipped to the text column
 * (--sel-l / --sel-r, used in editor.css): inside the card, and inside a code block's panel.
 */
export const selectionClip = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.measure(); }
  update(u) { if (u.geometryChanged || u.viewportChanged || u.docChanged) this.measure(); }
  measure() {
    this.view.requestMeasure({
      key: this,
      read: (view) => textColumn(view, 0),
      write: ([l, r], view) => { view.dom.style.setProperty('--sel-l', l + 'px'); view.dom.style.setProperty('--sel-r', r + 'px'); },
    });
  }
});

class CodeBgMarker {
  constructor(x, y, w, h, top, bottom) { Object.assign(this, { x, y, w, h, top, bottom }); }
  draw() { const d = document.createElement('div'); d.className = 'cm-cb-bg'; this.place(d); return d; }
  update(dom) { this.place(dom); return true; }
  place(d) {
    d.style.transform = `translate(${this.x}px, ${this.y}px)`; d.style.width = this.w + 'px'; d.style.height = this.h + 'px';
    d.style.borderRadius = `${this.top ? 10 : 0}px ${this.top ? 10 : 0}px ${this.bottom ? 10 : 0}px ${this.bottom ? 10 : 0}px`;
  }
  eq(o) { return ['x', 'y', 'w', 'h', 'top', 'bottom'].every((k) => o[k] === this[k]); }
}

/**
 * The background of code blocks, under the selection: when each line painted its own, the
 * selection (drawn beneath the text) only showed in the margins of a selected code block.
 * One rounded panel per block on screen, from its rendered lines (.cm-cb, see live.js).
 */
export const codeBgLayer = layer({
  above: false,
  class: 'cm-cb-bg-layer',
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.focusChanged ||
    u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLive))),
  markers(view) {
    const s = view.scrollDOM.getBoundingClientRect();
    const baseLeft = s.left - view.scrollDOM.scrollLeft, baseTop = s.top - view.scrollDOM.scrollTop;
    const out = [];
    let run = null;
    // a panel is rounded where its block ends: the opening fence above, the closing fence (or the
    // last line of an unclosed block) below; cut by the edge of the viewport it stays square there
    const close = () => {
      if (!run) return;
      const end = run.last.classList, bottom = end.contains('cm-cb-close') || (end.contains('cm-cb-last') && !run.last.nextElementSibling);
      out.push(new CodeBgMarker(Math.round(run.l - baseLeft), Math.round(run.t - baseTop), Math.round(run.r - run.l), Math.round(run.b - run.t), run.top, bottom));
      run = null;
    };
    for (const line of view.contentDOM.children) {
      if (!line.classList.contains('cm-cb')) { close(); continue; }
      if (line.classList.contains('cm-cb-open')) close();
      const r = line.getBoundingClientRect();
      if (!run) run = { l: r.left, r: r.right, t: r.top, b: r.bottom, top: line.classList.contains('cm-cb-open'), last: line };
      else { run.l = Math.min(run.l, r.left); run.r = Math.max(run.r, r.right); run.b = r.bottom; run.last = line; }
      if (line.classList.contains('cm-cb-close')) close();
    }
    close();
    return out;
  },
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
