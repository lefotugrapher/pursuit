// Board search: the public job searches of Workable (jobs.workable.com) and SmartRecruiters
// (jobs.smartrecruiters.com/sr-jobs/search). Unlike LinkedIn/Indeed alerts, every result already sits on an ATS
// Pursuit can fill and submit, so hands-free can apply without first hunting for the employer's page.
//
// Checked Nov 2026:
// - Workable: GET jobs.workable.com/api/v1/jobs?query=&location=Ireland (20 per page, `nextPageToken` →
//   `&pageToken=`). Results have no apply.workable.com shortcode; the posting page jobs.workable.com/view/{id}
//   opens the same Workable form (form[data-ui=application-form]) in a dialog via [data-ui=overview-apply-now].
//   A non-null `linkoutUrl` means the employer applies elsewhere; that URL becomes the apply URL.
// - SmartRecruiters: GET jobs.smartrecruiters.com/sr-jobs/search?keyword=&limit=100. Location parameters and
//   offset are ignored, so "ireland" goes into the keyword and results are filtered to country "ie". Ids are
//   the same posting ids the per-company adapter stores, so the two dedupe naturally.

import type { RawJob, SourceAdapter, SourceContext, WatchCompany } from '@/lib/types';
import { type AdapterContext, isoFrom, joinLocations, passesPrefilter, str } from './common';
import { errorMessage } from './http';
import { mapSmartRecruitersPosting } from './smartrecruiters';

const WORKABLE_MAX_PAGES = 5;
const SR_MAX_DETAILS = 40;
const MAX_QUERIES = 12;

// ───────────────────────────── Queries ─────────────────────────────

/** Search terms: sources.boardSearch.queries, else the LinkedIn keywords (deduped), capped. */
export function boardQueries(ctx: SourceContext): string[] {
  const own = ctx.sources.boardSearch?.queries ?? [];
  const base = own.length ? own : ctx.sources.linkedinGuest.queries.map((q) => q.keywords);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of base) {
    const k = q.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.slice(0, MAX_QUERIES);
}

// ───────────────────────────── Workable ─────────────────────────────

interface WkLocation { city?: string | null; subregion?: string | null; countryName?: string | null }
export interface WkSearchJob {
  id?: string;
  title?: string;
  state?: string;
  description?: string;
  requirementsSection?: string;
  benefitsSection?: string;
  employmentType?: string;
  department?: string;
  url?: string;
  locations?: string[];
  location?: WkLocation;
  created?: string;
  company?: { id?: string; title?: string; website?: string; url?: string };
  workplace?: string;
  linkoutUrl?: string | null;
}
interface WkSearchPage { jobs?: WkSearchJob[]; nextPageToken?: string | null }

export function mapWorkableSearchJob(job: WkSearchJob): RawJob | null {
  const title = str(job.title);
  const url = str(job.url);
  const company = str(job.company?.title);
  if (!title || !url || !company || !job.id || (job.state && job.state !== 'published')) return null;
  const linkout = str(job.linkoutUrl ?? undefined);
  const remote = job.workplace === 'remote' || (job.locations ?? []).includes('TELECOMMUTE');
  const descriptionHtml = [job.description, job.requirementsSection, job.benefitsSection].filter((s) => s?.trim()).join('\n');
  return {
    source: 'workable',
    sourceId: job.id,
    company,
    title,
    location: joinLocations([job.location?.city, job.location?.subregion, job.location?.countryName], ', '),
    url,
    applyUrl: linkout ?? url,
    descriptionHtml: descriptionHtml || undefined,
    postedAt: isoFrom(job.created),
    employmentType: str(job.employmentType),
    department: str(job.department),
    remote: remote ? true : undefined,
    atsMeta: {
      ...(linkout ? {} : { ats: 'workable' }),
      via: 'workable_search',
      workableJobId: job.id,
      workableCompanyId: job.company?.id,
      companyWebsite: job.company?.website,
      ...(linkout ? { linkoutUrl: linkout } : {}),
    },
  };
}

