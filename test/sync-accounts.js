// Accounts on the sync server (sync-server/server.js): the first one taken over from the shared
// token with its library, signing in, quotas, devices, passwords, the administrator, the trash.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const assert = require('assert');

const TOKEN = crypto.randomBytes(24).toString('hex');
const step = (name) => console.log('  ✓', name);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function start(data, env = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, '../sync-server/server.js')], {
    env: { ...process.env, DATA: data, WHIMFLOW_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1', DEFAULT_QUOTA: String(10000), ...env }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve({ proc, base: `http://127.0.0.1:${m[1]}` }); });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}
const stop = (s) => new Promise((r) => { s.proc.once('exit', r); s.proc.kill(); });

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-accounts-'));
  let srv = await start(data);
  const call = async (method, route, { token, json, body, headers = {} } = {}) => {
    const r = await fetch(srv.base + route, { method, body: json ? JSON.stringify(json) : body, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers } });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: r.status, json: j };
  };
  const put = (token, p, content, headers = { 'If-None-Match': '*' }) => call('PUT', '/v1/file?path=' + encodeURIComponent(p), { token, body: content, headers });
  try {
    // ---- before any account: the shared token, one library ----
    assert.strictEqual((await put(TOKEN, '笔记/旧的.md', '# 旧的')).status, 200);
    assert.strictEqual((await call('POST', '/v1/login', { json: { name: 'chris', password: 'x'.repeat(8) } })).json.error, 'setup', 'no accounts yet: set up first');
    assert.strictEqual((await call('GET', '/v1/me', { token: TOKEN })).json.error, 'setup');
    assert.strictEqual((await call('POST', '/v1/setup', { token: 'y'.repeat(48), json: { name: 'chris', password: 'secret-pass' } })).status, 401, 'setup needs the shared token');
    assert.strictEqual((await call('POST', '/v1/setup', { token: TOKEN, json: { name: 'chris', password: 'short' } })).status, 400, 'a password of 8 characters or more');

    // ---- the first account: the administrator, with the library ----
    let r = await call('POST', '/v1/setup', { token: TOKEN, json: { name: 'Chris', password: 'secret-pass', device: 'Mac' } });
    assert.strictEqual(r.status, 200);
    const chris = r.json.token;
    assert.deepStrictEqual([r.json.account.name, r.json.account.admin, r.json.account.quota, r.json.account.devices.length], ['Chris', true, 10000, 1]);
    assert.strictEqual((await call('GET', '/v1/manifest', { token: chris })).json.files['笔记/旧的.md'].v, sha('# 旧的'), 'the library moved into the account');
    assert(!fs.existsSync(path.join(data, '笔记')), 'and is no longer shared');
    assert.strictEqual((await call('GET', '/v1/manifest', { token: TOKEN })).status, 401, 'the shared token no longer works');
    assert.strictEqual((await call('POST', '/v1/setup', { token: chris, json: { name: 'x2', password: 'secret-pass' } })).status, 409, 'only once');
    const stored = fs.readFileSync(path.join(data, '.accounts.json'), 'utf8') + fs.readFileSync(path.join(data, '.sessions.json'), 'utf8');
    assert(!stored.includes('secret-pass') && !stored.includes(chris), 'neither the password nor the sign-in is stored as such');
    step('the first account takes over the shared library; the shared token stops working');

    // ---- signing in ----
    r = await call('POST', '/v1/login', { json: { name: 'chris', password: 'secret-pass', device: 'iPhone' } });
    assert.strictEqual(r.status, 200, 'names ignore case');
    const phone = r.json.token;
    assert.strictEqual((await call('GET', '/v1/me', { token: phone })).json.devices.length, 2, 'two devices');
    assert.strictEqual((await call('POST', '/v1/login', { json: { name: 'chris', password: 'nope-nope' } })).json.error, 'wrong');
    step('signing in by name and password');

    // ---- the administrator: accounts, each with its own library and space ----
    assert.strictEqual((await call('POST', '/v1/users', { token: chris, json: { name: 'ann', password: 'ann-password', quota: 50 } })).status, 200);
    assert.strictEqual((await call('POST', '/v1/users', { token: chris, json: { name: 'ANN', password: 'ann-password' } })).status, 409, 'names are unique');
    assert.strictEqual((await call('POST', '/v1/users', { token: chris, json: { name: 'a/b', password: 'ann-password' } })).status, 400, 'a name is letters, digits, _ . -');
    const ann = (await call('POST', '/v1/login', { json: { name: 'ann', password: 'ann-password', device: 'Ann Mac' } })).json.token;
    assert.deepStrictEqual((await call('GET', '/v1/manifest', { token: ann })).json, { files: {}, dirs: [] }, 'her own, empty library');
    assert.strictEqual((await call('GET', '/v1/file?path=' + encodeURIComponent('笔记/旧的.md'), { token: ann })).status, 404, 'she cannot read his');
    assert.strictEqual((await call('GET', '/v1/users', { token: ann })).status, 403, 'only the administrator manages accounts');
    assert.strictEqual((await put(ann, 'a.md', 'x'.repeat(40))).status, 200);
    r = await put(ann, 'b.md', 'x'.repeat(20));
    assert.deepStrictEqual([r.status, r.json.error, r.json.used, r.json.quota], [507, 'quota', 40, 50], 'past her space: refused, with what is used');
    assert.strictEqual((await put(ann, 'a.md', 'y'.repeat(45), { 'If-Match': sha('x'.repeat(40)) })).status, 200, 'replacing a file counts only the difference');
    assert.strictEqual((await call('DELETE', '/v1/file?path=a.md', { token: ann, headers: { 'If-Match': sha('y'.repeat(45)) } })).status, 200);
    assert.strictEqual((await put(ann, 'b.md', 'x'.repeat(20))).status, 200, 'the trash does not count');
    assert.strictEqual((await call('PATCH', '/v1/users?name=ann', { token: chris, json: { quota: 1000 } })).status, 200);
    assert.strictEqual((await call('GET', '/v1/me', { token: ann })).json.quota, 1000, 'more space');
    const list = (await call('GET', '/v1/users', { token: chris })).json.users;
    assert.deepStrictEqual(list.map((u) => [u.name, u.admin, u.used]), [['Chris', true, Buffer.byteLength('# 旧的')], ['ann', false, 20]], 'the list shows each account and its space');
    step('the administrator makes accounts; each has its own library and space, refused past it; the trash does not count');

    // five wrong passwords lock that name for a while, even for the right password; other names are not affected
    assert.strictEqual((await call('POST', '/v1/users', { token: chris, json: { name: 'bob', password: 'bob-password' } })).status, 200);
    for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/v1/login', { json: { name: 'Bob', password: 'nope-nope' } })).status, 401);
    r = await call('POST', '/v1/login', { json: { name: 'bob', password: 'bob-password' } });
    assert(r.status === 429 && r.json.retryAfter > 0, 'locked, even with the right password');
    assert.strictEqual((await call('POST', '/v1/login', { json: { name: 'ann', password: 'ann-password' } })).status, 200, 'other names are not');
    step('five wrong passwords lock that name for 15 minutes');

    // ---- devices and passwords ----
    const me = (await call('GET', '/v1/me', { token: chris })).json;
    const other = me.devices.find((d) => !d.current);
    assert.strictEqual((await call('DELETE', '/v1/devices?id=' + other.id, { token: chris })).status, 200);
    assert.strictEqual((await call('GET', '/v1/manifest', { token: phone })).status, 401, 'a device signed out from another');
    assert.strictEqual((await call('POST', '/v1/password', { token: chris, json: { old: 'wrong-pass', new: 'new-secret' } })).status, 401);
    const phone2 = (await call('POST', '/v1/login', { json: { name: 'chris', password: 'secret-pass', device: 'iPhone' } })).json.token;
    assert(phone2, 'signed in again');
    assert.strictEqual((await call('POST', '/v1/password', { token: chris, json: { old: 'secret-pass', new: 'new-secret' } })).status, 200);
    assert.strictEqual((await call('GET', '/v1/manifest', { token: phone2 })).status, 401, 'a new password signs the other devices out');
    assert.strictEqual((await call('GET', '/v1/manifest', { token: chris })).status, 200, 'not this one');
    assert.strictEqual((await call('PATCH', '/v1/users?name=ann', { token: chris, json: { disabled: true } })).status, 200);
    assert.strictEqual((await call('GET', '/v1/manifest', { token: ann })).status, 401, 'a disabled account is signed out');
    assert.strictEqual((await call('POST', '/v1/login', { json: { name: 'ann', password: 'ann-password' } })).json.error, 'disabled');
    assert.strictEqual((await call('PATCH', '/v1/users?name=Chris', { token: chris, json: { disabled: true } })).status, 400, 'not one\'s own');
    await call('PATCH', '/v1/users?name=ann', { token: chris, json: { disabled: false, password: 'reset-by-admin' } });
    assert.strictEqual((await call('POST', '/v1/login', { json: { name: 'ann', password: 'reset-by-admin' } })).status, 200, 'the administrator resets a password');
    assert.strictEqual((await call('POST', '/v1/logout', { token: chris })).status, 200);
    assert.strictEqual((await call('GET', '/v1/me', { token: chris })).status, 401, 'signed out');
    step('devices sign out one by one; a new password, or disabling, signs out the rest');

    // ---- across a restart; old trash is erased ----
    const c2 = (await call('POST', '/v1/login', { json: { name: 'chris', password: 'new-secret' } })).json.token;
    assert(c2, 'signs in with the new password');
    await stop(srv);
    const userDir = fs.readdirSync(path.join(data, '.users')).find((d) => fs.existsSync(path.join(data, '.users', d, '笔记')));
    const oldTrash = path.join(data, '.users', userDir, '.trash', '20200101T000000-abc');
    fs.mkdirSync(oldTrash, { recursive: true });
    fs.writeFileSync(path.join(oldTrash, 'x.md'), 'x');
    const past = new Date('2020-01-02'); fs.utimesSync(oldTrash, past, past);
    srv = await start(data);
    assert.strictEqual((await call('GET', '/v1/manifest', { token: c2 })).status, 200, 'sign-ins survive a restart');
    await new Promise((r) => setTimeout(r, 300));
    assert(!fs.existsSync(oldTrash), 'what was in the trash for 30 days is erased');
    step('sign-ins survive a restart; the trash is emptied after 30 days');
    console.log('SYNC ACCOUNTS OK');
  } catch (err) {
    console.error('SYNC ACCOUNTS FAIL', err);
    process.exitCode = 1;
  } finally {
    await stop(srv).catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
