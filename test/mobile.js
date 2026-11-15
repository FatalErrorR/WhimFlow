// The iPhone / iPad app (mobile/www, built by `node scripts/build.js mobile`), run in
// Chromium at phone and tablet size with touch. Capacitor's plugins have browser
// versions (files live in IndexedDB), so the same code runs as in the iOS app; what
// this cannot cover is iOS itself (the WebKit engine, the keyboard, the Files app).
const { chromium, devices } = require('playwright');
const http = require('http');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const www = path.join(root, 'mobile/www');
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.woff': 'font/woff' };

(async () => {
  if (!fs.existsSync(path.join(www, 'index.html'))) throw new Error('mobile/www is missing: run `node scripts/build.js mobile`');
  fs.mkdirSync(shots, { recursive: true });
  const server = http.createServer((req, res) => {
    const p = path.join(www, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
    if (!p.startsWith(www) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const step = (name) => console.log('  ✓', name);

  // ---------- iPhone ----------
  const phone = await browser.newContext({ ...devices['iPhone 15'], locale: 'zh-CN' });
  let page = await phone.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  const boot = async () => { await page.goto(url); await page.waitForFunction(() => window.__whimflowMobile, null, { timeout: 15000 }); await sleep(300); };
  await boot();
  const W = (fn, arg) => page.evaluate(fn, arg);
  const read = (p) => W((p) => window.api.mobile.read(p), p);
  const exists = (p) => W((p) => window.api.mobile.exists(p), p);
  const body = (cls) => W((c) => document.body.classList.contains(c), cls);

  assert(await body('m-phone') && await body('m-lib'), 'a phone starts in the library');
  assert(/还没有文档/.test(await page.locator('#m-lib .m-empty').innerText()), 'which is empty at first');
  await page.screenshot({ path: path.join(shots, 'm1-library-empty.png') });

  // new document: typed, then saved on its own under its title
  await page.locator('.m-fab').tap();
  assert(!(await body('m-lib')), 'the + opens the editor');
  await page.locator('.cm-content').tap();
  await page.keyboard.type('# 购物清单');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('牛奶和面包');
  await page.waitForFunction(() => window.__whimflow.ctx.docs.active().filePath, null, { timeout: 8000 });
  assert.strictEqual(await W(() => window.__whimflow.ctx.docs.active().filePath), '/WhimFlow/购物清单.md', 'named after its title');
  await page.waitForFunction(() => !window.__whimflow.ctx.docs.active().dirty, null, { timeout: 8000 });
  assert.strictEqual(await read('/WhimFlow/购物清单.md'), '# 购物清单\n\n牛奶和面包');
  assert.strictEqual(await page.locator('#m-bar .m-title b').innerText(), '购物清单');
  step('new document: written, saved by itself, named after its title');

  // the formatting bar (shown above the keyboard; the emulator has no keyboard, so it is raised by hand)
  await W(() => { document.body.classList.add('m-kb'); document.documentElement.style.setProperty('--kb', '300px'); });
  assert(await page.locator('#m-tools').isVisible(), 'formatting bar above the keyboard while editing');
  await page.keyboard.press('Enter');
  await page.locator('#m-tools .m-k', { hasText: '☐' }).tap();
  await page.keyboard.type('鸡蛋');
  await page.waitForFunction(() => window.__whimflow.editor.getValue().endsWith('- [ ] 鸡蛋'), null, { timeout: 4000 }).catch(async (e) => { throw new Error('editor holds: ' + JSON.stringify(await W(() => window.__whimflow.editor.getValue()))); });
  assert(await W(() => document.activeElement && document.activeElement.classList.contains('cm-content')), 'the keyboard stays up');
  await page.screenshot({ path: path.join(shots, 'm2-editing.png') });
  await page.locator('#m-tools .m-hide').tap();
  await sleep(200);
  assert(!(await page.locator('#m-tools').isVisible()), 'and hides with the keyboard');
  await W(() => { document.body.classList.remove('m-kb'); document.documentElement.style.setProperty('--kb', '0px'); });
  step('formatting bar: inserts at the caret without dropping the keyboard');

  // write / read (the caret in a paragraph, as when you have just been writing one)
  await W(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(3).from } }); });
  await page.locator('#m-bar .m-seg button[data-mode="read"]').tap();
  await page.waitForFunction(() => /鸡蛋/.test(document.querySelector('#preview-doc').textContent));
  assert(await body('m-read') && await page.locator('#preview').isVisible() && !(await page.locator('#main').isVisible()), 'read shows the final view alone');
  await page.waitForSelector('#preview-doc .here', { state: 'attached', timeout: 3000 });
  assert.deepStrictEqual(await W(() => ({
    bars: [...document.querySelectorAll('#preview-doc *')].filter((e) => getComputedStyle(e).boxShadow !== 'none').length,
    bands: [...document.querySelectorAll('.pv-band')].filter((e) => getComputedStyle(e).display !== 'none').length,
  })), { bars: 0, bands: 0 }, 'no caret bar or bands beside the text when reading on a phone');
  await page.screenshot({ path: path.join(shots, 'm3-read.png') });
  await page.locator('#preview-doc p', { hasText: '牛奶和面包' }).tap();
  await sleep(300);
  assert(!(await body('m-read')), 'tapping a paragraph goes back to writing');
  assert.strictEqual(await W(() => window.__whimflow.editor.caretLine()), 3, 'at that paragraph');
  step('写 / 看: the final view, and back to the paragraph tapped');

  // the sheet: outline
  await W(() => { const v = window.__whimflow.editor.view; const ins = '\n\n## 周末\n\n水果'; v.dispatch({ changes: { from: v.state.doc.length, insert: ins }, selection: { anchor: v.state.doc.length + ins.length } }); });
  await page.locator('#m-bar .m-more').tap();
  assert(await page.locator('#m-sheetwrap .m-sheet').isVisible(), 'the sheet opens');
  assert.deepStrictEqual(await page.locator('.m-ol').allInnerTexts(), ['购物清单', '周末']);
  await page.screenshot({ path: path.join(shots, 'm4-sheet.png') });
  await page.locator('.m-ol', { hasText: '购物清单' }).tap();
  assert(!(await page.locator('#m-sheetwrap .m-sheet').isVisible()), 'and closes on a choice');
  step('sheet: outline jumps to a heading');

  // back to the library: saved, listed, renamed
  await page.locator('#m-bar .m-back').tap();
  await page.waitForFunction(() => document.body.classList.contains('m-lib') && document.querySelector('#m-lib .m-doc'));
  assert(/水果/.test(await read('/WhimFlow/购物清单.md')), 'leaving the document saved it');
  assert.strictEqual(await page.locator('#m-lib .m-doc h4').first().innerText(), '购物清单');
  const row = page.locator('#m-lib .m-doc').first();
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 20); await page.mouse.down(); await sleep(650); await page.mouse.up();
  await page.locator('#ctxmenu .item', { hasText: '编辑名字' }).click();
  await page.fill('#modal-input', '周末采购.md');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__whimflow.ctx.docs.byPath('/WhimFlow/周末采购.md'), null, { timeout: 5000 });
  assert(await exists('/WhimFlow/周末采购.md') && !(await exists('/WhimFlow/购物清单.md')), 'renamed on disk');
  step('library: recent documents; long-press to rename');

  // folders and full-text search
  await page.locator('#m-lib .m-chips button[data-view="folders"]').tap();
  await page.locator('.m-newfolder').tap();
  await page.fill('#modal-input', '工作');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#m-lib .m-folder')].some((f) => f.textContent.includes('工作')), null, { timeout: 5000 });

  // swipe a row left: … (编辑 → 编辑名字 / 移到文件夹) and × (删除, asked first)
  const swipe = async (loc) => {
    const b = await loc.boundingBox(), y = b.y + b.height / 2;
    await page.mouse.move(b.x + b.width - 30, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width - 30 - i * 25, y);
    await page.mouse.up(); await sleep(300);
  };
  const rowOf = (cls, text) => page.locator('#m-lib .m-swipe', { has: page.locator(cls, { hasText: text }) });
  const moveVia = async (row, folder) => {
    await swipe(row);
    assert(await row.evaluate((e) => e.classList.contains('open')), 'swiping left opens the row');
    await row.locator('.m-act-edit').tap();
    assert.deepStrictEqual(await page.locator('#ctxmenu .item').allInnerTexts(), ['编辑名字', '移到文件夹'], '… offers rename and move');
    await page.locator('#ctxmenu .item', { hasText: '移到文件夹' }).click();
    await page.locator('#ctxmenu .item', { hasText: folder }).click();
  };
  await sleep(900); // the library redraws itself once more after a new folder
  {
    // halfway through a swipe the buttons are glued to the row's edge, their icons only half grown
    const r = rowOf('.m-doc', '购物清单'), b = await r.boundingBox(), y = b.y + b.height / 2;
    await page.mouse.move(b.x + b.width - 30, y); await page.mouse.down();
    for (let i = 1; i <= 4; i++) await page.mouse.move(b.x + b.width - 30 - i * 15, y);
    const mid = await r.evaluate((w) => {
      const row = w.querySelector('.m-doc'), acts = w.querySelector('.m-swipe-acts');
      return { gap: Math.round(acts.getBoundingClientRect().left - row.getBoundingClientRect().right), p: +getComputedStyle(acts).getPropertyValue('--p'), select: getComputedStyle(row).webkitUserSelect || getComputedStyle(row).userSelect, h: Math.round(row.getBoundingClientRect().height) };
    });
    await page.mouse.move(b.x + b.width - 30, y); await page.mouse.up(); await sleep(400);
    assert.strictEqual(mid.gap, 0, 'mid-swipe: the buttons move with the row');
    assert(mid.p > 0.2 && mid.p < 0.8, 'mid-swipe: the icons are still growing: ' + mid.p);
    assert.strictEqual(mid.select, 'none', 'a long press does not select the row text');
    assert(mid.h <= 64, 'a document row is compact: ' + mid.h);
    assert(!(await r.evaluate((w) => w.classList.contains('open'))), 'dragged back: closed again');
  }
  await moveVia(rowOf('.m-doc', '购物清单'), '工作');
  await page.waitForFunction(() => window.api.mobile.exists('/WhimFlow/工作/周末采购.md'), null, { timeout: 5000 });
  assert(!(await exists('/WhimFlow/周末采购.md')), 'moved into the folder');
  await page.locator('#m-lib .m-folder', { hasText: '工作' }).tap();
  await moveVia(rowOf('.m-doc', '购物清单'), 'WhimFlow');
  await page.waitForFunction(() => window.api.mobile.exists('/WhimFlow/周末采购.md'), null, { timeout: 5000 });
  assert(!(await exists('/WhimFlow/工作/周末采购.md')), 'and back to the top of the library');
  await page.locator('#m-lib .m-crumb').tap();
  const work = rowOf('.m-folder', '工作');
  await swipe(work);
  await page.screenshot({ path: path.join(shots, 'm4-swipe.png') });
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await work.locator('.m-act-del').tap();
  await sleep(900); // the library redraws after any action on an item
  assert(/工作/.test(asked) && await exists('/WhimFlow/工作'), 'delete asks first; cancelled, nothing is deleted');
  await swipe(work);
  page.once('dialog', (d) => d.accept());
  await work.locator('.m-act-del').tap();
  await page.waitForFunction(async () => !(await window.api.mobile.exists('/WhimFlow/工作')), null, { timeout: 5000 });
  step('swipe left: move into a folder and back; delete asks first');

  await page.locator('#m-lib .m-search input').fill('面包');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#m-lib .m-hit mark'), null, { timeout: 10000 });
  await page.locator('#m-lib .m-hit').first().tap();
  await page.waitForFunction(() => !document.body.classList.contains('m-lib'));
  assert.strictEqual(await W(() => window.__whimflow.editor.caretLine()), 3, 'a search hit opens at its line');
  step('folders, and full-text search that opens at the hit');

  // crash: unsaved text comes back after the app is killed
  await W(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
  await page.keyboard.type(' 还没保存');
  await W(() => window.api.setSetting('autoSave', false));
  await page.keyboard.type('的字');
  await sleep(1700); // the draft is written
  await page.close();
  page = await phone.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await boot();
  assert(!(await body('m-lib')), 'a recovered document opens straight away');
  assert(/还没保存的字/.test(await W(() => window.__whimflow.editor.getValue())), 'with the unsaved text');
  assert(!/还没保存的字/.test(await read('/WhimFlow/周末采购.md')), 'the file itself is untouched until saved');
  await W(() => window.api.setSetting('autoSave', true));
  await page.locator('#m-bar .m-back').tap();
  await page.waitForFunction(() => document.body.classList.contains('m-lib'));
  await page.waitForFunction(async () => /还没保存的字/.test(await window.api.mobile.read('/WhimFlow/周末采购.md')), null, { timeout: 5000 });
  step('killed with unsaved text: it comes back, and is saved on leaving');

  // the file changed elsewhere (the Files app, another device): no silent overwrite
  await page.locator('#m-lib .m-chips button[data-view="recent"]').tap();
  await page.locator('#m-lib .m-doc').first().tap();
  await page.waitForFunction(() => !document.body.classList.contains('m-lib'));
  await W(async () => { // another writer, based on the version on disk
    const p = '/WhimFlow/周末采购.md', m = window.api.mobile;
    const r = await window.api.save({ content: '# 周末采购\n\n别处改的', filePath: p, expectedVersion: await m.hash(await m.read(p)), docId: 'elsewhere', rev: 1 });
    if (!r || !r.ok) throw new Error('could not write behind the app\'s back');
  });
  await W(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
  await page.keyboard.type(' 本机');
  await page.locator('#m-bar .m-back').tap();
  await sleep(1000);
  assert.strictEqual(await read('/WhimFlow/周末采购.md'), '# 周末采购\n\n别处改的', 'the text written elsewhere is not overwritten');
  assert(await W(() => !!window.__whimflow.ctx.docs.list().find((d) => d.conflict && / 本机$/.test(window.__whimflow.ctx.docs.textOf(d)))), 'this device keeps its text, marked as a conflict');
  step('changed elsewhere: the save is refused, both texts kept');

  // a save interrupted between writing the new text and replacing the file is finished at the next start
  await W(() => window.api.mobile.writeFile('/WhimFlow/半途.md.mftmp', '# 半途\n\n完整的新内容'));
  await page.close();
  page = await phone.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await boot();
  assert.strictEqual(await read('/WhimFlow/半途.md'), '# 半途\n\n完整的新内容', 'the interrupted save was completed');
  assert(!(await exists('/WhimFlow/半途.md.mftmp')), 'and its temporary file is gone');
  await page.close();
  step('a save interrupted halfway is completed at the next start');

  // ---------- sync with a WhimFlow server (a real one, on this computer), on a fresh iPhone ----------
  const TOKEN = crypto.randomBytes(24).toString('hex');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-mobile-sync-'));
  const syncProc = spawn(process.execPath, [path.join(root, 'sync-server/server.js')], {
    env: { ...process.env, DATA: data, WHIMFLOW_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const syncUrl = await new Promise((resolve) => syncProc.stdout.on('data', (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(`http://127.0.0.1:${m[1]}`); }));
  const onServer = (rel) => (fs.existsSync(path.join(data, ...rel.split('/'))) ? fs.readFileSync(path.join(data, ...rel.split('/'))) : null);
  const until = async (fn, what, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return; await sleep(100); } throw new Error('timed out waiting for: ' + what); };
  const otherDevice = (rel, body, headers) => fetch(syncUrl + '/v1/file?path=' + encodeURIComponent(rel), { method: 'PUT', body, headers: { Authorization: 'Bearer ' + TOKEN, ...headers } });
  try {
    const iphone2 = await browser.newContext({ ...devices['iPhone 15'], locale: 'zh-CN' });
    page = await iphone2.newPage();
    page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
    await boot();
    await W(() => window.api.mobile.writeFile('/WhimFlow/手机笔记.md', '# 手机笔记\n\n在 iPhone 上写的'));
    assert.strictEqual(await page.locator('#m-lib .m-local').innerText(), '保存在本机', 'not connected yet');
    await page.locator('#m-lib .m-local').tap(); // not connected: the chip opens Settings
    await page.waitForSelector('#settings:not([hidden]) input[type="password"]');
    await page.locator('#settings input[type="text"]').first().fill(syncUrl);
    await page.locator('#settings input[type="password"]').fill(TOKEN);
    await page.locator('#settings .set-btn.primary').tap();
    await page.waitForSelector('#settings .sync-state', { timeout: 10000 });
    await until(() => onServer('手机笔记.md'), 'the phone\'s document reaches the server');
    assert.strictEqual(onServer('手机笔记.md').toString(), '# 手机笔记\n\n在 iPhone 上写的');
    await page.screenshot({ path: path.join(shots, 'm6-sync-settings.png') });
    await page.locator('#settings .set-close').tap();
    await until(async () => /已同步/.test(await page.locator('#m-lib .m-local').innerText()), 'the chip says synced');
    assert.strictEqual(await W(async () => (await window.api.syncConfig()).url), syncUrl);
    step('sync: connect in Settings (the chip opens it); the phone\'s documents go up; the chip says "已同步"');

    // what another device put on the server comes down: a document and an image, byte for byte
    const png = crypto.randomBytes(5000);
    assert.strictEqual((await otherDevice('电脑上写的.md', '# 电脑上写的\n', { 'If-None-Match': '*' })).status, 200);
    assert.strictEqual((await otherDevice('assets/图.png', png, { 'If-None-Match': '*' })).status, 200);
    await page.locator('#m-lib .m-local').tap(); // connected: a tap syncs now
    await page.locator('#m-lib .m-chips button[data-view="folders"]').tap();
    await until(async () => (await page.locator('#m-lib .m-doc', { hasText: '电脑上写的' }).count()) === 1, 'the new document shows in the library');
    const listed = await W(() => window.api.mobile.syncLocal.list());
    assert.strictEqual(listed.files['assets/图.png'] && listed.files['assets/图.png'].v, sha(png), 'the image arrived unchanged');
    await page.screenshot({ path: path.join(shots, 'm7-sync-library.png') });
    step('a document and an image from another device come down; the library shows them');

    // an open document follows a change made elsewhere; an edit here goes up
    await page.locator('#m-lib .m-doc', { hasText: '手机笔记' }).tap();
    await page.waitForFunction(() => !document.body.classList.contains('m-lib'));
    const before = onServer('手机笔记.md');
    assert.strictEqual((await otherDevice('手机笔记.md', '# 手机笔记\n\n电脑改过了', { 'If-Match': sha(before) })).status, 200);
    await W(() => window.api.syncNow());
    await page.waitForFunction(() => window.__whimflow.editor.getValue() === '# 手机笔记\n\n电脑改过了', null, { timeout: 8000 });
    await W(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await page.keyboard.type('，手机又补了一句');
    await page.locator('#m-bar .m-back').tap();
    await until(() => /手机又补了一句/.test(String(onServer('手机笔记.md'))), 'the edit reaches the server', 15000);
    assert(!fs.readdirSync(data).some((n) => /冲突/.test(n)), 'no conflict copies: nothing was lost or doubled');
    step('the open document follows a change from another device; an edit here goes up');

    // pull the library down to sync: a short pull springs back, a long one syncs
    await until(async () => W(() => document.body.classList.contains('m-lib')), 'back in the library');
    const pullBy = (dist) => W(async (dist) => {
      const lib = document.querySelector('#m-lib'); lib.scrollTop = 0;
      const at = (y) => new Touch({ identifier: 1, target: lib, clientX: 200, clientY: y });
      const fire = (type, y, list = true) => lib.dispatchEvent(new TouchEvent(type, { touches: list ? [at(y)] : [], changedTouches: [at(y)], bubbles: true, cancelable: true }));
      fire('touchstart', 150);
      let blocked = true;
      for (let y = 160; y <= 150 + dist; y += 10) { const ev = new TouchEvent('touchmove', { touches: [at(y)], changedTouches: [at(y)], bubbles: true, cancelable: true }); lib.dispatchEvent(ev); blocked = blocked && ev.defaultPrevented; }
      const seen = { text: document.querySelector('.m-pull-text').textContent, offset: getComputedStyle(lib).getPropertyValue('--pull').trim(), blocked };
      fire('touchend', 150 + dist, false);
      return seen;
    }, dist);
    assert.strictEqual((await otherDevice('下拉刷新.md', '# 下拉刷新\n', { 'If-None-Match': '*' })).status, 200);
    let seen = await pullBy(60);
    assert.deepStrictEqual([seen.text, seen.offset, seen.blocked], ['下拉同步', '30px', true], 'a short pull: the list follows the finger, the page does not bounce');
    await sleep(500);
    assert.strictEqual(await W(() => getComputedStyle(document.querySelector('#m-lib')).getPropertyValue('--pull').trim()), '0px', 'and springs back');
    assert.strictEqual(await page.locator('#m-lib .m-doc', { hasText: '下拉刷新' }).count(), 0, 'without syncing');
    seen = await pullBy(180);
    assert.strictEqual(seen.text, '松开立即同步', 'past the line it says release');
    await until(async () => /正在同步|已同步/.test(await page.locator('.m-pull-text').innerText()), 'it syncs');
    await page.screenshot({ path: path.join(shots, 'm8-pull-sync.png') });
    await until(async () => (await page.locator('#m-lib .m-doc', { hasText: '下拉刷新' }).count()) === 1, 'the new document is in the list');
    await until(async () => W(() => getComputedStyle(document.querySelector('#m-lib')).getPropertyValue('--pull').trim() === '0px'), 'the list settles back');
    step('pull the library down to sync: a short pull springs back, a long one syncs and shows the result');

    assert.strictEqual(await W(async () => (await window.Capacitor.Plugins.Preferences.get({ key: 'keychain:syncToken' })).value), TOKEN, 'the token is in the (emulated) Keychain');
    assert(!(await W(async () => (await window.Capacitor.Plugins.Preferences.get({ key: 'settings' })).value)).includes(TOKEN), 'and not in the settings');
    await page.close();
    step('the token is kept in the Keychain, not in the settings');
  } finally {
    syncProc.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }

  // ---------- iPad (landscape): the desktop islands ----------
  const ipad = await browser.newContext({ ...devices['iPad Pro 11 landscape'], locale: 'zh-CN' });
  page = await ipad.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await boot();
  assert(await body('m-tablet'), 'an iPad in landscape gets the tablet layout');
  await page.locator('.m-fab').tap();
  await page.locator('.cm-content').tap();
  await page.keyboard.type('# iPad 笔记\n\n三块浮岛');
  await W(() => window.__whimflow.ctx.right.setRight(true, 'preview'));
  await sleep(800);
  assert(await page.locator('#sidebar').isVisible() && await page.locator('#main').isVisible() && await page.locator('#right').isVisible(), 'sidebar, editor and final view side by side');
  await page.screenshot({ path: path.join(shots, 'm5-ipad.png') });
  step('iPad: sidebar, editor and final view side by side');

  assert.deepStrictEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('MOBILE OK  screenshots:', shots);
})().catch((e) => { console.error('MOBILE FAIL', e); process.exit(1); });
