// The README's screenshots (assets/), made without anything appearing on screen:
//   desktop  the app itself, hidden (WHIMFLOW_HIDDEN: windows drawn but never shown, no Dock icon)
//   iPhone   the iOS web app (mobile/www) in headless Chromium, three screens composed into one image
// Both use temporary data and a sync server on this computer: the Mac's library goes up, the
// iPhone brings it down, as in real use. Run: npm run build && node scripts/build.js mobile && node scripts/screenshots.js
const { _electron, chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const http = require('http'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');

const root = path.join(__dirname, '..');
const out = path.join(root, 'assets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return; await sleep(100); } throw new Error('timed out: ' + what); };

const DOC = `---
title: 让想法自然生长
author: FatalErrorR
tags: 写作, 思考, 笔记
---

# 让想法自然生长

WhimFlow 把 Markdown 变成一张安静的书桌：用来思考、起草，也用来整理想法。

## 先抓住念头

从一个粗糙的想法开始。让文字靠近一些，结构会在书写中自己浮现。

### 不离开页面的笔记

- [x] 随手记下，不用切换窗口
- [x] 原文和成稿放在一起
- [ ] 写完了就分享出去

### 一个小习惯

> 好的界面，会让下一个念头更容易出现。

## 给草稿塑形

编辑器保持专注，正式稿在一旁同步跟随。

### 几个好用的细节

| 模式 | 适合 |
| --- | --- |
| 实时预览 | 写作和修改 |
| 正式稿 | 阅读和审阅 |
| 思维导图 | 看清结构 |

## 放心地回看

一份好草稿的简单模型：$\\text{清晰} = \\text{结构} + \\text{节奏}$。

$$
\\text{clarity} = \\text{structure} + \\text{rhythm}
$$

\`\`\`js
const draft = { structure: true, rhythm: true };
console.log(draft);
\`\`\`

### 准备好分享

在 Mac 上写，在 iPhone 上接着写：文件库会自己同步。
`;
const LIBRARY = {
  '让想法自然生长.md': DOC,
  '灵感速记.md': '# 灵感速记\n\n- 把会议记录变成思维导图\n- 周末整理读书笔记\n',
  '工作/季度计划.md': '# 季度计划\n\n## 目标\n\n- 发布 iPhone 版\n- 文件库同步\n\n## 节奏\n\n每两周回看一次。\n',
  '工作/会议纪要.md': '# 会议纪要\n\n讨论了同步的冲突处理：两份都保留。\n',
  '读书笔记/思考的框架.md': '# 思考的框架\n\n先写下问题，再写下你知道的。\n',
};

(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-shots-')));
  const TOKEN = crypto.randomBytes(24).toString('hex');
  const server = spawn(process.execPath, [path.join(root, 'sync-server/server.js')], {
    env: { ...process.env, DATA: path.join(work, 'server'), WHIMFLOW_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((r) => server.stdout.on('data', (d) => { const m = /on 127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) r(`http://127.0.0.1:${m[1]}`); }));
  let app, browser;
  try {
    // ---------- desktop ----------
    const ud = path.join(work, 'ud');
    for (const [rel, text] of Object.entries(LIBRARY)) {
      const p = path.join(ud, 'Documents', ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    app = await _electron.launch({
      executablePath: require(path.join(root, 'node_modules/electron')),
      args: ['--no-sandbox', root, '--user-data-dir=' + ud],
      env: { ...process.env, WHIMFLOW_TEST: '1', WHIMFLOW_HIDDEN: '1', WHIMFLOW_LANG: 'zh' },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('body.ready');
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { if (w.isVisible()) throw new Error('a window is showing'); w.setContentSize(1440, 900); } });
    const lib = await page.evaluate(() => window.__whimflow.ctx.env.library);
    const r = await page.evaluate(([u, t]) => window.api.syncConnect({ url: u, token: t }), [url, TOKEN]);
    if (!r.ok) throw new Error('connect: ' + JSON.stringify(r));
    await until(async () => /已同步/.test(await page.locator('#tree .tree-root.lib .tree-root-meta').innerText().catch(() => '')), 'synced');
    await page.evaluate((p) => window.api.openPath(p), path.join(lib, '让想法自然生长.md'));
    await page.waitForFunction(() => /让想法自然生长/.test(window.__whimflow.state.filePath || ''));
    await page.evaluate(() => { const s = window.__whimflow.ctx.sidebar; s.setSidebar(true, 'files'); });
    await page.locator('#tree .tree-item.dir', { hasText: '工作' }).click();
    await page.evaluate(() => { const v = window.__whimflow.editor.view; const i = v.state.doc.toString().indexOf('# 让想法'); v.dispatch({ selection: { anchor: i + 2 } }); v.focus(); });
    await page.evaluate(() => window.__whimflow.ctx.right.setRight(true, 'preview'));
    await page.waitForSelector('#preview-doc .katex', { timeout: 15000 });
    await sleep(1200);
    await page.screenshot({ path: path.join(out, 'showcase.png') });
    // the map wants room: a wider right panel (as when its edge is dragged), the outline folded away
    await page.evaluate(() => { document.documentElement.style.setProperty('--right-w', '620px'); window.__whimflow.ctx.right.setRight(true, 'mindmap'); });
    await page.waitForSelector('#mindmap .mm-node');
    await sleep(1400);
    await page.screenshot({ path: path.join(out, 'mindmap.png') });
    if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))) throw new Error('a window showed up');
    await app.close(); app = null;
    console.log('desktop: showcase.png, mindmap.png');

    // ---------- iPhone ----------
    const www = path.join(root, 'mobile/www');
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
    const web = http.createServer((req, res) => {
      const p = path.join(www, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
      if (!p.startsWith(www) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0);
    browser = await chromium.launch();
    // the app fills the whole screen (Safari's 393 × 659 is the page under its own bars)
    const phone = await (await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 393, height: 852 }, locale: 'zh-CN' })).newPage();
    await phone.goto(`http://127.0.0.1:${web.address().port}/`);
    await phone.waitForFunction(() => window.__whimflowMobile, null, { timeout: 15000 });
    const pr = await phone.evaluate(([u, t]) => window.api.syncConnect({ url: u, token: t }), [url, TOKEN]);
    if (!pr.ok) throw new Error('phone connect: ' + JSON.stringify(pr));
    await phone.locator('#m-lib .m-chips button[data-view="folders"]').tap();
    await until(async () => (await phone.locator('#m-lib .m-doc').count()) >= 2 && /已同步/.test(await phone.locator('#m-lib .m-local').innerText()), 'the library came down');
    await sleep(600);
    const shots = [];
    const shoot = async (name) => { const p = path.join(work, name + '.png'); await phone.screenshot({ path: p }); shots.push(p); };
    await shoot('1-library');
    await phone.locator('#m-lib .m-doc', { hasText: '让想法自然生长' }).tap();
    await phone.waitForFunction(() => !document.body.classList.contains('m-lib'));
    await phone.locator('#m-bar .m-more').tap();
    await phone.locator('.m-tabs button[data-tab="mindmap"]').tap();
    await phone.waitForSelector('#m-map .mm-node');
    await phone.evaluate(() => { document.activeElement && document.activeElement.blur(); window.__whimflow.editor.scrollToHeading(1, false); });
    await sleep(900);
    await shoot('2-write-map');
    await phone.locator('#m-map .m-map-close').tap();
    await phone.evaluate(() => window.api.setSetting('theme', 'midnight'));
    await phone.locator('#m-bar .m-seg button[data-mode="read"]').tap();
    await phone.waitForSelector('#preview-doc .katex', { timeout: 10000 });
    await sleep(600);
    await phone.evaluate(() => { document.querySelector('#preview').scrollTop = 0; });
    await sleep(600);
    await shoot('3-read-dark');
    web.close();

    // the three screens side by side
    const img = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    const sheet = await (await browser.newContext({ viewport: { width: 1200, height: 840 }, deviceScaleFactor: 1.5 })).newPage();
    await sheet.setContent(`<body style="margin:0;height:840px;display:flex;gap:44px;align-items:center;justify-content:center;background:linear-gradient(160deg,#efe9df,#e4dccf)">
      ${shots.map((p) => `<img src="${img(p)}" style="width:320px;border-radius:46px;border:7px solid #1d1c1a;box-shadow:0 24px 50px -18px rgba(40,30,15,.5)">`).join('')}</body>`);
    await sleep(300);
    await sheet.screenshot({ path: path.join(out, 'iphone.png') });
    console.log('iPhone: iphone.png');
  } finally {
    if (app) await app.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error('SCREENSHOTS FAIL', e); process.exit(1); });
