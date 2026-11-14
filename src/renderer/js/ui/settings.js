// Preferences: one quiet sheet. Every change applies immediately, in every window.
import { $, t } from '../util.js';
import { setLineBreaks } from '../render.js';

/** One line about the sync, for Settings and the sidebar. */
export function syncText(s, short = false) {
  if (!s || s.state === 'off') return short ? '' : t('未连接服务器', 'Not connected');
  if (s.state === 'syncing') return t('正在同步…', 'Syncing…');
  if (s.state === 'offline') return short ? t('离线', 'Offline') : t('连不上服务器，有网时会自动同步', 'Offline; syncs again when the server is reachable');
  if (s.state === 'auth') return short ? t('同步出错', 'Sync error') : t('服务器不接受这个令牌，请断开后重新连接', 'The server refused the token; disconnect and connect again');
  if (s.state === 'error') return short ? t('同步出错', 'Sync error') : t('同步出错：', 'Sync error: ') + (s.message || '');
  const at = s.at ? new Date(s.at).toLocaleTimeString(t('zh-CN', 'en-US'), { hour: '2-digit', minute: '2-digit' }) : '';
  return t('已同步', 'Synced') + (at && !short ? ' ' + at : '');
}

const THEMES = [['daylight', '象牙', 'Ivory'], ['paper', '纸张', 'Paper'], ['mint', '鼠尾草', 'Sage'], ['slate', '暖夜', 'Dusk'], ['midnight', '深夜', 'Night']];