export async function searchWorkable(ctx: SourceContext, query: string, location = 'Ireland'): Promise<RawJob[]> {
  const out: RawJob[] = [];
  let token: string | undefined;
  for (let page = 0; page < WORKABLE_MAX_PAGES; page++) {
    const qs = `query=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const data = await ctx.http.json<WkSearchPage>(`https://jobs.workable.com/api/v1/jobs?${qs}`);
    for (const job of data.jobs ?? []) {
      if (job.location?.countryName && job.location.countryName !== location) continue;
      const raw = mapWorkableSearchJob(job);
      if (raw && passesPrefilter(ctx, raw.title, raw.location, raw.remote)) out.push(raw);
    }
    token = data.nextPageToken ?? undefined;
    if (!token || !(data.jobs ?? []).length) break;
  }
  return out;
}

// ───────────────────────────── SmartRecruiters ─────────────────────────────

interface SrSearchJob {
  id?: string;
  name?: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  company?: { identifier?: string; name?: string };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { id?: string; label?: string };
  department?: { label?: string };
  function?: { label?: string };
  actions?: { details?: string };
  applyUrl?: string;
}
interface SrSearchPage { content?: SrSearchJob[] }

export async function searchSmartRecruiters(ctx: SourceContext, query: string, details: { left: number }): Promise<RawJob[]> {
  const data = await ctx.http.json<SrSearchPage>(
    `https://jobs.smartrecruiters.com/sr-jobs/search?keyword=${encodeURIComponent(`${query} ireland`)}&limit=100`,
  );
  const known = (ctx as AdapterContext).haveDetail?.('smartrecruiters');
  const out: RawJob[] = [];
  for (const s of data.content ?? []) {
    if (!s.id || !s.name || s.location?.country !== 'ie' || !s.company?.identifier) continue;
    const location = joinLocations([s.location.city, s.location.region, 'Ireland'], ', ');
    if (!passesPrefilter(ctx, s.name, location, s.location.remote === true)) continue;
    const company: WatchCompany = { name: s.company.name ?? s.company.identifier, ats: 'smartrecruiters', token: s.company.identifier, enabled: true };
    let detail: Parameters<typeof mapSmartRecruitersPosting>[2];
    const detailUrl = str(s.actions?.details);
    if (detailUrl && /^https:\/\/api\.smartrecruiters\.com\//.test(detailUrl) && !known?.has(s.id) && details.left > 0) {
      details.left--;
      try {
        detail = await ctx.http.json(detailUrl);
      } catch (err) {
        ctx.log.warn(`board_search: SmartRecruiters detail failed for ${company.name} ${s.id}`, { error: errorMessage(err) });
      }
    }
    const raw = mapSmartRecruitersPosting({ ...s, id: s.id }, company, detail);
    if (!raw) continue;
    if (!detail && s.applyUrl && /^https:\/\/jobs\.smartrecruiters\.com\//.test(s.applyUrl)) {
      raw.url = s.applyUrl;
      raw.applyUrl = s.applyUrl;
    }
    raw.atsMeta = { ...raw.atsMeta, via: 'smartrecruiters_search' };
    out.push(raw);
  }
  return out;
}

// ───────────────────────────── Adapter ─────────────────────────────

export async function fetchBoardSearch(ctx: SourceContext): Promise<RawJob[]> {
  const queries = boardQueries(ctx);
  const byKey = new Map<string, RawJob>();
  const failures: string[] = [];
  let attempts = 0;
  const details = { left: SR_MAX_DETAILS };
  const run = async (label: string, fn: () => Promise<RawJob[]>) => {
    attempts++;
    try {
      for (const raw of await fn()) byKey.set(`${raw.source}:${raw.sourceId}`, raw);
    } catch (err) {
      failures.push(`${label}: ${errorMessage(err)}`);
      ctx.log.warn(`board_search: ${label} failed`, { error: errorMessage(err) });
    }
  };
  for (const q of queries) {
    await run(`Workable "${q}"`, () => searchWorkable(ctx, q));
    await run(`SmartRecruiters "${q}"`, () => searchSmartRecruiters(ctx, q, details));
  }
  if (attempts > 0 && failures.length === attempts) throw new Error(`every board search failed; first: ${failures[0]}`);
  return [...byKey.values()];
}

export const boardSearch: SourceAdapter = {
  id: 'board_search',
  label: 'Workable + SmartRecruiters search',
  fetch: fetchBoardSearch,
};
