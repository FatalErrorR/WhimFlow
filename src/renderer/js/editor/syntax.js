// Markdown syntax extensions for the editor's parser (Lezer): ==highlight==,
// $inline math$ and $$ math blocks. Kept in step with render.js.
import { tags as t, Tag } from '@lezer/highlight';

// Own tags, so code languages that use special(string) etc. are not coloured as math.
export const highlightTag = Tag.define();
export const mathTag = Tag.define();

const Punct = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/;

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
export const HighlightExt = {
  defineNodes: [
    { name: 'Highlight', style: highlightTag },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next != 61 || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sB = /\s|^$/.test(before), sA = /\s|^$/.test(after), pB = Punct.test(before), pA = Punct.test(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sA && (!pA || sB || pB), !sB && (!pB || sA || pA));
    },
    after: 'Emphasis',
  }],
};

const isDollarLine = (line) => line.next == 36 && line.text.charCodeAt(line.pos + 1) == 36;

export const MathExt = {
  defineNodes: [
    { name: 'InlineMath', style: mathTag },
    { name: 'MathMark', style: t.processingInstruction },
    { name: 'MathBlock', block: true },
  ],
  parseInline: [{
    name: 'InlineMath',
    parse(cx, next, pos) {
      if (next != 36 || cx.char(pos + 1) == 36 || cx.char(pos - 1) == 36) return -1;
      const first = cx.char(pos + 1);
      if (first == 32 || first == 9 || first == -1) return -1;
      for (let i = pos + 1; i < cx.end; i++) {
        const c = cx.char(i);
        if (c == 92) { i++; continue; }
        if (c == 36) {
          if (i == pos + 1) return -1;
          const prev = cx.char(i - 1), after = cx.char(i + 1);
          if (prev == 32 || prev == 9 || (after >= 48 && after <= 57)) return -1;
          return cx.addElement(cx.elt('InlineMath', pos, i + 1, [cx.elt('MathMark', pos, pos + 1), cx.elt('MathMark', i, i + 1)]));
        }
      }
      return -1;
    },
    before: 'Emphasis',
  }],
  parseBlock: [{
    name: 'MathBlock',
    parse(cx, line) {
      if (!isDollarLine(line)) return false;
      const start = cx.lineStart + line.pos;
      const marks = [cx.elt('MathMark', start, start + 2)];
      if (/\S\s*\$\$\s*$/.test(line.text.slice(line.pos + 2))) {
        const close = cx.lineStart + line.text.lastIndexOf('$$');
        marks.push(cx.elt('MathMark', close, close + 2));
        cx.nextLine();
        cx.addElement(cx.elt('MathBlock', start, close + 2, marks));
        return true;
      }
      let end = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        end = cx.lineStart + line.text.length;
        if (/^\s*\$\$\s*$/.test(line.text)) {
          const at = cx.lineStart + line.text.indexOf('$$');
          marks.push(cx.elt('MathMark', at, at + 2));
          end = at + 2;
          cx.nextLine();
          break;
        }
      }
      cx.addElement(cx.elt('MathBlock', start, end, marks));
      return true;
    },
    endLeaf: (cx, line) => isDollarLine(line),
    before: 'FencedCode',
  }],
};

// ---- footnotes: [^label] references and [^label]: definitions ----
const FOOT_DEF = /^\[\^([^\]\s]+)\]:[ \t]?/;
export const FootnoteExt = {
  defineNodes: [
    { name: 'FootnoteRef', style: t.link },
    { name: 'FootnoteDefinition', block: true },
    { name: 'FootnoteMark', style: t.processingInstruction },
  ],
  parseInline: [{
    name: 'FootnoteRef',
    parse(cx, next, pos) {
      if (next != 91 || cx.char(pos + 1) != 94) return -1;
      for (let i = pos + 2; i < cx.end; i++) {
        const c = cx.char(i);
        if (c == 93) return i > pos + 2 ? cx.addElement(cx.elt('FootnoteRef', pos, i + 1)) : -1;
        if (c == 32 || c == 9 || c == 91) return -1;
      }
      return -1;
    },
    before: 'Link',
  }],
  parseBlock: [{
    name: 'FootnoteDefinition',
    parse(cx, line) {
      if (cx.depth > 1) return false; // top level only (the document itself is depth 1)
      const m = FOOT_DEF.exec(line.text.slice(line.pos));
      if (!m) return false;
      const start = cx.lineStart + line.pos;
      const children = [cx.elt('FootnoteMark', start, start + m[0].length)];
      const textStart = start + m[0].length;
      let text = line.text.slice(line.pos + m[0].length), end = cx.lineStart + line.text.length;
      const offsets = [textStart];
      // continuation lines are indented
      while (cx.nextLine() && /^( {2,}|\t)\S/.test(line.text)) {
        text += '\n' + line.text;
        end = cx.lineStart + line.text.length;
        offsets.push(cx.lineStart);
      }
      children.push(...cx.parser.parseInline(text, textStart));
      cx.addElement(cx.elt('FootnoteDefinition', start, end, children));
      return true;
    },
    endLeaf: (cx, line) => FOOT_DEF.test(line.text.slice(line.pos)),
  }],
};

// ---- YAML front matter: a --- block at the very top of the document ----
export const FrontMatterExt = {
  defineNodes: [
    { name: 'FrontMatter', block: true },
    { name: 'FrontMatterMark', style: t.processingInstruction },
  ],
  parseBlock: [{
    name: 'FrontMatter',
    parse(cx, line) {
      if (cx.lineStart !== 0 || line.text.trimEnd() !== '---') return false;
      const marks = [cx.elt('FrontMatterMark', 0, 3)];
      let end = line.text.length;
      while (cx.nextLine()) {
        end = cx.lineStart + line.text.length;
        if (/^(---|\.\.\.)\s*$/.test(line.text)) {
          marks.push(cx.elt('FrontMatterMark', cx.lineStart, cx.lineStart + 3));
          cx.nextLine();
          cx.addElement(cx.elt('FrontMatter', 0, end, marks));
          return true;
        }
      }
      cx.addElement(cx.elt('FrontMatter', 0, end, marks));
      return true;
    },
    before: 'HorizontalRule',
  }],
};
