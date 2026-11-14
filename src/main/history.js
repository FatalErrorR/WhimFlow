'use strict';
// Version history: a snapshot of the file each time it is saved (and when it is
// opened, so the version before your edits is always there).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function history(app, getKeep) {
  const root = () => path.join(app.getPath('userData'), 'history');
  const dirFor = (filePath) => path.join(root(), crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 20));
  const list = (filePath) => {
    try {
      return fs.readdirSync(dirFor(filePath)).filter((n) => /^\d+\.md$/.test(n)).map((n) => +n.slice(0, -3)).sort((a, b) => b - a);
    } catch (_) { return []; }
  };
  return {
    snapshot(filePath, content) {
      if (!filePath) return;
      const dir = dirFor(filePath);
      const ids = list(filePath);
      try {
        if (ids.length && fs.readFileSync(path.join(dir, ids[0] + '.md'), 'utf8') === content) return;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'path.txt'), path.resolve(filePath));
        let id = Date.now();
        if (ids.includes(id)) id++;
        fs.writeFileSync(path.join(dir, id + '.md'), content);
        for (const old of [id, ...ids].slice(Math.max(1, getKeep()))) fs.unlinkSync(path.join(dir, old + '.md'));
      } catch (_) { /* history is best effort */ }
    },
    list(filePath) {
      const dir = dirFor(filePath);
      return list(filePath).map((id) => {
        let size = 0;
        try { size = fs.statSync(path.join(dir, id + '.md')).size; } catch (_) { /* pruned */ }
        return { id, time: id, size };
      });
    },
    read(filePath, id) {
      try { return fs.readFileSync(path.join(dirFor(filePath), Number(id) + '.md'), 'utf8'); } catch (_) { return null; }
    },
  };
};
