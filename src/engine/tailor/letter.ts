// Cover letters in Kayzee's voice. Server-only.
//
// LLM path: facts (ids + text), matched keywords and forbidden gaps go to the model, with the JD
// wrapped in untrusted(). Post-processing: fixDashes → truth guard → slop lint → word count, with
// one regeneration listing the problems. No LLM (or a letter that still fails the truth guard):
// a deterministic template built only from fact-bank sentences.
//
// Also exports the shared writing helpers used by answers.ts and prep.ts (fact ranking,
// first-person conversion, guarded checks).

import { z } from 'zod';
import { loadFacts, loadProfile } from '@/lib/config';
import { addArtifact, getJob, listContacts, updateJob } from '@/lib/db';
import { llmJSON, untrusted } from '@/lib/llm';
import type { Artifact, Fact, FactBank, GuardResult, Job, KeywordCoverage, Profile } from '@/lib/types';
import { describeSlop, fixDashes, lintSlop, type SlopResult } from '../slop';
import { guardText, type GuardOptions } from '../truthguard';
import { renderLetterPdf } from './letterPdf';

export const LETTER_MAX_WORDS = 250;
const TEMPLATE_GREETING = 'Dear Hiring Team,';

// ───────────────────────────── Truth guard access ─────────────────────────────

/** Same shape as truthguard.guardText; injectable so tests can count or stub guard calls. */
export type GuardTextFn = (text: string, facts: FactBank, opts?: GuardOptions) => GuardResult;

export const defaultGuard: GuardTextFn = guardText;

