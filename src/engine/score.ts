// Hard filters + 0-100 job scoring (SPEC §5.3).
//
// hardFilters rejects jobs Kayzee can't or shouldn't apply to (blacklist, senior titles, clearly
// non-target role families, locations outside his areas, salary under his floor, mandatory years
// over his limit, languages he doesn't speak) and flags things he should know (UK right to work,
// sponsorship wording, Irish language, driving licence, unpaid roles).
// scoreJob is deterministic first; when an LLM key is configured it blends a 50/50 LLM judgement
// of role fit and seniority into the heuristic. The JD is always passed as untrusted data.

import { sponsorBonus as knownSponsorBonus, sponsorRecord } from '@/engine/sponsors';
import { z } from 'zod';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { daysBetween, nowIso } from '@/lib/time';
import type { FactBank, FilterResult, KeywordCoverage, NewJob, Profile, Salary, ScoreDetail } from '@/lib/types';
import { coverage as keywordCoverage, extractKeywords, isDoNotClaim, splitJdLines, splitSentences, type JdLine } from './keywords';
import { cleanText, normalizePhrase, tokenize } from './lexicon';

// ───────────────────────────── Types & constants ─────────────────────────────

/** The job fields scoring needs. `Job` and `NewJob` both satisfy it. */
export type ScorableJob = Pick<NewJob, 'title' | 'company' | 'location' | 'remote' | 'description'> &
  Partial<Pick<NewJob, 'country' | 'salary' | 'employmentType' | 'postedAt'>>;

export type ScoreComponents = ScoreDetail['components'];

export const SCORE_WEIGHTS: Readonly<Record<keyof ScoreComponents, number>> = {
  skills: 40,
  roleFit: 25,
  seniority: 15,
  location: 10,
  freshness: 5,
  salary: 5,
};

export const GBP_TO_EUR = 1.17;
/** Rough rate; USD salaries are rare for his searches and only gate the floor check. */
export const USD_TO_EUR = 0.92;
const HOURS_PER_YEAR = 1950; // 37.5h × 52
const WORKING_DAYS_PER_YEAR = 230;
const FRESHNESS_DAYS = 30;

export type LocationClass = 'primary' | 'remote' | 'secondary' | 'unknown' | 'outside';
export interface LocationInfo { cls: LocationClass; label: string; flags: string[] }

export interface YearsRequirement {
  /** Highest years figure that reads as mandatory, or null. */
  mandatory: number | null;
  /** Highest years figure that reads as desirable/alternative, or null. */
  optional: number | null;
}

export interface AnnualSalaryEur { min?: number; max?: number; source: 'job' | 'description' }

export interface LlmJudgement { roleFit: number; seniority: number; reasons: string[] }
export type LlmJudge = (input: { job: ScorableJob; profile: Profile; facts: FactBank }) => Promise<LlmJudgement | null>;

export interface ScoreOptions {
  /** Precomputed coverage (saves re-extracting keywords). */
  coverage?: KeywordCoverage;
  /** Custom judge (tests), or false to force the heuristic path. Default: OpenRouter when configured. */
  llm?: LlmJudge | false;
  now?: Date;
}

