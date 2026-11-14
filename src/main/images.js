'use strict';
// Where pasted / dropped images go, per the user's settings.
//   imageFolder: "./assets", "./${filename}.assets", "." or an absolute path
//   imageRelative: write a path relative to the document when possible
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const IMG = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];

// `P` is the path flavour (path.posix / path.win32); it defaults to this platform's.
const isWin = (P) => P === path.win32 || (P === path && process.platform === 'win32');
/** An absolute path as a file:// URL: spaces, #, ?, %, CJK and backslashes all survive. */
const toUrl = (p, P = path) => pathToFileURL(p, { windows: isWin(P) }).href;
// one path segment of a relative link; parentheses too, so the Markdown link never breaks
const encodeSegment = (s) => encodeURIComponent(s).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const relLink = (from, to, P = path) => P.relative(from, to).split(P.sep).map(encodeSegment).join('/') || '.';

function targetDir(settings, docPath, userData, P = path) {
  const tpl = String(settings.imageFolder || './assets').trim() || './assets';
  const name = docPath ? P.basename(docPath).replace(/\.[^.]+$/, '') : 'untitled';
  const folder = tpl.replace(/\$\{filename\}/g, name);
  if (P.isAbsolute(folder)) return folder;
  return docPath ? P.resolve(P.dirname(docPath), folder) : P.join(userData, 'images');
}

/** The Markdown link for an image file, relative to the document when allowed. */
function linkFor(settings, docPath, file, P = path) {
  if (docPath && settings.imageRelative !== false) {
    const rel = P.relative(P.dirname(docPath), file);
    // another drive (Windows) gives an absolute "relative" path; far-away folders read better absolute
    if (!P.isAbsolute(rel) && !rel.startsWith('..' + P.sep + '..' + P.sep + '..')) return relLink(P.dirname(docPath), file, P);
  }
  return toUrl(file, P);
}

const MAX_TRIES = 10000;
/**
 * Save image bytes under a free name. The name is claimed with an exclusive create
 * ('wx'), so two saves at the same moment can never pick the same file: the loser
 * of the race simply moves on to shot-1, shot-2, …
 */
async function saveImage(settings, docPath, userData, name, data) {
  const dir = targetDir(settings, docPath, userData);
  await fs.promises.mkdir(dir, { recursive: true });
  let ext = path.extname(name || '').toLowerCase();
  if (!IMG.includes(ext.slice(1))) ext = '.png';
  let base = path.basename(name || 'image', path.extname(name || '')).replace(/[^\w一-龥.-]+/g, '-') || 'image';
  if (base === 'image') base = 'image-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bytes = Buffer.from(data);
  for (let i = 0; i < MAX_TRIES; i++) {
    const file = path.join(dir, i ? `${base}-${i}${ext}` : base + ext);
    let fh;
    try { fh = await fs.promises.open(file, 'wx'); }
    catch (err) { if (err.code === 'EEXIST') continue; throw err; }
    try {
      await fh.writeFile(bytes);
      await fh.close();
    } catch (err) {
      await fh.close().catch(() => {});
      await fs.promises.unlink(file).catch(() => {}); // never leave a truncated image under a claimed name
      throw err;
    }
    return linkFor(settings, docPath, file);
  }
  throw new Error('No free file name for the image in ' + dir);
}

module.exports = { saveImage, linkFor, targetDir, toUrl, relLink, IMG };