export interface GuardContext {
  /** Strings that may appear although they are not facts: company, job title, contact name. */
  allowNames: string[];
  gaps?: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Variants of a job title worth masking: full title and the title without bracketed/dashed suffixes. */
function titleVariants(title: string): string[] {
  const base = title.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
  const head = base.split(/\s+[-–—|,]\s+/)[0]?.trim() ?? '';
  return [...new Set([title.trim(), base, head])].filter((t) => t.length >= 3);
}

export function guardContextFor(job: Pick<Job, 'company' | 'title' | 'keywords'>, extraNames: string[] = []): GuardContext {
  return {
    allowNames: [job.company, cleanCompany(job.company), cleanTitle(job.title), ...titleVariants(job.title), ...extraNames].filter((n) => n && n.trim().length >= 2),
    gaps: job.keywords?.gaps ?? [],
  };
}

/** Replaces allowed names with neutral lowercase stand-ins so the guard only judges the claims. */
export function maskAllowedNames(text: string, names: string[]): string {
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w])${escapeRegExp(name.trim())}(?![\\w])`, 'gi'), 'the organisation');
  }
  return out;
}

const CONTRACTIONS: Record<string, string> = { "i'm": 'I am', "i've": 'I have', "i'd": 'I would', "i'll": 'I will' };
/** Pronouns/determiners that open sentences but are never names; lowercased so the guard's name check skips them. */
const NEVER_NAMES = /(^|[.!?]\s+|\n\s*)(Your|You're|You've|You'd|It's|That's|There's|There|Thanks|Thank|Please|Happy|Glad|Looking)\b/g;

/**
 * Expands "I'm/I've/I'd/I'll" and lowercases sentence-opening pronouns. These carry no claims, but
 * the guard's capitalised-name check would otherwise read them as unverified names.
 */
export function neutraliseFunctionWords(text: string): string {
  return text
    .replace(/\bI['’](m|ve|d|ll)\b/g, (m) => CONTRACTIONS[m.toLowerCase().replace('’', "'")] ?? m)
    .replace(NEVER_NAMES, (_m, pre: string, word: string) => pre + word.toLowerCase());
}

/** Runs the guard with names masked and allowed; a throwing guard fails closed. */
export function runGuard(guard: GuardTextFn, text: string, facts: FactBank, ctx: GuardContext): GuardResult {
  try {
    const prepared = neutraliseFunctionWords(maskAllowedNames(text, ctx.allowNames));
    return guard(prepared, facts, { gaps: ctx.gaps ?? [], allowTerms: ctx.allowNames });
  } catch (err) {
    return { ok: false, problems: [`Truth guard error: ${(err as Error).message}`] };
  }
}

// ───────────────────────────── Fact relevance ─────────────────────────────

const STOP_WORDS = new Set(
  'the and for with that this from your you our are will have has had was were been into onto over their they them its it\'s about across within such also more than then when where which while what who whom how all any can may must should would could each other per via work role team job using use based including include'.split(
    ' ',
  ),
);

export function contentTokens(text: string): Set<string> {
  const tokens = String(text ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
  return new Set(tokens);
}

/** Tag → phrases that signal it in a JD. Tags not listed match on their own words. */
const TAG_SIGNALS: Record<string, string[]> = {
  pr: ['public relations', ' pr ', 'press', 'media relations'],
  comms: ['communication', 'comms'],
  'internal-comms': ['internal comm'],
  social: ['social media', 'instagram', 'tiktok', 'linkedin', 'social'],
  content: ['content'],
  video: ['video', 'reels', 'filming'],
  photography: ['photo'],
  seo: ['seo', 'search engine', 'organic search'],
  'local-seo': ['local seo', 'google business'],
  events: ['event'],
  analytics: ['analytic', 'reporting', 'data', 'insight', 'metrics', 'kpi'],
  'press-releases': ['press release'],
  copywriting: ['copywrit', 'copy', 'writing'],
  'student-engagement': ['student'],
  stakeholder: ['stakeholder'],
  influencer: ['influencer', 'creator'],
  partnerships: ['partnership'],
  research: ['research', 'insight'],
  presentation: ['present'],
  'public-speaking': ['presentation', 'public speaking'],
  'digital-marketing': ['digital marketing'],
  campaign: ['campaign'],
  brand: ['brand'],
  community: ['community'],
  marketing: ['marketing'],
  'lead-generation': ['lead gen'],
  automation: ['automat'],
  leadership: ['leadership', 'lead a team', 'manage a team'],
  advocacy: ['advocacy', 'advocate'],
  outreach: ['outreach'],
  design: ['design', 'graphic'],
  drone: ['drone', 'aerial'],
};

function tagSignals(tag: string): string[] {
  return TAG_SIGNALS[tag] ?? [tag.replace(/-/g, ' ')];
}

export interface RankedFact { fact: Fact; score: number }

const NARRATIVE_KINDS = new Set<Fact['kind']>(['achievement', 'project', 'role']);

/**
 * Scores fact-bank entries for a job: keyword coverage citations, tag signals present in the JD,
 * and content-word overlap. Only narrative facts (achievement/project/role) are ranked.
 */
export function rankFactsForJob(job: Pick<Job, 'title' | 'description' | 'keywords'>, facts: FactBank, kw?: KeywordCoverage): RankedFact[] {
  const coverage = kw ?? job.keywords;
  const jdLower = ` ${`${job.title}\n${job.description}`.toLowerCase().replace(/\s+/g, ' ')} `;
  const jdTokens = contentTokens(jdLower);
  const titleTokens = contentTokens(job.title);
  const citations = new Map<string, number>();
  for (const m of coverage?.matched ?? []) {
    const weight = coverage?.keywords.find((k) => k.term === m.term)?.weight ?? 1;
    for (const id of m.factIds) citations.set(id, (citations.get(id) ?? 0) + weight);
  }

  return facts.facts
    .filter((f) => NARRATIVE_KINDS.has(f.kind))
    .map((fact) => {
      let score = (citations.get(fact.id) ?? 0) * 3;
      for (const tag of fact.tags) {
        if (tagSignals(tag).some((s) => jdLower.includes(s))) score += 2;
        if (titleTokens.has(tag)) score += 1.5;
      }
      let overlap = 0;
      for (const t of contentTokens(fact.text)) if (jdTokens.has(t)) overlap += 1;
      score += Math.min(overlap, 6) * 0.5;
      if (fact.kind === 'achievement') score += 1;
      if (fact.kind === 'project') score += 0.5;
      return { fact, score };
    })
    .sort((a, b) => b.score - a.score || facts.facts.indexOf(a.fact) - facts.facts.indexOf(b.fact));
}

/** Top N facts that can be written as first-person sentences, at most one per organisation. */
export function pickStoryFacts(ranked: RankedFact[], n: number): Fact[] {
  const picked: Fact[] = [];
  const orgs = new Set<string>();
  for (const { fact } of ranked) {
    if (picked.length >= n) break;
    if (!toFirstPerson(fact)) continue;
    const org = (fact.org ?? fact.id).toLowerCase();
    if (orgs.has(org)) continue;
    orgs.add(org);
    picked.push(fact);
  }
  return picked;
}

/** Skills/tools from the fact bank that the JD mentions: honest "matched" terms without keywords.ts. */
export function matchedTerms(job: Pick<Job, 'title' | 'description' | 'keywords'>, facts: FactBank, kw?: KeywordCoverage): string[] {
  const coverage = kw ?? job.keywords;
  if (coverage?.matched.length) {
    const weights = new Map(coverage.keywords.map((k) => [k.term, k.weight]));
    return [...coverage.matched].sort((a, b) => (weights.get(b.term) ?? 1) - (weights.get(a.term) ?? 1)).map((m) => m.term);
  }
  const jd = ` ${`${job.title}\n${job.description}`.toLowerCase().replace(/\s+/g, ' ')} `;
  return [...facts.skills, ...facts.tools].filter((term) => {
    const t = term.toLowerCase();
    return t.length >= 3 && new RegExp(`(?<![a-z0-9])${escapeRegExp(t)}(?![a-z0-9])`).test(jd);
  });
}

// ───────────────────────────── First-person sentences ─────────────────────────────

const IRREGULAR_PAST = new Set(['shot', 'wrote', 'ran', 'led', 'built', 'grew', 'made', 'won', 'took', 'began', 'set', 'held', 'gave', 'drove', 'taught', 'brought', 'sold', 'met', 'spoke', 'found', 'chose']);
const PARTICIPLE: Record<string, string> = { wrote: 'written', ran: 'run', grew: 'grown', took: 'taken', began: 'begun', gave: 'given', drove: 'driven', spoke: 'spoken', chose: 'chosen' };

function isPastVerb(word: string): boolean {
  const w = word.toLowerCase();
  return IRREGULAR_PAST.has(w) || (w.length > 4 && w.endsWith('ed'));
}

function lowerFirst(s: string): string {
  return s.length > 1 && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * Rewrites a fact-bank achievement ("Wrote press releases for X.", "At X, organised Y.") as a
 * first-person sentence without changing any claim. Returns null for facts that aren't verb-led.
 */
export function toFirstPerson(fact: Fact): string | null {
  const text = fact.text.trim().replace(/\s+/g, ' ');
  const lead = /^((?:At|For|As (?:a|an|the)?\s?)[^,]{2,80}),\s+([A-Za-z]+)(.*)$/.exec(text);
  if (lead && isPastVerb(lead[2])) return `${lead[1]}, I ${lowerFirst(lead[2])}${lead[3]}`;
  const first = text.split(' ')[0] ?? '';
  if (!isPastVerb(first)) return null;
  const rest = text.slice(first.length);
  // "Produced ... since Sep 2025." reads naturally as present perfect.
  if (/\bsince\b/i.test(rest)) {
    const participle = PARTICIPLE[first.toLowerCase()] ?? first.toLowerCase();
    return `I've ${participle}${rest.replace(/,\s+since\b/i, ' since')}`;
  }
  return `I ${first.toLowerCase()}${rest}`;
}

