// ATS parse check for a compiled CV PDF. Server-only.
//
// "Beat the ATS" here means: the PDF's text layer is extractable and clean, the standard headings
// and contact details are machine-readable, it fits on two A4 pages, and the keywords Kayzee can
// honestly claim (matched by facts) actually made it into the text. JD gaps never count against him.
//
// Score (0-100), additive:
//   text extractable ............ 30  (gate: if no usable text layer the score is capped at 10)
//   no bad characters ........... 10  (U+2011, soft hyphens, ligatures, private-use, U+FFFD...)
//   page count .................. 15  (≤2 pages: 15, exactly 3: 5, more: 0)
//   standard sections ........... 15  (pro rata over SUMMARY, EXPERIENCE, EDUCATION, SKILLS)
//   contact line ................ 10  (email 5 + phone 5)
//   claimable keywords carried .. 20  (share of kw.matched terms found in the text, by weight; full marks if none)

import fs from 'node:fs';
import { extractText, getDocumentProxy } from 'unpdf';
import type { AtsReport, KeywordCoverage } from '@/lib/types';

export const ATS_WEIGHTS = { text: 30, chars: 10, pages: 15, sections: 15, contact: 10, keywords: 20 } as const;
export const MAX_PAGES = 2;

/** Headings an ATS looks for, with the variants that count as each. */
export const EXPECTED_SECTIONS: { name: string; pattern: RegExp }[] = [
  { name: 'SUMMARY', pattern: /^(professional\s+)?(summary|profile|personal statement)$/i },
  { name: 'EXPERIENCE', pattern: /^(work\s+|professional\s+|relevant\s+)?(experience|employment( history)?)$/i },
  { name: 'EDUCATION', pattern: /^education( and qualifications)?$/i },
  { name: 'SKILLS', pattern: /^(key\s+|core\s+)?skills$/i },
];

const BAD_CHARS: { re: RegExp; label: string }[] = [
  { re: /\u2011/, label: 'U+2011 non-breaking hyphen' },
  { re: /\u00AD/, label: 'U+00AD soft hyphen' },
  { re: /\uFFFD/, label: 'U+FFFD replacement character' },
  { re: /[\uFB00-\uFB06]/, label: 'ligature glyph (ﬁ/ﬂ)' },
  { re: /[\uE000-\uF8FF]/, label: 'private-use glyph' },
  { re: /[\u200B-\u200D\uFEFF]/, label: 'zero-width character' },
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{3,4}/;

/** Text normalised for keyword search: lowercase, ASCII dashes/quotes, line-break hyphens rejoined. */
export function normalizeForSearch(text: string): string {
  return ` ${text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/-\s*\n\s*/g, '-')
    .replace(/[^\p{L}\p{N}&+%'#./-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

export function termInText(term: string, normText: string): boolean {
  const t = normalizeForSearch(term).trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
  // Allow a plural/inflection tail so "press release" finds "press releases".
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`, 'u').test(normText);
}

export interface PdfText { text: string; pages: number }

/** Extracts merged text + page count. Throws if the file is unreadable or not a PDF. */
export async function readPdfText(pdfPath: string): Promise<PdfText> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await getDocumentProxy(data);
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join('\n') : text, pages: pdf.numPages };
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}

/** Page count only (used by the tailoring loop to keep the CV at two pages). */
export async function pdfPageCount(pdfPath: string): Promise<number> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await getDocumentProxy(data);
  try {
    return pdf.numPages;
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}

function weightOf(term: string, kw: KeywordCoverage): number {
  const hit = kw.keywords.find((k) => k.term.toLowerCase() === term.toLowerCase());
  return hit && hit.weight > 0 ? hit.weight : 1;
}

function emptyReport(problem: string): AtsReport {
  return {
    score: 0, pages: 0, textExtractable: false, badChars: [], sectionsFound: [], sectionsMissing: EXPECTED_SECTIONS.map((s) => s.name),
    contactFound: false, keywordPct: 0, keywordsInText: [], keywordsMissing: [], problems: [problem],
  };
}

