// Right island: mind map and final view (a rendered, read-only copy that follows
// the editor's scroll position).
import { $, t, fileUrl, dirname, ICONS } from '../util.js';
import { renderBlocks, renderMermaidIn } from '../render.js';

export function initRight(ctx) {
  const { api, editor, state } = ctx;
  const right = { open: false, tab: 'mindmap' };

  function setRight(open, tab) {
    if (tab) right.tab = tab;
    right.open = open;
    document.body.classList.toggle('right-open', open);
    document.body.dataset.rtab = right.tab;
    document.querySelectorAll('.right-tab').forEach((b) => b.classList.toggle('active', b.dataset.rtab === right.tab));
    $('#right-label').textContent = { mindmap: t('思维导图', 'Mind Map'), preview: t('正式稿', 'Final View'), history: t('历史版本', 'History') }[right.tab];
    $('#btn-right').classList.toggle('on', open);
    ctx.islands && ctx.islands.applyOrder(false);
    if (open) {
      ctx.mindmap.reset();
      const side = ctx.sidebar.isOpen() ? $('#sidebar').offsetWidth : 0;
      api.ensureWidth(side + 600 + $('#right').offsetWidth + 40);
      refresh(true);
    }
  }
  const toggle = (tab) => setRight(!(right.open && right.tab === tab), tab);
  document.querySelectorAll('.right-tab').forEach((b) => { b.onclick = () => setRight(true, b.dataset.rtab); });

  let timer = null, seq = 0;
  /** `now`: render at once and from scratch (panel opened, theme changed); otherwise when typing allows. */
  function refresh(now) {
    if (!right.open) return;
    if (right.tab === 'mindmap') ctx.mindmap.render();
    else if (right.tab === 'history') { if (now) ctx.history.render(); }
    else if (now) { clearTimeout(timer); timer = null; renderPreview(true); }
    else schedulePreview();
  }

  // ---- the final view, updated block by block ----
  // While typing, updates are throttled rather than postponed: the first keystroke
  // plans one, later keystrokes join it, so the view keeps up with typing. The pause
  // grows with how long the last update took, so long documents leave room to type.
  let lastCost = 0, shown = null; // shown: { doc, base } of what is on screen
  let groups = [];                // on screen: [{ key, nodes, line }] per top-level block
  function schedulePreview() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; renderPreview(false); }, Math.min(400, Math.max(30, lastCost * 2)));
  }
  ctx.previewUpToDate = () => !timer && !!shown && shown.doc === editor.getState().doc;

  /** Give every element with a data-line its line in the whole document. */
  function placeLines(g) {
    for (const n of g.nodes) {
      if (n.nodeType !== 1) continue;
      const els = n.hasAttribute('data-line') ? [n, ...n.querySelectorAll('[data-line]')] : n.querySelectorAll('[data-line]');
      for (const el of els) {
        if (el._rel === undefined) el._rel = +el.dataset.line; // as rendered: counted from the block's first line
        el.dataset.line = el._rel + g.line - 1;
      }
    }
  }

  async function renderPreview(force) {
    if (!right.open || right.tab !== 'preview') return;
    const doc = $('#preview-doc');
    const base = state.filePath ? fileUrl(dirname(state.filePath)) + '/' : '';
    const text = editor.getState().doc;
    if (!force && shown && shown.doc === text && shown.base === base) return; // nothing new
    const my = ++seq;
    const t0 = performance.now();
    const blocks = renderBlocks(text.toString(), { base });
    if (force || doc.childNodes.length !== groups.reduce((n, g) => n + g.nodes.length, 0)) { groups = []; doc.textContent = ''; }
    // blocks that did not change at the start and the end stay as they are
    let a = 0;
    while (a < groups.length && a < blocks.length && groups[a].key === blocks[a].key) a++;
    let b = 0;
    while (b < groups.length - a && b < blocks.length - a && groups[groups.length - 1 - b].key === blocks[blocks.length - 1 - b].key) b++;
    const stage = document.createElement('div');
    const fresh = blocks.slice(a, blocks.length - b).map((bl) => {
      const tpl = document.createElement('template');
      tpl.innerHTML = bl.html;
      const nodes = [...tpl.content.childNodes];
      stage.append(...nodes);
      return { key: bl.key, nodes, line: bl.line };
    });
    lastCost = performance.now() - t0;
    await renderMermaidIn(stage); // diagrams of new blocks only (others are already drawn)
    if (my !== seq) return;
    const t1 = performance.now();
    const top = pane.scrollTop;
    const before = groups[groups.length - b] ? groups[groups.length - b].nodes[0] : null;
    for (const g of groups.slice(a, groups.length - b)) for (const n of g.nodes) n.remove();
    for (const g of fresh) for (const n of g.nodes) doc.insertBefore(n, before);
    groups = [...groups.slice(0, a), ...fresh, ...groups.slice(groups.length - b)];
    groups.forEach((g, i) => { const line = blocks[i].line; if (g.line !== line || fresh.includes(g)) { g.line = line; placeLines(g); } });
    dressCode(fresh.flatMap((g) => g.nodes));
    pane.scrollTop = top;
    shown = { doc: text, base };
    lastCost += performance.now() - t1;
    sync();
    markHere();
  }

  // Code blocks in the final view get a copy button, and folded ones a bar to open them.
  // (Exports get neither: there the code is always shown in full.)
  const opened = new Set(); // source lines of folded blocks the reader has opened
  const moreLabel = (pre) => (pre.classList.contains('folded')
    ? t(`展开其余 ${+pre.dataset.fold - 5} 行`, `Show ${+pre.dataset.fold - 5} more lines`) : t('收起', 'Fold'));
  function dressCode(nodes) {
    const pres = [];
    for (const n of nodes) if (n.nodeType === 1) { if (n.matches('pre')) pres.push(n); pres.push(...n.querySelectorAll('pre')); }
    for (const pre of pres) {
      if (!pre.querySelector(':scope > code')) continue;
      const copy = document.createElement('button');
      copy.className = 'code-copy';
      copy.innerHTML = ICONS.copy;
      copy.dataset.tip = t('拷贝代码', 'Copy code');
      pre.append(copy);
      if (!pre.dataset.fold) continue;
      pre.classList.toggle('folded', !opened.has(pre.dataset.line));
      const more = document.createElement('button');
      more.className = 'code-more';
      more.innerHTML = `${ICONS.unfold}<span></span>`;
      more.lastChild.textContent = moreLabel(pre);
      pre.append(more);
    }
  }
  function codeClick(e) {
    const copy = e.target.closest('.code-copy'), more = e.target.closest('.code-more');
    if (!copy && !more) return false;
    const pre = (copy || more).closest('pre');
    if (copy) {
      api.copyText(pre.querySelector('code').textContent.replace(/\n$/, ''));
      copy.innerHTML = ICONS.check; copy.classList.add('done');
      setTimeout(() => { copy.innerHTML = ICONS.copy; copy.classList.remove('done'); }, 1200);
    } else {
      const folded = pre.classList.toggle('folded');
      if (folded) opened.delete(pre.dataset.line); else opened.add(pre.dataset.line);
      more.innerHTML = `${folded ? ICONS.unfold : ICONS.fold}<span></span>`;
      more.lastChild.textContent = moreLabel(pre);
    }
    return true;
  }

  // ---- keeping the two views in step ----
  // Every rendered block knows its source line (data-line). Pairs of
  // (editor y, preview y) for those lines are the anchors both directions interpolate between.
  const pane = $('#preview');
  const blocks = () => [...$('#preview-doc').querySelectorAll('[data-line]')];
  const topIn = (el) => el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  function anchors() {
    const sc = editor.scrollDOM, out = [[0, 0]];
    let lastLine = 0;
    for (const el of blocks()) {
      const line = +el.dataset.line;
      if (line <= lastLine) continue; // nested blocks starting on the same line
      lastLine = line;
      const e = editor.yOfLine(line), p = topIn(el);
      if (e > out[out.length - 1][0] && p >= out[out.length - 1][1]) out.push([e, p]);
    }
    out.push([Math.max(sc.scrollHeight, out[out.length - 1][0] + 1), Math.max(pane.scrollHeight, out[out.length - 1][1] + 1)]);
    return out;
  }
  const lerp = (pairs, v, a, b) => {
    let i = 0;
    while (i < pairs.length - 2 && pairs[i + 1][a] <= v) i++;
    const lo = pairs[i], hi = pairs[i + 1];
    const f = hi[a] > lo[a] ? (v - lo[a]) / (hi[a] - lo[a]) : 0;
    return lo[b] + Math.max(0, Math.min(1, f)) * (hi[b] - lo[b]);
  };
  // The view being scrolled by hand leads and the other follows. "By hand" on the
  // final view means a wheel/trackpad gesture or dragging its scrollbar; a pointer
  // merely resting there must not stop it following your typing.
  let wheelUntil = 0, dragging = false, quiet = 0;
  const previewLeads = () => dragging || Date.now() < wheelUntil;
  pane.addEventListener('wheel', () => { wheelUntil = Date.now() + 250; }, { passive: true });
  pane.addEventListener('pointerdown', () => { dragging = true; });
  addEventListener('pointerup', () => { dragging = false; });
  function sync() {
    if (!right.open || right.tab !== 'preview' || previewLeads() || Date.now() < quiet) return;
    const sc = editor.scrollDOM;
    const pMax = Math.max(0, pane.scrollHeight - pane.clientHeight), eMax = Math.max(1, sc.scrollHeight - sc.clientHeight);
    pane.scrollTop = sc.scrollTop >= eMax - 1 ? pMax : sc.scrollTop <= 0 ? 0 : Math.min(pMax, lerp(anchors(), sc.scrollTop + 24, 0, 1) - 24);
  }
  pane.addEventListener('scroll', () => {
    if (!previewLeads() || !right.open || right.tab !== 'preview') return;
    const sc = editor.scrollDOM;
    const pMax = Math.max(1, pane.scrollHeight - pane.clientHeight), eMax = Math.max(0, sc.scrollHeight - sc.clientHeight);
    sc.scrollTop = pane.scrollTop >= pMax - 1 ? eMax : pane.scrollTop <= 0 ? 0 : Math.min(eMax, lerp(anchors(), pane.scrollTop + 24, 1, 0) - 24);
  }, { passive: true });

  /** Mark the rendered block that holds the editor's caret. */
  function markHere() {
    if (!right.open || right.tab !== 'preview') return;
    const line = editor.caretLine();
    let best = null;
    for (const el of blocks()) { if (+el.dataset.line <= line) best = el; else break; }
    for (const el of $('#preview-doc').querySelectorAll('.here')) if (el !== best) { el.classList.remove('here'); if (!el.classList.length) el.removeAttribute('class'); }
    if (best) best.classList.add('here');
    placeBands(line, best);
  }
  let hereTimer;
  editor.onSelection(() => { clearTimeout(hereTimer); hereTimer = setTimeout(markHere, 80); });

  // ---- where the caret is, shown in the final view ----
  // Two bands behind the text: a faint one over the whole section the caret is in
  // (its heading down to the next heading of the same or a higher level) and a
  // brighter one over the caret's own block (paragraph, list item, table row…).
  // Both reach the same distance past the text column on either side. They are
  // drawn as separate layers, so the view's layout (and its scroll sync) never moves.
  const BAND_PAD = 14; // how far past the text column, each side (within the page's 24px padding)
  const secBand = document.createElement('div'), curBand = document.createElement('div');
  secBand.className = 'pv-band pv-sec'; curBand.className = 'pv-band pv-cur';
  pane.prepend(secBand, curBand);
  const hide = (b) => { b.hidden = true; };
  function place(band, top, bottom) {
    const doc = $('#preview-doc'), cs = getComputedStyle(doc);
    const pr = pane.getBoundingClientRect(), dr = doc.getBoundingClientRect();
    const left = dr.left - pr.left + pane.scrollLeft + parseFloat(cs.paddingLeft) - BAND_PAD;
    const width = dr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 2 * BAND_PAD;
    band.style.transform = `translate(${Math.round(left)}px, ${Math.round(top - pr.top + pane.scrollTop)}px)`;
    band.style.width = Math.round(width) + 'px';
    band.style.height = Math.max(0, Math.round(bottom - top)) + 'px';
    if (band.hidden) { band.style.transition = 'none'; band.hidden = false; void band.offsetHeight; band.style.transition = ''; } // appear in place, then glide
  }
  /** The part of `el` that is its own line(s): a list item without the list nested in it. */
  function ownRect(el) {
    if (el.tagName === 'LI') {
      const nested = [...el.children].find((c) => /^(UL|OL|PRE|BLOCKQUOTE|TABLE|DIV)$/.test(c.tagName));
      const before = nested && [...el.childNodes].slice(0, [...el.childNodes].indexOf(nested));
      if (nested && before.some((n) => n.nodeType === 1 || n.textContent.trim())) { // some text of its own before the nested list
        const r = document.createRange();
        r.setStart(el, 0); r.setEndBefore(nested);
        const rect = r.getBoundingClientRect();
        if (rect.height) return rect;
      }
    }
    return el.getBoundingClientRect();
  }
  function placeBands(line, best) {
    const doc = $('#preview-doc');
    if (!right.open || right.tab !== 'preview' || !editor.hasFocus()) { hide(secBand); hide(curBand); return; }
    // the section: top-level headings carry the structure
    const tops = [...doc.children].filter((el) => el.hasAttribute('data-line'));
    let head = null;
    for (const el of tops) { if (/^H[1-6]$/.test(el.tagName) && +el.dataset.line <= line) head = el; if (+el.dataset.line > line) break; }
    if (head) {
      const level = +head.tagName[1];
      let last = head;
      for (let el = head.nextElementSibling; el; el = el.nextElementSibling) {
        if (!el.hasAttribute('data-line')) continue; // the footnote list at the end is not part of a section
        if (/^H[1-6]$/.test(el.tagName) && +el.tagName[1] <= level) break;
        last = el;
      }
      const a = head.getBoundingClientRect(), b = last.getBoundingClientRect();
      place(secBand, a.top - 8, b.bottom + 8);
    } else hide(secBand);
    if (best) { const r = ownRect(best); place(curBand, r.top - 3, r.bottom + 3); } else hide(curBand);
  }
  // keep them in place when the view's layout changes (images or diagrams arriving, resizing)
  new ResizeObserver(() => { if (!secBand.hidden || !curBand.hidden) markHere(); }).observe($('#preview-doc'));
  editor.onFocus((focused) => { if (!focused) { hide(secBand); hide(curBand); } else markHere(); });

  pane.addEventListener('click', (e) => {
    if (codeClick(e)) return;
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('#')) {
        const target = $('#preview-doc').querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
        if (target && target.dataset.line) editor.jumpTo({ line: +target.dataset.line });
      } else api.openExternal(a.href);
      return;
    }
    if (String(getSelection())) return; // selecting text in the final view is not a jump
    const block = e.target.closest('[data-line]');
    if (!block) return;
    // jump to that block in the editor; the view stays where the reader is
    quiet = Date.now() + 200;
    editor.jumpTo({ line: +block.dataset.line });
    markHere();
  });

  return { setRight, toggle, refresh, sync, isOpen: () => right.open, tab: () => right.tab };
}
