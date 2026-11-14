'use strict';
// WhimFlow sync server: one library of Markdown files and images (DATA), shared by one
// person's devices. No dependencies; a small HTTP API behind nginx (which does HTTPS):
//
//   GET    /v1/ping                -> { ok, version }
//   GET    /v1/manifest            -> { files: { path: { v, size, mtime } }, dirs: [path] }
//   GET    /v1/file?path=P         -> the bytes, with header X-Version
//   PUT    /v1/file?path=P         -> { v }    If-None-Match: *  to create, If-Match: <v> to replace that version
//   DELETE /v1/file?path=P         -> { ok }   If-Match: <v>; the file goes to DATA/.trash, never erased
//   PUT    /v1/dir?path=P          -> { ok }   create a folder (and its parents)
//   DELETE /v1/dir?path=P          -> { ok }   an empty folder only
//
// A version (v) is the SHA-256 of a file's bytes, the same value the apps already compare
// before every save. A write that names a version the file no longer has is refused (412,
// with the current version), so two devices can never silently overwrite each other; a
// write without a precondition is refused too (428). Writing the bytes a file already has
// always succeeds, so a retried request is harmless.
//
// Every request needs "Authorization: Bearer <WHIMFLOW_TOKEN>".
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const DATA = path.resolve(process.env.DATA || '/data');
const TOKEN = process.env.WHIMFLOW_TOKEN || '';
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = +process.env.MAX_BODY || 50 * 1024 * 1024;
const TRASH = path.join(DATA, '.trash');

if (TOKEN.length < 32) { console.error('WHIMFLOW_TOKEN must be set (32 characters or more)'); process.exit(1); }

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tokenHash = sha(TOKEN);
function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && crypto.timingSafeEqual(Buffer.from(sha(m[1]), 'hex'), Buffer.from(tokenHash, 'hex'));
}

/** A library path ("notes/a.md") as given by a client, or null: relative, no "..", nothing hidden. */
function clean(p) {
  if (typeof p !== 'string') return null;
  p = p.normalize('NFC');
  if (!p || p.length > 1024 || /[\0\\]/.test(p) || p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || s.startsWith('.') || Buffer.byteLength(s) > 255)) return null;
  return parts.join('/');
}
const abs = (rel) => path.join(DATA, ...rel.split('/'));

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

async function manifest() {
  const files = {}, dirs = [];
  async function walk(dir, rel) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue; // .trash, temporary files
      const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { dirs.push(r); await walk(p, r); }
      else if (e.isFile()) {
        const v = await versionOf(p);
        if (!v) continue;
        const st = await fsp.stat(p);
        files[r] = { v, size: st.size, mtime: Math.round(st.mtimeMs) };
      }
    }
  }
  await walk(DATA, '');
  return { files, dirs };
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
async function toTrash(file, rel) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const dest = path.join(TRASH, stamp + '-' + crypto.randomBytes(3).toString('hex'), ...rel.split('/'));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(file, dest);
  cache.delete(file);
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
const unquote = (s) => String(s || '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
const fail = (status, error, extra) => Object.assign(new Error(error), { status, extra });

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (status, obj, headers = {}) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length, ...headers }); res.end(b); };
  if (!authorized(req)) return send(401, { error: 'unauthorized' });
  const route = req.method + ' ' + url.pathname;
  if (route === 'GET /v1/ping') return send(200, { ok: true, version: VERSION });
  if (route === 'GET /v1/manifest') return send(200, await manifest());

  const rel = clean(url.searchParams.get('path'));
  if (!/^\/v1\/(file|dir)$/.test(url.pathname)) return send(404, { error: 'not found' });
  if (!rel) return send(400, { error: 'bad path' });
  const file = abs(rel);

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
      await writeAtomic(file, body);
      cache.set(file, { ...(await fsp.stat(file).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }))), v });
      console.log(new Date().toISOString(), 'put', rel, body.length);
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
      await toTrash(file, rel);
      console.log(new Date().toISOString(), 'delete', rel);
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
      console.log(new Date().toISOString(), 'rmdir', rel);
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
server.listen(PORT, HOST, () => console.log(`whimflow-sync ${VERSION} on ${HOST}:${server.address().port}, data in ${DATA}`));
