'use strict';
// The desktop's sync: the library is a folder in the app's own data
// (~/Library/Application Support/WhimFlow/Documents on a Mac), the token sits in the keychain
// (sync-local.js), and the shared controller (src/shared/sync.js) decides when to sync:
// on start, a moment after a change, every minute, when a window comes to the front.
const fs = require('fs');
const path = require('path');
const { createSyncController, normalizeUrl } = require('../shared/sync');
const { createLocal, createState, createTokenStore } = require('./sync-local');
const fileops = require('./fileops');

function createDesktopSync({ userData, safeStorage, trashItem, queue, getUrl, setUrl, notify, device, fetch, every }) {
  const library = path.join(userData, 'Documents');
  fs.mkdirSync(library, { recursive: true });
  const c = createSyncController({
    local: createLocal({ root: library, queue, trashItem }),
    state: createState(path.join(userData, 'sync-state.json')),
    tokens: createTokenStore(path.join(userData, 'sync-token'), safeStorage),
    getUrl, setUrl, notify, device, fetch, every, hash: async (b) => fileops.hashOf(b),
  });
  return { ...c, library, focused: c.nudge };
}

module.exports = { createDesktopSync, normalizeUrl };
