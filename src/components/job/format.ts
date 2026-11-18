// Display formatting for jobs. Pure (server + client safe).

import type { AtsKind, Job, Salary, SourceId } from '@/lib/types';

const SOURCE_LABEL: Record<SourceId, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable',
  linkedin_guest: 'LinkedIn', adzuna: 'Adzuna', gmail_alert: 'Email alert', manual: 'Manual', board_search: 'Board search',
};

const ATS_LABEL: Record<AtsKind, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable',
  workday: 'Workday', linkedin: 'LinkedIn', indeed: 'Indeed', email: 'Email', unknown: 'Unknown ATS',
};

export const sourceLabel = (s: SourceId | string): string => SOURCE_LABEL[s as SourceId] ?? s;
export const atsLabel = (a: AtsKind | string): string => ATS_LABEL[a as AtsKind] ?? a;

/** ATSs the runner can fill and submit itself; everything else is a manual handoff. */
export const AUTOMATABLE_ATS: AtsKind[] = ['greenhouse', 'lever', 'ashby'];

const SYMBOL: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };

function compact(n: number, symbol: string): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${symbol}${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `${symbol}${Math.round(n)}`;
}

/** "€36k–42k", "£28k+", "up to €40k"; falls back to the raw text; undefined when unknown. */
export function formatSalary(s: Salary | undefined): string | undefined {
  if (!s) return undefined;
  const symbol = SYMBOL[String(s.currency ?? '').toUpperCase()] ?? (s.currency ? `${s.currency} ` : '');
  const min = typeof s.min === 'number' && s.min > 0 ? s.min : undefined;
  const max = typeof s.max === 'number' && s.max > 0 ? s.max : undefined;
  if (min && max && min !== max) return `${compact(min, symbol)}–${compact(max, symbol).replace(symbol, '')}`;
  if (min ?? max) {
    const v = (min ?? max) as number;
    return min && !max ? `${compact(v, symbol)}+` : max && !min ? `up to ${compact(v, symbol)}` : compact(v, symbol);
  }
  return s.raw?.trim() || undefined;
}

export function locationLabel(job: Pick<Job, 'location' | 'remote'>): string {
  const loc = job.location?.trim();
  if (loc && job.remote && !/remote/i.test(loc)) return `${loc} · remote`;
  return loc || (job.remote ? 'Remote' : 'Location not stated');
}

/** The URL Kayzee should open to see the posting. Only http(s) links are ever rendered. */
export function postingUrl(job: Pick<Job, 'url' | 'applyUrl'>): string | undefined {
  for (const candidate of [job.url, job.applyUrl]) {
    try {
      const u = new URL(candidate);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
    } catch {
      // try the next one
    }
  }
  return undefined;
}

const COMPONENT_LABEL: Record<string, string> = {
  skills: 'Skills', roleFit: 'Role fit', seniority: 'Seniority', location: 'Location', freshness: 'Freshness', salary: 'Salary',
};
export const COMPONENT_WEIGHT: Record<string, number> = { skills: 40, roleFit: 25, seniority: 15, location: 10, freshness: 5, salary: 5 };
export const componentLabel = (k: string): string => COMPONENT_LABEL[k] ?? k;

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Only https linkedin.com links are rendered as "Open LinkedIn" (contact data comes from scraped pages). */
export function safeLinkedInUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (host === 'linkedin.com' || host.endsWith('.linkedin.com')) ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