// ───────────────────────────── Letter assembly ─────────────────────────────

export function wordCount(text: string): number {
  return String(text ?? '').split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
}

export function signature(profile: Profile): string {
  const signOff = (profile.coverLetter.signOff || 'Kind Regards,').trim();
  const full = profile.name.full.trim();
  return signOff.toLowerCase().includes(full.toLowerCase()) ? signOff : `${signOff}\n${full}`;
}

export function greetingFor(contactName?: string): string {
  const name = contactName?.trim();
  return name && /^[\p{L}][\p{L}' .-]{1,60}$/u.test(name) ? `Dear ${name},` : TEMPLATE_GREETING;
}

export function assembleLetter(greeting: string, body: string, profile: Profile): string {
  return `${greeting}\n\n${body.trim()}\n\n${signature(profile)}`;
}

function currentRole(facts: FactBank): Fact | undefined {
  return facts.facts
    .filter((f) => f.kind === 'role' && f.end === null && f.title && f.org && !/freelance/i.test(f.title))
    .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))[0];
}

function degree(facts: FactBank): Fact | undefined {
  return facts.facts.find((f) => f.kind === 'education' && f.title && /\b(BA|BSc|MA|MSc|Bachelor|Master|Degree)\b/i.test(f.title));
}

function shortOrg(org: string): string {
  return /\(([^)]+)\)\s*$/.exec(org)?.[1] ?? org;
}

