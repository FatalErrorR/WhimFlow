// End-to-end test for several documents in one window: preview vs pinned, the
// title switcher, ⌃Tab, per-document undo history, closing, crash recovery.
const { _electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const root = path.join(__dirname, '..');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'; // the app's "mod" key: ⌘ on macOS, Ctrl elsewhere
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');

const launch = (args, extraEnv = {}) => _electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: ['--no-sandbox', root, ...args],
  env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh', WHIMFLOW_TEST_CONFIRM: 'discard', ...extraEnv },
});

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-docs-'));
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(work, n + '.md'), `# ${n.toUpperCase()}\n\nText of ${n}.\n`);
  const ud = path.join(work, '.ud');
  const errors = [];
  const step = (name) => console.log('  ✓', name);

  let app = await launch([path.join(work, 'a.md'), '--user-data-dir=' + ud]);
  let page = await app.firstWindow();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await page.waitForFunction(() => window.__whimflow && /a\.md$/.test(window.__whimflow.state.filePath || ''));
  await page.waitForTimeout(600);
  const run = (c, a) => page.evaluate(([c, a]) => { window.__whimflow.run(c, a); }, [c, a]);
  const val = () => page.evaluate(() => window.__whimflow.editor.getValue());
  const info = () => page.evaluate(() => { const d = window.__whimflow.ctx.docs; return { n: d.list().length, active: d.name(), names: d.list().map((x) => d.name(x) + (x.preview ? '?' : '') + (x.dirty ? '*' : '')) }; });
  const activeIs = (name) => page.waitForFunction((n) => window.__whimflow.ctx.docs.name() === n, name, { timeout: 5000 });
  const count = (s) => page.locator(s).count();
  const typeAtEnd = async (text) => {
    await page.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await page.keyboard.type(text);
  };

  // ---- one document: nothing extra on screen ----
  assert.strictEqual(await count('.doc-dot'), 0, 'a single document shows no switcher');
  assert(!(await page.evaluate(() => document.body.classList.contains('multi-doc'))), 'not in multi-document state');
  step('single document looks as before');

  // ---- single click previews, the next click replaces the preview ----
  await run('files');
  await page.click('.tree-item:has-text("b")');
  await activeIs('b.md');
  assert.deepStrictEqual((await info()).names, ['a.md', 'b.md?'], 'b opens as a preview');
  assert.strictEqual(await count('#doc-dots .doc-dot'), 2, 'a dot per document');
  assert.strictEqual(await count('#doc-dots .doc-dot.preview'), 1, 'the preview is marked');
  await page.click('.tree-item:has-text("c")');
  await activeIs('c.md');
  assert.deepStrictEqual((await info()).names, ['a.md', 'c.md?'], 'c replaces the preview instead of piling up');
  // ---- double click keeps it ----
  await page.dblclick('.tree-item:has-text("d")');
  await activeIs('d.md');
  await page.waitForFunction(() => !window.__whimflow.ctx.docs.active().preview);
  assert.deepStrictEqual((await info()).names, ['a.md', 'd.md'], 'double click pins the document');
  await page.click('.tree-item:has-text("c")');
  await activeIs('c.md');
  assert.deepStrictEqual((await info()).names, ['a.md', 'd.md', 'c.md?'], 'a new preview next to the pinned ones');
  step('preview on click, pin on double click');

  // ---- editing pins a preview; each document has its own text, caret and undo history ----
  await typeAtEnd('C-edit');
  await page.waitForFunction(() => window.__whimflow.state.dirty);
  assert.deepStrictEqual((await info()).names, ['a.md', 'd.md', 'c.md*'], 'editing pins it and marks it unsaved');
  await page.locator('#doc-dots .doc-dot').first().click();
  await activeIs('a.md');
  assert((await val()).startsWith('# A'), 'a shows its own text');
  await typeAtEnd('A-edit');
  await page.locator('#doc-dots .doc-dot').nth(2).click();
  await activeIs('c.md');
  assert((await val()).endsWith('C-edit'), 'c kept its edit while away');
  await page.keyboard.press(`${mod}+z`);
  await page.waitForFunction(() => !window.__whimflow.editor.getValue().includes('C-edit'));
  await page.locator('#doc-dots .doc-dot').first().click();
  await activeIs('a.md');
  assert((await val()).endsWith('A-edit'), 'undo in c did not touch a');
  assert.strictEqual(await count('#doc-dots .doc-dot.dirty'), 2, 'unsaved documents are marked on their dots');
  step('independent text and undo history');

  // ---- the title lists the documents on hover ----
  await page.hover('#doc-switch');
  await page.waitForSelector('#doc-list:not([hidden]) .doc-row');
  assert.strictEqual(await count('#doc-list .doc-row'), 3, 'all documents listed');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shots, 'd01-title-list.png') });
  await page.locator('#doc-list .doc-row', { hasText: 'd' }).click();
  await activeIs('d.md');
  assert(await page.evaluate(() => document.querySelector('#doc-list').hidden), 'list closes after choosing');
  step('title switcher');

  // ---- ⌃Tab cycles in most-recently-used order ----
  await page.keyboard.down('Control');
  await page.keyboard.press('Tab');
  await page.waitForSelector('#doc-cycle:not([hidden]) .doc-row.on');
  assert.strictEqual(await page.locator('#doc-cycle .doc-row.on .name').textContent(), 'a', 'the previous document is preselected');
  await page.screenshot({ path: path.join(shots, 'd02-ctrl-tab.png') });
  await page.keyboard.press('Tab');
  assert.strictEqual(await page.locator('#doc-cycle .doc-row.on .name').textContent(), 'c', 'Tab again moves on');
  await page.keyboard.up('Control');
  await activeIs('c.md');
  assert(await page.evaluate(() => document.querySelector('#doc-cycle').hidden), 'switcher gone on release');
  step('⌃Tab');

  // ---- the tree marks what is open; the palette lists open documents first ----
  assert.strictEqual(await count('.tree-item.opened'), 3, 'open files marked in the tree');
  await page.screenshot({ path: path.join(shots, 'd03-tree-and-dots.png') });
  await run('palette');
  await page.waitForSelector('.palette-item');
  assert.deepStrictEqual(await page.locator('.palette-item .hint').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['已打开', '已打开'], 'open documents first in the palette');
  await page.keyboard.press('Escape');
  step('tree markers and palette');

  // ---- saving is per document; a change on disk reaches a background document ----
  await page.locator('#doc-dots .doc-dot').first().click();
  await activeIs('a.md');
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => !window.__whimflow.state.dirty);
  assert(fs.readFileSync(path.join(work, 'a.md'), 'utf8').endsWith('A-edit'), 'a saved');
  assert(!fs.readFileSync(path.join(work, 'c.md'), 'utf8').includes('C-edit'), 'c untouched');
  await page.waitForTimeout(1700); // let the "own write" window pass
  fs.writeFileSync(path.join(work, 'd.md'), '# D\n\nChanged on disk.\n');
  await page.waitForTimeout(900);
  await page.locator('#doc-dots .doc-dot').nth(1).click();
  await activeIs('d.md');
  await page.waitForFunction(() => window.__whimflow.editor.getValue().includes('Changed on disk.'), null, { timeout: 5000 });
  step('per-document save, external changes');

  // ---- new and close ----
  await page.keyboard.press(`${mod}+n`);
  await page.waitForFunction(() => window.__whimflow.ctx.docs.list().length === 4);
  await page.waitForSelector('#welcome.show');
  await page.keyboard.press(`${mod}+w`);
  await page.waitForFunction(() => window.__whimflow.ctx.docs.list().length === 3);
  await page.hover('#doc-switch');
  await page.waitForSelector('#doc-list:not([hidden]) .doc-row');
  await page.locator('#doc-list .doc-row', { hasText: 'd' }).hover();
  await page.locator('#doc-list .doc-row', { hasText: 'd' }).locator('.x').click();
  await page.waitForFunction(() => window.__whimflow.ctx.docs.list().length === 2);
  assert.deepStrictEqual((await info()).names.map((n) => n.replace(/[*?]/g, '')), ['a.md', 'c.md'], 'd closed from the list');
  step('new and close');

  // ---- crash with two unsaved documents: both come back, in one window ----
  await page.evaluate(() => { const d = window.__whimflow.ctx.docs; d.activate(d.byPath(d.list()[1].filePath)); });
  await activeIs('c.md');
  await typeAtEnd(' unsaved-C');
  await page.locator('#doc-dots .doc-dot').first().click();
  await activeIs('a.md');
  await typeAtEnd(' unsaved-A');
  await page.waitForTimeout(2200);
  assert.strictEqual(fs.readdirSync(path.join(ud, 'drafts')).filter((n) => n.endsWith('.json')).length, 2, 'a draft per unsaved document');
  assert.deepStrictEqual(errors, [], 'no uncaught page errors');
  app.process().kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  app = await launch(['--user-data-dir=' + ud]);
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__whimflow && window.__whimflow.ctx.docs.list().length === 2, null, { timeout: 15000 });
  const back = await page.evaluate(() => window.__whimflow.ctx.docs.list().map((d) => [window.__whimflow.ctx.docs.name(d), d.dirty, window.__whimflow.ctx.docs.textOf(d).slice(-10)]).sort());
  assert.deepStrictEqual(back, [['a.md', true, ' unsaved-A'], ['c.md', true, ' unsaved-C']], 'both recovered, unsaved, in one window');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'd04-recovered.png') });
  // closing an unsaved document asks first (the test answers "don't save"); closing the last one closes the window
  await page.keyboard.press(`${mod}+w`);
  await page.waitForFunction(() => window.__whimflow.ctx.docs.list().length === 1);
  assert.strictEqual(await page.locator('.doc-dot').count(), 0, 'back to one document: the switcher is gone');
  step('crash recovery of several documents');

  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  console.log('DOCS OK  screenshots:', shots);
})().catch((e) => { console.error('DOCS FAIL', e); process.exit(1); });
