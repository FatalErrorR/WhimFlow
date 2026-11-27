// Boot and wiring: document state, open/save, commands and shortcuts, and the
// glue between the editor and the panels around it.
import { $, t, i18n, basename, dirname, fileUrl, toast, hideToast, initTips, countText, plainMarkdown, ICONS } from './util.js';
import { createEditor } from './editor/index.js';
import { live } from './editor/widgets.js';
import { renderMarkdown, renderMermaidIn } from './render.js';
import { initSidebar } from './ui/sidebar.js';
import { initRight } from './ui/right.js';
import { initMindmap } from './ui/mindmap.js';
import { initIslands } from './ui/islands.js';
import { initFind, initBubble, initPalette } from './ui/overlays.js';
import { initSettings, applySettings } from './ui/settings.js';
import { initSearch } from './ui/search.js';
import { initHistory } from './ui/history.js';
import { initDocs } from './ui/docs.js';
import { initCodeDiff } from './ui/codediff.js';
import { frontMatter } from './render.js';
import { setPlatform, remapPath } from './paths.js';

const api = window.api;

(async () => {
  const env = await api.init();
  i18n.zh = env.zh;
  setPlatform(env.platform);
  const isMac = env.isMac;
  const state = { settings: { ...env.settings }, filePath: null, dirty: false, theme: env.settings.theme, autoSave: env.settings.autoSave, folder: env.folder, zoom: 1, focus: false, typewriter: false, tab: 'outline', loading: false };
  document.body.classList.toggle('mac', isMac && !env.mobile); // iPad: ⌘ shortcuts, but no window buttons to make room for
  document.body.classList.toggle('mobile', !!env.mobile);
  document.documentElement.lang = env.zh ? 'zh-CN' : 'en';
  document.documentElement.dataset.theme = state.theme;
  $('#modal-cancel').textContent = t('取消', 'Cancel');
  $('#modal-ok').textContent = t('确定', 'OK');

  const ctx = { api, env, state };
  const editor = createEditor($('#editor'), {
    t, isMac,
    copy: (s) => api.copyText(s),
    insertImages: (files, pos, dropped) => insertImages(files, pos, dropped),
    openLink: (href) => openLink(href),
    reveal: (url) => api.revealUrl(url),
    compareCode: (pos) => ctx.codeDiff.start(pos),
  });
  ctx.editor = editor;

  // ---------- keyboard shortcuts ("mod" = ⌘ on macOS, Ctrl elsewhere) ----------
  const KEYS = {
    'mod+s': ['save'], 'mod+shift+s': ['save-as'], 'mod+p': ['print'], 'mod+n': ['new-doc'], 'mod+w': ['close-doc'],
    'mod+z': ['undo'], 'mod+shift+z': ['redo'], 'mod+y': ['redo'],
    'mod+shift+c': ['copy-md'],
    'mod+f': ['find'], 'mod+g': ['find-next'], 'mod+shift+g': ['find-prev'],
    [isMac ? 'mod+alt+f' : 'mod+h']: ['replace'],
    'mod+1': ['heading', 1], 'mod+2': ['heading', 2], 'mod+3': ['heading', 3], 'mod+4': ['heading', 4],
    'mod+5': ['heading', 5], 'mod+6': ['heading', 6], 'mod+0': ['heading', 0],
    'mod+=': ['heading-up'], 'mod+-': ['heading-down'],
    'mod+alt+t': ['table'], 'mod+alt+c': ['code-block'], 'mod+shift+k': ['code-block'], 'mod+alt+b': ['math-block'],
    'mod+alt+q': ['quote'], 'mod+alt+o': ['ordered-list'], 'mod+alt+u': ['list'], 'mod+alt+x': ['check'], 'mod+alt+-': ['line'],
    'mod+b': ['bold'], 'mod+i': ['italic'], 'mod+u': ['underline'], 'mod+k': ['link'],
    'ctrl+`': ['inline-code'], 'ctrl+shift+`': ['strike'], 'mod+shift+h': ['mark'], 'ctrl+m': ['inline-math'],
    [isMac ? 'mod+ctrl+i' : 'mod+shift+i']: ['image'],
    'mod+/': ['source'], 'mod+alt+/': ['split'], 'mod+shift+.': ['invisibles'], 'mod+shift+l': ['sidebar'], 'mod+shift+1': ['outline'], 'mod+shift+3': ['files'],
    'mod+shift+m': ['mindmap'], 'mod+shift+r': ['preview'], 'mod+shift+p': ['palette'],
    f8: ['focus'], f9: ['typewriter'],
    'mod+,': ['settings'], 'mod+shift+f': ['search'], 'mod+alt+r': ['footnote'],
    'mod+shift+9': ['zoom', 0], 'mod+shift+=': ['zoom', 1], 'mod+shift+-': ['zoom', -1],
  };
  ctx.shortcutFor = (cmd, arg) => {
    if (cmd === 'code-highlight') cmd = 'mark'; // the same key, inside a code block
    const hit = Object.entries(KEYS).find(([, v]) => v[0] === cmd && (v[1] == null ? arg == null : v[1] === arg));
    if (!hit) return '';
    return hit[0].split('+').map((k) => (isMac
      ? ({ mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' }[k] || k.toUpperCase())
      : ({ mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' }[k] || k.toUpperCase()))).join(isMac ? '' : '+');
  };
  ctx.tipFor = (label, cmd, arg) => { const k = ctx.shortcutFor(cmd, arg); return k ? `${label}  ${k}` : label; };

  // ---------- panels ----------
  ctx.sidebar = initSidebar(ctx);
  ctx.mindmap = initMindmap(ctx);
  ctx.right = initRight(ctx);
  ctx.islands = initIslands(ctx);
  ctx.find = initFind(ctx);
  ctx.run = (cmd, arg) => run(cmd, arg);
  ctx.bubble = initBubble(ctx);
  ctx.palette = initPalette(ctx);
  ctx.search = initSearch(ctx);
  ctx.history = initHistory(ctx);
  ctx.settingsUI = initSettings(ctx);
  ctx.codeDiff = initCodeDiff(ctx);
  applySettings(ctx, state.settings);
  initTips();

  const setIcon = (sel, icon, tip) => { const el = document.querySelector(sel); if (icon) el.innerHTML = icon; el.dataset.tip = tip; };
  setIcon('[data-tab="browse"]', ICONS.files, t('文件与大纲', 'Files & Outline'));
  setIcon('[data-rtab="mindmap"]', ICONS.mindmap, ctx.tipFor(t('思维导图', 'Mind Map'), 'mindmap'));
  setIcon('[data-rtab="preview"]', ICONS.doc, ctx.tipFor(t('正式稿', 'Final View'), 'preview'));
  setIcon('[data-rtab="history"]', ICONS.history, t('历史版本', 'Version History'));
  setIcon('[data-tab="search"]', ICONS.search, ctx.tipFor(t('在文件夹中搜索', 'Search in Folder'), 'search'));
  setIcon('#btn-sidebar', ICONS.sidebar, ctx.tipFor(t('侧边栏', 'Sidebar'), 'sidebar'));
  setIcon('#btn-right', ICONS.panel, t('思维导图 / 正式稿', 'Mind Map / Final View'));
  setIcon('#find-case', null, t('区分大小写', 'Match case'));
  setIcon('#find-prev', null, ctx.tipFor(t('上一个', 'Previous'), 'find-prev'));
  setIcon('#find-next', null, ctx.tipFor(t('下一个', 'Next'), 'find-next'));
  setIcon('#find-close', null, t('关闭', 'Close') + '  Esc');
  $('#btn-sidebar').onclick = () => run('sidebar');
  $('#btn-right').onclick = () => ctx.right.setRight(!ctx.right.isOpen());

  // ---------- document state ----------
  function updateTitle() {
    const name = ctx.docs ? ctx.docs.name() : t('未命名', 'Untitled');
    $('#title').textContent = name.replace(/\.(md|markdown)$/i, '');
    const conflicted = ctx.docs && ctx.docs.active() && ctx.docs.active().conflict;
    $('#title-state').textContent = conflicted ? t('— 与磁盘上的版本冲突', '— Conflicts with the file on disk') : state.dirty ? t('— 已编辑', '— Edited') : '';
    document.body.classList.toggle('doc-conflict', !!conflicted);
    const dot = $('#save-dot');
    dot.classList.toggle('dirty', state.dirty);
    dot.classList.toggle('conflict', !!conflicted);
    dot.dataset.tip = conflicted ? t('文件在磁盘上已被修改，没有覆盖。命令面板：从磁盘重新加载 / 覆盖磁盘上的文件', 'Changed on disk and not overwritten. Command palette: Reload from Disk / Overwrite File on Disk')
      : state.dirty ? t('有未保存的更改', 'Unsaved changes') : state.filePath ? t('已保存', 'All changes saved') : t('还没有保存到文件', 'Not saved to a file yet');
    api.setTitle(isMac ? name : `${conflicted ? '⚠ ' : state.dirty ? '● ' : ''}${name} — WhimFlow`);
  }
  // ---------- revisions ----------
  // Every edit to a document bumps doc.rev. doc.savedRev is the newest revision known
  // to be on disk. A save remembers the revision it wrote; when it finishes, only that
  // revision counts as saved: anything typed meanwhile stays unsaved, keeps its draft
  // and gets its own auto-save.
  const timers = new WeakMap(); // document -> { draft, auto }
  const timersOf = (doc) => { if (!timers.has(doc)) timers.set(doc, {}); return timers.get(doc); };
  const isOpen = (doc) => ctx.docs.list().includes(doc);

  // a draft remembers the version of the file its text was based on (see 'save' in main.js)
  const draftOf = (doc) => ({ filePath: doc.filePath, content: ctx.docs.fileText(doc), version: doc.diskVersion || null });
  ctx.draftOf = draftOf;
  /** Keep a copy of the document's unsaved text on disk, so a crash never takes it. */
  function scheduleDraft(doc, delay = 1200) {
    const tm = timersOf(doc);
    clearTimeout(tm.draft); tm.draft = null;
    if (!state.settings.drafts) return;
    tm.draft = setTimeout(() => {
      tm.draft = null;
      if (state.settings.drafts && doc.dirty && isOpen(doc)) api.draft(doc.id, draftOf(doc));
    }, delay);
  }
  function scheduleAuto(doc) {
    const tm = timersOf(doc);
    clearTimeout(tm.auto); tm.auto = null;
    if (!state.autoSave || !doc.filePath || doc.conflict) return;
    tm.auto = setTimeout(() => {
      tm.auto = null;
      // auto-save may have been turned off since this was planned
      if (state.autoSave && doc.dirty && doc.filePath && !doc.conflict && isOpen(doc)) save(false, doc);
    }, (state.settings.autoSaveDelay || 2) * 1000);
  }
  function cancelTimers(doc, which = ['draft', 'auto']) {
    const tm = timersOf(doc);
    for (const k of which) { clearTimeout(tm[k]); tm[k] = null; }
  }
  /** The text of `doc` changed (it need not be the active document). */
  function markChanged(doc) {
    doc.rev = (doc.rev || 0) + 1;
    if (doc.preview) doc.preview = false; // editing a previewed file keeps it open
    const was = doc.dirty;
    doc.dirty = true;
    if (doc === ctx.docs.active()) { state.dirty = true; if (!was) updateTitle(); }
    if (!was) ctx.docs.sync();
    scheduleDraft(doc);
    scheduleAuto(doc);
  }
  ctx.markChanged = markChanged;
  const baseUrl = () => (state.filePath ? fileUrl(dirname(state.filePath)) + '/' : '');
  ctx.baseUrl = baseUrl;

  function updateCount() {
    const sel = editor.selectionText();
    const md = editor.getValue();
    const c = countText(sel || plainMarkdown(md));
    const el = $('#wordcount');
    el.textContent = (sel ? t('已选 ', 'Selected ') : '') + (env.zh ? `${c.words} 词` : `${c.words} Words`);
    const lines = editor.view.state.doc.lines, mins = Math.max(1, Math.round(c.words / 300));
    const eol = ctx.docs && ctx.docs.active() && ctx.docs.active().eol === '\r\n' ? 'CRLF' : 'LF';
    el.dataset.tip = (env.zh ? `${c.words} 词 · ${c.chars} 字符 · ${lines} 行 · 阅读约 ${mins} 分钟` : `${c.words} words · ${c.chars} characters · ${lines} lines · ~${mins} min read`) + ` · ${eol}`;
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return t('夜深了，慢慢写。', 'It’s late. Take your time.');
    if (h < 11) return t('早上好，今天想写点什么？', 'Good morning. What’s on your mind?');
    if (h < 14) return t('中午好，写点什么吧。', 'Good afternoon. Ready to write?');
    if (h < 18) return t('下午好，今天想写点什么？', 'Good afternoon. What’s on your mind?');
    return t('晚上好，把今天的想法记下来吧。', 'Good evening. Let’s get your thoughts down.');
  }
  function updateWelcome() {
    const w = $('#welcome');
    const show = !state.filePath && editor.mode === 'live' && !editor.getValue().trim();
    if (show && !w.classList.contains('show')) {
      w.querySelector('.date').textContent = new Date().toLocaleDateString(env.zh ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'long' });
      w.querySelector('h2').textContent = greeting();
      w.querySelector('p').textContent = t('直接开始打字就好，格式会自己整理。', 'Just start typing. The formatting takes care of itself.');
      const ul = w.querySelector('ul');
      ul.textContent = '';
      const li = document.createElement('li'), kb = document.createElement('kbd'), sp = document.createElement('span');
      kb.textContent = ctx.shortcutFor('palette');
      sp.textContent = t('其余的一切，都在这里', 'Everything else lives here');
      li.append(kb, sp);
      ul.append(li);
    }
    w.classList.toggle('show', show);
    document.body.classList.toggle('has-welcome', show);
    editor.setIsland(ctx.islands.current() === 'main' && !show);
  }

  function refreshViews() {
    ctx.sidebar.refreshOutline();
    ctx.right.refresh();
    updateCount();
    updateWelcome();
  }
  ctx.refreshViews = refreshViews;

  let viewsTimer;
  editor.onChange((u) => {
    // images still being saved keep their place while the text around them changes
    const active = ctx.docs.active();
    for (const m of pendingImages) if (m.doc === active) m.pos = u.changes.mapPos(m.pos, 1);
    if (state.loading || !active) return;
    markChanged(active);
    updateWelcome();
    // the final view follows typing on its own (throttled); outline and mind map wait for a pause
    if (ctx.right.isOpen() && ctx.right.tab() === 'preview') ctx.right.refresh();
    clearTimeout(viewsTimer);
    viewsTimer = setTimeout(refreshViews, 250);
  });
  let countTimer;
  editor.onSelection(() => { clearTimeout(countTimer); countTimer = setTimeout(updateCount, 120); });
  editor.onScroll(() => {
    const idx = ctx.sidebar.highlight();
    ctx.mindmap.highlight(idx);
    ctx.right.sync();
  });

  // ---------- documents: switching, saving ----------
  ctx.onActivated = () => {
    updateTitle();
    ctx.mindmap.reset();
    refreshViews();
    if (ctx.right.isOpen() && ctx.right.tab() === 'history') ctx.history.render();
    if (ctx.find.isOpen()) ctx.find.close();
  };

  /**
   * Save `doc`. Saves of one document run one after another, never side by side.
   * opts.overwrite: replace the file even though it changed on disk, but only the exact
   * version named (the one a conflict reported) — an explicit user action.
   */
  function save(saveAs, doc = ctx.docs.active(), opts = {}) {
    if (!doc) return Promise.resolve(false);
    const next = (doc.saving || Promise.resolve()).catch(() => false).then(() => saveNow(saveAs, doc, opts));
    doc.saving = next;
    next.finally(() => { if (doc.saving === next) doc.saving = null; });
    return next;
  }
  /**
   * Images pasted while the document had no file live in the app's own folder (file:// links):
   * once it is saved they are copied in beside it and the links become relative, so they move and
   * sync with the document. The changed text is saved again (after this save).
   */
  async function adoptImages(doc, p, sent) {
    if (!api.adoptImages || !/file:\/\/[^)\s]*\/images\//.test(sent)) return;
    const moves = await api.adoptImages({ docPath: p, content: sent });
    if (!moves || !moves.length || !isOpen(doc) || doc.filePath !== p) return;
    const text = doc === ctx.docs.active() ? editor.getValue() : doc.state.doc.toString();
    const changes = [];
    for (const { from, to } of moves) for (let i = text.indexOf(from); i >= 0; i = text.indexOf(from, i + from.length)) changes.push({ from: i, to: i + from.length, insert: to });
    if (!changes.length) return;
    changes.sort((a, b) => a.from - b.from);
    if (doc === ctx.docs.active()) editor.view.dispatch({ changes, userEvent: 'input.image' });
    else { doc.state = doc.state.update({ changes }).state; doc.rev = (doc.rev || 0) + 1; doc.dirty = true; }
    save(false, doc);
  }
  async function saveNow(saveAs, doc, opts = {}) {
    if (!isOpen(doc)) return false;
    const rev = doc.rev || 0;
    const had = doc.filePath;
    const expectedVersion = opts.overwrite !== undefined ? opts.overwrite : (doc.diskVersion || null);
    const sent = ctx.docs.fileText(doc);
    const res = await api.save({ content: sent, saveAs, filePath: had, docId: doc.id, rev, suggest: doc.suggest || null, expectedVersion });
    if (!res) return false;
    if (res.conflict) { if (isOpen(doc)) onConflict(doc, res); return false; }
    const p = res.filePath;
    if (!isOpen(doc)) return true; // closed (discarded) while it was being written
    doc.diskVersion = res.version;
    doc.conflict = null;
    doc.savedRev = Math.max(doc.savedRev || 0, rev);
    doc.filePath = p;
    doc.suggest = null;
    doc.preview = false;
    const latest = (doc.rev || 0) === rev;
    doc.dirty = !latest;
    if (latest) {
      // exactly what is on disk now: its draft and pending timers are done with
      cancelTimers(doc);
      api.draft(doc.id, null);
    } else {
      // typed on while the file was written: keep the newer text protected
      scheduleDraft(doc, 0);
      scheduleAuto(doc);
    }
    const isActive = doc === ctx.docs.active();
    if (isActive && !env.mobile && (saveAs || !had || !state.autoSave)) toast(t('已保存', 'Saved')); // phones save on their own; the top bar shows it
    if (isActive) { state.filePath = p; state.dirty = doc.dirty; updateTitle(); }
    ctx.docs.sync();
    if (isActive && ctx.right.isOpen() && ctx.right.tab() === 'history') ctx.history.render();
    adoptImages(doc, p, sent).catch((err) => console.error("adopt images", err));
    if (p !== had) {
      if (isActive) { editor.setBase(baseUrl()); updateWelcome(); }
      if (!state.folder && !ctx.sidebar.inLibrary(p)) ctx.sidebar.setFolder(dirname(p)); else ctx.sidebar.refreshTree();
    }
    return true;
  }
  /**
   * The file changed on disk since this document read or wrote it (another window or
   * program). Nothing was written: the text stays as it is, unsaved, with its draft;
   * auto-save stops for it until the user reloads or overwrites.
   */
  function onConflict(doc, res) {
    doc.conflict = { currentVersion: res.currentVersion, filePath: res.filePath };
    cancelTimers(doc, ['auto']);
    if (doc.dirty) scheduleDraft(doc, 0);
    if (doc === ctx.docs.active()) updateTitle();
    ctx.docs.sync();
    toast(t('文件已被另一个窗口或外部程序修改，未覆盖磁盘内容。可在命令面板选择「从磁盘重新加载」或「覆盖磁盘上的文件」',
      'The file was changed by another window or program; the version on disk was not overwritten. Use “Reload from Disk” or “Overwrite File on Disk” in the command palette'), 9000);
  }
  /** Reload the active document from disk (its edits stay reachable with undo). */
  async function reloadFromDisk(doc = ctx.docs.active()) {
    if (!doc || !doc.filePath) { toast(t('这篇文档还没有保存到文件', 'This document has not been saved to a file')); return false; }
    const disk = await api.readDoc(doc.filePath);
    if (!disk) { toast(t('无法读取磁盘上的文件', 'Could not read the file on disk')); return false; }
    if (!isOpen(doc)) return false;
    await (doc.saving || Promise.resolve()).catch(() => {});
    const text = disk.content.replace(/\r\n/g, '\n');
    if (doc === ctx.docs.active()) { state.loading = true; editor.replaceAll(text, 'input.reload'); state.loading = false; }
    else doc.state = doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: text }, userEvent: 'input.reload' }).state;
    doc.eol = /\r\n/.test(disk.content) ? '\r\n' : '\n';
    doc.diskVersion = disk.version;
    doc.conflict = null;
    doc.rev = (doc.rev || 0) + 1; doc.savedRev = doc.rev; doc.dirty = false;
    cancelTimers(doc);
    api.draft(doc.id, null);
    if (doc === ctx.docs.active()) { state.dirty = false; updateTitle(); refreshViews(); }
    ctx.docs.sync();
    toast(t('已从磁盘重新加载（⌘Z 可找回刚才的内容）', 'Reloaded from disk (⌘Z brings your text back)').replace('⌘', isMac ? '⌘' : 'Ctrl+'));
    return true;
  }
  /** Save over the version a conflict reported — never over one changed since. */
  async function overwriteDisk(doc = ctx.docs.active()) {
    if (!doc || !doc.conflict) { toast(t('当前文档没有保存冲突', 'This document has no save conflict')); return false; }
    // the conflict was with another file (Save As): choose the target again instead
    if (doc.conflict.filePath !== doc.filePath) return save(true, doc);
    return save(false, doc, { overwrite: doc.conflict.currentVersion });
  }

  /** Save until the newest revision is on disk (closing a document or the window). */
  async function saveLatest(doc) {
    for (let i = 0; i < 5; i++) {
      if (!(await save(false, doc))) return false;
      if (!isOpen(doc) || !doc.dirty) return true;
    }
    return !doc.dirty;
  }
  ctx.save = save;
  ctx.saveLatest = saveLatest;
  ctx.forgetDoc = (doc) => cancelTimers(doc);

  // ---------- images: pasted, dropped or picked, always into the document they were meant for ----------
  const pendingImages = new Set(); // { doc, pos }: where the next image of a paste goes
  /** Insert text at `pos` of `doc`, active or not; returns the position after it. */
  function insertInto(doc, pos, text) {
    const active = doc === ctx.docs.active();
    const st = active ? editor.getState() : doc.state;
    pos = Math.max(0, Math.min(pos, st.doc.length));
    const line = st.doc.lineAt(pos);
    const insert = line.text.trim() && pos === line.to ? '\n\n' + text : text;
    if (active) {
      editor.view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true, userEvent: 'input.paste' });
    } else {
      doc.state = doc.state.update({ changes: { from: pos, insert }, userEvent: 'input.paste' }).state;
      markChanged(doc);
      for (const m of pendingImages) if (m.doc === doc && m.pos >= pos) m.pos += insert.length;
    }
    return pos + insert.length;
  }
  async function insertImages(files, pos, dropped) {
    const doc = ctx.docs.active();
    if (!doc) return;
    const docPath = doc.filePath; // links are relative to this, even if the document is switched meanwhile
    const mark = { doc, pos };
    pendingImages.add(mark);
    try {
      for (const f of files) {
        let src = null;
        try {
          const disk = dropped ? api.pathForFile(f) : null;
          src = disk ? await api.imageFile({ file: disk, docPath }) : await api.saveImage({ name: f.name, data: await f.arrayBuffer(), docPath });
        } catch (err) {
          toast(t('图片保存失败：', 'Could not save the image: ') + String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
          continue;
        }
        if (!src) continue;
        if (!isOpen(doc)) return; // the document was closed in the meantime
        const alt = (f.name || 'image').replace(/\.[^.]+$/, '');
        mark.pos = insertInto(doc, mark.pos, `![${alt}](${src})`);
      }
    } finally { pendingImages.delete(mark); }
  }
  ctx.docs = initDocs(ctx);

  async function renderDocument() {
    const stage = document.createElement('div');
    stage.innerHTML = renderMarkdown(editor.getValue(), { base: baseUrl() });
    await renderMermaidIn(stage);
    return stage.innerHTML;
  }
  async function exportDoc(type) {
    toast(t('正在导出…', 'Exporting…'));
    const body = await renderDocument();
    const meta = frontMatter(editor.getValue()).meta;
    const title = (meta && meta.title) || (state.filePath ? basename(state.filePath).replace(/\.[^.]+$/, '') : t('未命名', 'Untitled'));
    const r = await api.exportDoc({ type, body, title, theme: state.theme });
    if (!r) { hideToast(); return; }
    toast(r.note === 'truncated' ? t('文档太长，图片只包含了前面一部分：', 'Very long document; the image holds the first part: ') + r.path : t('已导出到 ', 'Exported to ') + r.path);
  }
  async function print() {
    $('#print-doc').innerHTML = await renderDocument();
    window.print();
    $('#print-doc').textContent = '';
  }

  function openLink(href) {
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1)).toLowerCase();
      const i = editor.headings().findIndex((h) => h.text.toLowerCase().replace(/\s+/g, '-') === id || h.text.toLowerCase() === id);
      if (i >= 0) editor.scrollToHeading(i);
      return;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && state.filePath) href = new URL(href, fileUrl(state.filePath)).href;
    api.openExternal(href);
  }

  // ---------- commands ----------
  const EDIT = new Set(['undo', 'redo', 'heading', 'heading-up', 'heading-down', 'table', 'code-block', 'math-block', 'quote', 'ordered-list', 'list', 'check',
    'line', 'toc', 'footnote', 'bold', 'italic', 'strike', 'inline-code', 'link', 'underline', 'mark', 'inline-math']);
  const commands = {
    save: () => save(false),
    'save-as': () => save(true),
    export: (type) => exportDoc(type),
    print: () => print(),
    'copy-md': () => { api.copyText(editor.selectionText() || editor.getValue()); toast(t('已拷贝 Markdown', 'Markdown copied')); },
    find: () => ctx.find.open(false),
    replace: () => ctx.find.open(true),
    'find-next': () => ctx.find.step(1),
    'find-prev': () => ctx.find.step(-1),
    image: async () => {
      const doc = ctx.docs.active();
      if (!doc) return;
      const src = await api.pickImage({ docPath: doc.filePath });
      if (!src || !isOpen(doc)) return;
      if (doc === ctx.docs.active()) { editor.focus(); editor.run('image', src); return; }
      // picked for a document that is no longer in front: put it at that document's caret
      const r = doc.state.selection.main;
      doc.state = doc.state.update({ changes: { from: r.from, to: r.to, insert: `![](${src})` }, userEvent: 'input' }).state;
      markChanged(doc);
    },
    source: () => {
      editor.setMode(editor.mode === 'live' ? 'source' : 'live');
      toast(editor.mode === 'live' ? t('所见即所得', 'Live preview') : t('源代码模式', 'Source code mode'));
      updateWelcome();
      editor.focus();
    },
    // editing area + display area: the Markdown source on the left, the rendered result on the right
    split: () => {
      const on = !(editor.mode === 'source' && ctx.right.isOpen() && ctx.right.tab() === 'preview');
      editor.setMode(on ? 'source' : 'live');
      ctx.right.setRight(on, 'preview');
      updateWelcome();
      toast(on ? t('分栏：左边源码，右边展示', 'Split: source on the left, result on the right') : t('所见即所得', 'Live preview'));
      editor.focus();
    },
    invisibles: () => {
      const on = !state.settings.showInvisibles;
      api.setSetting('showInvisibles', on);
      toast(on ? t('显示空格、Tab 和换行符', 'Showing invisible characters') : t('隐藏不可见字符', 'Invisible characters hidden'));
    },
    sidebar: () => ctx.sidebar.setSidebar(!ctx.sidebar.isOpen()),
    outline: () => ctx.sidebar.toggleCard('outline'),
    files: () => ctx.sidebar.toggleCard('files'),
    library: () => ctx.sidebar.showLibrary(),
    'open-folder': () => api.openFolderDialog(),
    mindmap: () => ctx.right.toggle('mindmap'),
    preview: () => ctx.right.toggle('preview'),
    'new-doc': () => { ctx.docs.newDoc(); },
    'close-doc': () => ctx.docs.close(),
    'switch-doc': () => { ctx.docs.switchNext(); },
    palette: () => (ctx.palette.isOpen() ? ctx.palette.close() : ctx.palette.open()),
    settings: () => (ctx.settingsUI.isOpen() ? ctx.settingsUI.close() : ctx.settingsUI.open()),
    search: () => ctx.search.open(),
    history: () => ctx.right.toggle('history'),
    theme: (id) => api.setSetting('theme', id),
    'island-move': (dir) => ctx.islands.moveCurrent(dir),
    // a save that found the file changed on disk: the user decides
    'conflict-reload': () => reloadFromDisk(),
    'conflict-overwrite': () => overwriteDisk(),
    // code blocks
    'code-compare': () => ctx.codeDiff.start(),
    'code-highlight': () => { if (!editor.run('code-highlight')) toast(t('把光标放进代码块，再高亮所在的行', 'Put the caret in a code block to highlight its lines')); },
    'code-fold': () => {
      const r = editor.run('code-fold');
      toast({ folded: t('已折叠，光标移出代码块后收起', 'Folded: it closes when the caret leaves the block'), unfolded: t('已展开', 'Unfolded'),
        short: t('这段代码太短，不需要折叠', 'This block is too short to fold') }[r] || t('把光标放进代码块', 'Put the caret in a code block'));
    },
    focus: () => { state.focus = !state.focus; editor.setFocusMode(state.focus); toast(state.focus ? t('专注模式', 'Focus mode') : t('退出专注模式', 'Focus mode off')); },
    typewriter: () => { state.typewriter = !state.typewriter; editor.setTypewriter(state.typewriter); toast(state.typewriter ? t('打字机模式', 'Typewriter mode') : t('退出打字机模式', 'Typewriter mode off')); },
    zoom: (d) => {
      state.zoom = d === 0 ? 1 : Math.min(2, Math.max(0.6, +(state.zoom + d * 0.1).toFixed(2)));
      document.documentElement.style.setProperty('--zoom', state.zoom);
      editor.view.requestMeasure();
      toast(Math.round(state.zoom * 100) + '%');
    },
  };
  function run(cmd, arg) {
    try {
      if (EDIT.has(cmd)) { if (!editor.hasFocus() && cmd !== 'undo' && cmd !== 'redo') editor.focus(); return editor.run(cmd, arg); }
      const fn = commands[cmd];
      return fn ? fn(arg) : undefined;
    } catch (err) { console.error(cmd, err); }
  }
  window.__whimflow = { run, state, editor, ctx };

  api.onCmd(async (cmd, arg) => {
    if (cmd === 'save-all' && typeof arg === 'string' && arg.startsWith('save-done-')) { api.reply(arg, await ctx.docs.saveAll()); return; }
    run(cmd, arg);
  });

  const CODE_KEY = { Minus: '-', Equal: '=', Slash: '/', Backquote: '`', Comma: ',', Period: '.' };
  const CELL_OWN = new Set(['bold', 'italic', 'underline', 'mark', 'link', 'inline-code', 'strike']);
  const FIELD_OK = new Set(['find', 'replace', 'find-next', 'find-prev', 'save', 'save-as', 'new-doc', 'close-doc', 'sidebar', 'outline', 'files', 'source', 'mindmap', 'preview', 'palette', 'undo', 'redo']);
  window.addEventListener('keydown', (e) => {
    if (!$('#modal').hidden) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (ctx.palette.isOpen() && !(mod && e.shiftKey && e.code === 'KeyP')) return;
    if (ctx.settingsUI.isOpen() && !(mod && e.code === 'Comma')) return;
    if (e.key === 'Escape' && ctx.find.isOpen()) { ctx.find.close(); e.preventDefault(); return; }
    const key = CODE_KEY[e.code] || (/^Digit\d$/.test(e.code) ? e.code.slice(5) : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase());
    const combo = (mod ? 'mod+' : '') + (isMac && e.ctrlKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + key;
    let hit = KEYS[combo];
    if (!hit && !isMac && mod) hit = KEYS[combo.replace(/^mod\+/, 'ctrl+')];
    if (!hit) return;
    // inside a table cell: the cell formats its own text; structural commands do not apply
    const inCell = e.target.closest && e.target.closest('.mf-cell');
    if (inCell && (CELL_OWN.has(hit[0]) || (EDIT.has(hit[0]) && hit[0] !== 'undo' && hit[0] !== 'redo'))) return;
    const inField = e.target instanceof HTMLInputElement;
    if (inField && !FIELD_OK.has(hit[0])) return;
    if (inField && (hit[0] === 'undo' || hit[0] === 'redo')) return; // let the field undo its own text
    e.preventDefault(); e.stopPropagation();
    run(hit[0], hit[1]);
  }, true);

  // the chrome steps back while you type
  document.addEventListener('keydown', (e) => { if ($('#editor').contains(e.target) && !e.metaKey && !e.ctrlKey && e.key.length === 1) document.body.classList.add('typing'); }, true);
  document.addEventListener('mousemove', () => document.body.classList.remove('typing'));

  // drop Markdown files onto the window to open them
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (e.target && e.target.closest && e.target.closest('#tree')) return; // onto the file tree: copied in (sidebar.js)
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    const docs = files.filter((f) => /\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(f.name));
    if (!docs.length) return;
    e.preventDefault(); e.stopPropagation();
    for (const f of docs) { const p = api.pathForFile(f); if (p) api.openPath(p); }
  }, true);

  // ---------- from the main process ----------
  // (braces matter: a listener's return value would be copied across the bridge, and a document cannot be)
  api.onLoad((d) => { ctx.docs.open(d); });
  api.onShowDoc((d) => { ctx.docs.show(d); });
  api.onJump((j) => { editor.jumpTo(j); });
  api.onFolder((dir) => { ctx.sidebar.setFolder(dir); ctx.sidebar.setSidebar(true, 'files'); });
  // sync: the sidebar shows how it is doing; files it brought in show up in the tree (open
  // documents follow on their own: a changed file is reported like any change on disk)
  if (api.onSyncStatus) {
    api.onSyncStatus((s) => {
      ctx.sidebar.setSync(s);
      if (s.changed) ctx.sidebar.refreshTree(); // the library is always in the tree
      const n = (s.conflicts || []).length;
      if (n) toast(t(`${n} 篇文档在两台设备上都改过，两份都保留了（名字里带「冲突」的是另一份）`, `${n} document(s) were changed on two devices; both versions are kept (the copy has "冲突" in its name)`));
    });
    api.syncConfig().then((c) => ctx.sidebar.setSync(c.status));
  }
  // a file or a whole folder was renamed: every open document inside follows it
  api.onRenamed(({ from, to }) => {
    let moved = false;
    for (const doc of ctx.docs.list()) {
      const np = remapPath(doc.filePath, from, to);
      if (!np) continue;
      doc.filePath = np;
      moved = true;
      if (doc.dirty) scheduleDraft(doc, 0); // the draft names the file it belongs to
    }
    const nf = remapPath(state.folder, from, to);
    if (nf) ctx.sidebar.setFolder(nf);
    ctx.sidebar.renamed(from, to);
    if (!moved) return;
    const active = ctx.docs.active();
    if (active && state.filePath !== active.filePath) { state.filePath = active.filePath; editor.setBase(baseUrl()); }
    updateTitle();
    ctx.docs.sync();
  });
  api.onFullscreen((f) => { document.body.classList.toggle('fullscreen', f); });
  // a file changed on disk: follow it, unless that document has unsaved edits
  api.onFileChanged(({ filePath, content, version }) => {
    const doc = ctx.docs.byPath(filePath);
    if (!doc || (version && version === doc.diskVersion)) return; // what this document already has (e.g. its own save)
    if (doc.dirty || doc.saving) return; // keep the edits; saving them will report the conflict
    doc.diskVersion = version || doc.diskVersion;
    doc.conflict = null;
    if (content.replace(/\r\n/g, '\n') === ctx.docs.textOf(doc)) return;
    doc.eol = /\r\n/.test(content) ? '\r\n' : '\n';
    if (doc !== ctx.docs.active()) { doc.state = editor.newState(content); return; }
    state.loading = true;
    editor.replaceAll(content.replace(/\r\n/g, '\n'), 'external');
    state.loading = false;
    refreshViews();
  });
  api.onSetting((k, v) => {
    state.settings[k] = v;
    applySettings(ctx, state.settings);
    if (k === 'drafts') {
      if (!v) {
        // off: nothing more is written, and what was written goes
        for (const d of ctx.docs.list()) cancelTimers(d, ['draft']);
        api.clearDrafts();
      } else {
        // on again: protect what is unsaved right now
        for (const d of ctx.docs.list()) if (d.dirty) api.draft(d.id, draftOf(d));
      }
    }
    if (k === 'autoSave') {
      state.autoSave = v;
      if (!v) for (const d of ctx.docs.list()) cancelTimers(d, ['auto']); // a save already under way finishes; no new ones start
      else for (const d of ctx.docs.list()) if (d.dirty && d.filePath) { if (d === ctx.docs.active()) save(false, d); else scheduleAuto(d); }
    }
    if (k === 'autoSaveDelay') for (const d of ctx.docs.list()) if (timersOf(d).auto) scheduleAuto(d);
    if (k === 'theme' && v !== state.theme) {
      state.theme = v;
      document.documentElement.dataset.theme = v;
      live.epoch = (live.epoch || 0) + 1; // re-draw diagrams in the new colours
      editor.setBase(baseUrl());
      setTimeout(() => ctx.right.refresh(true), 50);
    }
  });

  // ---------- boot ----------
  state.tab = 'browse';
  document.body.dataset.tab = state.tab;
  ctx.islands.applyOrder(false);
  ctx.islands.setIsland('main');
  ctx.docs.newDoc();
  await ctx.sidebar.setFolder(state.folder); // also draws the library
  if (state.folder || env.showLibrary) ctx.sidebar.setSidebar(true, 'files');
  else ctx.sidebar.setSidebar(!!env.settings.sidebar, 'outline');
  editor.focus();
  document.body.classList.add('ready');
  await api.ready();
  window.dispatchEvent(new Event('whimflow-ready')); // the iPhone / iPad interface attaches here
})();
