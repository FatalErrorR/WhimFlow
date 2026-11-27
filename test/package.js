// The packaged app (dist, from `npm run test:package`), hidden: what it shows from KaTeX and
// Mermaid is packaged (src/renderer/vendor), not left behind in node_modules. Formulas, diagrams
// (in the editor and the final view) and the exports work. WHIMFLOW_APP names another executable.
const { _electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const root = path.join(__dirname, '..');
const exe = process.env.WHIMFLOW_APP || [path.join(root, 'dist/mac-arm64/WhimFlow.app/Contents/MacOS/WhimFlow'), path.join(root, 'dist/mac/WhimFlow.app/Contents/MacOS/WhimFlow'), path.join(root, 'dist/win-unpacked/WhimFlow.exe')].find((p) => fs.existsSync(p));
(async () => {
  if (!exe) throw new Error('no packaged app in dist/: run electron-builder --dir first (npm run test:package)');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pkg-')));
  const doc = path.join(work, 'doc.md');
  fs.writeFileSync(doc, '# 打包测试\n\n公式 $E = mc^2$\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```mermaid\ngraph LR\n  A --> B\n```\n');
  const app = await _electron.launch({ executablePath: exe, args: [doc, '--user-data-dir=' + path.join(work, 'ud')],
    env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_HIDDEN: '1', WHIMFLOW_LANG: 'zh', WHIMFLOW_TEST_EXPORT: path.join(work, 'out') } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__whimflow && /doc\.md$/.test(window.__whimflow.state.filePath || ''));
  if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))) throw new Error('a window showed');
  await page.evaluate(() => { const s = window.__whimflow.editor.view.scrollDOM; s.scrollTop = s.scrollHeight; });
  await page.waitForSelector('.cm-block-mermaid svg', { timeout: 15000 });
  await page.evaluate(() => window.__whimflow.ctx.right.setRight(true, 'preview'));
  await page.waitForSelector('#preview-doc .katex', { timeout: 10000 });
  await page.waitForSelector('#preview-doc svg', { timeout: 15000 });
  const fontsOk = await page.evaluate(() => document.fonts.check('16px KaTeX_Main'));
  const out = { editorDiagram: true, finalFormula: true, finalDiagram: true, katexFont: fontsOk };
  for (const type of ['html', 'docx', 'pdf']) {
    await page.evaluate((t) => window.__whimflow.run('export', t), type);
    const f = path.join(work, 'out.' + type);
    for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 150));
    out['export ' + type] = fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) + 'KB' : 'MISSING';
  }
  assert.deepStrictEqual(out, { editorDiagram: true, finalFormula: true, finalDiagram: true, katexFont: true, 'export html': out['export html'], 'export docx': out['export docx'], 'export pdf': out['export pdf'] });
  for (const t of ['html', 'docx', 'pdf']) assert(out['export ' + t] !== 'MISSING', t + ' exported');
  console.log('  ✓ the packaged app: formulas, diagrams in the editor and the final view, HTML / Word / PDF exports', JSON.stringify(out));
  console.log('PACKAGE OK');
  await app.close();
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => { console.error('PACKAGE FAIL', e); process.exit(1); });
