'use strict';
// Two-way sync of a WhimFlow library with the sync server (sync-server/server.js). Shared by
// the desktop (main process) and the iPhone app (bundled into the page): nothing here touches
// files or the network itself, `local` and `remote` do, so the same rules run everywhere.
//
// Each pass compares three versions of every path: here (local), on the server (remote), and
// the one both last agreed on (base, kept by `state`). A version is the SHA-256 of the bytes.
//   - only one side changed it            -> the change is copied to the other side
//   - both changed it, differently        -> nothing is lost: the server's text stays under the
//                                            name, this device's text is kept beside it as a copy
//                                            "name (冲突 <device> <time>).md", on both sides
//   - one side deleted it, the other edited it -> the edit wins, the file comes back
//   - a delete goes to the trash on the other side too, it never erases
// The first pass (no base yet) only adds, it never deletes. If one whole side is suddenly empty
// while the base remembers files (a library folder moved away, a server restored from nothing),
// the base is dropped rather than deleting everything on the other side.
// Every write names the version it replaces, here and on the server, so an edit made during a
// pass is never overwritten; what could not be done now is picked up by the next pass.
//
// local:  list() -> { files: { path: { v } }, dirs: [path] }      paths relative, "/"-separated, NFC
//         read(path) -> bytes;  write(path, bytes, expected) -> true | false (expected: version, or
//         null for "must not exist");  trash(path, expected) -> true | false;
//         mkdir(path);  rmdir(path) -> true | false (only when empty)
// remote: createRemote() below, or the same shape
// state:  load() -> { files: { path: v }, dirs: [path] } | null;  save(that)

/** The name for this device's copy of a file both sides changed: "a/笔记 (冲突 iPhone 2026-11-14 20.05).md". */
function conflictName(p, device, date, taken) {
  const slash = p.lastIndexOf('/');
  const dir = p.slice(0, slash + 1), name = p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
  const who = String(device || '').replace(/[\\/:*?"<>|\0]/g, '').trim() || '另一台设备';
  for (let i = 1; ; i++) {
    const c = `${dir}${stem} (冲突 ${who} ${when}${i > 1 ? ' ' + i : ''})${ext}`;
    if (!taken(c)) return c;
  }
}

const depth = (p) => p.split('/').length;

function createSync({ local, remote, state, device, now = () => new Date(), hash = null, log = () => {} }) {
  async function pass() {
    const [L, R, saved] = await Promise.all([local.list(), remote.manifest(), state.load()]);
    let base = { files: { ...((saved && saved.files) || {}) }, dirs: new Set((saved && saved.dirs) || []) };
    const out = { up: [], down: [], removedHere: [], removedThere: [], conflicts: [], skipped: [], errors: [], reset: false };
    const nB = Object.keys(base.files).length;
    if (nB && (!Object.keys(L.files).length || !Object.keys(R.files).length)) {
      base = { files: {}, dirs: new Set() }; // a whole side is empty: merge again rather than delete everything
      out.reset = true;
    }
    const step = async (p, fn) => {
      try { await fn(); } catch (err) {
        if (err && err.code === 'auth') throw err;
        out.errors.push({ path: p, error: String((err && err.message) || err) });
        log('sync error', p, err);
      }
    };
    const save = () => state.save({ files: base.files, dirs: [...base.dirs].sort() });

    async function download(p, expectLocal) {
      const got = await remote.get(p);
      if (!got) { out.skipped.push(p); return false; }                  // gone from the server meanwhile
      if (hash && (await hash(got.bytes)) !== got.v) throw new Error('damaged in transfer');
      if (!(await local.write(p, got.bytes, expectLocal))) { out.skipped.push(p); return false; } // edited here meanwhile
      base.files[p] = got.v;
      out.down.push(p);
      return true;
    }
    async function upload(p, v, replaces) {
      const bytes = await local.read(p);
      if (hash && (await hash(bytes)) !== v) { out.skipped.push(p); return false; } // edited here meanwhile
      const r = await remote.put(p, bytes, replaces ? { ifMatch: replaces } : { create: true });
      if (r.conflict) { out.skipped.push(p); return false; }            // changed on the server meanwhile: next pass
      base.files[p] = r.v;
      out.up.push(p);
      return true;
    }

    try {
      // 1) folders new on one side are made on the other (parents first); removals wait for step 3
      const Ld = new Set(L.dirs), Rd = new Set(R.dirs);
      const dirs = [...new Set([...Ld, ...Rd, ...base.dirs])].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
      const goneThere = [], goneHere = [];
      for (const d of dirs) {
        const l = Ld.has(d), r = Rd.has(d), b = base.dirs.has(d);
        if (l && r) base.dirs.add(d);
        else if (l) { if (b) goneThere.push(d); else await step(d, async () => { await remote.mkdir(d); base.dirs.add(d); out.up.push(d + '/'); }); }
        else if (r) { if (b) goneHere.push(d); else await step(d, async () => { await local.mkdir(d); base.dirs.add(d); out.down.push(d + '/'); }); }
        else base.dirs.delete(d);
      }

      // 2) files
      const lower = new Map(Object.keys(L.files).map((p) => [p.toLowerCase(), p]));
      const taken = (c) => c in L.files || c in R.files;
      const paths = [...new Set([...Object.keys(L.files), ...Object.keys(R.files), ...Object.keys(base.files)])].sort();
      for (const p of paths) {
        const l = L.files[p] && L.files[p].v, r = R.files[p] && R.files[p].v, b = base.files[p];
        await step(p, async () => {
          if (l === r) { if (l) base.files[p] = l; else delete base.files[p]; return; }
          if (l === b) {                                                   // only the server changed it
            if (!r) {
              if (await local.trash(p, l)) { delete base.files[p]; out.removedHere.push(p); } else out.skipped.push(p);
              return;
            }
            const same = !l && lower.get(p.toLowerCase());
            if (same && same !== p) { out.skipped.push(p); return; }      // "A.md" here, "a.md" there: one file on this system
            await download(p, l || null);
            return;
          }
          if (r === b) {                                                   // only this device changed it
            if (!l) {
              const x = await remote.del(p, r);
              if (x.conflict) { out.skipped.push(p); return; }
              delete base.files[p]; out.removedThere.push(p);
              return;
            }
            await upload(p, l, b);
            return;
          }
          // both changed it
          if (!l) { if (await download(p, null)) out.conflicts.push({ path: p, kept: 'edit from the server' }); return; }
          if (!r) { if (await upload(p, l, null)) out.conflicts.push({ path: p, kept: 'edit from this device' }); return; }
          const mine = await local.read(p);
          if (hash && (await hash(mine)) !== l) { out.skipped.push(p); return; }
          const copy = conflictName(p, device, now(), taken);
          if (!(await local.write(copy, mine, null))) { out.skipped.push(p); return; } // this device's text is safe first
          L.files[copy] = { v: l };
          if (!(await download(p, l))) return;                             // the server's text under the name
          const r2 = await remote.put(copy, mine, { create: true });       // and the copy for the other devices
          if (r2.v) base.files[copy] = r2.v;
          out.conflicts.push({ path: p, copy });
        });
      }

      // 3) folders removed on the other side go here too, once empty (deepest first)
      const deepFirst = (a, b) => depth(b) - depth(a);
      for (const d of goneHere.sort(deepFirst)) {
        await step(d, async () => {
          const x = await remote.rmdir(d);
          if (x.ok) { base.dirs.delete(d); out.removedThere.push(d + '/'); }
        });
      }
      for (const d of goneThere.sort(deepFirst)) {
        await step(d, async () => {
          if (await local.rmdir(d)) { base.dirs.delete(d); out.removedHere.push(d + '/'); }
        });
      }
    } finally {
      await save();
    }
    return out;
  }

  // one pass at a time; asking during a pass runs one more pass right after it
  let running = null, again = false;
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        let res;
        do { again = false; res = await pass(); } while (again);
        return res;
      } finally { running = null; }
    })();
    return running;
  }
  return { sync, isRunning: () => !!running };
}

