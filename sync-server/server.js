'use strict';
// WhimFlow sync server: a library of Markdown files and images per account, shared by that
// account's devices. No dependencies; a small HTTP API behind nginx (which does HTTPS).
//
// Accounts (created by the administrator only; each with a storage quota, 1 GB by default):
//   POST   /v1/login      { name, password, device }     -> { token, account }   (no token needed)
//   POST   /v1/setup      { name, password, device }     -> { token, account }   the first account, the
//          administrator: only while there are none, with the old shared token (WHIMFLOW_TOKEN);
//          the library that token synced becomes this account's
//   GET    /v1/me                                         -> account: name, admin, quota, used, devices
//   GET    /v1/space                                      -> what takes the space: the largest files, the trash
//   POST   /v1/logout                                     -> this device's sign-in ends
//   DELETE /v1/devices?id=                                -> sign another device of this account out
//   POST   /v1/password   { old, new }                   -> other devices are signed out
//   GET    /v1/users                         (admin)      -> every account, with its space
//   POST   /v1/users      { name, password, quota }      (admin) a new account
//   PATCH  /v1/users?name= { quota, password, disabled } (admin) a new password or disabling signs it out
// A sign-in is a random token the device keeps (in its keychain); only its hash is stored here.
// A sign-in not used for 90 days (SESSION_DAYS) ends: that device signs in again.
// Passwords are kept as scrypt hashes. Five wrong passwords lock the name for 15 minutes.
//
// Files (the signed-in account's library):
//   GET    /v1/ping                -> { ok, version }
//   GET    /v1/manifest            -> { files: { path: { v, size, mtime } }, dirs: [path] }
//   GET    /v1/file?path=P         -> the bytes, with header X-Version
//   PUT    /v1/file?path=P         -> { v }    If-None-Match: *  to create, If-Match: <v> to replace that version
//   DELETE /v1/file?path=P         -> { ok }   If-Match: <v>; the file goes to the library's .trash
//   PUT    /v1/dir?path=P          -> { ok }   create a folder (and its parents)
//   DELETE /v1/dir?path=P          -> { ok }   an empty folder only
// A version (v) is the SHA-256 of a file's bytes, the same value the apps compare before every
// save. A write that names a version the file no longer has is refused (412, with the current
// version), so two devices never silently overwrite each other; a write without a precondition
// is refused too (428). Writing the bytes a file already has always succeeds (a retry is
// harmless). A write past the account's quota is refused (507); the trash does not count, and
// what has been in it for 30 days (TRASH_DAYS) is erased.
//
// Before the first account exists the server works as it did: one library (DATA), one shared
// token. Pages may call it from the iPhone app (capacitor://localhost) and from this computer
// (localhost, for tests); more origins in CORS_ORIGINS (comma separated). No cookies are used.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const VERSION = 2;
const DATA = path.resolve(process.env.DATA || '/data');
const TOKEN = process.env.WHIMFLOW_TOKEN || '';
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = +process.env.MAX_BODY || 50 * 1024 * 1024;
const DEFAULT_QUOTA = +process.env.DEFAULT_QUOTA || 1024 ** 3;
const TRASH_DAYS = process.env.TRASH_DAYS != null ? +process.env.TRASH_DAYS : 30;
const SESSION_DAYS = process.env.SESSION_DAYS != null ? +process.env.SESSION_DAYS : 90;
const stale = (s) => Date.now() - s.seen > SESSION_DAYS * 86400e3;
const USERS = path.join(DATA, '.users');
const ACCOUNTS = path.join(DATA, '.accounts.json');
const SESSIONS = path.join(DATA, '.sessions.json');
const ORIGINS = new Set(['capacitor://localhost', ...String(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)]);
const allowedOrigin = (o) => !!o && (ORIGINS.has(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

if (TOKEN && TOKEN.length < 32) { console.error('WHIMFLOW_TOKEN must be 32 characters or more'); process.exit(1); }

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const fail = (status, error, extra) => Object.assign(new Error(error), { status, extra });

// ---------- accounts, kept in two small JSON files (hidden: never part of a library) ----------
let accounts = { users: [] }; // [{ id, name, hash, salt, quota, admin, disabled, created }]
let sessions = {};            // tokenHash -> { user, device, created, seen }
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
async function writeJson(file, obj) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  await fsp.rename(tmp, file);
}
const saveAccounts = () => writeJson(ACCOUNTS, accounts);
const saveSessions = () => writeJson(SESSIONS, sessions);

const scrypt = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
async function setPassword(user, password) {
  if (typeof password !== 'string' || password.length < 8) throw fail(400, 'password', { message: 'at least 8 characters' });
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = await scrypt(password, user.salt);
}
const checkPassword = async (user, password) => sameHash(await scrypt(password, user.salt), user.hash);
const findUser = (name) => accounts.users.find((u) => u.name.toLowerCase() === String(name || '').trim().toLowerCase());
const validName = (name) => typeof name === 'string' && /^[\p{L}\p{N}_.-]{2,32}$/u.test(name.trim());
const rootOf = (user) => path.join(USERS, user.id);

function newSession(user, device) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[sha(token)] = { user: user.id, device: String(device || '').slice(0, 60) || 'device', created: Date.now(), seen: Date.now() };
  return token;
}
const endSessions = (user, except) => { for (const [h, s] of Object.entries(sessions)) if (s.user === user.id && h !== except) delete sessions[h]; };
const sessionId = (hash) => hash.slice(0, 12); // what a device is called in the list: never enough to sign in with

