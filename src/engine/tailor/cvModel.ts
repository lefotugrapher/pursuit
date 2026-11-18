// Master CV ⇄ CvModel. Server-only, pure (no I/O).
//
// The master (~/skill/cv/Kshitiz_Mittal_CV.tex) is built from its own macros:
//   \section{TITLE}            section heading
//   \role{Title}{Dates}        entry title line
//   \org{Organisation}{Place}  entry organisation line
//   \note{Italic context}      optional one-line note
//   itemize / \item            bullets
//   \entrygap                  spacing between entries
// Sections whose body uses \role are parsed into entries; any other section (Skills, Interests, or
// anything we don't fully understand) is kept verbatim in `raw` so it renders byte-for-byte.
// Text fields in the model are PLAIN text; renderCv escapes them back to LaTeX.

import type { CvBullet, CvEntry, CvModel, CvSection, Fact, FactBank } from '@/lib/types';
import { escapeLatex, latexToPlain, readGroup, stripComments } from './latex';

export class CvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CvParseError';
  }
}

const SUMMARY_TITLE = /^(summary|profile|personal statement|professional summary)$/i;
const COMMENT_ONLY = /^\s*%.*$/;

// ───────────────────────────── Parsing ─────────────────────────────

/** Drops trailing blank and comment-only lines (the master's decorative "% ── SKILLS ──" rules). */
function trimTrailingComments(text: string): string {
  const lines = text.split('\n');
  while (lines.length && (lines[lines.length - 1].trim() === '' || COMMENT_ONLY.test(lines[lines.length - 1]))) lines.pop();
  return lines.join('\n');
}

function trimLeadingBlank(text: string): string {
  return text.replace(/^\s*\n/, '').replace(/^\s+$/, '');
}

interface RawSection { title: string; body: string }

