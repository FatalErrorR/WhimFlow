// Mind map of the headings, and editing the document through it: double-click to
// rename, drag to move a whole section, Enter / Tab to add a sibling / child.
// Every edit rewrites the Markdown as a single undoable change.
import { $, t, basename, toast } from '../util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const COLORS = ['#c96442', '#6a8caf', '#7d8f69', '#bf8e4b', '#9a7aa0', '#5f9a96', '#b5727f'];

export function initMindmap(ctx) {
  const { editor, state } = ctx;
  const mm = { tx: 24, ty: 0, k: 1, collapsed: new Set(), fitted: false, nodes: [], bbox: null, activeIdx: -1, selected: null, justDragged: false };
  const visible = () => ctx.right.isOpen() && ctx.right.tab() === 'mindmap';
  const measure = document.createElement('canvas').getContext('2d');
  const cssFont = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || 'sans-serif';
  const textWidth = (s, font) => { measure.font = font; return measure.measureText(s).width; };
  const svgEl = (tag, attrs, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.append(e);
    return e;
  };

  function buildTree() {
    const title = state.filePath ? basename(state.filePath).replace(/\.[^.]+$/, '') : t('未命名', 'Untitled');
    let root = { text: title, idx: -1, children: [], key: '~' };
    const stack = [{ node: root, level: 0 }];
    editor.headings().forEach((h, i) => {
      if (!h.text) return;
      while (stack[stack.length - 1].level >= h.level) stack.pop();
      const parent = stack[stack.length - 1].node;
      const node = { text: h.text, idx: i, children: [], key: `${parent.key}/${parent.children.length}:${h.text}` };
      parent.children.push(node);
      stack.push({ node, level: h.level });
    });
    if (root.children.length === 1) root = root.children[0];
    return root;
  }
  function layout(root) {
    const nodes = [];
    let cursor = 0;
    const ROW = 31, GAP = 40;
    const walk = (n, depth, x, color) => {
      n.label = n.text.length > 42 ? n.text.slice(0, 41) + '…' : n.text;
      n.depth = depth; n.color = color; n.h = depth === 0 ? 36 : 26;
      n.w = Math.ceil(textWidth(n.label, depth === 0 ? '500 16px ' + cssFont('--serif-font') : (depth === 1 ? '500 ' : '') + '13px ' + cssFont('--ui-font'))) + (depth === 0 ? 32 : 22);
      n.x = x;
      n.folded = mm.collapsed.has(n.key) && n.children.length > 0;
      nodes.push(n);
      if (n.folded || !n.children.length) { n.y = cursor; cursor += ROW; }
      else {
        n.children.forEach((c, i) => walk(c, depth + 1, x + n.w + GAP, depth === 0 ? COLORS[i % COLORS.length] : color));
        n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
      }
    };
    walk(root, 0, 0, 'var(--accent)');
    return nodes;
  }
  const countDesc = (n) => n.children.reduce((a, c) => a + 1 + countDesc(c), 0);

  function render() {
    if (!visible()) return;
    const links = $('#mm-links'), nodesG = $('#mm-nodes');
    links.textContent = ''; nodesG.textContent = '';
    const empty = !editor.headings().some((h) => h.text);
    $('#mm-empty').hidden = !empty;
    $('#mm-empty').textContent = t('加上几个标题，思路就会在这里展开。', 'Add a few headings and your thinking will unfold here.');
    if (empty) { mm.nodes = []; mm.bbox = null; return; }
    const nodes = layout(buildTree());
    mm.nodes = nodes;
    let minY = Infinity, maxY = -Infinity, maxX = 0;
    for (const n of nodes) {
      minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2); maxX = Math.max(maxX, n.x + n.w + 16);
      if (!n.folded) for (const c of n.children) {
        const x1 = n.x + n.w, x2 = c.x, mx = (x1 + x2) / 2;
        const y1 = n.depth === 0 ? n.y : n.y + n.h / 2, y2 = c.y + c.h / 2;
        svgEl('path', { class: 'mm-link', pathLength: 1, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, stroke: c.color }, links);
      }
      const g = svgEl('g', { class: `mm-node d${Math.min(n.depth, 3)}${n.depth === 0 ? ' root' : ''}`, transform: `translate(${n.x},${n.y - n.h / 2})` }, nodesG);
      g.dataset.idx = n.idx;
      svgEl('rect', { width: n.w, height: n.h, rx: n.depth === 0 ? 18 : 7 }, g);
      if (n.depth > 0) svgEl('line', { x1: 0, x2: n.w, y1: n.h, y2: n.h, stroke: n.color }, g);
      svgEl('text', { x: n.depth === 0 ? 16 : 11, y: n.h / 2 }, g).textContent = n.label;
      svgEl('title', {}, g).textContent = n.text;
      if (n.idx === mm.selected) g.classList.add('selected');
      g.addEventListener('click', () => { if (mm.justDragged) return; select(n.idx); editor.scrollToHeading(n.idx); });
      g.addEventListener('pointerdown', (e) => nodeDown(e, n, g));
      g.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(n.idx); });
      if (n.children.length) {
        const tg = svgEl('g', { class: 'mm-toggle' + (n.folded ? ' folded' : ''), transform: `translate(${n.x + n.w + 10},${n.depth === 0 ? n.y : n.y + n.h / 2})` }, nodesG);
        svgEl('circle', { r: 6.5, stroke: n.color }, tg);
        svgEl('text', {}, tg).textContent = n.folded ? countDesc(n) : '−';
        tg.addEventListener('click', (e) => {
          e.stopPropagation();
          mm.collapsed.has(n.key) ? mm.collapsed.delete(n.key) : mm.collapsed.add(n.key);
          render();
        });
      }
    }
    mm.bbox = { x: 0, y: minY, w: maxX, h: maxY - minY };
    if (!mm.fitted) {
      fit(false);
      const svg = $('#mm-svg');
      svg.classList.add('mm-intro');
      clearTimeout(mm.introTimer);
      mm.introTimer = setTimeout(() => svg.classList.remove('mm-intro'), 900);
    } else apply(false);
    highlight(mm.activeIdx);
  }
  function apply(animate) {
    $('#mm-svg').classList.toggle('animate', !!animate);
    $('#mm-root').setAttribute('transform', `translate(${mm.tx},${mm.ty}) scale(${mm.k})`);
  }
  function fit(animate) {
    const box = $('#mindmap').getBoundingClientRect();
    if (!mm.bbox || !box.width) return;
    const pad = 28;
    mm.k = Math.max(0.25, Math.min(1.3, (box.width - pad * 2) / mm.bbox.w, (box.height - pad * 2) / mm.bbox.h));
    mm.tx = Math.max(pad, (box.width - mm.bbox.w * mm.k) / 2);
    mm.ty = box.height / 2 - (mm.bbox.y + mm.bbox.h / 2) * mm.k;
    mm.fitted = true;
    apply(animate);
  }
  function zoom(f, cx, cy) {
    const box = $('#mindmap').getBoundingClientRect();
    if (cx == null) { cx = box.width / 2; cy = box.height / 2; }
    const k = Math.max(0.2, Math.min(3, mm.k * f));
    mm.tx = cx - (cx - mm.tx) * (k / mm.k); mm.ty = cy - (cy - mm.ty) * (k / mm.k); mm.k = k;
    apply(false);
  }
  function highlight(idx) {
    mm.activeIdx = idx;
    if (!visible()) return;
    const shown = new Set(mm.nodes.map((n) => n.idx));
    let target = idx;
    while (target > 0 && !shown.has(target)) target--;
    document.querySelectorAll('.mm-node').forEach((g) => g.classList.toggle('active', +g.dataset.idx === target));
  }
  function select(idx) {
    mm.selected = idx;
    document.querySelectorAll('.mm-node').forEach((g) => g.classList.toggle('selected', +g.dataset.idx === idx));
  }

  // ---------- editing the document through the map ----------
  function structure() {
    const hs = editor.headings();
    if (hs.some((h) => !h.top || h.setext)) {
      toast(t('这篇文档的标题写在引用或列表里，暂时不能在导图里调整', 'Headings inside quotes or lists can’t be restructured from the map'));
      return null;
    }
    const lines = editor.getValue().split('\n');
    const heads = hs.map((h) => ({ line: h.line - 1, level: h.level, raw: h.raw }));
    const end = (k) => { for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= heads[k].level) return heads[j].line; return lines.length; };
    return { lines, heads, end };
  }
  // insert lines with exactly one blank line on each side
  function insertLines(arr, at, block) {
    while (block.length && !block[block.length - 1].trim()) block.pop();
    const pre = at > 0 && arr[at - 1].trim() ? [''] : [];
    const post = at < arr.length && arr[at].trim() ? [''] : [];
    arr.splice(at, 0, ...pre, ...block, ...post);
    return at + pre.length;
  }
  function commit(lines, then) {
    editor.replaceAll(lines.join('\n'), 'input.structure');
    ctx.refreshViews();
    mm.fitted = false;
    render();
    if (then) then();
  }
  function rename(idx, text) {
    const s = structure(); if (!s || !s.heads[idx]) return;
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || text === s.heads[idx].raw) return;
    s.lines[s.heads[idx].line] = '#'.repeat(s.heads[idx].level) + ' ' + text;
    commit(s.lines);
  }
  function startRename(idx) {
    const n = mm.nodes.find((x) => x.idx === idx), inp = $('#mm-rename');
    if (idx < 0) { toast(t('中心节点是文件名，请在文件树里重命名', 'The centre is the file name; rename it in the file tree')); return; }
    const s = structure();
    if (!n || !s || !s.heads[idx]) return;
    inp.value = s.heads[idx].raw;
    inp.style.left = n.x * mm.k + mm.tx + 'px';
    inp.style.top = (n.y - n.h / 2) * mm.k + mm.ty + 'px';
    inp.style.width = Math.max(150, n.w * mm.k + 40) + 'px';
    inp.style.height = Math.max(26, n.h * mm.k) + 'px';
    inp.hidden = false; inp.focus(); inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true; inp.hidden = true; inp.onkeydown = inp.onblur = null;
      if (ok) rename(idx, inp.value);
      $('#mm-svg').focus();
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  }
  function addHeading(idx, asChild) {
    const s = structure(); if (!s) return;
    let level, at;
    if (idx < 0 || !s.heads[idx]) { level = s.heads.length ? Math.min(...s.heads.map((h) => h.level)) : 1; at = s.lines.length; }
    else { level = Math.min(6, s.heads[idx].level + (asChild ? 1 : 0)); at = s.end(idx); }
    const pos = s.heads.filter((h) => h.line < at).length;
    insertLines(s.lines, at, ['#'.repeat(level) + ' ' + t('新标题', 'New heading')]);
    commit(s.lines, () => { select(pos); startRename(pos); });
  }
  function moveSection(fromIdx, toIdx, mode) {
    const s = structure(); if (!s || !s.heads[fromIdx]) return;
    const a = fromIdx, b = toIdx;
    if (b >= 0 && !s.heads[b]) return;
    const aStart = s.heads[a].line, aEnd = s.end(a);
    if (b >= 0 && s.heads[b].line >= aStart && s.heads[b].line < aEnd) return; // into itself
    const minLevel = Math.min(...s.heads.map((h) => h.level));
    const newLevel = b < 0 ? minLevel : mode === 'child' ? s.heads[b].level + 1 : s.heads[b].level;
    const delta = newLevel - s.heads[a].level;
    const block = s.lines.slice(aStart, aEnd);
    for (const h of s.heads) if (h.line >= aStart && h.line < aEnd) {
      block[h.line - aStart] = '#'.repeat(Math.max(1, Math.min(6, h.level + delta))) + ' ' + h.raw;
    }
    let at = b < 0 ? s.lines.length : mode === 'before' ? s.heads[b].line : s.end(b);
    if (at >= aStart && at <= aEnd && delta === 0) return; // same place, same level
    const rest = s.lines.slice(0, aStart).concat(s.lines.slice(aEnd));
    if (aStart > 0 && aStart < rest.length && !rest[aStart - 1].trim() && !rest[aStart].trim()) rest.splice(aStart, 1);
    const removed = s.lines.length - rest.length;
    if (at > aStart) at -= removed;
    insertLines(rest, Math.max(0, Math.min(at, rest.length)), block);
    mm.selected = null;
    commit(rest);
  }
  function nodeDown(e, n, g) {
    if (e.button !== 0 || n.idx < 0) return;
    const svg = $('#mm-svg');
    svg.focus();
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, ghost = null, drop = null;
    const marker = (d) => {
      document.querySelectorAll('.mm-node.drop').forEach((x) => x.classList.remove('drop'));
      const line = $('#mm-dropline'); if (line) line.remove();
      drop = d;
      if (!d) return;
      if (d.mode === 'child') { const tg = document.querySelector(`.mm-node[data-idx="${d.node.idx}"]`); if (tg) tg.classList.add('drop'); }
      else { const y = d.node.y + (d.mode === 'before' ? -18 : 18); svgEl('line', { id: 'mm-dropline', x1: d.node.x, x2: d.node.x + Math.max(60, d.node.w), y1: y, y2: y }, $('#mm-nodes')); }
    };
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true; g.classList.add('lifting'); svg.classList.add('mm-dragging');
        ghost = document.createElement('div'); ghost.id = 'mm-ghost'; ghost.textContent = n.label; $('#mindmap').append(ghost);
      }
      const box = svg.getBoundingClientRect();
      ghost.style.transform = `translate(${ev.clientX - box.left + 12}px, ${ev.clientY - box.top + 10}px)`;
      const px = (ev.clientX - box.left - mm.tx) / mm.k, py = (ev.clientY - box.top - mm.ty) / mm.k;
      let best = null;
      for (const c of mm.nodes) {
        if (c === n || c.key.startsWith(n.key + '/')) continue;
        if (px < c.x - 16 || px > c.x + c.w + 40) continue;
        const dy = py - c.y;
        if (px <= c.x + c.w + 8 && Math.abs(dy) <= c.h / 2 - 3) { best = { node: c, mode: 'child' }; break; }
        if (c.depth > 0 && Math.abs(dy) < 28 && (!best || Math.abs(dy) < best.d)) best = { node: c, mode: dy < 0 ? 'before' : 'after', d: Math.abs(dy) };
      }
      marker(best);
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      if (!dragging) return;
      const d = drop;
      marker(null);
      if (ghost) ghost.remove();
      g.classList.remove('lifting'); svg.classList.remove('mm-dragging');
      mm.justDragged = true; setTimeout(() => { mm.justDragged = false; }, 50);
      if (d) moveSection(n.idx, d.node.idx, d.mode);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }

  // ---------- pan, zoom, keys ----------
  const svg = $('#mm-svg');
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mm-node, .mm-toggle')) return;
    drag = { x: e.clientX, y: e.clientY, tx: mm.tx, ty: mm.ty };
    svg.setPointerCapture(e.pointerId); svg.classList.add('panning'); svg.classList.remove('animate');
  });
  svg.addEventListener('pointermove', (e) => { if (drag) { mm.tx = drag.tx + e.clientX - drag.x; mm.ty = drag.ty + e.clientY - drag.y; apply(false); } });
  const end = () => { drag = null; svg.classList.remove('panning'); };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const b = svg.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoom(Math.exp(-e.deltaY * 0.01), e.clientX - b.left, e.clientY - b.top);
    else { mm.tx -= e.deltaX; mm.ty -= e.deltaY; apply(false); }
  }, { passive: false });
  svg.addEventListener('dblclick', (e) => { if (!e.target.closest('.mm-node, .mm-toggle')) fit(true); });
  svg.addEventListener('keydown', (e) => {
    if (mm.selected == null || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = mm.nodes.find((x) => x.idx === mm.selected);
    if (!n) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addHeading(n.idx, n.depth === 0); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); addHeading(n.idx, true); }
    else if (e.key === 'F2') { e.preventDefault(); startRename(n.idx); }
  });
  $('#mm-hint').textContent = t('双击改名 · 拖动重组 · ↵ 同级 · ⇥ 子级 · ⌘Z 撤销', 'Double-click to rename · drag to move · ↵ sibling · ⇥ child · ⌘Z undo');
  new ResizeObserver(() => { if (visible() && mm.bbox) fit(false); }).observe($('#mindmap'));

  return { render, fit, highlight, reset: () => { mm.fitted = false; }, bbox: () => mm.bbox, apply };
}