// wrong passwords: five within 15 minutes lock that name (from that address) for 15 minutes
const tries = new Map(); // key -> { n, until }
function locked(key) { const t = tries.get(key); return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0; }
function wrong(key) { const t = tries.get(key) || { n: 0, until: 0 }; t.n++; if (t.n >= 5) { t.until = Date.now() + 15 * 60e3; t.n = 0; } tries.set(key, t); }

// ---------- who is asking ----------
async function caller(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha(m[1]);
  if (!accounts.users.length) return TOKEN && sameHash(h, sha(TOKEN)) ? { legacy: true, root: DATA } : null;
  const s = sessions[h];
  const user = s && accounts.users.find((u) => u.id === s.user);
  if (!user || user.disabled) return null;
  if (s && stale(s)) { delete sessions[h]; saveSessions().catch(() => {}); return null; } // not used for 90 days
  if (Date.now() - s.seen > 60e3) { s.seen = Date.now(); saveSessions().catch(() => {}); }
  return { user, hash: h, root: rootOf(user) };
}

// ---------- a library ----------
/** A library path ("notes/a.md") as given by a client, or null: relative, no "..", nothing hidden. */
function clean(p) {
  if (typeof p !== 'string') return null;
  p = p.normalize('NFC');
  if (!p || p.length > 1024 || /[\0\\]/.test(p) || p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || s.startsWith('.') || Buffer.byteLength(s) > 255)) return null;
  return parts.join('/');
}
const abs = (root, rel) => path.join(root, ...rel.split('/'));

// versions of files already read, while their size and time are unchanged
const cache = new Map(); // abs path -> { mtimeMs, size, v }
async function versionOf(file) {
  let st;
  try { st = await fsp.stat(file); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; throw err; }
  if (!st.isFile()) return undefined; // a folder where a file was asked for
  const c = cache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.v;
  const v = sha(await fsp.readFile(file));
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, v });
  return v;
}

async function walk(root, onFile, onDir) {
  async function go(dir, rel) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue; // .trash, temporary files, the accounts
      const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (onDir) onDir(r); await go(p, r); } else if (e.isFile()) await onFile(p, r);
    }
  }
  await go(root, '');
}
async function manifest(root) {
  const files = {}, dirs = [];
  await walk(root, async (p, r) => {
    const v = await versionOf(p);
    if (!v) return;
    const st = await fsp.stat(p);
    files[r] = { v, size: st.size, mtime: Math.round(st.mtimeMs) };
  }, (r) => dirs.push(r));
  return { files, dirs };
}
/** Bytes the library takes (the trash does not count). */
async function usage(root) {
  let n = 0;
  await walk(root, async (p) => { try { n += (await fsp.stat(p)).size; } catch (_) { /* gone */ } });
  return n;
}

// changes happen one at a time: a version check and the write after it are never split
let queue = Promise.resolve();
const serial = (fn) => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };

