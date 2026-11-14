'use strict';
// Search every Markdown file under a folder. Pure Node (fs + path): it runs inside a
// worker thread (see search.js), so a pathological regular expression can be stopped.
const fs = require('fs');
const path = require('path');

const MD = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;
const MAX_FILES = 5000, MAX_HITS = 2000, MAX_SIZE = 5 * 1024 * 1024;

async function walk(dir, out, depth = 0) {
  if (depth > 12 || out.length >= MAX_FILES) return;
  let ents;
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, depth + 1);
    else if (MD.test(e.name)) out.push(full);
  }
}

async function search(folder, query, opts = {}) {
  if (!folder || !query) return { files: [], total: 0, capped: false };
  let re;
  try {
    const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.word ? `\\b(?:${src})\\b` : src, opts.caseSensitive ? 'g' : 'gi');
  } catch (err) { return { error: String(err.message), code: 'invalid', files: [], total: 0 }; }
  const paths = [];
  await walk(folder, paths);
  const files = [];
  let total = 0, capped = false;
  for (const p of paths) {
    let text;
    try { if ((await fs.promises.stat(p)).size > MAX_SIZE) continue; text = await fs.promises.readFile(p, 'utf8'); } catch (_) { continue; }
    const lines = text.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length && total < MAX_HITS; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) && total < MAX_HITS) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const start = Math.max(0, m.index - 40);
        matches.push({ line: i + 1, col: m.index, len: m[0].length, text: lines[i].slice(start, m.index + m[0].length + 80), at: m.index - start });
        total++;
      }
    }
    if (matches.length) files.push({ path: p, name: path.basename(p), rel: path.relative(folder, path.dirname(p)), matches });
    if (total >= MAX_HITS) { capped = true; break; }
  }
  return { files, total, capped };
}

module.exports = { search };
