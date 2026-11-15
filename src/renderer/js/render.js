// Markdown → HTML for everything that is *rendered* rather than edited: the final
// view, print, HTML/PDF export and the blocks drawn inside the editor (tables,
// diagrams, formulas). Output is sanitised: documents are untrusted input.
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import markPlugin from 'markdown-it-mark';
import taskLists from 'markdown-it-task-lists';
import katex from 'katex';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import { parseInfo, inRanges, canFold, diffKind, isDiffLang } from './codemeta.js';
import { fileUrl, platform } from './paths.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Formulas and code highlighting are the slow parts of rendering, and while typing
// almost all of them are the same as a moment ago: remember recent results.
function memo(limit, fn) {
  const cache = new Map();
  return (key, ...args) => {
    let v = cache.get(key);
    if (v === undefined) {
      v = fn(...args);
      if (cache.size >= limit) cache.delete(cache.keys().next().value); // oldest first
      cache.set(key, v);
    }
    return v;
  };
}
const mathMemo = memo(3000, (tex, display) => {
  try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' }); }
  catch (err) { return `<span class="render-error">${esc(err.message)}</span>`; }
});
export const renderMath = (tex, display) => mathMemo((display ? 'D' : 'I') + tex, tex, display);

const codeMemo = memo(1500, (code, lang) => {
  if (lang && hljs.getLanguage(lang)) {
    try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch (_) { /* fall through */ }
  }
  return esc(code);
});
export const highlightCode = (code, lang) => codeMemo((lang || '') + '\u0000' + code, code, lang);

// --- math: $inline$ and $$ blocks, with the same rules as the editor's parser ---
function mathInline(state, silent) {
  const src = state.src, start = state.pos;
  if (src.charCodeAt(start) !== 0x24 || src.charCodeAt(start + 1) === 0x24) return false;
  const first = src.charCodeAt(start + 1);
  if (first === 0x20 || first === 0x09 || Number.isNaN(first)) return false;
  for (let i = start + 1; i < state.posMax; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) { i++; continue; }
    if (c === 0x0a) return false;
    if (c === 0x24) {
      if (i === start + 1) return false;
      const prev = src.charCodeAt(i - 1), next = src.charCodeAt(i + 1);
      if (prev === 0x20 || prev === 0x09 || (next >= 0x30 && next <= 0x39)) return false;
      if (!silent) { const tok = state.push('math_inline', 'math', 0); tok.content = src.slice(start + 1, i); }
      state.pos = i + 1;
      return true;
    }
  }
  return false;
}
function mathBlock(state, startLine, endLine, silent) {
  const lineText = (n) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  const first = lineText(startLine);
  if (!first.startsWith('$$')) return false;
  if (silent) return true;
  const rest = first.slice(2);
  let content, next = startLine;
  if (/\S\s*\$\$\s*$/.test(rest)) content = rest.replace(/\$\$\s*$/, '');
  else {
    const lines = rest.trim() ? [rest] : [];
    for (next = startLine + 1; next < endLine; next++) {
      const ln = lineText(next);
      if (/^\$\$\s*$/.test(ln)) break;
      lines.push(state.src.slice(state.bMarks[next], state.eMarks[next]));
    }
    content = lines.join('\n');
  }
  state.line = Math.min(next + 1, endLine);
  const tok = state.push('math_block', 'math', 0);
  tok.block = true; tok.content = content; tok.map = [startLine, state.line];
  return true;
}

