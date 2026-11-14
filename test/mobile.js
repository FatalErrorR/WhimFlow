// The iPhone / iPad app (mobile/www, built by `node scripts/build.js mobile`), run in
// Chromium at phone and tablet size with touch. Capacitor's plugins have browser
// versions (files live in IndexedDB), so the same code runs as in the iOS app; what
// this cannot cover is iOS itself (the WebKit engine, the keyboard, the Files app).
const { chromium, devices } = require('playwright');
const http = require('http');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
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

  // write / read
  await page.locator('#m-bar .m-seg button[data-mode="read"]').tap();
  await page.waitForFunction(() => /鸡蛋/.test(document.querySelector('#preview-doc').textContent));
  assert(await body('m-read') && await page.locator('#preview').isVisible() && !(await page.locator('#main').isVisible()), 'read shows the final view alone');
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
  await page.locator('#ctxmenu .item', { hasText: '重命名' }).click();
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
