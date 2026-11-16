'use strict';
// A window with unsaved documents asks before it closes. Quitting (⌘Q) closes every window, so
// it is held up by that question too: Electron cancels the quit when a window refuses to close.
// Once the question is answered (saved, or not saved), the window closes and the quit goes on;
// "Cancel" ends the quit. No Electron here, so it runs in plain Node tests.

/** Whether a quit is under way: set on before-quit, cleared when a window's question is cancelled. */
function createQuitState() {
  let quitting = false;
  return { start() { quitting = true; }, cancel() { quitting = false; }, active: () => quitting };
}

/**
 * Ask before `win` closes while `st.dirty`. confirm(st) -> 'saved' | 'discard' | 'cancel'.
 * quit(): asked again once this window is closed during a quit (other windows then ask in turn).
 */
function guardClose({ win, st, confirm, quitState, quit, later = setImmediate }) {
  win.on('close', (e) => {
    if (!st.dirty || st.forceClose) return;
    e.preventDefault();
    if (st.closing) return; // already asking
    st.closing = true;
    confirm(st).then((answer) => {
      st.closing = false;
      if (win.isDestroyed()) return;
      if (answer === 'cancel') { quitState.cancel(); return; }
      if (answer === 'discard' || !st.dirty) st.forceClose = true;
      const resume = quitState.active() && st.forceClose;
      win.close(); // edited again while saving: not forced, so it asks about the new changes
      if (resume) later(quit); // the quit this window held up goes on
    });
  });
}

module.exports = { createQuitState, guardClose };
