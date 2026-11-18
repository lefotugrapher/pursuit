// Turns adapter output (RawJob) into a NewJob: clean text, location/country, remote, salary, ATS, id.
// Pure functions only (no I/O), so every piece is unit-testable.

import { createHash } from 'node:crypto';
import { toIso } from '@/lib/time';
import type { AtsKind, NewJob, RawJob, Salary } from '@/lib/types';

export type Country = NonNullable<NewJob['country']>;

const MAX_DESCRIPTION_CHARS = 60_000;

// ───────────────────────────── Entities + HTML ─────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  bull: '•', middot: '·', euro: '€', pound: '£', dollar: '$', cent: '¢', yen: '¥', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', divide: '÷', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿', sect: '§', para: '¶',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', aelig: 'æ',
  Eacute: 'É', Aacute: 'Á', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Ccedil: 'Ç', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä',
  zwj: '', zwnj: '', shy: '', lrm: '', rlm: '',
};

function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

/** Decodes named, decimal and hex HTML entities. Unknown named entities are left untouched. */
export function decodeEntities(input: string): string {
  if (!input || !input.includes('&')) return input ?? '';
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (match, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const ch = codePointToString(cp);
      return ch === '' && cp !== 0 ? match : ch;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    if (named === undefined) return match;
    // Without a trailing ';' only decode when it is unambiguous (e.g. "&amp" in a URL) — we require `;` otherwise.
    return match.endsWith(';') || body === 'amp' ? named : match;
  });
}

/** Collapses runs of whitespace (incl. nbsp/zero-width) into single spaces and trims. */
export function cleanInline(text: string | undefined | null): string {
  if (!text) return '';
  return decodeEntities(text).replace(/[​-‍﻿]/g, '').replace(/[\s ]+/g, ' ').trim();
}

const BLOCK_CLOSE = /<\/(p|div|section|article|header|footer|h[1-6]|ul|ol|table|blockquote|pre)\s*>/gi;
const BLOCK_OPEN = /<(p|div|section|article|header|footer|h[1-6]|ul|ol|table|blockquote|pre)(\s[^>]*)?>/gi;

/**
 * HTML → readable plain text. Keeps paragraph breaks (blank line), line breaks and list items ("- item").
 * Handles HTML that arrives entity-escaped (Greenhouse `content`), drops scripts/styles/comments.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  let s = String(html);
  // Entity-escaped markup ("&lt;p&gt;...") with no real tags: unescape once first.
  if (!/<[a-z!/][^>]*>/i.test(s) && /&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);

  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, ' ') // source newlines are not meaningful in HTML
    .replace(/<br\s*\/?>/gi, '\n')
    // Block tags right inside <li> (<li><p>, <li><div><div>) must not push the bullet onto its own line.
    .replace(/<li(\s[^>]*)?>(\s*<(p|div)(\s[^>]*)?>)*/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<hr(\s[^>]*)?\/?>/gi, '\n\n')
    .replace(BLOCK_CLOSE, '\n\n')
    .replace(BLOCK_OPEN, '\n\n')
    .replace(/<[^>]+>/g, '');

  s = decodeEntities(s).replace(/[​-‍﻿]/g, '').replace(/ /g, ' ');
  return tidyText(s);
}

/** Normalises plain text: trims lines, collapses spaces, at most one blank line in a row, tight bullet lists. */
export function tidyText(text: string): string {
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/[ \t\f\v]+/g, ' ').trim();
    if (line === '' || line === '-') {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const isBullet = line.startsWith('- ');
    if (isBullet && out.length >= 2 && out[out.length - 1] === '' && out[out.length - 2].startsWith('- ')) out.pop();
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').trim();
}

// ───────────────────────────── Salary ─────────────────────────────

const HOURS_PER_YEAR = 1950;
const DAYS_PER_YEAR = 230;

type Period = 'hour' | 'day' | 'week' | 'month' | 'year';
const PERIOD_FACTOR: Record<Period, number> = { hour: HOURS_PER_YEAR, day: DAYS_PER_YEAR, week: 52, month: 12, year: 1 };

