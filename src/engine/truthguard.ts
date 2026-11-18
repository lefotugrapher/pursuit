// Truth guard (SPEC §0.1). Pure functions, no I/O.
//
// Nothing reaches an employer unless it is backed by config/facts.json. A piece of text passes only if:
//   1. every number it states (digits, %, €/£/$, ratios like 1:1, multipliers like "doubled",
//      number words like "seven", ordinals like "second") appears in the evidence;
//   2. every capitalised name (organisation, product, tool, title, acronym) appears in the evidence
//      or in the bank's confirmed skills/tools;
//   3. no `facts.doNotClaim` phrase appears (case-insensitive, simple word stems);
//   4. no JD "gap" term appears unless the evidence itself contains it.
// Evidence is the cited facts for a CV bullet (guardBullet) or the whole bank for free text such as
// letters and summaries (guardText). The guard is deliberately conservative: a false alarm costs a
// rephrase (callers fall back to the master wording); a miss would put an invented claim in front of
// an employer.

import type { CvModel, Fact, FactBank, GuardResult } from '@/lib/types';

export interface GuardOptions {
  /** JD keywords not backed by facts; any of them appearing in the text is a problem. */
  gaps?: string[];
  /** Extra names allowed in free text (employer, job title, recipient, Kayzee's own name). */
  allowTerms?: string[];
}

export interface CvGuardResult extends GuardResult {
  rejectedBullets: { text: string; problems: string[] }[];
}

// ───────────────────────────── Text normalisation ─────────────────────────────

/** Lowercase, unify quotes/dashes, drop possessives, keep the characters names and numbers use. */
export function normText(text: string): string {
  return ` ${String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[‐-―−]/g, '-')
    .replace(/'s\b/g, '')
    .replace(/s'(?=[^\p{L}\p{N}]|$)/gu, 's')
    .replace(/[^\p{L}\p{N}&+%€£$:.,\-\s]/gu, ' ')
    .replace(/[.,](?=\s|$)/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/** True if `phrase` occurs in the normalised `corpus` on word boundaries. */
function containsPhrase(normCorpus: string, phrase: string): boolean {
  const p = normText(phrase).trim();
  if (!p) return true;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/\\-|\s/g, '[\\s-]')}(?![\\p{L}\\p{N}])`, 'u');
  return re.test(normCorpus);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

// ───────────────────────────── Numbers ─────────────────────────────

type ClaimKind = 'num' | 'ordinal' | 'ratio' | 'mult';
interface NumClaim { raw: string; kind: ClaimKind; value: number; percent: boolean; currency?: string; plus: boolean; ratio?: string }

const UNITS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, dozen: 12 };
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, twentieth: 20, hundredth: 100,
};
const MULTIPLIERS: Record<string, number> = {
  double: 2, doubled: 2, doubling: 2, doubles: 2, twice: 2, twofold: 2,
  triple: 3, tripled: 3, tripling: 3, triples: 3, threefold: 3, trebled: 3,
  quadrupled: 4, quadruple: 4, fourfold: 4, tenfold: 10, halved: 0.5, halving: 0.5,
};
// "one" is everywhere in normal prose; it only counts as a quantity in ranking-style phrases.
const ONE_CONTEXT = /\b(?:page|top|number|rank(?:ed)?|position)\s+one\b/gi;

function wordValue(word: string): number | undefined {
  const w = word.toLowerCase();
  if (UNITS[w] !== undefined) return UNITS[w];
  if (TENS[w] !== undefined) return TENS[w];
  if (BIG[w] !== undefined) return BIG[w];
  const compound = /^([a-z]+)-([a-z]+)$/.exec(w);
  if (compound && TENS[compound[1]] !== undefined) {
    const unit = compound[2] === 'one' ? 1 : UNITS[compound[2]];
    if (unit !== undefined && unit < 10) return TENS[compound[1]] + unit;
  }
  return undefined;
}