// ───────────────────────────── Small helpers ─────────────────────────────

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word (or whole-phrase) test on lowercased text; works for terms ending in "." too. */
function hasTerm(text: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(t)}(?=$|[^a-z0-9])`, 'i').test(text);
}

function lowerTitle(title: string): string {
  return ` ${String(title ?? '').toLowerCase().replace(/&/g, ' and ')} `;
}

function formatEur(n: number): string {
  return `€${Math.round(n).toLocaleString('en-IE')}`;
}

function snippet(text: string, max = 140): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function jobSentences(description: string): JdLine[] {
  return splitJdLines(description).flatMap(splitSentences);
}

const OPTIONAL_CUE = /\b(desirable|ideally|preferabl[ey]|preferred|advantage|advantageous|bonus|nice to have|a plus|beneficial|not essential|would be (great|good|helpful|beneficial|useful)|is helpful|an asset)\b/i;

function readsOptional(s: JdLine): boolean {
  return s.optional || OPTIONAL_CUE.test(s.text);
}

// ───────────────────────────── Role families ─────────────────────────────

const NON_TARGET_FAMILIES: { label: string; re: RegExp }[] = [
  { label: 'software/engineering', re: /\b(software|developer|engineer|engineering|devops|programmer|full[- ]?stack|back[- ]?end|front[- ]?end|data scientist|data engineer|sre|qa|tester|it support|sysadmin|solutions architect)\b/ },
  { label: 'finance/accounting', re: /\b(accountant|accounting|accounts (payable|receivable|assistant)|bookkeeper|auditor|audit|payroll|tax|financial analyst|finance (manager|assistant|officer|executive)|actuary|actuarial|credit controller)\b/ },
  { label: 'healthcare', re: /\b(nurse|nursing|doctor|physician|pharmacist|healthcare assistant|care assistant|care worker|carer|social care|social worker|therapist|physiotherapist|dentist|dental|radiographer|midwife)\b/ },
  { label: 'sales', re: /\b(sales|account executive|account manager|business development|bdr|sdr|telesales)\b/ },
  { label: 'legal', re: /\b(solicitor|paralegal|lawyer|legal counsel|barrister|conveyancing)\b/ },
  { label: 'trades/operations', re: /\b(electrician|plumber|mechanic|technician|driver|warehouse|forklift|operative|labourer|chef|cook|kitchen porter|cleaner|security officer|retail assistant|store manager|barista)\b/ },
  { label: 'teaching', re: /\b(teacher|lecturer|tutor|teaching assistant)\b/ },
  { label: 'HR/recruitment', re: /\b(recruiter|recruitment consultant|talent acquisition|hr (generalist|advisor|assistant|manager|executive)|human resources)\b/ },
  { label: 'customer service', re: /\b(customer service|customer support|call centre|contact centre|receptionist)\b/ },
];

/** "Social" that isn't social media. Removed before family matching. */
const NON_MARKETING_SOCIAL = /\bsocial (care|work|worker|workers|services|housing|inclusion|justice|value|scientist|research|prescribing|prescriber)\b/g;

const BASE_TARGET_WORDS = [
  'pr', 'public relations', 'communications', 'communication', 'comms', 'content', 'social media', 'social',
  'marketing', 'digital', 'brand', 'branding', 'media', 'events', 'event', 'engagement', 'campaign', 'campaigns',
  'copywriter', 'copywriting', 'seo', 'press', 'creative', 'community', 'influencer', 'editorial', 'publicity',
  'outreach', 'partnerships', 'sponsorship', 'advocacy', 'video', 'videographer', 'storyteller', 'crm', 'ppc',
];

const GENERIC_ROLE_WORDS = new Set([
  'and', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'with', 'executive', 'assistant', 'officer', 'coordinator',
  'graduate', 'junior', 'trainee', 'intern', 'programme', 'program', 'senior', 'manager', 'specialist', 'associate',
]);

const PR_CONTEXT = /\b(public relations|pr agency|pr consultancy|media relations|press releases?|communications agency|journalists?)\b|\bpr\b/i;

function targetWords(profile: Profile): string[] {
  const fromProfile = [...profile.targets.roles, ...profile.targets.keywords]
    .flatMap((r) => r.toLowerCase().replace(/&/g, ' ').split(/[^a-z]+/))
    .filter((w) => w.length > 1 && !GENERIC_ROLE_WORDS.has(w));
  return [...new Set([...BASE_TARGET_WORDS, ...fromProfile])];
}

function marketingTitle(title: string): string {
  return lowerTitle(title).replace(NON_MARKETING_SOCIAL, ' ');
}

export function titleHasTargetWord(title: string, profile: Profile): boolean {
  const t = marketingTitle(title);
  return targetWords(profile).some((w) => hasTerm(t, w));
}

/** Label of the non-target family a title belongs to, or null. */
export function nonTargetFamily(title: string): string | null {
  const t = lowerTitle(title);
  return NON_TARGET_FAMILIES.find((f) => f.re.test(t))?.label ?? null;
}

/** Non-target title with no target word → reject. PR-agency "Account Executive" roles survive. */
function nonTargetRejection(job: ScorableJob, profile: Profile): string | null {
  const family = nonTargetFamily(job.title);
  if (!family || titleHasTargetWord(job.title, profile)) return null;
  const t = lowerTitle(job.title);
  const accountRoleOnly = /\baccount (executive|manager)\b/.test(t) && !/\b(sales|telesales|business development|bdr|sdr)\b/.test(t);
  if (family === 'sales' && accountRoleOnly && PR_CONTEXT.test(job.description)) return null;
  return `Not a target role (${family}): "${job.title}"`;
}

// ───────────────────────────── Title words / seniority ─────────────────────────────

/** Title-word exceptions: "lead" in "Lead Generation Executive" isn't a seniority word. */
const EXCLUDE_EXCEPTIONS: Record<string, RegExp> = {
  lead: /\blead[- ]?(generation|gen)\b/,
  // Entry-level "manager" titles stay in; every other manager title is too senior.
  manager: /\b(?:assistant|social media|community|account|content|office) manager\b/,
};

function excludedTitleWord(title: string, words: string[]): string | null {
  const t = lowerTitle(title);
  for (const word of words) {
    if (!hasTerm(t, word)) continue;
    const exception = EXCLUDE_EXCEPTIONS[word.trim().toLowerCase()];
    if (exception && !hasTerm(t.replace(new RegExp(exception.source, 'g'), ' '), word)) continue;
    return word;
  }
  return null;
}

interface TitleLevel { score: number; label: string }

export function titleSeniority(title: string): TitleLevel {
  const t = lowerTitle(title).replace(/\blead[- ]?(generation|gen)\b/g, ' ');
  if (/\b(director|head of|vice president|vp|chief|cmo|cco|partner)\b/.test(t)) return { score: 0, label: 'Director-level title' };
  if (/\bassistant manager\b/.test(t)) return { score: 0.5, label: 'Assistant manager title' };
  if (/\b(senior|sr\.?|principal|lead)\b/.test(t)) return { score: 0.15, label: 'Senior title' };
  if (/\bmanager\b/.test(t)) return { score: 0.3, label: 'Manager-level title: likely too senior' };
  if (/\b(graduate|grad|junior|jr\.?|trainee|entry[- ]level|apprentice|apprenticeship)\b/.test(t)) return { score: 1, label: 'Graduate/junior role' };
  if (/\b(intern|internship|placement)\b/.test(t)) return { score: 0.85, label: 'Internship' };
  if (/\b(assistant|coordinator|co-ordinator|executive|administrator)\b/.test(t)) return { score: 0.95, label: 'Executive/assistant-level role' };
  if (/\b(officer|specialist|associate|advisor|adviser)\b/.test(t)) return { score: 0.7, label: 'Officer/specialist level' };
  return { score: 0.6, label: 'Level not clear from title' };
}

const GRADUATE_CUE = /\b(graduate|recent graduates?|entry[- ]level|no (previous )?experience (is )?(necessary|required|needed)|early[- ]career|first role|graduate programme)\b/i;

function yearsScore(years: number): number {
  if (years <= 1) return 1;
  if (years === 2) return 0.85;
  if (years === 3) return 0.55;
  if (years === 4) return 0.35;
  return 0.15;
}

function seniorityComponent(job: ScorableJob, years: YearsRequirement): { score: number; label: string } {
  const level = titleSeniority(job.title);
  let score = level.score;
  let label = level.label;
  if (GRADUATE_CUE.test(job.description) && score >= 0.6) {
    score = Math.max(score, 0.95);
    if (level.score < 0.95) label = 'Posting welcomes graduates';
  }
  if (years.mandatory !== null && years.mandatory > 0) {
    const ys = yearsScore(years.mandatory);
    if (ys < score) {
      score = ys;
      label = `Asks for ${years.mandatory}+ years' experience`;
    }
  }
  return { score: clamp01(score), label };
}

// ───────────────────────────── Role fit ─────────────────────────────

const FUNCTION_STOP = new Set(
  [
    'and', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'with', 'executive', 'assistant', 'officer', 'coordinator',
    'graduate', 'grad', 'junior', 'trainee', 'intern', 'internship', 'entry', 'level', 'programme', 'senior', 'manager',
    'lead', 'head', 'specialist', 'associate', 'administrator', 'team', 'member', 'full', 'time', 'part', 'contract',
    'temporary', 'permanent', 'remote', 'hybrid', 'role', 'job', 'position', 'maternity', 'cover', 'month', 'months',
    'fixed', 'term', 'ii', 'iii', 'sr', 'jr', 'ft', 'pt', 'placement',
  ].map((w) => tokenize(w)[0]),
);

function functionTokens(title: string): string[] {
  const prepared = String(title ?? '')
    .toLowerCase()
    .replace(/\bpublic relations\b/g, ' pr ')
    .replace(/\bcomms\b/g, ' communications ')
    .replace(/\bco-ordinator\b/g, ' coordinator ');
  return [...new Set(tokenize(prepared).filter((t) => !FUNCTION_STOP.has(t)))];
}

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  return (2 * shared) / (a.length + b.length);
}