function joinTerms(terms: string[]): string {
  if (terms.length <= 1) return terms[0] ?? '';
  return `${terms.slice(0, -1).join(', ')} and ${terms[terms.length - 1]}`;
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Deterministic letter body from fact-bank sentences only: opener (role + company), current role and
 * degree, two or three relevant achievements, and a short close. Trimmed to stay under the word cap.
 */
export function buildTemplateBody(job: Job, facts: FactBank, kw?: KeywordCoverage): { body: string; factIds: string[] } {
  const ranked = rankFactsForJob(job, facts, kw);
  const stories = pickStoryFacts(ranked, 3);
  const role = currentRole(facts);
  const edu = degree(facts);
  const terms = matchedTerms(job, facts, kw).slice(0, 2);

  const build = (storyCount: number): { body: string; factIds: string[] } => {
    const used: string[] = [];
    const opener: string[] = [`I'm applying for the ${cleanTitle(job.title)} role at ${cleanCompany(job.company)}.`];
    if (role?.title && role.org) {
      opener.push(`I'm currently ${role.title} of ${role.org}.`);
      used.push(role.id);
    }
    if (edu?.title && edu.org) {
      opener.push(`I studied for a ${edu.title} at ${shortOrg(edu.org)}.`);
      used.push(edu.id);
    }

    const chosen = stories.slice(0, storyCount);
    const middle: string[] = [];
    if (terms.length) middle.push(`Your posting asks for ${joinTerms(terms)}, and that's work I've done.`);
    for (const f of chosen) {
      middle.push(sentence(toFirstPerson(f) ?? f.text));
      used.push(f.id);
    }

    const close = `I'd like to bring that experience to ${cleanCompany(job.company)}, and I'd be glad to talk it through in more detail. Thanks for taking the time to read my application.`;
    const paragraphs = [opener.join(' ')];
    // Two short story paragraphs read better than one long one.
    if (middle.length > 3) paragraphs.push(middle.slice(0, 2).join(' '), middle.slice(2).join(' '));
    else if (middle.length) paragraphs.push(middle.join(' '));
    paragraphs.push(close);
    return { body: fixDashes(paragraphs.join('\n\n')), factIds: used };
  };

  for (let n = Math.min(3, stories.length); n >= 1; n--) {
    const draft = build(n);
    if (wordCount(draft.body) + 12 <= LETTER_MAX_WORDS) return draft;
  }
  return build(Math.min(1, stories.length));
}

// ───────────────────────────── LLM letter ─────────────────────────────

const LetterSchema = z.object({
  paragraphs: z.array(z.string().min(1)).min(2).max(6),
  factIds: z.array(z.string()).default([]),
});

const BANNED_FOR_PROMPT = [
  'passionate', 'thrilled', 'excited to apply', 'I am writing to express', 'leverage', 'dynamic', 'synergy', 'spearhead',
  'fast-paced', 'results-driven', 'proven track record', 'hit the ground running', 'wear many hats', 'go-getter',
  'think outside the box', 'great fit', 'utilize', 'facilitate', 'foster', 'pivotal', 'realm', 'landscape', 'embark',
  'journey', 'unwavering', 'meticulous', 'robust', 'seamless', 'elevate', 'delve', 'tapestry', 'testament',
  'furthermore', 'moreover', 'sentences starting with Additionally', 'not only... but also', "it's not just X, it's Y",
  'em dashes or en dashes', 'exclamation marks', 'rhetorical questions', 'lists of three',
];

function factLines(facts: FactBank, ranked: RankedFact[]): string {
  const order = ranked.map((r) => r.fact);
  const others = facts.facts.filter((f) => !order.includes(f) && f.kind === 'education');
  return [...order, ...others].map((f) => `- [${f.id}] ${f.text}`).join('\n');
}

function letterSystemPrompt(profile: Profile): string {
  return [
    `You write cover letters for ${profile.name.full} (goes by ${profile.name.preferred}).`,
    'Voice rules:',
    ...profile.coverLetter.voiceNotes.map((n) => `- ${n}`),
    'Hard rules:',
    '- Every claim must come from the FACTS list. Cite the fact ids you used in factIds.',
    '- Never claim anything listed under GAPS, never invent numbers, employers, tools, titles or results.',
    '- Never mention visa, sponsorship, work permits or referees.',
    `- The body (no greeting, no sign-off) must be under ${LETTER_MAX_WORDS - 30} words in 3 or 4 short paragraphs.`,
    '- Do not include a greeting line or a sign-off: they are added for you.',
    '- No markdown, no bold, no headings, no bullet points.',
    `- Never use: ${BANNED_FOR_PROMPT.join('; ')}.`,
    'Output JSON: {"paragraphs": string[], "factIds": string[]}.',
  ].join('\n');
}

function letterUserPrompt(job: Job, facts: FactBank, ranked: RankedFact[], terms: string[], gaps: string[]): string {
  const top = ranked.slice(0, 6).map((r) => r.fact.id);
  return [
    `ROLE: ${cleanTitle(job.title)}`,
    `COMPANY: ${cleanCompany(job.company)} (name it at least once, naturally)`,
    job.location ? `LOCATION: ${job.location}` : '',
    `MATCHED KEYWORDS (backed by facts, use one or two naturally): ${terms.slice(0, 8).join(', ') || 'none'}`,
    `GAPS (in the posting but NOT backed by facts; never claim these): ${gaps.join(', ') || 'none'}`,
    `MOST RELEVANT FACT IDS: ${top.join(', ')}`,
    'FACTS:',
    factLines(facts, ranked),
    'JOB DESCRIPTION:',
    untrusted('job-description', job.description, 8000),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Strips anything the model added that the letter format forbids. */
export function sanitizeLetterBody(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+)/, '').trimEnd());
  let body = lines.join('\n').trim();
  body = body.replace(/^(?:dear [^\n]{1,60},|hi [^\n]{1,40},|hello[^\n]{0,40},)\s*/i, '');
  body = body.replace(/\n\s*(?:kind regards|best regards|regards|best wishes|sincerely|yours sincerely|yours faithfully|thanks|many thanks),?[\s\S]*$/i, '');
  return body.replace(/\n{3,}/g, '\n\n').trim();
}


