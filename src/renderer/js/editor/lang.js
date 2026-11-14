// Code languages for fenced blocks: the list behind fence autocompletion, and the
// highlight style that colours both Markdown and code inside the editor.
import { languages } from '@codemirror/language-data';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { highlightTag, mathTag } from './syntax.js';

export const DIAGRAMS = ['mermaid'];
export const POPULAR = ['javascript', 'typescript', 'python', 'bash', 'json', 'html', 'css', 'sql', 'go', 'rust', 'java', 'c', 'cpp',
  'csharp', 'yaml', 'markdown', 'diff', 'swift', 'kotlin', 'ruby', 'php', 'shell', 'dockerfile', 'lua', 'r', 'scala', 'toml', 'xml', 'jsx', 'tsx'];

// One entry per language: the id written after the fence, its display name and aliases.
let list = null;
export function languageList() {
  if (list) return list;
  const seen = new Set();
  list = [];
  const add = (id, name, aliases, kind) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({ id, name, aliases: aliases.filter((a) => a !== id), kind });
  };
  const idOf = (d) => {
    const lower = d.name.toLowerCase().replace(/\s+/g, '');
    if (/^[a-z0-9]+$/.test(lower)) return lower;
    return d.alias.find((a) => /^[a-z0-9_-]+$/.test(a)) || lower;
  };
  const byId = new Map(languages.map((d) => [idOf(d), d]));
  for (const id of POPULAR) { const d = byId.get(id) || languages.find((x) => x.alias.includes(id)); if (d) add(id, d.name, [...d.alias, idOf(d)]); }
  for (const id of DIAGRAMS) add(id, 'Mermaid', [], 'diagram');
  for (const d of [...languages].sort((a, b) => a.name.localeCompare(b.name))) add(idOf(d), d.name, d.alias);
  return list;
}

export function matchLanguages(query, recent = []) {
  const all = languageList();
  const q = query.trim().toLowerCase();
  if (!q) {
    const r = recent.map((id) => all.find((l) => l.id === id)).filter(Boolean);
    return [...r, ...all.filter((l) => !r.includes(l))].slice(0, 8).map((l) => ({ l, via: '' }));
  }
  const scored = [];
  for (const l of all) {
    let score = 0, via = '';
    if (l.id === q) score = 100;
    else if (l.aliases.includes(q)) { score = 95; via = q; }
    else if (l.id.startsWith(q)) score = 80 - l.id.length * 0.1;
    else {
      const a = l.aliases.find((x) => x.startsWith(q));
      if (a) { score = 60; via = a; } else if (l.id.includes(q) || l.name.toLowerCase().includes(q)) score = 30;
    }
    if (score && score < 90 && POPULAR.includes(l.id)) score += 15; // common languages first
    if (score) scored.push({ l, via, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 8);
}

export { languages };

export const highlightStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', class: 'tok-muted' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.processingInstruction, class: 'tok-mark' },
  { tag: t.contentSeparator, class: 'tok-mark' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: highlightTag, class: 'tok-highlight' },
  { tag: mathTag, class: 'tok-math' },
  { tag: t.labelName, class: 'tok-info' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: [t.string, t.regexp, t.character, t.inserted], class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tok-number' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], class: 'tok-title' },
  { tag: [t.propertyName, t.attributeName], class: 'tok-attr' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName), t.self], class: 'tok-type' },
  { tag: t.tagName, class: 'tok-keyword' },
  { tag: [t.meta, t.punctuation, t.operator, t.angleBracket], class: 'tok-meta' },
  { tag: [t.deleted, t.invalid], class: 'tok-deletion' },
]);