const ROLE_FAMILIES: { name: string; score: number; re: RegExp }[] = [
  { name: 'PR', score: 1, re: /\b(pr|public relations|press|media relations|publicity)\b/ },
  { name: 'communications', score: 1, re: /\b(communications?|comms|corporate affairs|public affairs)\b/ },
  { name: 'content', score: 0.95, re: /\b(content|copywriter|copywriting|editorial|storyteller|creator)\b/ },
  { name: 'social media', score: 0.95, re: /\b(social media|socials?|community manager|influencer)\b/ },
  { name: 'digital marketing', score: 0.9, re: /\b(digital marketing|marketing|seo|ppc|email marketing|growth marketing|e-?commerce|crm)\b/ },
  { name: 'events & engagement', score: 0.85, re: /\b(events?|engagement|community)\b/ },
  { name: 'adjacent', score: 0.55, re: /\b(brand|branding|creative|media|campaigns?|partnerships?|sponsorship|outreach|advocacy|fundraising|video|videographer|photographer|writer|editor|journalist|reporter|producer|digital)\b/ },
];

interface RoleFit { score: number; bestRole: string | null; family: string | null }

export function roleFitHeuristic(title: string, profile: Profile): RoleFit {
  const titleTokens = functionTokens(title);
  let best = 0;
  let bestRole: string | null = null;
  for (const role of profile.targets.roles) {
    const d = dice(titleTokens, functionTokens(role));
    if (d > best) {
      best = d;
      bestRole = role;
    }
  }
  const t = marketingTitle(title);
  const family = ROLE_FAMILIES.find((f) => f.re.test(t)) ?? null;
  const familyScore = family?.score ?? 0.1;
  let score = Math.max(best, familyScore * 0.9) + 0.1 * Math.min(best, familyScore);
  if (nonTargetFamily(title)) score *= 0.6;
  return { score: round2(clamp01(score)), bestRole: best >= 0.5 ? bestRole : null, family: family?.name ?? null };
}

// ───────────────────────────── Location ─────────────────────────────

const IE_PLACES = [
  'republic of ireland', 'roi', 'carlow', 'cavan', 'clare', 'cork', 'donegal', 'dublin', 'galway', 'kerry', 'kildare',
  'kilkenny', 'laois', 'leitrim', 'limerick', 'longford', 'louth', 'mayo', 'meath', 'monaghan', 'offaly', 'roscommon',
  'sligo', 'tipperary', 'waterford', 'westmeath', 'wexford', 'wicklow', 'dundalk', 'drogheda', 'swords', 'navan',
  'athlone', 'ennis', 'tralee', 'letterkenny', 'naas', 'newbridge', 'maynooth', 'bray', 'dun laoghaire', 'tallaght',
  'blanchardstown', 'sandyford', 'balbriggan', 'ashbourne', 'mullingar', 'portlaoise', 'castlebar', 'shannon',
];
const NI_PLACES = [
  'northern ireland', 'belfast', 'newry', 'armagh', 'derry', 'londonderry', 'lisburn', 'craigavon', 'portadown',
  'lurgan', 'banbridge', 'omagh', 'enniskillen', 'coleraine', 'ballymena', 'antrim', 'carrickfergus', 'newtownabbey',
  'co. down', 'county down', 'tyrone', 'fermanagh', 'dungannon', 'ni',
];
const COUNTRY_ONLY = new Set(['ireland', 'republic of ireland', 'roi']);
const PAN_REGION =/\b(europe|european|emea|eu|eea|worldwide|anywhere|global|international)\b/;
const REMOTE_WORDS = /\b(remote|hybrid|home|based|working|work|from|fully|wfh|in|or|and|first|flexible|office|on-site|onsite|location|locations|multiple|country|of)\b/g;

function locationText(job: ScorableJob): string {
  return ` ${cleanText(job.location ?? '').replace(/[^a-z0-9.]+/g, ' ').trim()} `;
}

function matchesAny(text: string, places: string[]): boolean {
  return places.some((p) => hasTerm(text, p));
}

function isRemoteJob(job: ScorableJob, loc: string): boolean {
  return Boolean(job.remote) || /\b(remote|work from home|wfh|fully remote)\b/.test(loc);
}

/** Where a job sits relative to Kayzee's areas. */
export function classifyLocation(job: ScorableJob, profile: Profile): LocationInfo {
  const loc = locationText(job);
  const label = (job.location ?? '').trim() || (job.remote ? 'Remote' : 'Location not stated');
  const primaryTerms = profile.targets.locations.map((l) => l.toLowerCase().trim()).filter((l) => l && l !== 'remote');
  const acceptsIreland = primaryTerms.includes('ireland');
  const withoutNI = loc.replace(/northern ireland/g, ' ');
  const secondary = matchesAny(loc, [...profile.targets.secondaryLocations.map((l) => l.toLowerCase()), ...NI_PLACES]) || job.country === 'GB-NIR';
  const primary =
    matchesAny(withoutNI, primaryTerms) ||
    (acceptsIreland && (matchesAny(withoutNI, IE_PLACES) || (job.country === 'IE' && !secondary)));
  const niFlag = 'Northern Ireland/UK role: check your UK right to work';
  // "Remote - Ireland" is a remote job, not a job in one of his places: only a named town/county
  // makes a remote posting primary.
  const namedPlace = matchesAny(withoutNI, [...primaryTerms, ...IE_PLACES].filter((p) => !COUNTRY_ONLY.has(p)));

  if (primary && isRemoteJob(job, loc) && !namedPlace && profile.targets.remoteOk) {
    return { cls: 'remote', label, flags: secondary ? [niFlag] : [] };
  }
  if (primary) return { cls: 'primary', label, flags: secondary ? [niFlag] : [] };
  if (secondary) return { cls: 'secondary', label, flags: [niFlag] };

  if (isRemoteJob(job, loc)) {
    if (!profile.targets.remoteOk) return { cls: 'outside', label, flags: [] };
    if (PAN_REGION.test(loc)) return { cls: 'remote', label, flags: ['Remote across Europe/EMEA: check they can employ you in Ireland'] };
    const leftover = loc.replace(REMOTE_WORDS, ' ').replace(/[^a-z]+/g, ' ').trim();
    if (leftover) return { cls: 'outside', label, flags: [] }; // e.g. "Remote - UK", "Remote, US"
    if (job.country === 'IE') return { cls: 'remote', label, flags: [] };
    if (job.country === 'GB' || job.country === 'OTHER') return { cls: 'outside', label, flags: [] };
    return { cls: 'remote', label, flags: ['Remote: country not stated, check they hire in Ireland'] };
  }

  if (!loc.trim()) {
    if (job.country === 'IE' && acceptsIreland) return { cls: 'primary', label, flags: [] };
    if (job.country === 'GB' || job.country === 'OTHER') return { cls: 'outside', label, flags: [] };
    return { cls: 'unknown', label, flags: ['Location not stated'] };
  }
  return { cls: 'outside', label, flags: [] };
}

const LOCATION_SCORE: Record<LocationClass, number> = { primary: 1, remote: 0.9, secondary: 0.6, unknown: 0.5, outside: 0 };

