'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const isMac = process.platform === 'darwin';
const MD_EXT = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt'];
const images = require('./main/images');
const exporter = require('./main/exporter');
const fileops = require('./main/fileops');
const { createSearch } = require('./main/search');
const IMG_EXT = images.IMG;

// End-to-end tests (WHIMFLOW_TEST=1 only) reach in here to slow an IPC call down,
// answer a dialog, or make the Trash fail. Never present in normal use.
const testHooks = process.env.WHIMFLOW_TEST ? (globalThis.__whimflowTest = { delay: {}, answer: {}, trashItem: null, searchTimeout: null }) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** ipcMain.handle, plus the optional test delay for that channel. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    if (testHooks && testHooks.delay[channel]) await sleep(testHooks.delay[channel]);
    return fn(...args);
  });
}
/** A message box; tests may answer it in advance (by `kind`). */
function ask(win, kind, opts) {
  if (testHooks && testHooks.answer[kind] != null) return Promise.resolve({ response: testHooks.answer[kind] });
  return dialog.showMessageBox(win, opts);
}
const search = createSearch({ timeout: () => (testHooks && testHooks.searchTimeout) || undefined });

// ---------- the app's own folder (it was "MarkFlow" before: see main/migrate.js) ----------
try {
  require('./main/migrate').adoptOldFolder({ appData: app.getPath('appData'), name: app.getName(), userData: app.getPath('userData') });
} catch (err) { console.error('could not copy the old settings folder', err); }

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  theme: 'daylight', autoSave: false, autoSaveDelay: 2, recent: [], sidebar: false, lastFolder: null,
  fontSize: 16, lineWidth: 1200, /* 1200 = no limit: the text fills the editor */ lineHeight: 1.7, docFont: 'serif',
  closeBrackets: true, indent: 4, spellcheck: false, showInvisibles: false,
  imageFolder: './assets', imageRelative: true, imageCopy: true,
  drafts: true, history: true, historyKeep: 50, language: 'auto',
};
// Settings the renderer may change, and that every window is told about.
const SHARED = Object.keys(DEFAULTS).filter((k) => !['recent', 'lastFolder'].includes(k));
let settings = { ...DEFAULTS };
const shared = () => Object.fromEntries(SHARED.map((k) => [k, settings[k]]));
const recovery = require('./main/recovery')(app);
const history = require('./main/history')(app, () => settings.historyKeep);
// v2: the default line width became "no limit". A settings file from before still holds
// the old default (720) because every setting is written out; that one moves to the new
// default once. A width the user picks afterwards is kept.
const SETTINGS_VERSION = 2;
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); Object.assign(settings, saved); } catch (_) {}
  if (saved && !(saved.settingsVersion >= 2) && saved.lineWidth === 720) settings.lineWidth = DEFAULTS.lineWidth;
  const upgrade = saved && saved.settingsVersion !== SETTINGS_VERSION;
  settings.settingsVersion = SETTINGS_VERSION;
  if (upgrade) saveSettings();
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (_) {}
}

let zh = false;
const t = (z, e) => (zh ? z : e);

// ---------- windows ----------
const wins = new Map(); // id -> {win, filePath, dirty, watcher, folder}
let pendingOpen = []; // files requested before ready

function stateOf(win) { return win && wins.get(win.id); }
function focused() { return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]; }

function createWindow(opts = {}) {
  const cur = BrowserWindow.getFocusedWindow();
  const pos = cur ? { x: cur.getPosition()[0] + 28, y: cur.getPosition()[1] + 28 } : {};
  const win = new BrowserWindow({
    width: 1000, height: 760, minWidth: 420, minHeight: 300, ...pos,
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    // The window buttons (about 16 pt tall) share one centre line with the header rows
    // drawn by app.css: 28 px from the top (window padding 6 + border 1 + header 21).
    trafficLightPosition: { x: 14, y: 20 },
    backgroundColor: ['midnight', 'slate'].includes(settings.theme) ? '#262624' : '#faf9f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: true,
    },
  });
  // docs/activeId mirror what the renderer has open; filePath and dirty describe the
  // active document and "any unsaved document" respectively.
  const st = { win, docs: [], activeId: null, filePath: null, dirty: false, watchers: new Map(), drafts: new Set(),
    folder: opts.folder || null, init: opts, draftBase: recovery.newId(), pendingRecover: new Map() };
  wins.set(win.id, st);
  const id = win.id;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openExternal(url); });

  win.on('close', (e) => {
    if (!st.dirty || st.forceClose) return;
    e.preventDefault();
    if (st.closing) return; // already asking
    st.closing = true;
    confirmSave(st).then((answer) => {
      st.closing = false;
      if (win.isDestroyed()) return;
      if (answer === 'discard' || (answer === 'saved' && !st.dirty)) { st.forceClose = true; win.close(); }
      else if (answer === 'saved') win.close(); // edited again while saving: ask about the new changes
    });
  });
  // closing only happens once unsaved changes were saved or deliberately discarded
  win.on('closed', () => { for (const w of st.watchers.values()) { try { w.close(); } catch (_) {} } wins.delete(id); search.cancel(id); for (const d of st.drafts) recovery.remove(d); });
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  return st;
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  else if (/^file:/i.test(url)) {
    try {
      const p = require('url').fileURLToPath(url);
      if (MD_EXT.includes(path.extname(p).slice(1).toLowerCase())) openPath(p);
      else shell.openPath(p);
    } catch (_) {}
  }
}