// ───────────────────────────── Names ─────────────────────────────

const LOCATION_WORDS = /^(?:remote|hybrid|on-?site|dublin(?: \d+)?|cork|galway|limerick|belfast|ireland|uk|emea|europe|naas|dundalk|swords|county \w+|co\.? \w+)$/i;

/** "Product Marketing Ops Manager | Ireland | Remote" → "Product Marketing Ops Manager"; drops (contract notes), location suffixes and repeated department tails. */
export function cleanTitle(title: string): string {
  let t = String(title ?? '').split('|')[0];
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, ' ');
  t = t.split(/\s+[-–—]\s+/).filter((part, i) => i === 0 || !LOCATION_WORDS.test(part.trim())).join(' - ');
  const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].split(/\s+/).length >= 2) t = parts[0];
  return t.replace(/\s+/g, ' ').trim() || String(title ?? '').trim();
}

/** "Ryanair - Europe's Favourite Airline" → "Ryanair"; "LUCEY GROUP LIMITED" → "Lucey Group". */
export function cleanCompany(company: string): string {
  let c = String(company ?? '').split(/\s+[-–—|]\s+/)[0];
  c = c.replace(/[,]?\s+(?:limited|ltd\.?|dac|plc|inc\.?|llc|gmbh|uc|clg)$/i, '').trim();
  if (c.length > 3 && c === c.toUpperCase()) c = c.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
  return c || String(company ?? '').trim();
}

/** True when the letter names the employer (full cleaned name, or its distinctive first word). */
export function namesCompany(text: string, company: string): boolean {
  const name = cleanCompany(company).toLowerCase();
  const lower = text.toLowerCase();
  if (lower.includes(name)) return true;
  const first = name.split(/\s+/)[0];
  return first.length >= 4 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower);
}

