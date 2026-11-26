// The editor, assembled. Everything outside this folder talks to the editor
// through the small object returned by createEditor().
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, lineNumbers, highlightActiveLineGutter } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, indentOnInput, bracketMatching, indentUnit, syntaxTree, LanguageDescription } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightExt, MathExt, FootnoteExt, FrontMatterExt } from './syntax.js';
import { tableNavKeymap } from './tablewidget.js';
import { invisibles } from './invisibles.js';
import { languages, highlightStyle } from './lang.js';
import { livePreview, focusPlugin, refreshLive } from './live.js';
import { live } from './widgets.js';
import { fenceCompletion, codeKeymap, keepHighlights } from './code.js';
import { tableKeymap } from './table.js';
import { findField, findApi } from './find.js';
import { islandLayer, selectionClip } from './island.js';
import { runCommand } from './commands.js';
import { headingsOf, topBlockAt, fenceAt, fenceInfo } from './structure.js';

export function createEditor(parent, opts) {
  const liveComp = new Compartment(), modeComp = new Compartment(), prefComp = new Compartment();
  let prefs = { closeBrackets: true, indent: 4, spellcheck: false, invisibles: false };
  const prefExt = () => [
    prefs.closeBrackets ? closeBrackets() : [],
    prefs.invisibles ? invisibles : [],
    indentUnit.of(' '.repeat(prefs.indent)),
    EditorState.tabSize.of(prefs.indent),
    EditorView.contentAttributes.of({ spellcheck: prefs.spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' }),
  ];
  const handlers = { change: [], selection: [], scroll: [], focus: [] };
  let mode = 'live', typewriter = false, headingsCache = null;
  Object.assign(live, { t: opts.t, copy: opts.copy, reveal: opts.reveal || (() => {}), jumpToHeading: (i) => api.scrollToHeading(i), compare: (pos) => opts.compareCode && opts.compareCode(pos) });

  // live preview draws the document; source mode is a plain editor with line numbers
  const sourceExt = [lineNumbers(), highlightActiveLineGutter()];
  const modeBody = () => (mode === 'live' ? livePreview : sourceExt);
  const modeExt = () => [
    liveComp.of(modeBody()),
    modeComp.of(EditorView.editorAttributes.of({ class: mode === 'live' ? 'cm-live' : 'cm-source' })),
  ];

  // Pasted and dropped images are saved asynchronously; opts.insertImages (app.js) knows
  // which document they belong to and puts them there even if another one is in front by then.
  const insertImages = (files, pos, dropped) => opts.insertImages && opts.insertImages(files, pos, dropped);
  const linkAt = (view, pos) => {
    for (let n = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
      if (n.name === 'Link' || n.name === 'Autolink' || n.name === 'Image') { const u = n.getChild('URL'); return u ? view.state.sliceDoc(u.from, u.to).replace(/^<|>$/g, '') : null; }
      if (n.name === 'URL') return view.state.sliceDoc(n.from, n.to);
    }
    return null;
  };

  const extensions = () => [
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    indentOnInput(),
    bracketMatching(),
    prefComp.of(prefExt()),
    autocompletion({ override: [fenceCompletion], icons: false }),
    Prec.high(keymap.of([...tableKeymap, ...codeKeymap, ...tableNavKeymap])),
    keymap.of([...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
    markdown({ base: markdownLanguage, codeLanguages: (info) => LanguageDescription.matchLanguageName(languages, info.replace(/\{.*$/, ''), true), extensions: [HighlightExt, MathExt, FootnoteExt, FrontMatterExt, { remove: ['IndentedCode'] }], completeHTMLTags: false }), // indented lines are text; code is fenced (```)
    syntaxHighlighting(highlightStyle),
    modeExt(),
    focusPlugin,
    keepHighlights,
    findField,
    islandLayer,
    selectionClip,
    EditorState.transactionExtender.of((tr) => (typewriter && (tr.selection || tr.docChanged) && !tr.isUserEvent('select.pointer')
      ? { effects: EditorView.scrollIntoView((tr.selection || tr.startState.selection).main.head, { y: 'center' }) } : null)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) { headingsCache = null; handlers.change.forEach((f) => f(u)); }
      if (u.docChanged || u.selectionSet) handlers.selection.forEach((f) => f(u));
      if (u.focusChanged) handlers.focus.forEach((f) => f(u.view.hasFocus));
    }),
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type));
        if (!files.length) return false;
        e.preventDefault();
        insertImages(files, view.state.selection.main.head, false);
        return true;
      },
      drop(e, view) {
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => /^image\//.test(f.type));
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        insertImages(files, pos == null ? view.state.selection.main.head : pos, true);
        return true;
      },
      mousedown(e, view) {
        if (!(opts.isMac ? e.metaKey : e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const url = pos == null ? null : linkAt(view, pos);
        if (!url) return false;
        e.preventDefault();
        opts.openLink(url);
        return true;
      },
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: extensions() }) });
  view.scrollDOM.addEventListener('scroll', () => handlers.scroll.forEach((f) => f()), { passive: true });
  const refresh = () => view.dispatch({ effects: refreshLive.of(null) });
  // distance from the scroller's content top to the document's first line
  const docOffset = () => view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;

  const api = {
    view,
    find: findApi(view),
    get mode() { return mode; },
    get scrollDOM() { return view.scrollDOM; },
    getValue: () => view.state.doc.toString(),
    /** A fresh document state: own undo history, caret at the top (below any YAML front matter). */
    newState(text) {
      const fm = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
      const anchor = fm ? Math.min(text.length, fm[0].length + (text[fm[0].length] === '\n' ? 1 : 0)) : 0;
      return EditorState.create({ doc: text, selection: { anchor }, extensions: extensions() });
    },
    getState: () => view.state,
    /** Show a document state (switching documents keeps each one's history and caret). */
    setState(st, scrollTop = 0) {
      headingsCache = null;
      view.setState(st);
      // a stored state remembers the mode and preferences it was made with: bring it up to date
      view.dispatch({ effects: [liveComp.reconfigure(modeBody()), modeComp.reconfigure(EditorView.editorAttributes.of({ class: mode === 'live' ? 'cm-live' : 'cm-source' })), prefComp.reconfigure(prefExt())] });
      view.scrollDOM.scrollTop = scrollTop;
      requestAnimationFrame(() => { view.scrollDOM.scrollTop = scrollTop; });
    },
    setValue(text) { api.setState(api.newState(text)); },
    /** Replace the content as one undoable edit (only the changed middle is touched). */
    replaceAll(text, userEvent = 'input') {
      const old = view.state.doc.toString();
      if (old === text) return;
      let a = 0;
      while (a < old.length && a < text.length && old[a] === text[a]) a++;
      let b = 0;
      while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
      view.dispatch({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, userEvent });
    },
    setMode(m) {
      mode = m;
      view.dispatch({ effects: [liveComp.reconfigure(modeBody()), modeComp.reconfigure(EditorView.editorAttributes.of({ class: m === 'live' ? 'cm-live' : 'cm-source' }))] });
    },
    setBase(url, quiet) { live.base = url || ''; if (!quiet) refresh(); },
    configure(p) { prefs = { ...prefs, ...p }; view.dispatch({ effects: prefComp.reconfigure(prefExt()) }); },
    setFocusMode(on) { live.focusMode = on; refresh(); },
    setTypewriter(on) { typewriter = on; if (on) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) }); },
    setIsland(on) { if (live.island !== on) { live.island = on; refresh(); } },
    run: (name, arg) => runCommand(view, name, arg, opts.t),
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    selectionText() { const r = view.state.selection.main; return view.state.sliceDoc(r.from, r.to); },
    selectionRect() {
      const r = view.state.selection.main;
      if (r.empty) return null;
      const a = view.coordsAtPos(r.from), b = view.coordsAtPos(r.to);
      if (!a || !b) return null;
      return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), multiline: a.top !== b.top };
    },
    headings() { return headingsCache || (headingsCache = headingsOf(view.state)); },
    currentBlock: () => topBlockAt(view.state, view.state.selection.main.head),
    /** Select `len` characters at line/column and bring them to the middle of the view. */
    jumpTo({ line, col = 0, len = 0 }) {
      const { doc } = view.state;
      const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
      const from = Math.min(l.from + col, l.to), to = Math.min(from + len, l.to);
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      view.focus();
    },
    /** The fenced code block at a document position (default: the caret), or null. */
    codeBlockAt(pos = view.state.selection.main.head) {
      const node = fenceAt(view.state, Math.max(0, Math.min(pos, view.state.doc.length)));
      if (!node) return null;
      const info = fenceInfo(view.state, node);
      return { from: node.from, to: node.to, lang: info.lang, title: info.meta.title, code: info.code, line: info.open, closed: info.closed };
    },
    posAt: (x, y) => view.posAtCoords({ x, y }),
    /** Mark the block chosen for a comparison (-1 clears it). */
    setPick(pos) { if (live.pick !== pos) { live.pick = pos; refresh(); } },
    /** A new block of text on its own lines after the block that ends at `pos`. */
    insertBelow(pos, text) {
      const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
      const insert = '\n\n' + text + (line.number < view.state.doc.lines && view.state.doc.line(line.number + 1).text.trim() ? '\n' : '');
      view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + 2 }, effects: EditorView.scrollIntoView(line.to + 2, { y: 'center' }), userEvent: 'input' });
      view.focus();
    },
    lineCount: () => view.state.doc.lines,
    caretLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    /** Scroller y of the top of line n (1-based). */
    yOfLine: (n) => api.yOf(view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines))).from),
    /** Scroller y of a document position (works for off-screen lines too). */
    yOf: (pos) => view.lineBlockAt(Math.min(pos, view.state.doc.length)).top + docOffset(),
    scrollToHeading(i, smooth = true) {
      const h = api.headings()[i];
      if (!h) { view.scrollDOM.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' }); return; }
      const target = api.yOf(h.from) - 24;
      if (smooth && Math.abs(target - view.scrollDOM.scrollTop) < view.scrollDOM.clientHeight * 2) view.scrollDOM.scrollTo({ top: target, behavior: 'smooth' });
      else view.dispatch({ effects: EditorView.scrollIntoView(h.from, { y: 'start', yMargin: 24 }) });
    },
    /** Index of the heading the reader is currently in. */
    headingIndexAtScroll() {
      const hs = api.headings(), top = view.scrollDOM.scrollTop + 60;
      let idx = 0;
      for (let i = 0; i < hs.length; i++) { if (api.yOf(hs[i].from) <= top) idx = i; else break; }
      return hs.length ? idx : -1;
    },
    onChange: (f) => handlers.change.push(f),
    onSelection: (f) => handlers.selection.push(f),
    onScroll: (f) => handlers.scroll.push(f),
    onFocus: (f) => handlers.focus.push(f),
  };
  return api;
}