const CURRENCY_SYMBOL: Record<string, string> = { '€': 'EUR', '£': 'GBP', $: 'USD' };
const CURRENCY_CODE = /\b(EUR|GBP|USD|euros?|pounds?|sterling)\b/i;

function currencyFrom(text: string): string | undefined {
  const sym = /[€£$]/.exec(text)?.[0];
  if (sym) return CURRENCY_SYMBOL[sym];
  const code = CURRENCY_CODE.exec(text)?.[1]?.toLowerCase();
  if (!code) return undefined;
  if (code.startsWith('eur')) return 'EUR';
  if (code.startsWith('pound') || code === 'gbp' || code === 'sterling') return 'GBP';
  if (code === 'usd') return 'USD';
  return undefined;
}

function periodFrom(text: string): Period | undefined {
  const t = text.toLowerCase();
  const per = String.raw`(?:\bper|\ban|\ba|\/)\s*`;
  if (new RegExp(`${per}(hour|hr)\\b|\\bhourly\\b|\\bp\\/h\\b`).test(t)) return 'hour';
  if (new RegExp(`${per}day\\b|\\bdaily\\b|\\bday rate\\b|\\bp\\/d\\b`).test(t)) return 'day';
  if (new RegExp(`${per}(week|wk)\\b|\\bweekly\\b|\\bp\\/w\\b`).test(t)) return 'week';
  if (new RegExp(`${per}(month|mo)\\b|\\bmonthly\\b|\\bpcm\\b|\\bp\\/m\\b`).test(t)) return 'month';
  if (new RegExp(`${per}(year|yr|annum)\\b|\\bannual(ly)?\\b|\\bp\\.a\\.?|\\bpa\\b|\\byearly\\b`).test(t)) return 'year';
  return undefined;
}

/** "35,000" | "35.000" | "35000" | "35" | "15.50" (+ optional k) → number. */
function parseAmount(num: string, k: boolean): number | undefined {
  let n = num.replace(/\s/g, '');
  const withCents = /^(\d{1,3}(?:[.,]\d{3})+)[.,]\d{1,2}$/.exec(n);
  if (withCents) n = withCents[1]; // "35,000.00" / "35.000,00"
  if (/^\d{1,3}([.,]\d{3})+$/.test(n)) n = n.replace(/[.,]/g, ''); // thousands separators
  else if (/^\d+,\d{1,2}$/.test(n)) n = n.replace(',', '.'); // "15,50" decimal comma
  else n = n.replace(/,/g, '');
  const v = Number(n);
  if (!Number.isFinite(v)) return undefined;
  return k ? v * 1000 : v;
}

