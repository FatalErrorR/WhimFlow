// window.api for iPhone and iPad (Capacitor): the same calls the desktop's main process
// answers (see src/preload.js), built on the app's own storage.
//
//   Documents/            the library (visible in the Files app): Markdown files, folders, images
//   Documents/.Trash/     what was deleted (moved, never erased)
//   Library/drafts/       unsaved text, for crash recovery
//   Library/history/      a snapshot per save
//   Preferences           settings and the recent list
//
// The interface sees paths under a fixed root (/WhimFlow/...), never the app's container
// path, which iOS may change between updates. The same safety rules as on the desktop:
// a save names the version it was based on and is refused if the file changed; a save
// never leaves half a file behind (a full temporary copy is written first); a draft is
// only let go once its text is safe.
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';
import { platform } from '../paths.js';

export const ROOT = '/WhimFlow';
const DOCS = Directory.Documents, LIB = Directory.Library;
const MD = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;
const IMG = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'heic', 'avif'];
const DEFAULTS = {
  theme: 'daylight', autoSave: true, autoSaveDelay: 1, recent: [], sidebar: false, lastFolder: null,
  fontSize: 17, lineWidth: 1200, lineHeight: 1.7, docFont: 'serif',
  closeBrackets: true, indent: 4, spellcheck: true, showInvisibles: false,
  imageFolder: './assets', imageRelative: true, imageCopy: true,
  drafts: true, history: true, historyKeep: 50, language: 'auto', lineBreaks: true,
};

