'use strict';
// Export: HTML, PDF, PNG (one long image) and Word (.docx). PNG and Word render
// the page in an offscreen window; Word gets formulas and diagrams as pictures.
const { BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const vendor = path.join(__dirname, '..', 'renderer', 'vendor'); // KaTeX's css and fonts, copied by scripts/build.js
const renderer = path.join(__dirname, '..', 'renderer');
const fileUrl = (p) => require('url').pathToFileURL(p).href; // spaces, #, ? and CJK in the app's path survive
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } };
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A standalone page. `local` uses bundled fonts/KaTeX css (PDF, PNG, Word); otherwise a CDN. */
function buildHtml({ body, title, theme }, { local = false, light = false } = {}) {
  if (light && ['slate', 'midnight'].includes(theme)) theme = 'daylight';
  const katexVer = (read(path.join(vendor, 'katex', 'VERSION')) || '').trim() || '0.16.11';
  const katex = local ? fileUrl(path.join(vendor, 'katex', 'katex.min.css')) : `https://cdn.jsdelivr.net/npm/katex@${katexVer}/dist/katex.min.css`;
  const fonts = local ? `\n<link rel="stylesheet" href="${fileUrl(path.join(renderer, 'fonts', 'fonts.css'))}">` : '';
  return `<!doctype html>
<html data-theme="${esc(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: file:; style-src 'unsafe-inline' * file:; font-src * data: file:">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${katex}">${fonts}
<style>
${read(path.join(renderer, 'content.css'))}
html { background: var(--bg); }
body { margin: 0 auto; max-width: 820px; padding: 48px 32px 80px; }
@media print { html, body { background: #fff; } body { max-width: none; padding: 0; } pre, table, img, blockquote, .mermaid-block { break-inside: avoid; } h1, h2, h3 { break-after: avoid; } }
</style>
</head>
<body class="doc">
${body}
</body>
</html>
`;
}

// Written next to the document so relative image paths keep resolving.
async function writeTmp(html, docPath) {
  const name = `.whimflow-export-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`;
  let tmp = path.join(docPath ? path.dirname(docPath) : os.tmpdir(), name);
  try { await fs.promises.writeFile(tmp, html, 'utf8'); }
  catch (_) { tmp = path.join(os.tmpdir(), name); await fs.promises.writeFile(tmp, html, 'utf8'); }
  return tmp;
}

async function withPage(html, docPath, opts, fn) {
  const tmp = await writeTmp(html, docPath);
  const w = new BrowserWindow({ show: false, width: opts.width || 900, height: opts.height || 1000, webPreferences: { sandbox: true, offscreen: !!opts.offscreen, javascript: true } });
  try {
    await w.loadFile(tmp);
    // lazy images never load off screen: load them all now, and never wait forever
    await w.webContents.executeJavaScript(`Promise.race([
      document.fonts.ready.then(() => Promise.all([...document.images].map((i) => { i.loading = 'eager'; return i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }); }))),
      new Promise((r) => setTimeout(r, 5000)),
    ]).then(() => true)`);
    await sleep(250);
    return await fn(w);
  } finally {
    w.destroy();
    fs.promises.unlink(tmp).catch(() => {});
  }
}

async function toPdf(page, docPath) {
  return withPage(buildHtml(page, { local: true, light: true }), docPath, {}, (w) => w.webContents.printToPDF({
    printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 },
  }));
}

