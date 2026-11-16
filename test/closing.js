// Closing and quitting with unsaved documents (src/main/closing.js), with stand-in windows: no
// Electron, nothing on screen. The app below behaves like Electron's: quit() closes every window,
// and is cancelled when one of them refuses (preventDefault in 'close').
const assert = require('assert');
const { EventEmitter } = require('events');
const { createQuitState, guardClose } = require('../src/main/closing.js');

const step = (name) => console.log('  ✓', name);
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

function makeApp() {
  const app = { windows: [], quitting: null, quit: 0, exited: false, quitState: createQuitState() };
  app.doQuit = () => { // Electron: before-quit, then close each window; one that refuses cancels the quit
    app.quit++;
    app.quitState.start();
    for (const w of [...app.windows]) if (!w.tryClose()) return;
    app.exited = true;
  };
  return app;
}
function makeWindow(app, { dirty = true, answers = [] } = {}) {
  const win = new EventEmitter();
  const st = { dirty, closing: false, forceClose: false, asked: 0 };
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.tryClose = () => {
    let refused = false;
    win.emit('close', { preventDefault: () => { refused = true; } });
    if (refused) return false;
    win.destroyed = true;
    app.windows.splice(app.windows.indexOf(win), 1);
    return true;
  };
  win.close = () => { win.tryClose(); };
  const confirm = async (s) => {
    s.asked++;
    const a = answers.shift() || 'saved';
    if (typeof a === 'function') return a(s);
    if (a === 'saved') s.dirty = false;
    return a;
  };
  guardClose({ win, st, confirm, quitState: app.quitState, quit: () => app.doQuit(), later: (fn) => setImmediate(fn) });
  app.windows.push(win);
  return { win, st };
}

(async () => {
  try {
    // ⌘Q with an unsaved document, "Save": saved, the window closes, and the app quits
    let app = makeApp();
    let { st } = makeWindow(app);
    app.doQuit();
    assert(!app.exited && st.asked === 1, 'the quit waits for the question');
    await settle();
    assert(app.exited && !st.dirty && app.windows.length === 0, 'saved, then the app quits');
    step('⌘Q, Save: the document is saved and the app quits');

    // "Don't Save" quits too
    app = makeApp(); ({ st } = makeWindow(app, { answers: ['discard'] }));
    app.doQuit(); await settle();
    assert(app.exited, "Don't Save: the app quits");
    // "Cancel": nothing closes, the app stays, and a later window close does not quit it
    app = makeApp(); ({ st } = makeWindow(app, { answers: ['cancel', 'saved'] }));
    app.doQuit(); await settle();
    assert(!app.exited && app.windows.length === 1 && !app.quitState.active(), 'Cancel: the app stays, the quit is over');
    app.windows[0].close(); await settle();
    assert(app.windows.length === 0 && !app.exited && app.quit === 1, 'closing the window afterwards does not quit the app');
    step("Don't Save quits; Cancel keeps the app and ends the quit");

    // closing a window (not quitting): saved and closed, the app stays open
    app = makeApp(); ({ st } = makeWindow(app));
    app.windows[0].close(); await settle();
    assert(app.windows.length === 0 && !app.exited && app.quit === 0, 'only the window closes');
    step('closing a window with unsaved text: it saves and closes; the app keeps running');

    // edited again while saving: asked again, then the quit goes on
    app = makeApp();
    ({ st } = makeWindow(app, { answers: [(s) => { s.dirty = true; return 'saved'; }, 'saved'] }));
    app.doQuit(); await settle();
    assert(app.exited && st.asked === 2, 'asked about the new changes, then quit');
    // two windows with unsaved documents: each asks in turn, then the app quits
    app = makeApp();
    const a = makeWindow(app), b = makeWindow(app);
    app.doQuit(); await settle();
    assert(app.exited && a.st.asked === 1 && b.st.asked === 1, 'both asked once, then quit');
    step('edited while saving: asked again; two windows ask in turn; then the app quits');
    console.log('CLOSING OK');
  } catch (err) {
    console.error('CLOSING FAIL', err);
    process.exitCode = 1;
  }
})();
