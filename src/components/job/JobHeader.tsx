// Job header used by the approval card and the job detail page. Hook-free (server + client safe).

import type { ReactNode } from 'react';
import { Badge, ScoreRing, StatusBadge, cx, timeAgo } from '@/components/ui';
import type { Job } from '@/lib/types';
import { AUTOMATABLE_ATS, atsLabel, formatSalary, locationLabel, sourceLabel } from './format';

export function CompanyMark({ name, size = 40 }: { name: string; size?: number }) {
  const clean = name.replace(/^demo\s+/i, '').trim() || name;
  const letters = clean.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
  let hue = 0;
  for (const ch of clean) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-[10px] font-semibold text-white"
      style={{
        width: size, height: size, fontSize: size * 0.36,
        background: `linear-gradient(135deg, hsl(${hue} 55% 46%), hsl(${(hue + 40) % 360} 60% 34%))`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      {letters || '?'}
    </span>
  );
}

export function JobHeader({ job, actions, showStatus = false, compact = false }: { job: Job; actions?: ReactNode; showStatus?: boolean; compact?: boolean }) {
  const salary = formatSalary(job.salary);
  const handoff = !AUTOMATABLE_ATS.includes(job.ats);
  return (
    <div className="flex items-start gap-3.5">
      <CompanyMark name={job.company} size={compact ? 36 : 44} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-dim">
          <span className="font-medium text-fg/90">{job.company}</span>
          {job.starred && <span className="text-warn" aria-label="Starred">★</span>}
          {showStatus && <StatusBadge status={job.status} />}
        </div>
        <h1 className={cx('mt-0.5 font-semibold tracking-[-0.015em] text-fg', compact ? 'text-[17px] leading-6' : 'text-[20px] leading-7 md:text-[22px]')}>
          {job.title}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-dim">
          <span>{locationLabel(job)}</span>
          {salary && <span className="tabular text-fg/80">{salary}</span>}
          {job.employmentType && <span className="capitalize">{job.employmentType}</span>}
          <span suppressHydrationWarning title={job.postedAt ? new Date(job.postedAt).toLocaleString('en-IE') : undefined}>
            {job.postedAt ? `posted ${timeAgo(job.postedAt)}` : `found ${timeAgo(job.discoveredAt)}`}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge>{sourceLabel(job.source)}</Badge>
          <Badge tone={handoff ? 'warn' : 'info'} title={handoff ? 'Pursuit fills what it can, then hands the form to you' : 'Pursuit can fill and submit this form'}>
            {atsLabel(job.ats)}{handoff ? ' · handoff' : ''}
          </Badge>
          {job.country === 'GB-NIR' && <Badge tone="warn" title="UK right-to-work differs from Ireland">Northern Ireland</Badge>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <ScoreRing score={job.score} size={compact ? 44 : 54} />
        {actions}
      </div>
    </div>
  );
}
