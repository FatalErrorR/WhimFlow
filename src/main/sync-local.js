'use strict';
// The desktop's side of sync (see src/shared/sync.js): the library folder on disk, the base
// versions in a small JSON file, and the server's token kept encrypted by the system
// (Electron's safeStorage: on macOS the key lives in the login Keychain).
// No Electron here, so it runs in plain Node tests; main.js passes in what it needs.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const fileops = require('./fileops');
const { syncable } = require('../shared/sync');

/**
 * The library on disk. Writes and moves to the Trash go through `queue` (the same per-file
 * queue the app's own saves use), and only happen if the file is still the version the sync
 * engine saw, so an edit saved in the meantime is never overwritten.
 */
function createLocal({ root, queue = fileops.keyedQueue(), trashItem }) {
  const abs = (rel) => path.join(root, ...rel.split('/'));
  const cache = new Map(); // abs path -> { mtimeMs, size, v }
  async function versionOf(file) {
    let st;
    try { st = await fsp.stat(file); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; throw err; }
    if (!st.isFile()) return undefined;
    const c = cache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.v;
    const v = fileops.hashOf(await fsp.readFile(file));
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, v });
    return v;
  }
  return {
    root,
    async list() {
      const files = {}, dirs = [];
      async function walk(dir, rel) {
        let ents;
        try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
        for (const e of ents) {
          const r = (rel ? rel + '/' : '') + e.name.normalize('NFC');
          if (!syncable(r)) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { dirs.push(r); await walk(p, r); }
          else if (e.isFile()) { const v = await versionOf(p); if (v) files[r] = { v }; }
        }
      }
      await walk(root, '');
      return { files, dirs };
    },
    read: (rel) => fsp.readFile(abs(rel)),
    write: (rel, bytes, expected) => queue(abs(rel), async () => {
      const file = abs(rel);
      const cur = await versionOf(file);
      if (cur === undefined || cur !== expected) return false;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fileops.writeFileAtomic(file, Buffer.from(bytes));
      return true;
    }),
    trash: (rel, expected) => queue(abs(rel), async () => {
      const file = abs(rel);
      if ((await versionOf(file)) !== expected) return false;
      const r = await fileops.moveToTrash(file, { trashItem });
      if (r.ok) cache.delete(file);
      return r.ok;
    }),
    mkdir: (rel) => fsp.mkdir(abs(rel), { recursive: true }),
    /**
     * Only a folder with nothing synced left in it. Hidden leftovers (Finder's .DS_Store, a
     * temporary file from an interrupted save) do not keep it, but are not erased either: then
     * the whole folder goes to the Trash.
     */
    async rmdir(rel) {
      const dir = abs(rel);
      let ents;
      try { ents = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return true; throw err; }
      if (ents.some((n) => !n.startsWith('.'))) return false;
      if (!ents.length) { await fsp.rmdir(dir); return true; }
      return (await fileops.moveToTrash(dir, { trashItem })).ok;
    },
  };
}

/** The versions both sides last agreed on, in one JSON file (replaced atomically). */
function createState(file) {
  return {
    async load() { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; } },
    async save(s) { await fsp.mkdir(path.dirname(file), { recursive: true }); await fileops.writeFileAtomic(file, JSON.stringify(s)); },
    async clear() { await fsp.rm(file, { force: true }); },
  };
}

/** The server's token, encrypted with a key the system keeps (never written in the clear). */
function createTokenStore(file, safeStorage) {
  return {
    get() {
      try { return safeStorage.decryptString(fs.readFileSync(file)); } catch (_) { return null; }
    },
    set(token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('the system keychain is not available');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, safeStorage.encryptString(token), { mode: 0o600 });
    },
    clear() { fs.rmSync(file, { force: true }); },
  };
}

module.exports = { createLocal, createState, createTokenStore };