const MAX_PNG_HEIGHT = 30000;
/** The whole document as one image: capture screen by screen and stack the bitmaps. */
async function toPng(page, docPath) {
  const width = 900, view = 1000;
  return withPage(buildHtml(page, { local: true }), docPath, { width, height: view, offscreen: true }, async (w) => {
    const total = Math.min(MAX_PNG_HEIGHT, await w.webContents.executeJavaScript('document.documentElement.scrollHeight'));
    const parts = [];
    let pw = 0, ph = 0, scale = 1;
    for (let y = 0; y < total; y += view) {
      const h = Math.min(view, total - y);
      const top = Math.min(y, Math.max(0, total - view)); // the page cannot scroll past its end
      await w.webContents.executeJavaScript(`scrollTo(0, ${top}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      await sleep(60);
      const img = await w.webContents.capturePage({ x: 0, y: y - top, width, height: h });
      const size = img.getSize();
      scale = size.width / width;
      pw = size.width; ph += size.height;
      parts.push(img.toBitmap());
    }
    const png = nativeImage.createFromBitmap(Buffer.concat(parts), { width: pw, height: ph, scaleFactor: scale }).toPNG();
    return { data: png, truncated: total >= MAX_PNG_HEIGHT };
  });
}

/** Word: formulas and diagrams become pictures; local images are embedded. */
async function toDocx(page, docPath) {
  const HTMLtoDOCX = require('html-to-docx');
  const body = await withPage(buildHtml(page, { local: true, light: true }), docPath, { width: 900, height: 1000, offscreen: true }, async (w) => {
    const run = (js) => w.webContents.executeJavaScript(js);
    const n = await run(`(() => {
      const els = [...document.querySelectorAll('.katex-display, .katex, .mermaid-block')].filter((e) => !e.parentElement.closest('.katex-display, .katex'));
      els.forEach((e, i) => e.setAttribute('data-cap', i));
      return els.length;
    })()`);
    for (let i = 0; i < n; i++) {
      const r = await run(`(() => { const e = document.querySelector('[data-cap="${i}"]'); const t = e.classList.contains('mermaid-block') ? (e.querySelector('svg') || e) : e;
        t.scrollIntoView({ block: 'center' }); const b = t.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
      await sleep(30);
      if (r.w < 1 || r.h < 1) continue;
      const img = await w.webContents.capturePage({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.w) + 1, height: Math.ceil(r.h) + 1 });
      const src = 'data:image/png;base64,' + img.toPNG().toString('base64');
      await run(`(() => { const e = document.querySelector('[data-cap="${i}"]'); const im = document.createElement('img');
        im.src = ${JSON.stringify(src)}; im.width = ${Math.ceil(r.w)}; im.height = ${Math.ceil(r.h)};
        if (e.classList.contains('katex-display') || e.classList.contains('mermaid-block')) { const p = document.createElement('p'); p.style.textAlign = 'center'; p.append(im); e.replaceWith(p); } else e.replaceWith(im); })()`);
    }
    // code blocks: keep line breaks and a monospace face; drop the highlight spans Word ignores,
    // but keep the file name and the tint of highlighted / added / removed lines
    await run(`document.querySelectorAll('pre > code').forEach((c) => { const pre = c.parentElement;
      const mono = 'margin:0;font-family:Menlo,Consolas,monospace;font-size:10pt';
      const tint = { hl: '#f6e6da', add: '#e2efd9', del: '#f8dedb' };
      const marked = [...c.querySelectorAll('.line')];
      const lines = marked.length ? marked.map((l) => ({ text: l.textContent.replace(/\\n$/, ''), kind: ['hl', 'add', 'del'].find((k) => l.classList.contains(k)) }))
        : c.textContent.replace(/\\n$/, '').split('\\n').map((text) => ({ text }));
      const box = document.createElement('div'); box.setAttribute('style', 'font-family: Menlo, Consolas, monospace; font-size: 10pt; background: #f2f0e8;');
      if (pre.dataset.title) { const p = document.createElement('p'); const b = document.createElement('strong'); b.textContent = pre.dataset.title; p.append(b); p.setAttribute('style', mono); box.append(p); }
      lines.forEach((line) => { const p = document.createElement('p'); p.setAttribute('style', mono + (line.kind ? ';background-color:' + tint[line.kind] : ''));
        if (line.kind) { const sp = document.createElement('span'); sp.setAttribute('style', 'background-color:' + tint[line.kind]); sp.textContent = line.text || ' '; p.append(sp); } else p.textContent = line.text || ' ';
        box.append(p); });
      pre.replaceWith(box); })`);
    // Word needs every picture's size; give it the size it has on the page (at most the text width)
    await run(`document.querySelectorAll('img').forEach((im) => { const w = Math.round(Math.min(im.getBoundingClientRect().width || im.naturalWidth || 400, 640)); const h = Math.round(im.naturalWidth ? w * im.naturalHeight / im.naturalWidth : (im.getBoundingClientRect().height || 300));
      im.removeAttribute('loading'); im.removeAttribute('style'); im.setAttribute('width', w || 400); im.setAttribute('height', h || 300); })`);
    await run(`document.querySelectorAll('input[type=checkbox]').forEach((c) => c.replaceWith(document.createTextNode(c.checked ? '☑ ' : '☐ ')))`);
    return run('document.body.innerHTML');
  });
  // local images → data URIs (Word cannot follow file:// links)
  const html = body.replace(/(<img\b[^>]*?\ssrc=")(file:\/\/[^"]+)(")/gi, (m, a, src, b) => {
    try {
      const p = decodeURIComponent(new URL(src).pathname);
      const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml');
      return a + `data:image/${ext};base64,` + fs.readFileSync(p).toString('base64') + b;
    } catch (_) { return m; }
  });
  return HTMLtoDOCX(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(page.title)}</title></head><body>${html}</body></html>`, null, {
    title: page.title, font: 'Calibri', fontSize: 22, table: { row: { cantSplit: true } },
    margins: { top: 1200, right: 1200, bottom: 1200, left: 1200 },
  });
}

module.exports = { buildHtml, toPdf, toPng, toDocx };
