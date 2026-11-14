'use strict';
// The app was called MarkFlow before it was WhimFlow. Its settings, unsaved-text
// drafts, version history and window storage live in a folder named after the app,
// so the first start under the new name copies the old folder over. The old folder
// is left exactly as it was; nothing is copied if the new folder already exists.
const fs = require('fs');
const path = require('path');

// Chromium's caches are rebuilt on their own and can be large: not worth copying
const DISPOSABLE = /[\\/](Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|ShaderCache|Crashpad)$/;

const MARK = '.copied-from-markflow';
const OURS = ['settings.json', 'drafts', 'history']; // what the app itself keeps there

/**
 * Returns 'copied', or why not: 'custom' (a folder given on the command line), 'done'
 * (copied before), 'exists' (the new folder already has the app's own data), 'none'.
 * Electron creates the new folder itself at start (crash reports and the like), so what
 * counts is whether the app's own data is there yet, not whether the folder is.
 */
function adoptOldFolder({ appData, name, userData, oldName = 'MarkFlow' }) {
  if (userData !== path.join(appData, name)) return 'custom';
  if (fs.existsSync(path.join(userData, MARK))) return 'done';
  if (OURS.some((n) => fs.existsSync(path.join(userData, n)))) return 'exists';
  const old = path.join(appData, oldName);
  if (!fs.existsSync(old)) return 'none';
  // never overwrites: anything already in the new folder stays as it is
  fs.cpSync(old, userData, { recursive: true, errorOnExist: false, force: false, filter: (src) => !DISPOSABLE.test(src) });
  fs.writeFileSync(path.join(userData, MARK), `Copied from ${old} on ${new Date().toISOString()}\n`);
  return 'copied';
}

module.exports = { adoptOldFolder };
