// Read-only panels for the approval card and job detail: score signals, keyword coverage, ATS
// report, outreach draft previews. Hook-free (server + client safe).

import type { ReactNode } from 'react';
import { Badge, Meter, cx } from '@/components/ui';
import type { AtsReport, Job, KeywordCoverage, ScoreDetail } from '@/lib/types';
import { COMPONENT_WEIGHT, componentLabel } from '@/components/job/format';
import type { DraftView } from './model';

export function Panel({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-[var(--radius)] border border-line bg-panel p-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-dim">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function SignalList({ reasons, flags }: { reasons: string[]; flags: string[] }) {
  if (!reasons.length && !flags.length) return <p className="text-[13px] text-faint">Not scored yet.</p>;
  return (
    <ul className="space-y-1.5 text-[13px]">
      {flags.map((f, i) => (
        <li key={`f${i}`} className="flex gap-2 text-warn">
          <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warn" />
          <span>{f}</span>
        </li>
      ))}
      {reasons.map((r, i) => (
        <li key={`r${i}`} className="flex gap-2 text-dim">
          <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-good/70" />
          <span>{r}</span>
        </li>
      ))}
    </ul>
  );
}

export function ScoreBreakdown({ detail }: { detail?: ScoreDetail }) {
  if (!detail) return <p className="text-[13px] text-faint">Not scored yet.</p>;
  const entries = Object.entries(detail.components) as [string, number][];
  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2">
          <div className="flex-1"><Meter value={v} label={componentLabel(k)} /></div>
          <span className="w-9 text-right text-[11px] tabular text-faint" title="Weight in the total">×{COMPONENT_WEIGHT[k] ?? '?'}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1 text-[11px] text-faint">
        <span>{detail.llmUsed ? 'LLM-assisted' : 'Heuristic'} score</span>
        <span>·</span>
        <span suppressHydrationWarning>{new Date(detail.scoredAt).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}</span>
      </div>
    </div>
  );
}

export function KeywordCoverageView({ coverage }: { coverage?: KeywordCoverage }) {
  if (!coverage || (!coverage.matched.length && !coverage.gaps.length)) {
    return <p className="text-[13px] text-faint">No keywords extracted yet.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-sunk">
          <div className="h-full rounded-full bg-good" style={{ width: `${Math.max(0, Math.min(100, coverage.pct))}%` }} />
        </div>
        <span className="text-[12px] tabular text-dim">{Math.round(coverage.pct)}% backed</span>
      </div>
      {coverage.matched.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {coverage.matched.map((m) => (
            <Badge key={m.term} tone="good" title={m.factIds.length ? `Backed by: ${m.factIds.join(', ')}` : 'Backed by your fact bank'}>
              {m.term}
            </Badge>
          ))}
        </div>
      )}
      {coverage.gaps.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] text-faint">In the JD, not in your facts, so never claimed:</div>
          <div className="flex flex-wrap gap-1.5">
            {coverage.gaps.map((g) => (
              <Badge key={g} title="Not claimed: no fact backs this">{g}</Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AtsReportView({ report }: { report: AtsReport | null }) {
  if (!report) return <p className="text-[13px] text-faint">No ATS check yet (it runs after the CV PDF compiles).</p>;
  const tone = report.score >= 80 ? 'text-good' : report.score >= 60 ? 'text-accent' : 'text-warn';
  return (
    <div className="space-y-2.5 text-[13px]">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className={cx('text-[22px] font-semibold tabular', tone)}>{Math.round(report.score)}</span>
        <span className="text-dim">{report.pages} page{report.pages === 1 ? '' : 's'}</span>
        <span className="text-dim">{Math.round(report.keywordPct)}% keywords in text</span>
        <span className={report.textExtractable ? 'text-dim' : 'text-bad'}>{report.textExtractable ? 'text extractable' : 'text NOT extractable'}</span>
      </div>
      {report.problems.length > 0 ? (
        <ul className="space-y-1">
          {report.problems.map((p, i) => <li key={i} className="flex gap-2 text-warn"><span aria-hidden="true">!</span><span>{p}</span></li>)}
        </ul>
      ) : (
        <p className="text-good">No parse problems found.</p>
      )}
      {report.keywordsMissing.length > 0 && (
        <p className="text-[12px] text-faint">Backed but missing from the PDF: {report.keywordsMissing.join(', ')}</p>
      )}
    </div>
  );
}

const DRAFT_KIND: Record<string, string> = {
  outreach: 'Outreach email', follow_up: 'Follow-up', reply: 'Reply', linkedin_note: 'LinkedIn note', digest: 'Digest', thank_you: 'Thank-you',
};

export function DraftsPreview({ drafts }: { drafts: DraftView[] }) {
  if (!drafts.length) return <p className="text-[13px] text-faint">No outreach drafted for this job.</p>;
  return (
    <ul className="space-y-2.5">
      {drafts.map((d) => {
        const warnings = (d.guardProblems?.length ?? 0) + (d.slopHits?.length ?? 0);
        return (
          <li key={d.id} className="rounded-[var(--radius-sm)] border border-line bg-bg-sunk/50 p-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <Badge tone={d.channel === 'linkedin' ? 'info' : 'neutral'}>{DRAFT_KIND[d.kind] ?? d.kind}</Badge>
              {d.to && <span className="truncate text-dim">to {d.to}</span>}
              {warnings > 0 && <Badge tone="warn">{warnings} warning{warnings === 1 ? '' : 's'}</Badge>}
            </div>
            {d.subject && <div className="mt-1.5 text-[13px] font-medium text-fg">{d.subject}</div>}
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-[12.5px] text-dim">{d.body}</p>
          </li>
        );
      })}
    </ul>
  );
}

export function JobDescription({ job, className }: { job: Pick<Job, 'description'>; className?: string }) {
  const text = job.description?.trim();
  if (!text) return <p className="text-[13px] text-faint">No description captured. Open the posting to read it.</p>;
  return <div className={cx('prose-pursuit text-[13px] text-dim', className)}>{text}</div>;
}
