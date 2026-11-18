// Pure matching rules for the resolver: title similarity, company identity, location compatibility,
// board-slug derivation. Applying to the wrong job is worse than not applying, so every rule here errs
// on the side of "no match".

import { cleanInline, countriesIn, decodeEntities } from '@/engine/sources/normalize';
import type { CompanyEvidence, LocationVerdict, MatchVerdict } from './types';

// ───────────────────────────── Text helpers ─────────────────────────────

/** Lowercase, accent-free, '&' → 'and', punctuation → spaces. */
export function fold(text: string | undefined | null): string {
  return cleanInline(decodeEntities(text ?? ''))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[™®©]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ───────────────────────────── Locations ─────────────────────────────

const CITY_NAMES = [
  'dublin', 'cork', 'galway', 'limerick', 'waterford', 'dundalk', 'drogheda', 'belfast', 'newry', 'derry', 'londonderry',
  'lisburn', 'armagh', 'craigavon', 'bangor', 'swords', 'letterkenny', 'mullingar', 'shannon', 'ennis', 'athlone', 'sligo',
  'kilkenny', 'wexford', 'naas', 'navan', 'maynooth', 'bray', 'tralee', 'carlow', 'portlaoise', 'tullamore', 'clonmel',
  'killarney', 'castlebar', 'cavan', 'monaghan', 'aldergrove', 'newbridge', 'leixlip', 'tallaght', 'blanchardstown',
  'sandyford', 'malahide', 'balbriggan', 'ashbourne', 'greystones', 'arklow', 'longford', 'roscommon', 'ballina', 'westport',
  'nenagh', 'thurles', 'mallow', 'midleton', 'cobh', 'dungarvan', 'enniscorthy', 'portadown', 'lurgan', 'omagh',
  'enniskillen', 'coleraine', 'ballymena', 'antrim', 'newtownabbey', 'carrickfergus', 'banbridge',
  'london', 'manchester', 'edinburgh', 'glasgow', 'birmingham', 'leeds', 'bristol', 'liverpool', 'cardiff', 'newcastle',
  'sheffield', 'nottingham', 'cambridge', 'oxford', 'brighton', 'milton keynes', 'aberdeen', 'southampton',
];
const CITY_RE = new RegExp(`\\b(${CITY_NAMES.map((c) => c.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'g');
const COUNTY_RE = /\b(?:county|co)\s+(dublin|cork|galway|limerick|waterford|louth|meath|kildare|wicklow|wexford|kilkenny|carlow|laois|offaly|westmeath|longford|clare|kerry|tipperary|mayo|sligo|leitrim|roscommon|donegal|cavan|monaghan|antrim|down|armagh|tyrone|fermanagh|londonderry|derry)\b/g;

/** City / county keys named in a location string ("Swords, County Dublin" → {swords, dublin}). */
export function citiesIn(text: string | undefined | null): Set<string> {
  const s = fold(text);
  const out = new Set<string>();
  if (!s) return out;
  for (const m of s.matchAll(CITY_RE)) out.add(m[1].replace(/\s+/g, ' '));
  for (const m of s.matchAll(COUNTY_RE)) out.add(m[1] === 'londonderry' ? 'derry' : m[1]);
  if (out.has('londonderry')) {
    out.delete('londonderry');
    out.add('derry');
  }
  return out;
}

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|home based|distributed|virtual)\b/;
const EUROPE_RE = /\b(emea|europe|european|eu|eea|uk and ireland|ireland and uk|ireland)\b/;
const NON_EU_RE = /\b(us|usa|united states|america|americas|canada|apac|latam|india|australia|singapore|japan)\b/;

/**
 * Is the target posting's location compatible with Kayzee's job? Same city (or the job only names a
 * country the target is in), or a remote role open to Ireland/Europe. Different cities → incompatible.
 */
export function locationVerdict(
  job: { location: string; title?: string },
  targetLocation: string | undefined | null,
  targetRemote?: boolean,
): LocationVerdict {
  const t = fold(targetLocation);
  if (!t && !targetRemote) return 'unknown';
  const jobCities = citiesIn(`${job.location} ${titleLocationHints(job.title ?? '')}`);
  const tCities = citiesIn(t);
  const jCountries = countriesIn(job.location);
  const tCountries = countriesIn(targetLocation);
  const tRemote = Boolean(targetRemote) || REMOTE_RE.test(t);

  if (!job.location.trim() && !jobCities.size) return 'unknown';
  const intersects = [...tCities].some((c) => jobCities.has(c));
  if (jobCities.size && tCities.size && intersects) return 'compatible';

  if (tCountries.size) {
    const shared = [...tCountries].some((c) => jCountries.has(c));
    if (!shared) {
      if (tRemote && (EUROPE_RE.test(t) || tCountries.has('IE'))) return 'compatible';
      if (jCountries.has('GB-NIR') && tCountries.has('GB') && !tCities.size) return 'unknown';
      return 'incompatible';
    }
    if (jobCities.size && tCities.size) return tRemote ? 'compatible' : 'incompatible';
    return 'compatible';
  }
  if (tCities.size) {
    if (jobCities.size) return tRemote ? 'compatible' : 'incompatible';
    return 'unknown';
  }
  if (tRemote) return NON_EU_RE.test(t) && !EUROPE_RE.test(t) ? 'incompatible' : 'compatible';
  return 'unknown';
}

/** City names that appear in the location-ish tail of a title ("... - Galway", "... – Belfast"). */
function titleLocationHints(title: string): string {
  const parts = cleanInline(decodeEntities(title)).split(/\s+[-–—|]\s+|,\s*/);
  return parts.slice(1).filter((p) => citiesIn(p).size > 0 && p.split(/\s+/).length <= 4).join(' ');
}

// ───────────────────────────── Titles ─────────────────────────────

const STOPWORDS = new Set(['the', 'and', 'of', 'for', 'to', 'a', 'an', 'in', 'with', 'at', 'on', 'or', 'our', 'your', 'm', 'f', 'd', 'w', 'x', 'job', 'vacancy', 'position', 'role']);
/** Seniority/level words: if one title has one and the other doesn't, they are different jobs. */
const SENIORITY = new Set(['senior', 'junior', 'lead', 'principal', 'head', 'director', 'manager', 'intern', 'graduate', 'trainee', 'chief', 'vp', 'staff', 'apprentice', 'entry']);

const SYNONYMS: [RegExp, string][] = [
  [/\bpublic relations\b/g, 'pr'],
  [/\bco ordinator\b/g, 'coordinator'],
  [/\bprogramme\b/g, 'program'],
  [/\bcomms\b/g, 'communications'],
  [/\bmktg\b/g, 'marketing'],
  [/\bexec\b/g, 'executive'],
  [/\bmgr\b/g, 'manager'],
  [/\b(snr|sr)\b/g, 'senior'],
  [/\b(jnr|jr)\b/g, 'junior'],
  [/\binternships?\b/g, 'intern'],
  [/\bgrad\b/g, 'graduate'],
  [/\borganisation/g, 'organization'],
  [/\be mail\b/g, 'email'],
];

const WORK_MODE_RE = /^(remote|hybrid|on ?site|onsite|in office|full ?time|part ?time|permanent|perm|contract|contractor|temporary|temp|fixed ?term( contract)?|ftc|maternity (cover|leave)|\d+ ?(month|months|mth|year|years)( fixed term)?( contract)?|immediate start|urgent|new|apply now|\d{4} start|start \d{4})$/;

function isLocationSegment(seg: string): boolean {
  const f = fold(seg);
  if (!f) return false;
  const words = f.split(' ').length;
  if (words > 5) return false;
  if (citiesIn(f).size > 0 && words <= 4) return true;
  if (countriesIn(seg).size > 0 && words <= 4) return true;
  return /^(remote|hybrid)( \w+)?$/.test(f) || /\b(county|co) [a-z]+$/.test(f) || /^dublin \d{1,2}w?$/.test(f);
}

/** Splits off " - Dublin", " | CCS1259", "(Fixed Term)", " - Tesco Ireland" style noise; keeps the job name. */
export function cleanTitle(title: string, company?: string): string {
  let s = cleanInline(decodeEntities(title));
  s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ');
  // " | ..." tails are codes, locations or brands: keep the first segment.
  s = s.split(/\s+\|\s+|\s*\|\s*(?=[A-Z0-9])/)[0];
  const companyKey = company ? coreTokens(company) : [];
  const segments = s.split(/\s+[-–—]\s+|\s+[–—]|[–—]\s+/).map((x) => x.trim()).filter(Boolean);
  const kept = segments.filter((seg, i) => {
    const f = fold(seg);
    if (!f) return false;
    if (WORK_MODE_RE.test(f)) return false;
    if (isLocationSegment(seg)) return false;
    if (companyKey.length && i > 0) {
      const toks = new Set(f.split(' '));
      if (companyKey.some((t) => t.length >= 3 && toks.has(t))) return false;
    }
    return true;
  });
  let out = (kept.length ? kept : segments.slice(0, 1)).join(' ').replace(/,(\s*,)+/g, ',').replace(/[,\s]+$/, '');
  // A trailing ", Dublin" / ", Galway" is a location too ("Community Fundraising Executive, Fundraising, Dublin").
  for (let i = 0; i < 3; i++) {
    const m = /,\s*([^,]+)$/.exec(out);
    if (m && isLocationSegment(m[1])) out = out.slice(0, m.index);
    else break;
  }
  return out.trim();
}

function stem(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Normalised, de-duplicated title tokens (synonyms, plurals, reference codes and stopwords removed). */
export function titleTokens(title: string, company?: string): string[] {
  let f = fold(cleanTitle(title, company)).replace(/-/g, ' ');
  for (const [re, to] of SYNONYMS) f = f.replace(re, to);
  const out: string[] = [];
  for (const raw of f.split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (/^(?=.*\d)(?=.*[a-z])[a-z0-9]{4,}$/.test(raw)) continue; // ccs1259, r425826: reference codes
    const t = stem(raw);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export interface TitleSimilarity { score: number; exact: boolean; seniorityMismatch: boolean }

export function titleSimilarity(a: string, b: string, company?: string): TitleSimilarity {
  const A = new Set(titleTokens(a, company));
  const B = new Set(titleTokens(b, company));
  if (!A.size || !B.size) return { score: 0, exact: false, seniorityMismatch: false };
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  const score = Math.round((inter / union) * 1000) / 1000;
  const exact = inter === A.size && inter === B.size;
  const senA = [...A].filter((t) => SENIORITY.has(t)).sort().join(',');
  const senB = [...B].filter((t) => SENIORITY.has(t)).sort().join(',');
  return { score: exact ? 1 : score, exact, seniorityMismatch: senA !== senB };
}

export const TITLE_THRESHOLD = 0.75;

export function titlesMatch(a: string, b: string, company?: string): boolean {
  const s = titleSimilarity(a, b, company);
  return !s.seniorityMismatch && (s.exact || s.score >= TITLE_THRESHOLD);
}

// ───────────────────────────── Companies ─────────────────────────────

const LEGAL_OR_REGION = new Set([
  'ltd', 'limited', 'group', 'ireland', 'irish', 'dac', 'plc', 'inc', 'incorporated', 'llc', 'llp', 'uc', 'clg', 'co', 'company',
  'corp', 'corporation', 'holdings', 'holding', 'uk', 'europe', 'emea', 'international', 'global', 'the', 'and', 'of', 'gmbh',
  'ag', 'sa', 'bv', 'agency', 'hub',
]);

/** Words that, alone, are too common to identify a company from a board slug or host name. */
const COMMON_NAME_WORDS = new Set([
  'alternatives', 'enterprise', 'search', 'digital', 'focus', 'force', 'circle', 'virgin', 'marsh', 'smart', 'media', 'creative',
  'fluent', 'pivotal', 'associations', 'staff', 'management', 'coaching', 'talent', 'people', 'engage', 'link', 'recruitment',
  'consulting', 'solutions', 'services', 'partners', 'design', 'studio', 'marketing', 'labs', 'capital', 'health', 'energy',
  'green', 'blue', 'red', 'first', 'prime', 'apex', 'summit', 'global', 'united', 'national', 'general', 'central', 'premier',
  'elite', 'select', 'connect', 'direct', 'online', 'tech', 'technology', 'technologies', 'systems', 'software', 'data', 'cloud',
]);

/** "Ryanair - Europe's Favourite Airline" → "Ryanair"; drops parentheticals and ™. */
export function companyDisplay(name: string | undefined | null): string {
  let s = cleanInline(decodeEntities(name ?? ''));
  s = s.split(/\s+[-–—|]\s+/)[0];
  s = s.replace(/\([^)]*\)/g, ' ').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

/** All tokens of the display name ("Food Safety Authority of Ireland" → food safety authority of ireland). */
export function fullTokens(name: string | undefined | null): string[] {
  return fold(companyDisplay(name)).split(' ').filter(Boolean);
}

/** Identity tokens without legal/region words ("Dalata Hotel Group" → dalata hotel). */
export function coreTokens(name: string | undefined | null): string[] {
  const full = fullTokens(name);
  const core = full.filter((t) => !LEGAL_OR_REGION.has(t));
  return core.length ? core : full.filter((t) => t !== 'the' && t !== 'and' && t !== 'of');
}

export function acronym(name: string | undefined | null): string {
  const toks = fullTokens(name).filter((t) => !['of', 'and', 'the', 'for'].includes(t) && !/^\d+$/.test(t));
  return toks.length >= 3 ? toks.map((t) => t[0]).join('') : '';
}

/** True when a company name is too generic to be identified by a slug or host alone. */
export function isWeakName(name: string): boolean {
  const core = coreTokens(name);
  if (!core.length) return true;
  const joined = core.join('');
  if (joined.length < 4) return true;
  return core.length === 1 && COMMON_NAME_WORDS.has(core[0]);
}

/** Do two company names refer to the same employer? */
export function companyMatches(a: string | undefined | null, b: string | undefined | null): boolean {
  const A = coreTokens(a);
  const B = coreTokens(b);
  if (!A.length || !B.length) return false;
  const ja = A.join('');
  const jb = B.join('');
  if (ja === jb) return true;
  // "Microchip" ⊂ "Microchip Technology", "Marsh" ⊂ "Marsh McLennan": the shorter name must be the
  // longer one's leading words (so "Search Talent" never matches "Talent Search Partners").
  const [small, big] = A.length <= B.length ? [A, B] : [B, A];
  if (small.every((t, i) => big[i] === t) && small.join('').length >= 3) return true;
  // "TCS" vs "Tata Consultancy Services", "FSAI" vs "Food Safety Authority of Ireland".
  const acA = acronym(a);
  const acB = acronym(b);
  if (A.length === 1 && acB && A[0] === acB) return true;
  if (B.length === 1 && acA && B[0] === acA) return true;
  return false;
}

const HOST_NOISE = new Set([
  'www', 'careers', 'career', 'jobs', 'job', 'apply', 'join', 'joinus', 'work', 'workwithus', 'talent', 'recruiting', 'recruitment',
  'hr', 'en', 'ie', 'uk', 'com', 'co', 'org', 'net', 'io', 'eu', 'de', 'info', 'biz', 'gov', 'app', 'global', 'corporate', 'group',
]);

/** Does a host name belong to the company ("careers.dalatahotelgroup.com" ↔ "Dalata Hotel Group")? */
export function hostMatchesCompany(host: string, company: string): boolean {
  const labels = host.toLowerCase().split('.').filter((l) => l && !HOST_NOISE.has(l)).map((l) => l.replace(/-/g, ''));
  if (!labels.length) return false;
  const core = coreTokens(company);
  const full = fullTokens(company);
  if (!core.length) return false;
  const coreJoined = core.join('');
  const fullJoined = full.join('');
  const ac = acronym(company);
  // "Focus Ireland" must not claim focus.com: a common-word core only counts with its full name.
  if (core.length === 1 && COMMON_NAME_WORDS.has(core[0])) {
    return labels.some((label) => label === fullJoined || (fullJoined === coreJoined && label === coreJoined));
  }
  return labels.some((label) => {
    if (label === coreJoined || label === fullJoined) return true;
    if (ac && ac.length >= 3 && label === ac) return true;
    if (coreJoined.length >= 6 && label.includes(coreJoined)) return true;
    const first = core[0];
    if (first.length >= 5 && !COMMON_NAME_WORDS.has(first) && label.startsWith(first)) return true;
    if (core.length >= 2 && label === core.slice(0, 2).join('')) return true;
    return false;
  });
}

// ───────────────────────────── Slugs ─────────────────────────────

export interface SlugCandidate { slug: string; weak: boolean }

/**
 * Board slugs to probe for a company: joined/hyphenated cores, the full name, an acronym and the
 * LinkedIn company slug. At most `max`. Slugs that are common words are marked weak.
 */
export function companySlugs(company: string, extra: string[] = [], max = 6): SlugCandidate[] {
  const core = coreTokens(company);
  const full = fullTokens(company).filter((t) => t !== 'and' && t !== 'of' && t !== 'the');
  const out: string[] = [];
  const add = (s: string | undefined) => {
    const v = (s ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };
  // Priority order: the forms boards use most often first, so the cap drops the long shots.
  const ac = acronym(company);
  add(core.join(''));
  if (ac.length >= 3 && core.length >= 3) add(ac);
  if (core.length > 1) add(core.join('-'));
  for (const e of extra) {
    add(e.replace(/-/g, ''));
    add(e);
  }
  if (full.join('') !== core.join('')) add(full.join(''));
  if (core.length >= 2 && core[0].length >= 5 && !COMMON_NAME_WORDS.has(core[0])) add(core[0]);
  if (core.length >= 3) add(core.slice(0, 2).join(''));
  if (ac.length >= 3) add(ac);
  if (full.length > 1 && full.join('-') !== core.join('-')) add(full.join('-'));
  const weakCompany = isWeakName(company);
  return out.slice(0, max).map((slug) => {
    const compact = slug.replace(/-/g, '');
    const weak = compact.length < 4 || COMMON_NAME_WORDS.has(compact) || (weakCompany && compact === core.join(''));
    return { slug, weak };
  });
}

/** Does a board slug plausibly belong to the company? (used for URLs found by search) */
export function slugMatchesCompany(slug: string, company: string): boolean {
  const s = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return false;
  const core = coreTokens(company).join('');
  const full = fullTokens(company).join('');
  const ac = acronym(company);
  if (s === core || s === full || (ac && s === ac)) return true;
  if (core.length >= 5 && s.startsWith(core)) return true; // "ryanairgroupholdings" ← "ryanair"
  const first = coreTokens(company)[0] ?? '';
  return first.length >= 5 && !COMMON_NAME_WORDS.has(first) && s.startsWith(first);
}

// ───────────────────────────── Verdicts ─────────────────────────────

const COMPANY_WEIGHT: Record<CompanyEvidence, number> = {
  api_name: 1, jsonld_org: 1, domain: 0.95, agency_site: 0.95, slug: 0.9, page_text: 0.85,
};

/**
 * The single acceptance rule: company evidence AND title similarity ≥ 0.75 (no seniority clash) AND
 * location compatible (or unknown on the target, but only with strong company evidence).
 */
export function judge(
  job: { title: string; company: string; location: string },
  target: { title: string; location?: string; remote?: boolean },
  company: CompanyEvidence | undefined,
  opts: { weakSlug?: boolean } = {},
): MatchVerdict {
  const sim = titleSimilarity(job.title, target.title, job.company);
  const location = locationVerdict(job, target.location, target.remote);
  const base = { titleScore: sim.score, location, company };
  if (!company) return { ok: false, confidence: 0, reason: 'company not confirmed', ...base };
  if (sim.seniorityMismatch) return { ok: false, confidence: 0, reason: `seniority differs ("${target.title}")`, ...base };
  if (!(sim.exact || sim.score >= TITLE_THRESHOLD)) return { ok: false, confidence: 0, reason: `title too different ("${target.title}", ${sim.score})`, ...base };
  if (location === 'incompatible') return { ok: false, confidence: 0, reason: `location differs ("${target.location ?? ''}")`, ...base };
  if (location === 'unknown' && (company === 'slug' || company === 'page_text')) {
    return { ok: false, confidence: 0, reason: 'location unknown and company only inferred', ...base };
  }
  if (opts.weakSlug && !sim.exact) return { ok: false, confidence: 0, reason: 'generic board slug needs an exact title', ...base };
  const confidence = Math.round(sim.score * COMPANY_WEIGHT[company] * (location === 'compatible' ? 1 : 0.9) * 100) / 100;
  return { ok: true, confidence, ...base };
}