// ───────────────────────────── Salary ─────────────────────────────

const CURRENCY = String.raw`(€|£|\$|eur\s?|gbp\s?|usd\s?)`;
const AMOUNT = String.raw`(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k)?`;
const RANGE_RE = new RegExp(`${CURRENCY}\\s?${AMOUNT}\\s*(?:-|–|to)\\s*(?:${CURRENCY}\\s?)?${AMOUNT}([^.;\\n]{0,30})`, 'i');
const SINGLE_RE = new RegExp(`${CURRENCY}\\s?${AMOUNT}([^;\\n]{0,30})`, 'gi');
const SALARY_CONTEXT = /\b(salary|per annum|p\.?a\.?|package|compensation|pay|paid|rate)\b/i;

type Period = 'hour' | 'day' | 'month' | 'year';

function parseAmount(raw: string, k: string | undefined): number {
  const thousandsSep = /[,.]\d{3}(?!\d)/.test(raw) && !/\.\d{1,2}$/.test(raw);
  const n = Number(thousandsSep ? raw.replace(/[,.]/g, '') : raw.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

function periodOf(tail: string): Period | null {
  const t = tail.toLowerCase();
  if (/(per|an|a|\/)\s*(hour|hr)\b|hourly|p\/h\b|\bph\b/.test(t)) return 'hour';
  if (/(per|a|\/)\s*day\b|daily|day rate/.test(t)) return 'day';
  if (/(per|a|\/)\s*month\b|monthly|\bpcm\b/.test(t)) return 'month';
  if (/per annum|p\.?a\.?\b|(per|a|\/)\s*year|annual|\bpa\b/.test(t)) return 'year';
  return null;
}

function currencyOf(symbol: string): Salary['currency'] {
  const s = symbol.trim().toLowerCase();
  if (s === '£' || s === 'gbp') return 'GBP';
  if (s === '$' || s === 'usd') return 'USD';
  return 'EUR';
}

function annualizeByPeriod(n: number, period: Period): number {
  if (period === 'hour') return n * HOURS_PER_YEAR;
  if (period === 'day') return n * WORKING_DAYS_PER_YEAR;
  if (period === 'month') return n * 12;
  return n;
}

/** Best-effort salary from JD text, used only when the job has no parsed salary. */
export function parseSalaryFromText(text: string): Salary | undefined {
  const range = text.match(RANGE_RE);
  if (range) {
    const [raw, cur, a, ak, , b, bk, tail] = range;
    if (/^\s*(m|million|bn|billion)\b/i.test(tail)) return undefined;
    const lo = parseAmount(a, ak || bk);
    const hi = parseAmount(b, bk);
    const period = periodOf(tail) ?? (lo >= 10_000 && hi >= 10_000 ? 'year' : null);
    if (period && lo > 0 && hi >= lo) {
      return { min: annualizeByPeriod(lo, period), max: annualizeByPeriod(hi, period), currency: currencyOf(cur), period: 'year', raw: raw.trim() };
    }
  }
  for (const m of text.matchAll(SINGLE_RE)) {
    const [raw, cur, a, k, tail] = m;
    if (/^\s*(m|million|bn|billion)\b/i.test(tail)) continue;
    const n = parseAmount(a, k);
    const period = periodOf(tail) ?? (n >= 15_000 && SALARY_CONTEXT.test(text.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + raw.length + 30)) ? 'year' : null);
    if (period && n > 0) {
      const annual = annualizeByPeriod(n, period);
      return { min: annual, max: annual, currency: currencyOf(cur), period: 'year', raw: raw.trim() };
    }
  }
  return undefined;
}

/** Defensive: values that look hourly/daily/monthly are annualised. */
function annualizeMagnitude(n: number): number {
  if (n < 300) return n * HOURS_PER_YEAR;
  if (n < 1500) return n * WORKING_DAYS_PER_YEAR;
  if (n < 10_000) return n * 12;
  return n;
}

function toEur(n: number, currency: Salary['currency']): number {
  const c = String(currency ?? 'EUR').toUpperCase();
  if (c === 'GBP') return n * GBP_TO_EUR;
  if (c === 'USD') return n * USD_TO_EUR;
  return n;
}

/** Annual salary in EUR from the job's parsed salary, else from the JD text. Null if unknown. */
export function annualSalaryEur(job: ScorableJob): AnnualSalaryEur | null {
  const fromJob = job.salary && (job.salary.min || job.salary.max) ? job.salary : undefined;
  const salary = fromJob ?? parseSalaryFromText(job.description ?? '');
  if (!salary) return null;
  const conv = (n: number | undefined) => (n && n > 0 ? Math.round(toEur(annualizeMagnitude(n), salary.currency)) : undefined);
  const min = conv(salary.min);
  const max = conv(salary.max);
  if (min === undefined && max === undefined) return null;
  return { min, max, source: fromJob ? 'job' : 'description' };
}

// ───────────────────────────── Years of experience ─────────────────────────────

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15,
};
const NUM = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)`;
const YEARS_RE = new RegExp(
  String.raw`\b${NUM}\s*(?:\(\s*\d{1,2}\s*\)\s*)?(?:\+|plus)?\s*(?:(?:-|–|to|or)\s*${NUM}\s*(?:\(\s*\d{1,2}\s*\)\s*)?\+?\s*)?(?:years?|yrs?)['’]?(?=\W|$)([^.;\n]{0,90})`,
  'gi',
);
const EXPERIENCE_CONTEXT = /\b(experience|exp)\b|\bin (a |an |the )?(similar|related|relevant|comparable|pr|public relations|communications|comms|marketing|agency|content|social|digital|media|journalism|newsroom|role|position|industry|field|sector)\b|\bworking (in|as|with)\b|track record|background in|post[- ]qualification/i;
const COMPANY_HISTORY = /\b(established|founded|history|heritage|in business|trading for|celebrat\w*|anniversary)\b/i;
const CANDIDATE_CUE = /\b(you|your|candidate|applicant|ideal|require|required|requirement|essential|must|minimum|at least|should|need)\b/i;
const ALTERNATIVE_BEFORE = /\b(or|alternatively|otherwise)\s+(at least |a minimum of |minimum (of )?)?$/i;

function numberValue(token: string | undefined): number | null {
  if (!token) return null;
  const n = /^\d+$/.test(token) ? Number(token) : NUM_WORDS[token.toLowerCase()];
  return Number.isFinite(n) ? n : null;
}

