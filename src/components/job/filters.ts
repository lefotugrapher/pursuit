// /jobs list filters: parse searchParams ⇄ JobQuery, build hrefs. Pure (server + client safe).

import { JOB_STATUSES, type JobQuery, type JobStatus, type SourceId } from '@/lib/types';

export const SOURCES: SourceId[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'linkedin_guest', 'adzuna', 'gmail_alert', 'manual'];
export const SORTS = ['updatedAt', 'score', 'postedAt', 'discoveredAt'] as const;
export type JobsSort = (typeof SORTS)[number];
export const PAGE_SIZE = 50;

export interface JobsFilter {
  statuses: JobStatus[];
  source?: SourceId;
  minScore?: number;
  q?: string;
  sort: JobsSort;
  dir: 'asc' | 'desc';
  page: number;
}

export type SearchParams = Record<string, string | string[] | undefined>;

const list = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
const first = (v: string | string[] | undefined): string | undefined => list(v)[0];

export function parseJobsFilter(sp: SearchParams): JobsFilter {
  const statuses = [...new Set(list(sp.status))].filter((s): s is JobStatus => (JOB_STATUSES as string[]).includes(s));
  const source = first(sp.source);
  const min = Number(first(sp.min));
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim().slice(0, 120);
  const sort = first(sp.sort);
  const page = Math.trunc(Number(first(sp.page)));
  return {
    statuses,
    source: SOURCES.includes(source as SourceId) ? (source as SourceId) : undefined,
    minScore: Number.isFinite(min) && min > 0 ? Math.min(100, Math.round(min)) : undefined,
    q: q || undefined,
    sort: (SORTS as readonly string[]).includes(sort ?? '') ? (sort as JobsSort) : 'updatedAt',
    dir: first(sp.dir) === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

export function toJobQuery(f: JobsFilter): JobQuery {
  return {
    status: f.statuses.length ? f.statuses : undefined,
    source: f.source,
    minScore: f.minScore,
    search: f.q,
    orderBy: f.sort,
    dir: f.dir,
    limit: PAGE_SIZE,
    offset: (f.page - 1) * PAGE_SIZE,
  };
}

/** /jobs URL for `f` with `patch` applied (page resets unless patched). */
export function jobsHref(f: JobsFilter, patch: Partial<JobsFilter> = {}): string {
  const next: JobsFilter = { ...f, page: 1, ...patch };
  const params = new URLSearchParams();
  for (const s of next.statuses) params.append('status', s);
  if (next.source) params.set('source', next.source);
  if (next.minScore) params.set('min', String(next.minScore));
  if (next.q) params.set('q', next.q);
  if (next.sort !== 'updatedAt') params.set('sort', next.sort);
  if (next.dir !== 'desc') params.set('dir', next.dir);
  if (next.page > 1) params.set('page', String(next.page));
  const qs = params.toString();
  return qs ? `/jobs?${qs}` : '/jobs';
}

export function isFiltered(f: JobsFilter): boolean {
  return Boolean(f.statuses.length || f.source || f.minScore || f.q);
}
