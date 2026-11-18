'use client';
// /jobs filter bar: search (debounced), status chips (multi), source, minimum score. State lives in
// the URL so the table stays server-rendered and links are shareable.

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { cx } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import type { JobStatus } from '@/lib/types';
import { sourceLabel } from './format';
import { SOURCES, isFiltered, jobsHref, type JobsFilter } from './filters';

const STATUS_CHIPS: { label: string; statuses: JobStatus[] }[] = [
  { label: 'Ready', statuses: ['ready'] },
  { label: 'Needs you', statuses: ['needs_you'] },
  { label: 'In flight', statuses: ['approved', 'applying'] },
  { label: 'Applied', statuses: ['applied', 'replied'] },
  { label: 'Interview', statuses: ['interview', 'offer'] },
  { label: 'Scored', statuses: ['scored', 'tailoring'] },
  { label: 'New', statuses: ['discovered'] },
  { label: 'Closed', statuses: ['rejected', 'skipped', 'filtered_out', 'failed', 'withdrawn'] },
];

const MIN_SCORES = [0, 45, 60, 70, 80, 90];

export function JobsFilterBar({ filter, counts, total }: { filter: JobsFilter; counts: Record<JobStatus, number>; total: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(filter.q ?? '');
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const push = (patch: Partial<JobsFilter>) => start(() => router.push(jobsHref(filterRef.current, patch), { scroll: false }));

  useEffect(() => setQ(filter.q ?? ''), [filter.q]);

  // Debounced search: only navigates when the text actually differs from the URL.
  useEffect(() => {
    const next = q.trim();
    if (next === (filterRef.current.q ?? '')) return;
    const t = setTimeout(() => push({ q: next || undefined }), 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const toggleChip = (statuses: JobStatus[]) => {
    const current = new Set(filter.statuses);
    const allOn = statuses.every((s) => current.has(s));
    for (const s of statuses) (allOn ? current.delete(s) : current.add(s));
    push({ statuses: [...current] });
  };

  return (
    <div className={cx('space-y-3 transition-opacity', pending && 'opacity-70')} aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <span className="sr-only">Search jobs</span>
          <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, company, location…"
            className="h-9 w-full rounded-[var(--radius-sm)] border border-line bg-panel pl-8 pr-3 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </label>
        <select
          aria-label="Source"
          value={filter.source ?? ''}
          onChange={(e) => push({ source: (e.target.value || undefined) as JobsFilter['source'] })}
          className="h-9 rounded-[var(--radius-sm)] border border-line bg-panel px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none"
        >
          <option value="">All sources</option>
          {SOURCES.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
        <select
          aria-label="Minimum score"
          value={filter.minScore ?? 0}
          onChange={(e) => push({ minScore: Number(e.target.value) || undefined })}
          className="h-9 rounded-[var(--radius-sm)] border border-line bg-panel px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none"
        >
          {MIN_SCORES.map((n) => <option key={n} value={n}>{n ? `Score ≥ ${n}` : 'Any score'}</option>)}
        </select>
        {isFiltered(filter) && (
          <button type="button" onClick={() => { setQ(''); start(() => router.push(pathname ?? '/jobs')); }} className="h-9 rounded-[var(--radius-sm)] px-2.5 text-[12px] text-dim hover:bg-panel-hover hover:text-fg">
            Clear
          </button>
        )}
        <span className="ml-auto text-[12px] tabular text-faint">{total} job{total === 1 ? '' : 's'}</span>
      </div>
      <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {STATUS_CHIPS.map((chip) => {
          const on = chip.statuses.every((s) => filter.statuses.includes(s));
          const n = chip.statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
          return (
            <button
              key={chip.label}
              type="button"
              aria-pressed={on}
              onClick={() => toggleChip(chip.statuses)}
              className={cx(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors',
                on ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line bg-panel text-dim hover:border-line-strong hover:text-fg',
              )}
            >
              {chip.label}
              <span className={cx('tabular', on ? 'text-accent/80' : 'text-faint')}>{n}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
