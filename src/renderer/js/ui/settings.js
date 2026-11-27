// Preferences: one quiet sheet. Every change applies immediately, in every window.
import { $, t, prompt } from '../util.js';
import { setLineBreaks } from '../render.js';

/** 1536 -> "1.5 KB", 1073741824 -> "1 GB" */
export function sizeText(n) {
  if (!(n >= 0)) return '';
  const u = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]].find(([, v]) => n >= v);
  if (!u) return n + ' B';
  const x = n / u[1];
  return (x >= 100 || Number.isInteger(x) ? Math.round(x) : x.toFixed(1)) + ' ' + u[0];
}

/** One line about the sync, for Settings and the sidebar. */
export function syncText(s, short = false) {
  if (!s || s.state === 'off') return short ? '' : t('未连接服务器', 'Not connected');
  if (s.state === 'syncing') return t('正在同步…', 'Syncing…');
  if (s.state === 'offline') return short ? t('离线', 'Offline') : t('连不上服务器，有网时会自动同步', 'Offline; syncs again when the server is reachable');
  if (s.state === 'auth') return short ? t('需要重新登录', 'Sign in again') : t('登录已失效，请重新登录', 'Signed out; sign in again');
  if (s.state === 'quota') return short ? t('空间已满', 'Space full') : t(`空间已满（已用 ${sizeText(s.used)} / ${sizeText(s.quota)}），新的改动暂时传不上去`, `Space full (${sizeText(s.used)} of ${sizeText(s.quota)}); new changes wait`);
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
  /** A switch for a true/false setting; `invert`: the switch is on when the setting is false. */
  const toggle = (k, invert = false) => {
    const b = document.createElement('button');
    const on = () => (invert ? !current[k] : !!current[k]);
    b.className = 'switch' + (on() ? ' on' : '');
    b.setAttribute('role', 'switch');
    b.onclick = () => { set(k, !current[k]); b.classList.toggle('on', on()); };
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
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const row = (...kids) => { const b = el('div', 'sync-actions'); b.append(...kids); return b; };
  const msgBox = () => el('div', 'sync-msg');
  const ERR = {
    url: () => t('地址不对（需要 https）', 'Not a valid address (https is required)'),
    name: () => t('请填写用户名和密码', 'Enter the name and the password'),
    wrong: () => t('用户名或密码不对', 'Wrong name or password'),
    disabled: () => t('这个账号已被停用', 'This account is disabled'),
    setup: () => t('这个服务器还没有账号：请在已经连上它的设备上，到「设置 → 同步」创建管理员账号', 'This server has no accounts yet: create the administrator’s on a device already connected to it'),
    offline: () => t('连不上这个服务器', 'Could not reach this server'),
    password: () => t('密码至少 8 位', 'At least 8 characters'),
    taken: () => t('这个用户名已经有人用了', 'This name is taken'),
    quota: () => t('空间大小不对', 'Not a valid size'),
  };
  const errText = (r) => (r && r.error === 'locked' ? t(`输错太多次，请 ${Math.ceil((r.retryAfter || 900) / 60)} 分钟后再试`, `Too many tries; try again in ${Math.ceil((r.retryAfter || 900) / 60)} min`)
    : (ERR[r && r.error] || (() => t('出错了：', 'Something went wrong: ') + ((r && r.message) || '')))());
  const SIZES = [[500 * 1024 ** 2, '500 MB'], [1024 ** 3, '1 GB'], [5 * 1024 ** 3, '5 GB'], [10 * 1024 ** 3, '10 GB']];

  async function renderSync() {
    if (!api.syncConfig) { syncBox.textContent = ''; return; }
    const cfg = await api.syncConfig();
    syncBox.textContent = '';
    if (cfg.url && cfg.status.state !== 'auth') {
      const me = api.syncAccount ? await api.syncAccount('me') : { ok: false, error: 'setup' };
      if (me.ok) return renderAccount(cfg, me.result);
      if (me.error === 'setup') return renderSetup(cfg);
      return renderServerOnly(cfg); // offline: what is known
    }
    renderLogin(cfg);
  }
  const stateLine = (cfg) => el('span', 'sync-state', syncText(cfg.status));
  const syncNowBtn = () => button(t('立即同步', 'Sync now'), () => api.syncNow());
  const signOutBtn = (label) => button(label, async () => {
    if (!window.confirm(t('退出后本机不再同步。本机和服务器上的文件都会保留。', 'Stop syncing on this device? The files stay, here and on the server.'))) return;
    await api.syncDisconnect(); renderSync();
  });

  /** Not signed in (or signed out by the server): the address, the name, the password. */
  function renderLogin(cfg) {
    const url = input('text', 'whimflow.example.com'), name = input('text', t('用户名', 'Name')), pass = input('password', t('密码', 'Password'));
    url.value = cfg.url ? cfg.url.replace(/^https:\/\//, '') : '';
    const msg = msgBox();
    if (cfg.url && cfg.status.state === 'auth') msg.textContent = t('登录已失效，请重新登录', 'Signed out; sign in again');
    const go = button(t('登录', 'Sign in'), async () => {
      msg.textContent = t('正在登录…', 'Signing in…'); go.disabled = true;
      const r = await api.syncConnect({ url: url.value, name: name.value, password: pass.value });
      go.disabled = false;
      if (r && r.ok) { renderSync(); return; }
      msg.textContent = errText(r);
    }, 'primary');
    pass.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    syncBox.append(
      field(t('服务器地址', 'Server address'), t('你的 WhimFlow 同步服务器', 'Your WhimFlow sync server'), wrap(url)),
      field(t('账号', 'Account'), t('由服务器的管理员创建；每台设备登录一次', 'Made by the server’s administrator; sign in once per device'), wrap(name, pass, go, msg)),
    );
  }

  /** Connected with the shared token to a server without accounts: make the administrator's. */
  function renderSetup(cfg) {
    syncBox.append(field(t('服务器', 'Server'), cfg.url.replace(/^https:\/\//, ''), row(stateLine(cfg), syncNowBtn(), signOutBtn(t('断开', 'Disconnect')))));
    const name = input('text', t('管理员用户名', 'Administrator name')), pass = input('password', t('密码（至少 8 位）', 'Password (8 or more)')), again = input('password', t('再输一次密码', 'The password again'));
    const msg = msgBox();
    const go = button(t('创建管理员账号', 'Create the administrator'), async () => {
      if (pass.value !== again.value) { msg.textContent = t('两次输入的密码不一样', 'The passwords differ'); return; }
      msg.textContent = t('正在创建…', 'Creating…'); go.disabled = true;
      const r = await api.syncSetup({ name: name.value, password: pass.value });
      go.disabled = false;
      if (r && r.ok) { renderSync(); return; }
      msg.textContent = errText(r);
    }, 'primary');
    syncBox.append(field(t('升级为账号登录', 'Switch to accounts'),
      t('这个服务器还在用共享令牌。创建管理员账号后，现在的文件库归这个账号所有，其他设备改用用户名和密码登录，令牌作废', 'This server still uses the shared token. The library becomes the administrator’s; other devices then sign in by name and password, and the token stops working'),
      wrap(name, pass, again, go, msg)));
  }

  function renderServerOnly(cfg) {
    syncBox.append(field(t('服务器', 'Server'), cfg.url.replace(/^https:\/\//, ''), row(stateLine(cfg), syncNowBtn(), signOutBtn(t('退出登录', 'Sign out')))));
  }

  /** Signed in: the account, its space, its devices, the password; the administrator's accounts. */
  function renderAccount(cfg, acc) {
    syncBox.append(field(acc.name + (acc.admin ? t('（管理员）', ' (administrator)') : ''), cfg.url.replace(/^https:\/\//, ''),
      row(stateLine(cfg), syncNowBtn(), signOutBtn(t('退出登录', 'Sign out')))));
    const pct = acc.quota ? Math.min(100, Math.round(acc.used / acc.quota * 100)) : 0;
    const bar = el('div', 'sync-usage' + (pct >= 90 ? ' full' : '')); const fill = el('i'); fill.style.width = pct + '%'; bar.append(fill);
    syncBox.append(field(t('空间', 'Space'), t(`已用 ${sizeText(acc.used)} / ${sizeText(acc.quota)}`, `${sizeText(acc.used)} of ${sizeText(acc.quota)} used`), bar));
    // what takes the space: the largest files (a document opens on a click), and the trash
    const big = el('div', 'sync-devices sync-big');
    const bigRow = field(t('占用最多', 'Largest files'), t('正在统计…', 'Counting…'), big);
    syncBox.append(bigRow);
    api.syncAccount('space').then((r) => {
      const hint = bigRow.querySelector('.set-hint');
      if (!r.ok) { hint.textContent = errText(r); return; }
      const sp = r.result;
      hint.textContent = t(`共 ${sp.files} 个文件` + (sp.trash ? `；回收站 ${sizeText(sp.trash)}，不占空间，${sp.trashDays} 天后自动清空` : ''),
        `${sp.files} file(s)` + (sp.trash ? `; ${sizeText(sp.trash)} in the trash, not counted, emptied after ${sp.trashDays} days` : ''));
      for (const f of sp.largest.slice(0, 8)) {
        const line = el('div', 'sync-device');
        const name = el(/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(f.path) && cfg.library ? 'button' : 'span', 'sync-file', f.path);
        if (name.tagName === 'BUTTON') name.onclick = () => { close(); api.openPath(cfg.library.replace(/[\\/]+$/, '') + '/' + f.path); };
        line.append(name, el('em', '', sizeText(f.size)));
        big.append(line);
      }
      if (!sp.largest.length) big.append(el('em', '', t('还没有文件', 'No files yet')));
    });
    // recently deleted (on any device): back where it was, then it syncs to every device
    const gone = el('div', 'sync-devices sync-gone');
    const goneRow = field(t('最近删除', 'Recently deleted'), t('正在读取…', 'Loading…'), gone);
    syncBox.append(goneRow);
    const when = (ms) => new Date(ms).toLocaleString(t('zh-CN', 'en-US'), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    api.syncAccount('trash').then((r) => {
      const hint = goneRow.querySelector('.set-hint');
      if (!r.ok) { hint.textContent = errText(r); return; }
      const { items, days } = r.result;
      hint.textContent = t(`任何设备上删除的文件都在这里保留 ${days} 天，恢复后会同步回所有设备`, `Files deleted on any device stay here for ${days} days; a restored one syncs back everywhere`);
      if (!items.length) { gone.append(el('em', '', t('没有删除的文件', 'Nothing deleted'))); return; }
      for (const it of items.slice(0, 20)) {
        const line = el('div', 'sync-device');
        line.append(el('span', 'sync-file', it.path), el('em', '', when(it.deleted)));
        const back = button(t('恢复', 'Restore'), async () => {
          back.disabled = true;
          const x = await api.syncAccount('restore', [it.id]);
          if (!x.ok) { back.disabled = false; window.alert(x.error === 'quota' ? t('空间不够，恢复不了', 'Not enough space to restore it') : errText(x)); return; }
          line.replaceChildren(el('span', 'sync-file', x.result.path), el('em', '', t('已恢复', 'Restored')));
          api.syncNow();
        });
        line.append(back);
        gone.append(line);
      }
      if (items.length > 20) gone.append(el('em', '', t(`还有 ${items.length - 20} 个更早的`, `${items.length - 20} more, older`)));
    });
    const devices = el('div', 'sync-devices');
    for (const d of acc.devices) {
      const line = el('div', 'sync-device'); line.append(el('span', '', d.device));
      if (d.current) line.append(el('em', '', t('本机', 'this device')));
      else line.append(button(t('移除', 'Sign out'), async () => {
        if (!window.confirm(t(`让「${d.device}」退出登录？它要重新输入密码才能再同步。`, `Sign “${d.device}” out? It needs the password to sync again.`))) return;
        await api.syncAccount('signOutDevice', [d.id]); renderSync();
      }));
      devices.append(line);
    }
    syncBox.append(field(t('已登录的设备', 'Signed-in devices'), t('丢了的设备可以在这里移除', 'Sign a lost device out here'), devices));
    // the password
    const oldP = input('password', t('当前密码', 'Current password')), newP = input('password', t('新密码（至少 8 位）', 'New password (8 or more)'));
    const msg = msgBox();
    const save = button(t('修改密码', 'Change password'), async () => {
      const r = await api.syncAccount('changePassword', [oldP.value, newP.value]);
      if (r.ok) { oldP.value = newP.value = ''; msg.textContent = t('已修改；其他设备需要重新登录', 'Changed; other devices sign in again'); return; }
      msg.textContent = r.error === 'auth' || r.error === 'wrong' ? t('当前密码不对', 'Wrong current password') : errText(r);
    });
    syncBox.append(field(t('密码', 'Password'), t('修改后，其他设备需要重新登录', 'Other devices sign in again afterwards'), wrap(oldP, newP, save, msg)));
    if (acc.admin) renderAdmin();
  }

  /** The administrator: every account, its space; new accounts. */
  async function renderAdmin() {
    const box = el('div');
    syncBox.append(section(t('账号管理', 'Accounts')), box);
    const r = await api.syncAccount('users');
    if (!r.ok) { box.append(el('div', 'sync-msg', errText(r))); return; }
    for (const u of r.result.users) {
      const pct = u.quota ? Math.min(100, Math.round(u.used / u.quota * 100)) : 0;
      const bar = el('div', 'sync-usage' + (pct >= 90 ? ' full' : '')); const fill = el('i'); fill.style.width = pct + '%'; bar.append(fill);
      const actions = row(
        button(t('调整空间', 'Space'), async () => {
          const v = await prompt(t(`「${u.name}」的空间（GB）`, `Space for “${u.name}” (GB)`), String(Math.round(u.quota / 1024 ** 3 * 10) / 10));
          if (v == null) return;
          const gb = parseFloat(v);
          if (!(gb > 0)) { window.alert(ERR.quota()); return; }
          await api.syncAccount('updateUser', [u.name, { quota: Math.round(gb * 1024 ** 3) }]); renderSync();
        }),
        button(t('重置密码', 'Reset password'), async () => {
          const v = await prompt(t(`「${u.name}」的新密码（至少 8 位）`, `New password for “${u.name}” (8 or more)`), '');
          if (!v) return;
          const x = await api.syncAccount('updateUser', [u.name, { password: v }]);
          window.alert(x.ok ? t('已重置；他的设备需要用新密码重新登录', 'Reset; their devices sign in again with it') : errText(x));
        }),
        ...(u.admin ? [] : [button(u.disabled ? t('启用', 'Enable') : t('停用', 'Disable'), async () => {
          if (!u.disabled && !window.confirm(t(`停用「${u.name}」？他的设备会退出登录，文件保留在服务器上。`, `Disable “${u.name}”? Their devices are signed out; the files stay on the server.`))) return;
          await api.syncAccount('updateUser', [u.name, { disabled: !u.disabled }]); renderSync();
        })]),
      );
      const right = el('div', 'textset'); right.append(bar, actions);
      box.append(field(u.name + (u.admin ? t('（管理员）', ' (administrator)') : '') + (u.disabled ? t('（已停用）', ' (disabled)') : ''),
        t(`已用 ${sizeText(u.used)} / ${sizeText(u.quota)} · ${u.devices} 台设备`, `${sizeText(u.used)} of ${sizeText(u.quota)} · ${u.devices} device(s)`), right));
    }
    // a new account
    const name = input('text', t('用户名', 'Name')), pass = input('password', t('初始密码（至少 8 位）', 'First password (8 or more)'));
    const size = document.createElement('select'); size.className = 'sync-size';
    for (const [v, label] of SIZES) { const o = document.createElement('option'); o.value = v; o.textContent = label; if (v === 1024 ** 3) o.selected = true; size.append(o); }
    const msg = msgBox();
    const go = button(t('创建账号', 'Create'), async () => {
      const x = await api.syncAccount('createUser', [name.value.trim(), pass.value, +size.value]);
      if (x.ok) { renderSync(); return; }
      msg.textContent = x.error === 'name' ? t('用户名 2–32 位：字母、数字、汉字、_ . -', '2–32 letters, digits, _ . -') : errText(x);
    }, 'primary');
    box.append(field(t('新建账号', 'New account'), t('把用户名和初始密码告诉对方，他在自己的设备上登录', 'Give them the name and the password to sign in with'), wrap(name, pass, size, go, msg)));
    box.querySelectorAll('.set-row').forEach((x) => x.classList.add('sync-row'));
  }
  let lastState = null;
  if (api.onSyncStatus) api.onSyncStatus((st) => {
    const line = syncBox.querySelector('.sync-state');
    if (line) line.textContent = syncText(st);
    if (st.state !== lastState && (st.state === 'auth' || lastState === 'auth') && !root.hidden) renderSync(); // signed out elsewhere: the sign-in form
    lastState = st.state;
  });

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
      field(t('正文区不换行（严格 Markdown）', 'Strict line breaks (Markdown)'), t('关（默认）：编辑区按一次回车，正式稿和导出里也换行。开：按 Markdown 标准，单个回车连成一行，空一行才分段', 'Off (default): one Return is a new line in the final view and exports too. On: standard Markdown, single lines join until a blank line'), toggle('lineBreaks', true)),
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
