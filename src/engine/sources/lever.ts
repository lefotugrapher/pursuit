// Lever postings: https://api.lever.co/v0/postings/{company}?mode=json (EU accounts live on api.eu.lever.co).

import type { RawJob, SourceAdapter, SourceContext, WatchCompany } from '@/lib/types';
import { eachCompany, isoFrom, joinLocations, passesPrefilter, str } from './common';
import { errorStatus } from './http';

interface LeverList { text?: string; content?: string }
interface LeverPosting {
  id: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: { location?: string; allLocations?: string[]; commitment?: string; department?: string; team?: string };
  description?: string;
  descriptionPlain?: string;
  lists?: LeverList[];
  additional?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string } | null;
  salaryDescription?: string;
  salaryDescriptionPlain?: string;
}

const HOSTS = ['https://api.lever.co', 'https://api.eu.lever.co'];
const COUNTRY_NAMES: Record<string, string> = { IE: 'Ireland', GB: 'United Kingdom', US: 'United States' };

const INTERVAL_TEXT: Record<string, string> = {
  'per-year-salary': 'per year', 'per-month-salary': 'per month', 'per-week-salary': 'per week',
  'per-day-wage': 'per day', 'per-hour-wage': 'per hour',
};

function salaryText(p: LeverPosting): string | undefined {
  const r = p.salaryRange;
  if (r && (r.min || r.max) && r.currency) {
    const range = [r.min, r.max].filter((v): v is number => typeof v === 'number' && v > 0).join(' - ');
    return `${r.currency} ${range} ${INTERVAL_TEXT[r.interval ?? ''] ?? 'per year'}`;
  }
  return str(p.salaryDescriptionPlain);
}

function descriptionHtml(p: LeverPosting): string {
  const parts = [p.description ?? ''];
  for (const list of p.lists ?? []) {
    parts.push(`<h3>${list.text ?? ''}</h3><ul>${list.content ?? ''}</ul>`);
  }
  if (p.additional) parts.push(p.additional);
  return parts.join('\n');
}

function locationOf(p: LeverPosting): string {
  const locs = p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location];
  const joined = joinLocations(locs);
  const country = p.country ? COUNTRY_NAMES[p.country.toUpperCase()] ?? p.country : undefined;
  if (!country || joined.toLowerCase().includes(country.toLowerCase())) return joined;
  return joined ? `${joined}, ${country}` : country;
}

export function mapLeverPosting(p: LeverPosting, company: WatchCompany, apiHost = HOSTS[0]): RawJob | null {
  const title = str(p.text);
  if (!title || !p.id || !p.hostedUrl) return null;
  const workplace = (p.workplaceType ?? '').toLowerCase();
  return {
    source: 'lever',
    sourceId: p.id,
    company: company.name,
    title,
    location: locationOf(p),
    url: p.hostedUrl,
    applyUrl: str(p.applyUrl) ?? `${p.hostedUrl.replace(/\/$/, '')}/apply`,
    descriptionHtml: descriptionHtml(p),
    postedAt: isoFrom(p.createdAt),
    salaryText: salaryText(p),
    employmentType: str(p.categories?.commitment),
    department: str(p.categories?.department) ?? str(p.categories?.team),
    remote: workplace === 'remote' ? true : workplace === 'onsite' || workplace === 'hybrid' ? false : undefined,
    atsMeta: { ats: 'lever', company: company.token, postingId: p.id, apiHost, workplaceType: p.workplaceType, watchName: company.name },
  };
}

export async function fetchLeverCompany(ctx: SourceContext, company: WatchCompany): Promise<RawJob[]> {
  let postings: LeverPosting[] | undefined;
  let host = HOSTS[0];
  for (const candidate of HOSTS) {
    try {
      postings = await ctx.http.json<LeverPosting[]>(`${candidate}/v0/postings/${encodeURIComponent(company.token)}?mode=json`);
      host = candidate;
      break;
    } catch (err) {
      // 404 on the global API usually means the account is hosted in the EU region.
      if (errorStatus(err) !== 404 || candidate === HOSTS[HOSTS.length - 1]) throw err;
    }
  }
  if (!Array.isArray(postings)) return [];
  const out: RawJob[] = [];
  for (const p of postings) {
    const raw = mapLeverPosting(p, company, host);
    if (raw && passesPrefilter(ctx, raw.title, raw.location, raw.remote)) out.push(raw);
  }
  return out;
}

export const lever: SourceAdapter = {
  id: 'lever',
  label: 'Lever boards',
  fetch: (ctx) => eachCompany(ctx, 'lever', (company) => fetchLeverCompany(ctx, company)),
};