/** Extracts every numeric claim in `text`. */
export function extractNumbers(text: string): NumClaim[] {
  const src = String(text ?? '').replace(/[‐-―−]/g, '-');
  const claims: NumClaim[] = [];
  const consumed: [number, number][] = [];
  const take = (start: number, end: number) => consumed.push([start, end]);
  const isConsumed = (i: number) => consumed.some(([a, b]) => i >= a && i < b);

  for (const m of src.matchAll(/(\d+)\s*:\s*(\d+)/g)) {
    claims.push({ raw: m[0], kind: 'ratio', value: Number(m[1]) / Math.max(1, Number(m[2])), percent: false, plus: false, ratio: `${Number(m[1])}:${Number(m[2])}` });
    take(m.index, m.index + m[0].length);
  }
  for (const m of src.matchAll(/\b(\d+)(?:st|nd|rd|th)\b/gi)) {
    claims.push({ raw: m[0], kind: 'ordinal', value: Number(m[1]), percent: false, plus: false });
    take(m.index, m.index + m[0].length);
  }
  for (const m of src.matchAll(/\b(\d+(?:\.\d+)?)\s*x\b|\bx\s*(\d+(?:\.\d+)?)\b/gi)) {
    claims.push({ raw: m[0], kind: 'mult', value: Number(m[1] ?? m[2]), percent: false, plus: false });
    take(m.index, m.index + m[0].length);
  }
  const numRe = /([€£$]|\b(?:eur|gbp|usd)\s?)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s?(?:%|per\s?cent|percent)|\+|\s?k\b|\s?m\b|\s?million\b|\s?thousand\b)?/gi;
  for (const m of src.matchAll(numRe)) {
    const numStart = m.index + (m[1]?.length ?? 0);
    if (isConsumed(numStart)) continue;
    // A digit glued to letters (e.g. "N-TUTORR" is fine; "B2B", "Stamp1G") is a code, not a quantity.
    const before = src[m.index - 1] ?? '';
    const after = src[m.index + m[0].length] ?? '';
    if (/[A-Za-z]/.test(before) && !m[1]) continue;
    if (/[A-Za-z]/.test(after) && !m[3]) continue;
    let value = Number(m[2].replace(/,/g, ''));
    const suffix = (m[3] ?? '').trim().toLowerCase();
    if (suffix === 'k' || suffix === 'thousand') value *= 1000;
    if (suffix === 'm' || suffix === 'million') value *= 1_000_000;
    const cur = (m[1] ?? '').trim().toLowerCase();
    const currency = cur === '€' || cur === 'eur' ? 'EUR' : cur === '£' || cur === 'gbp' ? 'GBP' : cur === '$' || cur === 'usd' ? 'USD' : undefined;
    claims.push({
      raw: m[0].trim(),
      kind: 'num',
      value,
      percent: /%|cent/.test(suffix),
      plus: suffix === '+',
      ...(currency ? { currency } : {}),
    });
  }
  for (const m of src.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)?\b/g)) {
    const w = m[0].toLowerCase();
    const v = wordValue(w);
    if (v !== undefined) {
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 12);
      claims.push({ raw: m[0], kind: 'num', value: v, percent: /^\s?(?:%|per\s?cent|percent)/i.test(tail), plus: false });
    } else if (ORDINALS[w] !== undefined) claims.push({ raw: m[0], kind: 'ordinal', value: ORDINALS[w], percent: false, plus: false });
    else if (MULTIPLIERS[w] !== undefined) claims.push({ raw: m[0], kind: 'mult', value: MULTIPLIERS[w], percent: false, plus: false });
  }
  for (const m of src.matchAll(ONE_CONTEXT)) claims.push({ raw: m[0], kind: 'num', value: 1, percent: false, plus: false });
  return claims;
}

