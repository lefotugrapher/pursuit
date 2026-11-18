// Known sponsors: employers that were issued Irish employment permits, from the Department of Enterprise's
// "Permits issued to companies" spreadsheet (config/sponsors.json, built 2026-11-16 from the 2025 file).
// An employer that sponsored before is far more likely to sponsor Kayzee, so these jobs rank higher.
// Matching is deliberately cautious: a wrong match would push a non-sponsor up his queue.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '@/lib/paths';

interface SponsorFile { year: number; list: { key: string; name: string; permits: number }[] }
export interface SponsorRecord { names: string[]; permits: number; year: number }

let cache: { year: number; entries: { core: string[]; name: string; permits: number }[] } | null | undefined;

const SUFFIX = /\b(limited|ltd|dac|plc|unlimited company|unlimited|uc|clg|teoranta|teo|cuideachta|designated activity company|company limited by guarantee|t\/a|ta|inc|llc|gmbh)\b/g;
/** Words that don't identify an employer on their own. */
const NOISE = new Set([
  'the', 'and', 'of', 'ireland', 'irish', 'uk', 'eu', 'group', 'holdings', 'international', 'europe', 'european', 'emea', 'global',
  'services', 'solutions', 'company', 'co', 'recruitment', 'recruiters', 'recruiting', 'consulting', 'consultancy', 'consultants',
  'digital', 'media', 'marketing', 'agency', 'partners', 'people', 'talent', 'search', 'personnel', 'staffing', 'resources',
]);

/** Distinctive name tokens: lowercase, legal suffixes, brackets, taglines and noise words removed. */
export function coreTokens(name: string): string[] {
  const s = String(name ?? '')
    .split(/\s+[-–—|]\s+/)[0]
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return s.split(/\s+/).filter((t) => t && !NOISE.has(t));
}

/** All name tokens (suffixes and taglines removed, noise words kept). */
function rawTokens(name: string): string[] {
  return String(name ?? '').split(/\s+[-–—|]\s+/)[0].toLowerCase().replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ')
    .replace(SUFFIX, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function load(): typeof cache {
  if (cache !== undefined) return cache;
  try {
    const file = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'sponsors.json'), 'utf8')) as SponsorFile;
    cache = { year: file.year, entries: file.list.map((e) => ({ core: coreTokens(e.name), name: e.name, permits: e.permits })).filter((e) => e.core.length) };
  } catch {
    cache = null;
  }
  return cache;
}

/** Test seam. */
export function setSponsorsForTests(list: { name: string; permits: number }[] | null, year = 2025): void {
  cache = list ? { year, entries: list.map((e) => ({ core: coreTokens(e.name), name: e.name, permits: e.permits })) } : undefined;
}

function startsWith(long: string[], short: string[]): boolean {
  return short.length <= long.length && short.every((t, i) => long[i] === t);
}

/**
 * The employer's permit record, or null. The job's distinctive name must be a whole-token prefix of the registered
 * name (or the reverse), and must be distinctive enough: one-token names need 4+ characters ("Ryanair", "KPMG"),
 * single letters or digits never match on their own.
 */
export function sponsorRecord(company: string): SponsorRecord | null {
  const data = load();
  if (!data) return null;
  const core = coreTokens(company);
  if (!core.length) return null;
  if (core.length === 1 && core[0].length < 4) return null;
  let hits: typeof data.entries;
  if (core.length === 1) {
    // One distinctive word ("Ryanair", "Stripe"): prefer an exact registered name; otherwise accept only a few
    // same-brand entities ("Stripe Technology", "Stripe Payments"), never a crowd of unrelated "Summit ..." firms.
    const firsts = data.entries.filter((e) => e.core[0] === core[0]);
    const exact = firsts.filter((e) => e.core.length === 1);
    // "Summit Recruitment" lost a generic word to reach one token: then only an exact registered name may match,
    // or it would borrow "Summit Scaffolding"'s record.
    const strippedWords = coreTokens(company).length < rawTokens(company).length;
    hits = exact.length ? exact : !strippedWords && firsts.length <= 3 && core[0].length >= 5 ? firsts : [];
  } else {
    hits = data.entries.filter((e) => startsWith(e.core, core) || (e.core.length >= 2 && startsWith(core, e.core)));
  }
  if (!hits.length) return null;
  return { names: hits.map((h) => h.name).slice(0, 5), permits: hits.reduce((n, h) => n + h.permits, 0), year: data.year };
}

/** Score bonus for a known sponsor: bigger sponsors are likelier to do it again. */
export function sponsorBonus(rec: SponsorRecord | null): number {
  if (!rec) return 0;
  return rec.permits >= 20 ? 8 : rec.permits >= 3 ? 6 : 4;
}
