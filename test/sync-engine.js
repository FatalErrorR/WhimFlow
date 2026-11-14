// The shared sync engine (src/shared/sync.js) between two devices and a real sync server
// (sync-server/server.js on a free port). The devices keep their libraries in memory, so
// every rule can be checked exactly: what travels, what is kept, what is never lost.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const assert = require('assert');
const { createSync, createRemote, conflictName, syncable } = require('../src/shared/sync.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TOKEN = crypto.randomBytes(24).toString('hex');
const step = (name) => console.log('  ✓', name);

async function startServer() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-sync-engine-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '../sync-server/server.js')], {
    env: { ...process.env, DATA: data, WHIMFLOW_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(+m[1]); });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return { url: `http://127.0.0.1:${port}`, data, stop() { proc.kill(); fs.rmSync(data, { recursive: true, force: true }); } };
}

/** A device whose library is a Map in memory, with the same promises a real one makes. */
function device(name, server, { token = TOKEN } = {}) {
  const files = new Map(), dirs = new Set(), trash = [];
  const hooks = {};
  const addParents = (p) => { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); };
  const local = {
    async list() {
      const out = {};
      for (const [p, b] of files) if (syncable(p)) out[p] = { v: sha(b) };
      return { files: out, dirs: [...dirs].filter(syncable) };
    },
    async read(p) { return files.get(p); },
    async write(p, bytes, expected) {
      if (hooks.beforeWrite) await hooks.beforeWrite(p);
      const cur = files.has(p) ? sha(files.get(p)) : null;
      if (cur !== expected) return false;
      files.set(p, Buffer.from(bytes)); addParents(p);
      return true;
    },
    async trash(p, expected) {
      if (!files.has(p) || sha(files.get(p)) !== expected) return false;
      trash.push(p); files.delete(p);
      return true;
    },
    async mkdir(p) { dirs.add(p); addParents(p); },
    async rmdir(p) {
      if ([...files.keys(), ...dirs].some((x) => x.startsWith(p + '/'))) return false;
      dirs.delete(p);
      return true;
    },
  };
  let saved = null;
  const state = { load: async () => saved && JSON.parse(saved), save: async (s) => { saved = JSON.stringify(s); } };
  const engine = createSync({ local, remote: createRemote({ url: server.url, token }), state, device: name, hash: async (b) => sha(b), now: () => new Date(2026, 10, 14, 20, 5) });
  const text = (p) => (files.has(p) ? files.get(p).toString('utf8') : undefined);
  const put = (p, s) => { files.set(p, Buffer.from(s)); addParents(p); };
  return { name, files, dirs, trash, hooks, sync: () => engine.sync(), engine, text, put };
}
const names = (d) => [...d.files.keys()].sort();
const serverHas = (srv, p) => fs.existsSync(path.join(srv.data, ...p.split('/')));
const serverText = (srv, p) => fs.readFileSync(path.join(srv.data, ...p.split('/')), 'utf8');

async function scenario(title, fn) {
  const srv = await startServer();
  try { await fn(srv); step(title); } finally { srv.stop(); }
}

