// End-to-end tests for: editable tables, images, crash recovery & history,
// export to Word/PNG, folder search, settings, footnotes & YAML front matter.
const { _electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'; // the app's "mod" key: ⌘ on macOS, Ctrl elsewhere
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');

const launch = (args, extraEnv = {}) => _electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: ['--no-sandbox', root, ...args],
  env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh', ...extraEnv },
});

const DOC = `---
title: 季度计划
tags:
  - work
  - plan
---

# Plan

Intro paragraph with a note.[^a]

| Name | Owner | Due |
| --- | --- | --- |
| Alpha | Ann | Mon |
| Beta | Bob | Tue |

![pic](assets/pic.png)

Closing words.

[^a]: The first note.
`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-feat-'));
  fs.mkdirSync(path.join(work, 'notes'));
  fs.mkdirSync(path.join(work, 'assets'));
  fs.writeFileSync(path.join(work, 'doc.md'), DOC);
  fs.writeFileSync(path.join(work, 'notes/a.md'), '# A\n\nnothing here\n');
  fs.writeFileSync(path.join(work, 'notes/b.md'), '# B\n\nfirst line\nthe needle is here\nand another needle\n');
  // a real 40x30 PNG
  const png = (w, h) => {
    const { deflateSync } = require('zlib');
    const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 201; raw[i + 1] = 100; raw[i + 2] = 66; }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  fs.writeFileSync(path.join(work, 'assets/pic.png'), png(400, 300));
  const ud = path.join(work, '.ud');
  const errors = [];

  const app = await launch([path.join(work, 'doc.md'), '--user-data-dir=' + ud], { WHIMFLOW_TEST_EXPORT: path.join(work, 'out') });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });
  page.on('requestfailed', (r) => console.log('[requestfailed]', r.url().slice(0, 200)));
  await page.waitForSelector('body.ready');
  await page.waitForFunction(() => window.__whimflow.state.filePath);
  await page.waitForTimeout(800);
  const run = (c, a) => page.evaluate(([c, a]) => window.__whimflow.run(c, a), [c, a]);
  const val = () => page.evaluate(() => window.__whimflow.editor.getValue());
  const count = (s) => page.locator(s).count();
  const waitVal = (re, msg) => page.waitForFunction((src) => new RegExp(src).test(window.__whimflow.editor.getValue()), re.source, { timeout: 6000, polling: 100 })
    .catch(async () => { throw new Error(msg + '\n' + JSON.stringify(await val())); });
  const caretAt = (needle, offset = 0) => page.evaluate(([n, o]) => {
    const v = window.__whimflow.editor.view, i = v.state.doc.toString().indexOf(n);
    v.dispatch({ selection: { anchor: i + o }, scrollIntoView: true }); v.focus();
  }, [needle, offset]);
  const step = (name) => console.log('  ✓', name);

  // ---- YAML front matter ----
  assert(await count('.cm-frontmatter') === 1, 'front matter drawn as a card');
  assert(await page.locator('.cm-frontmatter').textContent().then((s) => s.includes('季度计划') && s.includes('work, plan')), 'card lists the properties');
  assert.deepStrictEqual(await page.evaluate(() => window.__whimflow.editor.headings().map((h) => h.text)), ['Plan'], 'front matter is not mistaken for a heading');
  await caretAt('title:', 2);
  await page.waitForTimeout(150);
  assert(await count('.cm-fm-src') >= 5, 'caret inside shows the YAML source');
  step('YAML front matter');

  // ---- footnotes ----
  await caretAt('Closing words.', 0);
  await page.waitForTimeout(150);
  assert.strictEqual(await page.locator('.cm-fn-ref').first().textContent(), '1', 'reference shown as a number');
  assert(await page.locator('.cm-fn-ref').first().getAttribute('data-tip') === 'The first note.', 'reference shows its note on hover');
  assert(await count('.cm-fn-badge') === 1, 'definition shows a badge');
  await caretAt('Closing words', 'Closing words'.length);
  await page.keyboard.press(`${mod}+Alt+r`);
  await page.keyboard.type('Second note.');
  await waitVal(/Closing words\[\^1\]\.\n\n\[\^a\]: The first note\.\n\[\^1\]: Second note\./, 'insert a footnote');
  await caretAt('Intro', 0);
  await page.waitForTimeout(200);
  assert.deepStrictEqual(await page.locator('.cm-fn-ref').allTextContents(), ['1', '2'], 'footnotes numbered in order');
  await page.screenshot({ path: path.join(shots, 'f01-footnotes.png') });
  step('footnotes');

  // ---- editable table ----
  assert(await count('.cm-table-widget') === 1, 'table drawn as an editable grid');
  await page.screenshot({ path: path.join(shots, 'f02-table.png') });
  await page.locator('.mf-cell', { hasText: 'Alpha' }).click();
  await page.keyboard.type(' One');
  await waitVal(/\| Alpha One \| Ann {3}\| Mon \|/, 'typing in a cell writes the table, re-aligned');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await page.keyboard.press('Tab'); // past the last cell → new row
  await page.keyboard.type('Gamma');
  await waitVal(/\| Gamma {5}\| +\| +\|\n/, 'Tab past the last cell adds a row');
  await page.locator('.mf-cell', { hasText: 'Owner' }).click({ button: 'right' });
  await page.waitForSelector('#ctxmenu');
  await page.screenshot({ path: path.join(shots, 'f03-table-menu.png') });
  await page.locator('#ctxmenu .item', { hasText: '在右侧插入列' }).click();
  await waitVal(/\| Name +\| Owner \| +\| Due \|/, 'insert a column from the menu');
  await page.locator('.mf-cell', { hasText: 'Due' }).click({ button: 'right' });
  await page.locator('#ctxmenu .item', { hasText: '居中' }).click();
  await waitVal(/\| -+ \| -+ \| -+ \| :-+: \|/, 'centre a column');
  // drag the "Beta" row above "Alpha One"
  await page.locator('.mf-cell', { hasText: 'Beta' }).hover();
  const grip = await page.locator('.mf-grip-row').boundingBox();
  const alpha = await page.locator('.mf-cell', { hasText: 'Alpha' }).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 4, alpha.y + 2, { steps: 8 });
  await page.screenshot({ path: path.join(shots, 'f04-table-drag.png') });
  await page.mouse.up();
  await waitVal(/\| Beta [^\n]*\n\| Alpha One/, 'drag a row to reorder');
  await page.locator('.mf-cell', { hasText: 'Ann' }).click();
  await page.keyboard.press(`${mod}+z`);
  await waitVal(/\| Alpha One[^\n]*\n\| Beta/, 'undo restores the order');
  assert(/\| :-+: \|\n/.test(await val()) && /\| Owner \| +\| Due/.test(await val()), 'only the move was undone (column and alignment stay)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => window.__whimflow.editor.hasFocus()), 'Escape returns to the text');
  // a click beside the table lands in a cell and keeps it a table
  const tb = await page.locator('.mf-table').boundingBox();
  await page.mouse.click(tb.x + tb.width + 60, tb.y + tb.height - 8);
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('mf-cell'));
  assert(await count('.cm-table-widget') === 1 && await count('.cm-table-src') === 0, 'still drawn as a table');
  await page.keyboard.press('Escape');
  step('editable tables');

  // ---- images: size, alignment, corner drag ----
  await caretAt('Closing words', 0);
  await page.waitForSelector('.cm-image:not(.preview) img');
  await page.waitForFunction(() => document.querySelector('.cm-image img').naturalWidth === 400);
  await page.locator('.cm-image').hover();
  await page.waitForSelector('.cm-img-bar', { state: 'visible' });
  await page.screenshot({ path: path.join(shots, 'f05-image-bar.png') });
  await page.locator('.cm-img-bar button', { hasText: '50%' }).click();
  await waitVal(/<img src="assets\/pic\.png" alt="pic" width="50%">/, 'resize to 50%');
  await page.locator('.cm-image').hover();
  await page.locator('.cm-img-bar button', { hasText: '↔' }).click();
  await waitVal(/<img src="assets\/pic\.png" alt="pic" width="50%" style="display:block;margin:0 auto">/, 'centre the image');
  await page.waitForTimeout(200);
  const box = await page.locator('.cm-image-frame').boundingBox();
  const line = await page.evaluate(() => document.querySelector('.cm-line').getBoundingClientRect().width);
  assert(Math.abs(box.width - line * 0.5) < 4, 'drawn at half width');
  await page.locator('.cm-image').hover();
  const h = await page.locator('.cm-img-handle').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + line * 0.2, h.y + h.height / 2, { steps: 6 });
  await page.screenshot({ path: path.join(shots, 'f06-image-resize.png') });
  await page.mouse.up();
  await waitVal(/width="7\d%"/, 'drag the corner to resize');
  await page.locator('.cm-image').hover();
  await page.locator('.cm-img-bar button', { hasText: '100%' }).click();
  await page.locator('.cm-image').hover();
  await page.locator('.cm-img-bar button', { hasText: '↔' }).click();
  await waitVal(/\n!\[pic\]\(assets\/pic\.png\)\n/, 'back to plain Markdown at 100%, no alignment');
  await run('preview');
  await page.waitForFunction(() => { const i = document.querySelector('#preview-doc img'); return i && i.naturalWidth === 400; }, null, { timeout: 8000 });
  await run('preview');
  step('images');

  // ---- settings ----
  await run('settings');
  await page.waitForSelector('#settings:not([hidden]) .set-row');
  await page.screenshot({ path: path.join(shots, 'f07-settings.png') });
  await page.locator('.set-row', { hasText: '字号' }).locator('input[type=range]').fill('20');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.cm-scroller')).fontSize === '20px');
  await page.locator('.set-row', { hasText: '图片文件夹' }).locator('.chips button', { hasText: '${filename}' }).click();
  await page.locator('.set-row', { hasText: '自动配对' }).locator('.switch').click();
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.querySelector('#settings').hidden), 'settings close');
  const saved = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
  assert(saved.fontSize === 20 && saved.imageFolder === './${filename}.assets' && saved.closeBrackets === false, 'settings persisted');
  await caretAt('Closing words[^1].', 'Closing words[^1].'.length);
  await page.keyboard.type(' (x');
  await waitVal(/Closing words\[\^1\]\. \(x\n/, 'closing brackets turned off');
  const link = await page.evaluate(async () => window.api.saveImage({ name: 'shot.png', data: new Uint8Array([137, 80, 78, 71]).buffer }));
  assert.strictEqual(link, 'doc.assets/shot.png', 'image folder setting used');
  assert(fs.existsSync(path.join(work, 'doc.assets/shot.png')), 'image saved into doc.assets');
  await page.evaluate(() => window.api.setSetting('fontSize', 17));
  step('settings');

  // ---- history (open snapshot + saves) ----
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => !window.__whimflow.state.dirty);
  await caretAt('Intro', 0);
  await page.keyboard.type('Edited. ');
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => !window.__whimflow.state.dirty);
  await run('history');
  await page.waitForSelector('.hist-item');
  assert(await count('.hist-item') >= 3, 'a version per save, plus the one opened');
  await page.screenshot({ path: path.join(shots, 'f08-history.png') });
  await page.locator('.hist-item').last().click();
  await page.waitForSelector('.hist-diff .dl.add');
  await page.screenshot({ path: path.join(shots, 'f09-history-diff.png') });
  await page.locator('.hist-bar button.primary').click();
  await waitVal(/^---\ntitle: 季度计划[\s\S]*\| Alpha \| Ann \| Mon \|/, 'restore the original version');
  assert.strictEqual(await val(), DOC, 'restored text is exactly the original');
  await page.keyboard.press(`${mod}+z`);
  await waitVal(/Edited\. Intro/, 'restoring is one undo step');
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => !window.__whimflow.state.dirty);
  step('version history');

  // ---- search in folder ----
  await run('search');
  await page.fill('#search-input', 'needle');
  await page.waitForSelector('.hit');
  assert.strictEqual(await count('.hit'), 2, 'two matches');
  assert(await page.locator('#search-status').textContent().then((s) => s.includes('1 个文件')), 'status');
  await page.screenshot({ path: path.join(shots, 'f10-search.png') });
  await page.locator('.hit').nth(1).click();
  await page.waitForFunction(() => /b\.md$/.test(window.__whimflow.state.filePath || ''));
  await page.waitForTimeout(200);
  assert.strictEqual(await page.evaluate(() => window.__whimflow.editor.selectionText()), 'needle', 'opened at the match, selected');
  assert.strictEqual(await page.evaluate(() => window.__whimflow.editor.view.state.doc.lineAt(window.__whimflow.editor.view.state.selection.main.head).number), 5, 'on the right line');
  step('search in folder');

  // ---- invisible characters, split mode, Windows line endings ----
  fs.writeFileSync(path.join(work, 'crlf.md'), '# Win\r\n\r\nfirst  line\twith tab\r\n全角\u3000空格\r\n');
  await page.evaluate((p) => window.api.openInWindow(p), path.join(work, 'crlf.md'));
  await page.waitForFunction(() => /crlf\.md$/.test(window.__whimflow.state.filePath || ''));
  assert.strictEqual(await count('.cm-eol'), 0, 'invisible characters are off by default');
  await page.keyboard.press(`${mod}+Shift+.`);
  await page.waitForSelector('.cm-eol');
  assert.strictEqual(await count('.cm-eol'), 4, 'a mark at every line break');
  assert(await count('.cm-highlightSpace') >= 3 && await count('.cm-highlightTab') === 1, 'spaces and the tab are marked');
  assert.strictEqual(await count('.cm-ws-wide'), 1, 'the full-width space is pointed out');
  await run('split');
  await page.waitForSelector('.cm-source');
  await page.waitForSelector('#preview-doc h1');
  assert(await page.evaluate(() => document.body.classList.contains('right-open') && document.body.dataset.rtab === 'preview'), 'split: source left, result right');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'f12-split-invisibles.png') });
  assert(await count('.cm-lineNumbers .cm-gutterElement') >= 4, 'source mode shows line numbers');
  assert.deepStrictEqual(await page.locator('#preview-doc [data-line]').evaluateAll((els) => els.map((e) => e.tagName + e.dataset.line)), ['H11', 'P3'], 'rendered blocks know their source line');
  await page.locator('#preview-doc p').last().click();
  await page.waitForFunction(() => window.__whimflow.editor.caretLine() === 3);
  await page.waitForFunction(() => document.querySelector('#preview-doc p:last-of-type').classList.contains('here'));
  assert.strictEqual(await count('#preview-doc .here'), 1, 'the block holding the caret is marked in the final view');
  await page.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
  await page.keyboard.type('added');
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => !window.__whimflow.state.dirty);
  assert.strictEqual(fs.readFileSync(path.join(work, 'crlf.md'), 'utf8'), '# Win\r\n\r\nfirst  line\twith tab\r\n全角\u3000空格\r\nadded', 'Windows line endings are written back unchanged');
  await run('split');
  await page.waitForSelector('.cm-live');
  await page.screenshot({ path: path.join(shots, 'f13-live-invisibles.png') });
  await page.keyboard.press(`${mod}+Shift+.`);
  await page.waitForFunction(() => !document.querySelector('.cm-eol'));
  // a long document: the two views scroll each other, line-accurately
  const longDoc = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} with some words.\n`).join('\n');
  fs.writeFileSync(path.join(work, 'long.md'), longDoc);
  await page.evaluate((p) => window.api.openInWindow(p), path.join(work, 'long.md'));
  await page.waitForFunction(() => /long\.md$/.test(window.__whimflow.state.filePath || ''));
  await run('split');
  await page.waitForFunction(() => document.querySelectorAll('#preview-doc h2').length === 60);
  const topHeading = (sel) => page.evaluate((s) => {
    const box = document.querySelector(s.pane).getBoundingClientRect();
    const hs = [...document.querySelectorAll(s.item)].map((el) => ({ t: el.textContent, y: el.getBoundingClientRect().top - box.top })).filter((h) => h.y >= -4 && /Section \d+/.test(h.t));
    return hs.length ? +/Section (\d+)/.exec(hs[0].t)[1] : null;
  }, sel);
  await page.waitForTimeout(300); // let the brief post-click pause in syncing pass
  await page.evaluate(() => { const ed = window.__whimflow.editor; ed.scrollDOM.scrollTop = ed.yOfLine(4 * 29 + 1) - 24; }); // line of "## Section 30"
  await page.waitForTimeout(400);
  const edA = await topHeading({ pane: '#editor .cm-scroller', item: '#editor .cm-line' }), pvA = await topHeading({ pane: '#preview', item: '#preview-doc h2' });
  assert(edA === 30 && Math.abs(pvA - edA) <= 1, `final view follows the editor to the same section (editor ${edA}, view ${pvA})`);
  const pv = await page.locator('#preview').boundingBox();
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(500);
  const edB = await topHeading({ pane: '#editor .cm-scroller', item: '#editor .cm-line' }), pvB = await topHeading({ pane: '#preview', item: '#preview-doc h2' });
  assert(pvB > pvA + 5 && Math.abs(pvB - edB) <= 1, `the editor follows the final view too (view ${pvB}, editor ${edB})`);
  await page.screenshot({ path: path.join(shots, 'f14-split-sync.png') });
  await page.mouse.move(600, 400);
  await run('split');
  await page.waitForSelector('.cm-live');
  step('invisible characters, split mode, CRLF, two-way sync');

  // ---- export Word and PNG ----
  await page.evaluate((p) => window.api.openInWindow(p), path.join(work, 'doc.md'));
  await page.waitForFunction(() => /doc\.md$/.test(window.__whimflow.state.filePath || ''));
  await page.evaluate(() => window.__whimflow.editor.replaceAll(window.__whimflow.editor.getValue() + '\nInline $a^2+b^2$ and\n\n$$\nE = mc^2\n$$\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n'));
  await run('export', 'docx');
  await page.waitForFunction(() => /已导出|Exported/.test(document.querySelector('#toast').textContent), null, { timeout: 60000 });
  const docx = path.join(work, 'out.docx');
  const listing = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print("\\n".join(z.namelist()));print(z.read("word/document.xml").decode())', docx]).toString();
  assert(listing.includes('word/document.xml'), 'docx is a Word document');
  assert((listing.match(/word\/media\//g) || []).length >= 3, 'formulas and the picture embedded as images: ' + (listing.match(/word\/media\/\S+/g) || []).join(' '));
  assert(listing.includes('Alpha One') && listing.includes('console.log(x);') && listing.includes('w:tbl'), 'text, code and table carried over');
  fs.copyFileSync(docx, path.join(shots, 'export.docx'));
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await run('export', 'png');
  await page.waitForFunction(() => /已导出|Exported/.test(document.querySelector('#toast').textContent), null, { timeout: 60000 });
  const pngOut = fs.readFileSync(path.join(work, 'out.png'));
  assert(pngOut.slice(1, 4).toString() === 'PNG', 'png export');
  const [pw, ph] = [pngOut.readUInt32BE(16), pngOut.readUInt32BE(20)];
  assert(pw >= 900 && ph > 1000, `png has the whole page (${pw}x${ph})`);
  fs.copyFileSync(path.join(work, 'out.png'), path.join(shots, 'export.png'));
  step('export Word and PNG');
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+s`);

  assert.deepStrictEqual(errors, [], 'no uncaught page errors');
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});

  // ---- crash recovery: type, get killed, come back ----
  const ud2 = path.join(work, '.ud2');
  let a2 = await launch([path.join(work, 'notes/a.md'), '--user-data-dir=' + ud2]);
  let p2 = await a2.firstWindow();
  await p2.waitForFunction(() => window.__whimflow && /a\.md$/.test(window.__whimflow.state.filePath || ''));
  await p2.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
  await p2.keyboard.type('Words that were never saved.');
  await p2.waitForTimeout(2200); // draft written
  assert(fs.readdirSync(path.join(ud2, 'drafts')).length === 1, 'draft on disk');
  a2.process().kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  assert(!fs.readFileSync(path.join(work, 'notes/a.md'), 'utf8').includes('never saved'), 'the file itself was not written');
  a2 = await launch(['--user-data-dir=' + ud2]);
  p2 = await a2.firstWindow();
  await p2.waitForFunction(() => window.__whimflow && /a\.md$/.test(window.__whimflow.state.filePath || ''), null, { timeout: 15000 });
  await p2.waitForFunction(() => window.__whimflow.editor.getValue().includes('Words that were never saved.'));
  assert(await p2.evaluate(() => window.__whimflow.state.dirty), 'recovered text is marked unsaved');
  await p2.waitForFunction(() => /恢复/.test(document.querySelector('#toast').textContent));
  await p2.screenshot({ path: path.join(shots, 'f11-recovered.png') });
  await p2.keyboard.press(`${mod}+s`);
  await p2.waitForFunction(() => !window.__whimflow.state.dirty);
  assert(fs.readFileSync(path.join(work, 'notes/a.md'), 'utf8').includes('never saved'), 'saved after recovery');
  assert.strictEqual(fs.readdirSync(path.join(ud2, 'drafts')).filter((n) => n.endsWith('.json')).length, 0, 'draft cleared after saving');
  await a2.evaluate(({ app }) => app.exit(0)).catch(() => {});
  step('crash recovery');

  console.log('FEATURES OK  screenshots:', shots);
})().catch((e) => { console.error('FEATURES FAIL', e); process.exit(1); });