/** Before a window with unsaved documents closes: 'saved', 'discard' or 'cancel'. */
async function confirmSave(st) {
  const unsaved = st.docs.filter((d) => d.dirty);
  const name = unsaved.length === 1 ? (unsaved[0].filePath ? path.basename(unsaved[0].filePath) : t('未命名', 'Untitled')) : null;
  const { response } = await ask(st.win, 'close-window', {
    type: 'warning',
    message: name ? t(`是否保存对 “${name}” 的更改？`, `Do you want to save the changes made to “${name}”?`)
      : t(`有 ${unsaved.length} 篇文档尚未保存，是否保存？`, `${unsaved.length} documents have unsaved changes. Save them?`),
    detail: t('如果不保存，你的更改将会丢失。', "Your changes will be lost if you don't save them."),
    buttons: [name ? t('保存', 'Save') : t('全部保存', 'Save All'), t('取消', 'Cancel'), t('不保存', "Don't Save")],
    defaultId: 0, cancelId: 1,
  });
  if (response === 1) return 'cancel';
  if (response === 2) return 'discard';
  return (await requestSave(st)) ? 'saved' : 'cancel';
}

function requestSave(st) {
  return new Promise((resolve) => {
    const ch = 'save-done-' + Date.now() + Math.random();
    ipcMain.once(ch, (_e, ok) => resolve(!!ok));
    st.win.webContents.send('cmd', 'save-all', ch);
  });
}

// ---------- file ops ----------
// one watcher per open file; a change on disk is sent to the window with its path
function syncWatchers(st) {
  const paths = new Set(st.docs.map((d) => d.filePath).filter(Boolean));
  for (const [p, w] of st.watchers) if (!paths.has(p)) { try { w.close(); } catch (_) {} st.watchers.delete(p); }
  for (const p of paths) if (!st.watchers.has(p)) watchFile(st, p);
}
function watchFile(st, p) {
  let timer = null, w = null;
  try {
    w = fs.watch(p, (type) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (st.win.isDestroyed()) return;
        // the file was replaced (a save writes a new file and renames it into place): watch the new one
        if (type === 'rename' && st.watchers.get(p) === w) {
          try { w.close(); } catch (_) {}
          st.watchers.delete(p);
          if (fs.existsSync(p) && hasDoc(st, p)) watchFile(st, p);
        }
        // every window hears about every change, its own saves included: the renderer compares
        // the version with what it last read or wrote and ignores what it already has
        try { const buf = await fsp.readFile(p); st.win.webContents.send('file-changed', { filePath: p, content: buf.toString('utf8'), version: fileops.hashOf(buf) }); } catch (_) {}
      }, 200);
    });
    st.watchers.set(p, w);
  } catch (_) { /* unwatchable (e.g. removed) */ }
}
const hasDoc = (st, p) => st.docs.some((d) => d.filePath === p);

function addRecent(p) {
  settings.recent = [p, ...settings.recent.filter((x) => x !== p)].slice(0, 12);
  saveSettings();
  try { app.addRecentDocument(p); } catch (_) {}
  buildMenu();
}

async function loadInto(st, filePath, jump, opts = {}) {
  let buf;
  try { buf = await fsp.readFile(filePath); }
  catch (err) {
    dialog.showErrorBox(t('无法打开文件', 'Cannot open file'), String(err.message || err));
    return false;
  }
  const content = buf.toString('utf8');
  addRecent(filePath);
  if (settings.history) history.snapshot(filePath, content);
  // version: the file as read; a later save only replaces the file if it is still this version
  st.win.webContents.send('load', { filePath, content, version: fileops.hashOf(buf), jump, preview: !!opts.preview });
  return true;
}

// Open a file as a document in the focused window (or the window that already has it).
async function openPath(p, target) {
  p = path.resolve(p);
  let stat;
  try { stat = await fsp.stat(p); } catch (_) { return; }
  if (stat.isDirectory()) return openFolder(p, target);
  for (const s of wins.values()) if (hasDoc(s, p)) { s.win.focus(); s.win.webContents.send('show-doc', { filePath: p }); return; }
  const st = target || stateOf(focused());
  if (!st) { createWindow({ files: [p] }); return; }
  if (st.loaded) await loadInto(st, p); else (st.init.files = st.init.files || []).push(p);
}

function openFolder(dir, target) {
  let st = target || stateOf(focused());
  settings.lastFolder = dir; saveSettings();
  if (!st) { createWindow({ folder: dir }); return; }
  st.folder = dir;
  if (st.loaded) st.win.webContents.send('folder', dir); else st.init.folder = dir;
}

