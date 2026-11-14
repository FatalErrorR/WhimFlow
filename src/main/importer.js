'use strict';
// Files dragged from Finder (or Explorer) into a folder of the sidebar: copied in, never moved.
// Markdown documents bring the local images they show (relative links, kept at the same place
// relative to the document); folders come with their documents and images. Nothing is
// overwritten: a name that is taken gets a number ("笔记 2.md").
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DOC = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;
const IMG = /\.(png|jpe?g|gif|svg|webp|heic|avif|bmp)$/i;
const SKIP_DIR = new Set(['node_modules', '.git']);

/** "笔记.md" in `dir` if free, else "笔记 2.md", "笔记 3.md"… */
async function freeName(dir, name) {
  const ext = path.extname(name), stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${stem} ${i}${ext}`;
    try { await fsp.lstat(path.join(dir, n)); } catch (err) { if (err.code === 'ENOENT') return n; throw err; }
  }
}

/** The relative image paths a Markdown text shows: ![](a/b.png), <img src="a.png">; not web, data or absolute. */
function imageLinks(text) {
  const out = new Set();
  const take = (raw) => {
    let s = String(raw || '').trim().replace(/^<|>$/g, '');
    if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/') || s.startsWith('#')) return;
    s = s.replace(/[?#].*$/, '');
    try { s = decodeURI(s); } catch (_) { /* keep as written */ }
    if (IMG.test(s)) out.add(s);
  };
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/g)) take(m[1]);
  for (const m of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) take(m[1]);
  return [...out];
}

const sameBytes = async (a, b) => { try { return (await fsp.readFile(a)).equals(await fsp.readFile(b)); } catch (_) { return false; } };

/**
 * Copy `sources` (absolute paths of files or folders) into `dest` (an existing folder).
 * Returns { added: [paths of the top-level items made], images: n, skipped: [names] }.
 */
async function importInto(dest, sources) {
  const out = { added: [], images: 0, skipped: [] };

  async function copyImagesOf(srcDoc, destDoc) {
    const text = await fsp.readFile(srcDoc, 'utf8');
    const from = path.dirname(srcDoc), to = path.dirname(destDoc);
    for (const rel of imageLinks(text)) {
      const s = path.resolve(from, rel), d = path.resolve(to, rel);
      if (!s.startsWith(from + path.sep) || !d.startsWith(to + path.sep)) continue; // only beside or below the document
      if (!fs.existsSync(s) || !fs.statSync(s).isFile()) continue;
      if (fs.existsSync(d)) { if (!(await sameBytes(s, d))) out.skipped.push(rel); continue; } // never overwrite
      await fsp.mkdir(path.dirname(d), { recursive: true });
      await fsp.copyFile(s, d, fs.constants.COPYFILE_EXCL);
      out.images++;
    }
  }
  async function copyFolder(src, d) {
    await fsp.mkdir(d);
    for (const e of await fsp.readdir(src, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const s = path.join(src, e.name), t = path.join(d, e.name);
      if (e.isDirectory()) await copyFolder(s, t);
      else if (e.isFile() && (DOC.test(e.name) || IMG.test(e.name))) await fsp.copyFile(s, t, fs.constants.COPYFILE_EXCL);
    }
  }

  for (const src of sources) {
    let st;
    try { st = await fsp.stat(src); } catch (_) { out.skipped.push(path.basename(src)); continue; }
    const name = path.basename(src);
    if (st.isDirectory()) {
      if (dest === src || dest.startsWith(src + path.sep)) { out.skipped.push(name); continue; } // not into itself
      const d = path.join(dest, await freeName(dest, name));
      await copyFolder(src, d);
      out.added.push(d);
    } else if (DOC.test(name) || IMG.test(name)) {
      const d = path.join(dest, await freeName(dest, name));
      await fsp.copyFile(src, d, fs.constants.COPYFILE_EXCL);
      if (DOC.test(name)) await copyImagesOf(src, d);
      out.added.push(d);
    } else out.skipped.push(name);
  }
  return out;
}

module.exports = { importInto, imageLinks, freeName };