// ───────────────────────────── Checks ─────────────────────────────

export interface LetterCheck { guard: GuardResult; slop: SlopResult; words: number; problems: string[] }

export function checkLetter(fullText: string, body: string, facts: FactBank, ctx: GuardContext, guard: GuardTextFn, company?: string): LetterCheck {
  const guardResult = runGuard(guard, body, facts, ctx);
  const slop = lintSlop(body, { facts, allow: ctx.allowNames });
  const words = wordCount(fullText);
  const problems = [
    ...guardResult.problems.map((p) => `Truth: ${p}`),
    ...describeSlop(slop.hits).map((p) => `Style: ${p}`),
    ...(words > LETTER_MAX_WORDS ? [`Length: ${words} words; the whole letter must be ${LETTER_MAX_WORDS} or fewer.`] : []),
    ...(company && !namesCompany(body, company) ? [`Specific: the letter never names ${cleanCompany(company)}; mention the company by name.`] : []),
  ];
  return { guard: guardResult, slop, words, problems };
}

// ───────────────────────────── Public API ─────────────────────────────

export interface CoverLetterOptions {
  coverage?: KeywordCoverage;
  contactName?: string;
  /** Store a 'cover_letter' artifact (default true). */
  save?: boolean;
  /** Render a PDF next to the CV (default true; skipped when save is false). */
  pdf?: boolean;
  /** Test seam: a guard to use instead of ../truthguard. */
  guard?: GuardTextFn;
}

export interface CoverLetterResult {
  text: string;
  guard: GuardResult;
  slop: SlopResult;
  llmUsed: boolean;
  factIds: string[];
  wordCount: number;
  /** Non-empty when the letter still has problems Kayzee should look at. */
  flags: string[];
  artifactId?: number;
  pdfPath?: string | null;
}

function contactNameFor(job: Job, explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  try {
    return listContacts({ jobId: job.id }).find((c) => c.name?.trim() && c.confidence >= 0.6)?.name?.trim();
  } catch {
    return undefined;
  }
}

async function llmBody(
  job: Job,
  facts: FactBank,
  profile: Profile,
  ranked: RankedFact[],
  terms: string[],
  gaps: string[],
  fixList?: { previous: string; problems: string[] },
): Promise<{ body: string; factIds: string[] } | null> {
  let user = letterUserPrompt(job, facts, ranked, terms, gaps);
  if (fixList) {
    user += `\n\nYOUR PREVIOUS DRAFT:\n${fixList.previous}\n\nIt had these problems. Rewrite the whole body and fix every one:\n${fixList.problems
      .map((p) => `- ${p}`)
      .join('\n')}`;
  }
  const out = await llmJSON({
    purpose: fixList ? 'letter.regenerate' : 'letter.write',
    system: letterSystemPrompt(profile),
    user,
    schema: LetterSchema,
    maxTokens: 900,
    temperature: fixList ? 0.3 : 0.5,
  });
  if (!out) return null;
  const known = new Set(facts.facts.map((f) => f.id));
  const body = fixDashes(sanitizeLetterBody(out.paragraphs.join('\n\n')));
  return body ? { body, factIds: out.factIds.filter((id) => known.has(id)) } : null;
}

/**
 * Writes, checks and (by default) stores a cover letter for a job. Never throws for LLM problems:
 * falls back to the template letter.
 */
