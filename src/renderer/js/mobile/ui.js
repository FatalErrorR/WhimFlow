// The iPhone / iPad interface around the shared editor (see the mock-up): a document
// library instead of the sidebar, a top bar with 写 / 看 (write / read), a formatting
// bar above the keyboard, and a sheet from the bottom for the outline and the rest.
// On an iPad that is wide enough, the desktop's three islands are used as they are.
import { t, toast, showMenu } from '../util.js';
import { App } from '@capacitor/app';
import { Keyboard } from '@capacitor/keyboard';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Capacitor } from '@capacitor/core';
import { syncText } from '../ui/settings.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (d, w = 22) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'), more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 26), folder: svg('<path d="M3 7.5h6l2 2.3h10V19H3z"/>'), search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', 18),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
  share: svg('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v8h14v-8"/>'), find: svg('<circle cx="10.5" cy="10.5" r="5.5"/><path d="M19 19l-4.2-4.2"/>'),
  hist: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/><path d="M12 8v4.5l3 2"/>'), theme: svg('<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/>'),
  kbd: svg('<rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 10h1M11 10h1M15 10h1M8 13.5h8"/><path d="M10 20l2 1.5 2-1.5"/>', 20),
  doc: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>', 20), sync: svg('<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/>', 18), cross: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
};
const THEMES = ['daylight', 'paper', 'mint', 'slate', 'midnight'];

