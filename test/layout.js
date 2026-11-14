// macOS window buttons (red, yellow, green) are drawn by the system on top of the page,
// at x 14–68, y 20–36 (see trafficLightPosition in src/main.js). This test lays the app
// out the macOS way (body.mac) in every arrangement and checks that nothing clickable or
// readable sits under them, and that the header rows share the buttons' centre line.
// Runs on any platform: the macOS styles are applied by class, not by the OS.
const { _electron } = require('playwright');
const assert = require('assert');
const path = require('path'), fs = require('fs'), os = require('os');
(async () => {
  const root = path.join(__dirname, '..'), work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lights-'));
  for (const n of ['a', 'b']) fs.writeFileSync(path.join(work, n + '.md'), `# ${n}\n\ntext\n`);
  const app = await _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: ['--no-sandbox', root, path.join(work, 'a.md'), '--user-data-dir=' + path.join(work, 'ud')], env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh' } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__whimflow && window.__whimflow.state.filePath);
  await page.evaluate(() => document.body.classList.add('mac'));
  const BOX = { x0: 8, x1: 74, y0: 14, y1: 42 }; // the buttons' frames with ~6px of breathing room
  const check = async (label) => {
    await page.waitForTimeout(450);
    const hits = await page.evaluate((B) => {
      const out = [];
      for (const el of document.querySelectorAll('button, input, a, [data-tip], .tree-item, #title, #title-state, #right-label, .card-head, .eyebrow, .doc-dot, #doc-switch, .island-grip')) {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        if (el.closest('[hidden]')) continue;
        if (r.right > B.x0 && r.left < B.x1 && r.bottom > B.y0 && r.top < B.y1) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')} @ ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
      return out;
    }, BOX);
    assert.deepStrictEqual(hits, [], label + ': something sits under the window buttons');
    console.log('  ✓', label);
  };
  const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
  const order = (o) => page.evaluate((o) => { localStorage.setItem('mf-order', JSON.stringify(o)); }, o);
  const M = (js) => page.evaluate(js);
  await size(1200, 800);

  await M(() => { const c = window.__whimflow.ctx; c.sidebar.setSidebar(true, 'files'); c.right.setRight(false); });
  await check('sidebar open (files), editor');
  await M(() => window.__whimflow.ctx.sidebar.setSidebar(true, 'search'));
  await check('sidebar open (search)');
  await M(() => document.documentElement.style.setProperty('--side-w', '180px'));
  await check('sidebar at its minimum width');
  await M(() => window.__whimflow.ctx.sidebar.setSidebar(false));
  await check('sidebar closed, one document');
  await page.evaluate((p) => window.api.openInWindow(p, null, { preview: false }), path.join(work, 'b.md'));
  await page.waitForFunction(() => window.__whimflow.ctx.docs.list().length === 2);
  await check('sidebar closed, two documents (title switcher)');
  await M(() => window.__whimflow.run('find'));
  await check('sidebar closed, find bar open');
  await M(() => window.__whimflow.ctx.find.close());
  await M(() => { window.__whimflow.ctx.right.setRight(true, 'mindmap'); });
  await check('sidebar closed, right panel open');
  // the right panel moved to the left edge
  await M(() => { const c = window.__whimflow.ctx; c.islands.setIsland('right'); c.islands.moveCurrent(-1); });
  await page.waitForTimeout(300);
  await M(() => { const c = window.__whimflow.ctx; c.islands.setIsland('right'); c.islands.moveCurrent(-1); });
  await check('right panel first (left edge)');
  await M(() => window.__whimflow.ctx.sidebar.setSidebar(true, 'files'));
  await check('right panel first, sidebar open too');
  await size(560, 600);
  await check('narrow window');
  // the header rows are centred on the buttons' line (28px from the top)
  await size(1200, 800);
  await M(() => { const c = window.__whimflow.ctx; c.right.setRight(true, 'mindmap'); });
  await page.waitForTimeout(450);
  const centres = await M(() => ['.side-tab', '.right-tab', '#title'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
  assert.deepStrictEqual(centres, [28, 28, 28], 'header rows level with the window buttons');
  // each island's drag dot sits in its top-right corner, on that same line
  const grips = await M(() => ['#sidebar', '#main', '#right'].map((s) => {
    const isl = document.querySelector(s).getBoundingClientRect(), g = document.querySelector(s + ' > .island-grip').getBoundingClientRect();
    return { island: s, centreY: Math.round(g.top + g.height / 2), fromRight: Math.round(isl.right - g.right) };
  }));
  for (const g of grips) {
    assert.strictEqual(g.centreY, 28, g.island + ' dot on the header line');
    assert(g.fromRight >= 7 && g.fromRight <= 12, g.island + ' dot in the top-right corner, clear of the resize edge: ' + g.fromRight);
  }
  console.log('  ✓ each island’s drag dot in its top-right corner, on the header line');
  console.log('  ✓ header icons and title centred on the window buttons’ line');
  // the width handles: on the gap between two islands, and grabbing one keeps the selected island
  await M(() => { localStorage.removeItem('mf-order'); });
  for (const arrangement of ['default', 'right panel first']) {
    if (arrangement !== 'default') {
      await M(() => { const c = window.__whimflow.ctx; c.islands.setIsland('right'); c.islands.moveCurrent(-1); });
      await page.waitForTimeout(300);
      await M(() => { const c = window.__whimflow.ctx; c.islands.setIsland('right'); c.islands.moveCurrent(-1); });
      await page.waitForTimeout(500);
    }
    await page.locator('.cm-content').click();
    for (const [handle, panel] of [['#side-resizer', '#sidebar'], ['#right-resizer', '#right']]) {
      const gap = await page.evaluate((h) => {
        const el = document.querySelector(h), p = el.parentElement, r = p.getBoundingClientRect();
        const start = p.classList.contains('rz-start');
        const x = start ? r.left - 3 : r.right + 3; // the middle of the 6px gap beside the panel
        return { x, y: r.top + r.height / 2, hit: document.elementFromPoint(x, r.top + r.height / 2) === el };
      }, handle);
      assert(gap.hit, `${arrangement}: the gap beside ${panel} is its width handle`);
      const before = await page.evaluate((p) => document.querySelector(p).getBoundingClientRect().width, panel);
      await page.mouse.move(gap.x, gap.y); await page.mouse.down();
      await page.mouse.move(gap.x + 40, gap.y, { steps: 4 }); await page.mouse.up();
      await page.waitForTimeout(200);
      const after = await page.evaluate((p) => document.querySelector(p).getBoundingClientRect().width, panel);
      assert(Math.abs(Math.abs(after - before) - 40) <= 2, `${arrangement}: ${panel} is 40px ${after > before ? 'wider' : 'narrower'} (${before} → ${after})`);
      assert.strictEqual(await M(() => document.body.dataset.island), 'main', `${arrangement}: resizing ${panel} keeps the editor selected`);
    }
    console.log('  ✓ width handles on the gaps, editor stays selected (' + arrangement + ')');
  }
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});

  // line width: "no limit" by default, the text fills the editor however wide the window
  const launchWith = async (saved) => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lw-'));
    if (saved) fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify(saved));
    const a = await _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: ['--no-sandbox', root, path.join(work, 'a.md'), '--user-data-dir=' + ud], env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_LANG: 'zh' } });
    const p = await a.firstWindow();
    await p.waitForFunction(() => window.__whimflow && window.__whimflow.state.filePath);
    await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 900));
    await p.waitForTimeout(400);
    const r = await p.evaluate(() => {
      const c = document.querySelector('#editor .cm-content').getBoundingClientRect(), sc = document.querySelector('#editor .cm-scroller').getBoundingClientRect();
      return { lineWidth: window.__whimflow.state.settings.lineWidth, content: Math.round(c.width), editor: Math.round(sc.width) };
    });
    await a.evaluate(({ app: x }) => x.exit(0)).catch(() => {});
    return { ...r, file: JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')) };
  };
  let lw = await launchWith(null);
  assert.strictEqual(lw.lineWidth, 1200, 'a fresh install has no line-width limit');
  assert(lw.content >= lw.editor - 30, `the text fills the editor (${lw.content} of ${lw.editor}px)`);
  lw = await launchWith({ theme: 'daylight', lineWidth: 720 });
  assert.strictEqual(lw.lineWidth, 1200, 'the old default (720) becomes "no limit"');
  assert.strictEqual(lw.file.settingsVersion, 2, 'and is written back once');
  assert.strictEqual(lw.file.theme, 'daylight', 'other settings are kept');
  lw = await launchWith({ lineWidth: 720, settingsVersion: 2 });
  assert.strictEqual(lw.lineWidth, 720, 'a width chosen after the change is kept');
  assert(lw.content < 760, 'and used');
  lw = await launchWith({ lineWidth: 900 });
  assert.strictEqual(lw.lineWidth, 900, 'any other width the user chose is kept');
  console.log('  ✓ line width: no limit by default; the old default moves over once; chosen widths kept');
  console.log('LAYOUT OK');
})().catch((e) => { console.error('LAYOUT FAIL', e); process.exit(1); });