// breaks: a single line break inside a paragraph is shown as a line break (what the editor shows).
// Strict CommonMark (a line break is a space) is one setting away: setLineBreaks(false).
const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
md.use(footnote).use(markPlugin).use(taskLists, { enabled: true, label: false });
// markdown-it refuses file: links (and data: except a few image types), so a local image written as
// a file:// URL (what a pasted image gets while its document has no file yet) stayed as text in the
// final view while the editor showed the picture. file: is allowed here; the HTML still goes
// through DOMPurify, which allows file: and nothing that runs (see PURIFY).
md.validateLink = (url) => {
  const u = String(url).trim().toLowerCase();
  if (/^(vbscript|javascript):/.test(u)) return false;
  if (u.startsWith('data:')) return /^data:image\/(gif|png|jpeg|webp);/.test(u);
  return true;
};
md.inline.ruler.after('escape', 'math_inline', mathInline);
md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.math_inline = (t, i) => renderMath(t[i].content, false);
const lineAttr = (tok, env) => (env && env.lines && tok.map ? ` data-line="${tok.map[0] + env.lineOffset + 1}"` : '');
md.renderer.rules.math_block = (t, i, o, env) => `<div class="math-block"${lineAttr(t[i], env)}>${renderMath(t[i].content, true)}</div>\n`;
/** Highlighted HTML → one string per source line, with spans closed and reopened across breaks. */
function splitLines(html) {
  const out = [], open = [], re = /<span[^>]*>|<\/span>|\n/g;
  let cur = '', last = 0, m;
  while ((m = re.exec(html))) {
    cur += html.slice(last, m.index);
    last = re.lastIndex;
    if (m[0] === '\n') { out.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else { if (m[0] === '</span>') open.pop(); else open.push(m[0]); cur += m[0]; }
  }
  cur += html.slice(last);
  if (cur.replace(/<[^>]+>/g, '')) out.push(cur + '</span>'.repeat(open.length));
  return out;
}
md.renderer.rules.fence = (tokens, idx, opts, env) => {
  const tok = tokens[idx];
  const meta = parseInfo(tok.info), lang = meta.lang;
  // encoded: the sanitiser rightly drops attribute values that contain "-->"
  if (lang === 'mermaid') return `<div class="mermaid-block"${lineAttr(tok, env)} data-src="${encodeURIComponent(tok.content)}"></div>\n`;
  const text = tok.content.replace(/\n$/, '').split('\n'), count = tok.content ? text.length : 0;
  const diff = isDiffLang(lang);
  let html = highlightCode(tok.content, lang), cls = 'hljs' + (lang ? ' language-' + esc(lang) : '');
  if (meta.hl.length || diff) {
    // one element per line, so single lines can carry a background
    html = '<span class="lines">' + splitLines(html).map((line, i) => {
      const kind = (inRanges(meta.hl, i + 1) ? ' hl' : '') + (diff && diffKind(text[i] || '') ? ' ' + diffKind(text[i]) : '');
      return `<span class="line${kind}">${line}\n</span>`;
    }).join('') + '</span>';
    cls += ' has-lines';
  }
  const attr = (lang ? ` data-lang="${esc(lang)}"` : '') + (meta.title ? ` data-title="${esc(meta.title)}"` : '')
    + (meta.fold && canFold(count) ? ` data-fold="${count}"` : '') + lineAttr(tok, env);
  return `<pre${attr}><code class="${cls}">${html}</code></pre>\n`;
};
const slug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
md.renderer.rules.heading_open = (tokens, idx, opts, env, self) => {
  const text = tokens[idx + 1].children.map((c) => c.content).join('');
  let id = slug(text) || 'section', n = 1;
  env.ids = env.ids || new Set();
  while (env.ids.has(id)) id = `${slug(text)}-${n++}`;
  env.ids.add(id);
  tokens[idx].attrSet('id', id);
  (env.headings = env.headings || []).push({ level: +tokens[idx].tag[1], text, id });
  return self.renderToken(tokens, idx, opts);
};
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const tok = tokens[idx];
  tok.attrSet('src', resolveSrc(tok.attrGet('src'), env.base));
  tok.attrSet('loading', 'lazy');
  return defaultImage(tokens, idx, opts, env, self);
};

export function resolveSrc(src, base) {
  if (src && platform.windows && /^[A-Za-z]:[\\/]/.test(src)) return fileUrl(src); // a Windows path, not a "c:" URL
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('#')) return src;
  if (src.startsWith('/')) return fileUrl(src);
  try { return base ? new URL(src, base).href : src; } catch (_) { return src; }
}

function tocHtml(headings) {
  if (!headings || !headings.length) return '';
  const min = Math.min(...headings.map((h) => h.level));
  let html = '<nav class="toc">', depth = min - 1;
  for (const h of headings) {
    while (depth < h.level) { html += '<ul>'; depth++; }
    while (depth > h.level) { html += '</ul>'; depth--; }
    html += `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`;
  }
  while (depth >= min) { html += '</ul>'; depth--; }
  return html + '</nav>';
}

const PURIFY = {
  ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mspace', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'mstyle', 'msubsup', 'munderover', 'mroot', 'mpadded', 'menclose', 'nav'],
  ADD_ATTR: ['data-src', 'data-lang', 'data-title', 'data-fold', 'encoding', 'loading'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  // local images are file:// URLs; allow them alongside the usual safe protocols
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};
export const sanitize = (html) => DOMPurify.sanitize(html, PURIFY);

/** Single line breaks: shown as line breaks (true) or joined like spaces, as CommonMark says (false). */
export function setLineBreaks(on) {
  if (md.options.breaks === !!on) return false;
  md.set({ breaks: !!on });
  return true;
}

/** YAML front matter at the top of a document: the simple `key: value` pairs, and the rest. */
export function frontMatter(src) {
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { meta: null, body: src, raw: '' };
  const meta = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-][\w .-]*?):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1].trim(); meta[key] = kv[2].replace(/^["']|["']$/g, ''); continue; }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) meta[key] = (meta[key] ? meta[key] + ', ' : '') + item[1].replace(/^["']|["']$/g, '');
  }
  return { meta, body: src.slice(m[0].length), raw: m[1] };
}

/** One line of inline Markdown (a table cell) to sanitised HTML. */
export function renderInline(src, { base } = {}) {
  return sanitize(md.renderInline(src, { base }));
}