export async function writeCoverLetter(job: Job, facts: FactBank, profile: Profile, opts: CoverLetterOptions = {}): Promise<CoverLetterResult> {
  const guard = opts.guard ?? defaultGuard;
  const contact = contactNameFor(job, opts.contactName);
  const greeting = greetingFor(contact);
  const ctx = guardContextFor(job, contact ? [contact] : []);
  const ranked = rankFactsForJob(job, facts, opts.coverage);
  const terms = matchedTerms(job, facts, opts.coverage);
  const gaps = ctx.gaps ?? [];

  const evaluate = (draft: { body: string; factIds: string[] }) => {
    const text = assembleLetter(greeting, draft.body, profile);
    return { ...draft, text, check: checkLetter(text, draft.body, facts, ctx, guard, job.company) };
  };

  const template = evaluate(buildTemplateBody(job, facts, opts.coverage));
  let chosen = template;
  let llmUsed = false;
  const flags: string[] = [];

  const first = await llmBody(job, facts, profile, ranked, terms, gaps);
  if (first) {
    let best = evaluate(first);
    if (best.check.problems.length) {
      const retry = await llmBody(job, facts, profile, ranked, terms, gaps, { previous: first.body, problems: best.check.problems });
      if (retry) {
        const second = evaluate(retry);
        if (second.check.problems.length <= best.check.problems.length) best = second;
      }
    }
    if (best.check.guard.ok || !template.check.guard.ok) {
      chosen = best;
      llmUsed = true;
    } else {
      flags.push('The written letter failed the truth guard twice, so the plain template letter was used instead.');
    }
  }

  flags.push(...chosen.check.problems);
  const result: CoverLetterResult = {
    text: chosen.text,
    guard: chosen.check.guard,
    slop: chosen.check.slop,
    llmUsed,
    factIds: [...new Set(chosen.factIds)],
    wordCount: chosen.check.words,
    flags,
  };

  if (opts.save !== false) {
    result.pdfPath = opts.pdf === false ? null : await renderLetterPdf(result.text, job.id, profile);
    const artifact = storeLetter(job.id, result.text, {
      llmUsed,
      factIds: result.factIds,
      guard: result.guard,
      slopHits: describeSlop(result.slop.hits),
      wordCount: result.wordCount,
      flags,
      pdfPath: result.pdfPath ?? null,
    }, result.pdfPath ?? undefined);
    result.artifactId = artifact.id;
  }
  return result;
}

function storeLetter(jobId: string, text: string, meta: Record<string, unknown>, pdfPath?: string): Artifact {
  return addArtifact({ jobId, kind: 'cover_letter', content: text, ...(pdfPath ? { path: pdfPath } : {}), meta });
}

export interface SavedLetter { artifact: Artifact; guard: GuardResult; slop: SlopResult; wordCount: number; flags: string[]; pdfPath: string | null }

/**
 * Dashboard edit flow: stores Kayzee's edited letter as a new version after re-running the truth
 * guard and slop lint. His wording is kept as typed (only trimmed); problems come back as flags.
 */
export async function saveCoverLetter(jobId: string, text: string, opts: { guard?: GuardTextFn; pdf?: boolean } = {}): Promise<SavedLetter> {
  const job = getJob(jobId);
  if (!job) throw new Error(`saveCoverLetter: job not found: ${jobId}`);
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!clean) throw new Error('saveCoverLetter: the letter is empty');

  const facts = loadFacts();
  const profile = loadProfile();
  const guard = opts.guard ?? defaultGuard;
  const contact = contactNameFor(job);
  const ctx = guardContextFor(job, [...(contact ? [contact] : []), profile.name.full, profile.name.preferred, profile.name.first, profile.name.last]);
  const body = stripFrame(clean);
  const check = checkLetter(clean, body, facts, ctx, guard, job.company);
  const pdfPath = opts.pdf === false ? null : await renderLetterPdf(clean, jobId, profile);
  const artifact = storeLetter(jobId, clean, {
    edited: true,
    llmUsed: false,
    guard: check.guard,
    slopHits: describeSlop(check.slop.hits),
    wordCount: check.words,
    flags: check.problems,
    pdfPath,
  }, pdfPath ?? undefined);
  updateJob(jobId, {}); // bumps updatedAt so the queue shows the edit
  return { artifact, guard: check.guard, slop: check.slop, wordCount: check.words, flags: check.problems, pdfPath };
}

/** Removes the greeting line and the sign-off block from a full letter, leaving the body. */
export function stripFrame(letter: string): string {
  const lines = letter.trim().split('\n');
  if (lines.length && /^(dear|hi|hello)\b/i.test(lines[0].trim())) lines.shift();
  const text = lines.join('\n');
  return text.replace(/\n\s*(?:kind regards|best regards|regards|best wishes|sincerely|yours sincerely|yours faithfully|many thanks|thanks),?\s*(?:\n[^\n]*){0,3}\s*$/i, '').trim();
}
