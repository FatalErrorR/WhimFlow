// The desktop's sync adapter (src/main/sync-local.js) on real folders, against a real sync
// server: two "Macs" with a library folder each. No Electron, no windows.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const assert = require('assert');
const { createSync, createRemote } = require('../src/shared/sync.js');
const { createLocal, createState } = require('../src/main/sync-local.js');
const fileops = require('../src/main/fileops.js');
const { createDesktopSync, normalizeUrl } = require('../src/main/sync-desktop.js');

const TOKEN = crypto.randomBytes(24).toString('hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const step = (name) => console.log('  ✓', name);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-sync-desktop-'));

(async () => {
  const data = path.join(work, 'server');
  const proc = spawn(process.execPath, [path.join(__dirname, '../sync-server/server.js')], {
    env: { ...process.env, DATA: data, WHIMFLOW_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve) => proc.stdout.on('data', (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(+m[1]); }));
  const remote = () => createRemote({ url: `http://127.0.0.1:${port}`, token: TOKEN });

  function mac(name) {
    const root = path.join(work, name, 'Documents'), trash = path.join(work, name, 'Trash');
    fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(trash, { recursive: true });
    const hooks = {};
    const queue = fileops.keyedQueue();
    // the app's own saves share this queue; a test can slip one in just before a sync write
    const q = (key, task) => queue(key, async () => { if (hooks.before) { const h = hooks.before; hooks.before = null; await h(key); } return task(); });
    const local = createLocal({ root, queue: q, trashItem: async (p) => fs.renameSync(p, path.join(trash, path.basename(p))) });
    const engine = createSync({ local, remote: remote(), state: createState(path.join(work, name, 'sync-state.json')), device: name, hash: async (b) => sha(b), now: () => new Date(2026, 10, 14, 21, 0) });
    const f = (rel) => path.join(root, ...rel.split('/'));
    return {
      root, trash, hooks, sync: () => engine.sync(), f,
      write: (rel, s) => { fs.mkdirSync(path.dirname(f(rel)), { recursive: true }); fs.writeFileSync(f(rel), s); },
      read: (rel) => (fs.existsSync(f(rel)) ? fs.readFileSync(f(rel), 'utf8') : undefined),
    };
  }

  try {
    const a = mac('MacA'), b = mac('MacB');
    a.write('购物清单.md', '# 购物清单'); a.write('工作/周报.md', '# 周报'); a.write('工作/assets/图.png', crypto.randomBytes(3000));
    fs.mkdirSync(a.f('空文件夹')); a.write('.DS_Store', 'finder'); a.write('工作/.周报.md.abc.mftmp', 'tmp');
    await a.sync(); await b.sync();
    assert.strictEqual(b.read('工作/周报.md'), '# 周报');
    assert(Buffer.compare(fs.readFileSync(b.f('工作/assets/图.png')), fs.readFileSync(a.f('工作/assets/图.png'))) === 0, 'images');
    assert(fs.statSync(b.f('空文件夹')).isDirectory(), 'empty folders');
    assert(!fs.existsSync(path.join(data, '.DS_Store')) && !fs.existsSync(path.join(data, '工作/.周报.md.abc.mftmp')), 'Finder and temporary files stay home');
    step('a library folder reaches another Mac: nested folders, images, empty folders; hidden files stay');

    // the app saves the file right as sync is about to replace it
    b.write('购物清单.md', '# 购物清单\n\nB 改的'); await b.sync();
    a.hooks.before = async (key) => { if (key === a.f('购物清单.md')) a.write('购物清单.md', '# 购物清单\n\nA 刚保存的'); };
    const r = await a.sync();
    assert.deepStrictEqual(r.skipped, ['购物清单.md'], 'the sync write is refused');
    assert.strictEqual(a.read('购物清单.md'), '# 购物清单\n\nA 刚保存的', 'what the app saved is on disk');
    await a.sync();
    assert.strictEqual(a.read('购物清单.md (冲突 MacA 2026-11-14 21.00).md'.replace('.md (', ' (')), '# 购物清单\n\nA 刚保存的', 'next pass: kept as a conflict copy');
    assert.strictEqual(a.read('购物清单.md'), '# 购物清单\n\nB 改的');
    step('a save made while syncing is never overwritten; it becomes a conflict copy');

    // deletes go to the system Trash; a folder with only .DS_Store left can go
    fs.rmSync(b.f('工作'), { recursive: true }); await b.sync();
    a.write('工作/.DS_Store', 'finder');
    await a.sync();
    assert(!fs.existsSync(a.f('工作')), 'the folder is gone (hidden leftovers did not keep it)');
    assert.deepStrictEqual(fs.readdirSync(a.trash).sort(), ['周报.md', '图.png', '工作'], 'its files are in the Trash, and the folder with its leftovers');
    assert.deepStrictEqual(fs.readdirSync(path.join(a.trash, '工作')).sort(), ['.DS_Store', '.周报.md.abc.mftmp'], 'nothing erased');
    step('deletes go to the Trash; a folder holding only hidden leftovers goes there too');

    // the state survives a restart (a new engine on the same files)
    const again = mac('MacA');
    const idle = await again.sync();
    assert.deepStrictEqual([idle.up, idle.down, idle.conflicts, idle.removedHere, idle.removedThere], [[], [], [], [], []], 'nothing to redo after a restart: ' + JSON.stringify(idle));
    step('after a restart nothing is redone (the base is on disk)');

    // ---- the desktop's controller: connect, sync after a change, disconnect ----
    assert.deepStrictEqual(['whimflow.example.com', 'https://a.b/', 'http://a.b', 'http://127.0.0.1:9', 'nonsense url'].map(normalizeUrl),
      ['https://whimflow.example.com', 'https://a.b', null, 'http://127.0.0.1:9', null], 'addresses: https added, plain http only for this computer');
    const userData = path.join(work, 'MacC');
    const fakeKeychain = { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from([...Buffer.from(x)].map((c) => c ^ 0x5a)), decryptString: (b) => Buffer.from([...b].map((c) => c ^ 0x5a)).toString() };
    let url = '', seen = [];
    const desk = createDesktopSync({
      userData, safeStorage: fakeKeychain, queue: fileops.keyedQueue(), fetch: globalThis.fetch, trashItem: async () => {},
      getUrl: () => url, setUrl: (u) => { url = u; }, notify: (st) => seen.push(st.state), device: 'MacC',
    });
    desk.start();
    assert.deepStrictEqual(seen, ['off'], 'not connected at first');
    assert.strictEqual(desk.library, path.join(userData, 'Documents'));
    assert(fs.statSync(desk.library).isDirectory(), 'the library folder is made');
    const base = `http://127.0.0.1:${port}`;
    assert.strictEqual((await desk.connect({ url: base, token: 'x'.repeat(48) })).error, 'auth');
    assert.strictEqual((await desk.connect({ url: 'http://example.com', token: TOKEN })).error, 'url');
    assert.strictEqual((await desk.connect({ url: 'http://127.0.0.1:1', token: TOKEN })).error, 'offline');
    assert.strictEqual(url, '', 'nothing kept after a failed connect');
    assert.deepStrictEqual(await desk.connect({ url: base + '/', token: TOKEN }), { ok: true, url: base, account: null });
    assert(!fs.readFileSync(path.join(userData, 'sync-token')).includes(TOKEN), 'the token is not stored in the clear');
    for (let i = 0; i < 50 && desk.status().state !== 'ok'; i++) await new Promise((r) => setTimeout(r, 100));
    assert(fs.existsSync(path.join(desk.library, '购物清单.md')), 'connected: the library fills from the server');
    assert.deepStrictEqual(seen.slice(-2), ['syncing', 'ok']);
    fs.writeFileSync(path.join(desk.library, '新的.md'), '# 新的');
    desk.changed();
    for (let i = 0; i < 60 && !fs.existsSync(path.join(data, '新的.md')); i++) await new Promise((r) => setTimeout(r, 100));
    assert(fs.existsSync(path.join(data, '新的.md')), 'a change goes up a moment later');
    step('the desktop controller (a server without accounts): checks the server first, keeps the token encrypted, syncs after a change');

    // ---- accounts: this Mac makes the administrator's account; another device signs in by name ----
    assert.strictEqual((await desk.connect({ url: base, name: 'chris', password: 'secret-pass' })).error, 'setup', 'no accounts on the server yet');
    assert.strictEqual(url, base, 'a refused sign-in keeps the current connection');
    let ra = await desk.setup({ name: 'chris', password: 'secret-pass' });
    assert(ra.ok && ra.account.admin, 'the administrator: ' + JSON.stringify(ra));
    const userRoot = path.join(data, '.users', fs.readdirSync(path.join(data, '.users'))[0]);
    assert(fs.existsSync(path.join(userRoot, '新的.md')), 'the library is now the account\'s');
    fs.writeFileSync(path.join(desk.library, '账号之后.md'), '# 账号之后');
    desk.changed();
    for (let i = 0; i < 60 && !fs.existsSync(path.join(userRoot, '账号之后.md')); i++) await new Promise((r2) => setTimeout(r2, 100));
    assert(fs.existsSync(path.join(userRoot, '账号之后.md')), 'it syncs on, signed in');
    const userData2 = path.join(work, 'MacD');
    let url2 = '';
    const desk2 = createDesktopSync({
      userData: userData2, safeStorage: fakeKeychain, queue: fileops.keyedQueue(), fetch: globalThis.fetch, trashItem: async () => {},
      getUrl: () => url2, setUrl: (u) => { url2 = u; }, notify: () => {}, device: 'MacD',
    });
    desk2.start();
    assert.strictEqual((await desk2.connect({ url: base, name: 'chris', password: 'wrong-pass' })).error, 'wrong');
    assert.strictEqual((await desk2.connect({ url: base, name: 'chris' })).error, 'name', 'a name and a password are needed');
    ra = await desk2.connect({ url: base, name: 'Chris', password: 'secret-pass' });
    assert(ra.ok && ra.account.name === 'chris', 'signed in by name');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(desk2.library, '账号之后.md')); i++) await new Promise((r2) => setTimeout(r2, 100));
    assert(fs.existsSync(path.join(desk2.library, '账号之后.md')) && fs.existsSync(path.join(desk2.library, '购物清单.md')), 'the account\'s library comes down');
    assert(!fs.readFileSync(path.join(userData2, 'sync-token')).toString().includes('secret-pass'), 'the password is not kept');
    let me = await desk.account('me');
    assert.deepStrictEqual(me.result.devices.map((d) => d.device).sort(), ['MacC', 'MacD'], 'both devices are listed');
    assert.strictEqual((await desk.account('nope')).error, 'method', 'only the account calls');
    await desk2.disconnect();
    me = await desk.account('me');
    assert.deepStrictEqual(me.result.devices.map((d) => d.device), ['MacC'], 'signing out ends that device\'s sign-in on the server');
    desk2.stop();
    step('accounts: the first one made from this Mac keeps the library; another device signs in by name and password; signing out ends it');

    await desk.disconnect();
    assert.deepStrictEqual([url, desk.status().state, fs.existsSync(path.join(userData, 'sync-token')), fs.existsSync(path.join(userData, 'sync-state.json'))], ['', 'off', false, false]);
    assert(fs.existsSync(path.join(desk.library, '新的.md')) && fs.existsSync(path.join(userRoot, '新的.md')), 'disconnecting keeps the files on both sides');
    desk.stop();
    step('signing out: the files stay on both sides');
    console.log('SYNC DESKTOP OK');
  } catch (err) {
    console.error('SYNC DESKTOP FAIL', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
