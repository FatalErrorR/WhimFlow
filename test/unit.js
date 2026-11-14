// Unit and integration tests that need no window: Trash, atomic saves, image names
// and links, folder search in a worker, recovery drafts, renderer path helpers.
// Every file operation happens in a fresh temporary folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const fileops = require(path.join(root, 'src/main/fileops'));
const images = require(path.join(root, 'src/main/images'));
const { createSearch } = require(path.join(root, 'src/main/search'));
const makeRecovery = require(path.join(root, 'src/main/recovery'));

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `mf-unit-${name}-`));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Trash ----------
test('trash: a failing Trash deletes nothing (file and folder)', async () => {
  const dir = tmp('trash');
  const file = path.join(dir, 'note.md');
  const folder = path.join(dir, 'folder');
  fs.writeFileSync(file, 'keep me');
  fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'inner.md'), 'keep me too');
  // any attempt to delete for good would be recorded here
  const deletions = [];
  const spied = [[fs.promises, 'rm'], [fs.promises, 'rmdir'], [fs.promises, 'unlink'], [fs, 'rmSync'], [fs, 'rmdirSync'], [fs, 'unlinkSync'], [fs, 'rm']];
  const saved = spied.map(([o, k]) => o[k]);
  spied.forEach(([o, k]) => { o[k] = (...a) => { deletions.push([k, a[0]]); throw new Error('deletion attempted'); }; });
  try {
    const fail = async () => { throw new Error('Trash is not available on this volume'); };
    const r1 = await fileops.moveToTrash(file, { trashItem: fail });
    const r2 = await fileops.moveToTrash(folder, { trashItem: fail });
    assert.deepStrictEqual(r1, { ok: false, error: 'Trash is not available on this volume' });
    assert.strictEqual(r2.ok, false);
  } finally { spied.forEach(([o, k], i) => { o[k] = saved[i]; }); }
  assert.deepStrictEqual(deletions, [], 'nothing was removed');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'keep me');
  assert.strictEqual(fs.readFileSync(path.join(folder, 'inner.md'), 'utf8'), 'keep me too');
});
test('trash: success goes through trashItem only', async () => {
  const calls = [];
  const r = await fileops.moveToTrash('/x/y.md', { trashItem: async (p) => { calls.push(p); } });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(calls, ['/x/y.md']);
});

