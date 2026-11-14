'use strict';
// When and how the desktop syncs. The library is a folder in the app's own data
// (~/Library/Application Support/WhimFlow/Documents on a Mac); the server address is a
// setting, the token sits in the keychain (see sync-local.js). It syncs on start, a moment
// after a save, every minute, and when a window comes to the front; windows hear the
// outcome through notify() ('sync-status').
const fs = require('fs');
const path = require('path');
const { createSync, createRemote } = require('../shared/sync');
const { createLocal, createState, createTokenStore } = require('./sync-local');
const fileops = require('./fileops');

/** "whimflow.example.com" -> "https://whimflow.example.com"; plain http only for this computer. */
function normalizeUrl(input) {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function createDesktopSync({ userData, safeStorage, trashItem, queue, getUrl, setUrl, notify, device, fetch, every = 60000 }) {
  const library = path.join(userData, 'Documents');
  fs.mkdirSync(library, { recursive: true });
  const tokens = createTokenStore(path.join(userData, 'sync-token'), safeStorage);
  const state = createState(path.join(userData, 'sync-state.json'));
  const local = createLocal({ root: library, queue, trashItem });
  let engine = null, status = { state: 'off' }, timer = null, soon = null, lastFocus = 0;

  const setStatus = (s) => { status = { ...s, url: getUrl() || null }; notify(status); };
  function build() {
    const url = getUrl(), token = url ? tokens.get() : null;
    clearInterval(timer); timer = null;
    engine = url && token ? createSync({ local, remote: createRemote({ url, token, fetch }), state, device, hash: async (b) => fileops.hashOf(b) }) : null;
    if (engine) timer = setInterval(() => run(), every);
    else setStatus({ state: 'off' });
  }
  async function run() {
    const e = engine;
    if (!e) return status;
    if (!e.isRunning()) setStatus({ state: 'syncing', at: status.at });
    try {
      const r = await e.sync();
      if (e !== engine) return status; // disconnected meanwhile
      setStatus({
        state: r.errors.length ? 'error' : 'ok', at: Date.now(),
        changed: r.down.length + r.removedHere.length + r.conflicts.length > 0,
        conflicts: r.conflicts.map((c) => c.copy || c.path),
        message: r.errors.length ? `${r.errors[0].path}: ${r.errors[0].error}` : '',
      });
    } catch (err) {
      if (e !== engine) return status;
      setStatus({ state: ['offline', 'auth'].includes(err.code) ? err.code : 'error', at: status.at, message: String((err && err.message) || err) });
    }
    return status;
  }

  return {
    library,
    status: () => ({ ...status, url: getUrl() || null }),
    start() { build(); if (engine) run(); },
    syncNow: () => run(),
    /** Something in the library changed here: sync shortly (saves come in bursts). */
    changed() { if (!engine) return; clearTimeout(soon); soon = setTimeout(run, 2000); },
    focused() { if (engine && Date.now() - lastFocus > 20000) { lastFocus = Date.now(); run(); } },
    /** Check the address and token with the server, then keep them and sync. */
    async connect({ url, token }) {
      const u = normalizeUrl(url), tk = String(token || '').trim();
      if (!u) return { ok: false, error: 'url' };
      if (!tk) return { ok: false, error: 'token' };
      try { await createRemote({ url: u, token: tk, fetch }).ping(); }
      catch (err) { return { ok: false, error: err.code || 'error', message: String((err && err.message) || err) }; }
      if (getUrl() !== u) await state.clear(); // another server: merge from scratch, never delete
      tokens.set(tk);
      setUrl(u);
      build();
      run();
      return { ok: true, url: u };
    },
    /** Stop syncing; the files stay, the server keeps its copy. */
    async disconnect() {
      tokens.clear();
      setUrl('');
      await state.clear();
      build();
      return { ok: true };
    },
    stop() { clearInterval(timer); clearTimeout(soon); },
  };
}

module.exports = { createDesktopSync, normalizeUrl };
