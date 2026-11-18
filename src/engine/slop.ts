// Slop linter: flags the phrases and punctuation habits that make writing read as AI-generated,
// and repairs dash misuse. Pure functions, no I/O. Used on cover letters, screening answers,
// outreach drafts and prep packs before anything reaches Kayzee or an employer.

import type { FactBank } from '@/lib/types';

export interface SlopHit { rule: string; match: string }
export interface SlopResult { ok: boolean; hits: SlopHit[] }

export interface SlopOptions {
  /** Phrases that appear in the fact bank are allowed (e.g. "detail-oriented" if Kayzee really said it). */
  facts?: FactBank;
  /** Extra allowed strings, e.g. the company name or job title ("Dynamic Media Ltd"). */
  allow?: string[];
}

interface PhraseRule {
  rule: string;
  re: RegExp;
  /** The rule is skipped when this text (lowercase) appears in the facts or allow-list. */
  allowIfPresent?: string;
}

const w = (body: string): RegExp => new RegExp(`\\b(?:${body})\\b`, 'gi');

/** AI vocabulary and stock phrases. Each regex is global + case-insensitive. */
const PHRASE_RULES: PhraseRule[] = [
  { rule: 'ai-vocab:delve', re: w('delv(?:e|es|ed|ing)') },
  { rule: 'ai-vocab:tapestry', re: w('tapestr(?:y|ies)') },
  { rule: 'ai-vocab:leverage', re: w('leverag(?:e|es|ed|ing)') },
  { rule: 'ai-vocab:passionate', re: w('passionate(?:ly)?') },
  { rule: 'ai-vocab:thrilled', re: w('thrilled') },
  { rule: 'ai-vocab:testament', re: w('testament') },
  { rule: 'ai-vocab:fast-paced', re: w('fast[- ]paced') },
  { rule: 'ai-vocab:dynamic', re: w('dynamic'), allowIfPresent: 'dynamic' },
  { rule: 'ai-vocab:synergy', re: w('synerg(?:y|ies|istic)') },
  { rule: 'ai-vocab:spearhead', re: w('spearhead(?:s|ed|ing)?') },
  { rule: 'ai-vocab:robust', re: w('robust') },
  { rule: 'ai-vocab:seamless', re: w('seamless(?:ly)?') },
  { rule: 'ai-vocab:elevate', re: w('elevat(?:e|es|ed|ing)') },
  { rule: 'ai-vocab:results-driven', re: w('results[- ]driven') },
  { rule: 'ai-vocab:cutting-edge', re: w('cutting[- ]edge') },
  { rule: 'ai-vocab:utilize', re: w('utili[sz](?:e|es|ed|ing|ation)') },
  { rule: 'ai-vocab:facilitate', re: w('facilitat(?:e|es|ed|ing)'), allowIfPresent: 'facilitat' },
  { rule: 'ai-vocab:foster', re: w('foster(?:s|ed|ing)?'), allowIfPresent: 'foster' },
  { rule: 'ai-vocab:pivotal', re: w('pivotal') },
  { rule: 'ai-vocab:realm', re: w('realms?') },
  { rule: 'ai-vocab:landscape', re: w('landscapes?'), allowIfPresent: 'landscape' },
  { rule: 'ai-vocab:embark', re: w('embark(?:s|ed|ing)?') },
  { rule: 'ai-vocab:journey', re: w('journeys?'), allowIfPresent: 'journey' },
  { rule: 'ai-vocab:unwavering', re: w('unwavering(?:ly)?') },
  { rule: 'ai-vocab:meticulous', re: w('meticulous(?:ly)?') },
  { rule: 'ai-vocab:furthermore', re: w('furthermore') },
  { rule: 'ai-vocab:moreover', re: w('moreover') },
  { rule: 'ai-vocab:go-getter', re: w('go[- ]getters?') },
  { rule: 'ai-vocab:detail-oriented', re: w('detail[- ]oriented'), allowIfPresent: 'detail-oriented' },
  { rule: 'stock:in-todays', re: /\bin today['’]s\b/gi },
  { rule: 'stock:navigate-landscape', re: /\bnavigat(?:e|es|ed|ing)\s+(?:the\s+)?(?:\w+\s+)?landscapes?\b/gi },
  { rule: 'stock:writing-to-express', re: /\bI(?: am|['’]m) writing to express\b/gi },
  { rule: 'stock:excited-to-apply', re: /\bI(?: am|['’]m) (?:so |very |really )?excited to (?:apply|submit)\b/gi },
  { rule: 'stock:great-fit', re: /\bI(?: would|['’]d) be (?:a |an )?(?:great|perfect|ideal|excellent|strong) fit\b/gi },
  { rule: 'stock:proven-track-record', re: /\bproven track record\b/gi },
  { rule: 'stock:hit-the-ground-running', re: /\bhit the ground running\b/gi },
  { rule: 'stock:wear-many-hats', re: /\bwear(?:ing)? (?:many|multiple) hats\b/gi },
  { rule: 'stock:outside-the-box', re: /\bthink(?:ing)? outside (?:of )?the box\b/gi },
  { rule: 'stock:not-only-but-also', re: /\bnot only\b[^.!?\n]{1,120}?\bbut also\b/gi },
  { rule: 'stock:not-just-x-its-y', re: /\b(?:it|this|that)(?:['’]s| is) not just\b[^.!?\n]{1,80}?[,;]\s*(?:it|this|that)(?:['’]s| is)\b/gi },
];

const SENTENCE_START_ADDITIONALLY = /(?:^|[.!?]\s+|\n\s*)(Additionally)\b/g;

function allowedText(opts: SlopOptions): string {
  const parts: string[] = [];
  if (opts.facts) {
    parts.push(...opts.facts.facts.map((f) => f.text), ...opts.facts.skills, ...opts.facts.tools, ...Object.values(opts.facts.summaries));
  }
  if (opts.allow) parts.push(...opts.allow);
  return parts.join('\n').toLowerCase().replace(/\s+/g, ' ');
}

function phraseHits(text: string, allowed: string): SlopHit[] {
  const hits: SlopHit[] = [];
  for (const { rule, re, allowIfPresent } of PHRASE_RULES) {
    if (allowIfPresent && allowed.includes(allowIfPresent)) continue;
    for (const m of text.matchAll(re)) {
      // A phrase lifted verbatim from an allowed source (company name, fact) is not slop.
      if (allowed && allowed.includes(m[0].toLowerCase())) continue;
      hits.push({ rule, match: m[0] });
    }
  }
  for (const m of text.matchAll(SENTENCE_START_ADDITIONALLY)) hits.push({ rule: 'stock:additionally-sentence-start', match: m[1] });
  return hits;
}

/** Em dashes anywhere, en dashes / double hyphens used as punctuation, en dashes in number ranges. */
function dashHits(text: string): SlopHit[] {
  const hits: SlopHit[] = [];
  for (const m of text.matchAll(/\S{0,12}\s*—\s*\S{0,12}/g)) hits.push({ rule: 'dash:em-dash', match: m[0].trim() });
  for (const m of text.matchAll(/\S{0,12}(?:\s–\s|\s–(?=\w)|(?<=[A-Za-z])–(?=[A-Za-z]{2,}\s))\S{0,12}/g)) {
    hits.push({ rule: 'dash:en-dash-punctuation', match: m[0].trim() });
  }
  for (const m of text.matchAll(/\d\s?–\s?\d/g)) hits.push({ rule: 'dash:en-dash-range', match: m[0] });
  for (const m of text.matchAll(/\S{0,12}\s--\s\S{0,12}/g)) hits.push({ rule: 'dash:double-hyphen', match: m[0].trim() });
  return hits;
}

function punctuationHits(text: string, allowed: string): SlopHit[] {
  const hits: SlopHit[] = [];
  for (const m of text.matchAll(/[^\s!]{0,20}!+/g)) {
    // Brand names with a bang ("Yahoo!") are not exclamations when the allow-list carries them.
    if (allowed && allowed.includes(m[0].toLowerCase())) continue;
    hits.push({ rule: 'punct:exclamation', match: m[0] });
  }
  const questions = splitSentences(text).filter((s) => s.trim().endsWith('?'));
  if (questions.length > 1) {
    for (const q of questions) hits.push({ rule: 'punct:rhetorical-questions', match: q.trim().slice(-60) });
  }
  return hits;
}

/**
 * Rule-of-three abuse: "X, Y and Z" lists. One is natural; three or more in a short piece is a tell.
 * Each item is one to three words.
 */
const TRIAD = /\b[\w'’-]+(?: [\w'’-]+){0,2}, [\w'’-]+(?: [\w'’-]+){0,2},? (?:and|or) [\w'’-]+(?: [\w'’-]+){0,2}\b/g;
export const TRIAD_LIMIT = 2;

function triadHits(text: string): SlopHit[] {
  const triads = [...text.matchAll(TRIAD)].map((m) => m[0]);
  return triads.length > TRIAD_LIMIT ? triads.map((match) => ({ rule: 'style:rule-of-three', match })) : [];
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
}

/** Lints text for AI tells. `ok` is true only with zero hits. */
export function lintSlop(text: string, opts: SlopOptions = {}): SlopResult {
  const source = String(text ?? '');
  const allowed = allowedText(opts);
  const hits = [...dashHits(source), ...phraseHits(source, allowed), ...punctuationHits(source, allowed), ...triadHits(source)];
  return { ok: hits.length === 0, hits };
}

/** One line per hit, for regeneration prompts and dashboard badges. */
export function describeSlop(hits: SlopHit[]): string[] {
  return hits.map((h) => `${h.rule}: "${h.match}"`);
}

// ───────────────────────────── Dash repair ─────────────────────────────

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
/** Words that usually open an independent clause: a dash before them becomes a full stop. */
const CLAUSE_STARTERS = new Set([
  'i', "i'm", "i've", "i'd", "i'll", 'we', "we're", "we've", 'it', "it's", 'that', "that's", 'this', 'they', "they're",
  'you', "you're", 'he', 'she', 'there', "there's", 'these', 'those', 'my', 'our', 'his', 'her', 'their',
]);

function capitalise(s: string): string {
  return s.replace(/^(\s*["'“‘(]?)([a-z])/, (_, pre: string, ch: string) => pre + ch.toUpperCase());
}

/** Picks comma vs full stop for a dash whose right-hand side is `rest` (up to the sentence end). */
function joinAcrossDash(left: string, rest: string): string {
  const trimmedLeft = left.replace(/[\s,;:]+$/, '');
  const right = rest.replace(/^\s+/, '');
  if (!right) return `${trimmedLeft}.`;
  const firstWord = (right.match(/^[A-Za-z'’]+/)?.[0] ?? '').toLowerCase().replace('’', "'");
  const words = right.split(/\s+/).filter(Boolean).length;
  if (CLAUSE_STARTERS.has(firstWord) && words >= 4) return `${trimmedLeft}. ${capitalise(right)}`;
  return `${trimmedLeft}, ${right}`;
}

const PUNCT_DASH = '(?:\\s+[—–]\\s*|\\s*—\\s+|\\s+--\\s+|(?<=[A-Za-z,)])—(?=[A-Za-z(]))';

/**
 * Replaces em/en dashes used as punctuation with commas or full stops, and turns dash ranges
 * ("2022–2026", "Sep 2022 – Oct 2026", "Mon–Fri") into plain hyphens. Idempotent.
 */
export function fixDashes(text: string): string {
  let out = String(text ?? '');

  // 1. Ranges keep a hyphen: digits, month names, years to "present".
  out = out.replace(/(\d)\s*[–—]\s*(?=\d)/g, '$1-');
  out = out.replace(new RegExp(`(\\d{4}|${MONTH})\\s*[–—]\\s*(?=${MONTH}|present\\b|Present\\b|now\\b|today\\b)`, 'g'), (m, a: string) =>
    /\s/.test(m) ? `${a} - ` : `${a}-`,
  );
  out = out.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*[–—]\s*(?=(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))/g, '$1-');
  // Unspaced en dash between words is a compound or route ("Dublin–Belfast"): hyphen.
  out = out.replace(/(?<=[A-Za-z])–(?=[A-Za-z])/g, '-');

  // 2. Paired parenthetical dashes in one sentence: "X — Y — Z" → "X, Y, Z".
  const pair = new RegExp(`${PUNCT_DASH}([^.!?\\n—–]{1,80}?)${PUNCT_DASH}`, 'g');
  out = out.replace(pair, (_m, inner: string) => `, ${inner.trim()}, `);

  // 3. Remaining single dashes, processed per line so a dash never pulls in the next paragraph.
  out = out
    .split('\n')
    .map((line) => {
      const single = new RegExp(PUNCT_DASH);
      let guard = 0;
      while (single.test(line) && guard++ < 20) {
        const m = single.exec(line)!;
        const left = line.slice(0, m.index);
        const after = line.slice(m.index + m[0].length);
        const end = after.search(/[.!?](\s|$)/);
        const rest = end === -1 ? after : after.slice(0, end);
        const tail = end === -1 ? '' : after.slice(end);
        if (!left.trim()) {
          line = capitalise(after.replace(/^\s+/, '')); // a line that starts with a dash
          continue;
        }
        line = joinAcrossDash(left, rest) + tail;
      }
      return line;
    })
    .join('\n');

  // 4. Any stray em/en dash left (e.g. at a line end) becomes a comma; then tidy punctuation.
  out = out.replace(/\s*[—]\s*$/gm, '.').replace(/\s*[—]\s*/g, ', ');
  out = out.replace(/\s*–\s*/g, (m) => (m.trim() === m ? '-' : ', '));
  return tidyPunctuation(out);
}

function tidyPunctuation(text: string): string {
  return text
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?;:])(?=\s|$)/g, '$1')
    .replace(/([^.])\.[ \t]*\.(?!\.)/g, '$1.') // doubled full stop, but keep "..." ellipses
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])(?=\s|$)/g, '$1') // only stray spaces before punctuation, not ".NET"
    .replace(/[ \t]+$/gm, '');
}
