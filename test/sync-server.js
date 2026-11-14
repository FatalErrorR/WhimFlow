// The sync server (sync-server/server.js), run for real on a free port with a temporary library.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const assert = require('assert');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TOKEN = crypto.randomBytes(24).toString('hex');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-sync-'));
const step = (name) => console.log('  ✓', name);

(async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '../sync-server/server.js')], {
    env: { ...process.env, DATA: data, WHIMFLOW_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1', MAX_BODY: String(1024 * 1024) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(+m[1]); });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, route, { body, headers = {}, token = TOKEN } = {}) => {
    const r = await fetch(base + route, { method, body, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
    return { status: r.status, json, buf, version: r.headers.get('x-version') };
  };
  const q = (p) => '?path=' + encodeURIComponent(p);

  try {
    // ---- access ----
    assert.strictEqual((await call('GET', '/v1/ping', { token: null })).status, 401, 'no token');
    assert.strictEqual((await call('GET', '/v1/ping', { token: 'x'.repeat(48) })).status, 401, 'wrong token');
    assert.deepStrictEqual((await call('GET', '/v1/ping')).json, { ok: true, version: 1 });
    step('a token is required');

    // ---- the iPhone app's page may call it; other web pages may not ----
    const pre = (origin) => fetch(base + '/v1/file?path=a.md', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,if-match' } });
    let o = await pre('capacitor://localhost');
    assert.strictEqual(o.status, 204);
    assert.strictEqual(o.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    assert(/If-Match/.test(o.headers.get('access-control-allow-headers')) && /PUT/.test(o.headers.get('access-control-allow-methods')));
    o = await pre('https://evil.example');
    assert.strictEqual(o.headers.get('access-control-allow-origin'), null, 'another site gets no permission');
    const g = await fetch(base + '/v1/ping', { headers: { Origin: 'capacitor://localhost', Authorization: 'Bearer ' + TOKEN } });
    assert.deepStrictEqual([g.headers.get('access-control-allow-origin'), g.headers.get('access-control-expose-headers')], ['capacitor://localhost', 'X-Version']);
    step('the iPhone app may call it across origins; other sites may not');

    // ---- create, read, replace ----
    const a1 = '# 购物清单\n\n牛奶';
    let r = await call('PUT', '/v1/file' + q('笔记/购物清单.md'), { body: a1 });
    assert.strictEqual(r.status, 428, 'a write must say which version it expects');
    r = await call('PUT', '/v1/file' + q('笔记/购物清单.md'), { body: a1, headers: { 'If-None-Match': '*' } });
    assert.deepStrictEqual([r.status, r.json.v], [200, sha(a1)], 'created; the version is the SHA-256 of the bytes');
    assert.strictEqual(fs.readFileSync(path.join(data, '笔记/购物清单.md'), 'utf8'), a1, 'on disk, in its folder');
    r = await call('PUT', '/v1/file' + q('笔记/购物清单.md'), { body: 'other', headers: { 'If-None-Match': '*' } });
    assert.deepStrictEqual([r.status, r.json.current], [412, sha(a1)], 'create refused: it exists');
    r = await call('GET', '/v1/file' + q('笔记/购物清单.md'));
    assert.deepStrictEqual([r.status, r.buf.toString('utf8'), r.version], [200, a1, sha(a1)]);
    const a2 = a1 + '\n面包';
    r = await call('PUT', '/v1/file' + q('笔记/购物清单.md'), { body: a2, headers: { 'If-Match': sha(a1) } });
    assert.deepStrictEqual([r.status, r.json.v], [200, sha(a2)], 'replaced the version it named');
    r = await call('PUT', '/v1/file' + q('笔记/购物清单.md'), { body: a1 + '\n鸡蛋', headers: { 'If-Match': sha(a1) } });
    assert.deepStrictEqual([r.status, r.json.current], [412, sha(a2)], 'an older version is refused, and told the current one');
    r = await call('PUT', '/v1/file' + q('笔记/购物清单.md'), { body: a2, headers: { 'If-Match': sha(a1) } });
    assert.strictEqual(r.status, 200, 'the bytes it already has: fine (a retry)');
    step('create, read and replace by version; stale writes refused');

    // ---- two devices at once ----
    const both = await Promise.all(['手机', '电脑'].map((who) => call('PUT', '/v1/file' + q('笔记/购物清单.md'), { body: a2 + '\n' + who, headers: { 'If-Match': sha(a2) } })));
    assert.deepStrictEqual(both.map((x) => x.status).sort(), [200, 412], 'two writes from the same version: exactly one wins');
    step('two devices writing the same version at once: one is refused');

    // ---- binary, manifest ----
    const png = crypto.randomBytes(5000);
    r = await call('PUT', '/v1/file' + q('笔记/assets/图.png'), { body: png, headers: { 'If-None-Match': '*' } });
    assert.strictEqual(r.status, 200);
    assert(Buffer.compare((await call('GET', '/v1/file' + q('笔记/assets/图.png'))).buf, png) === 0, 'images come back byte for byte');
    assert.strictEqual((await call('PUT', '/v1/dir' + q('空的'))).status, 200);
    fs.writeFileSync(path.join(data, '.hidden.md'), 'x');
    const m = (await call('GET', '/v1/manifest')).json;
    assert.deepStrictEqual(Object.keys(m.files).sort(), ['笔记/assets/图.png', '笔记/购物清单.md'], 'files, nothing hidden');
    assert.deepStrictEqual(m.dirs.sort(), ['空的', '笔记', '笔记/assets'], 'folders, empty ones too');
    assert.strictEqual(m.files['笔记/assets/图.png'].v, sha(png));
    step('images byte for byte; the manifest lists files and folders, nothing hidden');

    // ---- paths ----
    for (const bad of ['../x.md', '/etc/passwd', 'a/../../x', '.Trash/x.md', 'a\\b.md', 'a//b.md', '']) {
      assert.strictEqual((await call('PUT', '/v1/file' + q(bad), { body: 'x', headers: { 'If-None-Match': '*' } })).status, 400, 'refused: ' + bad);
    }
    assert.strictEqual((await call('PUT', '/v1/file' + q('big.md'), { body: Buffer.alloc(2 * 1024 * 1024), headers: { 'If-None-Match': '*' } })).status, 413, 'too large');
    step('paths outside the library or hidden are refused; size limit');

    // ---- delete ----
    const cur = (await call('GET', '/v1/manifest')).json.files['笔记/购物清单.md'].v;
    r = await call('DELETE', '/v1/file' + q('笔记/购物清单.md'), { headers: { 'If-Match': sha('old') } });
    assert.strictEqual(r.status, 412, 'deleting a version that is not there anymore: refused');
    r = await call('DELETE', '/v1/file' + q('笔记/购物清单.md'), { headers: { 'If-Match': cur } });
    assert.strictEqual(r.status, 200);
    assert(!fs.existsSync(path.join(data, '笔记/购物清单.md')), 'gone from the library');
    const trashed = fs.readdirSync(path.join(data, '.trash'));
    assert(trashed.length === 1 && fs.existsSync(path.join(data, '.trash', trashed[0], '笔记/购物清单.md')), 'kept in .trash');
    assert.strictEqual((await call('DELETE', '/v1/file' + q('笔记/购物清单.md'), { headers: { 'If-Match': cur } })).status, 200, 'deleting again is fine');
    assert.strictEqual((await call('DELETE', '/v1/dir' + q('笔记'))).status, 409, 'a folder with files is not deleted');
    assert.strictEqual((await call('DELETE', '/v1/dir' + q('空的'))).status, 200, 'an empty one is');
    assert(!(await call('GET', '/v1/manifest')).json.dirs.includes('空的'));
    step('delete by version, into .trash; only empty folders');
    console.log('SYNC SERVER OK');
  } catch (err) {
    console.error('SYNC SERVER FAIL', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
