// The desktop app with sync, end to end: a real window (its own temporary user data, so its own
// library) and a real sync server on this computer. Connect in Settings, drag files into the
// library, see them reach the server; a file another device puts on the server shows up here.
const { _electron } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const assert = require('assert');
const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');
const step = (name) => console.log('  ✓', name);
const TOKEN = crypto.randomBytes(24).toString('hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-sync-app-')));
  const data = path.join(work, 'server');
  const server = spawn(process.execPath, [path.join(root, 'sync-server/server.js')], {
    env: { ...process.env, DATA: data, WHIMFLOW_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve) => server.stdout.on('data', (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(+m[1]); }));
  const url = `http://127.0.0.1:${port}`;
  const app = await _electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: ['--no-sandbox', root, '--user-data-dir=' + path.join(work, 'ud')],
    env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh' },
  });
  const errors = [];
  const until = async (fn, what, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out waiting for: ' + what); };
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
    await page.waitForSelector('body.ready');
    const library = await page.evaluate(() => window.__whimflow.ctx.env.library);
    assert.strictEqual(library, path.join(work, 'ud', 'Documents'));
    assert.strictEqual(await page.evaluate(() => window.__whimflow.state.folder), library, 'a blank window shows the library');
    await page.evaluate(() => window.__whimflow.run('files'));
    assert.strictEqual(await page.locator('#tree-card .card-meta').innerText(), '我的文件库');
    step('a new window shows "我的文件库"');

    // ---- connect in Settings ----
    await page.evaluate(() => window.__whimflow.run('settings'));
    await page.waitForSelector('#settings:not([hidden]) input[type="password"]');
    await page.locator('#settings input[type="text"]').first().fill('http://example.com');
    await page.locator('#settings input[type="password"]').fill(TOKEN);
    await page.locator('#settings .set-btn.primary').click();
    await until(async () => /https/.test(await page.locator('#settings .sync-msg').innerText()), 'the address is refused');
    await page.locator('#settings input[type="text"]').first().fill(url);
    await page.locator('#settings input[type="password"]').fill('x'.repeat(48));
    await page.locator('#settings .set-btn.primary').click();
    await until(async () => /不接受/.test(await page.locator('#settings .sync-msg').innerText()), 'the token is refused');
    await page.locator('#settings input[type="password"]').fill(TOKEN);
    await page.locator('#settings .set-btn.primary').click();
    await page.waitForSelector('#settings .sync-state');
    await until(async () => /已同步/.test(await page.locator('#settings .sync-state').innerText()), 'synced');
    await page.screenshot({ path: path.join(shots, 'sync-settings.png') });
    await page.locator('#settings .set-close').click();
    assert(await page.evaluate(() => document.querySelector('#settings').hidden), 'settings closed');
    await until(async () => /我的文件库 · 已同步/.test(await page.locator('#tree-card .card-meta').innerText()), 'the sidebar says so');
    step('Settings > Sync: a wrong address or token is refused, the right one connects; the sidebar shows "已同步"');

    // ---- files dragged in from Finder are copied into the library and go up ----
    const src = path.join(work, 'desk');
    fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(src, '旅行.md'), '# 旅行\n\n![海](assets/海.png)\n');
    fs.writeFileSync(path.join(src, 'assets', '海.png'), crypto.randomBytes(2000));
    const r = await page.evaluate(({ p, d }) => window.api.importFiles({ paths: [p], dir: d }), { p: path.join(src, '旅行.md'), d: library });
    assert.deepStrictEqual([r.added, r.images], [[path.join(library, '旅行.md')], 1]);
    assert.strictEqual(await page.evaluate(({ p }) => window.api.importFiles({ paths: [p], dir: '/tmp' }), { p: path.join(src, '旅行.md') }), null, 'only into the window\'s folder');
    await until(() => fs.existsSync(path.join(data, '旅行.md')) && fs.existsSync(path.join(data, 'assets', '海.png')), 'the copied files reach the server');
    assert(fs.existsSync(path.join(src, '旅行.md')), 'the original stays where it was');
    step('files dragged into the library are copied in, with their images, and reach the server');

    // the tree takes the drop (the window does not open the file instead), and shows where it goes
    const dropped = await page.evaluate(() => {
      const tree = document.querySelector('#tree');
      const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.md', { type: 'text/markdown' }));
      tree.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const highlighted = tree.classList.contains('drop-root');
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      tree.dispatchEvent(ev);
      return { highlighted, handled: ev.defaultPrevented, after: tree.classList.contains('drop-root') };
    });
    assert.deepStrictEqual(dropped, { highlighted: true, handled: true, after: false });
    await until(async () => /没有可以复制/.test(await page.locator('#toast, .toast').first().innerText().catch(() => '')), 'a file that is not on disk is reported');
    step('the file tree takes the drop and highlights where it goes');

    // ---- a file another device put on the server comes down ----
    const phoneText = '# 手机上写的\n';
    const put = await fetch(url + '/v1/file?path=' + encodeURIComponent('手机上写的.md'), { method: 'PUT', body: phoneText, headers: { Authorization: 'Bearer ' + TOKEN, 'If-None-Match': '*' } });
    assert.strictEqual(put.status, 200);
    await page.evaluate(() => window.api.syncNow());
    await until(async () => (await page.locator('.tree-item', { hasText: '手机上写的' }).count()) === 1, 'it shows in the tree');
    assert.strictEqual(fs.readFileSync(path.join(library, '手机上写的.md'), 'utf8'), phoneText);
    assert.strictEqual(sha(fs.readFileSync(path.join(library, 'assets', '海.png'))), sha(fs.readFileSync(path.join(src, 'assets', '海.png'))));
    await page.screenshot({ path: path.join(shots, 'sync-tree.png') });
    step('a file from another device comes down and shows in the tree');

    // ---- disconnect: everything stays ----
    page.once('dialog', (d) => d.accept());
    await page.evaluate(() => window.__whimflow.run('settings'));
    await page.locator('#settings .set-btn', { hasText: '断开' }).click();
    await page.waitForSelector('#settings input[type="password"]');
    assert(fs.existsSync(path.join(library, '旅行.md')) && fs.existsSync(path.join(data, '旅行.md')), 'files stay on both sides');
    step('disconnecting keeps the files here and on the server');

    assert.deepStrictEqual(errors, [], 'no page errors');
    console.log('SYNC APP OK  screenshots:', shots);
  } catch (err) {
    console.error('SYNC APP FAIL', err);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