/** Years-of-experience asks in a JD, split into mandatory vs desirable/alternative. */
export function yearsRequired(description: string): YearsRequirement {
  const result: YearsRequirement = { mandatory: null, optional: null };
  for (const sentence of jobSentences(description)) {
    const text = sentence.text;
    for (const m of text.matchAll(YEARS_RE)) {
      const lo = numberValue(m[1]);
      const tail = m[3] ?? '';
      if (lo === null || lo <= 0 || lo > 30) continue;
      if (/^\s*(old|of age|ago)\b/i.test(tail) || !EXPERIENCE_CONTEXT.test(tail)) continue;
      const startsWithHistory = /^\s*(with|for|over)\s+(over |more than |nearly |almost )?\d/i.test(text);
      if (COMPANY_HISTORY.test(text) || (startsWithHistory && !CANDIDATE_CUE.test(text.replace(/\bexperience\b/gi, '')))) continue;
      const before = text.slice(0, m.index ?? 0);
      const optional = readsOptional(sentence) || ALTERNATIVE_BEFORE.test(before) || /\bequivalent\b/i.test(tail);
      const key = optional ? 'optional' : 'mandatory';
      result[key] = Math.max(result[key] ?? 0, lo);
    }
  }
  return result;
}

// ───────────────────────────── Languages ─────────────────────────────

const LANGUAGES = [
  'german', 'french', 'spanish', 'italian', 'dutch', 'portuguese', 'polish', 'swedish', 'danish', 'norwegian', 'finnish',
  'russian', 'mandarin', 'cantonese', 'chinese', 'japanese', 'korean', 'arabic', 'turkish', 'czech', 'slovak',
  'hungarian', 'romanian', 'greek', 'hebrew', 'ukrainian', 'lithuanian', 'latvian', 'bulgarian', 'croatian', 'welsh',
  'flemish', 'hindi', 'urdu', 'punjabi', 'tamil', 'bengali', 'vietnamese', 'thai', 'indonesian', 'malay', 'english',
  // Language groups used in titles like "Nordic Speaker" / "Scandinavian-speaking".
  'nordic', 'scandinavian',
];
const PROFICIENCY_BEFORE = String.raw`(fluent|fluency|native|mother tongue|proficien\w*|business[- ]level|professional[- ]level|working knowledge|conversational|excellent|strong|written and (verbal|spoken)|spoken and written)\b[^.;\n]{0,40}`;
const PROFICIENCY_AFTER = String.raw`[^.;\n]{0,30}\b(speaker|speakers|speaking|language|fluency|fluent|native|level|skills|c1|c2|b2)\b`;
const NOT_LANGUAGE_AFTER = /^\s*(market|markets|customers|clients|brands?|company|office|team|region|government|cuisine|speaking market)\b/i;

function languageRegexes(lang: string): RegExp[] {
  if (lang === 'polish') {
    // "polish" is usually the verb: only adjacent proficiency phrasing counts.
    return [/\b(fluent|native)\s+(in\s+)?polish\b/i, /\bpolish[- ](speaker|speaking|language|native)\b/i];
  }
  return [
    new RegExp(`${PROFICIENCY_BEFORE}\\b${lang}\\b`, 'i'),
    new RegExp(`\\b${lang}\\b${PROFICIENCY_AFTER}`, 'i'),
    new RegExp(`\\b${lang}[- ]speak(ing|er)\\b`, 'i'),
  ];
}

function mentionsLanguage(text: string, lang: string): boolean {
  return languageRegexes(lang).some((re) => {
    const m = re.exec(text);
    if (!m) return false;
    const after = text.slice(text.toLowerCase().indexOf(lang, m.index) + lang.length);
    return !NOT_LANGUAGE_AFTER.test(after) || /speak/i.test(m[0]);
  });
}

interface LanguageCheck { rejected: string[]; flags: string[] }

