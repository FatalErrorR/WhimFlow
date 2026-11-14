// Small shared helpers: DOM, paths, i18n, toast, prompt, hover tips, word counts.
export const $ = (s) => document.querySelector(s);
export { dirname, basename, fileUrl } from './paths.js';

export const i18n = { zh: false };
export const t = (zh, en) => (i18n.zh ? zh : en);

const svgIcon = (d) => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  files: svgIcon('<path d="M1.8 4h4.2l1.4 1.8h6.8v7.2H1.8z"/>'),
  outline: svgIcon('<path d="M2.5 4h11M5 8h8.5M5 12h8.5"/>'),
  mindmap: svgIcon('<circle cx="3.5" cy="8" r="1.8"/><circle cx="12.5" cy="3.5" r="1.5"/><circle cx="12.5" cy="12.5" r="1.5"/><path d="M5.2 7.3C8 6.5 8 3.5 11 3.5M5.2 8.7C8 9.5 8 12.5 11 12.5"/>'),
  doc: svgIcon('<rect x="3" y="1.8" width="10" height="12.4" rx="1.5"/><path d="M5.5 5.2h5M5.5 8h5M5.5 10.8h3"/>'),
  sidebar: svgIcon('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11"/>'),
  panel: svgIcon('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M10 2.5v11"/>'),
  search: svgIcon('<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 14 14"/>'),
  history: svgIcon('<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8M2.5 2.6v2.6h2.6"/><path d="M8 5v3.2l2 1.3"/>'),
  copy: svgIcon('<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>'),
  check: svgIcon('<path d="m3.5 8.5 3 3 6-7"/>'),
  unfold: svgIcon('<path d="m4.5 3.5 3.5 3 3.5-3M4.5 12.5l3.5-3 3.5 3"/>'),
  fold: svgIcon('<path d="m4.5 6.5 3.5-3 3.5 3M4.5 9.5l3.5 3 3.5-3"/>'),
  link: svgIcon('<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),
};

let toastTimer;
/** A short message at the bottom. `ms` = 0 keeps it up until hideToast() or the next toast. */
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
export const hideToast = () => { clearTimeout(toastTimer); $('#toast').hidden = true; };

export function prompt(title, value) {
  return new Promise((resolve) => {
    const m = $('#modal'), inp = $('#modal-input');
    $('#modal-title').textContent = title;
    inp.value = value || '';
    m.hidden = false;
    inp.focus();
    const dot = inp.value.lastIndexOf('.');
    inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
    const done = (v) => { m.hidden = true; inp.onkeydown = null; resolve(v); };
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(inp.value.trim());
      else if (e.key === 'Escape') done(null);
    };
    $('#modal-ok').onclick = () => done(inp.value.trim());
    $('#modal-cancel').onclick = () => done(null);
  });
}

/** Hover tips for anything with data-tip (or title, which is converted). */
export function initTips() {
  const tip = $('#tip');
  let timer = null, cur = null;
  const hide = () => { clearTimeout(timer); cur = null; tip.hidden = true; };
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip], [title]');
    if (el === cur) return;
    hide();
    if (!el) return;
    if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
    if (!el.dataset.tip) return;
    cur = el;
    timer = setTimeout(() => {
      if (!el.isConnected) return;
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2)) + 'px';
      tip.style.top = (r.top < h + 14 ? r.bottom + 7 : r.top - h - 7) + 'px';
    }, 380);
  });
  for (const ev of ['mousedown', 'keydown', 'scroll']) document.addEventListener(ev, hide, true);
  document.addEventListener('mouseleave', hide);
}

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g;
export function countText(s) {
  const cjk = (s.match(CJK) || []).length;
  const latin = (s.replace(CJK, ' ').match(/[A-Za-z0-9À-ɏ_'’-]+/g) || []).length;
  return { words: cjk + latin, chars: s.replace(/\s/g, '').length };
}
export function plainMarkdown(md) {
  return md
    .replace(/^(```|~~~).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]( \[[ xX]\])?|\d+\.)\s+/gm, '')
    .replace(/[*_~`=|#>$]/g, '');
}

/** A small context menu. items: { label, run, hint?, danger?, disabled? } or '-'. */
export function showMenu(items, x, y) {
  let menu = document.getElementById('ctxmenu');
  if (menu) menu.remove();
  menu = document.createElement('div');
  menu.id = 'ctxmenu';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; menu.append(s); continue; }
    const b = document.createElement('button');
    b.className = 'item' + (it.danger ? ' danger' : '');
    b.disabled = !!it.disabled;
    const l = document.createElement('span'); l.textContent = it.label;
    const h = document.createElement('span'); h.className = 'hint'; h.textContent = it.hint || '';
    b.append(l, h);
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => { close(); it.run(); };
    menu.append(b);
  }
  document.body.append(menu);
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
  menu.style.top = (y + h > innerHeight - 8 ? Math.max(8, y - h) : y) + 'px';
  const close = () => { menu.remove(); removeEventListener('mousedown', outside, true); removeEventListener('keydown', esc, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  setTimeout(() => { addEventListener('mousedown', outside, true); addEventListener('keydown', esc, true); });
  return close;
}
