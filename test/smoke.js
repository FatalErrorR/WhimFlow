// End-to-end test: launches the real Electron app and drives it like a user.
const { _electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const root = path.join(__dirname, '..');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'; // the app's "mod" key: ⌘ on macOS, Ctrl elsewhere
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');

const launch = (args, extraEnv = {}) => _electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: ['--no-sandbox', root, ...args],
  env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: process.env.WHIMFLOW_LANG || 'zh', ...extraEnv },
});

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.mkdirSync(path.join(work, 'notes'));
  fs.copyFileSync(path.join(root, 'docs/Markdown-Reference.md'), path.join(work, 'Reference.md'));
  fs.writeFileSync(path.join(work, 'notes/todo.md'), '# Todo\n\n- one\n- two\n');
  const errors = [];

  // ---- a blank window greets you ----
  {
    const blank = await launch(['--user-data-dir=' + path.join(work, 'ud0')]);
    const bp = await blank.firstWindow();
    bp.on('pageerror', (e) => errors.push(e.message));
    await bp.waitForSelector('#welcome.show');
    await bp.waitForTimeout(900);
    await bp.screenshot({ path: path.join(shots, '00-welcome.png') });
    await bp.keyboard.type('hello');
    await bp.waitForSelector('#welcome:not(.show)');
    await blank.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }

  const app = await launch([path.join(work, 'Reference.md'), '--user-data-dir=' + path.join(work, 'ud')], { WHIMFLOW_TEST_EXPORT: path.join(work, 'out') });
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message, String(e.stack).split('\n').slice(0, 6).join(' | ')); });
  await page.waitForSelector('body.ready');
  await page.waitForFunction(() => window.__whimflow.state.filePath);
  await page.waitForTimeout(1200);
  const run = (c, a) => page.evaluate(([c, a]) => window.__whimflow.run(c, a), [c, a]);
  const val = () => page.evaluate(() => window.__whimflow.editor.getValue());
  const caretAt = (needle, offset = 0) => page.evaluate(([n, o]) => {
    const v = window.__whimflow.editor.view, i = v.state.doc.toString().indexOf(n);
    if (i < 0) throw new Error('not found: ' + n);
    v.dispatch({ selection: { anchor: i + o }, scrollIntoView: true }); v.focus();
  }, [needle, offset]);
  const waitVal = (re, msg) => page.waitForFunction((src) => new RegExp(src).test(window.__whimflow.editor.getValue()), re.source, { timeout: 5000, polling: 100 })
    .catch(async () => { throw new Error(msg + '\n' + JSON.stringify((await val()).slice(0, 1500))); });

  // ---- loads and renders live ----
  const original = fs.readFileSync(path.join(work, 'Reference.md'), 'utf8');
  assert.strictEqual(await val(), original, 'document text is kept exactly as on disk');
  assert.strictEqual(await page.evaluate(() => window.__whimflow.state.dirty), false, 'not dirty after load');
  const count = (sel) => page.locator(sel).count();
  assert(await count('.cm-h1') === 1 && await count('.cm-h2') >= 1, 'headings styled');
  assert.strictEqual(await page.evaluate(() => window.__whimflow.editor.headings().length), 9, 'headings read from the syntax tree');
  assert(await count('.cm-block-toc') === 1, 'table of contents rendered');
  await caretAt('Simplicity', 0);
  await page.waitForTimeout(200);
  assert(await count('.cm-task') === 2, 'task checkboxes');
  assert(await count('.cm-bullet') >= 2, 'bullets');
  assert(await count('.cm-line[style*="text-indent"]') >= 4, 'list items have hanging indents');
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).textAutospace), 'normal', 'CJK/Latin spacing on');
  await page.evaluate(() => { const s = window.__whimflow.editor.view.scrollDOM; s.scrollTop = s.scrollHeight; });
  await page.waitForSelector('.cm-block-mermaid svg', { timeout: 15000 });
  assert(await count('.cm-block-math .katex') === 1 && await count('.cm-math .katex') >= 1, 'formulas rendered');
  await page.evaluate(() => { window.__whimflow.editor.view.scrollDOM.scrollTop = 0; });
  await page.waitForTimeout(300);

  await run('outline');
  assert(await count('.outline-item') >= 9, 'outline');
  await page.screenshot({ path: path.join(shots, '01-outline.png') });
  await run('files');
  assert(await count('.tree-item') >= 2, 'file tree');

  // ---- typing and formatting ----
  await caretAt('and edit its source.', 'and edit its source.'.length);
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('Typed paragraph');
  await page.keyboard.press(`${mod}+2`);
  await waitVal(/\n## Typed paragraph\n/, 'ctrl+2 makes a heading');
  await page.keyboard.press(`${mod}+0`);
  await waitVal(/\nTyped paragraph\n/, 'ctrl+0 back to paragraph');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('plain ');
  await page.keyboard.press(`${mod}+b`); await page.keyboard.type('bold');
  await waitVal(/plain \*\*bold\*\*/, 'ctrl+b bold');
  await page.keyboard.press(`${mod}+b`); // toggles bold off around the caret
  await waitVal(/plain bold\n/, 'ctrl+b again unwraps');
  await page.keyboard.press(`${mod}+z`);
  await waitVal(/plain \*\*bold\*\*/, 'undo restores bold');
  assert.strictEqual(await page.evaluate(() => window.__whimflow.state.dirty), true, 'dirty after edit');

  // ---- code blocks: shortcut → language completion → highlight → indent → exit ----
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.press(`${mod}+Shift+k`);
  await page.keyboard.type('py');
  await page.waitForFunction(() => { const e = document.querySelector('.cm-tooltip-autocomplete li[aria-selected] .cm-completionLabel'); return e && e.textContent === 'python'; }, null, { timeout: 5000 });
  await page.screenshot({ path: path.join(shots, '02-lang.png') });
  await page.keyboard.press('Enter');
  await page.keyboard.type('def greet(name):');
  await page.keyboard.press('Enter');
  await page.keyboard.type('return "hi " + name  # comment');
  await waitVal(/```python\ndef greet\(name\):\n {4}return "hi " \+ name {2}# comment\n```/, 'code block with auto-indent');
  await page.waitForTimeout(300);
  for (const tok of ['keyword', 'string', 'comment', 'title']) assert(await count(`.cm-cb .tok-${tok}`) > 0, 'python highlighted: ' + tok);
  await page.screenshot({ path: path.join(shots, '03-code-edit.png') });
  await page.keyboard.press(`${mod}+Enter`);
  await page.keyboard.type('after code');
  await waitVal(/```\n\nafter code/, 'ctrl+enter leaves the block');
  await page.waitForTimeout(300);
  assert(await page.locator('.cm-cb-header .cm-cb-lang', { hasText: 'python' }).count() === 1, 'the block, once left, shows its language tag');
  await page.screenshot({ path: path.join(shots, '04-code-view.png') });

  // ---- tables: Tab moves between cells and re-aligns ----
  await caretAt('| **Strong**', 4);
  await page.waitForTimeout(200);
  assert(await count('.cm-table-src') >= 3, 'table shows its source while the caret is in it');
  await page.keyboard.press('Tab');
  const tbl = await page.evaluate(() => { const v = window.__whimflow.editor.view; const d = v.state.doc.toString(); const a = d.indexOf('| Style'); return d.slice(a, d.indexOf('\n\n', a)); });
  const lens = tbl.split('\n').map((l) => l.length);
  assert(lens.every((l) => l === lens[0]), 'table re-aligned on Tab');
  assert(await page.evaluate(() => { const v = window.__whimflow.editor.view, h = v.state.selection.main.head, l = v.state.doc.lineAt(h); return l.text.slice(0, h - l.from).trimEnd().endsWith('`**text**`'); }), 'Tab moved to the next cell');
  await page.screenshot({ path: path.join(shots, '05-table-edit.png') });
  await page.keyboard.press(`${mod}+z`);

  // ---- islands ----
  assert.strictEqual(await page.evaluate(() => document.body.dataset.island), 'main', 'editor island raised');
  assert(await count('.cm-island') === 1, 'block island drawn');
  await page.mouse.click(120, 520);
  await page.waitForFunction(() => ['files', 'outline'].includes(document.body.dataset.island));
  await page.waitForFunction(() => getComputedStyle(document.querySelector(`.side-card[data-island="${document.body.dataset.island}"]`)).boxShadow !== 'none' && getComputedStyle(document.querySelector('#main')).boxShadow === 'none', null, { timeout: 5000 });
  assert.strictEqual(await page.evaluate(() => [...document.querySelectorAll('.side-card')].filter((c) => getComputedStyle(c).boxShadow !== 'none').length), 1, 'only the clicked side island is raised');
  assert(await count('.cm-island') === 0, 'block island hides when the editor is not raised');
  await page.screenshot({ path: path.join(shots, '06-island-side.png') });
  await page.mouse.click(700, 300);
  await page.waitForFunction(() => document.body.dataset.island === 'main');

  // ---- find / replace (and undo it) ----
  await page.keyboard.press(`${mod}+f`);
  await page.fill('#find-input', 'item');
  await page.waitForFunction(() => /^\d+ \/ 3$/.test(document.querySelector('#find-count').textContent));
  assert(await count('.cm-find') >= 1, 'matches highlighted');
  await run('replace');
  await page.fill('#find-input', 'Typed paragraph');
  await page.fill('#replace-input', 'Replaced para');
  await page.click('#replace-all');
  await waitVal(/Replaced para/, 'replace all');
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${mod}+z`);
  await waitVal(/Typed paragraph/, 'replace all is one undo step');
  await page.keyboard.press(`${mod}+Shift+z`);
  await waitVal(/Replaced para/, 'redo');

  // ---- save ----
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => !window.__whimflow.state.dirty);
  assert(fs.readFileSync(path.join(work, 'Reference.md'), 'utf8').includes('Replaced para'), 'saved to disk');

  // ---- source mode keeps text, history and caret ----
  const before = await val();
  await run('source');
  await page.waitForSelector('.cm-source');
  assert.strictEqual(await val(), before, 'source mode keeps text');
  assert(await count('.cm-h1') === 0, 'source mode shows plain Markdown');
  await page.screenshot({ path: path.join(shots, '07-source.png') });
  await run('source');
  await page.waitForSelector('.cm-live');

  // ---- images ----
  await caretAt('Replaced para', 'Replaced para'.length);
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const src = await window.api.saveImage({ name: 'pic.png', data: await blob.arrayBuffer() });
    window.__whimflow.editor.run('image', src);
  });
  await waitVal(/!\[\]\(assets\/pic\.png\)/, 'relative image path kept in Markdown');
  assert(fs.existsSync(path.join(work, 'assets/pic.png')), 'image saved next to the document');
  await caretAt('# Markdown Reference', 0);
  await page.waitForFunction(() => { const i = document.querySelector('.cm-image img'); return i && i.complete && i.naturalWidth === 8; }, null, { timeout: 5000 });

  // ---- mind map: view, navigate, edit, undo ----
  await run('mindmap');
  await page.waitForSelector('.mm-node');
  assert(await count('.mm-node') >= 9, 'mind map nodes');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(shots, '08-mindmap.png') });
  await page.locator('.mm-node', { hasText: 'Diagram' }).click();
  await page.waitForTimeout(900);
  assert(await page.evaluate(() => window.__whimflow.editor.view.scrollDOM.scrollTop > 300), 'clicking a node scrolls the editor');
  await page.locator('.mm-node', { hasText: 'Quote' }).dblclick();
  await page.waitForSelector('#mm-rename:not([hidden])');
  await page.fill('#mm-rename', 'Quotation');
  await page.keyboard.press('Enter');
  await waitVal(/\n## Quotation\n/, 'rename from the map');
  await page.locator('.mm-node', { hasText: 'Lists' }).click();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#mm-rename:not([hidden])');
  await page.fill('#mm-rename', 'Extra');
  await page.keyboard.press('Enter');
  await waitVal(/Open task\n\n## Extra\n\n## Quotation/, 'add a sibling from the map');
  await page.waitForTimeout(400);
  const bb = async (name) => page.locator('.mm-node', { hasText: name }).first().boundingBox();
  const m1 = await bb('Math'), c1 = await bb('Code');
  await page.mouse.move(m1.x + m1.width / 2, m1.y + m1.height / 2);
  await page.mouse.down();
  await page.mouse.move(m1.x + m1.width / 2 + 10, m1.y - 10, { steps: 4 });
  await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2, { steps: 8 });
  await page.screenshot({ path: path.join(shots, '09-mm-drag.png') });
  await page.mouse.up();
  await waitVal(/```\n\n### Math\n[\s\S]*\$\$[\s\S]*## Diagram/, 'drag a section under another');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, '10-mm-edited.png') });
  await page.keyboard.press(`${mod}+z`);
  await waitVal(/\n## Math\n/, 'map edits undo like any other edit');
  await page.keyboard.press(`${mod}+Shift+z`);
  await waitVal(/\n### Math\n/, 'and redo');

  // ---- final view ----
  await run('preview');
  await page.waitForSelector('#preview-doc .katex', { timeout: 10000 });
  await page.waitForSelector('#preview-doc .mermaid-block svg', { timeout: 15000 });
  await page.evaluate(() => { const s = window.__whimflow.editor.view.scrollDOM; s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(600);
  assert(await page.evaluate(() => document.querySelector('#preview').scrollTop > 200), 'final view follows the editor');
  await page.screenshot({ path: path.join(shots, '11-preview.png') });

  // ---- palette ----
  await run('palette');
  await page.fill('#palette-input', 'mid');
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(shots, '12-palette.png') });
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.querySelector('#palette').hidden), 'palette closes');

  // ---- themes ----
  await page.evaluate(() => window.api.setSetting('theme', 'midnight'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight');
  await run('mindmap');
  await caretAt('function greet', 0);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, '13-midnight.png') });
  await page.evaluate(() => window.api.setSetting('theme', 'daylight'));
  await run('focus');
  await caretAt('Simplicity', 0);
  await page.waitForTimeout(300);
  assert(await count('.cm-dim') > 3, 'focus mode dims other blocks');
  await page.screenshot({ path: path.join(shots, '14-focus.png') });
  await run('focus');

  // ---- export ----
  await run('export', 'html');
  await page.waitForFunction(() => /已导出|Exported/.test(document.querySelector('#toast').textContent), null, { timeout: 30000 });
  const html = fs.readFileSync(path.join(work, 'out.html'), 'utf8');
  assert(html.includes('class="katex') && html.includes('<svg') && html.includes('hljs-'), 'html export rendered');
  assert(!html.includes('data-line'), 'exports carry no editor bookkeeping');
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await run('export', 'pdf');
  await page.waitForFunction(() => /已导出|Exported/.test(document.querySelector('#toast').textContent), null, { timeout: 30000 });
  const pdf = fs.readFileSync(path.join(work, 'out.pdf'));
  assert(pdf.slice(0, 4).toString() === '%PDF' && pdf.length > 20000, 'pdf export');
  fs.copyFileSync(path.join(work, 'out.pdf'), path.join(shots, 'export.pdf'));
  fs.copyFileSync(path.join(work, 'out.html'), path.join(shots, 'export.html'));

  // ---- rearranging islands ----
  await run('mindmap'); // close the right panel
  await run('files');
  await page.waitForTimeout(300);
  const leftOf = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().left, sel);
  if (!(await page.evaluate(() => document.body.classList.contains('sidebar-open')))) await run('files');
  assert(await leftOf('#sidebar') < await leftOf('#main'), 'sidebar starts on the left');
  const g = await page.locator('#sidebar > .island-grip').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 420, g.y + g.height / 2 + 4, { steps: 16 });
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(shots, '15-drag.png') });
  await page.mouse.up();
  await page.waitForTimeout(500);
  assert(await leftOf('#sidebar') > await leftOf('#main'), 'sidebar dragged right of the editor');
  await page.evaluate(() => { document.body.dataset.island = 'side'; });
  await run('island-move', -1);
  await page.waitForTimeout(500);
  assert(await leftOf('#sidebar') < await leftOf('#main'), 'moved back by command');

  // ---- open another file from the tree ----
  await run('save');
  await page.waitForFunction(() => !window.__whimflow.state.dirty);
  await page.click('.tree-item:has-text("notes")');
  await page.click('.tree-item:has-text("todo")');
  await page.waitForFunction(() => /todo\.md$/.test(window.__whimflow.state.filePath || ''));
  assert((await val()).startsWith('# Todo'), 'opened from the tree');
  await page.screenshot({ path: path.join(shots, '16-tree-open.png') });

  assert.deepStrictEqual(errors, [], 'no uncaught page errors');
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  console.log('SMOKE OK  screenshots:', shots);
})().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
