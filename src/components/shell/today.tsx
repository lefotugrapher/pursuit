// Today-page building blocks: funnel strip, worker runs, readiness chips, finish-setup card.
// Hook-free server components.

import Link from 'next/link';
import { Badge, Card, cx, timeAgo } from '@/components/ui';
import type { StatusRun, WorkerHealth } from '@/app/api/_lib/status';
import type { ReadinessChip, SetupStep } from '@/lib/server';
import type { FunnelStats } from '@/lib/types';
import { Icon } from './icons';

const FUNNEL: { key: keyof FunnelStats; label: string; href: string }[] = [
  { key: 'discovered', label: 'Discovered', href: '/jobs' },
  { key: 'scored', label: 'Scored', href: '/jobs?min=1' },
  { key: 'ready', label: 'Ready', href: '/queue' },
  { key: 'applied', label: 'Applied', href: '/jobs?status=applied&status=replied&status=interview&status=offer&status=rejected' },
  { key: 'replied', label: 'Replied', href: '/jobs?status=replied&status=interview&status=offer' },
  { key: 'interview', label: 'Interview', href: '/interviews' },
  { key: 'offer', label: 'Offer', href: '/jobs?status=offer' },
];

/** Cumulative funnel as proportional columns with stage-to-stage conversion. */
export function FunnelStrip({ funnel }: { funnel: FunnelStats }) {
  const base = Math.max(1, funnel.discovered);
  return (
    <div className="grid grid-cols-7 gap-1.5" role="list" aria-label="Funnel">
      {FUNNEL.map((stage, i) => {
        const value = Number(funnel[stage.key]) || 0;
        const prev = i > 0 ? Number(funnel[FUNNEL[i - 1].key]) || 0 : 0;
        const conv = i > 0 && prev > 0 ? Math.round((value / prev) * 100) : null;
        const height = value > 0 ? Math.max(6, Math.sqrt(value / base) * 100) : 2;
        return (
          <Link key={stage.key} href={stage.href} role="listitem" className="group flex min-w-0 flex-col items-stretch gap-1.5">
            <div className="flex h-24 items-end">
              <div
                className={cx('w-full rounded-t-[5px] transition-colors', i >= 5 ? 'bg-good/70 group-hover:bg-good' : 'bg-accent/55 group-hover:bg-accent')}
                style={{ height: `${height}%` }}
              />
            </div>
            <div className="text-[17px] font-semibold leading-5 tabular text-fg">{value}</div>
            <div className="truncate text-[11px] text-dim">{stage.label}</div>
            <div className="h-4 text-[10.5px] tabular text-faint">{conv === null ? '' : `${conv}%`}</div>
          </Link>
        );
      })}
    </div>
  );
}

const RUN_TONE: Record<StatusRun['state'], 'good' | 'bad' | 'accent'> = { ok: 'good', failed: 'bad', running: 'accent' };

function duration(run: StatusRun): string {
  if (!run.finishedAt) return 'running';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

export function WorkerPanel({ worker, runs }: { worker: WorkerHealth; runs: StatusRun[] }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-2.5 items-center justify-center">
          {worker.online && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-40" />}
          <span className={cx('relative inline-flex size-2 rounded-full', worker.online ? 'bg-good' : 'bg-faint')} />
        </span>
        <span className="text-[13px] font-medium text-fg">{worker.online ? 'Worker online' : 'Worker offline'}</span>
        <span className="text-[12px] text-faint" suppressHydrationWarning>
          {worker.heartbeatAt ? `heartbeat ${timeAgo(worker.heartbeatAt)}` : 'never seen'}
        </span>
      </div>
      {!worker.online && (
        <p className="rounded-[var(--radius-sm)] bg-bg-sunk px-3 py-2 text-[12px] text-dim">
          Start it in a terminal: <code className="font-mono text-fg">pnpm worker</code>. Nothing is discovered, tailored or submitted while it is off.
        </p>
      )}
      {runs.length === 0 ? (
        <p className="text-[13px] text-faint">No runs yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 py-2 text-[13px]" title={r.error ?? undefined}>
              <span className={cx('size-1.5 shrink-0 rounded-full', r.state === 'ok' ? 'bg-good' : r.state === 'failed' ? 'bg-bad' : 'bg-accent animate-pulse-dot')} />
              <span className="min-w-0 flex-1 truncate capitalize text-fg">{r.kind}</span>
              {r.state === 'failed' && <Badge tone={RUN_TONE[r.state]}>failed</Badge>}
              <span className="w-12 text-right text-[11px] tabular text-faint">{duration(r)}</span>
              <span className="w-14 text-right text-[11px] tabular text-faint" suppressHydrationWarning>{timeAgo(r.startedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReadinessChips({ chips }: { chips: ReadinessChip[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c.id}
          title={c.detail}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]',
            c.ok ? 'border-line bg-panel text-dim' : 'border-warn/30 bg-warn-soft text-warn',
          )}
        >
          <span className={cx('size-1.5 rounded-full', c.ok ? 'bg-good' : 'bg-warn')} />
          {c.label}
          <span className="text-faint">{c.ok ? 'ready' : 'off'}</span>
        </span>
      ))}
    </div>
  );
}

export function SetupCard({ steps }: { steps: SetupStep[] }) {
  if (!steps.length) return null;
  const envLines = steps.flatMap((s) => s.envLines ?? []);
  return (
    <Card className="border-warn/25">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-warn-soft text-warn"><Icon name="bolt" size={15} /></span>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="text-[14px] font-semibold text-fg">Finish setup</h2>
            <p className="text-[13px] text-dim">Pursuit works without these, but each one unlocks part of the pipeline.</p>
          </div>
          <ul className="space-y-2.5">
            {steps.map((s) => (
              <li key={s.id} className="text-[13px]">
                <div className="font-medium text-fg">{s.title}</div>
                <div className="text-dim">{s.why}</div>
                {s.command && <code className="mt-1 inline-block rounded bg-bg-sunk px-2 py-0.5 font-mono text-[12px] text-fg">{s.command}</code>}
              </li>
            ))}
          </ul>
          {envLines.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] text-dim">
                Add to <code className="font-mono text-fg">.env.local</code> in the project folder (it is gitignored), then restart <code className="font-mono">pnpm dev</code> and <code className="font-mono">pnpm worker</code>:
              </div>
              <pre className="scrollbar-thin overflow-x-auto rounded-[var(--radius-sm)] border border-line bg-bg-sunk px-3 py-2 font-mono text-[12px] leading-5 text-fg">{envLines.join('\n')}</pre>
            </div>
          )}
          <Link href="/settings" className="inline-block text-[12px] text-accent hover:underline">Full health check in Settings →</Link>
        </div>
      </div>
    </Card>
  );
}