const AMOUNT = String.raw`(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?([kK](?![a-zA-Z]))?`;
const CUR_PRE = String.raw`(€|£|\$|EUR\s?|GBP\s?|USD\s?)`;
const CUR_POST = String.raw`(\s?(?:EUR|GBP|USD|€|£)(?![a-zA-Z]))`;
const UNIT = String.raw`(?:\s?\/\s?(?:yr|year|annum|hr|hour|day|wk|week|mo|month)\b)?`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|\bto\b|\band\b)\s*`;
// Groups: 1 cur1, 2 num1, 3 k1, 4 post1, 5 cur2, 6 num2, 7 k2, 8 post2
const MONEY_RANGE = new RegExp(String.raw`${CUR_PRE}?\s?${AMOUNT}${CUR_POST}?${UNIT}(?:${RANGE_SEP}${CUR_PRE}?\s?${AMOUNT}${CUR_POST}?${UNIT})?`, 'g');

function plausibleAnnual(v: number): boolean {
  return v >= 5_000 && v <= 1_000_000;
}

interface SalaryOpts { currency?: string; requireCurrency?: boolean }

/**
 * Parses a salary phrase into an annual EUR/GBP/USD range. Handles "€35,000 - €40,000", "£25k-£30k",
 * "€30-35k", "€15.50 per hour" (×1950), "£200 per day" (×230), "€3,000 per month", "35.000 EUR p.a.".
 * Returns undefined when nothing plausible is found. With requireCurrency, only amounts carrying a
 * currency symbol/code count (so "50,000 customers" in a description is ignored).
 */
export function parseSalary(text: string | undefined | null, opts: SalaryOpts = {}): Salary | undefined {
  if (!text) return undefined;
  const raw = cleanInline(text);
  if (!raw) return undefined;

  for (const m of raw.matchAll(MONEY_RANGE)) {
    const [whole, cur1, num1, k1, post1, cur2, num2, k2, post2] = m;
    if (!num1) continue;
    const marker = `${cur1 ?? ''}${post1 ?? ''}${cur2 ?? ''}${post2 ?? ''}`;
    if (opts.requireCurrency && !marker.trim()) continue;
    const currency = currencyFrom(marker) ?? opts.currency;
    const start = m.index ?? 0;
    const window = raw.slice(Math.max(0, start - 12), start + whole.length + 40);
    // A "k" on the upper bound applies to a small lower bound too ("€30-35k").
    const kLow = Boolean(k1) || (Boolean(k2) && num2 !== undefined && Number(num1.replace(/[.,]/g, '')) < 1000);
    let lo = parseAmount(num1, kLow);
    let hi = num2 !== undefined ? parseAmount(num2, Boolean(k2)) : undefined;
    if (lo === undefined) continue;
    if (hi !== undefined && hi < lo) [lo, hi] = [hi, lo];

    const period = periodFrom(window) ?? (plausibleAnnual(lo) ? 'year' : undefined);
    if (!period) continue;
    const factor = PERIOD_FACTOR[period];
    const min = Math.round(lo * factor);
    const max = hi !== undefined ? Math.round(hi * factor) : undefined;
    if (!plausibleAnnual(min) || (max !== undefined && !plausibleAnnual(max))) continue;
    const salary: Salary = { min, period: 'year', raw: raw.length > 160 ? whole.trim() : raw };
    if (max !== undefined && max !== min) salary.max = max;
    if (currency) salary.currency = currency;
    return salary;
  }
  return undefined;
}

/** Looks for a salary statement inside a job description (currency symbol/code required). */
export function findSalaryInText(text: string): Salary | undefined {
  if (!text) return undefined;
  const lines = text.split('\n').filter((l) => /[€£]|\b(EUR|GBP)\b/.test(l) && /\d/.test(l));
  // Prefer lines that talk about pay.
  lines.sort((a, b) => Number(/salary|compensation|pay|per annum|rate|wage|€|£/i.test(b)) - Number(/salary|compensation|pay|per annum|rate|wage|€|£/i.test(a)));
  for (const line of lines.slice(0, 20)) {
    const s = parseSalary(line.slice(0, 300), { requireCurrency: true });
    if (s) return { ...s, raw: s.raw && s.raw.length > 120 ? s.raw.slice(0, 120) : s.raw };
  }
  return undefined;
}

// ───────────────────────────── Location ─────────────────────────────

function wordRe(words: string[]): RegExp {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(`(^|[^a-z])(${escaped.join('|')})(?![a-z])`, 'i');
}

const NI_RE = wordRe([
  'northern ireland', 'belfast', 'newry', 'derry', 'londonderry', 'lisburn', 'armagh', 'craigavon', 'portadown', 'lurgan',
  'enniskillen', 'omagh', 'coleraine', 'ballymena', 'newtownabbey', 'banbridge', 'dungannon', 'strabane', 'carrickfergus',
  'newtownards', 'antrim', 'downpatrick', 'magherafelt', 'limavady', 'larne', 'holywood', 'co. down', 'county down', 'co down',
  'co. tyrone', 'county tyrone', 'co tyrone', 'fermanagh', 'n. ireland', 'ni, uk', 'bangor, co',
]);
const IE_RE = wordRe([
  'ireland', 'republic of ireland', 'éire', 'eire', 'dublin', 'cork', 'galway', 'limerick', 'waterford', 'dundalk', 'drogheda',
  'louth', 'meath', 'kildare', 'wicklow', 'wexford', 'kilkenny', 'carlow', 'laois', 'offaly', 'westmeath', 'longford',
  'swords', 'navan', 'naas', 'maynooth', 'bray', 'athlone', 'sligo', 'letterkenny', 'donegal', 'ennis', 'shannon', 'tralee',
  'killarney', 'kerry', 'clare', 'tipperary', 'mayo', 'castlebar', 'leixlip', 'tallaght', 'blanchardstown', 'sandyford',
  'dun laoghaire', 'balbriggan', 'malahide', 'cavan', 'monaghan', 'mullingar', 'portlaoise', 'tullamore', 'clonmel', 'newbridge',
]);
const GB_RE = wordRe([
  'united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'gb', 'london', 'manchester',
  'birmingham', 'edinburgh', 'glasgow', 'bristol', 'leeds', 'liverpool', 'cardiff', 'sheffield', 'newcastle', 'nottingham',
  'cambridge', 'oxford', 'brighton', 'leicester', 'southampton', 'aberdeen', 'milton keynes',
  'swansea', 'coventry', 'exeter', 'norwich', 'plymouth', 'portsmouth', 'guildford', 'slough', 'watford', 'dundee',
]);
const OTHER_RE = wordRe([
  'united states', 'usa', 'u.s.', 'us', 'america', 'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'peru',
  'germany', 'deutschland', 'france', 'spain', 'españa', 'portugal', 'italy', 'netherlands', 'belgium', 'luxembourg',
  'switzerland', 'austria', 'poland', 'czech', 'czechia', 'hungary', 'romania', 'bulgaria', 'greece', 'turkey', 'türkiye',
  'sweden', 'norway', 'denmark', 'finland', 'iceland', 'estonia', 'latvia', 'lithuania', 'ukraine', 'serbia', 'croatia',
  'israel', 'uae', 'united arab emirates', 'dubai', 'saudi arabia', 'qatar', 'egypt', 'nigeria', 'kenya', 'south africa',
  'india', 'pakistan', 'bangladesh', 'sri lanka', 'china', 'hong kong', 'taiwan', 'japan', 'korea', 'singapore', 'malaysia',
  'indonesia', 'philippines', 'vietnam', 'thailand', 'australia', 'new zealand',
  'new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver', 'atlanta', 'miami',
  'toronto', 'vancouver', 'montreal', 'berlin', 'munich', 'hamburg', 'paris', 'madrid', 'barcelona', 'lisbon', 'amsterdam',
  'rotterdam', 'brussels', 'zurich', 'vienna', 'warsaw', 'krakow', 'prague', 'budapest', 'bucharest', 'stockholm', 'oslo',
  'copenhagen', 'helsinki', 'tallinn', 'milan', 'rome', 'athens', 'istanbul', 'tel aviv', 'bangalore', 'bengaluru',
  'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai', 'karachi', 'lahore', 'tokyo', 'seoul', 'shanghai', 'beijing',
  'sydney', 'melbourne', 'auckland', 'sao paulo', 'são paulo', 'buenos aires', 'bogota', 'mexico city',
  'apac', 'latam', 'americas', 'north america', 'nordics', 'dach', 'benelux',
]);
const US_STATE_RE = /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const US_STATE_NAMES_RE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const REMOTE_WORDS_RE = /\b(remote|anywhere|work from home|wfh|home[- ]based|distributed|worldwide|global)\b/i;
const EUROPE_RE = /\b(emea|europe|european union|eu|eea|uk\s*&\s*ireland|uk and ireland|ireland and uk)\b/i;

/** All countries a location string mentions (several for multi-location postings). */
export function countriesIn(location: string | undefined | null): Set<Country> {
  const found = new Set<Country>();
  const original = cleanInline(location);
  const s = original.toLowerCase();
  if (!s) return found;
  // "Dublin, OH" / "Dublin, California": a US state wins over a city name unless Ireland is explicit.
  if ((US_STATE_RE.test(original) || US_STATE_NAMES_RE.test(s)) && !/\bireland\b/.test(s)) {
    found.add('OTHER');
    if (GB_RE.test(s) && /united kingdom|\buk\b/.test(s)) found.add('GB');
    return found;
  }
  if (NI_RE.test(s)) found.add('GB-NIR');
  const withoutNi = s.replace(/northern\s+ireland/g, ' ');
  if (IE_RE.test(withoutNi) || /(^|[,(\s])ie\)?$/.test(withoutNi)) found.add('IE');
  if (GB_RE.test(s)) found.add('GB');
  if (OTHER_RE.test(s)) found.add('OTHER');
  if (found.has('GB-NIR')) found.delete('GB'); // "Belfast, UK" is NI, not GB-mainland
  return found;
}

/**
 * Best country for Kayzee: IE > GB-NIR > GB > REMOTE > OTHER. REMOTE only for remote/EMEA/Europe postings
 * that name no specific country. undefined when the string gives no clue.
 */
export function detectCountry(location: string | undefined | null, remote = false): Country | undefined {
  const found = countriesIn(location);
  for (const c of ['IE', 'GB-NIR', 'GB'] as const) if (found.has(c)) return c;
  const s = cleanInline(location);
  const remoteish = remote || REMOTE_WORDS_RE.test(s) || EUROPE_RE.test(s);
  if (found.has('OTHER')) return EUROPE_RE.test(s) && !/\b(americas|apac|latam)\b/i.test(s) && remoteish ? 'REMOTE' : 'OTHER';
  if (remoteish) return 'REMOTE';
  return undefined;
}

/** Remote detection from location/title, plus strong phrases in the description. Hybrid is not remote. */
export function detectRemote(location?: string, title?: string, description?: string): boolean {
  const head = `${location ?? ''} ${title ?? ''}`;
  if (/\b(fully remote|100% remote|remote[- ]first|remote)\b/i.test(head) && !/\bnot remote\b/i.test(head)) {
    // "Hybrid/Remote" counts; "Hybrid" alone does not.
    return true;
  }
  if (/\b(work from home|wfh|home[- ]based|anywhere)\b/i.test(head)) return true;
  if (description && /\b(fully remote|100% remote|remote[- ]first company|this (role|position) is remote|work from anywhere)\b/i.test(description.slice(0, 20_000))) return true;
  return false;
}

/** Discovery pre-filter: keep Ireland / UK (incl. NI) / remote-compatible postings, and unknowns. */
export function locationAllowed(location: string | undefined | null, remote = false): boolean {
  const c = detectCountry(location, remote);
  return c !== 'OTHER';
}

/**
 * Titles that are never Kayzee's target even when a titleMustMatch fragment hits by accident
 * ("iOS Engineer - Creative App", "Talent Community", "Partnerships Counsel"). Kept deliberately narrow.
 */
const NON_TARGET_TITLE = new RegExp(
  String.raw`\b(` + [
    'engineers?', 'engineering manager', 'developers?', 'programmer', 'devops', 'sre', 'data scientist', 'machine learning',
    'ml researcher', 'research scientist', 'scientist', 'architect', 'accountant', 'counsel', 'solicitor', 'paralegal', 'attorney',
    'nurse', 'pharmacist', 'technician', 'mechanic', 'electrician', 'driver', 'chef', 'warehouse operative',
    'talent (community|pool|network)', 'general application', 'speculative application', 'expression of interest',
  ].join('|') + String.raw`)\b`,
  'i',
);

export function titleExcluded(title: string): boolean {
  return NON_TARGET_TITLE.test(cleanInline(title));
}

/** Discovery pre-filter: title contains one of the configured fragments (case-insensitive). Empty list = all. */
export function titleMatches(title: string, patterns: readonly string[]): boolean {
  if (!patterns.length) return true;
  const t = ` ${cleanInline(title).toLowerCase()} `;
  return patterns.some((p) => {
    const needle = p.toLowerCase();
    return needle.length > 0 && t.includes(needle);
  });
}

// ───────────────────────────── URLs + ATS ─────────────────────────────

const TRACKING_PARAMS = /^(utm_[a-z]+|trk|trkinfo|trackingid|refid|position|pagenum|lipi|midtoken|midsig|eid|otptoken|ssid|from|qd|rd|tk|alid|ad|sjdu|acatk|pub|vjs|fccid|src|source|ref|referrer|gh_src|lever-source|lever-origin|mc_cid|mc_eid|_hsenc|_hsmi|hsctatracking|fbclid|gclid|msclkid|dclid|igshid|cmp|campaign|ccid|xid|ss|s|t|cid|sid|emc|eml|bid|rid|urlhash|jobid_from|recommendedflavor|alertid)$/i;
const KEEP_PARAMS = /^(gh_jid|jk|jl|joblistingid|id|jobid|job|token|for|vjk|oga)$/i;

/** Removes tracking query params (utm_*, trk, refId, trackingId…) and fragments; keeps ids like gh_jid/jk/jl. */
export function canonicalUrl(raw: string | undefined | null): string {
  const input = cleanInline(raw);
  if (!input) return '';
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return input;
  u.hash = '';
  for (const name of [...u.searchParams.keys()]) {
    if (KEEP_PARAMS.test(name)) continue;
    if (TRACKING_PARAMS.test(name)) u.searchParams.delete(name);
  }
  u.protocol = 'https:';
  return u.toString().replace(/\?$/, '');
}

/** Identifies the ATS (or job board) behind a URL. */
export function detectAts(url: string | undefined | null): AtsKind {
  const raw = cleanInline(url);
  if (!raw) return 'unknown';
  if (/^mailto:/i.test(raw)) return 'email';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'unknown';
  }
  const host = u.hostname.toLowerCase();
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is('greenhouse.io') || u.searchParams.has('gh_jid')) return 'greenhouse';
  if (is('lever.co')) return 'lever';
  if (is('ashbyhq.com')) return 'ashby';
  if (is('smartrecruiters.com')) return 'smartrecruiters';
  if (is('workable.com')) return 'workable';
  if (is('myworkdayjobs.com') || is('myworkdaysite.com') || is('workday.com')) return 'workday';
  if (is('linkedin.com')) return 'linkedin';
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) return 'indeed';
  return 'unknown';
}

// ───────────────────────────── Identity ─────────────────────────────

/** Lowercase, accent-free, punctuation-free key. */
export function normalizeKey(text: string | undefined | null): string {
  return cleanInline(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const COMPANY_SUFFIX = /\b(ltd|limited|inc|incorporated|plc|llc|llp|gmbh|ag|sa|bv|dac|uc|co|corp|corporation|company|group|holdings|ireland|uk|europe|emea|international)\b/g;

/** Company key: drops legal suffixes, regional suffixes and parentheticals ("Intercom (Fin)" → "intercom"). */
export function normalizeCompany(company: string | undefined | null): string {
  const base = cleanInline(company).replace(/\([^)]*\)/g, ' ');
  const key = normalizeKey(base).replace(COMPANY_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return key || normalizeKey(company);
}

const CITY_KEYS = [
  'dublin', 'dundalk', 'drogheda', 'cork', 'galway', 'limerick', 'waterford', 'belfast', 'newry', 'derry', 'lisburn', 'armagh',
  'london', 'manchester', 'edinburgh', 'glasgow', 'birmingham', 'bristol', 'leeds', 'cardiff', 'swords', 'navan', 'naas',
  'athlone', 'sligo', 'kilkenny', 'wexford', 'letterkenny', 'ennis', 'tralee', 'maynooth', 'bray',
];

/**
 * Location key used in job ids: the first known city, else the country, else "remote", else the normalised
 * string. "Dublin, County Dublin, Ireland" and "Ireland - Dublin Hub (Hybrid)" both become "dublin", so the
 * same posting seen on LinkedIn and on the ATS collapses into one row.
 */
export function normalizeLocationKey(location: string | undefined | null): string {
  const key = normalizeKey(location);
  if (!key) return '';
  const words = ` ${key} `;
  let best: { city: string; at: number } | undefined;
  for (const city of CITY_KEYS) {
    const at = words.indexOf(` ${city} `);
    if (at >= 0 && (!best || at < best.at)) best = { city, at };
  }
  if (best) return best.city;
  const country = detectCountry(location);
  if (country === 'IE') return 'ireland';
  if (country === 'GB-NIR') return 'northern ireland';
  if (country === 'GB') return 'united kingdom';
  if (country === 'REMOTE') return 'remote';
  return key;
}

/** SPEC §3: sha1(normalize(company)|normalize(title)|normalize(location)), first 16 hex chars. */
export function jobId(company: string, title: string, location: string): string {
  const material = `${normalizeCompany(company)}|${normalizeKey(title)}|${normalizeLocationKey(location)}`;
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

// ───────────────────────────── Job ─────────────────────────────

function cleanEmploymentType(value: string | undefined): string | undefined {
  const v = cleanInline(value);
  if (!v) return undefined;
  const k = v.toLowerCase().replace(/[\s_-]+/g, '');
  const map: Record<string, string> = {
    fulltime: 'full-time', parttime: 'part-time', contract: 'contract', contractor: 'contract', temporary: 'temporary',
    temp: 'temporary', intern: 'internship', internship: 'internship', permanent: 'full-time', fixedterm: 'fixed-term',
    fixedtermcontract: 'fixed-term', graduate: 'graduate', volunteer: 'volunteer', apprenticeship: 'apprenticeship',
  };
  return map[k] ?? v;
}

function pickAts(url: string, applyUrl: string, source: RawJob['source']): AtsKind {
  const fromApply = detectAts(applyUrl);
  if (fromApply !== 'unknown') return fromApply;
  const fromUrl = detectAts(url);
  if (fromUrl !== 'unknown') return fromUrl;
  const bySource: Partial<Record<RawJob['source'], AtsKind>> = {
    greenhouse: 'greenhouse', lever: 'lever', ashby: 'ashby', smartrecruiters: 'smartrecruiters', workable: 'workable', linkedin_guest: 'linkedin',
  };
  return bySource[source] ?? 'unknown';
}

/** RawJob → NewJob (clean text, location, remote, salary, ATS, stable id). Never throws on odd input. */
export function normalizeJob(raw: RawJob): NewJob {
  const company = cleanInline(raw.company);
  const title = cleanInline(raw.title);
  const location = cleanInline(raw.location);
  const descriptionText = raw.descriptionText?.trim() ? tidyText(decodeEntities(raw.descriptionText)) : '';
  let description = descriptionText || htmlToText(raw.descriptionHtml);
  if (description.length > MAX_DESCRIPTION_CHARS) description = `${description.slice(0, MAX_DESCRIPTION_CHARS)}…`;

  const remote = raw.remote ?? detectRemote(location, title, description);
  const url = canonicalUrl(raw.url);
  const applyUrl = raw.applyUrl?.trim() ? canonicalUrl(raw.applyUrl) : url;
  const salary = parseSalary(raw.salaryText) ?? findSalaryInText(description);
  const country = detectCountry(location, remote);

  const job: NewJob = {
    id: jobId(company, title, location),
    source: raw.source,
    sourceId: String(raw.sourceId),
    company,
    title,
    location,
    remote,
    url,
    applyUrl,
    ats: pickAts(url, applyUrl, raw.source),
    atsMeta: raw.atsMeta ?? {},
    description,
  };
  if (country) job.country = country;
  if (salary) job.salary = salary;
  const employmentType = cleanEmploymentType(raw.employmentType);
  if (employmentType) job.employmentType = employmentType;
  const department = cleanInline(raw.department);
  if (department) job.department = department;
  const postedAt = toIso(raw.postedAt);
  if (postedAt) job.postedAt = postedAt;
  return job;
}
