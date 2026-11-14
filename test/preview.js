// End-to-end test for the final view while typing: it is patched block by block, so
// after every kind of edit it must be exactly what a full re-render gives (line
// numbers, footnote numbers, heading anchors, table of contents, diagrams), and it
// must keep up with typing.
const { _electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const root = path.join(__dirname, '..');
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'whimflow-shots');

const DOC = `---
title: Preview test
---

# Title

[toc]

Intro with a note.[^a] And $x^2$ inline.

## First

- one
- two
  - nested

\`\`\`js {2}
const a = 1;
const b = 2;
\`\`\`

$$
\\int_0^1 x\\,dx
$$

## Second

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`mermaid
graph LR
  A --> B
\`\`\`

> Quote.[^b]

[^a]: Note A.
[^b]: Note B.
`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-preview-'));
  fs.writeFileSync(path.join(work, 'doc.md'), DOC);
  const errors = [];
  const step = (name) => console.log('  ✓', name);
  const app = await _electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: ['--no-sandbox', root, path.join(work, 'doc.md'), '--user-data-dir=' + path.join(work, 'ud')],
    env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await page.waitForFunction(() => window.__whimflow && /doc\.md$/.test(window.__whimflow.state.filePath || ''));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
  await page.evaluate(() => window.__whimflow.run('preview'));
  await page.waitForFunction(() => document.querySelector('#preview-doc svg') && window.__whimflow.ctx.previewUpToDate());

  const settle = () => page.waitForFunction(() => window.__whimflow.ctx.previewUpToDate(), null, { timeout: 10000 }).then(() => page.waitForTimeout(150));
  const html = () => page.evaluate(() => document.querySelector('#preview-doc').innerHTML);
  /** The view as patched, then as rebuilt from scratch: they must be identical. */
  async function same(label) {
    await settle();
    const patched = await html();
    await page.evaluate(() => window.__whimflow.ctx.right.refresh(true));
    await settle();
    const full = await html();
    if (patched !== full) {
      let i = 0; while (i < patched.length && patched[i] === full[i]) i++;
      throw new Error(label + ': the patched view differs from a full render at ' + i + '\n patched: ' + JSON.stringify(patched.slice(Math.max(0, i - 120), i + 120)) + '\n full:    ' + JSON.stringify(full.slice(Math.max(0, i - 120), i + 120)));
    }
    step(label);
  }
  const edit = (fn, arg) => page.evaluate(([src, a]) => {
    const v = window.__whimflow.editor.view, d = v.state.doc;
    const f = new Function('v', 'd', 'a', src);
    v.dispatch(f(v, d, a));
  }, [fn, arg]);
  const lineStart = (text) => page.evaluate((t) => { const d = window.__whimflow.editor.view.state.doc; for (let i = 1; i <= d.lines; i++) if (d.line(i).text.startsWith(t)) return d.line(i).from; return -1; }, text);

  // lines added above shift every data-line below
  await edit('return { changes: { from: d.line(5).from, insert: "Added line.\\n\\nAnother.\\n\\n" } };');
  await same('lines added near the top');
  // typing inside one block
  const intro = await lineStart('Intro');
  await page.evaluate((p) => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: p + 5 } }); v.focus(); }, intro);
  await page.keyboard.type(' typed');
  await same('typing inside a paragraph');
  // a footnote referenced earlier renumbers the later ones
  await edit('return { changes: { from: a, insert: "Early.[^b] " } };', intro);
  await same('footnote numbers change');
  // a heading added before others: anchors and the table of contents change
  const first = await lineStart('## First');
  await edit('return { changes: { from: a, insert: "## First\\n\\nDuplicate heading.\\n\\n" } };', first);
  await same('heading added: anchors and table of contents');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#preview-doc nav.toc a').length), 4, 'the table of contents lists every heading');
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('#preview-doc h2')].map((h) => h.id)), ['first', 'first-1', 'second'], 'repeated headings get distinct anchors');
  // a block removed, two blocks merged
  const quote = await lineStart('> Quote');
  await edit('const l = d.lineAt(a); return { changes: { from: l.from, to: l.to + 1 } };', quote);
  const table = await lineStart('| 1 | 2 |');
  await edit('return { changes: { from: a - 1, to: a + 9, insert: "" } };', table);
  await same('block removed, table row removed');
  // the diagram changes; a code block's highlighted lines change
  const g = await lineStart('  A --> B');
  await edit('return { changes: { from: a, insert: "  B --> C\\n" } };', g);
  const fence = await lineStart('```js');
  await edit('const l = d.lineAt(a); return { changes: { from: l.from, to: l.to, insert: "```js {1,2}" } };', fence);
  await same('diagram and code block changed');
  // front matter grows: everything below moves
  await edit('return { changes: { from: d.line(2).to, insert: "\\nauthor: me\\ntags: a" } };');
  await same('front matter changed');
  // clicking a block still jumps to its line, and the caret's block is marked
  const second = await page.evaluate(() => { const el = [...document.querySelectorAll('#preview-doc h2')].find((h) => h.textContent === 'Second'); return +el.dataset.line; });
  assert.strictEqual(await page.evaluate((n) => window.__whimflow.editor.view.state.doc.line(n).text, second), '## Second', 'data-line points at the source line');
  await page.locator('#preview-doc h2', { hasText: 'Second' }).click();
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => window.__whimflow.editor.caretLine()), second, 'clicking jumps to that line');
  step('line numbers still drive jumping');

  // where the caret is: a faint band over its section, a brighter one over its own line
  const bands = () => page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
    const [sec, cur] = ['.pv-sec', '.pv-cur'].map((s) => document.querySelector(s));
    const doc = document.querySelector('#preview-doc'), cs = getComputedStyle(doc), d = doc.getBoundingClientRect();
    const col = { left: d.left + parseFloat(cs.paddingLeft), right: d.right - parseFloat(cs.paddingRight) };
    return { sec: sec.hidden ? null : r(sec), cur: cur.hidden ? null : r(cur), col,
      secColor: getComputedStyle(sec).backgroundColor, curColor: getComputedStyle(cur).backgroundColor };
  });
  const rectOf = (sel, text) => page.evaluate(([s, t]) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(t)); const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }, [sel, text]);
  const caretAt = async (text) => {
    const at = await lineStart(text);
    await page.evaluate((p) => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: p + 2 }, scrollIntoView: true }); v.focus(); }, at);
    await page.waitForTimeout(450);
  };
  await caretAt('- two');
  let bd = await bands();
  assert(bd.sec && bd.cur, 'both bands shown while editing');
  const h2 = await page.evaluate(() => { const b = document.querySelector('#preview-doc > h2#first-1').getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }); // the second "First" holds the list
  const code = await rectOf('#preview-doc > pre', 'const a');
  const math = await page.evaluate(() => { const b = document.querySelector('#preview-doc > .math-block').getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
  assert(bd.sec.top <= h2.top && bd.sec.top > h2.top - 20, 'the section starts at its heading');
  assert(bd.sec.bottom >= math.bottom && bd.sec.bottom < math.bottom + 20, 'and ends with its last block (before "## Second")');
  assert(code.top > bd.sec.top && code.bottom < bd.sec.bottom);
  const two = await page.evaluate(() => { const li = [...document.querySelectorAll('#preview-doc li')].find((e) => e.firstChild.textContent.trim() === 'two'); const r = document.createRange(); r.setStart(li, 0); r.setEndBefore(li.querySelector('ul')); const b = r.getBoundingClientRect(); const n = li.querySelector('ul').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, nestedTop: n.top }; });
  assert(bd.cur.top <= two.top && bd.cur.bottom >= two.bottom && bd.cur.bottom <= two.nestedTop + 4, 'the brighter band covers the list item’s own line, not its nested list');
  for (const b of [bd.sec, bd.cur]) {
    const l = bd.col.left - b.left, r = b.right - bd.col.right;
    assert(Math.abs(l - r) <= 1 && l >= 10 && l <= 18, 'both bands reach equally past the text column (' + l + ' / ' + r + ')');
  }
  assert.notStrictEqual(bd.secColor, bd.curColor, 'the caret’s band is brighter than the section’s');
  // another section: the bands follow
  await caretAt('| A |');
  bd = await bands();
  const secondH = await rectOf('#preview-doc > h2', 'Second'), row = await rectOf('#preview-doc tr', 'A');
  assert(Math.abs(bd.sec.top - (secondH.top - 8)) <= 1, 'the section band moved to "Second"');
  assert(bd.cur.top <= row.top && bd.cur.bottom >= row.bottom && bd.cur.bottom - bd.cur.top < 60, 'the brighter band is the table row');
  // before the first heading there is no section, only the caret's line
  await caretAt('Added line');
  bd = await bands();
  assert(!bd.sec && bd.cur, 'no section band before the first heading');
  // only while editing
  await page.evaluate(() => document.querySelector('#palette-input') && document.activeElement.blur());
  await page.waitForTimeout(200);
  bd = await bands();
  assert(!bd.sec && !bd.cur, 'hidden when the editor is not being edited');
  await page.screenshot({ path: path.join(shots, 'preview-bands.png') });
  step('caret position in the final view: section band, brighter line band, aligned edges');

  // keeps up with typing: a typed word shows in well under a second
  await page.evaluate(() => { const v = window.__whimflow.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
  const t0 = Date.now();
  await page.keyboard.type('\nquickcheck', { delay: 30 });
  await page.waitForFunction(() => document.querySelector('#preview-doc').textContent.includes('quickcheck'), null, { timeout: 5000, polling: 10 });
  const took = Date.now() - t0 - 30 * 10;
  assert(took < 600, 'the final view follows typing (' + took + ' ms after the last key)');
  step('follows typing (' + took + ' ms after the last key)');

  await page.screenshot({ path: path.join(shots, 'preview-incremental.png') });
  assert.deepStrictEqual(errors, [], 'no page errors');
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  console.log('PREVIEW OK  screenshots:', shots);
})().catch((e) => { console.error('PREVIEW FAIL', e); process.exit(1); });
