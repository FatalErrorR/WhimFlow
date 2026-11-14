// The three islands: the one you work in is raised; each can be dragged sideways
// by the dot in its top-right corner to reorder them; side islands resize from the edge that
// faces the editor.
import { $, t } from '../util.js';

const EASE = 'cubic-bezier(.3,.9,.3,1)';

export function initIslands(ctx) {
  const els = { side: $('#sidebar'), main: $('#main'), right: $('#right') };
  let order = ['side', 'main', 'right'];
  try {
    const saved = JSON.parse(localStorage.getItem('mf-order') || 'null');
    if (Array.isArray(saved) && saved.length === 3 && order.every((n) => saved.includes(n))) order = saved;
  } catch (_) { /* first run */ }

  // ---------- which island is raised ----------
  function setIsland(name) {
    if (document.body.dataset.island === name) return;
    document.body.dataset.island = name;
    ctx.editor.setIsland(name === 'main' && !document.body.classList.contains('has-welcome'));
  }
  // The side column is not an island itself: it holds small ones (files, outline, search).
  const SIDE = ['files', 'outline', 'search'];
  const sideIsland = () => (SIDE.includes(document.body.dataset.island) ? document.body.dataset.island : document.body.dataset.tab === 'search' ? 'search' : 'files');
  const regionOf = (el) => {
    if (!el || !el.closest) return null;
    if (el.closest('.resizer')) return null; // the boundary between two islands belongs to neither: resizing keeps the selection
    const card = el.closest('.side-card');
    if (card) return card.dataset.island;
    const r = el.closest('#sidebar, #main, #right');
    return r ? (r.id === 'sidebar' ? sideIsland() : r.id) : null;
  };
  // A click decides. Focus moves count too (keyboard, commands), except right after
  // a click elsewhere: a re-focus that follows a render must not steal the island.
  let lastPick = { region: null, at: 0 };
  document.addEventListener('mousedown', (e) => { const r = regionOf(e.target); if (r) { lastPick = { region: r, at: Date.now() }; setIsland(r); } }, true);
  document.addEventListener('focusin', (e) => {
    const r = regionOf(e.target);
    if (!r || (r !== lastPick.region && Date.now() - lastPick.at < 1200)) return;
    setIsland(r);
  });

  // ---------- order ----------
  const shown = (n) => getComputedStyle(els[n]).display !== 'none';
  function applyOrder(animate, except) {
    const before = {};
    if (animate) for (const n in els) before[n] = els[n].getBoundingClientRect().left;
    const vis = order.filter(shown);
    order.forEach((n, i) => {
      els[n].style.order = i;
      els[n].classList.toggle('first-island', vis[0] === n);
      els[n].classList.toggle('rz-start', i > order.indexOf('main'));
    });
    if (animate) for (const n in els) {
      if (n === except || !shown(n)) continue;
      const d = before[n] - els[n].getBoundingClientRect().left;
      if (Math.abs(d) > 1) els[n].animate([{ transform: `translateX(${d}px)` }, { transform: 'none' }], { duration: 340, easing: EASE });
    }
    try { localStorage.setItem('mf-order', JSON.stringify(order)); } catch (_) { /* private mode */ }
  }
  function move(name, dir) {
    const vis = order.filter(shown), i = vis.indexOf(name), other = vis[i + dir];
    if (i < 0 || !other) return false;
    const a = order.indexOf(name), b = order.indexOf(other);
    [order[a], order[b]] = [order[b], order[a]];
    return true;
  }

  for (const name in els) {
    const el = els[name];
    const grip = document.createElement('div');
    grip.className = 'island-grip';
    grip.dataset.tip = t('拖动以左右调换位置', 'Drag to rearrange');
    el.append(grip);
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      setIsland(name === 'side' ? sideIsland() : name);
      const startX = e.clientX, origin = el.getBoundingClientRect().left;
      let layoutLeft = origin, lastX = startX;
      grip.setPointerCapture(e.pointerId);
      el.classList.add('dragging'); document.body.classList.add('island-dragging');
      const place = (visLeft) => { el.style.transform = `translateX(${visLeft - layoutLeft}px) scale(1.012)`; };
      const onMove = (ev) => {
        const visLeft = origin + ev.clientX - startX, w = el.offsetWidth;
        const dir = Math.sign(ev.clientX - lastX);
        lastX = ev.clientX;
        place(visLeft);
        if (!dir) return;
        const vis = order.filter(shown), other = vis[vis.indexOf(name) + dir];
        if (!other) return;
        const o = els[other], ol = o.offsetLeft, ow = o.offsetWidth, need = Math.min(w, ow) / 2;
        const passed = dir > 0 ? visLeft + w > ol + need : visLeft < ol + ow - need;
        if (!passed || !move(name, dir)) return;
        applyOrder(true, name);
        el.style.transform = '';
        layoutLeft = el.getBoundingClientRect().left;
        place(visLeft);
      };
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove); grip.removeEventListener('pointerup', onUp); grip.removeEventListener('pointercancel', onUp);
        const from = el.getBoundingClientRect().left;
        el.style.transform = '';
        const to = el.getBoundingClientRect().left;
        document.body.classList.remove('island-dragging');
        const a = el.animate([{ transform: `translateX(${from - to}px) scale(1.012)` }, { transform: 'none' }], { duration: 340, easing: EASE });
        a.onfinish = a.oncancel = () => el.classList.remove('dragging');
      };
      grip.addEventListener('pointermove', onMove); grip.addEventListener('pointerup', onUp); grip.addEventListener('pointercancel', onUp);
    });
  }

  // ---------- resizing side islands ----------
  // The handle covers the gap between a side island and its neighbour (see .resizer in
  // app.css). Dragging it changes the width without changing which island is selected.
  const resizer = (handle, panel, cssVar, min, max) => {
    handle.onmousedown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startW = panel.offsetWidth, sign = panel.classList.contains('rz-start') ? -1 : 1;
      handle.classList.add('active'); document.body.classList.add('resizing');
      const onMove = (ev) => document.documentElement.style.setProperty(cssVar, Math.min(max(), Math.max(min, startW + sign * (ev.clientX - startX))) + 'px');
      const onUp = () => {
        removeEventListener('mousemove', onMove); removeEventListener('mouseup', onUp);
        handle.classList.remove('active'); document.body.classList.remove('resizing');
      };
      addEventListener('mousemove', onMove); addEventListener('mouseup', onUp);
    };
  };
  resizer($('#side-resizer'), els.side, '--side-w', 180, () => 520);
  resizer($('#right-resizer'), els.right, '--right-w', 260, () => innerWidth * 0.7);

  return {
    setIsland,
    current: () => document.body.dataset.island,
    applyOrder,
    moveCurrent(dir) { const cur = document.body.dataset.island || 'main'; if (move(cur === 'main' || cur === 'right' ? cur : 'side', dir)) applyOrder(true); },
  };
}