function claimSupported(claim: NumClaim, evidence: NumClaim[]): boolean {
  if (claim.kind === 'ratio') return evidence.some((e) => e.kind === 'ratio' && e.ratio === claim.ratio);
  const same = evidence.filter((e) => e.kind === claim.kind && Math.abs(e.value - claim.value) < 1e-9);
  if (!same.length) return false;
  if (claim.percent && !same.some((e) => e.percent)) return false;
  if (claim.currency && !same.some((e) => e.currency === claim.currency)) return false;
  if (claim.plus && !same.some((e) => e.plus)) return false;
  return true;
}

// ───────────────────────────── Names ─────────────────────────────

const CONNECTORS = new Set(['of', 'and', '&', 'the', 'to', 'by', 'for', 'de', 'on']);

/** Capitalised words that are not claims. */
const SAFE_CAPS = new Set([
  'i', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'dear', 'hi', 'hello', 'kind', 'regards', 'best', 'thanks', 'thank', 'sincerely', 'yours', 'cv', 'present',
]);

/** Common sentence-opening words (verbs in past tense, determiners, prepositions). */
const STARTERS = new Set([
  'a', 'an', 'the', 'as', 'at', 'for', 'in', 'on', 'with', 'through', 'across', 'from', 'by', 'to', 'over', 'under', 'using',
  'after', 'before', 'during', 'since', 'while', 'this', 'that', 'these', 'those', 'our', 'my', 'his', 'her', 'their', 'its',
  'each', 'every', 'all', 'both', 'also', 'and', 'but', 'so', 'then', 'when', 'where', 'it', 'we', 'you', 'he', 'she', 'they',
  'led', 'ran', 'built', 'grew', 'wrote', 'made', 'set', 'won', 'drove', 'took', 'kept', 'held', 'sold', 'brought', 'spoke',
  'sent', 'met', 'cut', 'put', 'began', 'found', 'shot', 'gave', 'taught', 'lead', 'run', 'build', 'write', 'manage', 'own',
  'help', 'support', 'create', 'plan', 'shoot', 'edit', 'film', 'design', 'research', 'present', 'organise', 'organize', 'co',
  'helped', 'previously', 'currently', 'now', 'here', 'there', 'what', 'why', 'how', 'if', 'i',
]);

