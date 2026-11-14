// Left island: file tree and outline.
import { $, t, basename, dirname, prompt, toast } from '../util.js';
import { remapPath } from '../paths.js';

export function initSidebar(ctx) {
  const { api, state } = ctx;
  const openDirs = new Set();
  let treeData = [];
  let outlineItems = [];

  // ---------- open / tabs ----------
  const isOpen = () => document.body.classList.contains('sidebar-open');
  // The side column holds two small islands, files above and outline below, or the
  // folder search. `card` may be 'files' / 'outline' (shown together) or 'search'.
  let lastCard = null;
  const cards = { files: $('#tree-card'), outline: $('#outline-card') };
  function setSidebar(open, card) {
    if (card) { state.tab = card === 'search' ? 'search' : 'browse'; document.body.dataset.tab = state.tab; }
    document.body.classList.toggle('sidebar-open', open);
    $('#btn-sidebar').classList.toggle('on', open);
    document.querySelectorAll('.side-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    api.setSetting('sidebar', open);
    ctx.islands && ctx.islands.applyOrder(false);
    if (open && cards[card]) {
      // bring the asked-for island into view and nod at it
      lastCard = card;
      setCollapsed(card, false);
      cards[card].classList.remove('nudge'); void cards[card].offsetWidth; cards[card].classList.add('nudge');
    }
    if (!open) lastCard = null;
    if (open && state.tab === 'browse') highlight();
  }
  /** Menu / shortcut: open on that island; asking for the same one again closes the column. */
  const toggleCard = (card) => setSidebar(!(isOpen() && state.tab === 'browse' && lastCard === card), card);
  document.querySelectorAll('.side-tab').forEach((b) => { b.onclick = () => setSidebar(true, b.dataset.tab === 'search' ? 'search' : (lastCard || 'files')); });

  // labels, folding, and the divider between the two islands
  cards.files.querySelector('.eyebrow').textContent = t('文件', 'Files');
  cards.outline.querySelector('.eyebrow').textContent = t('大纲', 'Outline');
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('mf-side') || '{}'); } catch (_) { return {}; } })();
  const savePrefs = () => { try { localStorage.setItem('mf-side', JSON.stringify(prefs)); } catch (_) { /* private mode */ } };
  function setCollapsed(card, on) {
    prefs[card + 'Collapsed'] = on;
    cards[card].classList.toggle('collapsed', on);
    savePrefs();
  }
  function setSplit(r) {
    prefs.split = Math.min(0.85, Math.max(0.15, r));
    $('#browse').style.setProperty('--split-a', prefs.split);
    $('#browse').style.setProperty('--split-b', 1 - prefs.split);
  }
  setSplit(prefs.split || 0.45);
  for (const card of ['files', 'outline']) {
    cards[card].classList.toggle('collapsed', !!prefs[card + 'Collapsed']);
    const head = cards[card].querySelector('.card-head');
    head.dataset.tip = t('点击折叠 / 展开', 'Click to fold / unfold');
    head.onclick = () => setCollapsed(card, !cards[card].classList.contains('collapsed'));
  }
  $('#side-split').onmousedown = (e) => {
    e.preventDefault();
    const box = $('#browse').getBoundingClientRect();
    const move = (ev) => setSplit((ev.clientY - box.top) / box.height);
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); savePrefs(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };

  // ---------- outline ----------
  function refreshOutline() {
    const box = $('#outline');
    const hs = ctx.editor.headings().filter((h) => h.text);
    // say whose chapters these are
    cards.outline.querySelector('.card-meta').textContent = ctx.docs ? ctx.docs.name().replace(/\.(md|markdown)$/i, '') : '';
    outlineItems = hs;
    box.textContent = '';
    if (!hs.length) {
      const e = document.createElement('div');
      e.className = 'side-empty';
      e.textContent = t('写下第一个标题，大纲就会出现在这里。', 'Write your first heading and the outline will appear here.');
      box.append(e);
      return;
    }
    const min = Math.min(...hs.map((h) => h.level));
    const listEl = document.createElement('div');
    listEl.className = 'outline-list';
    box.append(listEl);
    hs.forEach((h) => {
      const d = document.createElement('div');
      d.className = `outline-item l${h.level - min + 1}`;
      d.style.paddingLeft = 10 + (h.level - min) * 14 + 'px';
      const s = document.createElement('span');
      s.textContent = h.text;
      d.append(s);
      d.title = h.text;
      d.onclick = () => ctx.editor.scrollToHeading(ctx.editor.headings().indexOf(h));
      listEl.append(d);
    });
    const ind = document.createElement('div');
    ind.id = 'outline-ind';
    listEl.append(ind);
    highlight();
  }
  /** Mark the section being read; returns its index among all headings. */
  function highlight() {
    const idx = ctx.editor.headingIndexAtScroll();
    const all = ctx.editor.headings();
    const cur = all[idx];
    const items = [...$('#outline').querySelectorAll('.outline-item')];
    const k = cur ? outlineItems.indexOf(cur) : -1;
    items.forEach((c, i) => c.classList.toggle('active', i === k));
    const ind = $('#outline-ind');
    if (ind && items[k]) { ind.style.transform = `translateY(${items[k].offsetTop + 6}px)`; ind.style.opacity = 1; }
    return idx;
  }

  // ---------- file tree ----------
  async function setFolder(dir) {
    state.folder = dir;
    cards.files.querySelector('.card-meta').textContent = dir ? basename(dir) : '';
    openDirs.clear();
    await refreshTree();
  }
  async function refreshTree() {
    treeData = state.folder ? await api.readTree(state.folder) : [];
    renderTree();
  }
  function renderTree() {
    const box = $('#tree');
    box.textContent = '';
    if (!state.folder) {
      const e = document.createElement('div');
      e.className = 'side-empty';
      e.textContent = t('还没有打开文件夹。', 'No folder yet.');
      const b = document.createElement('button');
      b.className = 'link-btn';
      b.textContent = t('打开文件夹', 'Open a folder');
      b.onclick = () => api.openFolderDialog();
      e.append(document.createElement('br'), b);
      box.append(e);
      return;
    }
    const build = (nodes, parent, depth) => {
      for (const n of nodes) {
        const row = document.createElement('div');
        row.className = 'tree-item' + (n.dir ? ' dir' : '') + (n.dir && openDirs.has(n.path) ? ' open' : '') + (n.path === state.filePath ? ' active' : '') + (!n.dir && ctx.docs && ctx.docs.isOpen(n.path) ? ' opened' : '');
        row.style.paddingLeft = 6 + depth * 14 + 'px';
        row.dataset.path = n.path;
        const tw = document.createElement('span'); tw.className = 'twisty'; tw.textContent = n.dir ? '▶' : '';
        const label = document.createElement('span'); label.className = 'label'; label.textContent = n.dir ? n.name : n.name.replace(/\.(md|markdown)$/i, '');
        row.append(tw, label);
        row.title = n.name;
        row.onclick = () => {
          if (n.dir) { openDirs.has(n.path) ? openDirs.delete(n.path) : openDirs.add(n.path); row.classList.toggle('open'); }
          else api.openInWindow(n.path, null, { preview: true }); // a single click previews; the next one replaces it
        };
        row.ondblclick = () => { if (!n.dir) api.openInWindow(n.path, null, { preview: false }); }; // a double click keeps it open
        row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); api.treeMenu({ path: n.path, dir: n.dir }); };
        parent.append(row);
        if (n.dir) {
          const kids = document.createElement('div');
          kids.className = 'tree-children';
          build(n.children, kids, depth + 1);
          parent.append(kids);
        }
      }
    };
    build(treeData, box, 0);
    if (!box.children.length) {
      const e = document.createElement('div');
      e.className = 'side-empty';
      e.textContent = t('此文件夹中没有 Markdown 文件', 'No Markdown files in this folder');
      box.append(e);
    }
  }
  const markActiveFile = () => document.querySelectorAll('.tree-item').forEach((r) => {
    r.classList.toggle('active', r.dataset.path === state.filePath);
    r.classList.toggle('opened', !!ctx.docs && ctx.docs.isOpen(r.dataset.path));
  });
  $('#tree').oncontextmenu = (e) => { e.preventDefault(); if (state.folder) api.treeMenu({ path: state.folder, dir: true }); };

  api.onTreeAction(async (action, item) => {
    const dir = item.dir ? item.path : dirname(item.path);
    if (action === 'new-file' || action === 'new-folder') {
      const isDir = action === 'new-folder';
      const name = await prompt(isDir ? t('新建文件夹', 'New Folder') : t('新建文件', 'New File'), isDir ? '' : t('未命名.md', 'Untitled.md'));
      if (!name) return;
      const p = await api.createFile({ dir, name, isDir });
      if (!p) { toast(t('无法创建（名称无效或已存在）', 'Could not create (invalid or existing name)')); return; }
      openDirs.add(dir);
      await refreshTree();
      if (!isDir) api.openInWindow(p, null, { preview: false });
    } else if (action === 'rename') {
      const name = await prompt(t('重命名', 'Rename'), basename(item.path));
      if (!name || name === basename(item.path)) return;
      if (!(await api.rename({ from: item.path, name }))) { toast(t('重命名失败', 'Rename failed')); return; }
      refreshTree();
    } else if (action === 'trash') {
      const r = await api.trash(item.path);
      if (r && r.ok) refreshTree();
      else if (r && r.error) toast(t('无法移到废纸篓，文件没有改动：', 'Could not move to Trash; nothing was deleted: ') + r.error);
    }
  });

  /** A file or folder was renamed: folders that were open stay open under their new name. */
  function renamed(from, to) {
    for (const d of [...openDirs]) { const nd = remapPath(d, from, to); if (nd) { openDirs.delete(d); openDirs.add(nd); } }
    refreshTree();
  }

  return { setSidebar, toggleCard, isOpen, refreshOutline, highlight, setFolder, refreshTree, markActiveFile, renamed, files: () => treeData };
}