/** Full document (or a fragment such as a table) to sanitised HTML. */
// With `lines`, blocks carry data-line (their 1-based line in the source), which is
// what lets the final view scroll, highlight and jump in step with the editor.
const LINE_TOKENS = new Set(['paragraph_open', 'heading_open', 'blockquote_open', 'bullet_list_open', 'ordered_list_open', 'list_item_open', 'table_open', 'tr_open', 'hr']);
md.core.ruler.push('source_lines', (state) => {
  if (!state.env.lines || state.env.blocks) return; // renderBlocks numbers lines per block
  for (const tok of state.tokens) if (tok.map && LINE_TOKENS.has(tok.type)) tok.attrSet('data-line', String(tok.map[0] + state.env.lineOffset + 1));
});

export function renderMarkdown(src, { base, lines } = {}) {
  const body = frontMatter(src).body;
  const env = { base, lines: !!lines, lineOffset: lines ? src.slice(0, src.length - body.length).split('\n').length - 1 : 0 };
  let html = md.render(body, env);
  html = html.replace(TOC_P, () => tocHtml(env.headings));
  return sanitize(html);
}
const TOC_P = /<p[^>]*>\s*\[toc\]\s*<\/p>/gi; // (paragraphs may carry data-line)

// ---- the final view, block by block ----
// The document is cut into its top-level blocks. Each block is rendered with line
// numbers relative to its own first line, so a block whose text did not change gives
// exactly the same HTML (its key) even when lines were added above it. Sanitised HTML
// is remembered per key: only changed blocks pay for sanitising, and the final view
// only replaces the elements of changed blocks.
const blockCache = new Map();
const BLOCK_CACHE_MAX = 4000;
/**
 * [{ key, html, line }]: one entry per top-level block, in order. `html` is sanitised;
 * its data-line attributes count from 1 at the block's first line, which is `line`
 * (1-based, in the whole document). Absolute line = data-line + line - 1.
 */
export function renderBlocks(src, { base } = {}) {
  const body = frontMatter(src).body;
  const offset = src.length === body.length ? 0 : src.slice(0, src.length - body.length).split('\n').length - 1;
  const env = { base, lines: true, blocks: true, lineOffset: 0 };
  const tokens = md.parse(body, env);
  const groups = [];
  let cur = null, depth = 0;
  for (const tok of tokens) {
    if (depth === 0) { cur = { tokens: [], start: tok.map ? tok.map[0] : null }; groups.push(cur); }
    cur.tokens.push(tok);
    depth += tok.nesting;
  }
  // blocks without a source position (the footnote list at the end) follow the one before
  let last = 0;
  for (const g of groups) { if (g.start == null) g.start = last; else last = g.start; }
  const out = groups.map((g) => {
    for (const tok of g.tokens) if (tok.map && LINE_TOKENS.has(tok.type)) tok.attrSet('data-line', String(tok.map[0] - g.start + 1));
    env.lineOffset = -g.start; // fences and $$ blocks number themselves from env.lineOffset
    return { raw: md.renderer.render(g.tokens, md.options, env), line: g.start + offset + 1 };
  });
  return out.map(({ raw, line }) => {
    const key = (base || '') + '\u0000' + raw.replace(TOC_P, () => tocHtml(env.headings));
    let html = blockCache.get(key);
    if (html === undefined) {
      html = sanitize(key.slice(key.indexOf('\u0000') + 1));
      if (blockCache.size >= BLOCK_CACHE_MAX) blockCache.delete(blockCache.keys().next().value);
      blockCache.set(key, html);
    }
    return { key, html, line };
  });
}

// --- mermaid: loaded on first use (it is large) and rendered asynchronously ---
let mermaidReady = null, mermaidTheme = null, seq = 0;
const svgCache = new Map();
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = window.WHIMFLOW_MERMAID || '../../node_modules/mermaid/dist/mermaid.min.js'; // the iOS bundle ships it elsewhere
      s.onload = () => resolve(window.mermaid);
      s.onerror = () => reject(new Error('mermaid failed to load'));
      document.head.append(s);
    });
  }
  return mermaidReady;
}
const isDark = () => ['slate', 'midnight'].includes(document.documentElement.dataset.theme);
export function cachedMermaid(src) { return svgCache.get((isDark() ? 'd:' : 'l:') + src); }
export async function renderMermaidSource(src) {
  const key = (isDark() ? 'd:' : 'l:') + src;
  if (svgCache.has(key)) return svgCache.get(key);
  const mermaid = await loadMermaid();
  const theme = isDark() ? 'dark' : 'neutral';
  if (mermaidTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: getComputedStyle(document.body).getPropertyValue('--ui-font') });
    mermaidTheme = theme;
  }
  let svg;
  try { ({ svg } = await mermaid.render('mf-mermaid-' + (++seq), src)); }
  catch (err) { svg = `<div class="render-error">${esc(String(err && err.message || err).split('\n')[0])}</div>`; }
  document.querySelectorAll('body > [id^="dmf-mermaid-"]').forEach((n) => n.remove());
  if (svgCache.size > 200) svgCache.clear();
  svgCache.set(key, svg);
  return svg;
}
export async function renderMermaidIn(root) {
  await Promise.all([...root.querySelectorAll('.mermaid-block[data-src]')].map(async (el) => {
    el.innerHTML = await renderMermaidSource(decodeURIComponent(el.dataset.src));
  }));
}
