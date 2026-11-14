// What may follow the language on a code fence, shared by the editor and the renderer:
//
//   ```python title="save.py" {2,4-6} fold
//
// title — a file name shown above the code; {…} — lines to highlight (1-based);
// fold — the block starts collapsed. Other Markdown tools ignore all three.
const TITLE_RE = /(?:^|\s)(?:title|file|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/;
const HL_RE = /\{([\d\s,-]*)\}/;
const FOLD_RE = /(?:^|\s)(?:fold|folded|collapsed)(?=\s|$)/;

/** A folded block keeps this many lines in sight. */
export const FOLD_KEEP = 5;
/** Folding is only offered when it hides enough to be worth it. */
export const canFold = (lineCount) => lineCount >= FOLD_KEEP + 3;

function parseRanges(text) {
  const out = [];
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a >= 1 && b >= a) out.push([a, b]);
  }
  return out;
}

export function parseInfo(info) {
  const raw = String(info || '').trim();
  let lang = /^[^\s{]*/.exec(raw)[0];
  if (lang.includes('=')) lang = ''; // ```title="x" — an option, not a language
  let rest = raw.slice(lang.length), title = '', hl = [], fold = false;
  rest = rest.replace(TITLE_RE, (_, a, b, c) => { title = a != null ? a : b != null ? b : c; return ' '; });
  rest = rest.replace(HL_RE, (_, body) => { hl = parseRanges(body); return ' '; });
  rest = rest.replace(FOLD_RE, () => { fold = true; return ' '; });
  return { lang: lang.toLowerCase(), rawLang: lang, title, hl, fold, other: rest.trim().replace(/\s+/g, ' ') };
}

export const inRanges = (ranges, n) => ranges.some(([a, b]) => n >= a && n <= b);

/** Line numbers → the shortest list of ranges: [2,4,5,6] → [[2,2],[4,6]]. */
export function toRanges(lines) {
  const sorted = [...new Set(lines)].filter((n) => n >= 1).sort((a, b) => a - b), out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out;
}
export function linesOf(ranges) {
  const out = new Set();
  for (const [a, b] of ranges) for (let n = a; n <= Math.min(b, a + 5000); n++) out.add(n);
  return out;
}

/** The info string with some of its options changed; everything else is kept. */
export function withInfo(info, patch) {
  const cur = parseInfo(info), next = { ...cur, ...patch };
  const parts = [next.rawLang];
  const title = String(next.title || '').replace(/["`]/g, '').trim();
  if (title) parts.push(`title="${title}"`);
  if (next.hl && next.hl.length) parts.push('{' + next.hl.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(',') + '}');
  if (next.fold) parts.push('fold');
  if (cur.other) parts.push(cur.other);
  return parts.filter(Boolean).join(' ');
}

/** For ```diff blocks: what kind of line is this? */
export function diffKind(text) {
  if (/^(\+\+\+|---)(\s|$)/.test(text) || /^(diff |index |Index: |={3,})/.test(text)) return 'meta';
  if (text.startsWith('@@')) return 'hunk';
  if (text.startsWith('+')) return 'add';
  if (text.startsWith('-')) return 'del';
  return '';
}
export const isDiffLang = (lang) => lang === 'diff' || lang === 'patch';
