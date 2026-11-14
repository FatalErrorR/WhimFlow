'use strict';
// Crash recovery: each window keeps a draft of its unsaved text on disk. A clean
// save or close removes it; whatever is left at the next start came from a crash.
// A left-over draft is only removed once its text has been handed back to a window
// (and that window has written its own draft of it): see `ready` / `recovered` in main.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function recovery(app) {
  const dir = () => path.join(app.getPath('userData'), 'drafts');
  const valid = (id) => typeof id === 'string' && /^[\w-]{1,200}$/.test(id);
  return {
    newId: () => crypto.randomBytes(8).toString('hex'),
    valid,
    write(id, data) {
      if (!valid(id)) return false;
      try {
        fs.mkdirSync(dir(), { recursive: true });
        const file = path.join(dir(), id + '.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify({ ...data, savedAt: Date.now() }));
        fs.renameSync(file + '.tmp', file); // atomic: a crash mid-write never leaves half a draft
        return true;
      } catch (_) { return false; /* best effort */ }
    },
    remove(id) { if (valid(id)) { try { fs.unlinkSync(path.join(dir(), id + '.json')); } catch (_) { /* gone */ } } },
    /** Drafts left behind by a previous run, newest first. Several may name the same file. */
    leftovers() {
      let names = [];
      try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
      const out = [];
      for (const n of names) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8'));
          d.id = n.slice(0, -5);
          if (typeof d.content !== 'string') continue;
          // nothing to recover: the file on disk already holds exactly this text
          if (d.filePath) { try { if (fs.readFileSync(d.filePath, 'utf8') === d.content) { this.remove(d.id); continue; } } catch (_) { /* file gone: keep draft */ } }
          if (!d.filePath && !d.content.trim()) { this.remove(d.id); continue; }
          out.push(d);
        } catch (_) { /* unreadable */ }
      }
      return out.sort((a, b) => b.savedAt - a.savedAt);
    },
  };
};