async function readTree(dir, depth = 0) {
  if (depth > 6) return [];
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push({ name: e.name, path: full, dir: true, children: await readTree(full, depth + 1) });
    else if (MD_EXT.includes(path.extname(e.name).slice(1).toLowerCase())) out.push({ name: e.name, path: full, dir: false });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
  return out;
}

// ---------- IPC ----------
const W = (e) => stateOf(BrowserWindow.fromWebContents(e.sender));

ipcMain.on('copy-text', (_e, text) => { clipboard.writeText(String(text == null ? '' : text)); });
ipcMain.handle('init', (e) => {
  const st = W(e);
  return {
    settings: shared(),
    folder: st.folder, zh, isMac, platform: process.platform, home: os.homedir(),
  };
});

ipcMain.handle('ready', async (e) => {
  const st = W(e);
  st.loaded = true;
  // Drafts left by a crash come back as unsaved documents, then the files asked for.
  // Several drafts may name the same file (it was open in two windows): each one is
  // sent, and the renderer keeps every different text. A draft file is removed only
  // when the renderer confirms it has the text (see 'recovered').
  for (const rec of (st.init && st.init.recover) || []) {
    st.pendingRecover.set(rec.id, rec);
    const exists = !!rec.filePath && fs.existsSync(rec.filePath);
    // the draft remembers which version of the file its text was based on, so saving it
    // cannot silently replace a newer one (drafts from before versions: the file as it is now)
    let version = typeof rec.version === 'string' ? rec.version : null;
    if (exists && !version) { try { const v = await fileops.fileVersion(rec.filePath); version = v && v.sha256; } catch (_) { version = null; } }
    st.win.webContents.send('load', { filePath: exists ? rec.filePath : null, missingPath: rec.filePath || null, content: rec.content, version: exists ? version : null, recovered: true, draftId: rec.id });
  }
  for (const f of (st.init && st.init.files) || []) loadInto(st, f, st.init.jump);
});
// the renderer holds a recovered text (and has written its own draft of it): the old draft can go
handle('recovered', (e, draftId) => {
  const st = W(e);
  if (!st || !st.pendingRecover.has(draftId)) return false;
  st.pendingRecover.delete(draftId);
  recovery.remove(draftId);
  return true;
});

// the renderer's list of open documents: [{ id, filePath, dirty }] and which one is active
ipcMain.handle('docs', (e, docs, activeId) => {
  const st = W(e); if (!st) return;
  st.docs = Array.isArray(docs) ? docs : [];
  st.activeId = activeId;
  const active = st.docs.find((d) => d.id === activeId);
  st.filePath = (active && active.filePath) || null;
  st.dirty = st.docs.some((d) => d.dirty);
  if (isMac) { st.win.setRepresentedFilename(st.filePath || ''); st.win.setDocumentEdited(st.dirty); }
  syncWatchers(st);
});

// draft(docId, { filePath, content }) keeps one document's unsaved text; draft(docId, null) drops it
handle('draft', (e, docId, payload) => {
  const st = W(e); if (!st) return false;
  const key = String(docId == null ? '' : docId).replace(/[^\w-]/g, '');
  if (!key) return false;
  const id = `${st.draftBase}-${key}`;
  if (payload == null || !settings.drafts) { recovery.remove(id); st.drafts.delete(id); return false; }
  const ok = recovery.write(id, { filePath: payload.filePath || null, content: String(payload.content), version: typeof payload.version === 'string' ? payload.version : null });
  if (ok) st.drafts.add(id);
  return ok;
});
// drop every draft this window has written (drafts were turned off)
handle('drafts-clear', (e) => {
  const st = W(e); if (!st) return;
  for (const id of st.drafts) recovery.remove(id);
  st.drafts.clear();
});
ipcMain.handle('confirm-close-doc', async (e, name) => {
  if (process.env.WHIMFLOW_TEST_CONFIRM) return process.env.WHIMFLOW_TEST_CONFIRM;
  const st = W(e);
  const { response } = await dialog.showMessageBox(st.win, {
    type: 'warning',
    message: t(`是否保存对 “${name}” 的更改？`, `Do you want to save the changes made to “${name}”?`),
    detail: t('如果不保存，你的更改将会丢失。', "Your changes will be lost if you don't save them."),
    buttons: [t('保存', 'Save'), t('取消', 'Cancel'), t('不保存', "Don't Save")], defaultId: 0, cancelId: 1,
  });
  return ['save', 'cancel', 'discard'][response];
});
ipcMain.handle('close-window', (e) => { const st = W(e); if (st) { st.forceClose = true; st.win.close(); } });
handle('history-list', (e, filePath) => { const st = W(e); return st && filePath && hasDoc(st, filePath) ? history.list(filePath) : null; });
handle('history-read', (e, filePath, id) => { const st = W(e); return st && filePath && hasDoc(st, filePath) ? history.read(filePath, id) : null; });
handle('search', (e, { folder, query, opts }) => search.run(BrowserWindow.fromWebContents(e.sender).id, folder, query, opts));

