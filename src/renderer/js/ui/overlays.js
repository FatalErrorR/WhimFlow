// Find bar, selection bubble and command palette.
import { $, t, toast, dirname, ICONS } from '../util.js';

// ---------------- find & replace ----------------
export function initFind(ctx) {
  const { editor } = ctx;
  const fs = { open: false, cs: false };
  const input = $('#find-input'), rep = $('#replace-input');
  input.placeholder = t('查找', 'Find');
  rep.placeholder = t('替换为', 'Replace with');
  $('#replace-one').textContent = t('替换', 'Replace');
  $('#replace-all').textContent = t('全部替换', 'Replace All');

  const show = (s) => {
    $('#find-count').textContent = input.value ? (s.count ? `${s.index + 1} / ${s.count}${s.capped ? '+' : ''}` : t('无结果', 'No results')) : '';
  };
  function open(withReplace) {
    fs.open = true;
    $('#findbar').hidden = false;
    $('#replace-row').hidden = !withReplace;
    const sel = editor.selectionText();
    if (sel && !sel.includes('\n')) input.value = sel;
    input.focus(); input.select();
    show(editor.find.set(input.value, fs.cs));
  }
  function close() {
    fs.open = false;
    $('#findbar').hidden = true;
    editor.find.clear();
    editor.focus();
  }
  const step = (d) => { if (!fs.open) { open(false); return; } show(editor.find.step(d)); };
  input.oninput = () => show(editor.find.set(input.value, fs.cs));
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') close();
  };
  rep.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); show(editor.find.replaceOne(rep.value)); }
    else if (e.key === 'Escape') close();
  };
  $('#find-next').onclick = () => step(1);
  $('#find-prev').onclick = () => step(-1);
  $('#find-close').onclick = close;
  $('#find-case').onclick = (e) => { fs.cs = !fs.cs; e.currentTarget.classList.toggle('on', fs.cs); show(editor.find.set(input.value, fs.cs)); };
  $('#replace-one').onclick = () => show(editor.find.replaceOne(rep.value));
  $('#replace-all').onclick = () => {
    const n = editor.find.replaceAll(rep.value);
    if (n) toast(t(`已替换 ${n} 处，⌘Z 可撤销`, `Replaced ${n} — ⌘Z to undo`));
    show(editor.find.status());
  };
  return { open, close, step, isOpen: () => fs.open };
}

// ---------------- selection bubble ----------------
export function initBubble(ctx) {
  const { editor } = ctx;
  const bubble = $('#bubble');
  const names = { bold: t('加粗', 'Bold'), italic: t('斜体', 'Italic'), mark: t('高亮', 'Highlight'), 'inline-code': t('代码', 'Code'), link: t('链接', 'Link') };
  [['bold', '<b>B</b>'], ['italic', '<i style="font-family:var(--serif-font)">I</i>'], ['mark', '<span style="background:var(--mark);padding:0 4px;border-radius:3px">A</span>'],
    ['inline-code', '&lt;/&gt;'], ['link', ICONS.link]].forEach(([cmd, html]) => {
    const el = document.createElement('button');
    el.innerHTML = html;
    el.dataset.tip = ctx.tipFor(names[cmd], cmd);
    el.onmousedown = (e) => { e.preventDefault(); ctx.run(cmd); setTimeout(place, 60); };
    bubble.append(el);
  });
  function place() {
    const r = editor.mode === 'live' && editor.hasFocus() && $('#palette').hidden ? editor.selectionRect() : null;
    if (!r || r.multiline || !editor.selectionText().trim()) { bubble.hidden = true; return; }
    bubble.hidden = false;
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight, hb = $('#editor-wrap').getBoundingClientRect();
    let top = r.top - bh - 8;
    if (top < hb.top + 4) top = r.bottom + 8;
    bubble.style.left = Math.min(hb.right - bw - 8, Math.max(hb.left + 8, (r.left + r.right) / 2 - bw / 2)) + 'px';
    bubble.style.top = top + 'px';
  }
  document.addEventListener('mouseup', () => setTimeout(place, 10));
  document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') place(); else bubble.hidden = true; });
  document.addEventListener('mousedown', (e) => { if (!bubble.contains(e.target)) bubble.hidden = true; });
  editor.onScroll(() => { bubble.hidden = true; });
  return { hide: () => { bubble.hidden = true; } };
}