// ---------- paths ----------
const rel = (p) => {
  if (!p || (p !== ROOT && !p.startsWith(ROOT + '/'))) throw new Error('Outside the library: ' + p);
  return p.slice(ROOT.length + 1);
};
const join = (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/');
const dirOf = (p) => p.replace(/\/[^/]*$/, '') || ROOT;
const baseOf = (p) => p.replace(/^.*\//, '');
const isTmp = (n) => n.endsWith('.mftmp');

// ---------- small file helpers ----------
const read = (p) => Filesystem.readFile({ path: rel(p), directory: DOCS, encoding: Encoding.UTF8 }).then((r) => r.data);
const exists = (p) => Filesystem.stat({ path: rel(p), directory: DOCS }).then(() => true, () => false);
const write = (p, data) => Filesystem.writeFile({ path: rel(p), directory: DOCS, data, encoding: Encoding.UTF8, recursive: true });
async function hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function versionOf(p) { try { return await hash(await read(p)); } catch (_) { return null; } }

/** One task at a time per key (saves to one file never overlap). */
const queues = new Map();
function serial(key, task) {
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(key, next.catch(() => {}));
  return next;
}

/**
 * Replace a file without ever leaving half of it: the whole text goes to a temporary
 * file first; only then is the old file removed and the new one moved into place. If
 * the app is stopped in between, finishTemps() completes the move at the next start.
 */
async function safeWrite(p, text) {
  const tmp = p + '.mftmp';
  await write(tmp, text);
  if (await exists(p)) await Filesystem.deleteFile({ path: rel(p), directory: DOCS });
  await Filesystem.rename({ from: rel(tmp), to: rel(p), directory: DOCS, toDirectory: DOCS });
}
async function finishTemps(dir = ROOT) {
  let ents = [];
  try { ents = (await Filesystem.readdir({ path: rel(dir) || '', directory: DOCS })).files; } catch (_) { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.type === 'directory') { if (!e.name.startsWith('.')) await finishTemps(p); continue; }
    if (!isTmp(e.name)) continue;
    const target = p.slice(0, -'.mftmp'.length);
    try {
      if (await exists(target)) await Filesystem.deleteFile({ path: rel(p), directory: DOCS }); // the old file is intact (and a draft holds the edits)
      else await Filesystem.rename({ from: rel(p), to: rel(target), directory: DOCS, toDirectory: DOCS }); // finish an interrupted save
    } catch (_) { /* leave it for next time */ }
  }
}

// ---------- events (the main process's webContents.send) ----------
const listeners = {};
const on = (ch) => (fn) => { (listeners[ch] = listeners[ch] || []).push(fn); };
const emit = (ch, ...a) => { for (const fn of listeners[ch] || []) { try { fn(...a); } catch (err) { console.error(ch, err); } } };

export function createMobileApi(hooks = {}) {
  let settings = { ...DEFAULTS };
  let docs = [];                         // the renderer's open documents: [{ id, filePath, dirty }]
  const drafts = new Set();
  const pendingRecover = new Map();
  const draftBase = Math.random().toString(16).slice(2, 10);
  const writtenRev = new Map();
  const hasDoc = (p) => docs.some((d) => d.filePath === p);
  const zh = /^zh/i.test(navigator.language || 'zh');
  const t = (z, e) => (zh ? z : e);

  async function saveSettings() { await Preferences.set({ key: 'settings', value: JSON.stringify(settings) }); }
  async function addRecent(p) {
    settings.recent = [p, ...settings.recent.filter((x) => x !== p)].slice(0, 30);
    await saveSettings();
  }

  // ----- drafts and history live in Library/ (not shown in the Files app) -----
  const libWrite = (path, data) => Filesystem.writeFile({ path, directory: LIB, data, encoding: Encoding.UTF8, recursive: true });
  const libRead = (path) => Filesystem.readFile({ path, directory: LIB, encoding: Encoding.UTF8 }).then((r) => r.data);
  const libList = (path) => Filesystem.readdir({ path, directory: LIB }).then((r) => r.files, () => []);
  const libDelete = (path) => Filesystem.deleteFile({ path, directory: LIB }).catch(() => {});
  const histDir = async (p) => 'history/' + (await hash(p)).slice(0, 20);
  async function snapshot(p, content) {
    if (!settings.history) return;
    const dir = await histDir(p);
    const ids = (await libList(dir)).map((f) => f.name).filter((n) => /^\d+\.md$/.test(n)).map((n) => +n.slice(0, -3)).sort((a, b) => b - a);
    if (ids.length) { try { if ((await libRead(`${dir}/${ids[0]}.md`)) === content) return; } catch (_) { /* unreadable */ } }
    const id = Math.max(Date.now(), (ids[0] || 0) + 1);
    await libWrite(`${dir}/${id}.md`, content);
    for (const old of [id, ...ids].slice(Math.max(1, settings.historyKeep))) await libDelete(`${dir}/${old}.md`);
  }
  async function leftovers() {
    const out = [];
    for (const f of await libList('drafts')) {
      if (!f.name.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await libRead('drafts/' + f.name));
        d.id = f.name.slice(0, -5);
        if (typeof d.content !== 'string') continue;
        if (d.filePath) { try { if ((await read(d.filePath)) === d.content) { await libDelete('drafts/' + f.name); continue; } } catch (_) { /* gone: keep */ } }
        if (!d.filePath && !d.content.trim()) { await libDelete('drafts/' + f.name); continue; }
        out.push(d);
      } catch (_) { /* unreadable */ }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  // ----- the library -----
  /** Rename or move: never over an existing item; open documents and the recent list follow. */
  async function relocate(from, to) {
    if (to === from || (await exists(to))) return null;
    try { await Filesystem.rename({ from: rel(from), to: rel(to), directory: DOCS, toDirectory: DOCS }); } catch (_) { return null; }
    settings.recent = settings.recent.map((p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p));
    await saveSettings();
    emit('renamed', { from, to });
    return to;
  }
  async function readTree(dir = ROOT, depth = 0) {
    if (depth > 6) return [];
    let ents = [];
    try { ents = (await Filesystem.readdir({ path: rel(dir) || '', directory: DOCS })).files; } catch (_) { return []; }
    const out = [];
    for (const e of ents) {
      if (e.name.startsWith('.') || isTmp(e.name)) continue;
      const p = join(dir, e.name);
      if (e.type === 'directory') { if (!/^(assets|.*\.assets)$/.test(e.name)) out.push({ name: e.name, path: p, dir: true, mtime: +e.mtime || 0, children: await readTree(p, depth + 1) }); }
      else if (MD.test(e.name)) out.push({ name: e.name, path: p, dir: false, mtime: +e.mtime || 0, size: e.size || 0 });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
    return out;
  }
  async function loadInto(p, jump, opts = {}) {
    let content;
    try { content = await read(p); } catch (err) { hooks.toast && hooks.toast(t('无法打开：', 'Cannot open: ') + baseOf(p)); return false; }
    await addRecent(p);
    snapshot(p, content);
    emit('load', { filePath: p, content, version: await hash(content), jump, preview: !!opts.preview });
    return true;
  }
  /** A free name in `dir`: "name.md", "name 2.md", … */
  async function freeName(dir, name) {
    const m = /^(.*?)(\.[^.]+)?$/.exec(name);
    for (let i = 1; i < 1000; i++) {
      const p = join(dir, i === 1 ? name : `${m[1]} ${i}${m[2] || ''}`);
      if (!(await exists(p))) return p;
    }
    throw new Error('No free name in ' + dir);
  }
  const titleOf = (content) => {
    const m = /^#{1,6}\s+(.+)$/m.exec(content);
    return ((m ? m[1] : content.split('\n').find((l) => l.trim()) || '').replace(/[\\/:*?"<>|#`*_[\]]/g, '').trim().slice(0, 40)) || t('未命名', 'Untitled');
  };

  // ----- search, in a worker so a runaway expression can be stopped -----
  let searchWorker = null;
  const WORKER = `onmessage = (e) => {
    const { files, query, opts } = e.data; let re;
    try { const src = opts.regex ? query : query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      re = new RegExp(opts.word ? '\\\\b(?:' + src + ')\\\\b' : src, opts.caseSensitive ? 'g' : 'gi'); }
    catch (err) { postMessage({ error: String(err.message), code: 'invalid', files: [], total: 0 }); return; }
    const out = []; let total = 0, capped = false;
    for (const f of files) {
      const lines = f.text.split('\\n'), matches = [];
      for (let i = 0; i < lines.length && total < 2000; i++) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(lines[i])) && total < 2000) {
          if (!m[0].length) { re.lastIndex++; continue; }
          const start = Math.max(0, m.index - 40);
          matches.push({ line: i + 1, col: m.index, len: m[0].length, text: lines[i].slice(start, m.index + m[0].length + 80), at: m.index - start }); total++;
        }
      }
      if (matches.length) out.push({ path: f.path, name: f.name, rel: f.rel, matches });
      if (total >= 2000) { capped = true; break; }
    }
    postMessage({ files: out, total, capped });
  };`;
  async function search({ folder, query, opts = {} }) {
    if (searchWorker) { searchWorker.terminate(); searchWorker = null; }
    if (!query) return { files: [], total: 0, capped: false };
    const files = [];
    const walk = async (nodes) => { for (const n of nodes) { if (n.dir) await walk(n.children); else { try { files.push({ path: n.path, name: n.name, rel: dirOf(n.path).slice((folder || ROOT).length + 1), text: await read(n.path) }); } catch (_) { /* skip */ } } } };
    await walk(await readTree(folder || ROOT));
    return new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })));
      searchWorker = w;
      const timer = setTimeout(() => { w.terminate(); if (searchWorker === w) searchWorker = null; resolve({ error: 'timeout', code: 'timeout', files: [], total: 0 }); }, 8000);
      w.onmessage = (e) => { clearTimeout(timer); w.terminate(); if (searchWorker === w) searchWorker = null; resolve(e.data); };
      w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ error: String(e.message), code: 'failed', files: [], total: 0 }); };
      w.postMessage({ files, query, opts });
    });
  }

  // ----- images: next to the document, under a name nobody else has -----
  async function saveImage({ name, data, docPath }) {
    if (docPath === undefined) docPath = (docs.find((d) => d.active) || {}).filePath || null;
    const dir = docPath ? join(dirOf(docPath), settings.imageFolder.replace(/^\.\//, '').replace(/\$\{filename\}/g, baseOf(docPath).replace(/\.[^.]+$/, '')))
      : join(ROOT, 'assets');
    let ext = (/\.([^.]+)$/.exec(name || '') || [])[1];
    ext = IMG.includes((ext || '').toLowerCase()) ? ext.toLowerCase() : 'png';
    let base = (name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w一-龥.-]+/g, '-') || 'image';
    if (base === 'image') base = 'image-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bytes = new Uint8Array(data);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return serial('images:' + dir, async () => {
      let p = null;
      for (let i = 0; i < 10000 && !p; i++) { const c = join(dir, i ? `${base}-${i}.${ext}` : `${base}.${ext}`); if (!(await exists(c))) p = c; }
      await Filesystem.writeFile({ path: rel(p), directory: DOCS, data: btoa(bin), recursive: true });
      if (!docPath) return 'assets/' + encodeURIComponent(baseOf(p)); // shown relative to the library root
      const from = dirOf(docPath).split('/'), to = p.split('/');
      let i = 0; while (i < from.length && from[i] === to[i]) i++;
      return [...from.slice(i).map(() => '..'), ...to.slice(i)].map((s) => (s === '..' ? s : encodeURIComponent(s).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))).join('/');
    });
  }

  const api = {
    async init() {
      try { const v = (await Preferences.get({ key: 'settings' })).value; if (v) settings = { ...DEFAULTS, ...JSON.parse(v) }; } catch (_) { /* first start */ }
      await Filesystem.mkdir({ path: '', directory: DOCS, recursive: true }).catch(() => {});
      await finishTemps();
      platform.fileUrlFn = await api.mobile.fileUrlFor(); // images inside documents load through the app's file URLs
      return { settings: { ...settings }, folder: ROOT, zh, isMac: true, platform: 'ios', home: ROOT, mobile: true };
    },
    async ready() {
      // drafts left by an earlier run come back as unsaved documents; the draft file
      // goes only once the window has its text (see recovered)
      if (!settings.drafts) return;
      for (const rec of await leftovers()) {
        pendingRecover.set(rec.id, rec);
        const there = rec.filePath && (await exists(rec.filePath).catch(() => false));
        let version = typeof rec.version === 'string' ? rec.version : null;
        if (there && !version) version = await versionOf(rec.filePath);
        emit('load', { filePath: there ? rec.filePath : null, missingPath: rec.filePath || null, content: rec.content, version: there ? version : null, recovered: true, draftId: rec.id });
      }
    },
    async recovered(id) { if (!pendingRecover.has(id)) return false; pendingRecover.delete(id); await libDelete(`drafts/${id}.json`); return true; },
    async syncDocs(list, activeId) { docs = (Array.isArray(list) ? list : []).map((d) => ({ ...d, active: d.id === activeId })); },
    async draft(docId, payload) {
      const key = String(docId == null ? '' : docId).replace(/[^\w-]/g, '');
      if (!key) return false;
      const id = `${draftBase}-${key}`;
      if (payload == null || !settings.drafts) { await libDelete(`drafts/${id}.json`); drafts.delete(id); return false; }
      try {
        await libWrite(`drafts/${id}.json.tmp`, JSON.stringify({ filePath: payload.filePath || null, content: String(payload.content), version: payload.version || null, savedAt: Date.now() }));
        await libDelete(`drafts/${id}.json`);
        await Filesystem.rename({ from: `drafts/${id}.json.tmp`, to: `drafts/${id}.json`, directory: LIB, toDirectory: LIB });
        drafts.add(id);
        return true;
      } catch (_) { return false; }
    },
    async clearDrafts() { for (const id of drafts) await libDelete(`drafts/${id}.json`); drafts.clear(); },
    async confirmCloseDoc() { return 'save'; }, // documents save themselves on iPhone and iPad
    async closeWindow() { hooks.lastDocClosed && hooks.lastDocClosed(); },
    async setTitle() {},
    async ensureWidth() {},

    /** Save: the same answers as the desktop (see 'save' in src/main.js). */
    async save({ content, saveAs, filePath, docId, rev, expectedVersion }) {
      content = String(content);
      let p = filePath || null;
      let expected = typeof expectedVersion === 'string' ? expectedVersion : null;
      if (!p || saveAs) {
        // no save dialog on a phone: a new document becomes a file named after its title
        const dir = p ? dirOf(p) : (hooks.currentFolder && hooks.currentFolder()) || ROOT;
        p = await freeName(dir, titleOf(content) + '.md');
        expected = null;
      }
      const owner = String(docId);
      const result = await serial(p, async () => {
        const current = await versionOf(p);
        const last = writtenRev.get(p);
        if (docId != null && Number.isFinite(rev) && last && last.owner === owner && rev < last.rev && current === last.version) return { ok: true, filePath: p, version: current, skipped: true };
        if (current !== expected) return { ok: false, conflict: true, filePath: p, expectedVersion: expected, currentVersion: current, current: null };
        try { await safeWrite(p, content); } catch (err) { console.error('save failed', err); hooks.toast && hooks.toast(t('保存失败：', 'Save failed: ') + (err.message || err)); return null; }
        const version = await hash(content);
        if (docId != null && Number.isFinite(rev)) writtenRev.set(p, { owner, rev, version });
        snapshot(p, content);
        return { ok: true, filePath: p, version };
      });
      if (result && result.ok && p !== filePath) await addRecent(p);
      return result;
    },
    async readDoc(p) { if (!hasDoc(p)) return null; try { const content = await read(p); return { content, version: await hash(content) }; } catch (_) { return null; } },
    async openInWindow(p, jump, opts) { if (hasDoc(p)) { emit('show-doc', { filePath: p, jump, pin: !(opts && opts.preview) }); return true; } return loadInto(p, jump, opts); },
    async openPath(p) { return api.openInWindow(p, null, { preview: false }); },
    readTree: (dir) => readTree(dir || ROOT),
    async createFile({ dir, name, isDir }) {
      if (!name || /[\\/]/.test(name)) return null;
      if (!isDir && !/\.[^.]+$/.test(name)) name += '.md';
      const p = join(dir || ROOT, name);
      if (await exists(p)) return null;
      if (isDir) await Filesystem.mkdir({ path: rel(p), directory: DOCS, recursive: true });
      else await write(p, '');
      return p;
    },
    async rename({ from, name }) {
      if (!name || /[\\/]/.test(name)) return null;
      return relocate(from, join(dirOf(from), name));
    },
    /** Move a file or folder into another folder of the library, keeping its name. */
    async move({ from, dir }) {
      if (!dir || (dir !== ROOT && !dir.startsWith(ROOT + '/'))) return null;
      if (dir === from || dir.startsWith(from + '/')) return null; // not into itself
      return relocate(from, join(dir, baseOf(from)));
    },
    /** Delete = move into Documents/.Trash (kept; nothing is erased). */
    async trash(p) {
      const ok = await (hooks.confirm ? hooks.confirm(t(`将 “${baseOf(p)}” 移到「最近删除」？`, `Move “${baseOf(p)}” to Recently Deleted?`)) : true);
      if (!ok) return { ok: false, canceled: true };
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      try {
        await Filesystem.mkdir({ path: '.Trash', directory: DOCS, recursive: true }).catch(() => {});
        await Filesystem.rename({ from: rel(p), to: `.Trash/${stamp}-${baseOf(p)}`, directory: DOCS, toDirectory: DOCS });
        settings.recent = settings.recent.filter((x) => x !== p && !x.startsWith(p + '/'));
        await saveSettings();
        return { ok: true };
      } catch (err) { return { ok: false, error: String(err.message || err) }; }
    },
    async historyList(p) {
      if (!p || !hasDoc(p)) return null;
      const dir = await histDir(p);
      return (await libList(dir)).map((f) => f.name).filter((n) => /^\d+\.md$/.test(n)).map((n) => +n.slice(0, -3)).sort((a, b) => b - a).map((id) => ({ id, time: id, size: 0 }));
    },
    async historyRead(p, id) { if (!p || !hasDoc(p)) return null; try { return await libRead(`${await histDir(p)}/${Number(id)}.md`); } catch (_) { return null; } },
    search,
    saveImage,
    async imageFile() { return null; },
    async pickImage(req = {}) {
      const file = await new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = () => resolve(inp.files && inp.files[0]);
        inp.click();
      });
      if (!file) return null;
      return saveImage({ name: file.name, data: await file.arrayBuffer(), docPath: Object.prototype.hasOwnProperty.call(req, 'docPath') ? req.docPath : undefined });
    },
    /** Export on a phone means: share it (HTML or the Markdown itself). */
    async exportDoc({ type, body, title }) {
      if (!['html', 'md'].includes(type)) { hooks.toast && hooks.toast(t('iPhone 和 iPad 上可以分享 HTML 或 Markdown；PDF、Word 和长图请在电脑上导出', 'On iPhone and iPad you can share HTML or Markdown; export PDF, Word and images on a computer')); return null; }
      const name = (title || 'WhimFlow').replace(/[\\/:*?"<>|]/g, '') + '.' + type;
      const data = type === 'html' ? `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}` : body;
      const w = await Filesystem.writeFile({ path: 'share/' + name, directory: Directory.Cache, data, encoding: Encoding.UTF8, recursive: true });
      try { await Share.share({ title: name, url: w.uri }); } catch (_) { return null; }
      return { path: name, note: null };
    },
    async setSetting(k, v) {
      if (!(k in DEFAULTS) || ['recent', 'lastFolder'].includes(k) || typeof v !== typeof DEFAULTS[k]) return;
      settings[k] = v;
      await saveSettings();
      emit('setting', k, v);
    },
    async treeMenu(item) { hooks.treeMenu && hooks.treeMenu(item, (action) => emit('tree-action', action, item)); },
    async openExternal(url) { if (/^(https?|mailto):/i.test(url)) window.open(url, '_blank'); },
    async openFolderDialog() {}, async reveal() {}, async revealUrl() {},
    reply() {},
    copyText: (s) => { navigator.clipboard && navigator.clipboard.writeText(String(s)).catch(() => {}); },
    pathForFile: () => null,
    onCmd: on('cmd'), onLoad: on('load'), onFolder: on('folder'), onSetting: on('setting'), onFileChanged: on('file-changed'),
    onRenamed: on('renamed'), onTreeAction: on('tree-action'), onJump: on('jump'), onShowDoc: on('show-doc'), onFullscreen: on('fullscreen'),
    // for the mobile interface
    mobile: { ROOT, readTree, recent: () => settings.recent.slice(), read, exists, stat: (p) => Filesystem.stat({ path: rel(p), directory: DOCS }), titleOf, emit,
      writeFile: (p, text) => write(p, String(text)), // a plain write into the library (imports; tests acting as another device)
      hash },
  };

  // images in the documents are shown through the app's own file URL
  api.mobile.fileUrlFor = async () => {
    const { uri } = await Filesystem.getUri({ path: '', directory: DOCS });
    const root = uri.replace(/\/$/, '');
    return (p) => {
      const real = root + '/' + rel(p).split('/').map(encodeURIComponent).join('/');
      return Capacitor.isNativePlatform() ? Capacitor.convertFileSrc(real) : real;
    };
  };
  return api;
}
