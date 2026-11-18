// Ashby job boards: https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true

import type { RawJob, SourceAdapter, SourceContext, WatchCompany } from '@/lib/types';
import { eachCompany, isoFrom, joinLocations, passesPrefilter, str } from './common';

interface AshbyComponent { compensationType?: string; interval?: string; currencyCode?: string | null; minValue?: number | null; maxValue?: number | null }
interface AshbyJob {
  id: string;
  title?: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  address?: { postalAddress?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string | null;
    scrapeableCompensationSalarySummary?: string | null;
    summaryComponents?: AshbyComponent[];
  } | null;
}
interface AshbyResponse { jobs?: AshbyJob[] }

const EMPLOYMENT: Record<string, string> = { FullTime: 'full-time', PartTime: 'part-time', Intern: 'internship', Contract: 'contract', Temporary: 'temporary' };
const INTERVAL: Record<string, string> = { '1 YEAR': 'per year', '1 MONTH': 'per month', '1 WEEK': 'per week', '1 DAY': 'per day', '1 HOUR': 'per hour' };

function salaryText(job: AshbyJob): string | undefined {
  const salary = job.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary' && (c.minValue || c.maxValue) && c.currencyCode);
  if (salary) {
    const range = [salary.minValue, salary.maxValue].filter((v): v is number => typeof v === 'number' && v > 0).join(' - ');
    return `${salary.currencyCode} ${range} ${INTERVAL[salary.interval ?? ''] ?? 'per year'}`;
  }
  return str(job.compensation?.scrapeableCompensationSalarySummary) ?? str(job.compensation?.compensationTierSummary);
}

function locationOf(job: AshbyJob): string {
  const country = job.address?.postalAddress?.addressCountry;
  const primary = job.location && country && !job.location.toLowerCase().includes(country.toLowerCase()) && job.location !== 'Remote'
    ? `${job.location}, ${country}`
    : job.location;
  return joinLocations([primary, ...(job.secondaryLocations ?? []).map((s) => s.location)]);
}

function isRemote(job: AshbyJob): boolean | undefined {
  if (job.workplaceType) return job.workplaceType === 'Remote';
  return typeof job.isRemote === 'boolean' ? job.isRemote : undefined;
}

export function mapAshbyJob(job: AshbyJob, company: WatchCompany): RawJob | null {
  const title = str(job.title);
  const url = str(job.jobUrl);
  if (!title || !url || !job.id || job.isListed === false) return null;
  return {
    source: 'ashby',
    sourceId: job.id,
    company: company.name,
    title,
    location: locationOf(job),
    url,
    applyUrl: str(job.applyUrl) ?? `${url.replace(/\/$/, '')}/application`,
    descriptionHtml: job.descriptionHtml,
    descriptionText: job.descriptionHtml ? undefined : job.descriptionPlain,
    postedAt: isoFrom(job.publishedAt),
    salaryText: salaryText(job),
    employmentType: job.employmentType ? EMPLOYMENT[job.employmentType] ?? job.employmentType : undefined,
    department: str(job.department) ?? str(job.team),
    remote: isRemote(job),
    atsMeta: { ats: 'ashby', jobBoardName: company.token, jobPostingId: job.id, workplaceType: job.workplaceType ?? undefined, watchName: company.name },
  };
}

export async function fetchAshbyBoard(ctx: SourceContext, company: WatchCompany): Promise<RawJob[]> {
  const data = await ctx.http.json<AshbyResponse>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.token)}?includeCompensation=true`,
  );
  const out: RawJob[] = [];
  for (const job of data.jobs ?? []) {
    const raw = mapAshbyJob(job, company);
    if (raw && passesPrefilter(ctx, raw.title, raw.location, raw.remote)) out.push(raw);
  }
  return out;
}

export const ashby: SourceAdapter = {
  id: 'ashby',
  label: 'Ashby boards',
  fetch: (ctx) => eachCompany(ctx, 'ashby', (company) => fetchAshbyBoard(ctx, company)),
};