/** Replace a file without ever leaving half of it: write a hidden temporary file, flush, rename. */
async function writeAtomic(file, buf) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'wx', 0o644);
  try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
  try { await fsp.rename(tmp, file); } catch (err) { await fsp.rm(tmp, { force: true }); throw err; }
}
async function toTrash(root, file, rel) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const dest = path.join(root, '.trash', stamp + '-' + crypto.randomBytes(3).toString('hex'), ...rel.split('/'));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(file, dest);
  cache.delete(file);
}
/** Erase what has been in a library's trash longer than TRASH_DAYS. */
async function emptyOldTrash(root) {
  const trash = path.join(root, '.trash');
  let ents;
  try { ents = await fsp.readdir(trash); } catch (_) { return; }
  const before = Date.now() - TRASH_DAYS * 86400e3;
  for (const n of ents) {
    const p = path.join(trash, n);
    try { if ((await fsp.stat(p)).mtimeMs < before) await fsp.rm(p, { recursive: true, force: true }); } catch (_) { /* gone */ }
  }
}
async function emptyAllOldTrash() {
  await emptyOldTrash(DATA);
  for (const u of accounts.users) await emptyOldTrash(rootOf(u));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // past the limit the rest is read and dropped, so the client gets a 413 rather than a reset connection
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= MAX_BODY) chunks.push(c); else chunks.length = 0; });
    req.on('end', () => (n > MAX_BODY ? reject(fail(413, 'too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch (_) { throw fail(400, 'bad json'); }
}
const unquote = (s) => String(s || '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');

/** What takes an account's space: its 10 largest files; and what its trash holds (it does not count). */
async function spaceOf(user) {
  const root = rootOf(user), files = [];
  let used = 0, trash = 0;
  await walk(root, async (p, r) => { try { const n = (await fsp.stat(p)).size; used += n; files.push({ path: r, size: n }); } catch (_) { /* gone */ } });
  async function count(dir) {
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) await count(p); else { try { trash += (await fsp.stat(p)).size; } catch (_) { /* gone */ } } }
  }
  await count(path.join(root, '.trash'));
  files.sort((a, b) => b.size - a.size);
  return { used, quota: user.quota, files: files.length, largest: files.slice(0, 10), trash, trashDays: TRASH_DAYS };
}

async function accountOf(user, hash) {
  return {
    name: user.name, admin: !!user.admin, quota: user.quota, used: await usage(rootOf(user)),
    devices: Object.entries(sessions).filter(([, s]) => s.user === user.id)
      .map(([h, s]) => ({ id: sessionId(h), device: s.device, created: s.created, seen: s.seen, current: h === hash }))
      .sort((a, b) => b.seen - a.seen),
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (allowedOrigin(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Expose-Headers', 'X-Version');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Authorization, If-Match, If-None-Match, Content-Type', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
  }
  const send = (status, obj, headers = {}) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length, ...headers }); res.end(b); };
  const route = req.method + ' ' + url.pathname;
  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;

  // ---- signing in (no token yet) ----
  if (route === 'POST /v1/login') {
    const { name, password, device } = await readJsonBody(req);
    if (!accounts.users.length) return send(409, { error: 'setup' }); // no accounts yet: the administrator's comes first
    const key = String(name || '').trim().toLowerCase() + '|' + ip;
    const wait = locked(key);
    if (wait) return send(429, { error: 'locked', retryAfter: wait });
    const user = findUser(name);
    if (!user || !(await checkPassword(user, password))) { wrong(key); return send(401, { error: 'wrong' }); }
    if (user.disabled) return send(403, { error: 'disabled' });
    tries.delete(key);
    const token = newSession(user, device);
    await saveSessions();
    return send(200, { token, account: await accountOf(user, sha(token)) });
  }

  const who = await caller(req);
  if (!who) return send(401, { error: 'unauthorized' });
  if (route === 'GET /v1/ping') return send(200, { ok: true, version: VERSION, accounts: !who.legacy });

  // ---- the first account, from the old shared token: it takes over that library ----
  if (route === 'POST /v1/setup') {
    if (!who.legacy) return send(409, { error: 'accounts exist' });
    const { name, password, device } = await readJsonBody(req);
    if (!validName(name)) return send(400, { error: 'name' });
    const out = await serial(async () => {
      if (accounts.users.length) throw fail(409, 'accounts exist');
      const user = { id: crypto.randomBytes(8).toString('hex'), name: name.trim(), quota: DEFAULT_QUOTA, admin: true, disabled: false, created: Date.now() };
      await setPassword(user, password);
      const root = rootOf(user);
      await fsp.mkdir(root, { recursive: true });
      for (const n of await fsp.readdir(DATA)) {                       // the library, and its trash, move in
        if (n === '.users' || n === '.accounts.json' || n === '.sessions.json' || (n.startsWith('.') && n !== '.trash')) continue;
        await fsp.rename(path.join(DATA, n), path.join(root, n));
      }
      cache.clear();
      accounts.users.push(user);
      await saveAccounts();
      const token = newSession(user, device);
      await saveSessions();
      console.log(new Date().toISOString(), 'setup', user.name);
      return { token, account: await accountOf(user, sha(token)) };
    });
    return send(200, out);
  }

  // ---- the account ----
  if (url.pathname === '/v1/me' || url.pathname === '/v1/space' || url.pathname === '/v1/logout' || url.pathname === '/v1/devices' || url.pathname === '/v1/password' || url.pathname === '/v1/users') {
    if (who.legacy) return send(409, { error: 'setup' }); // no accounts yet
    const { user, hash } = who;
    if (route === 'GET /v1/me') return send(200, await accountOf(user, hash));
    if (route === 'GET /v1/space') return send(200, await spaceOf(user));
    if (route === 'POST /v1/logout') { delete sessions[hash]; await saveSessions(); return send(200, { ok: true }); }
    if (route === 'DELETE /v1/devices') {
      const id = url.searchParams.get('id');
      const h = Object.keys(sessions).find((k) => sessionId(k) === id && sessions[k].user === user.id);
      if (h) { delete sessions[h]; await saveSessions(); }
      return send(200, { ok: true });
    }
    if (route === 'POST /v1/password') {
      const b = await readJsonBody(req);
      if (!(await checkPassword(user, b.old))) return send(401, { error: 'wrong' });
      await setPassword(user, b.new);
      await saveAccounts();
      endSessions(user, hash);
      await saveSessions();
      return send(200, { ok: true });
    }
    // ---- the administrator ----
    if (!user.admin) return send(403, { error: 'admin only' });
    if (route === 'GET /v1/users') {
      const list = [];
      for (const u of accounts.users) list.push({ name: u.name, admin: !!u.admin, quota: u.quota, used: await usage(rootOf(u)), disabled: !!u.disabled, devices: Object.values(sessions).filter((s) => s.user === u.id).length, created: u.created });
      return send(200, { users: list });
    }
    if (route === 'POST /v1/users') {
      const b = await readJsonBody(req);
      if (!validName(b.name)) return send(400, { error: 'name' });
      if (findUser(b.name)) return send(409, { error: 'taken' });
      const quota = b.quota == null ? DEFAULT_QUOTA : Math.round(+b.quota);
      if (!(quota > 0)) return send(400, { error: 'quota' });
      const u = { id: crypto.randomBytes(8).toString('hex'), name: b.name.trim(), quota, admin: false, disabled: false, created: Date.now() };
      await setPassword(u, b.password);
      await fsp.mkdir(rootOf(u), { recursive: true });
      accounts.users.push(u);
      await saveAccounts();
      console.log(new Date().toISOString(), 'user created', u.name);
      return send(200, { ok: true });
    }
    if (route === 'PATCH /v1/users') {
      const u = findUser(url.searchParams.get('name'));
      if (!u) return send(404, { error: 'no such account' });
      const b = await readJsonBody(req);
      if (b.quota != null) { const q = Math.round(+b.quota); if (!(q > 0)) return send(400, { error: 'quota' }); u.quota = q; }
      if (b.password != null) { await setPassword(u, b.password); endSessions(u); }
      if (b.disabled != null) {
        if (u.id === user.id) return send(400, { error: 'not yourself' });
        u.disabled = !!b.disabled;
        if (u.disabled) endSessions(u);
      }
      await saveAccounts();
      await saveSessions();
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  }

  // ---- files ----
  const root = who.root;
  if (route === 'GET /v1/manifest') return send(200, await manifest(root));
  const rel = clean(url.searchParams.get('path'));
  if (!/^\/v1\/(file|dir)$/.test(url.pathname)) return send(404, { error: 'not found' });
  if (!rel) return send(400, { error: 'bad path' });
  const file = abs(root, rel);

  if (route === 'GET /v1/file') {
    const v = await versionOf(file);
    if (!v) return send(404, { error: 'not found' });
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Version': sha(buf) });
    return res.end(buf);
  }
  if (route === 'PUT /v1/file') {
    const body = await readBody(req);
    const v = sha(body);
    const ifMatch = req.headers['if-match'], create = unquote(req.headers['if-none-match']) === '*';
    if (!ifMatch && !create) return send(428, { error: 'a version (If-Match) or If-None-Match: * is required' });
    const out = await serial(async () => {
      const cur = await versionOf(file);
      if (cur === undefined) throw fail(409, 'a folder has this name');
      if (cur === v) return { v, same: true };                       // already these bytes (a retry, or the same edit)
      if (create ? cur !== null : cur !== unquote(ifMatch)) throw fail(412, 'changed on the server', { current: cur });
      if (who.user) {                                                 // the account's space
        const old = cur ? (await fsp.stat(file)).size : 0;
        const used = await usage(root);
        if (used - old + body.length > who.user.quota) throw fail(507, 'quota', { used, quota: who.user.quota });
      }
      await writeAtomic(file, body);
      cache.set(file, { ...(await fsp.stat(file).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }))), v });
      console.log(new Date().toISOString(), 'put', who.user ? who.user.name : '-', rel, body.length);
      return { v };
    });
    return send(200, out);
  }
  if (route === 'DELETE /v1/file') {
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) return send(428, { error: 'If-Match is required' });
    await serial(async () => {
      const cur = await versionOf(file);
      if (cur === null) return;                                       // already gone
      if (cur === undefined) throw fail(409, 'this is a folder');
      if (cur !== unquote(ifMatch)) throw fail(412, 'changed on the server', { current: cur });
      await toTrash(root, file, rel);
      console.log(new Date().toISOString(), 'delete', who.user ? who.user.name : '-', rel);
    });
    return send(200, { ok: true });
  }
  if (route === 'PUT /v1/dir') {
    await serial(async () => {
      try { await fsp.mkdir(file, { recursive: true }); } catch (err) { if (err.code === 'EEXIST' || err.code === 'ENOTDIR') throw fail(409, 'a file has this name'); throw err; }
    });
    return send(200, { ok: true });
  }
  if (route === 'DELETE /v1/dir') {
    await serial(async () => {
      let ents;
      try { ents = await fsp.readdir(file); } catch (err) { if (err.code === 'ENOENT') return; if (err.code === 'ENOTDIR') throw fail(409, 'this is a file'); throw err; }
      if (ents.some((n) => !n.startsWith('.'))) throw fail(409, 'the folder is not empty');
      await fsp.rm(file, { recursive: true }); // only hidden leftovers (temporary files) inside
      console.log(new Date().toISOString(), 'rmdir', who.user ? who.user.name : '-', rel);
    });
    return send(200, { ok: true });
  }
  return send(405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = err.status || 500;
    if (status === 500) console.error(err);
    const b = Buffer.from(JSON.stringify({ error: err.message, ...(err.extra || {}) }));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length, Connection: 'close' });
    res.end(b);
  });
});
fs.mkdirSync(DATA, { recursive: true });
accounts = readJson(ACCOUNTS, { users: [] });
sessions = readJson(SESSIONS, {});
if (!accounts.users.length && !TOKEN) console.warn('no accounts and no WHIMFLOW_TOKEN: nobody can sign in or set up the first account');
emptyAllOldTrash().catch((err) => console.error('trash', err));
function endStaleSessions() {
  let n = 0;
  for (const [h, s] of Object.entries(sessions)) if (stale(s)) { delete sessions[h]; n++; }
  if (n) saveSessions().catch(() => {});
}
endStaleSessions();
setInterval(() => { emptyAllOldTrash().catch((err) => console.error('trash', err)); endStaleSessions(); }, 6 * 3600e3).unref();
server.listen(PORT, HOST, () => console.log(`whimflow-sync ${VERSION} on ${HOST}:${server.address().port}, data in ${DATA}, ${accounts.users.length} account(s)`));
