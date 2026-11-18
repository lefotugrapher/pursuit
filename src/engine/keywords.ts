// JD keyword extraction and fact-bank coverage.
//
// extractKeywords: deterministic lexicon matching (synonyms + light stemming) weighted by where
// in the JD a term appears (requirements/essential > duties > intro > desirable > about us), plus a
// conservative pass that picks up tool/brand names after "experience with ..." style cues.
// coverage: a keyword is matched only when the fact bank backs it (fact text/tags, or the claimable
// skills/tools lists). doNotClaim terms are never matched. Unbacked keywords are gaps: shown to
// Kayzee, never claimed.

import type { Fact, FactBank, Keyword, KeywordCoverage } from '@/lib/types';
import {
  compiledLexicon,
  findLexiconEntry,
  normalizePhrase,
  normalizedHaystack,
  tokenize,
  variantsFor,
  type CompiledEntry,
  type KeywordKind,
} from './lexicon';

// ───────────────────────────── JD sections ─────────────────────────────

export type JdSection = 'requirements' | 'responsibilities' | 'desirable' | 'about' | 'intro';

export const SECTION_WEIGHTS: Record<JdSection, number> = {
  requirements: 1,
  responsibilities: 0.85,
  intro: 0.7,
  desirable: 0.5,
  about: 0.25,
};

export interface JdLine {
  text: string;
  section: JdSection;
  weight: number;
  /** Line reads as optional (desirable section or "ideally", "a plus", ...). */
  optional: boolean;
}