function splitSections(body: string): { header: string; sections: RawSection[] } {
  const re = /\\section\*?(?=\s*\{)/g;
  const starts: { at: number; titleEnd: number; title: string }[] = [];
  for (let m = re.exec(body); m; m = re.exec(body)) {
    // Skip commented-out \section lines.
    const lineStart = body.lastIndexOf('\n', m.index) + 1;
    if (stripComments(body.slice(lineStart, m.index)).length < m.index - lineStart) continue;
    let j = m.index + m[0].length;
    while (body[j] === ' ') j++;
    const g = readGroup(body, j);
    if (!g) throw new CvParseError(`Unbalanced \\section title near offset ${m.index}`);
    starts.push({ at: m.index, titleEnd: g.end, title: g.content });
    re.lastIndex = g.end;
  }
  const header = trimTrailingComments(body.slice(0, starts[0]?.at ?? body.length));
  const sections = starts.map((s, idx) => ({
    title: s.title,
    body: trimLeadingBlank(trimTrailingComments(body.slice(s.titleEnd, starts[idx + 1]?.at ?? body.length))),
  }));
  return { header, sections };
}

function entryKindFor(sectionTitle: string): CvEntry['kind'] {
  const t = sectionTitle.toLowerCase();
  if (/education|qualification/.test(t)) return 'education';
  if (/project|campaign|freelance|portfolio/.test(t)) return 'project';
  if (/experience|employment|work|career/.test(t)) return 'role';
  return 'other';
}

/** Reads `\name{a}{b}...` at `i` (after optional whitespace). Returns args or null if not that macro. */
function readMacro(src: string, i: number, name: string, argc: number): { args: string[]; end: number } | null {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  const token = `\\${name}`;
  if (!src.startsWith(token, j) || /[A-Za-z]/.test(src[j + token.length] ?? '')) return null;
  j += token.length;
  const args: string[] = [];
  for (let k = 0; k < argc; k++) {
    while (src[j] === ' ' || src[j] === '\t') j++;
    const g = readGroup(src, j);
    if (!g) return null;
    args.push(g.content);
    j = g.end;
  }
  return { args, end: j };
}

function parseItems(src: string, i: number): { items: string[]; end: number } | null {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  const open = '\\begin{itemize}';
  if (!src.startsWith(open, j)) return null;
  const close = src.indexOf('\\end{itemize}', j);
  if (close < 0) throw new CvParseError('Unclosed itemize environment');
  const inner = src.slice(j + open.length, close);
  if (inner.includes('\\begin{itemize}')) return null; // nested lists: leave the section raw
  const items = inner
    .split(/\\item\b/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
  return { items, end: close + '\\end{itemize}'.length };
}

/** Parses one entry chunk; null if it contains anything beyond role/org/note/itemize. */
function parseEntry(chunk: string, kind: CvEntry['kind']): CvEntry | null {
  const src = stripComments(chunk);
  const role = readMacro(src, 0, 'role', 2);
  if (!role) return null;
  let pos = role.end;
  const entry: CvEntry = { kind, title: latexToPlain(role.args[0]), bullets: [] };
  const dates = latexToPlain(role.args[1]);
  if (dates) entry.dates = dates;

  const org = readMacro(src, pos, 'org', 2);
  if (org) {
    const name = latexToPlain(org.args[0]);
    const place = latexToPlain(org.args[1]);
    if (name) entry.org = name;
    if (place) entry.location = place;
    pos = org.end;
  }
  const note = readMacro(src, pos, 'note', 1);
  if (note) {
    entry.note = latexToPlain(note.args[0]);
    pos = note.end;
  }
  const list = parseItems(src, pos);
  if (list) {
    entry.bullets = list.items.map((item) => ({ text: latexToPlain(item), factIds: [] }));
    pos = list.end;
  }
  if (src.slice(pos).trim() !== '') return null;
  return entry;
}

function parseSection(raw: RawSection): CvSection {
  const title = latexToPlain(raw.title);
  const body = raw.body;
  const verbatim: CvSection = { title, entries: [], raw: body };
  if (!/\\role\s*\{/.test(stripComments(body))) return verbatim;

  const chunks = body.split(/^\s*\\entrygap\s*$/m).map((c) => c.trim()).filter((c) => stripComments(c).trim() !== '');
  const kind = entryKindFor(title);
  const entries: CvEntry[] = [];
  for (const chunk of chunks) {
    const entry = parseEntry(chunk, kind);
    if (!entry) return verbatim; // unknown structure: keep the whole section exactly as written
    entries.push(entry);
  }
  return { title, entries };
}

/**
 * Parses the master CV. When `facts` is given, bullets and entries are linked to fact ids
 * (bullet ↔ fact.cvBullet, entry ↔ role/project/education fact with the same org + title).
 */
export function parseMasterCv(tex: string, facts?: FactBank): CvModel {
  const beginIdx = tex.indexOf('\\begin{document}');
  const endIdx = tex.lastIndexOf('\\end{document}');
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) throw new CvParseError('Missing \\begin{document} or \\end{document}');
  const preambleEnd = tex.indexOf('\n', beginIdx);
  const preamble = tex.slice(0, preambleEnd < 0 ? beginIdx + '\\begin{document}'.length : preambleEnd + 1);
  const bodyStart = preamble.length;
  const endLineStart = tex.lastIndexOf('\n', endIdx) + 1;
  const postamble = tex.slice(endLineStart);
  const body = tex.slice(bodyStart, endLineStart);

  const { header, sections: rawSections } = splitSections(body);
  if (!rawSections.length) throw new CvParseError('No \\section found in the CV body');

  let summary = '';
  const sections: CvSection[] = [];
  for (const raw of rawSections) {
    const title = latexToPlain(raw.title);
    if (!summary && SUMMARY_TITLE.test(title) && !/\\(begin|role|item)\b/.test(raw.body)) {
      summary = latexToPlain(raw.body);
      continue;
    }
    sections.push(parseSection(raw));
  }
  const model: CvModel = { preamble, header: header.trimEnd(), summary, sections, postamble };
  return facts ? linkFacts(model, facts) : model;
}

// ───────────────────────────── Fact linking ─────────────────────────────

/** Normalisation used to compare CV text with fact text (dashes, quotes, case, spacing, final period). */
export function normForMatch(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s*-+\s*/g, '-')
    .replace(/[\u2018\u2019\u02BC`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
}

const ENTRY_FACT_KINDS = new Set<Fact['kind']>(['role', 'project', 'education']);

function findEntryFact(entry: CvEntry, facts: Fact[]): string | undefined {
  const org = entry.org ? normForMatch(entry.org) : '';
  const title = normForMatch(entry.title);
  const hit = facts.find(
    (f) => ENTRY_FACT_KINDS.has(f.kind) && f.title && normForMatch(f.title) === title && (!org || (f.org && normForMatch(f.org) === org)),
  );
  return hit?.id;
}

function findBulletFacts(bullet: CvBullet, entry: CvEntry, facts: Fact[]): string[] {
  const text = normForMatch(bullet.text);
  const exact = facts.filter((f) => f.cvBullet && normForMatch(f.cvBullet) === text);
  if (exact.length === 1) return [exact[0].id];
  if (exact.length > 1) {
    // Same wording under two employers: prefer the fact for this entry's org.
    const sameOrg = entry.org ? exact.filter((f) => f.org && normForMatch(f.org) === normForMatch(entry.org ?? '')) : [];
    return (sameOrg.length ? sameOrg : exact).map((f) => f.id);
  }
  return [];
}

/** Returns a copy of `model` with fact ids attached to entries and bullets. Unmatched stay empty. */
export function linkFacts(model: CvModel, bank: FactBank): CvModel {
  return {
    ...model,
    sections: model.sections.map((section) => ({
      ...section,
      entries: section.entries.map((entry) => {
        const factId = findEntryFact(entry, bank.facts);
        return {
          ...entry,
          ...(factId ? { factId } : {}),
          bullets: entry.bullets.map((b) => ({ text: b.text, factIds: b.factIds.length ? [...b.factIds] : findBulletFacts(b, entry, bank.facts) })),
        };
      }),
    })),
  };
}

// ───────────────────────────── Rendering ─────────────────────────────

function sectionRule(title: string): string {
  const label = `% ── ${title.toUpperCase()} `;
  return label + '─'.repeat(Math.max(4, 80 - label.length));
}

function renderEntry(entry: CvEntry): string {
  const lines = [`\\role{${escapeLatex(entry.title)}}{${escapeLatex(entry.dates ?? '')}}`];
  if (entry.org || entry.location) lines.push(`\\org{${escapeLatex(entry.org ?? '')}}{${escapeLatex(entry.location ?? '')}}`);
  if (entry.note) lines.push(`\\note{${escapeLatex(entry.note)}}`);
  const bullets = entry.bullets.filter((b) => b.text.trim());
  if (bullets.length) {
    lines.push('\\begin{itemize}');
    for (const b of bullets) lines.push(`  \\item ${escapeLatex(b.text.trim())}`);
    lines.push('\\end{itemize}');
  }
  return lines.join('\n');
}

function renderSection(section: CvSection): string {
  const head = `${sectionRule(section.title)}\n\\section{${escapeLatex(section.title)}}\n\n`;
  if (section.raw !== undefined) return `${head}${section.raw.trim()}\n`;
  return `${head}${section.entries.map(renderEntry).join('\n\n\\entrygap\n')}\n`;
}

/** Renders the model with the master's own preamble and macros. */
export function renderCv(model: CvModel): string {
  const parts = [model.preamble.replace(/\s*$/, '\n'), `${model.header.trim()}\n`];
  if (model.summary.trim()) parts.push(`${sectionRule('Summary')}\n\\section{SUMMARY}\n\n${escapeLatex(model.summary.trim())}\n`);
  for (const section of model.sections) {
    if (section.raw === undefined && !section.entries.length) continue;
    parts.push(renderSection(section));
  }
  parts.push(model.postamble.includes('\\end{document}') ? model.postamble : '\\end{document}\n');
  return parts.join('\n');
}

// ───────────────────────────── Helpers ─────────────────────────────

/** Every bullet in reading order with its location in the model. */
export function allBullets(model: CvModel): { sectionIdx: number; entryIdx: number; bulletIdx: number; bullet: CvBullet; entry: CvEntry; section: CvSection }[] {
  const out: { sectionIdx: number; entryIdx: number; bulletIdx: number; bullet: CvBullet; entry: CvEntry; section: CvSection }[] = [];
  model.sections.forEach((section, sectionIdx) =>
    section.entries.forEach((entry, entryIdx) =>
      entry.bullets.forEach((bullet, bulletIdx) => out.push({ sectionIdx, entryIdx, bulletIdx, bullet, entry, section })),
    ),
  );
  return out;
}

/** Deep copy (the model is plain JSON). */
export function cloneModel(model: CvModel): CvModel {
  return structuredClone(model);
}
