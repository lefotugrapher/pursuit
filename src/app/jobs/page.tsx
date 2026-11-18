// /jobs: every job, filterable and sortable via searchParams, 50 per page. Server-rendered.

import type { Metadata } from 'next';
import Link from 'next/link';
import { Empty, StatusBadge, cx, timeAgo } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { JobsFilterBar } from '@/components/job/JobsFilterBar';
import { CompanyMark } from '@/components/job/JobHeader';
import { formatSalary, locationLabel, sourceLabel } from '@/components/job/format';
import { isFiltered, jobsHref, type JobsFilter, type JobsSort, type SearchParams } from '@/components/job/filters';
import { getJobsPage } from '@/lib/server';

export const metadata: Metadata = { title: 'Jobs' };

function scoreClass(score: number | undefined): string {
  if (score == null) return 'text-faint';
  return score >= 80 ? 'text-good' : score >= 60 ? 'text-accent' : score >= 45 ? 'text-warn' : 'text-bad';
}

function SortHeader({ filter, sort, label, className }: { filter: JobsFilter; sort: JobsSort; label: string; className?: string }) {
  const active = filter.sort === sort;
  const dir = active && filter.dir === 'desc' ? 'asc' : 'desc';
  return (
    <th scope="col" className={cx('px-3 py-2.5 font-medium', className)} aria-sort={active ? (filter.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <Link href={jobsHref(filter, { sort, dir, page: 1 })} className={cx('inline-flex items-center gap-1 hover:text-fg', active && 'text-fg')} scroll={false}>
        {label}
        {active && <span aria-hidden="true" className="text-[10px]">{filter.dir === 'asc' ? '▲' : '▼'}</span>}
      </Link>
    </th>
  );
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { filter, jobs, total, pages, counts } = await getJobsPage(await searchParams);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">Jobs</h1>
        <p className="mt-0.5 text-[13px] text-dim">Everything Pursuit has found, with where each one stands.</p>
      </header>

      <JobsFilterBar filter={filter} counts={counts} total={total} />

      {jobs.length === 0 ? (
        <Empty
          title={isFiltered(filter) ? 'No jobs match these filters' : 'No jobs yet'}
          action={isFiltered(filter) ? <Link href="/jobs" className="text-[13px] text-accent hover:underline">Clear filters</Link> : undefined}
        >
          {isFiltered(filter) ? 'Try a lower minimum score or a different status.' : 'Run discovery from ⌘K, or start the worker with pnpm worker.'}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius)] border border-line bg-panel">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line bg-bg-elev/50 text-[12px] text-dim">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium">Role</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <SortHeader filter={filter} sort="score" label="Score" className="text-right" />
                  <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Source</th>
                  <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Location</th>
                  <SortHeader filter={filter} sort="postedAt" label="Posted" className="hidden xl:table-cell" />
                  <SortHeader filter={filter} sort="updatedAt" label="Updated" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {jobs.map((job) => {
                  const salary = formatSalary(job.salary);
                  return (
                    <tr key={job.id} className="group hover:bg-panel-hover/60">
                      <td className="max-w-[380px] px-3 py-2.5">
                        <Link href={`/jobs/${job.id}`} className="flex items-center gap-3">
                          <CompanyMark name={job.company} size={28} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 truncate font-medium text-fg group-hover:text-accent">
                              {job.starred && <span className="text-warn" aria-label="Starred">★</span>}
                              <span className="truncate">{job.title}</span>
                            </span>
                            <span className="block truncate text-[12px] text-dim">{job.company}{salary ? ` · ${salary}` : ''}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-2.5"><StatusBadge status={job.status} /></td>
                      <td className={cx('px-3 py-2.5 text-right font-semibold tabular', scoreClass(job.score))}>{job.score != null ? Math.round(job.score) : '–'}</td>
                      <td className="hidden px-3 py-2.5 text-dim lg:table-cell">{sourceLabel(job.source)}</td>
                      <td className="hidden max-w-[200px] truncate px-3 py-2.5 text-dim md:table-cell">{locationLabel(job)}</td>
                      <td className="hidden px-3 py-2.5 tabular text-faint xl:table-cell" suppressHydrationWarning>{job.postedAt ? timeAgo(job.postedAt) : '—'}</td>
                      <td className="px-3 py-2.5 tabular text-faint" suppressHydrationWarning>{timeAgo(job.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5 text-[12px] text-dim">
              <span className="tabular">Page {filter.page} of {pages}</span>
              <div className="flex gap-1">
                {filter.page > 1 ? (
                  <Link href={jobsHref(filter, { page: filter.page - 1 })} className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-line px-2.5 hover:border-line-strong hover:text-fg"><Icon name="left" size={12} /> Prev</Link>
                ) : <span className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-line px-2.5 opacity-40"><Icon name="left" size={12} /> Prev</span>}
                {filter.page < pages ? (
                  <Link href={jobsHref(filter, { page: filter.page + 1 })} className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-line px-2.5 hover:border-line-strong hover:text-fg">Next <Icon name="right" size={12} /></Link>
                ) : <span className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-line px-2.5 opacity-40">Next <Icon name="right" size={12} /></span>}
              </div>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
