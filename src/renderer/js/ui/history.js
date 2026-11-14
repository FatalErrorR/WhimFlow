// Version history (right island, third tab): every save is a snapshot; pick one to
// see what changed since, and restore it as a single undoable edit.
import { $, t, toast } from '../util.js';
import { diffLines } from 'diff';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function when(ms) {
  const d = new Date(ms), now = new Date();
  const hm = d.toLocaleTimeString(t('zh-CN', 'en-US'), { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return t('今天 ', 'Today ') + hm;
  if (diff === 1) return t('昨天 ', 'Yesterday ') + hm;
  return d.toLocaleDateString(t('zh-CN', 'en-US'), { month: 'short', day: 'numeric' }) + ' ' + hm;
}

export function initHistory(ctx) {
  const { api, editor } = ctx;
  const list = $('#hist-list'), detail = $('#hist-detail');
  let open = null, seq = 0;
  // Every request belongs to one document (and its path at the time). A newer render, or
  // a different document in front, makes older answers worthless: they are dropped.
  const target = () => { const doc = ctx.docs.active(); return { doc, path: doc && doc.filePath }; };
  const current = (req) => req.my === seq && ctx.docs.active() === req.doc && req.doc.filePath === req.path;

  async function render() {
    const req = { ...target(), my: ++seq };
    open = null;
    detail.hidden = true; list.hidden = false;
    list.textContent = '';
    if (!req.path) {
      const e = document.createElement('div'); e.className = 'side-empty';
      e.textContent = t('保存这篇文档后，每次保存都会留下一个版本。', 'Once this document is saved, every save leaves a version here.');
      list.append(e);
      return;
    }
    const items = (await api.historyList(req.path)) || [];
    if (!current(req)) return;
    if (!items.length) {
      const e = document.createElement('div'); e.className = 'side-empty';
      e.textContent = t('还没有历史版本。', 'No versions yet.');
      list.append(e);
      return;
    }
    const cur = editor.getValue();
    for (const [i, it] of items.entries()) {
      const row = document.createElement('button'); row.className = 'hist-item';
      const text = await api.historyRead(req.path, it.id);
      if (!current(req)) return;
      let add = 0, del = 0;
      if (text != null) for (const p of diffLines(text, cur)) { if (p.added) add += p.count; if (p.removed) del += p.count; }
      const same = add + del === 0;
      row.innerHTML = `<span class="when">${esc(when(it.time))}</span><span class="delta">${same ? `<em>${esc(t('与当前相同', 'Same as now'))}</em>` : `<b class="add">+${add}</b><b class="del">−${del}</b>`}</span>${i === 0 ? `<span class="tag">${esc(t('最近保存', 'Last saved'))}</span>` : ''}`;
      row.onclick = () => show(it, text, req);
      list.append(row);
    }
  }

  function show(it, text, req) {
    if (text == null || !current(req)) return;
    open = { it, text, req };
    list.hidden = true; detail.hidden = false;
    detail.textContent = '';
    const bar = document.createElement('div'); bar.className = 'hist-bar';
    const back = document.createElement('button'); back.textContent = '← ' + t('全部版本', 'All versions'); back.onclick = render;
    const title = document.createElement('span'); title.className = 'when'; title.textContent = when(it.time);
    const restore = document.createElement('button'); restore.className = 'primary'; restore.textContent = t('恢复到这个版本', 'Restore this version');
    restore.onclick = () => {
      // only ever into the document this version belongs to
      if (ctx.docs.active() !== req.doc || req.doc.filePath !== req.path) {
        toast(t('这是另一篇文档的历史版本，没有恢复', 'That version belongs to another document; nothing was restored'));
        render();
        return;
      }
      editor.replaceAll(text, 'input.restore');
      ctx.refreshViews();
      toast(t('已恢复。⌘Z 可以撤销', 'Restored. ⌘Z to undo').replace('⌘', ctx.env.isMac ? '⌘' : 'Ctrl+'));
      render();
    };
    bar.append(back, title, restore);
    const legend = document.createElement('div'); legend.className = 'hist-legend eyebrow';
    legend.textContent = t('从这个版本到现在的变化', 'What changed since this version');
    const view = document.createElement('div'); view.className = 'hist-diff';
    const parts = diffLines(text, editor.getValue());
    if (parts.every((p) => !p.added && !p.removed)) { const e = document.createElement('div'); e.className = 'side-empty'; e.textContent = t('和当前内容完全相同。', 'Identical to the current text.'); view.append(e); }
    else for (const p of parts) {
      const lines = p.value.replace(/\n$/, '').split('\n');
      if (!p.added && !p.removed && lines.length > 6) {
        for (const l of lines.slice(0, 2)) view.append(line(' ', l, 'ctx'));
        const gap = document.createElement('div'); gap.className = 'gap';
        gap.textContent = t(`… ${lines.length - 4} 行未改动 …`, `… ${lines.length - 4} unchanged lines …`);
        view.append(gap);
        for (const l of lines.slice(-2)) view.append(line(' ', l, 'ctx'));
      } else for (const l of lines) view.append(line(p.added ? '+' : p.removed ? '−' : ' ', l, p.added ? 'add' : p.removed ? 'del' : 'ctx'));
    }
    detail.append(bar, legend, view);
  }
  function line(sign, text, cls) {
    const d = document.createElement('div'); d.className = 'dl ' + cls;
    const s = document.createElement('span'); s.className = 'sign'; s.textContent = sign;
    const tx = document.createElement('span'); tx.textContent = text || ' ';
    d.append(s, tx);
    return d;
  }
  return { render, refresh: () => { if (!detail.hidden && open && current(open.req)) show(open.it, open.text, open.req); else render(); } };
}
