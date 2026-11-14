// Several documents in one window, without a tab bar. The title is the switcher:
// a dot per open document sits next to it, hovering lists them, and ⌃Tab cycles
// through them in most-recently-used order. With a single document nothing shows.
import { $, t, basename, dirname, toast } from '../util.js';

export function initDocs(ctx) {
  const { api, editor, state } = ctx;
  // { id, filePath, state, scrollTop, dirty, preview, n, rev, savedRev, diskVersion, conflict?, label?, suggest? }
  // rev counts edits; savedRev is the newest revision known to be on disk (see app.js);
  // diskVersion is the SHA-256 of the file as this document last read or wrote it
  const docs = [];
  const mru = [];           // same documents, most recently used first
  let active = null, seq = 0, untitled = 0;

  const nameOf = (d) => (d.filePath ? basename(d.filePath) : d.label || t('未命名', 'Untitled') + (d.n > 1 ? ' ' + d.n : ''));
  const textOf = (d) => (d === active ? editor.getValue() : d.state.doc.toString());
  // the editor works with \n; a file that came with Windows line endings is written back with them
  const fileText = (d) => (d.eol === '\r\n' ? textOf(d).replace(/\n/g, '\r\n') : textOf(d));
  const pristine = (d) => !d.filePath && !d.dirty && !textOf(d).trim();

  function create(text = '') {
    const d = { id: 'd' + (++seq) + Date.now().toString(36), filePath: null, state: editor.newState(text), scrollTop: 0, dirty: false, preview: false, n: ++untitled, rev: 0, savedRev: 0, diskVersion: null, conflict: null };
    docs.push(d); mru.push(d);
    return d;
  }
  function sync() {
    api.syncDocs(docs.map((d) => ({ id: d.id, filePath: d.filePath, dirty: d.dirty })), active && active.id);
    renderSwitch();
    ctx.sidebar.markActiveFile();
  }
  /** Show `d`. `fresh` means its stored state must be shown even if it is already the active one. */
  function activate(d, { jump, fresh } = {}) {
    if (active === d && !fresh) { if (jump) editor.jumpTo(jump); return; }
    if (active && active !== d) { active.state = editor.getState(); active.scrollTop = editor.scrollDOM.scrollTop; }
    active = d;
    mru.splice(mru.indexOf(d), 1); mru.unshift(d);
    state.filePath = d.filePath; state.dirty = d.dirty;
    editor.setBase(ctx.baseUrl(), true);
    state.loading = true;
    editor.setState(d.state, d.scrollTop);
    state.loading = false;
    ctx.onActivated();
    sync();
    editor.focus();
    if (jump) setTimeout(() => editor.jumpTo(jump), 30);
  }

  /** A file arriving from the main process (opened, clicked in the tree, recovered after a crash). */
  function open({ filePath, content, version, jump, recovered, preview, draftId, missingPath }) {
    if (recovered) return openRecovered({ filePath, content, version, draftId, missingPath });
    let d = filePath && docs.find((x) => x.filePath === filePath);
    if (d) { if (!preview) d.preview = false; activate(d, { jump }); return d; }
    d = slot(preview);
    Object.assign(d, { filePath, state: editor.newState(content), scrollTop: 0, dirty: false, preview: !!preview, eol: eolOf(content), rev: 0, savedRev: 0, diskVersion: version || null, conflict: null, label: null, suggest: null });
    activate(d, { jump, fresh: true });
    if (!state.folder && filePath) ctx.sidebar.setFolder(dirname(filePath));
    return d;
  }
  const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');
  /** The document a newly opened file goes into: a blank untitled one, the preview slot, or a new one. */
  function slot(preview) {
    if (active && pristine(active)) return active;
    const p = preview && docs.find((x) => x.preview && !x.dirty);
    return p || create();
  }

  /**
   * Text recovered from a crash. Several drafts can name the same file (it was open in
   * two windows); none is dropped: the first becomes that file's document, every
   * different text becomes a "recovered copy" next to it. The old draft is only let go
   * (api.recovered) once this window has written a draft of its own for the text.
   */
  async function openRecovered({ filePath, content, version, draftId, missingPath }) {
    const text = content.replace(/\r\n/g, '\n');
    const same = docs.find((x) => textOf(x) === text && (x.filePath === filePath || (!x.filePath && x.dirty)));
    if (same) { if (draftId) api.recovered(draftId); return same; } // this exact text is already open
    const taken = filePath && docs.some((x) => x.filePath === filePath);
    let d;
    if (taken) {
      d = create();
      const name = basename(filePath);
      Object.assign(d, { filePath: null, label: t(`${name}（恢复副本）`, `${name} (recovered copy)`),
        suggest: filePath.replace(/(\.[^./\\]+)?$/, (ext) => t('（恢复副本）', ' (recovered)') + (ext || '.md')) });
    } else {
      d = slot(false);
      Object.assign(d, { filePath, label: !filePath && missingPath ? t(`${basename(missingPath)}（已恢复）`, `${basename(missingPath)} (recovered)`) : null, suggest: !filePath ? missingPath : null });
    }
    // a recovered copy is a new file; otherwise the version the draft's text was based on
    Object.assign(d, { state: editor.newState(content), scrollTop: 0, dirty: true, preview: false, eol: eolOf(content), rev: 1, savedRev: 0, diskVersion: d.filePath ? version || null : null, conflict: null });
    activate(d, { fresh: true });
    if (!state.folder && filePath) ctx.sidebar.setFolder(dirname(filePath));
    toast(taken ? t('已恢复上次没来得及保存的内容（另一个窗口的版本另存为恢复副本）', 'Recovered unsaved text (another window’s version opened as a recovered copy)')
      : t('已恢复上次没来得及保存的内容', 'Recovered the text you hadn’t saved last time'));
    const kept = await api.draft(d.id, ctx.draftOf(d));
    if (draftId && (kept || !state.settings.drafts)) api.recovered(draftId);
    return d;
  }
  function show({ filePath, jump, pin }) {
    const d = docs.find((x) => x.filePath === filePath);
    if (!d) return;
    if (pin) d.preview = false;
    activate(d, { jump });
    renderSwitch();
  }
  function newDoc() { const d = active && pristine(active) ? active : create(); activate(d); return d; }
  function pin(filePath) { const d = docs.find((x) => x.filePath === filePath); if (d && d.preview) { d.preview = false; renderSwitch(); } }

  async function close(d = active) {
    if (!d) return false;
    if (d.dirty) {
      activate(d);
      const answer = await api.confirmCloseDoc(nameOf(d));
      if (answer === 'cancel' || !answer) return false;
      // "save" means the newest text: keep saving until nothing typed meanwhile is left out
      if (answer === 'save' && !(await ctx.saveLatest(d))) return false;
    }
    if (!docs.includes(d)) return true;
    ctx.forgetDoc(d);
    api.draft(d.id, null);
    const idx = docs.indexOf(d);
    docs.splice(idx, 1); mru.splice(mru.indexOf(d), 1);
    if (!docs.length) { active = null; api.closeWindow(); return true; }
    if (active === d) { active = null; activate(mru[0], { fresh: true }); } else sync();
    return true;
  }
  /** Before the window closes: save every unsaved document; false if the user backs out of one. */
  async function saveAll() {
    for (let round = 0; round < 5; round++) {
      const unsaved = docs.filter((x) => x.dirty);
      if (!unsaved.length) return true;
      for (const d of unsaved) {
        if (!docs.includes(d)) continue;
        activate(d);
        if (!(await ctx.saveLatest(d))) return false;
      }
    }
    return !docs.some((x) => x.dirty);
  }

  // ---------- the title as switcher ----------
  const sw = $('#doc-switch'), dots = $('#doc-dots'), list = $('#doc-list');
  function renderSwitch() {
    const many = docs.length > 1;
    document.body.classList.toggle('multi-doc', many);
    dots.textContent = '';
    if (many) {
      const shown = docs.slice(0, 9);
      for (const d of shown) {
        const b = document.createElement('button');
        b.className = 'doc-dot' + (d === active ? ' on' : '') + (d.dirty ? ' dirty' : '') + (d.preview ? ' preview' : '');
        b.dataset.tip = nameOf(d);
        b.onclick = (e) => { e.stopPropagation(); activate(d); };
        dots.append(b);
      }
      if (docs.length > shown.length) { const more = document.createElement('span'); more.className = 'doc-more'; more.textContent = '+' + (docs.length - shown.length); dots.append(more); }
    }
    if (!list.hidden) renderList();
  }
  function renderList() {
    list.textContent = '';
    for (const d of docs) {
      const row = document.createElement('div');
      row.className = 'doc-row' + (d === active ? ' on' : '') + (d.preview ? ' preview' : '');
      const dot = document.createElement('span'); dot.className = 'doc-dot' + (d === active ? ' on' : '') + (d.dirty ? ' dirty' : '');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = nameOf(d).replace(/\.(md|markdown)$/i, '');
      const dir = document.createElement('span'); dir.className = 'dir';
      dir.textContent = d.filePath ? (state.folder && d.filePath.startsWith(state.folder) ? dirname(d.filePath).slice(state.folder.length + 1) : dirname(d.filePath).replace(ctx.env.home, '~')) : '';
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.dataset.tip = ctx.tipFor(t('关闭', 'Close'), 'close-doc');
      x.onclick = (e) => { e.stopPropagation(); close(d); };
      row.append(dot, name, dir, x);
      row.onclick = () => { activate(d); hideList(); };
      list.append(row);
    }
  }
  let hoverTimer;
  const showList = () => { if (docs.length < 2) return; renderList(); list.hidden = false; };
  const hideList = () => { list.hidden = true; };
  for (const el of [sw, list]) {
    el.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(showList, el === sw ? 180 : 0); });
    el.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(hideList, 260); });
  }
  sw.addEventListener('click', () => (list.hidden ? showList() : hideList()));

  // ---------- ⌃Tab: cycle through documents, most recent first ----------
  const cyc = $('#doc-cycle');
  let cycle = null;
  function renderCycle() {
    cyc.textContent = '';
    cycle.order.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'doc-row' + (i === cycle.i ? ' on' : '');
      const dot = document.createElement('span'); dot.className = 'doc-dot' + (d.dirty ? ' dirty' : '') + (i === cycle.i ? ' on' : '');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = nameOf(d).replace(/\.(md|markdown)$/i, '');
      row.append(dot, name);
      cyc.append(row);
    });
  }
  function step(dir) {
    if (docs.length < 2) return;
    if (!cycle) { cycle = { order: [...mru], i: 0 }; cyc.hidden = false; }
    cycle.i = (cycle.i + dir + cycle.order.length) % cycle.order.length;
    renderCycle();
  }
  function commitCycle() {
    if (!cycle) return;
    const d = cycle.order[cycle.i];
    cycle = null; cyc.hidden = true;
    if (docs.includes(d)) activate(d);
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    step(e.shiftKey ? -1 : 1);
  }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Control') commitCycle(); }, true);
  window.addEventListener('blur', () => { if (cycle) { cycle = null; cyc.hidden = true; } });

  return {
    open, show, newDoc, pin, close, saveAll, activate, sync, renderSwitch,
    /** One step without holding the key (menu, command palette). */
    switchNext() { if (docs.length > 1) activate(mru[1]); },
    active: () => active,
    list: () => docs,
    name: (d = active) => (d ? nameOf(d) : t('未命名', 'Untitled')),
    textOf, fileText,
    isOpen: (p) => docs.some((d) => d.filePath === p),
    byPath: (p) => docs.find((d) => d.filePath === p),
  };
}