/** The sync server's API over fetch (Node's, the page's, or one that goes through native code). */
function createRemote({ url, token, fetch: f = globalThis.fetch }) {
  const root = String(url || '').replace(/\/+$/, '');
  const q = (p) => '?path=' + encodeURIComponent(p);
  async function call(method, route, { body, headers } = {}) {
    let r;
    try {
      r = await f(root + route, { method, body, headers: { Authorization: 'Bearer ' + token, ...(headers || {}) } });
    } catch (err) {
      throw Object.assign(new Error('offline: ' + ((err && err.message) || err)), { code: 'offline' });
    }
    if (r.status === 401) throw Object.assign(new Error('the server did not accept the token'), { code: 'auth' });
    return r;
  }
  const fail = async (r) => { let m = ''; try { m = (await r.json()).error; } catch (_) {} return new Error(`server: ${r.status} ${m || ''}`.trim()); };
  return {
    async ping() { const r = await call('GET', '/v1/ping'); if (!r.ok) throw await fail(r); return r.json(); },
    async manifest() { const r = await call('GET', '/v1/manifest'); if (!r.ok) throw await fail(r); return r.json(); },
    async get(p) {
      const r = await call('GET', '/v1/file' + q(p));
      if (r.status === 404) return null;
      if (!r.ok) throw await fail(r);
      return { bytes: new Uint8Array(await r.arrayBuffer()), v: r.headers.get('x-version') };
    },
    async put(p, bytes, { ifMatch, create }) {
      const r = await call('PUT', '/v1/file' + q(p), { body: bytes, headers: create ? { 'If-None-Match': '*' } : { 'If-Match': ifMatch } });
      if (r.status === 412) return { conflict: true, current: (await r.json()).current };
      if (!r.ok) throw await fail(r);
      return { ok: true, v: (await r.json()).v };
    },
    async del(p, ifMatch) {
      const r = await call('DELETE', '/v1/file' + q(p), { headers: { 'If-Match': ifMatch } });
      if (r.status === 412) return { conflict: true, current: (await r.json()).current };
      if (!r.ok) throw await fail(r);
      return { ok: true };
    },
    async mkdir(p) { const r = await call('PUT', '/v1/dir' + q(p)); if (!r.ok) throw await fail(r); return { ok: true }; },
    async rmdir(p) {
      const r = await call('DELETE', '/v1/dir' + q(p));
      if (r.status === 409) return { ok: false, notEmpty: true };
      if (!r.ok) throw await fail(r);
      return { ok: true };
    },
  };
}

/** Whether a library path is synced: nothing hidden, no temporary files, names the server accepts. */
function syncable(p) {
  if (!p) return false;
  return p.split('/').every((s) => s && !s.startsWith('.') && !s.endsWith('.mftmp') && !/[\\\0]/.test(s) && new TextEncoder().encode(s).length <= 255);
}

module.exports = { createSync, createRemote, conflictName, syncable };