// ---------- atomic save ----------
test('atomic write: replaces content, keeps permissions, leaves no temporary file', async () => {
  const dir = tmp('atomic');
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o640);
  const r = await fileops.writeFileAtomic(file, '新内容 new');
  assert.strictEqual(r.atomic, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '新内容 new');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepStrictEqual(fs.readdirSync(dir), ['doc.md']);
  await fileops.writeFileAtomic(path.join(dir, 'fresh.md'), 'created');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'fresh.md'), 'utf8'), 'created');
});
test('atomic write: a symlinked document stays a symlink', async () => {
  const dir = tmp('link');
  fs.mkdirSync(path.join(dir, 'real'));
  const real = path.join(dir, 'real', 'doc.md');
  fs.writeFileSync(real, 'v1');
  fs.symlinkSync(real, path.join(dir, 'link.md'));
  await fileops.writeFileAtomic(path.join(dir, 'link.md'), 'v2');
  assert(fs.lstatSync(path.join(dir, 'link.md')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(real, 'utf8'), 'v2');
});
test('atomic write: a failed replace leaves the original intact and cleans up', async () => {
  const dir = tmp('fail');
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, 'original');
  const fsp = { ...fs.promises, rename: async () => { const e = new Error('EXDEV: cross-device'); e.code = 'EXDEV'; throw e; } };
  await assert.rejects(fileops.writeFileAtomic(file, 'new', { fsp }), /EXDEV/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepStrictEqual(fs.readdirSync(dir), ['doc.md'], 'temporary file removed');
});
test('atomic write: a busy file (Windows) is retried, then succeeds', async () => {
  const dir = tmp('busy');
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, 'original');
  let tries = 0;
  const fsp = { ...fs.promises, rename: async (a, b) => { if (++tries < 3) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return fs.promises.rename(a, b); } };
  await fileops.writeFileAtomic(file, 'new', { fsp });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  assert.strictEqual(tries, 3);
});
test('atomic write: a folder that refuses new files falls back to writing in place', async () => {
  const dir = tmp('perm');
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, 'original');
  const fsp = { ...fs.promises, open: async (p, flags, mode) => { if (String(p).endsWith('.mftmp')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return fs.promises.open(p, flags, mode); } };
  const r = await fileops.writeFileAtomic(file, 'new', { fsp });
  assert.strictEqual(r.atomic, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
});
test('file versions: content hash, null for a missing file, equal to what a save wrote', async () => {
  const dir = tmp('ver');
  const file = path.join(dir, 'doc.md');
  assert.strictEqual(await fileops.fileVersion(file), null);
  await fileops.writeFileAtomic(file, '内容 v1\n');
  const v1 = await fileops.fileVersion(file);
  assert.strictEqual(v1.sha256, fileops.contentVersion('内容 v1\n'), 'the version a save reports is the version on disk');
  assert.strictEqual(v1.size, Buffer.byteLength('内容 v1\n'));
  // same size, same mtime are not enough: only the content decides
  fs.writeFileSync(file, '内容 v2\n');
  fs.utimesSync(file, v1.mtimeMs / 1000, v1.mtimeMs / 1000);
  const v2 = await fileops.fileVersion(file);
  assert.strictEqual(v2.size, v1.size);
  assert.notStrictEqual(v2.sha256, v1.sha256);
});
test('save queue: saves of one file never overlap, and keep their order', async () => {
  const run = fileops.keyedQueue();
  const log = [];
  let inside = 0, maxInside = 0;
  const task = (name, ms) => async () => { inside++; maxInside = Math.max(maxInside, inside); log.push('start ' + name); await sleep(ms); log.push('end ' + name); inside--; };
  await Promise.all([run('/a.md', task('A', 60)), run('/a.md', task('B', 5)), run('/a.md', task('C', 20))]);
  assert.strictEqual(maxInside, 1);
  assert.deepStrictEqual(log, ['start A', 'end A', 'start B', 'end B', 'start C', 'end C']);
});
test('rename paths: only whole segments move', () => {
  assert.strictEqual(fileops.remapPath('/w/notes/a.md', '/w/notes', '/w/journal'), '/w/journal/a.md');
  assert.strictEqual(fileops.remapPath('/w/notes', '/w/notes', '/w/journal'), '/w/journal');
  assert.strictEqual(fileops.remapPath('/w/notes/sub/b.md', '/w/notes', '/w/journal'), '/w/journal/sub/b.md');
  assert.strictEqual(fileops.remapPath('/w/notes-old/c.md', '/w/notes', '/w/journal'), null);
  assert.strictEqual(fileops.remapPath('/w/notesX', '/w/notes', '/w/journal'), null);
  assert.strictEqual(fileops.remapPath('C:\\w\\notes\\a.md', 'C:\\w\\notes', 'C:\\w\\j', path.win32), 'C:\\w\\j\\a.md');
  assert.strictEqual(fileops.remapPath('C:\\w\\notes2\\a.md', 'C:\\w\\notes', 'C:\\w\\j', path.win32), null);
});

// ---------- images ----------
test('images: parallel saves of the same name keep every image', async () => {
  const dir = tmp('img');
  const doc = path.join(dir, 'doc.md');
  fs.writeFileSync(doc, '');
  const settings = { imageFolder: './assets', imageRelative: true };
  const N = 24;
  const links = await Promise.all(Array.from({ length: N }, (_, i) => images.saveImage(settings, doc, dir, 'shot.png', Buffer.from(`image number ${i}`))));
  assert.strictEqual(new Set(links).size, N, 'every save got its own file: ' + links.join(' '));
  const files = fs.readdirSync(path.join(dir, 'assets')).sort();
  assert.strictEqual(files.length, N);
  assert(files.includes('shot.png') && files.includes('shot-1.png'));
  links.forEach((link, i) => assert.strictEqual(fs.readFileSync(path.join(dir, decodeURIComponent(link)), 'utf8'), `image number ${i}`, 'link ' + link));
});
test('images: links survive spaces, #, ?, CJK, parentheses and backslashes', async () => {
  const base = tmp('names');
  const folder = path.join(base, 'my #1 ?文档 (draft)');
  fs.mkdirSync(folder);
  const doc = path.join(folder, 'doc.md');
  const settings = { imageFolder: './assets', imageRelative: true };
  const rel = await images.saveImage(settings, doc, base, '截图 #2?.png', Buffer.from('x'));
  assert.strictEqual(rel, 'assets/%E6%88%AA%E5%9B%BE-2-.png');
  // relative link to a folder with special characters
  const odd = path.join(folder, 'a #b?', 'c (1).png');
  const link = images.linkFor(settings, doc, odd);
  assert.strictEqual(link, 'a%20%23b%3F/c%20%281%29.png');
  assert.strictEqual(path.join(folder, ...link.split('/').map(decodeURIComponent)), odd);
  // absolute (file://) links
  for (const p of ['/tmp/a b/#1?/截图.png', '/tmp/back\\slash/x%20y.png', path.join(folder, 'z.png')]) {
    const url = images.toUrl(p);
    assert(!/[ #?]/.test(url.slice('file://'.length)), 'encoded: ' + url);
    assert.strictEqual(fileURLToPath(url), p, 'round trip ' + url);
  }
  const unsaved = await images.saveImage({ imageFolder: './assets' }, null, path.join(base, 'user #data'), 'p.png', Buffer.from('y'));
  assert(unsaved.startsWith('file:///') && unsaved.includes('user%20%23data'), unsaved);
  assert.strictEqual(fs.readFileSync(fileURLToPath(unsaved), 'utf8'), 'y');
});
test('images: Windows paths become proper file URLs', () => {
  const W = path.win32;
  assert.strictEqual(images.toUrl('C:\\Users\\me\\My #1\\图 ?.png', W), 'file:///C:/Users/me/My%20%231/%E5%9B%BE%20%3F.png');
  assert.strictEqual(images.linkFor({ imageRelative: true }, 'C:\\notes\\doc.md', 'C:\\notes\\assets\\a #b.png', W), 'assets/a%20%23b.png');
  assert.strictEqual(images.linkFor({ imageRelative: true }, 'C:\\notes\\doc.md', 'D:\\pics\\x.png', W), 'file:///D:/pics/x.png', 'another drive');
});

// ---------- search ----------
function searchFolder() {
  const dir = tmp('search');
  fs.writeFileSync(path.join(dir, 'a.md'), 'Hello world\nhello again\nworldly things\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), 'The World is wide\n' + 'a'.repeat(40) + '!\n');
  fs.writeFileSync(path.join(dir, 'skip.png'), 'hello');
  return dir;
}
test('search: plain, case, whole word and regex still work (in a worker)', async () => {
  const dir = searchFolder();
  const s = createSearch();
  const count = (r) => r.total;
  assert.strictEqual(count(await s.run('w', dir, 'hello', {})), 2);
  assert.strictEqual(count(await s.run('w', dir, 'hello', { caseSensitive: true })), 1);
  assert.strictEqual(count(await s.run('w', dir, 'world', {})), 3);
  assert.strictEqual(count(await s.run('w', dir, 'world', { word: true })), 2);
  const re = await s.run('w', dir, 'w.rld', { regex: true });
  assert.strictEqual(re.total, 3);
  assert.deepStrictEqual(re.files.map((f) => f.name).sort(), ['a.md', 'b.md']);
  const hit = re.files.find((f) => f.name === 'a.md').matches[0];
  assert.deepStrictEqual([hit.line, hit.col, hit.len], [1, 6, 5]);
  const bad = await s.run('w', dir, '(unclosed', { regex: true });
  assert.strictEqual(bad.code, 'invalid');
  assert(bad.error);
});
test('search: without a configured limit the default applies (searches do not time out at once)', async () => {
  const dir = searchFolder();
  const r = await createSearch({ timeout: () => undefined }).run('w', dir, 'hello', {});
  assert.strictEqual(r.total, 2, JSON.stringify(r));
});
test('search: a catastrophic regex times out and never blocks this thread', async () => {
  const dir = searchFolder();
  const s = createSearch({ timeout: () => 1200 });
  // measure how late timers fire on this thread while the search runs
  let worst = 0, last = Date.now(), ticking = true;
  const tick = () => { const now = Date.now(); worst = Math.max(worst, now - last - 20); last = now; if (ticking) setTimeout(tick, 20); };
  setTimeout(tick, 20);
  const t0 = Date.now();
  const r = await s.run('w', dir, '(a+)+$', { regex: true });
  ticking = false;
  const took = Date.now() - t0;
  assert.strictEqual(r.code, 'timeout', JSON.stringify(r));
  assert(took >= 1100 && took < 4000, 'stopped at the time limit: ' + took);
  assert(worst < 300, 'this thread stayed responsive (worst timer delay ' + worst + ' ms)');
});
test('search: a newer search cancels the older one from the same window', async () => {
  const dir = searchFolder();
  const s = createSearch({ timeout: () => 5000 });
  const slow = s.run('win1', dir, '(a+)+$', { regex: true });
  await sleep(100);
  const other = s.run('win2', dir, 'hello', {}); // another window is not affected
  const fast = s.run('win1', dir, 'hello', {});
  const [a, b, c] = await Promise.all([slow, fast, other]);
  assert.strictEqual(a.canceled, true);
  assert.strictEqual(b.total, 2);
  assert.strictEqual(c.total, 2);
});

// ---------- recovery ----------
test('recovery: drafts of the same file with different text are all kept', () => {
  const ud = tmp('ud');
  const rec = makeRecovery({ getPath: () => ud });
  const file = path.join(ud, 'a.md');
  fs.writeFileSync(file, 'on disk');
  rec.write('w1-d1', { filePath: file, content: 'window one' });
  rec.write('w2-d1', { filePath: file, content: 'window two' });
  rec.write('w3-d1', { filePath: file, content: 'on disk' }); // nothing to recover
  const left = rec.leftovers();
  assert.deepStrictEqual(left.map((d) => d.content).sort(), ['window one', 'window two']);
  assert.strictEqual(fs.existsSync(path.join(ud, 'drafts', 'w1-d1.json')), true, 'listing does not delete');
  assert.strictEqual(rec.write('../evil', { content: 'x' }), false, 'ids cannot leave the drafts folder');
});

// ---------- the rename: MarkFlow's folder is copied to WhimFlow's ----------
const { adoptOldFolder } = require(path.join(root, 'src/main/migrate'));
test('rename: the old folder is copied once, caches skipped, the original kept', () => {
  const appData = tmp('appdata');
  const old = path.join(appData, 'MarkFlow');
  fs.mkdirSync(path.join(old, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(old, 'history', 'abc'), { recursive: true });
  fs.mkdirSync(path.join(old, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(old, 'settings.json'), '{"theme":"midnight"}');
  fs.writeFileSync(path.join(old, 'drafts', 'w-d1.json'), '{"content":"unsaved"}');
  fs.writeFileSync(path.join(old, 'history', 'abc', '1.md'), 'v1');
  fs.writeFileSync(path.join(old, 'Cache', 'blob'), 'x'.repeat(1000));
  const userData = path.join(appData, 'WhimFlow');
  assert.strictEqual(adoptOldFolder({ appData, name: 'WhimFlow', userData: path.join(appData, 'elsewhere') }), 'custom');
  assert(!fs.existsSync(userData), 'a folder given on the command line is left alone');
  fs.mkdirSync(path.join(userData, 'Crashpad'), { recursive: true }); // Electron makes the folder itself at start
  fs.writeFileSync(path.join(userData, 'Crashpad', 'settings.dat'), 'electron');
  assert.strictEqual(adoptOldFolder({ appData, name: 'WhimFlow', userData }), 'copied');
  assert.strictEqual(fs.readFileSync(path.join(userData, 'Crashpad', 'settings.dat'), 'utf8'), 'electron', 'nothing already there is overwritten');
  assert.strictEqual(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'), '{"theme":"midnight"}');
  assert.strictEqual(fs.readFileSync(path.join(userData, 'drafts', 'w-d1.json'), 'utf8'), '{"content":"unsaved"}');
  assert.strictEqual(fs.readFileSync(path.join(userData, 'history', 'abc', '1.md'), 'utf8'), 'v1');
  assert(!fs.existsSync(path.join(userData, 'Cache')), 'caches are not copied');
  assert(fs.existsSync(path.join(old, 'settings.json')) && fs.existsSync(path.join(old, 'Cache', 'blob')), 'the old folder is untouched');
  // later starts: copied once, never again (even if the new settings change)
  fs.writeFileSync(path.join(userData, 'settings.json'), '{"theme":"paper"}');
  assert.strictEqual(adoptOldFolder({ appData, name: 'WhimFlow', userData }), 'done');
  const fresh = path.join(tmp('fresh'), 'WhimFlow');
  fs.mkdirSync(path.join(fresh, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(fresh), 'MarkFlow'));
  assert.strictEqual(adoptOldFolder({ appData: path.dirname(fresh), name: 'WhimFlow', userData: fresh }), 'exists', 'a WhimFlow folder with its own data is never mixed with the old one');
  assert.strictEqual(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'), '{"theme":"paper"}');
  assert.strictEqual(adoptOldFolder({ appData: tmp('empty'), name: 'WhimFlow', userData: path.join(tmp('empty2'), 'x') }), 'custom');
});

// ---------- renderer path helpers (bundled the same way as the app) ----------
function loadPaths() {
  const out = esbuild.buildSync({ entryPoints: [path.join(root, 'src/renderer/js/paths.js')], bundle: true, format: 'cjs', write: false, platform: 'neutral' });
  const m = { exports: {} };
  new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports);
  return m.exports;
}
test('renderer paths: file URLs and folder boundaries', () => {
  const P = loadPaths();
  P.setPlatform('darwin');
  assert.strictEqual(P.fileUrl('/Users/me/My #1 ?/文档.md'), 'file:///Users/me/My%20%231%20%3F/%E6%96%87%E6%A1%A3.md');
  assert.strictEqual(P.fileUrl('/tmp/back\\slash'), 'file:///tmp/back%5Cslash', 'a backslash is part of a name on macOS/Linux');
  assert.strictEqual(fileURLToPath(P.fileUrl('/tmp/a b/#?%/x.png')), '/tmp/a b/#?%/x.png');
  assert.strictEqual(new URL('assets/x.png', P.fileUrl('/d/my #1') + '/').href, 'file:///d/my%20%231/assets/x.png', 'base URL keeps # inside the path');
  assert(P.isUnder('/w/notes/a.md', '/w/notes') && !P.isUnder('/w/notes-old/a.md', '/w/notes'));
  assert.strictEqual(P.remapPath('/w/notes/a.md', '/w/notes', '/w/j'), '/w/j/a.md');
  assert.strictEqual(P.remapPath('/w/notes-old/a.md', '/w/notes', '/w/j'), null);
  assert.strictEqual(P.dirname('/w/a.md'), '/w');
  assert.strictEqual(P.basename('/w/a\\b.md'), 'a\\b.md');
  P.setPlatform('win32');
  assert.strictEqual(P.fileUrl('C:\\Users\\me\\My #1\\图.md'), 'file:///C:/Users/me/My%20%231/%E5%9B%BE.md');
  assert.strictEqual(P.fileUrl('\\\\server\\share\\a b.md'), 'file://server/share/a%20b.md');
  assert.strictEqual(P.dirname('C:\\w\\a.md'), 'C:\\w');
  assert.strictEqual(P.dirname('C:\\a.md'), 'C:\\');
  assert.strictEqual(P.basename('C:\\w\\a.md'), 'a.md');
  assert(P.isUnder('C:\\w\\notes\\a.md', 'C:\\w\\notes') && !P.isUnder('C:\\w\\notes2\\a.md', 'C:\\w\\notes'));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('  ✓', name); }
    catch (err) { failed++; console.log('  ✗', name); console.log(err); }
  }
  if (failed) { console.error(`UNIT FAIL  ${failed} of ${tests.length}`); process.exit(1); }
  console.log(`UNIT OK  ${tests.length} tests`);
})();
