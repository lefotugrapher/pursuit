// Adzuna search API (only when ADZUNA_APP_ID + ADZUNA_APP_KEY are set and sources.adzuna.enabled).
// Country 'ie' for the Republic, 'gb' for Northern Ireland queries. Predicted salaries are ignored:
// they are Adzuna's estimate, not the employer's figure.

import { env, hasAdzuna } from '@/lib/env';
import type { RawJob, SourceAdapter, SourceContext } from '@/lib/types';
import { isoFrom, passesPrefilter, str } from './common';
import { errorMessage } from './http';

interface AdzunaResult {
  id?: string | number;
  title?: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  contract_time?: string;
  contract_type?: string;
  category?: { label?: string };
}
interface AdzunaResponse { results?: AdzunaResult[]; count?: number }

const RESULTS_PER_PAGE = 50;
const MAX_DAYS_OLD = 14;
const CURRENCY: Record<string, string> = { ie: 'EUR', gb: 'GBP' };
const SYMBOL: Record<string, string> = { ie: '€', gb: '£' };

export function searchUrl(country: string, what: string, where: string, page = 1): string {
  const params = new URLSearchParams({
    app_id: env.ADZUNA_APP_ID ?? '',
    app_key: env.ADZUNA_APP_KEY ?? '',
    results_per_page: String(RESULTS_PER_PAGE),
    what,
    where,
    max_days_old: String(MAX_DAYS_OLD),
    'content-type': 'application/json',
  });
  return `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${page}?${params.toString()}`;
}

function locationOf(r: AdzunaResult, country: string): string {
  const display = str(r.location?.display_name) ?? '';
  const area = r.location?.area ?? [];
  const nation = country === 'ie' ? 'Ireland' : area.includes('Northern Ireland') ? 'Northern Ireland' : 'UK';
  return display.toLowerCase().includes(nation.toLowerCase()) ? display : [display, nation].filter(Boolean).join(', ');
}

function salaryText(r: AdzunaResult, country: string): string | undefined {
  const predicted = String(r.salary_is_predicted ?? '0') === '1';
  if (predicted || !(r.salary_min || r.salary_max)) return undefined;
  const sym = SYMBOL[country] ?? '';
  const parts = [r.salary_min, r.salary_max].filter((v): v is number => typeof v === 'number' && v > 0).map((v) => `${sym}${Math.round(v)}`);
  return `${[...new Set(parts)].join(' - ')} per year`;
}

export function mapAdzunaResult(r: AdzunaResult, country: string): RawJob | null {
  const title = str(r.title);
  const company = str(r.company?.display_name);
  const url = str(r.redirect_url);
  if (!title || !company || !url || r.id === undefined) return null;
  return {
    source: 'adzuna',
    sourceId: String(r.id),
    company,
    title,
    location: locationOf(r, country),
    url,
    descriptionText: str(r.description),
    postedAt: isoFrom(r.created),
    salaryText: salaryText(r, country),
    employmentType: [r.contract_time, r.contract_type].filter(Boolean).join(', ') || undefined,
    department: str(r.category?.label),
    atsMeta: { adzunaId: String(r.id), country, currency: CURRENCY[country], descriptionIsSnippet: true },
  };
}

export const adzuna: SourceAdapter = {
  id: 'adzuna',
  label: 'Adzuna',
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const cfg = ctx.sources.adzuna;
    if (!cfg.enabled) return [];
    if (!hasAdzuna()) {
      ctx.log.info('adzuna: enabled in sources.json but ADZUNA_APP_ID / ADZUNA_APP_KEY are not set; skipping');
      return [];
    }
    const out: RawJob[] = [];
    const seen = new Set<string>();
    let failures = 0;
    for (const q of cfg.queries) {
      try {
        const data = await ctx.http.json<AdzunaResponse>(searchUrl(q.country, q.what, q.where));
        for (const r of data.results ?? []) {
          const raw = mapAdzunaResult(r, q.country);
          if (!raw || seen.has(raw.sourceId)) continue;
          seen.add(raw.sourceId);
          if (passesPrefilter(ctx, raw.title, raw.location)) out.push(raw);
        }
      } catch (err) {
        failures++;
        ctx.log.warn(`adzuna: query "${q.what}" in ${q.where} (${q.country}) failed`, { error: errorMessage(err) });
      }
    }
    if (cfg.queries.length > 0 && failures === cfg.queries.length) throw new Error(`all ${failures} Adzuna queries failed`);
    return out;
  },
};
