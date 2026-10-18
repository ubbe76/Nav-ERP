// Pure manual search: no imports, no I/O. Shared with the public site
// (hemsida syncs this file), so keep it dependency-free.
//
// The manual is split into one section per heading; a query matches a
// section when every word is found in its heading or body (case and
// å/ä/ö-insensitive). Heading hits rank above body-only hits.

export interface ManualSection {
  chapter: string; // chapter slug
  chapterTitle: string;
  heading: string; // plain text
  id: string; // anchor, same rule as slugifyHeading
  text: string; // plain body text, whitespace collapsed
}

export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface ManualHit {
  chapter: string;
  chapterTitle: string;
  heading: string;
  id: string;
  headingParts: SnippetPart[];
  snippet: SnippetPart[];
  score: number;
}

// The heading anchor rule — the ONE implementation: manual.ts's renderer and
// HelpLink anchors use it through slugifyHeading, so a search hit always
// lands on the heading it found. Lives here because this file stays
// import-free (the public site syncs it).
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/é/g, "e")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function stripInline(s: string): string {
  // Inline code first, kept verbatim — `***` (the fallback location) is
  // text, not emphasis.
  const code: string[] = [];
  const withoutCode = s.replace(/`([^`]*)`/g, (_, c: string) => `\u0000${code.push(c) - 1}\u0000`);
  return withoutCode
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|`|\*)/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split one chapter's markdown into a section per heading. */
export function splitIntoSections(chapter: string, chapterTitle: string, markdown: string): ManualSection[] {
  const sections: ManualSection[] = [];
  let current: { heading: string; id: string; lines: string[] } | null = null;
  let fenced = false;
  const flush = () => {
    if (!current) return;
    const text = stripInline(current.lines.join(" ").replace(/^\s*[|:\- ]+$/gm, " ").replace(/\|/g, " ").replace(/(^|\s):?-{3,}:?(?=\s|$)/g, " "));
    sections.push({ chapter, chapterTitle, heading: current.heading, id: current.id, text });
  };
  // Text before the first heading belongs to the chapter itself.
  current = { heading: chapterTitle, id: "", lines: [] };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const m = !fenced ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      flush();
      const heading = stripInline(m[2] ?? "");
      current = { heading, id: slugify(m[2] ?? ""), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return sections.filter((s) => s.heading || s.text);
}

// One output char per input char, so indexes in the folded string map
// straight back to the original text.
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    const c = l.length === ch.length ? l : ch;
    out += c.replace(/[åä]/, "a").replace("ö", "o").replace("é", "e").replace("è", "e").replace("ü", "u");
  }
  return out;
}

export function queryTerms(query: string): string[] {
  return [...new Set(fold(query).split(/\s+/).filter((t) => t.length > 0))];
}

function highlight(text: string, terms: string[]): SnippetPart[] {
  if (!text) return [];
  const folded = fold(text);
  const mark = new Array<boolean>(text.length).fill(false);
  for (const t of terms) {
    for (let i = folded.indexOf(t); i !== -1; i = folded.indexOf(t, i + 1)) {
      for (let k = i; k < i + t.length; k++) mark[k] = true;
    }
  }
  const parts: SnippetPart[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || mark[i] !== mark[start]) {
      parts.push({ text: text.slice(start, i), hit: mark[start] === true });
      start = i;
    }
  }
  return parts;
}

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 180;

// The window shows where the most distinct search words sit together (the
// earliest such place), not merely the first hit of any word — "tid" inside
// "operationstid" must not win over the passage that has the whole query.
function snippetFor(text: string, terms: string[]): SnippetPart[] {
  if (!text) return [];
  const folded = fold(text);
  let first = -1;
  let bestCount = 0;
  for (const t of terms) {
    for (let i = folded.indexOf(t); i !== -1; i = folded.indexOf(t, i + 1)) {
      const window = folded.slice(Math.max(0, i - SNIPPET_BEFORE), i - SNIPPET_BEFORE + SNIPPET_LENGTH);
      const count = terms.filter((u) => window.includes(u)).length;
      if (count > bestCount || (count === bestCount && i < first)) {
        bestCount = count;
        first = i;
      }
    }
  }
  let start = first === -1 ? 0 : Math.max(0, first - SNIPPET_BEFORE);
  // Begin on a word boundary.
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp !== -1 && sp < first) start = sp + 1;
  }
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  const parts = highlight(text.slice(start, end), terms);
  if (start > 0) parts.unshift({ text: "… ", hit: false });
  if (end < text.length) parts.push({ text: " …", hit: false });
  return parts;
}

export function searchSections(sections: ManualSection[], query: string, limit = 50): ManualHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: ManualHit[] = [];
  sections.forEach((s, index) => {
    const h = fold(s.heading);
    const b = fold(s.text);
    let score = 0;
    let headingTerms = 0;
    for (const t of terms) {
      const inH = h.includes(t);
      if (!inH && !b.includes(t)) return;
      if (inH) {
        headingTerms++;
        score += 10;
      } else score += 1;
    }
    if (headingTerms === terms.length) score += 20;
    if (h === terms.join(" ")) score += 20;
    hits.push({
      chapter: s.chapter,
      chapterTitle: s.chapterTitle,
      heading: s.heading,
      id: s.id,
      headingParts: highlight(s.heading, terms),
      snippet: snippetFor(s.text, terms),
      score: score * 10000 - index, // stable: manual order breaks ties
    });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
