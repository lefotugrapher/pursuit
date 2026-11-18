// Workable: https://apply.workable.com/api/v1/widget/accounts/{name}?details=true
// Workable sits behind Cloudflare and rate-limits hard (HTTP 429 with a day-long Retry-After); our Http
// parks the host on such a 429 so the rest of the run does not hammer it.

import type { RawJob, SourceAdapter, SourceContext, WatchCompany } from '@/lib/types';
import { eachCompany, isoFrom, joinLocations, passesPrefilter, str } from './common';

interface WorkableLocation { country?: string; countryCode?: string; city?: string; region?: string; hidden?: boolean }
interface WorkableJob {
  title?: string;
  shortcode?: string;
  code?: string;
  employment_type?: string;
  telecommuting?: boolean;
  department?: string;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string;
  city?: string;
  state?: string;
  locations?: WorkableLocation[];
  description?: string;
  experience?: string;
  function?: string;
}
interface WorkableResponse { name?: string; jobs?: WorkableJob[] }

function locationOf(job: WorkableJob): string {
  const visible = (job.locations ?? []).filter((l) => !l.hidden);
  if (visible.length) return joinLocations(visible.map((l) => joinLocations([l.city, l.region, l.country], ', ')));
  return joinLocations([job.city, job.state, job.country], ', ');
}

export function mapWorkableJob(job: WorkableJob, company: WatchCompany, accountName?: string): RawJob | null {
  const title = str(job.title);
  const url = str(job.url) ?? str(job.shortlink) ?? (job.shortcode ? `https://apply.workable.com/j/${job.shortcode}` : undefined);
  if (!title || !url || !job.shortcode) return null;
  return {
    source: 'workable',
    sourceId: job.shortcode,
    company: str(accountName) ?? company.name,
    title,
    location: locationOf(job),
    url,
    applyUrl: str(job.application_url) ?? `${url.replace(/\/$/, '')}/apply`,
    descriptionHtml: job.description,
    postedAt: isoFrom(job.published_on) ?? isoFrom(job.created_at),
    employmentType: str(job.employment_type),
    department: str(job.department) ?? str(job.function),
    remote: job.telecommuting === true ? true : undefined,
    atsMeta: { ats: 'workable', account: company.token, shortcode: job.shortcode, experience: job.experience, watchName: company.name },
  };
}

export async function fetchWorkableAccount(ctx: SourceContext, company: WatchCompany): Promise<RawJob[]> {
  const data = await ctx.http.json<WorkableResponse>(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(company.token)}?details=true`,
  );
  const out: RawJob[] = [];
  for (const job of data.jobs ?? []) {
    const raw = mapWorkableJob(job, company, data.name);
    if (raw && passesPrefilter(ctx, raw.title, raw.location, raw.remote)) out.push(raw);
  }
  return out;
}

export const workable: SourceAdapter = {
  id: 'workable',
  label: 'Workable',
  fetch: (ctx) => eachCompany(ctx, 'workable', (company) => fetchWorkableAccount(ctx, company)),
};
