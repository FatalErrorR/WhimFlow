// Search every Markdown file in the open folder (left island, third tab).
import { $, t } from '../util.js';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initSearch(ctx) {
  const { api, state } = ctx;
  const input = $('#search-input'), results = $('#search-results'), status = $('#search-status');
  const opts = { caseSensitive: false, word: false, regex: false };
  input.placeholder = t('在文件夹中搜索', 'Search in folder');
  const tips = { caseSensitive: t('区分大小写', 'Match case'), word: t('全字匹配', 'Whole word'), regex: t('正则表达式', 'Regular expression') };
  document.querySelectorAll('#search .search-opt').forEach((b) => {
    b.dataset.tip = tips[b.dataset.opt];
    b.onclick = () => { opts[b.dataset.opt] = !opts[b.dataset.opt]; b.classList.toggle('on', opts[b.dataset.opt]); run(); };
  });
  let timer, seq = 0;
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); }
    if (e.key === 'Escape') { e.preventDefault(); ctx.editor.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); const first = results.querySelector('.hit'); if (first) first.focus(); }
  };

  async function run() {
    const q = input.value;
    const my = ++seq;
    results.textContent = '';
    if (!state.folder) {
      status.textContent = '';
      const e = document.createElement('div'); e.className = 'side-empty';
      e.textContent = t('打开一个文件夹，就能搜索里面所有的文档。', 'Open a folder to search all of its documents.');
      results.append(e);
      return;
    }
    if (!q) { status.textContent = ''; return; }
    status.textContent = t('搜索中…', 'Searching…');
    const r = await api.search({ folder: state.folder, query: q, opts });
    if (my !== seq || !r || r.canceled) return;
    if (r.code === 'timeout') { status.textContent = t('搜索超时：表达式太复杂或文件太多，已停止', 'Search timed out (the expression is too complex or there are too many files), so it was stopped'); return; }
    if (r.error) { status.textContent = (r.code === 'invalid' ? t('表达式有误：', 'Invalid expression: ') : t('搜索失败：', 'Search failed: ')) + r.error; return; }
    status.textContent = r.total
      ? t(`${r.files.length} 个文件 · ${r.total} 处${r.capped ? '（已截断）' : ''}`, `${r.total} in ${r.files.length} file${r.files.length > 1 ? 's' : ''}${r.capped ? ' (capped)' : ''}`)
      : t('没有找到', 'No results');
    for (const f of r.files) {
      const group = document.createElement('div'); group.className = 'hit-file';
      const head = document.createElement('div'); head.className = 'hit-head';
      head.innerHTML = `<span class="name">${esc(f.name.replace(/\.(md|markdown)$/i, ''))}</span><span class="dir">${esc(f.rel)}</span><span class="count">${f.matches.length}</span>`;
      head.onclick = () => group.classList.toggle('collapsed');
      group.append(head);
      for (const m of f.matches) {
        const row = document.createElement('button'); row.className = 'hit';
        const s = m.text;
        row.innerHTML = `<span class="ln">${m.line}</span><span class="txt">${esc(s.slice(0, m.at))}<mark>${esc(s.slice(m.at, m.at + m.len))}</mark>${esc(s.slice(m.at + m.len))}</span>`;
        row.onclick = () => api.openInWindow(f.path, { line: m.line, col: m.col, len: m.len }, { preview: true });
        row.onkeydown = (e) => {
          const all = [...results.querySelectorAll('.hit')], i = all.indexOf(row);
          if (e.key === 'ArrowDown' && all[i + 1]) { e.preventDefault(); all[i + 1].focus(); }
          if (e.key === 'ArrowUp') { e.preventDefault(); (all[i - 1] || input).focus(); }
        };
        group.append(row);
      }
      results.append(group);
    }
  }
  function open() {
    ctx.sidebar.setSidebar(true, 'search');
    const sel = ctx.editor.selectionText();
    if (sel && !sel.includes('\n')) input.value = sel;
    input.focus(); input.select();
    run();
  }
  return { open, run };
}
