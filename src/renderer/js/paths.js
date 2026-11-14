// File paths and file:// URLs in the renderer. On Windows a path may use "\" (and
// start with a drive letter or \\server\share); elsewhere "\" is an ordinary
// character in a file name and must be kept, and encoded, as such.
export const platform = { windows: false };
export const setPlatform = (name) => { platform.windows = name === 'win32'; };

const SEP = () => (platform.windows ? /[\\/]/ : /\//);
export const dirname = (p) => {
  const re = platform.windows ? /[\\/][^\\/]*$/ : /\/[^/]*$/;
  const d = p.replace(re, '');
  if (platform.windows && /^[A-Za-z]:$/.test(d)) return d + '\\';
  return d || (platform.windows ? p.slice(0, 1) : '/');
};
export const basename = (p) => p.split(SEP()).pop();

/** An absolute path as a file:// URL; every character that means something in a URL (space, #, ?, %) is encoded. */
export function fileUrl(p) {
  if (platform.windows) {
    const parts = p.split(/[\\/]/);
    if (/^[\\/]{2}[^\\/]/.test(p)) { // \\server\share\…
      const [, , host, ...rest] = parts;
      return 'file://' + host + '/' + rest.map(encodeURIComponent).join('/');
    }
    if (/^[A-Za-z]:$/.test(parts[0])) return 'file:///' + parts[0] + '/' + parts.slice(1).map(encodeURIComponent).join('/');
  }
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}

/** Is `p` the folder `dir` itself or inside it? Whole path segments only: "notes" is not inside "note". */
export function isUnder(p, dir) {
  if (!p || !dir) return false;
  if (p === dir) return true;
  const seps = platform.windows ? ['\\', '/'] : ['/'];
  return seps.some((s) => p.startsWith(dir.endsWith(s) ? dir : dir + s));
}
/** Where `p` is after `from` was renamed to `to`; null if untouched. */
export function remapPath(p, from, to) {
  if (!isUnder(p, from)) return null;
  return p === from ? to : to + p.slice(from.length);
}
