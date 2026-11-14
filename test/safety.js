// End-to-end tests for data safety: typing during a slow save, closing while a save
// is under way, auto-save and drafts being switched off and on, version history
// answering for a document that is no longer in front, images that arrive after
// the document was switched, renaming a folder with open documents, a Trash that
// fails, a runaway search, and two windows that crashed with the same file open.
// Slow IPC calls are simulated with the main process's test hooks (WHIMFLOW_TEST).
const { _electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const root = path.join(__dirname, '..');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'; // the app's "mod" key: ⌘ on macOS, Ctrl elsewhere
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');

const launch = (args, extraEnv = {}) => _electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: ['--no-sandbox', root, ...args],
  env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh', ...extraEnv },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for: ' + what);
    await sleep(80);
  }
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const draftsIn = (ud) => { try { return fs.readdirSync(path.join(ud, 'drafts')).filter((n) => n.endsWith('.json')).map((n) => ({ name: n, ...JSON.parse(fs.readFileSync(path.join(ud, 'drafts', n), 'utf8')) })); } catch (_) { return []; } };

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-safety-'));
  const errors = [];
  const step = (name) => console.log('  ✓', name);

  // a folder whose name holds the characters that break naive file URLs
  const dirA = path.join(work, 'notes #1 ?文档');
  const dirArchive = path.join(work, 'notes #1 ?文档-archive'); // same prefix, different folder
  fs.mkdirSync(dirA); fs.mkdirSync(dirArchive); fs.mkdirSync(path.join(work, 'other'));
  const fileA = path.join(dirA, 'a.md'), fileB = path.join(work, 'other', 'b.md'), fileC = path.join(work, 'c.md'), fileD = path.join(dirArchive, 'd.md');
  fs.writeFileSync(fileA, '# A\n\nStart.\n');
  fs.writeFileSync(fileB, '# B\n\nBRAVO text.\n');
  fs.writeFileSync(fileC, '# C\n\nALPHA-OLD text.\n');
  fs.writeFileSync(fileD, '# D\n\nArchive.\n');
  const ud = path.join(work, 'ud #1');

  let app = await launch([fileA, fileB, fileC, fileD, '--user-data-dir=' + ud], { WHIMFLOW_TEST_CONFIRM: 'save' });
  let page = await app.firstWindow();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await page.waitForFunction(() => window.__whimflow && window.__whimflow.ctx.docs && window.__whimflow.ctx.docs.list().filter((d) => d.filePath).length === 4, null, { timeout: 15000 });
  await page.waitForTimeout(500);

  const hooks = (patch) => app.evaluate((_e, p) => { Object.assign(globalThis.__whimflowTest, p); }, patch);
  const delay = (d) => app.evaluate((_e, v) => { globalThis.__whimflowTest.delay = v; }, d);
  const run = (c, a) => page.evaluate(([c, a]) => { window.__whimflow.run(c, a); }, [c, a]);
  const show = (p) => page.evaluate((p) => { const d = window.__whimflow.ctx.docs; d.activate(d.byPath(p)); }, p);
  const docInfo = (p) => page.evaluate((p) => { const D = window.__whimflow.ctx.docs, d = D.byPath(p); return d ? { text: D.textOf(d), dirty: d.dirty, active: D.active() === d } : null; }, p);
  const typeAtEnd = async (text) => {
    await page.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await page.keyboard.type(text);
  };
  const setting = (k, v) => page.evaluate(([k, v]) => window.api.setSetting(k, v), [k, v]);

  // ---------- 1. typing while a save is being written ----------
  await show(fileA);
  await delay({ save: 1500 });
  await typeAtEnd(' one');
  await run('save');
  await sleep(300);
  await typeAtEnd(' two');
  await until(() => (read(fileA) || '').includes(' one'), 'the first save to land');
  await sleep(250);
  assert(!read(fileA).includes(' two'), 'the slow save wrote what it was asked to');
  let info = await docInfo(fileA);
  assert(info.dirty, 'text typed during the save is still unsaved');
  assert(/已编辑/.test(await page.locator('#title-state').innerText()), 'the title says so');
  await until(() => draftsIn(ud).some((d) => d.content.includes(' two')), 'a draft holding the text typed during the save', 4000);
  await delay({});
  await run('save');
  await until(async () => !(await docInfo(fileA)).dirty, 'the second save');
  assert(read(fileA).includes(' one two'));
  await until(() => draftsIn(ud).length === 0, 'the draft to go once everything is saved');
  step('typing during a slow save: still unsaved, still in a draft');

  // ---------- 2. auto-save: a save under way does not swallow the next one ----------
  await setting('autoSaveDelay', 1);
  await setting('autoSave', true);
  await delay({ save: 1500 });
  await typeAtEnd(' three');
  await sleep(1800); // the auto-save started at ~1 s and is still being written
  await typeAtEnd(' four');
  await until(() => (read(fileA) || '').includes(' three four'), 'auto-save of the text typed during the previous auto-save', 9000);
  await until(async () => !(await docInfo(fileA)).dirty, 'clean afterwards');
  step('auto-save picks up text typed while it was writing');

  // ---------- 3. turning auto-save off cancels the save it had planned ----------
  await delay({});
  await setting('autoSaveDelay', 2);
  await typeAtEnd(' five');
  await setting('autoSave', false);
  await sleep(3200);
  assert(!read(fileA).includes(' five'), 'no auto-save after it was switched off');
  assert((await docInfo(fileA)).dirty, 'still unsaved');
  step('switching auto-save off cancels pending auto-saves');

  // ---------- 4. drafts off and on ----------
  await until(() => draftsIn(ud).some((d) => d.content.includes(' five')), 'a draft of the unsaved text', 4000);
  await setting('drafts', false);
  await until(() => draftsIn(ud).length === 0, 'drafts removed when switched off', 3000);
  await typeAtEnd(' six');
  await sleep(1700);
  assert.strictEqual(draftsIn(ud).length, 0, 'nothing written while off');
  await setting('drafts', true);
  await until(() => draftsIn(ud).some((d) => d.content.includes(' five six') && d.filePath === fileA), 'a fresh draft as soon as drafts are on again', 1500);
  step('drafts: switched off removes them, switched on writes them at once');

  // ---------- 5. closing a document while its save is slow ----------
  await delay({ save: 1500 });
  await run('close-doc'); // answers "save" (WHIMFLOW_TEST_CONFIRM)
  await sleep(400);
  await typeAtEnd(' seven');
  await until(async () => !(await docInfo(fileA)), 'the document to close', 10000);
  assert(read(fileA).includes(' five six seven'), 'closed only once the newest text was saved: ' + JSON.stringify(read(fileA)));
  await delay({});
  await page.evaluate((p) => window.api.openInWindow(p, null, { preview: false }), fileA);
  await until(async () => (await docInfo(fileA)) && (await docInfo(fileA)).active, 'a.md open again');
  step('closing during a slow save waits for the newest text');

  // ---------- 6. version history answering for another document ----------
  // c.md gets a second version; b.md has only the one taken when it was opened
  await show(fileC);
  await typeAtEnd(' ALPHA-NEW');
  await run('save');
  await until(async () => !(await docInfo(fileC)).dirty, 'c.md saved');
  await delay({ 'history-read': 900 });
  await run('history');
  await sleep(150);
  await show(fileB); // while c.md's versions are still being read
  await sleep(2600);
  const rows = await page.locator('.hist-item').count();
  assert.strictEqual(rows, 1, 'only b.md’s single version is listed, got ' + rows);
  await page.locator('.hist-item').first().click();
  await page.locator('.hist-bar .primary').click();
  await sleep(200);
  info = await docInfo(fileB);
  assert(!/ALPHA/.test(info.text), 'b.md never receives c.md’s text');
  // a restore button left over from c.md (switched away before clicking) restores nothing
  await delay({});
  await show(fileC);
  await page.waitForSelector('.hist-item');
  await page.locator('.hist-item').last().click();
  await page.evaluate(() => { window.__staleRestore = document.querySelector('.hist-bar .primary'); });
  await show(fileB);
  await page.evaluate(() => window.__staleRestore.click());
  await sleep(200);
  info = await docInfo(fileB);
  assert(!/ALPHA/.test(info.text) && info.text.includes('BRAVO'), 'stale restore did nothing: ' + JSON.stringify(info.text));
  assert(/另一篇文档/.test(await page.locator('#toast').innerText()), 'and said why');
  await run('history'); // close the panel
  step('history: answers for a document no longer in front are dropped; restore stays in its document');

  // ---------- 7. an image saved after the document was switched ----------
  await show(fileA);
  await delay({ 'save-image': 1200 });
  const before = (await docInfo(fileA)).text;
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const g = c.getContext('2d'); g.fillStyle = '#c96442'; g.fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    const v = window.__whimflow.editor.view;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(100);
  await show(fileB);
  const bBefore = (await docInfo(fileB)).text;
  await sleep(1800);
  assert.strictEqual((await docInfo(fileB)).text, bBefore, 'the image did not land in b.md');
  info = await docInfo(fileA);
  assert(info.text.startsWith(before) && info.text.endsWith('![shot](assets/shot.png)'), 'it landed in a.md, relative to a.md: ' + JSON.stringify(info.text.slice(-60)));
  assert(info.dirty, 'a.md is unsaved');
  assert(fs.existsSync(path.join(dirA, 'assets', 'shot.png')), 'saved next to a.md');
  assert(!fs.existsSync(path.join(work, 'other', 'assets')), 'nothing saved next to b.md');
  await delay({});
  // and it shows, although a.md lives in "notes #1 ?文档"
  await show(fileA);
  await page.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: 0 } }); });
  await page.waitForFunction(() => { const i = document.querySelector('.cm-image img'); return i && i.complete && i.naturalWidth === 8; }, null, { timeout: 5000 });
  await run('preview');
  await page.waitForFunction(() => { const i = document.querySelector('#preview-doc img'); return i && i.complete && i.naturalWidth === 8; }, null, { timeout: 5000 });
  await run('preview');
  step('image pasted, document switched: it goes into the right document, and shows despite # ? in the folder name');

  // ---------- 8. renaming a folder with open documents ----------
  await typeAtEnd(' eight');
  await sleep(1500);
  const journal = path.join(work, 'journal');
  const moved = await page.evaluate((from) => window.api.rename({ from, name: 'journal' }), dirA);
  assert.strictEqual(moved, journal);
  const movedA = path.join(journal, 'a.md');
  await until(() => page.evaluate((p) => !!window.__whimflow.ctx.docs.byPath(p), movedA), 'a.md to follow its folder');
  assert(await page.evaluate((p) => !!window.__whimflow.ctx.docs.byPath(p), fileD), 'd.md (in "…-archive") did not move');
  assert(await page.evaluate(() => window.__whimflow.ctx.baseUrl().includes('/journal/')), 'images resolve from the new folder');
  await until(() => draftsIn(ud).some((d) => d.filePath === movedA && d.content.includes(' eight')), 'the draft names the new path', 3000);
  await page.keyboard.press(`${mod}+s`);
  await until(async () => !(await docInfo(movedA)).dirty, 'saved after the rename');
  assert(read(movedA).includes(' eight') && read(movedA).includes('![shot](assets/shot.png)'));
  assert(!fs.existsSync(dirA), 'nothing written to the old folder');
  await page.waitForFunction(() => { const i = document.querySelector('.cm-image img'); return i && i.complete && i.naturalWidth === 8; }, null, { timeout: 5000 });
  step('renaming a folder moves its open documents, drafts and image base (and nothing with a similar name)');

  // ---------- 9. a Trash that fails deletes nothing ----------
  const doomed = path.join(work, 'keep-me');
  fs.mkdirSync(doomed); fs.writeFileSync(path.join(doomed, 'inner.md'), 'precious');
  await app.evaluate(() => { globalThis.__whimflowTest.answer.trash = 0; globalThis.__whimflowTest.trashItem = async () => { throw new Error('Trash unavailable'); }; });
  await app.evaluate(({ BrowserWindow }, p) => { BrowserWindow.getAllWindows()[0].webContents.send('tree-action', 'trash', { path: p, dir: true }); }, doomed);
  await page.waitForFunction(() => /无法移到废纸篓/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
  assert(/Trash unavailable/.test(await page.locator('#toast').innerText()), 'the reason is shown');
  assert.strictEqual(read(path.join(doomed, 'inner.md')), 'precious', 'the folder and its file are still there');
  step('Trash failure: error shown, nothing deleted');

  // ---------- 10. a catastrophic regular expression ----------
  fs.writeFileSync(path.join(work, 'evil.md'), 'a'.repeat(40) + '!\n');
  await hooks({ searchTimeout: 1500 });
  await page.evaluate((dir) => window.__whimflow.ctx.sidebar.setFolder(dir), work);
  await run('search');
  await page.locator('#search .search-opt[data-opt="regex"]').click();
  await page.fill('#search-input', '(a+)+$');
  await page.keyboard.press('Enter');
  await sleep(300);
  const ping = await page.evaluate(async () => { const t0 = performance.now(); await window.api.setTitle('ping'); return performance.now() - t0; });
  assert(ping < 400, 'the main process answers during the search (' + Math.round(ping) + ' ms)');
  await page.waitForFunction(() => /超时/.test(document.querySelector('#search-status').textContent), null, { timeout: 6000 })
    .catch(async (e) => { throw new Error('search status: ' + await page.locator('#search-status').innerText() + ' / ' + e.message); });
  await page.locator('#search .search-opt[data-opt="regex"]').click();
  await page.fill('#search-input', 'BRAVO');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /个文件/.test(document.querySelector('#search-status').textContent) && [...document.querySelectorAll('#search-results .hit-head .name')].some((n) => n.textContent === 'b'), null, { timeout: 6000 });
  step('search: a runaway regex times out, the app stays responsive, normal search works');

  // ---------- 11. closing the window while a save is slow ----------
  await show(movedA);
  await typeAtEnd(' nine');
  await delay({ save: 1500 });
  await app.evaluate(() => { globalThis.__whimflowTest.answer['close-window'] = 0; });
  assert.deepStrictEqual(errors, [], 'no page errors');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await sleep(400);
  await typeAtEnd(' ten');
  await until(() => app.process().exitCode !== null || app.process().signalCode !== null, 'the window (and app) to close', 12000).catch(() => {});
  assert(read(movedA).includes(' nine ten'), 'the window closed only after the newest text was saved: ' + JSON.stringify(read(movedA).slice(-40)));
  await app.close().catch(() => {});
  step('closing the window during a slow save waits for the newest text');

  // ---------- 12. two windows, one file, both crash ----------
  const shared = path.join(work, 'shared.md');
  fs.writeFileSync(shared, '# Shared\n\nBase.\n');
  const ud2 = path.join(work, 'ud2');
  app = await launch([shared, '--user-data-dir=' + ud2]);
  const w1 = await app.firstWindow();
  await w1.waitForFunction(() => window.__whimflow && /shared\.md$/.test(window.__whimflow.state.filePath || ''));
  const second = app.waitForEvent('window');
  await app.evaluate((_e, p) => { globalThis.__whimflowTest.createWindow({ files: [p] }); }, shared);
  const w2 = await second;
  await w2.waitForFunction(() => window.__whimflow && /shared\.md$/.test(window.__whimflow.state.filePath || ''), null, { timeout: 15000 });
  for (const [w, text] of [[w1, ' from window one'], [w2, ' from window two']]) {
    await w.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await w.keyboard.type(text);
  }
  await until(() => draftsIn(ud2).length === 2, 'a draft from each window', 5000);
  const oldDrafts = draftsIn(ud2).map((d) => d.name);
  app.process().kill('SIGKILL');
  await sleep(800);
  app = await launch(['--user-data-dir=' + ud2]);
  page = await app.firstWindow();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await page.waitForFunction(() => window.__whimflow && window.__whimflow.ctx.docs && window.__whimflow.ctx.docs.list().filter((d) => d.dirty).length === 2, null, { timeout: 15000 });
  const back = await page.evaluate(() => { const D = window.__whimflow.ctx.docs; return D.list().map((d) => ({ path: d.filePath, name: D.name(d), text: D.textOf(d), dirty: d.dirty })); });
  const texts = back.map((d) => d.text).sort();
  assert(texts[0].endsWith('Base.\n from window one') && texts[1].endsWith('Base.\n from window two'), 'both texts came back: ' + JSON.stringify(back));
  assert.strictEqual(back.filter((d) => d.path === shared).length, 1, 'one of them is shared.md itself');
  const copy = back.find((d) => !d.path);
  assert(copy && /恢复副本/.test(copy.name), 'the other is a recovered copy: ' + JSON.stringify(copy));
  await until(() => { const now = draftsIn(ud2); return now.length === 2 && now.every((d) => !oldDrafts.includes(d.name)); }, 'old drafts replaced by this window’s own', 5000);
  await page.screenshot({ path: path.join(shots, 'safety-recovered.png') });
  assert.deepStrictEqual(errors, [], 'no page errors');
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  step('two windows crashed with the same file: both texts recovered, drafts kept until then');

  // ---------- 13. two windows save the same file: the second one is a conflict, not an overwrite ----------
  const confDir = path.join(work, 'conflict');
  fs.mkdirSync(confDir);
  const sharedC = path.join(confDir, 'shared.md');
  fs.writeFileSync(sharedC, '# Shared\n\nBase.\n');
  const ud3 = path.join(work, 'ud3');
  app = await launch([sharedC, '--user-data-dir=' + ud3], { WHIMFLOW_TEST_CONFIRM: 'save' });
  const wA = await app.firstWindow();
  wA.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror A]', e.message); });
  await wA.waitForFunction((p) => window.__whimflow && window.__whimflow.state.filePath === p, sharedC, { timeout: 15000 });
  const nextWin = app.waitForEvent('window');
  await app.evaluate((_e, p) => { globalThis.__whimflowTest.createWindow({ files: [p] }); }, sharedC);
  const wB = await nextWin;
  wB.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror B]', e.message); });
  await wB.waitForFunction((p) => window.__whimflow && window.__whimflow.state.filePath === p, sharedC, { timeout: 15000 });
  await wB.waitForTimeout(400);
  const typeIn = async (w, text) => {
    await w.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await w.keyboard.type(text);
  };
  const stateOf = (w) => w.evaluate(() => { const D = window.__whimflow.ctx.docs, d = D.active(); return { path: d.filePath, text: D.textOf(d), dirty: d.dirty, conflict: !!d.conflict, n: D.list().length }; });
  const toastOf = (w) => w.locator('#toast').innerText();
  const hook = (patch) => app.evaluate((_e, p) => { for (const [k, v] of Object.entries(p)) Object.assign(globalThis.__whimflowTest[k], v); }, patch);

  await typeIn(wA, ' from window one');
  await typeIn(wB, ' from window two');
  await wA.keyboard.press(`${mod}+s`);
  await until(async () => !(await stateOf(wA)).dirty, 'window A saved');
  assert.strictEqual(read(sharedC), '# Shared\n\nBase.\n from window one');
  await wB.keyboard.press(`${mod}+s`);
  await until(async () => (await stateOf(wB)).conflict, 'window B told about the conflict', 5000);
  let b = await stateOf(wB);
  assert.strictEqual(read(sharedC), '# Shared\n\nBase.\n from window one', 'A’s text was not overwritten');
  assert(b.dirty && b.text.endsWith('Base.\n from window two'), 'B keeps its text, unsaved');
  assert(/未覆盖磁盘内容/.test(await toastOf(wB)) && !/^已保存$/.test(await toastOf(wB)), 'B says what happened, and not "Saved"');
  assert(/冲突/.test(await wB.locator('#title-state').innerText()), 'the title shows the conflict');
  await until(() => draftsIn(ud3).some((d) => d.content.endsWith('from window two') && d.filePath === sharedC), 'B’s draft is kept', 4000);
  // closing B (answer "save") cannot lose its text either: the conflict keeps it open
  await wB.evaluate(() => { window.__whimflow.run('close-doc'); });
  await sleep(800);
  b = await stateOf(wB);
  assert(b.n === 1 && b.dirty && b.text.endsWith('from window two'), 'B stayed open with its text');
  assert.strictEqual(read(sharedC), '# Shared\n\nBase.\n from window one');
  await wB.screenshot({ path: path.join(shots, 'safety-conflict.png') });
  // the user chooses to overwrite: an explicit command, replacing exactly the version reported
  await wB.evaluate(() => { window.__whimflow.run('conflict-overwrite'); });
  await until(async () => !(await stateOf(wB)).dirty, 'B overwritten on request');
  assert.strictEqual(read(sharedC), '# Shared\n\nBase.\n from window two');
  assert(!(await stateOf(wB)).conflict);
  // window A had nothing unsaved: it follows the file instead of showing stale text
  await until(async () => (await stateOf(wA)).text.endsWith('from window two'), 'A follows the file', 5000);
  assert(!(await stateOf(wA)).dirty);
  step('two windows, one file: the later save is a conflict (text, dirty state and draft kept); overwrite only on request');

  // ---------- 14. a change by another program, then a save ----------
  await typeIn(wA, ' A-edit');
  fs.writeFileSync(sharedC, 'EXTERNAL\n');
  await sleep(600); // the watcher's notice arrives; A has edits, so it keeps them
  assert((await stateOf(wA)).text.endsWith('A-edit'));
  await wA.keyboard.press(`${mod}+s`);
  await until(async () => (await stateOf(wA)).conflict, 'A told about the external change', 5000);
  assert.strictEqual(read(sharedC), 'EXTERNAL\n', 'the other program’s text was not overwritten');
  assert((await stateOf(wA)).dirty);
  // auto-save does not retry over it either
  await wA.evaluate(() => window.api.setSetting('autoSaveDelay', 1));
  await wA.evaluate(() => window.api.setSetting('autoSave', true));
  await typeIn(wA, '!');
  await sleep(1800);
  assert.strictEqual(read(sharedC), 'EXTERNAL\n', 'no auto-save over the conflict');
  await wA.evaluate(() => window.api.setSetting('autoSave', false));
  // reload from disk: the file's text, clean; undo brings the edits back (unsaved)
  await wA.evaluate(() => { window.__whimflow.run('conflict-reload'); });
  await until(async () => { const a = await stateOf(wA); return a.text === 'EXTERNAL\n' && !a.dirty && !a.conflict; }, 'A reloaded from disk');
  await wA.keyboard.press(`${mod}+z`);
  await until(async () => { const a = await stateOf(wA); return a.text.endsWith('A-edit!') && a.dirty; }, 'undo brings the edits back');
  await wA.evaluate(() => { window.__whimflow.run('conflict-reload'); });
  await until(async () => !(await stateOf(wA)).dirty, 'reloaded again');
  step('a change by another program blocks the save (and auto-save); reload is undoable');

  // ---------- 15. new files, consecutive saves and Save As still work ----------
  const fresh = path.join(confDir, 'fresh.md'), copyAs = path.join(confDir, 'copy.md'), target = path.join(confDir, 'target.md');
  await wA.evaluate(() => { window.__whimflow.run('new-doc'); });
  await until(async () => !(await stateOf(wA)).path, 'a new untitled document');
  await typeIn(wA, '# Fresh\n\nnew file');
  await hook({ answer: { saveDialog: fresh } });
  await wA.keyboard.press(`${mod}+s`);
  await until(async () => (await stateOf(wA)).path === fresh && !(await stateOf(wA)).dirty, 'the new file saved');
  assert.strictEqual(read(fresh), '# Fresh\n\nnew file');
  for (const more of [' one', ' two', ' three']) {
    await typeIn(wA, more);
    await wA.keyboard.press(`${mod}+s`);
    await until(async () => !(await stateOf(wA)).dirty, 'save' + more);
  }
  assert.strictEqual(read(fresh), '# Fresh\n\nnew file one two three', 'consecutive saves in one window');
  await hook({ answer: { saveDialog: copyAs } });
  await wA.keyboard.press(`${mod}+Shift+s`);
  await until(async () => (await stateOf(wA)).path === copyAs, 'Save As to a new file');
  assert.strictEqual(read(copyAs), read(fresh));
  await typeIn(wA, ' four');
  await wA.keyboard.press(`${mod}+s`);
  await until(async () => !(await stateOf(wA)).dirty, 'saving the copy');
  assert(read(copyAs).endsWith(' four') && !read(fresh).endsWith(' four'), 'later saves go to the copy');
  // Save As onto an existing file: replaces what was there when the dialog was confirmed…
  fs.writeFileSync(target, 'T0\n');
  await hook({ answer: { saveDialog: target } });
  await wA.evaluate(() => { window.__whimflow.run('save-as'); });
  await until(async () => (await stateOf(wA)).path === target, 'Save As over an existing file');
  assert(read(target).endsWith(' four'));
  // …but not a version that appeared after it
  await typeIn(wA, ' five');
  await hook({ delay: { 'save:write': 900 } });
  fs.writeFileSync(copyAs, 'C0\n');
  await hook({ answer: { saveDialog: copyAs } });
  await wA.evaluate(() => { window.__whimflow.run('save-as'); });
  await sleep(300);
  fs.writeFileSync(copyAs, 'C1 written meanwhile\n');
  await until(async () => (await stateOf(wA)).conflict, 'Save As target changed after the dialog', 5000);
  assert.strictEqual(read(copyAs), 'C1 written meanwhile\n', 'not overwritten');
  assert.strictEqual((await stateOf(wA)).path, target, 'the document still belongs to its own file');
  await hook({ delay: { 'save:write': 0 } });
  await wA.keyboard.press(`${mod}+s`);
  await until(async () => !(await stateOf(wA)).dirty, 'saving to its own file still works');
  assert(read(target).endsWith(' five'));
  assert.deepStrictEqual(errors, [], 'no page errors');
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  step('new file, consecutive saves, Save As (new and existing targets) still work; a target changed after the dialog is not overwritten');

  // ---------- 16. after the rename, settings and drafts from "MarkFlow" are still there ----------
  // (Linux only: there the app's folder follows XDG_CONFIG_HOME, so a temporary one can stand in;
  // elsewhere it would be the real user folder, which a test must not touch. test/unit.js covers the copy itself.)
  if (process.platform === 'linux') {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-xdg-'));
    const oldDir = path.join(xdg, 'MarkFlow');
    const keep = path.join(work, 'kept.md');
    fs.writeFileSync(keep, '# Kept\n');
    fs.mkdirSync(path.join(oldDir, 'drafts'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify({ theme: 'midnight', fontSize: 18 }));
    fs.writeFileSync(path.join(oldDir, 'drafts', 'old-d1.json'), JSON.stringify({ filePath: keep, content: '# Kept\n\nwritten before the rename\n', savedAt: Date.now() }));
    app = await launch([], { XDG_CONFIG_HOME: xdg });
    const w = await app.firstWindow();
    await w.waitForFunction(() => window.__whimflow && window.__whimflow.ctx.docs && window.__whimflow.ctx.docs.list().some((d) => d.dirty), null, { timeout: 15000 });
    assert.strictEqual(await w.evaluate(() => document.documentElement.dataset.theme), 'midnight', 'settings came along');
    assert(await w.evaluate(() => window.__whimflow.editor.getValue().includes('written before the rename')), 'the unsaved draft came back');
    assert(fs.existsSync(path.join(xdg, 'WhimFlow', 'settings.json')), 'copied into the new folder');
    assert(fs.existsSync(path.join(oldDir, 'drafts', 'old-d1.json')), 'the old folder is left as it was');
    const winTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    assert(/— WhimFlow$/.test(winTitle) && (await w.title()) === 'WhimFlow', 'the window is called WhimFlow: ' + winTitle);
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    step('renamed app: settings and unsaved drafts from the old folder are still there');
  }

  console.log('SAFETY OK  screenshots:', shots);
})().catch((e) => { console.error('SAFETY FAIL', e); process.exit(1); });