ipcMain.handle('ensure-width', (e, need) => {
  const st = W(e); if (!st || st.win.isFullScreen() || st.win.isMaximized()) return;
  const b = st.win.getBounds();
  const wa = require('electron').screen.getDisplayMatching(b).workArea;
  const width = Math.min(Math.round(need), wa.width);
  if (b.width >= width) return;
  const x = Math.max(wa.x, Math.min(b.x - Math.round((width - b.width) / 2), wa.x + wa.width - width));
  st.win.setBounds({ x, y: b.y, width, height: b.height }, true);
});

ipcMain.handle('set-title', (e, title) => { const st = W(e); if (st) st.win.setTitle(title); });

// Saves to one file run one after another, each replacing the file atomically.
//  - Version check: a save names the version of the file it was based on
//    (expectedVersion, a SHA-256; null for a file that should not exist yet). Right
//    before writing, inside the queue, the file is hashed again; if it is now a
//    different version (another window or program wrote it), nothing is written and
//    the answer is a conflict. Saving over that version takes an explicit second save
//    naming it (the renderer's "Overwrite" command).
//  - Revision check: a save also carries its document's id and revision; one older than
//    a revision already written for that document is not written (it would put back
//    older text). That protects typing during a save within one window.
// Answers: { ok: true, filePath, version } | { ok: false, conflict: true, … } | null (cancelled or failed)
const saveQueue = fileops.keyedQueue();
const writtenRev = new Map(); // path -> { owner, rev, version }
function saveDialog(st, opts) {
  if (testHooks && testHooks.answer.saveDialog !== undefined) {
    const a = testHooks.answer.saveDialog;
    return Promise.resolve(a ? { canceled: false, filePath: a } : { canceled: true });
  }
  return dialog.showSaveDialog(st.win, opts);
}
handle('save', async (e, { content, saveAs, filePath, docId, rev, suggest, expectedVersion }) => {
  const st = W(e);
  content = String(content);
  let p = filePath || null;
  let expected = typeof expectedVersion === 'string' ? expectedVersion : null;
  if (!p || saveAs) {
    const m = /^#{1,6}\s+(.+)$/m.exec(content);
    const guess = (m ? m[1].replace(/[\\/:*?"<>|#`*_]/g, '').trim().slice(0, 60) : '') || t('未命名', 'Untitled');
    const r = await saveDialog(st, {
      defaultPath: p || (suggest && path.isAbsolute(suggest) ? suggest : path.join(st.folder || app.getPath('documents'), guess + '.md')),
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }, { name: t('所有文件', 'All Files'), extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return null;
    p = r.filePath;
    // Another file: the user agreed (in the dialog) to replace what is there right now,
    // and only that: nothing for a new file, this exact version for an existing one.
    if (p !== filePath) {
      try { const v = await fileops.fileVersion(p); expected = v ? v.sha256 : null; }
      catch (err) { return saveFailed(err); }
    }
  }
  const owner = `${st.win.id}:${docId}`;
  const result = await saveQueue(p, async () => {
    if (testHooks && testHooks.delay['save:write']) await sleep(testHooks.delay['save:write']);
    let cur;
    try { cur = await fileops.fileVersion(p); } catch (err) { return saveFailed(err); }
    const current = cur ? cur.sha256 : null;
    const last = writtenRev.get(p);
    if (docId != null && Number.isFinite(rev) && last && last.owner === owner && rev < last.rev && current === last.version) {
      return { ok: true, filePath: p, version: current, skipped: true }; // a newer revision of this document is already on disk
    }
    if (current !== expected) {
      return { ok: false, conflict: true, filePath: p, expectedVersion: expected, currentVersion: current,
        current: cur ? { size: cur.size, mtimeMs: cur.mtimeMs } : null };
    }
    try {
      await fileops.writeFileAtomic(p, content);
    } catch (err) { return saveFailed(err); }
    const version = fileops.contentVersion(content);
    if (docId != null && Number.isFinite(rev)) writtenRev.set(p, { owner, rev, version });
    if (settings.history) history.snapshot(p, content);
    return { ok: true, filePath: p, version };
  });
  if (!result || !result.ok) return result || null;
  if (p !== filePath) addRecent(p);
  return result;
});
function saveFailed(err) {
  console.error('save failed', err);
  if (!process.env.WHIMFLOW_TEST) dialog.showErrorBox(t('保存失败', 'Save failed'), String(err.message || err));
  return null;
}
// the file as it is on disk now (for "Reload from Disk"); only for documents open in this window
handle('read-doc', async (e, p) => {
  const st = W(e);
  if (!st || !p || !hasDoc(st, p)) return null;
  try { const buf = await fsp.readFile(p); return { content: buf.toString('utf8'), version: fileops.hashOf(buf) }; } catch (_) { return null; }
});

ipcMain.handle('open-in-window', async (e, p, jump, opts) => {
  const st = W(e);
  if (hasDoc(st, p)) { st.win.webContents.send('show-doc', { filePath: p, jump, pin: !(opts && opts.preview) }); return true; }
  for (const s of wins.values()) if (s !== st && hasDoc(s, p)) { s.win.focus(); s.win.webContents.send('show-doc', { filePath: p, jump }); return false; }
  return loadInto(st, p, jump, opts);
});
ipcMain.handle('reveal-url', (_e, url) => { try { shell.showItemInFolder(require('url').fileURLToPath(url)); } catch (_) { /* not a file */ } });
ipcMain.handle('open-path', (_e, p) => openPath(p));
ipcMain.handle('open-folder-dialog', () => openDialog(true));
ipcMain.handle('read-tree', (_e, dir) => readTree(dir));
ipcMain.handle('open-external', (_e, url) => openExternal(url));
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
// Move to Trash, or nothing at all: if the system cannot trash the item it stays put
// and the renderer is told why. ({ ok } | { ok: false, error } | { ok: false, canceled })
handle('trash', async (e, p) => {
  const st = W(e);
  const { response } = await ask(st.win, 'trash', {
    type: 'warning', message: t(`将 “${path.basename(p)}” 移到废纸篓？`, `Move “${path.basename(p)}” to Trash?`),
    buttons: [t('移到废纸篓', 'Move to Trash'), t('取消', 'Cancel')], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return { ok: false, canceled: true };
  return fileops.moveToTrash(p, { trashItem: (x) => (testHooks && testHooks.trashItem ? testHooks.trashItem(x) : shell.trashItem(x)) });
});
ipcMain.handle('create-file', async (_e, { dir, name, isDir }) => {
  if (!name || /[\\/]/.test(name)) return null;
  if (!isDir && !path.extname(name)) name += '.md';
  const p = path.join(dir, name);
  if (fs.existsSync(p)) return null;
  if (isDir) await fsp.mkdir(p); else await fsp.writeFile(p, '');
  return p;
});
// Renaming a folder moves every open document inside it: each window is told
// (renamed { from, to }) and maps its documents, folder and drafts itself.
handle('rename', async (_e, { from, name }) => {
  if (!name || /[\\/]/.test(name)) return null;
  const to = path.join(path.dirname(from), name);
  if (to === from || fs.existsSync(to)) return null;
  try { await fsp.rename(from, to); } catch (_) { return null; }
  const move = (p) => fileops.remapPath(p, from, to);
  for (const s of wins.values()) {
    let touched = false;
    for (const d of s.docs) { const np = move(d.filePath); if (np) { d.filePath = np; touched = true; } }
    const nf = move(s.folder); if (nf) { s.folder = nf; touched = true; }
    if (s.filePath) s.filePath = move(s.filePath) || s.filePath;
    if (touched) { syncWatchers(s); s.win.webContents.send('renamed', { from, to }); }
  }
  settings.recent = settings.recent.map((p) => move(p) || p);
  if (settings.lastFolder) settings.lastFolder = move(settings.lastFolder) || settings.lastFolder;
  saveSettings(); buildMenu();
  return to;
});

// Image calls name the document they are for (docPath, null for an unsaved one):
// the link is made relative to that document even if another one is active by the
// time the file is written. Without docPath the active document is meant.
const docPathFor = (st, req) => {
  if (!req || !Object.prototype.hasOwnProperty.call(req, 'docPath')) return st.filePath;
  return req.docPath && hasDoc(st, req.docPath) ? req.docPath : null;
};
handle('save-image', async (e, req) => {
  const st = W(e);
  return images.saveImage(settings, docPathFor(st, req), app.getPath('userData'), req.name, req.data);
});
// a dropped image file: copy it next to the document, or link to it where it is
handle('image-file', async (e, req) => {
  const st = W(e);
  const file = typeof req === 'string' ? req : req.file;
  const docPath = typeof req === 'string' ? st.filePath : docPathFor(st, req);
  if (!settings.imageCopy) return images.linkFor(settings, docPath, file);
  return images.saveImage(settings, docPath, app.getPath('userData'), path.basename(file), await fsp.readFile(file));
});

handle('pick-image', async (e, req) => {
  const st = W(e);
  const docPath = docPathFor(st, req);
  const r = await dialog.showOpenDialog(st.win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: IMG_EXT }] });
  if (r.canceled || !r.filePaths[0]) return null;
  if (settings.imageCopy) return images.saveImage(settings, docPath, app.getPath('userData'), path.basename(r.filePaths[0]), await fsp.readFile(r.filePaths[0]));
  return images.linkFor(settings, docPath, r.filePaths[0]);
});

const EXPORTS = { pdf: 'PDF', html: 'HTML', docx: 'Word', png: 'PNG' };
ipcMain.handle('export', async (e, { type, body, title, theme }) => {
  const st = W(e);
  if (!EXPORTS[type]) return null;
  const base = st.filePath ? st.filePath.replace(/\.[^.\\/]+$/, '') : path.join(app.getPath('documents'), t('未命名', 'Untitled'));
  const r = process.env.WHIMFLOW_TEST_EXPORT ? { filePath: process.env.WHIMFLOW_TEST_EXPORT + '.' + type } : await dialog.showSaveDialog(st.win, {
    defaultPath: base + '.' + type,
    filters: [{ name: EXPORTS[type], extensions: [type] }],
  });
  if (r.canceled || !r.filePath) return null;
  const page = { body, title, theme };
  let note = null;
  try {
    if (type === 'html') await fsp.writeFile(r.filePath, exporter.buildHtml(page), 'utf8');
    else if (type === 'pdf') await fsp.writeFile(r.filePath, await exporter.toPdf(page, st.filePath));
    else if (type === 'docx') await fsp.writeFile(r.filePath, await exporter.toDocx(page, st.filePath));
    else { const out = await exporter.toPng(page, st.filePath); await fsp.writeFile(r.filePath, out.data); if (out.truncated) note = 'truncated'; }
  } catch (err) {
    console.error('export failed', err);
    if (!process.env.WHIMFLOW_TEST) dialog.showErrorBox(t('导出失败', 'Export failed'), String(err.message || err));
    return null;
  }
  return { path: r.filePath, note };
});

ipcMain.handle('set-setting', (_e, k, v) => setSetting(k, v));
function setSetting(k, v) {
  if (!SHARED.includes(k) || typeof v !== typeof DEFAULTS[k]) return;
  settings[k] = v; saveSettings();
  for (const s of wins.values()) s.win.webContents.send('setting', k, v);
  if (k === 'theme' || k === 'autoSave') buildMenu();
}

ipcMain.handle('tree-menu', (e, item) => {
  const st = W(e);
  const send = (action) => st.win.webContents.send('tree-action', action, item);
  const tpl = [
    { label: t('新建文件', 'New File'), click: () => send('new-file') },
    { label: t('新建文件夹', 'New Folder'), click: () => send('new-folder') },
  ];
  if (item.path !== st.folder) {
    tpl.push({ type: 'separator' },
      { label: t('重命名', 'Rename'), click: () => send('rename') },
      { label: t('移到废纸篓', 'Move to Trash'), click: () => send('trash') });
  }
  if (!item.dir) tpl.push({ label: t('在新窗口中打开', 'Open in New Window'), click: () => createWindow({ files: [item.path], folder: st.folder }) });
  tpl.push({ type: 'separator' }, { label: isMac ? t('在访达中显示', 'Reveal in Finder') : t('打开所在位置', 'Show in Folder'), click: () => shell.showItemInFolder(item.path) });
  Menu.buildFromTemplate(tpl).popup({ window: st.win });
});

// ---------- menu ----------
function send(cmd, arg) {
  const w = focused();
  if (w) w.webContents.send('cmd', cmd, arg);
  else if (cmd === 'new-doc') createWindow();
}
// Shortcuts are handled in the renderer (so they also win over the editor's own
// key handling); the menu only displays them.
const item = (label, cmd, accelerator, arg) => ({
  label, accelerator, registerAccelerator: false, click: () => send(cmd, arg),
});

async function openDialog(folder) {
  const w = focused();
  const r = await dialog.showOpenDialog(w, folder
    ? { properties: ['openDirectory', 'createDirectory'] }
    : { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: MD_EXT }, { name: t('所有文件', 'All Files'), extensions: ['*'] }] });
  if (r.canceled) return;
  for (const p of r.filePaths) await openPath(p);
}

const THEMES = [
  ['daylight', '象牙 Ivory'], ['paper', '纸张 Paper'], ['mint', '鼠尾草 Sage'],
  ['slate', '暖夜 Dusk'], ['midnight', '深夜 Night'],
];

function buildMenu() {
  const recent = settings.recent.filter((p) => fs.existsSync(p));
  const tpl = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: t('关于 WhimFlow', 'About WhimFlow') },
        { type: 'separator' },
        item(t('偏好设置…', 'Settings…'), 'settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: t('文件', 'File'),
      submenu: [
        item(t('新建', 'New'), 'new-doc', 'CmdOrCtrl+N'),
        { label: t('新建窗口', 'New Window'), accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        { label: t('打开…', 'Open…'), accelerator: 'CmdOrCtrl+O', click: () => openDialog(false) },
        { label: t('打开文件夹…', 'Open Folder…'), click: () => openDialog(true) },
        {
          label: t('打开最近使用', 'Open Recent'),
          submenu: [
            ...recent.map((p) => ({ label: p.replace(os.homedir(), '~'), click: () => openPath(p) })),
            ...(recent.length ? [{ type: 'separator' }] : []),
            { label: t('清除最近使用', 'Clear Recent'), enabled: recent.length > 0, click: () => { settings.recent = []; saveSettings(); try { app.clearRecentDocuments(); } catch (_) {} buildMenu(); } },
          ],
        },
        { type: 'separator' },
        item(t('保存', 'Save'), 'save', 'CmdOrCtrl+S'),
        item(t('另存为…', 'Save As…'), 'save-as', 'CmdOrCtrl+Shift+S'),
        { label: t('自动保存', 'Auto Save'), type: 'checkbox', checked: !!settings.autoSave, click: (mi) => setSetting('autoSave', mi.checked) },
        item(t('历史版本…', 'Version History…'), 'history'),
        { type: 'separator' },
        {
          label: t('导出', 'Export'),
          submenu: [item('PDF', 'export', undefined, 'pdf'), item('HTML', 'export', undefined, 'html'), item('Word (.docx)', 'export', undefined, 'docx'), item(t('图片 (PNG)', 'Image (PNG)'), 'export', undefined, 'png')],
        },
        item(t('打印…', 'Print…'), 'print', 'CmdOrCtrl+P'),
        { type: 'separator' },
        { label: isMac ? t('在访达中显示', 'Reveal in Finder') : t('打开文件位置', 'Show in Folder'), click: () => { const s = stateOf(focused()); if (s && s.filePath) shell.showItemInFolder(s.filePath); } },
        { type: 'separator' },
        ...(isMac ? [] : [item(t('偏好设置…', 'Settings…'), 'settings', 'Ctrl+,'), { type: 'separator' }]),
        item(t('关闭文档', 'Close Document'), 'close-doc', 'CmdOrCtrl+W'),
        { role: 'close', label: t('关闭窗口', 'Close Window'), accelerator: 'CmdOrCtrl+Shift+W' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: t('编辑', 'Edit'),
      submenu: [
        item(t('撤销', 'Undo'), 'undo', 'CmdOrCtrl+Z'),
        item(t('重做', 'Redo'), 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        { role: 'cut', label: t('剪切', 'Cut') }, { role: 'copy', label: t('拷贝', 'Copy') }, { role: 'paste', label: t('粘贴', 'Paste') },
        { role: 'pasteAndMatchStyle', label: t('粘贴为纯文本', 'Paste as Plain Text') },
        item(t('拷贝为 Markdown', 'Copy as Markdown'), 'copy-md', 'CmdOrCtrl+Shift+C'),
        { role: 'selectAll', label: t('全选', 'Select All') },
        { type: 'separator' },
        item(t('查找', 'Find'), 'find', 'CmdOrCtrl+F'),
        item(t('查找下一个', 'Find Next'), 'find-next', 'CmdOrCtrl+G'),
        item(t('查找上一个', 'Find Previous'), 'find-prev', 'CmdOrCtrl+Shift+G'),
        item(t('替换', 'Replace'), 'replace', isMac ? 'Cmd+Alt+F' : 'Ctrl+H'),
        { type: 'separator' },
        item(t('在文件夹中搜索', 'Search in Folder'), 'search', 'CmdOrCtrl+Shift+F'),
      ],
    },
    {
      label: t('段落', 'Paragraph'),
      submenu: [
        ...[1, 2, 3, 4, 5, 6].map((n) => item(t(`${'一二三四五六'[n - 1]}级标题`, `Heading ${n}`), 'heading', `CmdOrCtrl+${n}`, n)),
        item(t('段落', 'Paragraph'), 'heading', 'CmdOrCtrl+0', 0),
        { type: 'separator' },
        item(t('提升标题级别', 'Increase Heading Level'), 'heading-up', 'CmdOrCtrl+='),
        item(t('降低标题级别', 'Decrease Heading Level'), 'heading-down', 'CmdOrCtrl+-'),
        { type: 'separator' },
        item(t('表格', 'Table'), 'table', 'CmdOrCtrl+Alt+T'),
        item(t('代码块', 'Code Fences'), 'code-block', 'CmdOrCtrl+Alt+C'),
        item(t('公式块', 'Math Block'), 'math-block', 'CmdOrCtrl+Alt+B'),
        { type: 'separator' },
        item(t('引用', 'Quote'), 'quote', 'CmdOrCtrl+Alt+Q'),
        item(t('有序列表', 'Ordered List'), 'ordered-list', 'CmdOrCtrl+Alt+O'),
        item(t('无序列表', 'Unordered List'), 'list', 'CmdOrCtrl+Alt+U'),
        item(t('任务列表', 'Task List'), 'check', 'CmdOrCtrl+Alt+X'),
        { type: 'separator' },
        item(t('水平分割线', 'Horizontal Line'), 'line', 'CmdOrCtrl+Alt+-'),
        item(t('目录', 'Table of Contents'), 'toc'),
        item(t('脚注', 'Footnote'), 'footnote', 'CmdOrCtrl+Alt+R'),
      ],
    },
    {
      label: t('格式', 'Format'),
      submenu: [
        item(t('加粗', 'Strong'), 'bold', 'CmdOrCtrl+B'),
        item(t('斜体', 'Emphasis'), 'italic', 'CmdOrCtrl+I'),
        item(t('下划线', 'Underline'), 'underline', 'CmdOrCtrl+U'),
        item(t('代码', 'Code'), 'inline-code', 'Ctrl+`'),
        item(t('删除线', 'Strike'), 'strike', 'Ctrl+Shift+`'),
        item(t('高亮', 'Highlight'), 'mark', 'CmdOrCtrl+Shift+H'),
        item(t('行内公式', 'Inline Math'), 'inline-math', 'Ctrl+M'),
        { type: 'separator' },
        item(t('超链接', 'Hyperlink'), 'link', 'CmdOrCtrl+K'),
        item(t('图像…', 'Image…'), 'image', 'CmdOrCtrl+Ctrl+I'),
      ],
    },
    {
      label: t('视图', 'View'),
      submenu: [
        item(t('源代码模式', 'Source Code Mode'), 'source', 'CmdOrCtrl+/'),
        item(t('分栏：源码 + 展示', 'Split: Source + Preview'), 'split', 'CmdOrCtrl+Alt+/'),
        item(t('显示空格、Tab 和换行符', 'Show Invisible Characters'), 'invisibles', 'CmdOrCtrl+Shift+.'),
        { type: 'separator' },
        item(t('显示 / 隐藏侧边栏', 'Toggle Sidebar'), 'sidebar', 'CmdOrCtrl+Shift+L'),
        item(t('大纲', 'Outline'), 'outline', 'CmdOrCtrl+Shift+1'),
        item(t('文件树', 'File Tree'), 'files', 'CmdOrCtrl+Shift+3'),
        { type: 'separator' },
        item(t('思维导图', 'Mind Map'), 'mindmap', 'CmdOrCtrl+Shift+M'),
        item(t('正式稿', 'Final View'), 'preview', 'CmdOrCtrl+Shift+R'),
        item(t('命令面板…', 'Command Palette…'), 'palette', 'CmdOrCtrl+Shift+P'),
        { type: 'separator' },
        item(t('专注模式', 'Focus Mode'), 'focus', 'F8'),
        item(t('打字机模式', 'Typewriter Mode'), 'typewriter', 'F9'),
        { type: 'separator' },
        item(t('实际大小', 'Actual Size'), 'zoom', 'CmdOrCtrl+Shift+9', 0),
        item(t('放大', 'Zoom In'), 'zoom', 'CmdOrCtrl+Shift+=', 1),
        item(t('缩小', 'Zoom Out'), 'zoom', 'CmdOrCtrl+Shift+-', -1),
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('切换全屏', 'Toggle Full Screen') },
        { role: 'toggleDevTools', label: t('开发者工具', 'Developer Tools') },
      ],
    },
    {
      label: t('主题', 'Themes'),
      submenu: THEMES.map(([id, label]) => ({
        label, type: 'radio', checked: settings.theme === id,
        click: () => setSetting('theme', id),
      })),
    },
    {
      label: t('窗口', 'Window'), role: 'window',
      submenu: [
        { role: 'minimize', label: t('最小化', 'Minimize') }, { role: 'zoom', label: t('缩放', 'Zoom') },
        item(t('切换文档', 'Switch Document'), 'switch-doc', 'Ctrl+Tab'),
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: t('全部置于顶层', 'Bring All to Front') }] : []),
      ],
    },
    {
      role: 'help', label: t('帮助', 'Help'),
      submenu: [
        { label: t('Markdown 参考', 'Markdown Reference'), click: () => openPath(path.join(__dirname, '..', 'docs', 'Markdown-Reference.md')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---------- app lifecycle ----------
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (app.isReady()) openPath(p); else pendingOpen.push(p);
});

const gotLock = process.env.WHIMFLOW_TEST ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const files = argv.slice(1).filter((a) => !a.startsWith('-') && fs.existsSync(a));
    if (files.length) files.forEach((f) => openPath(f));
    else { const w = focused(); if (w) { if (w.isMinimized()) w.restore(); w.focus(); } else createWindow(); }
  });

  app.whenReady().then(() => {
    if (testHooks) testHooks.createWindow = (opts) => { createWindow(opts); };
    loadSettings();
    zh = /^zh/i.test(process.env.WHIMFLOW_LANG || (settings.language !== 'auto' ? settings.language : app.getLocale()));
    nativeTheme.themeSource = 'system';
    buildMenu();
    const args = process.argv.slice(1).filter((a) => !a.startsWith('-') && fs.existsSync(a) && path.resolve(a) !== app.getAppPath());
    const files = [...pendingOpen, ...args];
    pendingOpen = [];
    // drafts left behind by a crash come back first
    const drafts = settings.drafts ? recovery.leftovers() : [];
    const dirs = files.map((f) => path.resolve(f)).filter((f) => fs.statSync(f).isDirectory());
    const docs = files.map((f) => path.resolve(f)).filter((f) => !dirs.includes(f));
    createWindow({ recover: drafts, files: docs, folder: dirs[0] || null });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}