export function initMobile({ run, state, editor, ctx }, hooks) {
  const api = window.api, M = api.mobile, body = document.body;
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // ---------- phone or tablet ----------
  const wide = matchMedia('(min-width: 820px)');
  function layout() {
    body.classList.toggle('m-tablet', wide.matches);
    body.classList.toggle('m-phone', !wide.matches);
    if (wide.matches) { body.classList.remove('m-read'); ctx.sidebar.setSidebar(true, 'files'); }
    else { ctx.sidebar.setSidebar(false); if (!body.classList.contains('m-read')) ctx.right.setRight(false); }
  }
  wide.addEventListener('change', () => { layout(); if (wide.matches && mapOn) dockMap(false, true); else if (!wide.matches && mapWanted()) dockMap(true); });

  // ---------- top bar ----------
  const bar = el('header', '', `
    <button class="m-btn m-back" aria-label="${t('文档库', 'Library')}">${I.back}</button>
    <button class="m-title"><b></b><em></em></button>
    <div class="m-seg"><button data-mode="write">${t('写', 'Write')}</button><button data-mode="read">${t('看', 'Read')}</button></div>
    <button class="m-btn m-more" aria-label="${t('更多', 'More')}">${I.more}</button>`);
  bar.id = 'm-bar';
  body.prepend(bar);
  const titleEl = bar.querySelector('.m-title b'), stateEl = bar.querySelector('.m-title em');
  function updateBar() {
    titleEl.textContent = (ctx.docs.name() || '').replace(/\.(md|markdown)$/i, '');
    const d = ctx.docs.active();
    stateEl.textContent = d && d.conflict ? t('与磁盘冲突', 'Conflict') : d && d.dirty ? t('编辑中', 'Editing') : d && d.filePath ? t('已保存', 'Saved') : t('新文档', 'New');
    stateEl.classList.toggle('warn', !!(d && d.conflict));
  }
  new MutationObserver(updateBar).observe(document.querySelector('#title-state'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(updateBar).observe(document.querySelector('#title'), { childList: true, characterData: true, subtree: true });
  bar.querySelector('.m-back').onclick = () => showLibrary();
  bar.querySelector('.m-more').onclick = () => openSheet();
  bar.querySelector('.m-title').onclick = () => renameActive();
  bar.querySelectorAll('.m-seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

  // ---------- write / read ----------
  function setMode(mode, tab = 'preview') {
    const read = mode === 'read';
    if (read) { editor.view.contentDOM.blur(); ctx.right.setRight(true, tab); }
    else if (!wide.matches) ctx.right.setRight(false);
    body.classList.toggle('m-read', read && !wide.matches);
    bar.querySelectorAll('.m-seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (read ? 'read' : 'write')));
    if (!read) editor.focus();
  }
  // a tap on a paragraph of the final view goes back to writing, at that paragraph
  document.querySelector('#preview').addEventListener('click', (e) => {
    if (wide.matches || e.target.closest('a, .code-copy, .code-more')) return;
    if (e.target.closest('[data-line]')) setTimeout(() => setMode('write'), 0);
  });

  // ---------- the formatting bar above the keyboard ----------
  const tools = el('div', '', '');
  tools.id = 'm-tools';
  const T = [
    ['H', () => { const ln = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text; const lvl = (/^(#{1,6})\s/.exec(ln) || [])[1]; editor.run('heading', !lvl ? 2 : lvl.length === 2 ? 3 : 0); }, 'h'],
    ['B', () => run('bold'), 'b'], ['I', () => run('italic'), 'i'], ['S', () => run('strike'), 's'],
    ['|'],
    ['•', () => run('list')], ['1.', () => run('ordered-list')], ['☐', () => run('check')], ['❝', () => run('quote')],
    ['|'],
    ['</>', () => run('code-block'), 'mono'], ['`', () => run('inline-code'), 'mono'], ['∑', () => run('inline-math')], ['⊞', () => run('table')], ['🔗', () => run('link')], ['🖼', () => run('image')],
    ['|'],
    ['↶', () => run('undo')], ['↷', () => run('redo')],
  ];
  const scroller = el('div', 'm-tools-scroll');
  for (const [label, fn, cls] of T) {
    if (label === '|') { scroller.append(el('span', 'm-sep')); continue; }
    const b = el('button', 'm-k' + (cls ? ' ' + cls : ''));
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); }); // keep the keyboard up
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    scroller.append(b);
  }
  const hide = el('button', 'm-k m-hide', I.kbd);
  hide.addEventListener('pointerdown', (e) => e.preventDefault());
  hide.onclick = () => editor.view.contentDOM.blur();
  tools.append(scroller, hide);
  body.append(tools);
  // keyboard height: from the native keyboard (iOS), else from the visual viewport
  const setKb = (h) => { document.documentElement.style.setProperty('--kb', Math.max(0, Math.round(h)) + 'px'); };
  const native = Capacitor.isNativePlatform();
  if (native) {
    Keyboard.addListener('keyboardWillShow', (i) => { setKb(i.keyboardHeight); body.classList.add('m-kb'); }).catch(() => {});
    Keyboard.addListener('keyboardWillHide', () => { setKb(0); body.classList.remove('m-kb'); }).catch(() => {});
  }
  if (window.visualViewport) {
    const vv = () => { const h = innerHeight - visualViewport.height - visualViewport.offsetTop; if (h > 60) { setKb(h); body.classList.add('m-kb'); } };
    visualViewport.addEventListener('resize', vv);
  }
  editor.onFocus((f) => body.classList.toggle('m-editing', f));

  // ---------- the sheet from the bottom: outline, mind map, history, and the rest ----------
  const sheet = el('div', '', `<div class="m-dim"></div><section class="m-sheet">
    <div class="m-grab"></div>
    <div class="m-tabs"><button data-tab="outline" class="on">${t('大纲', 'Outline')}</button><button data-tab="mindmap">${t('思维导图', 'Mind map')}</button><button data-tab="history">${t('历史版本', 'History')}</button></div>
    <div class="m-outline"></div>
    <div class="m-actions">
      <button data-act="find"><i>${I.find}</i>${t('查找替换', 'Find')}</button>
      <button data-act="share"><i>${I.share}</i>${t('分享', 'Share')}</button>
      <button data-act="theme"><i>${I.theme}</i>${t('主题', 'Theme')}</button>
      <button data-act="settings"><i>${I.gear}</i>${t('设置', 'Settings')}</button>
    </div></section>`);
  sheet.id = 'm-sheetwrap';
  sheet.hidden = true;
  body.append(sheet);
  const closeSheet = () => { sheet.hidden = true; };
  sheet.querySelector('.m-dim').onclick = closeSheet;
  function openSheet() {
    const box = sheet.querySelector('.m-outline');
    box.textContent = '';
    const hs = editor.headings();
    const here = editor.headingIndexAtScroll();
    if (!hs.length) box.append(el('div', 'm-empty', esc(t('文档里还没有标题', 'No headings yet'))));
    const min = Math.min(...hs.map((h) => h.level));
    hs.forEach((h, i) => {
      const b = el('button', 'm-ol' + (i === here ? ' on' : ''));
      b.style.paddingLeft = 14 + (h.level - min) * 16 + 'px';
      b.textContent = h.text || t('（空标题）', '(empty)');
      b.onclick = () => { closeSheet(); setMode('write'); editor.scrollToHeading(i); };
      box.append(b);
    });
    editor.view.contentDOM.blur();
    sheet.hidden = false;
  }
  sheet.querySelectorAll('.m-tabs button').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.tab === 'outline') return;
      closeSheet();
      if (b.dataset.tab === 'mindmap' && !wide.matches) { dockMap(true); return; } // a phone: under the text
      setMode('read', b.dataset.tab);
      if (wide.matches) ctx.right.setRight(true, b.dataset.tab);
    };
  });
  sheet.querySelectorAll('.m-actions button').forEach((b) => {
    b.onclick = async () => {
      closeSheet();
      const a = b.dataset.act;
      if (a === 'find') { setMode('write'); ctx.find.open(false); }
      else if (a === 'settings') ctx.settingsUI.open();
      else if (a === 'theme') api.setSetting('theme', THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]);
      else if (a === 'share') {
        const r = b.getBoundingClientRect();
        showMenu([
          { label: t('分享 Markdown', 'Share Markdown'), run: () => api.exportDoc({ type: 'md', body: editor.getValue(), title: titleEl.textContent }) },
          { label: t('分享网页（HTML）', 'Share as web page (HTML)'), run: () => run('export', 'html') },
          { label: t('拷贝全文', 'Copy all'), run: () => run('copy-md') },
        ], r.left, r.top - 140);
      }
    };
  });

  // ---------- the library ----------
  const lib = el('div', '', `
    <div class="m-lib-top"><button class="m-local">${esc(t('保存在本机', 'On this device'))}</button><button class="m-btn m-lib-settings">${I.gear}</button></div>
    <h1>WhimFlow</h1>
    <label class="m-search">${I.search}<input type="search" placeholder="${esc(t('搜索所有文档', 'Search all documents'))}" enterkeyhint="search"></label>
    <div class="m-chips"><button data-view="recent" class="on">${t('最近', 'Recent')}</button><button data-view="folders">${t('文件夹', 'Folders')}</button></div>
    <div class="m-lib-body"></div>
    <button class="m-fab" aria-label="${t('新建', 'New')}">${I.plus}</button>`);
  lib.id = 'm-lib';
  body.append(lib);
  let view = 'recent', folder = M.ROOT, query = '';
  hooks.currentFolder = () => folder;
  const libBody = lib.querySelector('.m-lib-body');
  lib.querySelectorAll('.m-chips button').forEach((b) => { b.onclick = () => { view = b.dataset.view; lib.querySelectorAll('.m-chips button').forEach((x) => x.classList.toggle('on', x === b)); renderLibrary(); }; });
  lib.querySelector('.m-lib-settings').onclick = () => ctx.settingsUI.open();
  lib.querySelector('.m-fab').onclick = () => { ctx.docs.newDoc(); showEditor(); };
  const search = lib.querySelector('input');
  let searchTimer;
  search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query = search.value.trim(); renderLibrary(); }, 200); };
  search.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search.blur(); fullSearch(search.value.trim()); } };

  const when = (ms) => {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(t('zh-CN', 'en-US'), { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(t('zh-CN', 'en-US'), { month: 'short', day: 'numeric' });
  };
  async function docRow(path) {
    let text = '', mtime = 0;
    try { text = await M.read(path); mtime = +(await M.stat(path)).mtime || 0; } catch (_) { return null; }
    // the front matter (--- title: … ---) is not the text: the title and the line under it come after it
    const lines = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '').split('\n').map((l) => l.trim()).filter(Boolean);
    const title = (/^#{1,6}\s+(.+)$/.exec(lines[0] || '') || [])[1] || path.replace(/^.*\//, '').replace(/\.(md|markdown)$/i, '');
    const snippet = lines.slice(/^#/.test(lines[0] || '') ? 1 : 0).find((l) => !/^(#|```|---|\|)/.test(l)) || '';
    const open = ctx.docs.byPath(path);
    const row = el('div', 'm-doc', `<h4>${open && open.dirty ? '<span class="dot"></span>' : ''}${esc(title)}</h4><p>${esc(snippet.replace(/[*_`#>[\]]/g, ''))}</p><small>${esc(when(mtime))}</small>`);
    row.onclick = () => openDoc(path);
    longPress(row, (x, y) => itemMenu({ path, dir: false }, x, y));
    return swipeRow(row, { path, dir: false });
  }

  // ---------- swipe a row left: 编辑 (…) and 删除 (×) ----------
  const SWIPE = 132; // two 66 px buttons
  let swiped = null; // the row that is open: { wrap, close }
  function swipeRow(row, item) {
    const wrap = el('div', 'm-swipe', `<div class="m-swipe-acts">
      <button class="m-act-edit" aria-label="${esc(t('编辑', 'Edit'))}">${I.more}</button>
      <button class="m-act-del" aria-label="${esc(t('删除', 'Delete'))}">${I.cross}</button></div>`);
    wrap.append(row);
    const acts = wrap.firstElementChild;
    // the buttons ride in on the row's right edge (stretching a little past the end), their icons
    // growing in as they come; one movement, one curve, so the two never drift apart
    const set = (x, glide) => {
      for (const n of [row, acts]) n.style.transition = glide ? '' : 'none';
      row.style.transform = x ? `translateX(${x}px)` : '';
      acts.style.width = Math.max(SWIPE, -x) + 'px';
      acts.style.transform = `translateX(${Math.max(0, SWIPE + x)}px)`;
      acts.style.setProperty('--p', Math.min(1, -x / SWIPE).toFixed(3));
      wrap.classList.toggle('open', x < 0);
    };
    const me = { wrap, close: () => { set(0, true); if (swiped === me) swiped = null; } };
    const open = () => { if (swiped && swiped !== me) swiped.close(); set(-SWIPE, true); swiped = me; };
    let x0 = null, y0 = 0, base = 0, dx = 0, dragging = false, endedAt = 0, lastX = 0, lastT = 0, vx = 0;
    row.addEventListener('pointerdown', (e) => { x0 = lastX = e.clientX; y0 = e.clientY; lastT = e.timeStamp; base = swiped === me ? -SWIPE : 0; dx = vx = 0; dragging = false; });
    row.addEventListener('pointermove', (e) => {
      if (x0 == null) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!dragging) {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { x0 = null; return; } // scrolling the list
        if (Math.abs(mx) < 10) return;
        dragging = true;
        try { row.setPointerCapture(e.pointerId); } catch (_) { /* already released */ } // keep the finger's moves even over the buttons
        if (swiped && swiped !== me) swiped.close();
      }
      dx = mx;
      if (e.timeStamp > lastT) { vx = (e.clientX - lastX) / (e.timeStamp - lastT); lastX = e.clientX; lastT = e.timeStamp; }
      const x = Math.min(0, base + dx);
      set(x < -SWIPE ? -SWIPE - Math.min(40, (-SWIPE - x) * 0.3) : x); // past the buttons it pulls back
    });
    const end = (e) => { if (x0 == null) return; x0 = null; if (!dragging) return; endedAt = Date.now(); if (e.timeStamp - lastT > 100) vx = 0; // held still before letting go: not a flick
 (vx < -0.4 || (vx <= 0.4 && base + dx < -SWIPE / 2) ? open : me.close)(); }; // a flick decides; otherwise how far it went
    row.addEventListener('pointerup', end); row.addEventListener('pointercancel', end);
    // a tap on an open row closes it instead of opening the document; so does the click a drag may leave behind
    row.addEventListener('click', (e) => {
      if (Date.now() - endedAt < 350) { e.stopImmediatePropagation(); return; }
      if (swiped === me) { e.stopImmediatePropagation(); me.close(); }
    }, true);
    wrap.querySelector('.m-act-del').onclick = () => { me.close(); ctx.treeAction('trash', item); }; // trash() asks first
    wrap.querySelector('.m-act-edit').onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu([
        { label: t('编辑名字', 'Rename'), run: () => { me.close(); ctx.treeAction('rename', item); } },
        { label: t('移到文件夹', 'Move to Folder'), run: () => { me.close(); moveMenu(item, r.left, r.bottom); } },
      ], r.left, r.bottom);
    };
    return wrap;
  }
  // a touch anywhere else closes the open row
  document.addEventListener('pointerdown', (e) => { if (swiped && !swiped.wrap.contains(e.target) && !e.target.closest('#ctxmenu')) swiped.close(); }, true);

  /** Pick a folder of the library to move a file or folder into. */
  async function moveMenu(item, x, y) {
    const here = item.path.replace(/\/[^/]*$/, '') || M.ROOT;
    const all = [{ name: 'WhimFlow', path: M.ROOT, depth: 0 }];
    (function walk(nodes, depth) { for (const n of nodes) if (n.dir) { all.push({ name: n.name, path: n.path, depth }); walk(n.children, depth + 1); } })(await M.readTree(M.ROOT), 1);
    const targets = all.filter((d) => d.path !== here && d.path !== item.path && !d.path.startsWith(item.path + '/'));
    if (!targets.length) { toast(t('没有可以移入的文件夹，先新建一个', 'No folder to move into. Create one first')); return; }
    showMenu(targets.map((d) => ({ label: ' '.repeat(d.depth) + d.name, run: () => moveTo(item, d) })), x, y);
  }
  async function moveTo(item, d) {
    if (await api.move({ from: item.path, dir: d.path })) { toast(t(`已移到「${d.name}」`, `Moved to “${d.name}”`)); renderLibrary(); }
    else toast(t(`「${d.name}」里已有同名的文件或文件夹，没有移动`, `“${d.name}” already has an item with this name; nothing was moved`));
  }
  function longPress(node, fn) {
    let timer = null, start = null;
    node.addEventListener('pointerdown', (e) => { start = [e.clientX, e.clientY]; timer = setTimeout(() => { timer = null; node.dataset.held = '1'; fn(e.clientX, e.clientY); }, 520); });
    const cancel = (e) => { if (timer && (!e || !start || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8)) { clearTimeout(timer); timer = null; } };
    node.addEventListener('pointermove', cancel); node.addEventListener('pointerup', () => { clearTimeout(timer); timer = null; });
    node.addEventListener('click', (e) => { if (node.dataset.held) { e.stopImmediatePropagation(); delete node.dataset.held; } }, true);
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(e.clientX, e.clientY); });
  }
  function itemMenu(item, x, y) {
    showMenu([
      { label: t('编辑名字', 'Rename'), run: () => ctx.treeAction('rename', item) },
      { label: t('移到文件夹', 'Move to Folder'), run: () => moveMenu(item, x, y) },
      { label: t('删除', 'Delete'), danger: true, run: () => ctx.treeAction('trash', item) },
    ], x, y);
  }
  hooks.treeMenu = (item, choose) => {
    const r = (document.querySelector(`.tree-item[data-path="${CSS.escape(item.path)}"]`) || document.body).getBoundingClientRect();
    showMenu([
      { label: t('新建文档', 'New document'), run: () => choose('new-file') },
      { label: t('新建文件夹', 'New folder'), run: () => choose('new-folder') },
      ...(item.path !== M.ROOT ? ['-', { label: t('重命名', 'Rename'), run: () => choose('rename') }, { label: t('删除', 'Delete'), danger: true, run: () => choose('trash') }] : []),
    ], r.left + 40, r.bottom);
  };
  ctx.treeAction = (action, item) => api.mobile.emit('tree-action', action, item);

  let renderSeq = 0;
  async function renderLibrary() {
    const my = ++renderSeq;
    const frag = document.createDocumentFragment();
    const section = (label) => frag.append(el('div', 'm-eyebrow', esc(label)));
    const card = () => { const c = el('div', 'm-card'); frag.append(c); return c; };
    const match = (name) => !query || name.toLowerCase().includes(query.toLowerCase());
    if (view === 'recent') {
      const recent = M.recent();
      const rows = (await Promise.all(recent.map(docRow))).filter(Boolean).filter((r) => match(r.textContent));
      if (my !== renderSeq) return;
      if (rows.length) { section(t('最近打开', 'Recently opened')); const c = card(); rows.forEach((r) => c.append(r)); }
      else frag.append(el('div', 'm-empty', esc(query ? t('没有找到。按「搜索」查找全文', 'Nothing here. Press Search to look inside documents') : t('还没有文档。点右下角的 + 写第一篇', 'No documents yet. Tap + to write the first one'))));
    } else {
      const tree = await M.readTree(folder);
      if (my !== renderSeq) return;
      if (folder !== M.ROOT) {
        const up = el('button', 'm-crumb', `${I.back}<span>${esc(folder.slice(M.ROOT.length + 1))}</span>`);
        up.onclick = () => { folder = folder.replace(/\/[^/]*$/, '') || M.ROOT; renderLibrary(); };
        frag.append(up);
      }
      const dirs = tree.filter((n) => n.dir && match(n.name)), files = tree.filter((n) => !n.dir && match(n.name));
      if (dirs.length) {
        section(t('文件夹', 'Folders'));
        const c = card();
        for (const d of dirs) {
          const count = (function n(x) { return x.children.reduce((s, k) => s + (k.dir ? n(k) : 1), 0); })(d);
          const row = el('div', 'm-folder', `${I.folder}<span>${esc(d.name)}</span><small>${count}</small>`);
          row.onclick = () => { folder = d.path; renderLibrary(); };
          longPress(row, (x, y) => itemMenu(d, x, y));
          c.append(swipeRow(row, d));
        }
      }
      if (files.length) {
        section(t('文档', 'Documents'));
        const c = card();
        for (const f of files) { const r = await docRow(f.path); if (r) c.append(r); }
      }
      const add = el('button', 'm-newfolder', `${I.folder}<span>${esc(t('新建文件夹', 'New folder'))}</span>`);
      add.onclick = () => ctx.treeAction('new-folder', { path: folder, dir: true });
      frag.append(add);
      if (my !== renderSeq) return;
    }
    libBody.replaceChildren(frag);
  }
  async function fullSearch(q) {
    if (!q) { renderLibrary(); return; }
    const r = await api.search({ folder: M.ROOT, query: q, opts: {} });
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'm-eyebrow', esc(r.total ? t(`${r.files.length} 篇文档 · ${r.total} 处`, `${r.total} in ${r.files.length} documents`) : t('没有找到', 'No results'))));
    for (const f of r.files || []) {
      const c = el('div', 'm-card');
      c.append(el('div', 'm-hit-head', esc(f.name.replace(/\.(md|markdown)$/i, ''))));
      for (const m of f.matches.slice(0, 8)) {
        const row = el('button', 'm-hit', `${esc(m.text.slice(0, m.at))}<mark>${esc(m.text.slice(m.at, m.at + m.len))}</mark>${esc(m.text.slice(m.at + m.len))}`);
        row.onclick = () => openDoc(f.path, { line: m.line, col: m.col, len: m.len });
        c.append(row);
      }
      frag.append(c);
    }
    libBody.replaceChildren(frag);
  }

  // ---------- moving between the library and a document ----------
  async function openDoc(path, jump) {
    await api.openInWindow(path, jump || null, { preview: false });
    showEditor();
  }
  function showEditor() { body.classList.remove('m-lib'); setMode('write'); updateBar(); }
  async function showLibrary() {
    await saveDirty();
    body.classList.remove('m-read');
    body.classList.add('m-lib');
    editor.view.contentDOM.blur();
    renderLibrary();
  }
  /** Phones save on their own: leaving a document, or the app, saves what changed (and names new ones after their title). */
  async function saveDirty() {
    for (const d of ctx.docs.list()) {
      if (!d.dirty || d.conflict) continue;
      if (!d.filePath && !ctx.docs.textOf(d).trim()) continue;
      await ctx.save(false, d);
    }
  }
  let newDocTimer;
  editor.onChange(() => {
    const d = ctx.docs.active();
    if (!d || d.filePath) return;
    clearTimeout(newDocTimer);
    newDocTimer = setTimeout(() => { if (d.dirty && !d.filePath && ctx.docs.textOf(d).trim()) ctx.save(false, d); }, 2500);
  });
  async function renameActive() {
    const d = ctx.docs.active();
    if (!d || !d.filePath) { toast(t('写下第一行，文档就会以它命名', 'Write a first line: the document is named after it')); return; }
    ctx.treeAction('rename', { path: d.filePath, dir: false });
  }
  hooks.lastDocClosed = () => { ctx.docs.newDoc(); showLibrary(); };
  hooks.toast = (m) => toast(m);
  hooks.confirm = (m) => Promise.resolve(window.confirm(m));
  api.onRenamed(() => { if (body.classList.contains('m-lib')) renderLibrary(); updateBar(); });
  // a document opened from anywhere (a new file, a search hit) brings the editor forward
  api.onLoad(() => { if (body.classList.contains('m-lib')) showEditor(); });
  api.onTreeAction(() => { setTimeout(() => { if (body.classList.contains('m-lib')) renderLibrary(); }, 700); });

  // the app going to the background is the moment to save
  if (native) App.addListener('pause', () => { saveDirty(); }).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveDirty(); else M.syncNudge(); });
  // coming back to the front is the moment to sync
  if (native) App.addListener('resume', () => { M.syncNudge(); }).catch(() => {});

  // ---------- sync: the chip at the top of the library says how it is going; a tap syncs now ----------
  const chip = lib.querySelector('.m-local');
  let syncState = { state: 'off' };
  function showSync(st) {
    syncState = st || { state: 'off' };
    chip.textContent = syncState.state === 'off' ? t('保存在本机', 'On this device') : syncText(syncState);
    chip.dataset.state = syncState.state;
  }
  chip.onclick = () => { if (syncState.state === 'off') ctx.settingsUI.open(); else api.syncNow(); };
  api.onSyncStatus((st) => {
    showSync(st);
    if (st.changed && body.classList.contains('m-lib')) renderLibrary(); // what came in shows at once
    const n = (st.conflicts || []).length;
    if (n) toast(t(`${n} 篇文档在两台设备上都改过，两份都保留了`, `${n} document(s) changed on two devices; both versions kept`));
  });
  api.syncConfig().then((c) => showSync(c.status));

  // ---------- the mind map under the text (phone): the text above, the map below ----------
  // The desktop's map itself (mindmap.js) moves into this panel, so it renders, follows and edits
  // the same way. Drag the top edge between folded, a third and a half of the screen; a tap on it
  // folds or unfolds; × closes. Tapping a node scrolls the text there; the section being read is
  // highlighted (and slid into view). While the keyboard is up the panel steps aside.
  const map = el('section', '', `<div class="m-map-grab"><span class="m-map-handle"></span><span class="m-map-label">${esc(t('思维导图', 'Mind map'))}</span>
    <button class="m-map-close" aria-label="${esc(t('关闭思维导图', 'Close the mind map'))}">${I.cross}</button></div><div class="m-map-body"></div>`);
  map.id = 'm-map';
  body.append(map);
  const mmPane = document.getElementById('mindmap'), mmHome = mmPane.parentNode;
  const FOLDED = 44;
  const cssPx = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
  const typing = () => body.classList.contains('m-kb');
  // the room the map may take: with the keyboard up, what is left above it and the formatting bar,
  // keeping about 120 px of text in sight
  const mapRoom = () => (typing() ? Math.max(FOLDED, innerHeight - cssPx('--kb') - (body.classList.contains('m-editing') ? 46 : 0) - cssPx('--m-bar') - cssPx('--sat') - 120) : innerHeight * 0.7);
  const mapStops = () => (typing() ? [FOLDED, Math.round(Math.max(FOLDED, mapRoom() * 0.55)), Math.round(mapRoom())]
    : [FOLDED, Math.round(innerHeight * 0.36), Math.round(innerHeight * 0.55)]);
  let mapOn = false, mapH = +localStorage.getItem('whimflow.mapHeight') || 0;
  const mapWanted = () => localStorage.getItem('whimflow.mapOn') === '1';
  function setMapHeight(h, glide) {
    body.classList.toggle('m-map-drag', !glide);
    document.documentElement.style.setProperty('--map-h', Math.round(h) + 'px');
    map.classList.toggle('folded', h <= FOLDED + 4);
  }
  function dockMap(on, keepWish) {
    mapOn = !!on && !wide.matches;
    body.classList.toggle('m-map', mapOn);
    if (mapOn) {
      map.querySelector('.m-map-body').append(mmPane);
      setMapHeight(mapH > FOLDED + 4 ? mapH : mapStops()[1], true);
    } else if (mmPane.parentNode !== mmHome) mmHome.append(mmPane);
    ctx.mindmap.setDocked(mapOn);
    if (!keepWish) localStorage.setItem('whimflow.mapOn', mapOn ? '1' : '');
  }
  const grab = map.querySelector('.m-map-grab');
  let gy = null, gh = 0, gMoved = false;
  grab.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.m-map-close')) return;
    gy = e.clientY; gh = map.getBoundingClientRect().height - (parseFloat(getComputedStyle(map).paddingBottom) || 0); gMoved = false;
    try { grab.setPointerCapture(e.pointerId); } catch (_) {}
  });
  grab.addEventListener('pointermove', (e) => {
    if (gy == null) return;
    const d = gy - e.clientY;
    if (Math.abs(d) > 4) gMoved = true;
    if (gMoved) setMapHeight(Math.max(FOLDED, Math.min(mapRoom(), gh + d)));
  });
  const grabEnd = () => {
    if (gy == null) return;
    gy = null;
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--map-h')) || gh;
    const stops = mapStops();
    const h = gMoved ? stops.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a)) // to the nearest stop
      : cur <= FOLDED + 4 ? (mapH > FOLDED + 4 ? mapH : stops[1]) : FOLDED;                       // a tap folds / unfolds
    setMapHeight(h, true);
    if (h > FOLDED + 4 && !typing()) { mapH = h; localStorage.setItem('whimflow.mapHeight', String(h)); } // what it opens to without the keyboard
  };
  // the keyboard comes up: the map folds out of the way (pull it up to look); it goes down: back to its height
  let wasTyping = false;
  new MutationObserver(() => {
    const now = typing();
    if (now === wasTyping) return;
    wasTyping = now;
    if (!mapOn) return;
    setMapHeight(now ? FOLDED : mapH > FOLDED + 4 ? mapH : mapStops()[1], true);
  }).observe(body, { attributes: true, attributeFilter: ['class'] });
  grab.addEventListener('pointerup', grabEnd);
  grab.addEventListener('pointercancel', grabEnd);
  map.querySelector('.m-map-close').onclick = () => dockMap(false);
  if (mapWanted() && !wide.matches) dockMap(true);

  // ---------- pull the library down to sync ----------
  // Touch events (not pointer events): at the top of the list the finger's move is ours, so the
  // page does not bounce; the list follows the finger with some resistance, the arrows turn, and
  // past the line a light tap says "release now". Releasing there syncs; the result shows briefly.
  const pull = el('div', 'm-pull', `<span class="m-pull-icon">${I.sync}</span><span class="m-pull-text"></span>`);
  lib.prepend(pull);
  const pullText = pull.querySelector('.m-pull-text');
  const PULL = 64, PULL_MAX = 110, PULL_HOLD = 52;
  let py0 = null, px0 = 0, pulled = 0, armed = false, pullBusy = false;
  function setPull(d, glide) {
    lib.classList.toggle('m-pulling', !glide);
    lib.style.setProperty('--pull', d + 'px');
    pull.style.setProperty('--p', Math.min(1, d / PULL).toFixed(3));
  }
  const pullDone = () => { py0 = null; if (!pullBusy) setPull(0, true); };
  lib.addEventListener('touchstart', (e) => {
    py0 = null;
    if (pullBusy || lib.scrollTop > 0 || e.touches.length !== 1 || (e.target.closest && e.target.closest('input, textarea, .m-swipe.open'))) return;
    py0 = e.touches[0].clientY; px0 = e.touches[0].clientX; pulled = 0; armed = false;
  }, { passive: true });
  lib.addEventListener('touchmove', (e) => {
    if (py0 == null) return;
    const dy = e.touches[0].clientY - py0, dx = e.touches[0].clientX - px0;
    if (!pulled && (dy <= 0 || Math.abs(dx) > Math.abs(dy) || lib.scrollTop > 0)) { py0 = null; return; } // scrolling, or swiping a row
    e.preventDefault();
    pulled = Math.max(0, Math.min(PULL_MAX, dy * 0.5));
    setPull(pulled);
    if ((pulled >= PULL) !== armed) {
      armed = pulled >= PULL;
      if (armed && native) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    }
    pull.classList.toggle('armed', armed);
    pullText.textContent = armed ? t('松开立即同步', 'Release to sync') : t('下拉同步', 'Pull to sync');
  }, { passive: false });
  lib.addEventListener('touchcancel', pullDone);
  lib.addEventListener('touchend', async () => {
    if (py0 == null) return;
    py0 = null;
    pull.classList.remove('armed');
    if (!armed) { setPull(0, true); return; }
    if (syncState.state === 'off') { setPull(0, true); ctx.settingsUI.open(); return; } // not connected: say where to connect
    pullBusy = true;
    pull.classList.add('busy');
    pullText.textContent = t('正在同步…', 'Syncing…');
    setPull(PULL_HOLD, true);
    const started = Date.now();
    const st = await api.syncNow();
    await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - started)))); // long enough to be seen
    pull.classList.remove('busy');
    pullText.textContent = syncText(st);
    setTimeout(() => { setPull(0, true); setTimeout(() => { pullBusy = false; }, 350); }, 700);
  });

  layout();
  updateBar();
  // a document recovered after a crash opens straight away; otherwise the library comes first
  if (ctx.docs.list().some((d) => d.dirty)) showEditor(); else showLibrary();
  return { showLibrary, showEditor, setMode, openSheet, renderLibrary, saveDirty };
}