interface Token { word: string; start: number; end: number }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’&.\-]*/gu)) {
    let word = m[0].replace(/[.'’\-]+$/u, '');
    word = word.replace(/['’]s$/u, '');
    if (word) out.push({ word, start: m.index, end: m.index + word.length });
  }
  return out;
}

const isCap = (w: string) => /^\p{Lu}/u.test(w) || /\p{Ll}\p{Lu}/u.test(w);
const isAcronymOrCamel = (w: string) => /\p{Lu}.*\p{Lu}/u.test(w) || /\p{Ll}\p{Lu}/u.test(w);

function atSentenceStart(text: string, start: number): boolean {
  const before = text.slice(0, start).replace(/[\s"'“‘(\[]+$/u, '');
  return before === '' || /[.!?:;•\n]$/.test(before) || /[\n\r]\s*$/.test(text.slice(0, start));
}

/** Runs of capitalised tokens, allowing connector words between them ("Visit Things to Do"). */
function capitalisedRuns(text: string): { phrase: string; parts: string[]; atStart: boolean; first: string }[] {
  const tokens = tokenize(text);
  const runs: { phrase: string; parts: string[]; atStart: boolean; first: string }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!isCap(t.word) || /^\p{N}+$/u.test(t.word)) {
      i++;
      continue;
    }
    const members: Token[] = [t];
    let j = i + 1;
    while (j < tokens.length) {
      const gap = text.slice(members[members.length - 1].end, tokens[j].start);
      if (!/^\s+$/.test(gap) && gap !== '') break;
      if (isCap(tokens[j].word)) {
        members.push(tokens[j]);
        j++;
        continue;
      }
      const next = tokens[j + 1];
      const gap2 = next ? text.slice(tokens[j].end, next.start) : '';
      if (CONNECTORS.has(tokens[j].word.toLowerCase()) && next && isCap(next.word) && /^\s+$/.test(gap2)) {
        members.push(tokens[j], next);
        j += 2;
        continue;
      }
      break;
    }
    runs.push({
      phrase: text.slice(members[0].start, members[members.length - 1].end),
      parts: members.map((m) => m.word),
      atStart: atSentenceStart(text, t.start),
      first: t.word,
    });
    i = j;
  }
  return runs;
}

function lowercaseVocabulary(bank: FactBank): Set<string> {
  const vocab = new Set<string>();
  const texts = [...bank.facts.flatMap((f) => [f.text, f.cvBullet ?? '']), ...Object.values(bank.summaries), ...bank.skills];
  for (const t of texts) for (const m of t.matchAll(/\b\p{Ll}[\p{L}'-]*/gu)) vocab.add(m[0]);
  return vocab;
}

function namesProblems(text: string, normCorpus: string, bank: FactBank, allow: string[]): string[] {
  const problems: string[] = [];
  const vocab = lowercaseVocabulary(bank);
  const normAllow = normText(allow.join(' | '));
  const known = (phrase: string) => containsPhrase(normCorpus, phrase) || (allow.length > 0 && containsPhrase(normAllow, phrase));
  for (const run of capitalisedRuns(text)) {
    let parts = [...run.parts];
    if (run.atStart && !isAcronymOrCamel(run.first)) {
      const lw = run.first.toLowerCase();
      if (STARTERS.has(lw) || vocab.has(lw) || /(?:ed|ing|ised|ized)$/.test(lw)) {
        parts = parts.slice(1);
        while (parts.length && CONNECTORS.has(parts[0].toLowerCase())) parts.shift();
      }
    }
    if (!parts.length) continue;
    const phrase = parts.join(' ');
    if (known(phrase)) continue;
    // Fall back to the pieces between connectors ("Instagram and TikTok" → "Instagram", "TikTok").
    const pieces: string[][] = [[]];
    for (const p of parts) {
      if (CONNECTORS.has(p.toLowerCase())) pieces.push([]);
      else pieces[pieces.length - 1].push(p);
    }
    for (const piece of pieces) {
      const words = piece.filter((w) => !SAFE_CAPS.has(w.toLowerCase()));
      if (!words.length) continue;
      const sub = piece.join(' ');
      if (known(sub)) continue;
      // Title-case runs of safe words + a known name ("Since Jan Canopy Coffee") are judged by their unsafe words.
      if (words.length !== piece.length && known(words.join(' '))) continue;
      problems.push(`unverified name "${sub}" (not in the cited facts, skills or tools)`);
    }
  }
  return problems;
}

// ───────────────────────────── Phrases (doNotClaim, gaps) ─────────────────────────────

const SUFFIXES = '(?:e|es|s|y|ies|ed|ing|ion|ions|er|ers)?';

function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return escapeRe(w);
  if (w.endsWith('ies')) return `${escapeRe(w.slice(0, -3))}`;
  if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return escapeRe(w);
}

/**
 * Regex for a phrase. Lowercase phrases match simple inflections word by word ("media monitoring"
 * also catches "media monitored", "Media-Monitoring"); phrases with capitals or digits (brands,
 * titles, "Stamp 1G") match exactly, case-insensitive, with an optional possessive.
 */
export function phraseRegex(phrase: string): RegExp | null {
  const words = phrase.trim().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return null;
  const exact = /\p{Lu}/u.test(phrase) || /\d/.test(phrase);
  const parts = words.map((w) => (exact ? escapeRe(w.toLowerCase()) : `${stem(w)}${SUFFIXES}`));
  const tail = exact ? "(?:'s|’s)?" : '';
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("[\\s\\-'’]+")}${tail}(?![\\p{L}\\p{N}])`, 'iu');
}

function matches(phrase: string, text: string): string | null {
  const re = phraseRegex(phrase);
  if (!re) return null;
  const m = re.exec(text);
  return m ? m[0] : null;
}

// ───────────────────────────── Evidence ─────────────────────────────

interface Evidence { texts: string[]; numbers: NumClaim[]; normCorpus: string; rawCorpus: string }

function factTexts(f: Fact): string[] {
  return [f.text, f.cvBullet ?? '', f.org ?? '', f.title ?? '', f.start ?? '', f.end ?? '', ...(f.numbers ?? [])].filter(Boolean);
}

function buildEvidence(texts: string[], nameExtras: string[]): Evidence {
  const numbers = texts.flatMap(extractNumbers);
  const rawCorpus = [...texts, ...nameExtras].join(' | ');
  return { texts, numbers, normCorpus: normText(rawCorpus), rawCorpus };
}

function check(text: string, evidence: Evidence, bank: FactBank, opts: GuardOptions): string[] {
  const problems: string[] = [];
  if (!String(text ?? '').trim()) return ['empty text'];

  const allowNumbers = (opts.allowTerms ?? []).flatMap(extractNumbers);
  const seen = new Set<string>();
  for (const claim of extractNumbers(text)) {
    if (claimSupported(claim, evidence.numbers) || claimSupported(claim, allowNumbers)) continue;
    const key = claim.raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(`invented number "${claim.raw}" (not in the cited facts)`);
  }

  problems.push(...namesProblems(text, evidence.normCorpus, bank, opts.allowTerms ?? []));

  for (const phrase of bank.doNotClaim) {
    const hit = matches(phrase, text);
    if (hit) problems.push(`do-not-claim phrase "${phrase}" (matched "${hit}")`);
  }

  for (const gap of opts.gaps ?? []) {
    if (!gap.trim()) continue;
    const hit = matches(gap, text);
    if (hit && !matches(gap, evidence.rawCorpus)) problems.push(`claims JD gap "${gap}" (not backed by facts)`);
  }
  return [...new Set(problems)];
}

// ───────────────────────────── Public API ─────────────────────────────

/** Guards one CV bullet against the facts it cites (plus the bank's confirmed skills and tools). */
export function guardBullet(text: string, factIds: string[], facts: FactBank, opts: GuardOptions = {}): GuardResult {
  const problems: string[] = [];
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const cited: Fact[] = [];
  for (const id of factIds) {
    const f = byId.get(id);
    if (f) cited.push(f);
    else problems.push(`cites unknown fact id "${id}"`);
  }
  if (!factIds.length) problems.push('cites no facts');
  const evidence = buildEvidence(cited.flatMap(factTexts), [...facts.skills, ...facts.tools]);
  problems.push(...check(text, evidence, facts, opts));
  return { ok: problems.length === 0, problems };
}

/** Guards free text (cover letters, summaries, emails) against the whole fact bank. */
export function guardText(text: string, facts: FactBank, opts: GuardOptions = {}): GuardResult {
  const texts = [...facts.facts.flatMap(factTexts), ...Object.values(facts.summaries)];
  const evidence = buildEvidence(texts, [...facts.skills, ...facts.tools]);
  const problems = check(text, evidence, facts, opts);
  return { ok: problems.length === 0, problems };
}

/** Guards every bullet (against its cited facts) and the summary (against the bank) of a CV model. */
export function guardCv(model: CvModel, facts: FactBank, gaps: string[] = []): CvGuardResult {
  const rejectedBullets: { text: string; problems: string[] }[] = [];
  const problems: string[] = [];
  if (model.summary.trim()) {
    const g = guardText(model.summary, facts, { gaps });
    if (!g.ok) problems.push(...g.problems.map((p) => `summary: ${p}`));
  }
  for (const section of model.sections) {
    for (const entry of section.entries) {
      for (const bullet of entry.bullets) {
        const g = guardBullet(bullet.text, bullet.factIds, facts, { gaps });
        if (!g.ok) {
          rejectedBullets.push({ text: bullet.text, problems: g.problems });
          problems.push(...g.problems.map((p) => `${entry.org ?? entry.title}: ${p}`));
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, rejectedBullets };
}