// ---------------- command palette ----------------
const THEMES = [['daylight', '象牙 Ivory'], ['paper', '纸张 Paper'], ['mint', '鼠尾草 Sage'], ['slate', '暖夜 Dusk'], ['midnight', '深夜 Night']];
export function initPalette(ctx) {
  const { editor, state, api } = ctx;
  const ITEMS = [
    ['new-doc', null, '新建文档', 'New Document'], ['close-doc', null, '关闭文档', 'Close Document'],
    ['save', null, '保存', 'Save'], ['save-as', null, '另存为…', 'Save As…'],
    ['export', 'pdf', '导出 PDF', 'Export PDF'], ['export', 'html', '导出 HTML', 'Export HTML'], ['print', null, '打印…', 'Print…'],
    ['mindmap', null, '思维导图', 'Toggle Mind Map'], ['preview', null, '正式稿', 'Toggle Final View'],
    ['island-move', -1, '把当前浮岛移到左边', 'Move Island Left'], ['island-move', 1, '把当前浮岛移到右边', 'Move Island Right'],
    ['source', null, '源代码模式', 'Toggle Source Code Mode'], ['split', null, '分栏：源码 + 展示', 'Split: Source + Preview'],
    ['invisibles', null, '显示空格、Tab 和换行符', 'Show Invisible Characters'], ['sidebar', null, '显示 / 隐藏侧边栏', 'Toggle Sidebar'],
    ['outline', null, '大纲', 'Outline'], ['files', null, '文件树', 'File Tree'], ['open-folder', null, '打开文件夹…', 'Open Folder…'],
    ['focus', null, '专注模式', 'Focus Mode'], ['typewriter', null, '打字机模式', 'Typewriter Mode'],
    ['find', null, '查找', 'Find'], ['replace', null, '替换', 'Replace'],
    ...[1, 2, 3, 4, 5, 6].map((n) => ['heading', n, `${'一二三四五六'[n - 1]}级标题`, `Heading ${n}`]),
    ['heading', 0, '段落', 'Paragraph'],
    ['table', null, '插入表格', 'Insert Table'], ['code-block', null, '代码块', 'Code Block'],
    ['code-highlight', null, '代码块：高亮所在行', 'Code Block: Highlight Lines'], ['code-fold', null, '代码块：折叠 / 展开', 'Code Block: Fold / Unfold'],
    ['code-compare', null, '代码块：与另一个对比', 'Code Block: Compare with Another'], ['math-block', null, '公式块', 'Math Block'],
    ['quote', null, '引用', 'Quote'], ['ordered-list', null, '有序列表', 'Ordered List'], ['list', null, '无序列表', 'Unordered List'],
    ['check', null, '任务列表', 'Task List'], ['line', null, '水平分割线', 'Horizontal Line'], ['toc', null, '插入目录', 'Insert Table of Contents'],
    ['bold', null, '加粗', 'Strong'], ['italic', null, '斜体', 'Emphasis'], ['underline', null, '下划线', 'Underline'],
    ['strike', null, '删除线', 'Strike'], ['mark', null, '高亮', 'Highlight'], ['inline-code', null, '行内代码', 'Inline Code'],
    ['inline-math', null, '行内公式', 'Inline Math'], ['link', null, '超链接', 'Hyperlink'], ['image', null, '插入图像…', 'Insert Image…'],
    ['conflict-reload', null, '从磁盘重新加载', 'Reload from Disk'], ['conflict-overwrite', null, '覆盖磁盘上的文件（保存冲突时）', 'Overwrite File on Disk (after a save conflict)'],
    ['copy-md', null, '拷贝为 Markdown', 'Copy as Markdown'], ['footnote', null, '插入脚注', 'Insert Footnote'],
    ['settings', null, '偏好设置…', 'Settings…'], ['search', null, '在文件夹中搜索', 'Search in Folder'], ['history', null, '历史版本', 'Version History'],
    ['export', 'docx', '导出 Word', 'Export Word'], ['export', 'png', '导出图片 (PNG)', 'Export Image (PNG)'], ['undo', null, '撤销', 'Undo'], ['redo', null, '重做', 'Redo'],
    ['zoom', 1, '放大', 'Zoom In'], ['zoom', -1, '缩小', 'Zoom Out'], ['zoom', 0, '实际大小', 'Actual Size'],
    ...THEMES.map(([id, label]) => ['theme', id, '主题：' + label, 'Theme: ' + label]),
  ];
  const pal = { items: [], sel: 0 };
  const fuzzy = (q, s) => {
    if (!q) return 1;
    s = s.toLowerCase();
    const at = s.indexOf(q);
    if (at >= 0) return 100 - at;
    let i = 0;
    for (const ch of s) if (ch === q[i]) i++;
    return i === q.length ? 1 : 0;
  };
  const flat = (nodes, out = []) => { for (const n of nodes) n.dir ? flat(n.children, out) : out.push(n); return out; };

  function open() {
    ctx.bubble.hide();
    $('#palette').hidden = false;
    const inp = $('#palette-input');
    inp.value = '';
    inp.placeholder = t('输入命令或文件名…', 'Type a command or file name…');
    $('#palette-foot').textContent = t('↑↓ 选择　　↵ 执行　　esc 关闭', '↑↓ navigate    ↵ run    esc close');
    inp.focus();
    fill();
  }
  function close() { $('#palette').hidden = true; editor.focus(); }
  function fill() {
    const q = $('#palette-input').value.trim().toLowerCase();
    const items = [];
    // documents already open in this window come first
    for (const d of ctx.docs.list()) {
      if (d === ctx.docs.active()) continue;
      const name = ctx.docs.name(d), score = fuzzy(q, name);
      if (score) items.push({ score: score + 200, kind: '●', name, hint: t('已打开', 'Open'), go: () => ctx.docs.activate(d) });
    }
    for (const [cmd, arg, z, e] of ITEMS) {
      const score = Math.max(fuzzy(q, z), fuzzy(q, e));
      if (score) items.push({ score: score + 0.5, kind: '›', name: t(z, e), hint: ctx.shortcutFor(cmd, arg), go: () => ctx.run(cmd, arg) });
    }
    for (const f of flat(ctx.sidebar.files())) {
      const score = fuzzy(q, f.name);
      if (score && !ctx.docs.isOpen(f.path)) items.push({ score, kind: '≡', name: f.name, hint: state.folder ? dirname(f.path).replace(state.folder, '').replace(/^\//, '') : '', go: () => api.openInWindow(f.path, null, { preview: false }) });
    }
    if (q) items.sort((a, b) => b.score - a.score);
    pal.items = items.slice(0, 60);
    pal.sel = 0;
    const list = $('#palette-list');
    list.textContent = '';
    if (!pal.items.length) { const e = document.createElement('div'); e.className = 'palette-empty'; e.textContent = t('没有匹配项', 'No matches'); list.append(e); return; }
    pal.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'palette-item' + (i === 0 ? ' sel' : '');
      for (const [cls, txt] of [['kind', it.kind], ['name', it.name], ['hint', it.hint]]) { const s = document.createElement('span'); s.className = cls; s.textContent = txt; row.append(s); }
      row.onmousemove = () => select(i);
      row.onclick = () => pick(i);
      list.append(row);
    });
  }
  function select(i) {
    const rows = $('#palette-list').children;
    if (!rows.length || !pal.items.length) return;
    pal.sel = (i + pal.items.length) % pal.items.length;
    [...rows].forEach((r, j) => r.classList.toggle('sel', j === pal.sel));
    rows[pal.sel].scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const it = pal.items[i];
    if (!it) return;
    close();
    setTimeout(() => it.go(), 0);
  }
  $('#palette-input').oninput = fill;
  $('#palette-input').onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(pal.sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(pal.sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(pal.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    e.stopPropagation();
  };
  $('#palette').onmousedown = (e) => { if (e.target.id === 'palette') close(); };
  return { open, close, isOpen: () => !$('#palette').hidden };
}