const HEADING_RULES: [RegExp, JdSection][] = [
  [/\b(desirable|nice[- ]to[- ]haves?|bonus|advantageous|preferred|added advantage|would be an? (advantage|plus)|beneficial)\b/, 'desirable'],
  [/\babout (you|the candidate|the person)\b|\bwho you are\b|\bwhat you('?ll| will)? (need|bring|have)\b|\byou (will )?(have|bring)\b|\brequirements?\b|\brequired\b|\bessential\b|\bmust[- ]haves?\b|\bqualifications?\b|\bskills\b|\bexperience\b|person specification|\bcriteria\b|looking for|ideal candidate|\bthe person\b|your profile|competenc/, 'requirements'],
  [/\babout (the )?(role|job|position|opportunity)\b|responsibilit|\bduties\b|\bthe role\b|what you('?ll| will)? (do|be doing)|key tasks|day[- ]to[- ]day|role overview|your role|job description|main tasks|\bthe job\b|whats involved|in this role|\bthe opportunity\b/, 'responsibilities'],
  [/\babout\b|who we are|\bour (company|story|mission|values|team|culture|client)\b|company overview|\bbenefits\b|what we offer|\bperks\b|why (join|work)|equal opportunit|diversity|inclusion|how to apply|\bpackage\b|\breward|\bsalary\b|\bcompensation\b/, 'about'],
];

const OPTIONAL_CUE = /\b(desirable|ideally|preferabl[ey]|preferred|advantage|advantageous|bonus|nice to have|a plus|beneficial|not essential|would be (great|good|helpful|beneficial|useful)|is helpful|an asset)\b/;
const ESSENTIAL_CUE = /\b(essential|must|required|mandatory|minimum|at least|you will have|you have|you'll have|you need)\b/;

const INLINE_HEADING = /\s(?=(?:Key Responsibilities|Main Responsibilities|Responsibilities|Requirements|Essential(?: Criteria| Requirements| Skills)?|Desirable(?: Criteria| Requirements| Skills)?|Qualifications|About (?:Us|You|the Role|the Company)|What You(?:['’]ll| Will) (?:Do|Bring|Need)|Who You Are|Benefits|What We Offer|Nice to Have)\s*:)/g;

export function classifyHeading(text: string): JdSection | null {
  const t = text.toLowerCase().replace(/['’]/g, '').trim();
  for (const [re, section] of HEADING_RULES) if (re.test(t)) return section;
  return null;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function looksLikeStandaloneHeading(line: string): boolean {
  if (line.length > 60 || wordCount(line) > 7 || /[.!]$/.test(line)) return false;
  const letters = line.replace(/[^A-Za-z]/g, '');
  const allCaps = letters.length >= 3 && letters === letters.toUpperCase();
  const titleCase = line
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .every((w) => /^[A-Z(&]/.test(w));
  return allCaps || titleCase || line.endsWith('?');
}

/**
 * Whole-line headings recognised even in sentence case ("Nice to have", "What you'll bring").
 * Anchored so a bullet such as "Excellent communication skills" never switches section.
 */
const KNOWN_HEADING = new RegExp(
  '^(' +
    [
      'nice to haves?', 'bonus points', 'desirable( skills| criteria| requirements| qualifications| experience)?',
      'preferred (skills|qualifications|experience)', 'essential( skills| criteria| requirements| qualifications)?',
      'requirements', 'minimum (requirements|qualifications)', 'qualifications', 'skills( and experience)?',
      'experience', 'person specification', 'who you are', 'about you', 'what you(ll| will) (bring|need|have)',
      'what (were|we are) looking for', '(key |main )?responsibilities', '(key )?duties', 'the role', 'your role',
      'role overview', 'what you(ll| will) (do|be doing)', 'about (the )?(role|job|position|opportunity)',
      'about us', 'about the (company|team)', 'who we are', 'benefits', 'perks', 'what we offer', 'how to apply',
    ].join('|') +
    ')\\s*[:?!]?$',
);

/** Detects a heading line; `rest` is any content after "Heading:". */
function parseHeading(line: string): { section: JdSection; rest: string } | null {
  const colon = line.match(/^([^:]{2,60}):\s*(.*)$/);
  if (colon && wordCount(colon[1]) <= 7) {
    const section = classifyHeading(colon[1]);
    if (section) return { section, rest: colon[2] };
  }
  const plain = line.toLowerCase().replace(/['’]/g, '').trim();
  if (looksLikeStandaloneHeading(line) || KNOWN_HEADING.test(plain)) {
    const section = classifyHeading(line);
    if (section) return { section, rest: '' };
  }
  return null;
}

function lineFor(text: string, section: JdSection): JdLine {
  const lower = text.toLowerCase();
  const optionalCue = OPTIONAL_CUE.test(lower);
  let weight = SECTION_WEIGHTS[section];
  if (optionalCue) weight = Math.min(weight, SECTION_WEIGHTS.desirable);
  else if (section !== 'about' && ESSENTIAL_CUE.test(lower)) weight = Math.max(weight, SECTION_WEIGHTS.requirements);
  return { text, section, weight, optional: section === 'desirable' || optionalCue };
}

/** Splits a plain-text JD into lines tagged with the section they belong to. */
export function splitJdLines(jd: string): JdLine[] {
  const raw = String(jd ?? '')
    .replace(INLINE_HEADING, '\n')
    .split(/\r?\n|[•▪◦●·]/);
  const out: JdLine[] = [];
  let section: JdSection = 'intro';
  for (const rawLine of raw) {
    const line = rawLine.replace(/^[\s\-*>#–—]+/, '').trim();
    if (!line) continue;
    const heading = parseHeading(line);
    if (heading) {
      section = heading.section;
      // The heading text itself still counts as content ("Experience with Canva:" etc.).
      out.push(lineFor(line, section));
      continue;
    }
    out.push(lineFor(line, section));
  }
  return out;
}

/** Sentences of a line (keeps the line's section info). */
export function splitSentences(line: JdLine): JdLine[] {
  return line.text
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9(])/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ ...line, text: s }));
}

// ───────────────────────────── Extraction ─────────────────────────────

const KIND_FACTOR: Record<KeywordKind, number> = { skill: 1, tool: 0.9, duty: 0.85, domain: 0.45, soft: 0.35 };
const DEFAULT_LIMIT = 30;
const EXTRA_TOOL_FACTOR = 0.6;
const MAX_EXTRA_TOOLS = 5;

interface Variant { c: CompiledEntry; tokens: string[] }
let firstTokenIndex: Map<string, Variant[]> | null = null;

function variantIndex(): Map<string, Variant[]> {
  if (firstTokenIndex) return firstTokenIndex;
  const index = new Map<string, Variant[]>();
  for (const c of compiledLexicon()) {
    for (const tokens of c.variants) {
      const list = index.get(tokens[0]) ?? [];
      list.push({ c, tokens });
      index.set(tokens[0], list);
    }
  }
  for (const list of index.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  firstTokenIndex = index;
  return index;
}

function matchesAt(tokens: string[], i: number, phrase: string[]): boolean {
  if (i + phrase.length > tokens.length) return false;
  for (let k = 0; k < phrase.length; k++) if (tokens[i + k] !== phrase[k]) return false;
  return true;
}

/** Greedy longest-match, left to right: "google analytics" wins over "analytics". */
function lexiconHits(text: string): CompiledEntry[] {
  const tokens = tokenize(text);
  const index = variantIndex();
  const hits: CompiledEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const candidates = index.get(tokens[i]);
    const found = candidates?.find((v) => matchesAt(tokens, i, v.tokens));
    if (found) {
      hits.push(found.c);
      i += found.tokens.length;
    } else {
      i += 1;
    }
  }
  return hits;
}

interface Tally { term: string; kind: KeywordKind; importance: number; count: number; maxWeight: number }

function weightOf(t: Tally): number {
  const freqBoost = 1 + 0.1 * Math.min(t.count - 1, 3);
  const w = t.maxWeight * KIND_FACTOR[t.kind] * t.importance * freqBoost;
  return Math.round(Math.min(1, w) * 100) / 100;
}

const TOOL_CUE = /(?:experience (?:with|of|in|using)|knowledge of|proficien(?:t|cy) (?:in|with)|familiar(?:ity)? with|skilled in|competent in|expertise in|hands[- ]on with|working knowledge of)\s+([^.;:\n]{2,140})/gi;
const NOT_TOOLS = new Set([
  'ireland', 'irish', 'english', 'uk', 'eu', 'europe', 'emea', 'dublin', 'belfast', 'the', 'a', 'an', 'our', 'we',
  'pr', 'seo', 'ai', 'it', 'b2b', 'b2c', 'kpis', 'kpi', 'crm', 'cms', 'tv', 'i',
]);

/** Proper-noun tool/brand names after "experience with ..." cues that the lexicon doesn't know. */
function extraTools(lines: JdLine[], known: Set<string>): Tally[] {
  const out = new Map<string, Tally>();
  for (const line of lines) {
    if (line.section === 'about') continue;
    for (const m of line.text.matchAll(TOOL_CUE)) {
      for (const chunk of m[1].split(/,|\/|\(|\)|\band\b|\bor\b|\betc\b|\bsuch as\b|\bincluding\b|\be\.g\./i)) {
        const name = chunk.trim().replace(/^(the|a|an)\s+/i, '');
        const words = name.split(/\s+/).filter(Boolean);
        if (words.length < 1 || words.length > 3) continue;
        if (!words.every((w) => /^[A-Z][A-Za-z0-9.+-]*$|^[A-Za-z]*[A-Z][A-Za-z]*[0-9]*$/.test(w))) continue;
        const norm = normalizePhrase(name);
        if (!norm || NOT_TOOLS.has(name.toLowerCase()) || known.has(norm) || findLexiconEntry(name)) continue;
        const prev = out.get(norm);
        const weight = line.weight * EXTRA_TOOL_FACTOR;
        if (prev) {
          prev.count += 1;
          prev.maxWeight = Math.max(prev.maxWeight, weight);
        } else {
          out.set(norm, { term: name, kind: 'tool', importance: 1, count: 1, maxWeight: weight });
        }
      }
    }
  }
  return [...out.values()].slice(0, MAX_EXTRA_TOOLS);
}

/**
 * Top keywords (skills, tools, duties, domains, soft skills) in a JD, weighted 0-1 by section
 * (requirements > responsibilities > intro > desirable > about), kind and frequency.
 */
export function extractKeywords(jd: string, opts: { limit?: number } = {}): Keyword[] {
  const lines = splitJdLines(jd);
  const tallies = new Map<string, Tally>();
  for (const line of lines) {
    for (const c of lexiconHits(line.text)) {
      const key = c.entry.term;
      const prev = tallies.get(key);
      if (prev) {
        prev.count += 1;
        prev.maxWeight = Math.max(prev.maxWeight, line.weight);
      } else {
        tallies.set(key, { term: key, kind: c.entry.kind, importance: c.entry.importance ?? 1, count: 1, maxWeight: line.weight });
      }
    }
  }
  const known = new Set([...tallies.keys()].map(normalizePhrase));
  const all = [...tallies.values(), ...extraTools(lines, known)];
  return all
    .map((t) => ({ term: t.term, kind: t.kind, weight: weightOf(t), count: t.count }))
    .filter((k) => k.weight > 0)
    .sort((a, b) => b.weight - a.weight || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, opts.limit ?? DEFAULT_LIMIT)
    .map(({ term, kind, weight }) => ({ term, kind, weight }));
}

// ───────────────────────────── Coverage ─────────────────────────────

interface FactEvidence { id: string; rank: number; hay: string; tags: Set<string> }
interface FactIndex { facts: FactEvidence[]; claimable: string[]; doNotClaim: string[] }

/** Facts that describe interests, not capabilities, never back a keyword. */
const NON_EVIDENCE_TAGS = new Set(['interests']);
const MAX_FACT_IDS = 6;
/** Most specific evidence first when citing facts. */
const KIND_RANK: Record<Fact['kind'], number> = {
  achievement: 0, project: 1, role: 2, award: 3, skill: 4, tool: 4, education: 5, summary: 6, other: 7,
};

function buildFactIndex(bank: FactBank): FactIndex {
  const facts = bank.facts
    .filter((f) => !f.tags.some((t) => NON_EVIDENCE_TAGS.has(t.toLowerCase())))
    .map((f) => ({
      id: f.id,
      rank: KIND_RANK[f.kind] ?? 7,
      // Text + original bullet only: a role's title/org would make every fact of that role match.
      hay: normalizedHaystack([f.text, f.cvBullet].filter(Boolean).join(' . ')),
      tags: new Set(f.tags.map((t) => normalizePhrase(t.replace(/[-_]/g, ' '))).filter(Boolean)),
    }));
  return {
    facts,
    claimable: [...bank.skills, ...bank.tools].map(normalizedHaystack),
    doNotClaim: bank.doNotClaim.map(normalizePhrase).filter(Boolean),
  };
}

/** True when the term or one of its phrasings contains a doNotClaim phrase. */
export function isDoNotClaim(term: string, doNotClaim: string[]): boolean {
  const phrasings = [normalizePhrase(term), ...variantsFor(term)];
  return phrasings.some((p) => doNotClaim.some((d) => ` ${p} `.includes(` ${d} `)));
}

function factIdsFor(term: string, index: FactIndex): string[] {
  const variants = variantsFor(term);
  const evidence = findLexiconEntry(term)?.evidence ?? [];
  return index.facts
    .filter(
      (f) =>
        variants.some((v) => f.tags.has(v) || f.hay.includes(` ${v} `)) ||
        evidence.some((p) => f.hay.includes(` ${p} `)),
    )
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_FACT_IDS)
    .map((f) => f.id);
}

function inClaimableLists(term: string, index: FactIndex): boolean {
  const variants = variantsFor(term);
  return index.claimable.some((hay) => variants.some((v) => hay.includes(` ${v} `)));
}

/**
 * Which JD keywords the fact bank backs. `matched[].factIds` lists supporting fact ids; it can be
 * empty when the only backing is the bank's claimable skills/tools list. pct is weighted 0-100.
 */
export function coverage(keywords: Keyword[], facts: FactBank): KeywordCoverage {
  const index = buildFactIndex(facts);
  const matched: KeywordCoverage['matched'] = [];
  const gaps: string[] = [];
  let total = 0;
  let hit = 0;
  for (const kw of keywords) {
    const weight = Math.max(0, kw.weight);
    total += weight;
    if (isDoNotClaim(kw.term, index.doNotClaim)) {
      gaps.push(kw.term);
      continue;
    }
    const factIds = factIdsFor(kw.term, index);
    if (factIds.length || inClaimableLists(kw.term, index)) {
      matched.push({ term: kw.term, factIds });
      hit += weight;
    } else {
      gaps.push(kw.term);
    }
  }
  const pct = total > 0 ? Math.round((hit / total) * 100) : 0;
  return { keywords, matched, gaps, pct };
}

/** Convenience: does free text mention a keyword (any phrasing)? Used by the ATS check and UI. */
export function textMentions(text: string, term: string): boolean {
  const hay = normalizedHaystack(text);
  return variantsFor(term).some((v) => hay.includes(` ${v} `));
}