(async () => {
  try {
    await scenario('first sync: each library reaches the other, nothing is deleted', async (srv) => {
      const mac = device('Mac', srv), phone = device('iPhone', srv);
      mac.put('购物清单.md', '# 购物清单\n\n牛奶'); mac.put('笔记/想法.md', '# 想法'); mac.dirs.add('空的');
      phone.put('手机上写的.md', '# 手机');
      await mac.sync(); await phone.sync(); await mac.sync();
      const all = ['手机上写的.md', '笔记/想法.md', '购物清单.md'];
      assert.deepStrictEqual(names(mac), all); assert.deepStrictEqual(names(phone), all);
      assert(phone.dirs.has('空的') && serverHas(srv, '空的'), 'empty folders too');
      assert.strictEqual(phone.text('购物清单.md'), '# 购物清单\n\n牛奶');
    });

    await scenario('edits travel; images byte for byte; a pass with nothing new changes nothing', async (srv) => {
      const mac = device('Mac', srv), phone = device('iPhone', srv);
      mac.put('a.md', 'v1'); await mac.sync(); await phone.sync();
      mac.put('a.md', 'v2'); await mac.sync(); await phone.sync();
      assert.strictEqual(phone.text('a.md'), 'v2');
      const png = crypto.randomBytes(20000);
      phone.files.set('assets/图.png', png); await phone.sync(); await mac.sync();
      assert(Buffer.compare(mac.files.get('assets/图.png'), png) === 0, 'the image arrives unchanged');
      const idle = await mac.sync();
      assert.deepStrictEqual([idle.up, idle.down, idle.removedHere, idle.removedThere, idle.conflicts, idle.errors], [[], [], [], [], [], []], 'nothing to do: ' + JSON.stringify(idle));
    });

    await scenario('deletes travel, into the trash on both sides; so do removed folders', async (srv) => {
      const mac = device('Mac', srv), phone = device('iPhone', srv);
      mac.put('笔记/旧的.md', 'old'); mac.put('笔记/留着.md', 'keep'); mac.dirs.add('临时');
      await mac.sync(); await phone.sync();
      phone.files.delete('笔记/旧的.md'); phone.dirs.delete('临时');
      const r = await phone.sync();
      assert.deepStrictEqual(r.removedThere.sort(), ['临时/', '笔记/旧的.md']);
      assert(!serverHas(srv, '笔记/旧的.md') && fs.readdirSync(path.join(srv.data, '.trash')).length === 1, 'on the server: in .trash');
      await mac.sync();
      assert.deepStrictEqual(mac.trash, ['笔记/旧的.md'], 'on the other device: to its trash');
      assert(!mac.dirs.has('临时') && mac.text('笔记/留着.md') === 'keep');
    });

    await scenario('both edit the same file: both texts are kept, on both devices', async (srv) => {
      const mac = device('Mac', srv), phone = device('iPhone', srv);
      mac.put('计划.md', '原来的'); await mac.sync(); await phone.sync();
      mac.put('计划.md', 'Mac 改的'); phone.put('计划.md', 'iPhone 改的');
      await mac.sync();
      const r = await phone.sync();
      const copy = '计划 (冲突 iPhone 2026-11-14 20.05).md';
      assert.deepStrictEqual(r.conflicts, [{ path: '计划.md', copy }]);
      assert.deepStrictEqual([phone.text('计划.md'), phone.text(copy)], ['Mac 改的', 'iPhone 改的'], 'the server\'s text keeps the name; this device\'s is the copy');
      await mac.sync();
      assert.deepStrictEqual([mac.text('计划.md'), mac.text(copy)], ['Mac 改的', 'iPhone 改的'], 'and the other device gets the copy');
      assert.strictEqual(serverText(srv, copy), 'iPhone 改的');
    });

    await scenario('an edit beats a delete, whichever syncs first', async (srv) => {
      const mac = device('Mac', srv), phone = device('iPhone', srv);
      mac.put('a.md', 'old'); mac.put('b.md', 'old'); await mac.sync(); await phone.sync();
      // a.md: deleted on the Mac first, edited on the phone after
      mac.files.delete('a.md'); await mac.sync();
      phone.put('a.md', 'edited'); await phone.sync(); await mac.sync();
      assert.deepStrictEqual([mac.text('a.md'), phone.text('a.md')], ['edited', 'edited'], 'deleted, then edited elsewhere: it comes back');
      // b.md: edited on the phone first, deleted on the Mac after
      phone.put('b.md', 'edited'); await phone.sync();
      mac.files.delete('b.md'); await mac.sync();
      assert.deepStrictEqual([mac.text('b.md'), serverText(srv, 'b.md')], ['edited', 'edited'], 'edited, then deleted elsewhere: the edit stays');
    });

    await scenario('first sync where both have the same name with different text: both kept', async (srv) => {
      const mac = device('Mac', srv), phone = device('iPhone', srv);
      mac.put('日记.md', 'Mac 的'); phone.put('日记.md', 'iPhone 的');
      await mac.sync(); await phone.sync(); await mac.sync();
      const copy = '日记 (冲突 iPhone 2026-11-14 20.05).md';
      for (const d of [mac, phone]) assert.deepStrictEqual([d.text('日记.md'), d.text(copy)], ['Mac 的', 'iPhone 的'], d.name);
    });

    await scenario('an edit made while syncing is never overwritten', async (srv) => {
      const mac = device('Mac', srv), phone = device('iPhone', srv);
      mac.put('草稿.md', 'v1'); await mac.sync(); await phone.sync();
      phone.put('草稿.md', 'iPhone v2'); await phone.sync();
      // the Mac's user types into the file just as the server's version is about to be written
      mac.hooks.beforeWrite = async (p) => { if (p === '草稿.md') { mac.put(p, 'Mac 正在写'); mac.hooks.beforeWrite = null; } };
      const r = await mac.sync();
      assert.deepStrictEqual(r.skipped, ['草稿.md']);
      assert.strictEqual(mac.text('草稿.md'), 'Mac 正在写', 'what was typed is still there');
      await mac.sync();
      const copy = '草稿 (冲突 Mac 2026-11-14 20.05).md';
      assert.deepStrictEqual([mac.text('草稿.md'), mac.text(copy)], ['iPhone v2', 'Mac 正在写'], 'next pass: both texts kept');
    });

    await scenario('a library that is suddenly empty does not empty the server', async (srv) => {
      const mac = device('Mac', srv);
      mac.put('a.md', '1'); mac.put('b.md', '2'); await mac.sync();
      mac.files.clear(); // the library folder was moved away, or the app reinstalled
      const r = await mac.sync();
      assert(r.reset && !r.removedThere.length, 'no deletes sent');
      assert(serverHas(srv, 'a.md') && serverHas(srv, 'b.md'));
      assert.deepStrictEqual(names(mac), ['a.md', 'b.md'], 'the files come back');
    });

    await scenario('hidden and temporary files stay on the device', async (srv) => {
      const mac = device('Mac', srv);
      mac.put('.DS_Store', 'x'); mac.put('a.md.mftmp', 'x'); mac.put('.Trash/old.md', 'x'); mac.put('a.md', 'a');
      await mac.sync();
      assert.deepStrictEqual(fs.readdirSync(srv.data).filter((n) => !n.startsWith('.')), ['a.md']);
    });

    await scenario('a wrong token stops the sync with an auth error, and a second request joins a running pass', async (srv) => {
      const bad = device('Mac', srv, { token: 'x'.repeat(48) });
      bad.put('a.md', 'a');
      await assert.rejects(bad.sync(), (err) => err.code === 'auth');
      const mac = device('Mac', srv);
      mac.put('a.md', 'a');
      const [one, two] = [mac.sync(), mac.sync()];
      assert.strictEqual(one, two, 'the same pass');
      await one;
      assert(serverHas(srv, 'a.md'));
    });

    assert.strictEqual(conflictName('a/b.md', 'i/Phone', new Date(2026, 0, 2, 3, 4), (c) => c === 'a/b (冲突 iPhone 2026-01-02 03.04).md'), 'a/b (冲突 iPhone 2026-01-02 03.04 2).md');
    step('conflict copies get a free name');
    console.log('SYNC ENGINE OK');
  } catch (err) {
    console.error('SYNC ENGINE FAIL', err);
    process.exitCode = 1;
  }
})();
