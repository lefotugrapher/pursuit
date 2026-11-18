// Greenhouse job boards: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true

import type { RawJob, SourceAdapter, SourceContext, WatchCompany } from '@/lib/types';
import { eachCompany, isoFrom, joinLocations, passesPrefilter, str } from './common';
import { decodeEntities, detectCountry } from './normalize';

interface GhJob {
  id: number;
  internal_job_id?: number;
  title?: string;
  absolute_url?: string;
  company_name?: string;
  location?: { name?: string } | null;
  offices?: { name?: string; location?: string | null }[];
  departments?: { name?: string }[];
  content?: string;
  updated_at?: string;
  first_published?: string;
  requisition_id?: string | null;
}
interface GhResponse { jobs?: GhJob[] }

const API = 'https://boards-api.greenhouse.io/v1/boards';

export function boardUrl(token: string): string {
  return `${API}/${encodeURIComponent(token)}/jobs?content=true`;
}

function locationOf(job: GhJob): string {
  const primary = job.location?.name ?? '';
  const country = detectCountry(primary);
  // Offices only add information when the primary label is vague ("Hybrid", "Remote", "Multiple").
  if (country && country !== 'REMOTE') return joinLocations([primary]);
  return joinLocations([primary, ...(job.offices ?? []).map((o) => o.location || o.name)]);
}

export function mapGreenhouseJob(job: GhJob, company: WatchCompany): RawJob | null {
  const title = str(job.title);
  const url = str(job.absolute_url);
  if (!title || !url || job.id === undefined) return null;
  const hostedUrl = `https://job-boards.greenhouse.io/${encodeURIComponent(company.token)}/jobs/${job.id}`;
  return {
    source: 'greenhouse',
    sourceId: String(job.id),
    company: str(job.company_name) ?? company.name,
    title,
    location: locationOf(job),
    url,
    applyUrl: url,
    descriptionHtml: job.content ? decodeEntities(job.content) : undefined, // the API entity-escapes the HTML
    postedAt: isoFrom(job.first_published) ?? isoFrom(job.updated_at),
    department: str(job.departments?.[0]?.name),
    atsMeta: {
      ats: 'greenhouse',
      boardToken: company.token,
      jobId: job.id,
      internalJobId: job.internal_job_id,
      requisitionId: job.requisition_id ?? undefined,
      hostedUrl,
      watchName: company.name,
    },
  };
}

export async function fetchGreenhouseBoard(ctx: SourceContext, company: WatchCompany): Promise<RawJob[]> {
  const data = await ctx.http.json<GhResponse>(boardUrl(company.token));
  const out: RawJob[] = [];
  for (const job of data.jobs ?? []) {
    const raw = mapGreenhouseJob(job, company);
    if (raw && passesPrefilter(ctx, raw.title, raw.location)) out.push(raw);
  }
  return out;
}

export const greenhouse: SourceAdapter = {
  id: 'greenhouse',
  label: 'Greenhouse boards',
  fetch: (ctx) => eachCompany(ctx, 'greenhouse', (company) => fetchGreenhouseBoard(ctx, company)),
};