function checkLanguages(job: ScorableJob, profile: Profile): LanguageCheck {
  const known = new Set(profile.targets.languages.map((l) => l.toLowerCase()));
  const unknown = LANGUAGES.filter((l) => !known.has(l));
  const out: LanguageCheck = { rejected: [], flags: [] };
  const title = lowerTitle(job.title);
  for (const lang of unknown) {
    if (lang !== 'polish' && hasTerm(title, lang)) {
      out.rejected.push(`Title asks for ${capitalize(lang)}: "${job.title}"`);
      return out;
    }
  }
  for (const sentence of jobSentences(job.description)) {
    for (const lang of unknown) {
      if (!mentionsLanguage(sentence.text, lang)) continue;
      if (readsOptional(sentence)) out.flags.push(`${capitalize(lang)} listed as desirable`);
      else out.rejected.push(`Requires ${capitalize(lang)}: "${snippet(sentence.text, 100)}"`);
    }
  }
  out.flags = [...new Set(out.flags)];
  out.rejected = [...new Set(out.rejected)].slice(0, 2);
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ───────────────────────────── Soft flags ─────────────────────────────

const IRISH_LANGUAGE = /\b(irish language|gaeilge|as gaeilge|fluent irish|irish speakers?|irish[- ]speaking|(proficiency|competency|competence|knowledge|fluency) (in|of) irish)\b/i;
const DRIVING = /\b(driving licen[cs]e|drivers? licen[cs]e|full clean licen[cs]e|own (car|transport|vehicle)|access to (a |your own )?(car|vehicle))\b/i;
const NO_SPONSORSHIP = /\b(without (the need for |requiring |needing )?(visa |employer |work permit )?sponsorship|(unable|not able|cannot|can't|do not|don't|does not|will not|won't|are not able) (to )?(offer |provide |support )?(visa |work permit )?sponsor(ship)?|no (visa |work permit )?sponsorship|sponsorship (is )?not (available|offered|provided|possible))\b/i;
const RIGHT_TO_WORK = /\b(must (already )?have (the |full |a valid )?(legal )?right to work|(full |legal |existing )?right to work in (ireland|the uk|the eu|the eea|the united kingdom|the republic of ireland)|eligib(le|ility) to work in (ireland|the uk|the eu|the eea)|stamp 4|eu\/eea (citizen|passport|national)|valid work (permit|visa))\b/i;
// "unpaid leave days" / "unpaid parental leave" are benefits, not an unpaid job (Nov 2026: flagged Ryanair PR Exec).
const UNPAID = /\b(unpaid(?!\s+(?:\w+\s+){0,2}(?:leave|holidays?|days?|time[- ]off|breaks?|lunch|overtime|sabbaticals?|vacation))|voluntary (role|position)|volunteer (role|position)|expenses only|no salary)\b/i;

function softFlags(job: ScorableJob): string[] {
  const flags: string[] = [];
  const sentences = jobSentences(job.description);
  const find = (re: RegExp) => sentences.find((s) => re.test(s.text));

  const irish = find(IRISH_LANGUAGE);
  if (irish) flags.push(readsOptional(irish) ? 'Irish language listed as desirable' : 'Irish language mentioned: check if essential');

  const driving = find(DRIVING);
  if (driving) flags.push(readsOptional(driving) ? 'Driving licence listed as desirable' : 'Driving licence / own transport required');

  const noSponsor = find(NO_SPONSORSHIP);
  const rtw = noSponsor ?? find(RIGHT_TO_WORK);
  if (rtw) flags.push(`${noSponsor ? 'No sponsorship' : 'Right-to-work wording'}: "${snippet(rtw.text)}"`);

  if (UNPAID.test(`${job.title} ${job.description}`)) flags.push('Unpaid or voluntary role');

  const terms = `${job.employmentType ?? ''} ${job.title}`.toLowerCase();
  if (/\b(contract|temporary|temp|fixed[- ]term|maternity cover|mat cover)\b/.test(terms)) flags.push('Fixed-term or contract role');
  if (/\bpart[- ]time\b/.test(terms)) flags.push('Part-time role');
  return flags;
}

// ───────────────────────────── Hard filters ─────────────────────────────

function normalizeCompany(name: string): string {
  return ` ${cleanText(name)
    .replace(/\b(ltd|limited|plc|inc|llc|dac|uc|clg|group|holdings|ireland|t\/a)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function blacklisted(company: string, blacklist: string[]): string | null {
  const c = normalizeCompany(company);
  for (const entry of blacklist) {
    const b = normalizeCompany(entry).trim();
    if (b && c.includes(` ${b} `)) return entry;
  }
  return null;
}

interface Inspection {
  filters: FilterResult;
  location: LocationInfo;
  years: YearsRequirement;
  salary: AnnualSalaryEur | null;
}

// ───────────────────────────── Long-term roles + work permit ─────────────────────────────
// Kayzee is on Stamp 1G and needs an employer who will sponsor an employment permit before it ends, in a role he can
// keep for years. So: short-term roles are rejected (when targets.permanentOnly), employers that say they can't
// sponsor are rejected, UK/NI roles are rejected unless they offer sponsorship, and sponsorship offers get a boost.

const NON_PERMANENT_TERMS = /\b(contract(?:or)?|temporary|temp|fixed[- ]term|maternity (?:leave )?cover|mat cover|interim|seasonal|internship|intern|placement|part[- ]time)\b/;
const NON_PERMANENT_JD = /\b(\d{1,2}[- ](?:month|mth)s?(?: fixed[- ]term)? contract|fixed[- ]term (?:contract|role|position|basis)|maternity (?:leave )?cover|temporary (?:role|position|contract|basis)|(?:this is|is offered as) an? (?:short[- ]term|temporary|part[- ]time) (?:role|position|contract))\b/i;
const PERMANENT_WORDS = /\b(permanent|indefinite|open[- ]ended)\b/i;
const GRAD_PROGRAMME = /\bgraduate (?:programme|program|scheme)\b/i;
/** Wording that says the employer will sponsor a work/employment permit. */
export const SPONSOR_OFFERED = /\b((?:visa|work permit|employment permit|immigration) sponsorship (?:is |will be |can be )?(?:available|provided|offered|considered|supported)|(?:we|the company) (?:can|will|are able to|is able to|do) (?:offer |provide |support )?(?:visa |work permit |employment permit )?sponsor(?:ship)?\b|sponsorship (?:is )?available|critical skills (?:employment )?permit|open to (?:visa |work permit )?sponsorship)/i;

/** Why a role isn't long-term, or null. Graduate programmes count as long-term. */
export function shortTermReason(job: ScorableJob): string | null {
  const terms = `${job.employmentType ?? ''} ${job.title}`.toLowerCase();
  const desc = job.description ?? '';
  if (/\bpart[- ]time\b/.test(terms) && !/\bfull[- ]time\b/.test(terms)) return 'Part-time role';
  if (GRAD_PROGRAMME.test(`${job.title} ${desc.slice(0, 3000)}`)) return null;
  const m = terms.match(NON_PERMANENT_TERMS);
  if (m && !PERMANENT_WORDS.test(terms)) return `Not a long-term role (${m[1]})`;
  const j = desc.match(NON_PERMANENT_JD);
  if (j && !PERMANENT_WORDS.test(desc)) return `Not a long-term role ("${snippet(j[0])}")`;
  return null;
}

function workPermitRejections(job: ScorableJob, profile: Profile, location: LocationInfo): string[] {
  if (profile.workAuth?.needsSponsorship !== true) return [];
  const out: string[] = [];
  const noSponsor = jobSentences(job.description).find((s) => NO_SPONSORSHIP.test(s.text) && !/\bwith or without\b/i.test(s.text));
  if (noSponsor) out.push(`Says it can't sponsor a work permit: "${snippet(noSponsor.text)}"`);
  if (location.cls === 'secondary' && !profile.targets.ukRightToWork && !SPONSOR_OFFERED.test(job.description ?? '')) {
    out.push("UK/Northern Ireland role: you'd need UK visa sponsorship and the posting doesn't offer it");
  }
  return out;
}

function inspect(job: ScorableJob, profile: Profile): Inspection {
  const rejected: string[] = [];
  const flags: string[] = [];
  const t = profile.targets;

  const black = blacklisted(job.company, t.blacklistCompanies);
  if (black) rejected.push(`Company is on your blacklist (${black})`);

  const excluded = excludedTitleWord(job.title, t.excludeTitleWords);
  if (excluded) rejected.push(`Title contains "${excluded.trim()}": "${job.title}"`);

  const nonTarget = nonTargetRejection(job, profile);
  if (nonTarget) rejected.push(nonTarget);

  const location = classifyLocation(job, profile);
  if (location.cls === 'outside') rejected.push(`Location outside your areas: ${location.label}`);
  flags.push(...location.flags);

  const salary = annualSalaryEur(job);
  const top = salary?.max ?? salary?.min;
  if (top !== undefined && top < t.salaryFloorEUR) {
    rejected.push(`Salary ${formatEur(top)} is below your floor of ${formatEur(t.salaryFloorEUR)}`);
  }

  const years = yearsRequired(job.description);
  if (years.mandatory !== null && years.mandatory > t.maxYearsRequired) {
    rejected.push(`Asks for ${years.mandatory}+ years' experience (your limit is ${t.maxYearsRequired})`);
  } else if (years.mandatory !== null && years.mandatory === t.maxYearsRequired) {
    flags.push(`Asks for ${years.mandatory} years' experience: check you can show it`);
  }
  if (years.optional !== null && years.optional > t.maxYearsRequired && (years.mandatory ?? 0) <= t.maxYearsRequired) {
    flags.push(`Prefers ${years.optional}+ years' experience (desirable, not essential)`);
  }

  const languages = checkLanguages(job, profile);
  rejected.push(...languages.rejected);
  flags.push(...languages.flags);
  flags.push(...softFlags(job));

  if (t.permanentOnly) {
    const short = shortTermReason(job);
    if (short) rejected.push(short);
  }
  rejected.push(...workPermitRejections(job, profile, location));
  if (profile.workAuth?.needsSponsorship === true && SPONSOR_OFFERED.test(job.description ?? '')) flags.push('Offers visa/work-permit sponsorship');

  const uniqueRejected = [...new Set(rejected)];
  return {
    filters: { pass: uniqueRejected.length === 0, rejected: uniqueRejected, flags: [...new Set(flags)] },
    location,
    years,
    salary,
  };
}

/** Hard rejections + soft flags for a job. pass=false when anything is rejected. */
export function hardFilters(job: ScorableJob, profile: Profile): FilterResult {
  return inspect(job, profile).filters;
}

// ───────────────────────────── Components ─────────────────────────────

export function freshnessComponent(postedAt: string | undefined, now: Date = new Date()): number {
  if (!postedAt) return 0.5;
  const age = daysBetween(postedAt, now);
  if (Number.isNaN(age)) return 0.5;
  if (age <= 0) return 1;
  return round2(clamp01(1 - age / FRESHNESS_DAYS));
}

function salaryComponent(salary: AnnualSalaryEur | null, floor: number): number {
  const top = salary?.max ?? salary?.min;
  if (top === undefined) return 0.6;
  return top >= floor ? 1 : 0;
}

function skillsComponent(cov: KeywordCoverage): number {
  return cov.keywords.length ? round2(clamp01(cov.pct / 100)) : 0.5;
}

export function totalScore(c: ScoreComponents): number {
  let sum = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as (keyof ScoreComponents)[]) sum += SCORE_WEIGHTS[key] * clamp01(c[key]);
  return Math.round(sum);
}

// ───────────────────────────── Reasons ─────────────────────────────

const REASON_KINDS = new Set(['skill', 'tool', 'duty']);
const MAX_REASONS = 8;

function listTerms(terms: string[], n: number): string {
  return terms.slice(0, n).join(', ');
}

function skillReasons(cov: KeywordCoverage, facts: FactBank): string[] {
  const reasons: string[] = [];
  const byTerm = new Map(cov.keywords.map((k) => [k.term, k]));
  const matched = cov.matched.map((m) => m.term).filter((t) => REASON_KINDS.has(byTerm.get(t)?.kind ?? ''));
  if (matched.length) {
    const lead = cov.pct >= 60 ? 'Strong match' : cov.pct >= 35 ? 'Partial match' : 'Some overlap';
    reasons.push(`${lead}: ${listTerms(matched, 4)}`);
  } else if (cov.keywords.length) {
    reasons.push('Few of the posting\'s skills are backed by your facts');
  }
  const dnc = facts.doNotClaim.map(normalizePhrase).filter(Boolean);
  const gaps = cov.gaps.filter((g) => REASON_KINDS.has(byTerm.get(g)?.kind ?? ''));
  const blocked = gaps.filter((g) => isDoNotClaim(g, dnc));
  const missing = gaps.filter((g) => !blocked.includes(g));
  if (missing.length === 1) reasons.push(`Gap: ${missing[0]} not in your facts`);
  else if (missing.length > 1) reasons.push(`Gaps: ${listTerms(missing, 3)} not in your facts`);
  if (blocked.length) reasons.push(`Asks for ${listTerms(blocked, 3)}: on your do-not-claim list`);
  return reasons;
}

function roleReason(fit: RoleFit): string {
  if (fit.score >= 0.85 && fit.bestRole) return `Title close to your target "${fit.bestRole}"`;
  if (fit.score >= 0.6 && fit.family) return `${fit.family === 'adjacent' ? 'Adjacent' : capitalize(fit.family)} role family`;
  if (fit.score >= 0.4) return 'Title only loosely matches your target roles';
  return 'Title outside your target roles';
}

function locationReason(info: LocationInfo): string {
  switch (info.cls) {
    case 'primary': return `${info.label}: in your primary area`;
    case 'remote': return `${info.label}: remote`;
    case 'secondary': return `${info.label}: secondary area (UK right to work differs)`;
    case 'unknown': return 'Location not stated';
    default: return `${info.label}: outside your areas`;
  }
}

function salaryReason(salary: AnnualSalaryEur | null, floor: number): string {
  const top = salary?.max ?? salary?.min;
  if (top === undefined) return 'Salary not stated';
  const shown = salary?.min && salary?.max && salary.min !== salary.max ? `${formatEur(salary.min)}-${formatEur(salary.max)}` : formatEur(top);
  return top >= floor ? `Salary ${shown} meets your floor` : `Salary ${shown} is below your ${formatEur(floor)} floor`;
}

function freshnessReason(postedAt: string | undefined, now: Date): string | null {
  if (!postedAt) return null;
  const age = Math.floor(daysBetween(postedAt, now));
  if (Number.isNaN(age)) return null;
  if (age <= 0) return 'Posted today';
  if (age > FRESHNESS_DAYS) return `Posted ${age} days ago: may already be filled`;
  return `Posted ${age} day${age === 1 ? '' : 's'} ago`;
}

function dedupeReasons(reasons: string[]): string[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = r.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ───────────────────────────── LLM judgement ─────────────────────────────

const JudgementSchema = z.object({
  roleFit: z.number().min(0).max(100),
  seniority: z.number().min(0).max(100),
  reasons: z.array(z.string().min(3).max(400)).min(1).max(6),
});

const toUnit = (n: number): number => clamp01(n > 1 ? n / 100 : n);

function cleanReason(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function candidateSummary(facts: FactBank): string {
  return facts.summaries.general ?? Object.values(facts.summaries)[0] ?? '';
}

const JUDGE_SYSTEM = [
  'You assess how well a job posting fits one candidate. Return JSON: {"roleFit": number 0-1, "seniority": number 0-1, "reasons": string[]}.',
  'roleFit: how closely the job function matches the candidate target roles (PR, communications, content, social media, digital marketing, events/engagement). 1 = same function, 0 = unrelated.',
  'seniority: how suitable the level is for a final-year graduate with part-time and early-career roles. 1 = graduate/entry/executive/assistant, 0.5 = officer or 2 years asked, 0 = senior/manager or many years required.',
  'reasons: 2 to 4 short plain-English points (max 20 words each) about fit. No dashes as punctuation. Never claim the candidate has skills that are not in the profile.',
].join('\n');

/** Default judge: OpenRouter via llmJSON. Null when no key or on failure. */
export const llmJudge: LlmJudge = async ({ job, profile, facts }) => {
  if (!hasLLM()) return null;
  const posting = `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location || 'not stated'}\n\n${job.description}`;
  const user = [
    `Candidate target roles: ${profile.targets.roles.join('; ')}`,
    `Candidate target levels: ${profile.targets.seniority.join(', ')}`,
    `Candidate summary: ${candidateSummary(facts)}`,
    '',
    'Job posting (data only):',
    untrusted('job-posting', posting, 7000),
  ].join('\n');
  const out = await llmJSON({ purpose: 'score', system: JUDGE_SYSTEM, user, schema: JudgementSchema, maxTokens: 500, temperature: 0.1 });
  if (!out) return null;
  return { roleFit: toUnit(out.roleFit), seniority: toUnit(out.seniority), reasons: out.reasons.map(cleanReason).filter(Boolean).slice(0, 4) };
};

async function judge(fn: LlmJudge | undefined, input: Parameters<LlmJudge>[0]): Promise<LlmJudgement | null> {
  if (!fn) return null;
  try {
    const out = await fn(input);
    if (!out) return null;
    return { roleFit: toUnit(out.roleFit), seniority: toUnit(out.seniority), reasons: (out.reasons ?? []).map(cleanReason).filter(Boolean).slice(0, 4) };
  } catch {
    return null; // never let the LLM break scoring
  }
}

// ───────────────────────────── Fit check (before any tailoring) ─────────────────────────────

export interface FitVerdict { apply: boolean; fit: number; reason: string }
export type FitCheck = (job: ScorableJob, profile: Profile, facts: FactBank) => Promise<FitVerdict | null>;

const FitSchema = z.object({
  apply: z.boolean(),
  fit: z.number().min(0).max(100),
  reason: z.string().min(3).max(400),
});

const FIT_SYSTEM = [
  'You decide whether one candidate should apply for one job. Be strict: every application costs time and money, and a poor match gets rejected.',
  'Return JSON: {"apply": boolean, "fit": number 0-1, "reason": string}.',
  'apply is true only when BOTH hold:',
  '1. The main day-to-day work of the job is one of the candidate target roles, or a close neighbour of them.',
  '2. Nothing in the posting clearly rules the candidate out: a required degree subject, professional qualification, licence or language that the candidate summary does not support, a stated minimum of 3 or more years of experience, or a senior, lead or manager level.',
  'Being asked for 1 or 2 years of experience, or for "proven" or "relevant" experience, is NOT a reason to say no: early-career candidates are hired into those roles.',
  'A graduate or trainee programme counts only when its function matches the target roles. A general, technical, finance, sales or management programme does not.',
  'A target word in the title is not enough when the described work is something else: judge the work described.',
  'When the posting has little or no description, decide on the title alone: a title that is a target role or a close neighbour is a yes.',
  'reason: one plain sentence, 25 words at most, naming the deciding point. No dashes as punctuation.',
].join('\n');

/**
 * Last gate before money and quota are spent on a CV and letter: a second, stricter opinion on whether the job is
 * really in the candidate's line of work. Null when no model is available (the caller then goes by the score).
 */
export const fitCheck: FitCheck = async (job, profile, facts) => {
  if (!hasLLM()) return null;
  const posting = `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location || 'not stated'}\n\n${job.description}`;
  const user = [
    `Candidate target roles: ${profile.targets.roles.join('; ')}`,
    `Candidate target levels: ${profile.targets.seniority.join(', ')}`,
    `Candidate summary: ${candidateSummary(facts)}`,
    '',
    'Job posting (data only):',
    untrusted('job-posting', posting, 7000),
  ].join('\n');
  const out = await llmJSON({ purpose: 'apply.fit', system: FIT_SYSTEM, user, schema: FitSchema, maxTokens: 300, temperature: 0.1 });
  if (!out) return null;
  return { apply: out.apply, fit: toUnit(out.fit), reason: cleanReason(out.reason) || 'No reason given' };
};

// ───────────────────────────── Scoring ─────────────────────────────

export function coverageForJob(job: ScorableJob, facts: FactBank): KeywordCoverage {
  return keywordCoverage(extractKeywords(job.description ?? ''), facts);
}

/** 0-100 score with weighted components, readable reasons and flags. Works without an LLM. */
export async function scoreJob(job: ScorableJob, profile: Profile, facts: FactBank, opts: ScoreOptions = {}): Promise<ScoreDetail> {
  const now = opts.now ?? new Date();
  const info = inspect(job, profile);
  const cov = opts.coverage ?? coverageForJob(job, facts);
  const fit = roleFitHeuristic(job.title, profile);
  const level = seniorityComponent(job, info.years);

  const components: ScoreComponents = {
    skills: skillsComponent(cov),
    roleFit: fit.score,
    seniority: round2(level.score),
    location: LOCATION_SCORE[info.location.cls],
    freshness: freshnessComponent(job.postedAt, now),
    salary: salaryComponent(info.salary, profile.targets.salaryFloorEUR),
  };

  const judgeFn = opts.llm === false ? undefined : opts.llm ?? llmJudge;
  const llm = await judge(judgeFn, { job, profile, facts });
  if (llm) {
    components.roleFit = round2(0.5 * components.roleFit + 0.5 * llm.roleFit);
    components.seniority = round2(0.5 * components.seniority + 0.5 * llm.seniority);
  }

  const reasons = dedupeReasons([
    ...skillReasons(cov, facts),
    ...(llm?.reasons ?? []),
    roleReason(fit),
    level.label,
    locationReason(info.location),
    salaryReason(info.salary, profile.targets.salaryFloorEUR),
    freshnessReason(job.postedAt, now) ?? '',
  ]).slice(0, MAX_REASONS);

  const flags = [...info.filters.rejected.map((r) => `Filtered: ${r}`), ...info.filters.flags];
  // Sponsorship is the thing he needs most. A posting that offers it, or an employer that was issued Irish employment
  // permits last year (Department of Enterprise data, config/sponsors.json), moves up the queue. Capped at +12.
  let permitBonus = 0;
  if (profile.workAuth?.needsSponsorship === true) {
    if (SPONSOR_OFFERED.test(job.description ?? '')) {
      permitBonus += 8;
      reasons.unshift('Offers visa/work-permit sponsorship');
    }
    const record = sponsorRecord(job.company);
    if (record) {
      permitBonus += knownSponsorBonus(record);
      reasons.unshift(`Known sponsor: ${record.permits} Irish employment permit${record.permits === 1 ? '' : 's'} issued to this employer in ${record.year}`);
    }
    permitBonus = Math.min(12, permitBonus);
  }

  return {
    total: Math.min(100, totalScore(components) + permitBonus),
    components,
    reasons,
    flags,
    llmUsed: Boolean(llm),
    scoredAt: now.toISOString() || nowIso(),
  };
}

/** One-shot analysis for the pipeline: filters, keyword coverage and score from a single pass. */
export async function analyzeJob(
  job: ScorableJob,
  profile: Profile,
  facts: FactBank,
  opts: Omit<ScoreOptions, 'coverage'> = {},
): Promise<{ filters: FilterResult; coverage: KeywordCoverage; score: ScoreDetail }> {
  const cov = coverageForJob(job, facts);
  const score = await scoreJob(job, profile, facts, { ...opts, coverage: cov });
  return { filters: hardFilters(job, profile), coverage: cov, score };
}
