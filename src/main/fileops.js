'use strict';
// File operations that must never lose the user's data: moving to the Trash,
// replacing a document on disk, and following paths through a rename.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Move a file or folder to the Trash. If the system refuses, nothing is deleted:
 * the caller gets { ok: false, error } and the item stays where it is.
 */
async function moveToTrash(p, { trashItem }) {
  try {
    await trashItem(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err || 'unknown error') };
  }
}

/**
 * Replace `file` with `data` without ever leaving half a file behind: write a
 * temporary file next to it, flush it, then rename it over the original.
 * Follows symlinks (the link stays a link) and keeps the file's permissions.
 * If the folder does not allow creating the temporary file, falls back to
 * writing in place (the old behaviour) and says so with { atomic: false }.
 */
async function writeFileAtomic(file, data, { fsp = fs.promises, retries = 3 } = {}) {
  let target = file;
  try { target = await fsp.realpath(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let mode;
  try { mode = (await fsp.stat(target)).mode & 0o7777; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.mftmp`);
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'wx', mode === undefined ? 0o666 : mode);
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      // a folder we may not create files in, holding a file we may write: do what we can
      await fsp.writeFile(target, data, 'utf8');
      return { path: target, atomic: false };
    }
    throw err;
  }
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    if (mode !== undefined) await fsp.chmod(tmp, mode).catch(() => {});
    for (let i = 0; ; i++) {
      try { await fsp.rename(tmp, target); break; }
      catch (err) {
        // Windows: a virus scanner or indexer may hold the file for a moment
        if (i >= retries || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        await sleep(60 * (i + 1));
      }
    }
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  // make the rename itself durable where the platform allows it
  try { const d = await fsp.open(path.dirname(target), 'r'); await d.sync().catch(() => {}); await d.close(); } catch (_) { /* Windows */ }
  return { path: target, atomic: true };
}

/** A file's version: the SHA-256 of its bytes. size and mtime only help diagnose a conflict. */
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const contentVersion = (text) => hashOf(Buffer.from(String(text), 'utf8')); // what writeFileAtomic writes
/** { sha256, size, mtimeMs } of the file now, or null if there is no such file. */
async function fileVersion(p, { fsp = fs.promises } = {}) {
  let buf, st;
  try { buf = await fsp.readFile(p); st = await fsp.stat(p); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  return { sha256: hashOf(buf), size: st.size, mtimeMs: st.mtimeMs };
}

/** One task at a time per key (e.g. per file path); tasks for different keys run freely. */
function keyedQueue() {
  const tails = new Map();
  return function run(key, task) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return next;
  };
}

/** Is `p` the folder `dir` itself or inside it? (Only whole path segments count.) */
function isUnder(p, dir, P = path) {
  if (!p || !dir) return false;
  if (p === dir) return true;
  const prefix = dir.endsWith(P.sep) ? dir : dir + P.sep;
  return p.startsWith(prefix);
}

/** Where `p` is after `from` was renamed to `to`; null if the rename does not touch it. */
function remapPath(p, from, to, P = path) {
  if (!isUnder(p, from, P)) return null;
  return p === from ? to : to + p.slice(from.length);
}

module.exports = { moveToTrash, writeFileAtomic, keyedQueue, isUnder, remapPath, hashOf, contentVersion, fileVersion };
