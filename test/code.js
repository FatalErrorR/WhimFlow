// End-to-end test for code blocks: file-name titles, highlighted lines (and their
// numbers following edits), folding, copy, ```diff colouring, comparing two blocks.
const { _electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');

const SERVER = Array.from({ length: 18 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
const DOC = `# Code

Intro.

\`\`\`python title="save.py" {2,4-5}
def save(doc, path):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(doc.text)
        f.flush()
    os.replace(tmp, path)
    return True
\`\`\`

Middle.

\`\`\`javascript title="server.js" fold
${SERVER}
\`\`\`

\`\`\`diff
@@ -1,2 +1,2 @@
 keep
-old line
+new line
\`\`\`

\`\`\`python title="v1.py"
def total(items):
    s = 0
    for it in items:
        s += it.price
    return s
\`\`\`

After.

\`\`\`python title="v2.py"
def total(items, tax=0.0):
    s = 0
    for it in items:
        s += it.price * it.count
    return round(s * (1 + tax), 2)
\`\`\`

End.
`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-code-'));
  fs.writeFileSync(path.join(work, 'code.md'), DOC);
  const errors = [];
  const step = (name) => console.log('  ✓', name);

  const app = await _electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: ['--no-sandbox', root, path.join(work, 'code.md'), '--user-data-dir=' + path.join(work, '.ud')],
    env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh', WHIMFLOW_TEST_CONFIRM: 'discard', WHIMFLOW_TEST_EXPORT: path.join(work, 'out') },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await page.waitForFunction(() => window.__whimflow && /code\.md$/.test(window.__whimflow.state.filePath || ''));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 1000); });
  await page.waitForTimeout(700);

  const run = (c, a) => page.evaluate(([c, a]) => { window.__whimflow.run(c, a); }, [c, a]);
  const val = () => page.evaluate(() => window.__whimflow.editor.getValue());
  const count = (s) => page.locator(s).count();
  const lineOf = async (needle) => (await val()).split('\n').findIndex((l) => l.includes(needle)) + 1;
  const jump = async (needle, col = 0) => { const line = await lineOf(needle); await page.evaluate(([line, col]) => window.__whimflow.editor.jumpTo({ line, col }), [line, col]); await page.waitForTimeout(250); };
  const fenceOf = async (needle) => (await val()).split('\n').find((l) => l.startsWith('```') && l.includes(needle));
  const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  // ---- title, highlighted lines, diff colours ----
  await jump('Intro.');
  assert((await count('.cm-cb-titled')) >= 2, 'titled blocks in view have a title strip');
  assert.strictEqual(await page.locator('.cm-cb-title').first().innerText(), 'save.py');
  assert.strictEqual(await count('.cm-cb-hl'), 3, 'lines 2, 4 and 5 are highlighted');
  const hlText = await page.locator('.cm-cb-hl').allInnerTexts();
  assert(/tmp = path/.test(hlText[0]) && /f\.write/.test(hlText[1]) && /f\.flush/.test(hlText[2]), 'the right lines: ' + hlText.join(' | '));
  assert.strictEqual(await page.locator('.cm-cb-lang').first().innerText(), 'PYTHON', 'language is the first word only');
  assert((await count('.cm-cb .tok-keyword')) > 0, 'code is still syntax-highlighted with options on the fence');
  step('title strip, highlighted lines, language');

  // ---- folding ----
  assert.strictEqual(await count('.cm-cb-folded'), 1, 'the block marked fold is folded');
  assert(/13/.test(await page.locator('.cm-cb-more').innerText()), '18 lines, 5 shown, 13 hidden');
  assert.strictEqual(await count('.cm-line:has-text("const line6 = 6;")'), 0, 'hidden lines are not drawn');
  assert.strictEqual(await count('.cm-line:has-text("const line5 = 5;")'), 1, 'the first five stay');
  // the caret entering the block opens it; leaving closes it again
  await jump('const line3 = 3;');
  assert.strictEqual(await count('.cm-cb-folded'), 0, 'caret inside: unfolded');
  assert.strictEqual(await count('.cm-line:has-text("const line12 = 12;")'), 1);
  await jump('Middle.');
  assert.strictEqual(await count('.cm-cb-folded'), 1, 'caret outside: folded again');
  // the bar unfolds for good (removes "fold" from the fence)
  await page.locator('.cm-cb-folded').click();
  await page.waitForTimeout(250);
  assert.strictEqual(await fenceOf('server.js'), '```javascript title="server.js"', 'fold removed from the info string');
  assert.strictEqual(await count('.cm-cb-folded'), 0);
  // the header button folds it again
  await page.locator('.cm-line:has-text("const line2 = 2;")').hover();
  await page.waitForTimeout(200);
  const serverHead = page.locator('.cm-cb-open:has-text("server.js")');
  assert.strictEqual(await serverHead.locator('.cm-cb-header.show').count(), 1, 'tools show while the pointer is over the block');
  await serverHead.locator('button.cm-cb-fold').click();
  await page.waitForTimeout(250);
  assert.strictEqual(await fenceOf('server.js'), '```javascript title="server.js" fold');
  assert.strictEqual(await count('.cm-cb-folded'), 1, 'folded by the header button');
  assert.strictEqual(await page.locator('.cm-cb-open:has-text("save.py") button.cm-cb-fold').count(), 0, 'short blocks offer no fold button');
  await page.screenshot({ path: path.join(shots, 'code-1-live.png') });
  step('fold: bar, header button, opens while the caret is inside');

  // ---- copy ----
  await page.locator('.cm-line:has-text("os.replace")').hover();
  await page.locator('.cm-cb-open:has-text("save.py") .cm-cb-copy').click();
  assert(/^def save\(doc, path\):\n {4}tmp = /.test(await clip()) && /return True\n?$/.test(await clip()), 'copy puts the code on the clipboard');
  assert(!/```/.test(await clip()), 'without the fences');
  step('copy');

  // ---- highlight command; numbers follow edits ----
  await jump('os.replace', 4);
  await page.keyboard.press(`${mod}+Shift+H`);
  await page.waitForTimeout(200);
  assert.strictEqual(await fenceOf('save.py'), '```python title="save.py" {2,4-6}', '⌘⇧H highlights the caret line: ' + await fenceOf('save.py'));
  await page.keyboard.press(`${mod}+Shift+H`);
  await page.waitForTimeout(200);
  assert.strictEqual(await fenceOf('save.py'), '```python title="save.py" {2,4-5}', 'and again removes it');
  // a new line above a highlighted one pushes its number down
  await jump('def save(doc', 0);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# new');
  await page.waitForTimeout(200);
  assert.strictEqual(await fenceOf('save.py'), '```python title="save.py" {3,5-6}', 'numbers moved with the code: ' + await fenceOf('save.py'));
  // a line inside a highlighted run joins it
  await jump('f.write(doc.text)', 0);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('pass');
  await page.waitForTimeout(200);
  assert.strictEqual(await fenceOf('save.py'), '```python title="save.py" {3,5-7}', 'a line added inside a run is highlighted too: ' + await fenceOf('save.py'));
  // deleting a whole line pulls the numbers back up
  await jump('# new', 0);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  assert.strictEqual(await fenceOf('save.py'), '```python title="save.py" {2,4-6}', 'deleting a line above: ' + await fenceOf('save.py'));
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(200);
  assert.strictEqual(await fenceOf('save.py'), '```python title="save.py" {3,5-7}', 'undo restores code and numbers together');
  assert((await val()).includes('# new'));
  // outside code, the same key still wraps text
  await jump('Middle.', 0);
  await page.keyboard.press('Shift+End');
  await page.keyboard.press(`${mod}+Shift+H`);
  assert((await val()).includes('==Middle.=='), 'outside code ⌘⇧H is still inline highlight');
  await page.keyboard.press(`${mod}+z`);
  step('highlight lines with ⌘⇧H; numbers follow inserted and deleted lines');

  // ---- typing a fence with options ----
  await jump('End.', 0);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('```js t');
  await page.waitForTimeout(400);
  assert.strictEqual(await page.locator('.cm-tooltip-autocomplete li').first().locator('.cm-completionLabel').innerText(), 'title=""', 'options are offered after the language');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a.js');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('let a = 1;');
  await page.waitForTimeout(200);
  assert((await val()).includes('```js title="a.js"\nlet a = 1;\n```'), 'Enter on a fence with options closes the block: ' + JSON.stringify((await val()).slice(-60)));
  step('fence options: completion and auto-close');

  // ---- ```diff colours ----
  await jump('After.');
  assert.strictEqual(await count('.cm-cb-add'), 1);
  assert.strictEqual(await count('.cm-cb-del'), 1);
  assert.strictEqual(await count('.cm-cb-hunk'), 1);
  step('diff blocks colour added and removed lines');

  // ---- compare two blocks ----
  await jump('def total(items):');
  await run('code-compare');
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => document.body.classList.contains('picking-code')), 'waiting for the second block');
  assert((await count('.cm-cb-picked')) > 0, 'the first block is marked');
  assert(!(await page.locator('#toast').isHidden()), 'a hint stays up');
  await page.locator('.cm-line:has-text("it.price * it.count")').click();
  await page.waitForTimeout(300);
  assert.strictEqual(await count('#codediff'), 1, 'the comparison opens');
  assert(!(await page.evaluate(() => document.body.classList.contains('picking-code'))));
  assert.deepStrictEqual(await page.locator('.cd-names span').allInnerTexts(), ['v1.py', 'v2.py']);
  assert.strictEqual((await page.locator('.cd-stat').innerText()).replace(/\s/g, ''), '+3−3');
  assert.strictEqual(await count('.cd-row'), 5);
  assert.strictEqual(await page.locator('.cd-t.add ins').first().innerText(), ', tax=0.0', 'changed words are marked inside a changed line');
  await page.screenshot({ path: path.join(shots, 'code-2-compare.png') });
  // swap, then put the diff into the document
  await page.locator('.cd-top button', { hasText: '互换' }).click();
  assert.deepStrictEqual(await page.locator('.cd-names span').allInnerTexts(), ['v2.py', 'v1.py']);
  await page.locator('.cd-top button', { hasText: '互换' }).click();
  await page.locator('.cd-top button', { hasText: '拷贝差异' }).click();
  assert(/^-def total\(items\):\n\+def total\(items, tax=0\.0\):\n {5}s = 0/.test(await clip()), 'diff text on the clipboard: ' + JSON.stringify((await clip()).slice(0, 80)));
  await page.locator('.cd-top button.primary').click();
  await page.waitForTimeout(300);
  assert.strictEqual(await count('#codediff'), 0);
  const text = await val();
  const at = text.indexOf('```diff\n-def total(items):');
  assert(at > text.indexOf('return round(s * (1 + tax), 2)\n```'), 'a diff block is inserted after the later block');
  assert(text.slice(at).includes('+    return round(s * (1 + tax), 2)\n```\n\nEnd.'), 'on its own lines: ' + JSON.stringify(text.slice(at, at + 260)));
  // esc cancels picking; identical blocks say so
  await jump('def total(items):');
  await run('code-compare');
  await page.keyboard.press('Escape');
  assert(!(await page.evaluate(() => document.body.classList.contains('picking-code'))), 'esc cancels');
  assert.strictEqual(await count('.cm-cb-picked'), 0);
  await page.evaluate(() => { const c = window.__whimflow.ctx.codeDiff, e = window.__whimflow.editor; const b = e.codeBlockAt(); c.open(b, b); });
  assert.strictEqual(await count('.cd-same'), 1, 'identical blocks');
  await page.keyboard.press('Escape');
  assert.strictEqual(await count('#codediff'), 0, 'esc closes the comparison');
  step('compare: pick, side by side, word marks, swap, copy, insert as diff block');

  // ---- final view ----
  await run('preview');
  await page.waitForTimeout(1200);
  const pre = page.locator('#preview-doc pre');
  assert.strictEqual(await pre.first().getAttribute('data-title'), 'save.py');
  assert.strictEqual(await count('#preview-doc pre .line.hl'), 4, 'highlighted lines in the final view ({3,5-7})');
  assert(/tmp = path/.test(await page.locator('#preview-doc pre .line.hl').first().innerText()), 'the same code is highlighted after the edits');
  const lineBox = await page.evaluate(() => { const ls = [...document.querySelectorAll('#preview-doc pre .line')].slice(0, 3).map((l) => l.getBoundingClientRect()); return { h: ls.map((r) => Math.round(r.height)), step: Math.round(ls[1].top - ls[0].top) }; });
  assert(lineBox.h.every((h) => h === lineBox.h[0]) && lineBox.step === lineBox.h[0], 'wrapped lines keep the normal line rhythm: ' + JSON.stringify(lineBox));
  assert.strictEqual(await count('#preview-doc pre .line.add'), 3 + 1, 'diff lines are coloured (the inserted block and the sample)');
  const folded = page.locator('#preview-doc pre[data-fold]');
  assert.strictEqual(await folded.count(), 1);
  assert(await folded.evaluate((el) => el.classList.contains('folded') && el.querySelector('code').clientHeight < el.querySelector('code').scrollHeight), 'folded in the final view');
  const caretBefore = await page.evaluate(() => window.__whimflow.editor.caretLine());
  await folded.locator('.code-more').click();
  assert(await folded.evaluate((el) => !el.classList.contains('folded') && el.querySelector('code').clientHeight >= el.querySelector('code').scrollHeight), 'opens in place');
  await pre.first().hover();
  await pre.first().locator('.code-copy').click();
  assert(/^def save\(doc, path\):\n\s*# new\n/.test(await clip()), 'copy from the final view: ' + JSON.stringify((await clip()).slice(0, 50)));
  assert.strictEqual(await page.evaluate(() => window.__whimflow.editor.caretLine()), caretBefore, 'the buttons do not move the caret');
  await page.screenshot({ path: path.join(shots, 'code-3-final.png') });
  step('final view: title, highlighted lines, fold, copy');

  // ---- exports carry the title and highlights, never the fold ----
  await run('export', 'html');
  const outHtml = path.join(work, 'out.html');
  for (let i = 0; i < 50 && !fs.existsSync(outHtml); i++) await page.waitForTimeout(100);
  const html = fs.readFileSync(outHtml, 'utf8');
  assert(html.includes('data-title="save.py"') && html.includes('class="line hl"'), 'HTML export keeps title and highlights');
  assert(!html.includes('code-copy') && !html.includes('class="folded"'), 'no buttons, nothing hidden in an export');
  assert(html.includes('line18 = '), 'folded code is exported in full');
  await run('export', 'docx');
  const outDocx = path.join(work, 'out.docx');
  for (let i = 0; i < 150 && !fs.existsSync(outDocx); i++) await page.waitForTimeout(100);
  assert(fs.existsSync(outDocx) && fs.statSync(outDocx).size > 2000, 'Word export still works with these blocks');
  step('exports');

  assert.deepStrictEqual(errors, [], 'no page errors');
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); // the document is deliberately left unsaved
  console.log('CODE OK  screenshots:', shots);
})().catch((e) => { console.error('CODE FAIL', e); process.exit(1); });