export function initSettings(ctx) {
  const { api } = ctx;
  const root = $('#settings');
  let current = { ...ctx.env.settings };

  const field = (label, hint, control) => {
    const row = document.createElement('div'); row.className = 'set-row';
    const l = document.createElement('div'); l.className = 'set-label';
    const a = document.createElement('div'); a.textContent = label; l.append(a);
    if (hint) { const h = document.createElement('div'); h.className = 'set-hint'; h.textContent = hint; l.append(h); }
    row.append(l, control);
    return row;
  };
  const set = (k, v) => { current[k] = v; api.setSetting(k, v); };
  const segmented = (k, options) => {
    const box = document.createElement('div'); box.className = 'seg';
    for (const [value, label] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = current[k] === value ? 'on' : '';
      b.onclick = () => { set(k, value); box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
      box.append(b);
    }
    return box;
  };
  const slider = (k, min, max, step, fmt) => {
    const box = document.createElement('div'); box.className = 'slider';
    const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = current[k];
    const out = document.createElement('span'); out.textContent = fmt(current[k]);
    r.oninput = () => { const v = +r.value; out.textContent = fmt(v); set(k, v); };
    box.append(r, out);
    return box;
  };
  const toggle = (k) => {
    const b = document.createElement('button');
    b.className = 'switch' + (current[k] ? ' on' : '');
    b.setAttribute('role', 'switch');
    b.onclick = () => { set(k, !current[k]); b.classList.toggle('on', current[k]); };
    return b;
  };
  const text = (k, presets) => {
    const box = document.createElement('div'); box.className = 'textset';
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = current[k]; inp.spellcheck = false;
    inp.onchange = () => set(k, inp.value.trim() || './assets');
    box.append(inp);
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const [v, label] of presets) {
      const c = document.createElement('button'); c.textContent = label; c.dataset.tip = v;
      c.onclick = () => { inp.value = v; set(k, v); };
      chips.append(c);
    }
    box.append(chips);
    return box;
  };
  const section = (title) => { const h = document.createElement('div'); h.className = 'set-section eyebrow'; h.textContent = title; return h; };

  // ---------- sync (the desktop and the iPhone app answer the same calls) ----------
  const syncBox = document.createElement('div');
  const button = (label, fn, cls = '') => { const b = document.createElement('button'); b.className = 'set-btn ' + cls; b.textContent = label; b.onclick = fn; return b; };
  const input = (type, placeholder) => { const i = document.createElement('input'); i.type = type; i.placeholder = placeholder; i.spellcheck = false; i.autocapitalize = 'off'; i.autocomplete = 'off'; return i; };
  const wrap = (...kids) => { const b = document.createElement('div'); b.className = 'textset'; b.append(...kids); return b; };
  async function renderSync() {
    if (!api.syncConfig) { syncBox.textContent = ''; return; }
    const cfg = await api.syncConfig();
    syncBox.textContent = '';
    if (cfg.url) {
      const state = document.createElement('span'); state.className = 'sync-state'; state.textContent = syncText(cfg.status);
      const row = document.createElement('div'); row.className = 'sync-actions';
      row.append(state,
        button(t('立即同步', 'Sync now'), () => api.syncNow()),
        button(t('断开', 'Disconnect'), async () => {
          if (!window.confirm(t('断开后不再同步。本机和服务器上的文件都会保留。', 'Stop syncing? The files stay, here and on the server.'))) return;
          await api.syncDisconnect(); renderSync();
        }));
      syncBox.append(field(t('服务器', 'Server'), cfg.url.replace(/^https:\/\//, ''), row));
      return;
    }
    const url = input('text', 'whimflow.example.com'), token = input('password', t('令牌', 'Token'));
    const msg = document.createElement('div'); msg.className = 'sync-msg';
    const go = button(t('连接', 'Connect'), async () => {
      msg.textContent = t('正在连接…', 'Connecting…'); go.disabled = true;
      const r = await api.syncConnect({ url: url.value, token: token.value });
      go.disabled = false;
      if (r && r.ok) { renderSync(); return; }
      msg.textContent = ({
        url: t('地址不对（需要 https）', 'Not a valid address (https is required)'),
        token: t('请填写令牌', 'Enter the token'),
        auth: t('服务器不接受这个令牌', 'The server refused this token'),
        offline: t('连不上这个服务器', 'Could not reach this server'),
      })[r && r.error] || t('连接失败：', 'Could not connect: ') + ((r && r.message) || '');
    }, 'primary');
    token.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    syncBox.append(
      field(t('服务器地址', 'Server address'), t('你的 WhimFlow 同步服务器', 'Your WhimFlow sync server'), wrap(url)),
      field(t('令牌', 'Token'), t('服务器上生成的访问令牌，只需填一次', 'The access token from the server; entered once'), wrap(token, go, msg)),
    );
  }
  if (api.onSyncStatus) api.onSyncStatus((st) => { const el = syncBox.querySelector('.sync-state'); if (el) el.textContent = syncText(st); });

  function build() {
    const body = root.querySelector('.set-body');
    body.textContent = '';
    body.append(
      section(t('同步', 'Sync')),
      syncBox,
      section(t('外观', 'Appearance')),
      field(t('主题', 'Theme'), null, segmented('theme', THEMES.map(([id, z, e]) => [id, t(z, e)]))),
      field(t('正文字体', 'Text font'), null, segmented('docFont', [['serif', t('衬线', 'Serif')], ['sans', t('无衬线', 'Sans')], ['system', t('系统', 'System')]])),
      field(t('字号', 'Font size'), null, slider('fontSize', 13, 24, 1, (v) => v + ' px')),
      field(t('行距', 'Line height'), null, slider('lineHeight', 1.4, 2.2, 0.05, (v) => v.toFixed(2))),
      field(t('行宽', 'Line width'), t('正文一行最多多宽', 'How wide a line of text may get'), slider('lineWidth', 560, 1200, 20, (v) => (v >= 1200 ? t('不限', 'Full') : v + ' px'))),
      section(t('编辑', 'Editing')),
      field(t('自动配对括号和引号', 'Close brackets and quotes'), null, toggle('closeBrackets')),
      field(t('缩进宽度', 'Indent width'), null, segmented('indent', [[2, '2'], [4, '4']])),
      field(t('单个换行', 'Single line breaks'), t('开：按一次回车，正式稿和导出里也换行。关：严格按 Markdown 标准，连成一行，空一行才分段', 'On: one Enter is a new line in the final view and exports too. Off: strict Markdown, joined into one line until a blank line'), toggle('lineBreaks')),
      field(t('显示不可见字符', 'Show invisible characters'), t('用很淡的符号画出空格、Tab 和换行', 'Faint marks for spaces, tabs and line breaks'), toggle('showInvisibles')),
      field(t('拼写检查', 'Spell check'), null, toggle('spellcheck')),
      field(t('自动保存', 'Auto save'), t('停止输入后自动写入文件', 'Write to the file shortly after you stop typing'), toggle('autoSave')),
      field(t('自动保存间隔', 'Auto save delay'), null, slider('autoSaveDelay', 1, 30, 1, (v) => v + t(' 秒', ' s'))),
      section(t('图片', 'Images')),
      field(t('插入图片时', 'When inserting an image'), null, segmented('imageCopy', [[true, t('复制到图片文件夹', 'Copy to image folder')], [false, t('保留原位置', 'Keep where it is')]])),
      field(t('图片文件夹', 'Image folder'), t('相对于文档所在位置；${filename} 代表文档名', 'Relative to the document; ${filename} is its name'),
        text('imageFolder', [['./assets', './assets'], ['./${filename}.assets', './${filename}.assets'], ['.', t('文档旁边', 'Next to it')]])),
      field(t('使用相对路径', 'Use relative paths'), t('文档和图片一起移动时链接不会断', 'Links survive moving the folder'), toggle('imageRelative')),
      section(t('安全网', 'Safety net')),
      field(t('自动保留草稿', 'Keep drafts'), t('程序意外退出后，下次打开会恢复未保存的内容', 'Unsaved text comes back after a crash'), toggle('drafts')),
      field(t('保存历史版本', 'Keep version history'), t('每次保存留一份快照，可随时回看或恢复', 'A snapshot on every save, to look back or restore'), toggle('history')),
      field(t('每个文件最多保留', 'Versions kept per file'), null, slider('historyKeep', 10, 200, 10, (v) => v + t(' 份', ''))),
      section(t('语言', 'Language')),
      field(t('界面语言', 'Interface language'), t('重新打开窗口后生效', 'Takes effect in new windows'), segmented('language', [['auto', t('跟随系统', 'System')], ['zh', '中文'], ['en', 'English']])),
    );
  }
  function open() { current = { ...ctx.state.settings }; build(); renderSync(); root.hidden = false; root.querySelector('.set-sheet').focus(); }
  function close() { root.hidden = true; ctx.editor.focus(); }
  root.querySelector('.set-close').onclick = close;
  root.querySelector('.set-close').dataset.tip = t('关闭', 'Close') + '  Esc';
  root.querySelector('.set-title').textContent = t('偏好设置', 'Settings');
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  return { open, close, isOpen: () => !root.hidden };
}

/** Apply settings to this window: typography, editor behaviour, saving. */
export function applySettings(ctx, s) {
  const root = document.documentElement.style;
  root.setProperty('--doc-size', s.fontSize + 'px');
  root.setProperty('--line-height', s.lineHeight);
  root.setProperty('--line-width', s.lineWidth >= 1200 ? '100%' : s.lineWidth + 'px');
  const fonts = { sans: 'var(--ui-font)', system: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' };
  if (fonts[s.docFont]) root.setProperty('--doc-font', fonts[s.docFont]); else root.removeProperty('--doc-font');
  ctx.editor.configure({ closeBrackets: s.closeBrackets, indent: s.indent, spellcheck: s.spellcheck, invisibles: !!s.showInvisibles });
  // single line breaks: the final view (and later exports) render with the new rule
  if (setLineBreaks(s.lineBreaks !== false) && ctx.right) ctx.right.refresh(true);
  ctx.editor.view.requestMeasure();
}
