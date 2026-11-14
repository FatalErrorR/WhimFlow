// Images: reading an image (Markdown or <img>) from the text and writing it back
// with a size and alignment. Markdown has no syntax for either, so a resized or
// aligned image is written as an <img> tag; back at 100% it returns to ![]().
import { syntaxTree } from '@codemirror/language';

const ALIGN_STYLE = { left: 'display:block', center: 'display:block;margin:0 auto', right: 'display:block;margin-left:auto' };

export function parseImgTag(text) {
  if (!/^<img\b/i.test(text)) return null;
  const attrs = {};
  for (const m of text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  const style = (attrs.style || '').replace(/\s+/g, '');
  const align = /margin:0auto|margin-left:auto;margin-right:auto/.test(style) ? 'center' : /margin-left:auto/.test(style) ? 'right' : /display:block/.test(style) ? 'left' : '';
  let width = attrs.width || ((/(?:^|;)width:([\d.]+(?:%|px))/.exec(style) || [])[1]) || '';
  if (/^\d+$/.test(width)) width += 'px';
  return { src: attrs.src || '', alt: attrs.alt || '', width, align };
}

export function imageMarkup({ src, alt, width, align }) {
  if ((!width || width === '100%') && !align) return `![${alt}](${src})`;
  const a = [`src="${src}"`, `alt="${alt.replace(/"/g, '&quot;')}"`];
  if (width && width !== '100%') a.push(`width="${width.replace(/px$/, '')}"`);
  if (align) a.push(`style="${ALIGN_STYLE[align]}"`);
  return `<img ${a.join(' ')}>`;
}

/** The image at (or right next to) `pos`: its range in the text and its properties. */
export function imageAt(state, pos) {
  for (const side of [1, -1]) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Image') {
        const text = state.sliceDoc(n.from, n.to);
        const url = n.getChild('URL');
        const alt = /^!\[([^\]]*)\]/.exec(text);
        return { from: n.from, to: n.to, src: url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '') : '', alt: alt ? alt[1] : '', width: '', align: '' };
      }
      if (n.name === 'HTMLTag' || n.name === 'HTMLBlock') {
        const text = state.sliceDoc(n.from, n.to);
        const m = /<img\b[^>]*>/i.exec(text);
        if (!m) continue;
        const img = parseImgTag(m[0]);
        if (img) return { from: n.from + m.index, to: n.from + m.index + m[0].length, ...img };
      }
    }
  }
  return null;
}