/** Builds the report from already-extracted text (exported for tests and re-checks). */
export function analyzeText(text: string, pages: number, kw: KeywordCoverage): AtsReport {
  const problems: string[] = [];
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const textExtractable = letters >= 300;
  if (!textExtractable) problems.push(`Text layer is missing or too thin (${letters} letters extracted).`);

  const badChars = BAD_CHARS.filter((b) => b.re.test(text)).map((b) => b.label);
  if (badChars.length) problems.push(`Characters that break ATS keyword matching: ${badChars.join(', ')}.`);

  if (pages > MAX_PAGES) problems.push(`CV runs to ${pages} pages (limit ${MAX_PAGES}).`);

  const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' '));
  const sectionsFound = EXPECTED_SECTIONS.filter((s) => lines.some((l) => s.pattern.test(l))).map((s) => s.name);
  const sectionsMissing = EXPECTED_SECTIONS.map((s) => s.name).filter((n) => !sectionsFound.includes(n));
  if (sectionsMissing.length) problems.push(`Standard headings not found as their own line: ${sectionsMissing.join(', ')}.`);

  const head = text.slice(0, 600);
  const hasEmail = EMAIL_RE.test(head);
  const hasPhone = PHONE_RE.test(head);
  const contactFound = hasEmail && hasPhone;
  if (!hasEmail) problems.push('No email address in the first lines of the PDF text.');
  if (!hasPhone) problems.push('No phone number in the first lines of the PDF text.');

  const norm = normalizeForSearch(text);
  const jdTerms = kw.keywords.length ? kw.keywords.map((k) => k.term) : kw.matched.map((m) => m.term);
  const keywordsInText = [...new Set(jdTerms.filter((t) => termInText(t, norm)))];
  const totalJd = jdTerms.reduce((s, t) => s + weightOf(t, kw), 0);
  const foundJd = keywordsInText.reduce((s, t) => s + weightOf(t, kw), 0);
  const keywordPct = totalJd > 0 ? Math.round((foundJd / totalJd) * 100) : 0;

  const claimable = [...new Set(kw.matched.map((m) => m.term))];
  const keywordsMissing = claimable.filter((t) => !termInText(t, norm));
  const claimTotal = claimable.reduce((s, t) => s + weightOf(t, kw), 0);
  const claimFound = claimable.filter((t) => !keywordsMissing.includes(t)).reduce((s, t) => s + weightOf(t, kw), 0);
  const carryRate = claimTotal > 0 ? claimFound / claimTotal : 1;
  if (keywordsMissing.length) problems.push(`Keywords backed by facts but missing from the PDF text: ${keywordsMissing.join(', ')}.`);

  const pageScore = pages <= MAX_PAGES && pages > 0 ? ATS_WEIGHTS.pages : pages === MAX_PAGES + 1 ? 5 : 0;
  let score =
    (textExtractable ? ATS_WEIGHTS.text : 0) +
    (badChars.length ? 0 : ATS_WEIGHTS.chars) +
    pageScore +
    ATS_WEIGHTS.sections * (sectionsFound.length / EXPECTED_SECTIONS.length) +
    (hasEmail ? ATS_WEIGHTS.contact / 2 : 0) +
    (hasPhone ? ATS_WEIGHTS.contact / 2 : 0) +
    ATS_WEIGHTS.keywords * carryRate;
  if (!textExtractable) score = Math.min(score, 10);

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    pages,
    textExtractable,
    badChars,
    sectionsFound,
    sectionsMissing,
    contactFound,
    keywordPct,
    keywordsInText,
    keywordsMissing,
    problems,
  };
}

/** Parses the PDF like an ATS would and scores it. Never throws. */
export async function atsCheck(pdfPath: string, kw: KeywordCoverage): Promise<AtsReport> {
  if (!fs.existsSync(pdfPath)) return emptyReport(`PDF not found: ${pdfPath}`);
  let extracted: PdfText;
  try {
    extracted = await readPdfText(pdfPath);
  } catch (err) {
    return emptyReport(`Could not read the PDF: ${(err as Error).message}`);
  }
  return analyzeText(extracted.text, extracted.pages, kw);
}
