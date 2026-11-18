// / Today: what needs Kayzee now, how the search is going, and whether the engine is healthy.

import Link from 'next/link';
import { Badge, Card, Empty, Section, Stat } from '@/components/ui';
import { HandoffButton } from '@/components/job/HandoffButton';
import { Timeline } from '@/components/job/Timeline';
import { locationLabel } from '@/components/job/format';
import { Icon } from '@/components/shell/icons';
import { FunnelStrip, ReadinessChips, SetupCard, WorkerPanel } from '@/components/shell/today';
import { getReadiness, getTodayData } from '@/lib/server';

export default async function TodayPage() {
  const [data, readiness] = await Promise.all([getTodayData(), getReadiness()]);
  const { counts, funnel } = data;
  const responsePct = Math.round(funnel.responseRate * 100);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[12px] font-medium uppercase tracking-[0.1em] text-faint">{data.dateLabel}</p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.025em] text-fg md:text-[30px]">
            {data.greeting}, {data.name}
          </h1>
          <p className="mt-1 text-[14px] text-dim">
            {counts.ready > 0
              ? <>You have <Link href="/queue" className="font-medium text-accent hover:underline">{counts.ready} application{counts.ready === 1 ? '' : 's'}</Link> ready to approve.</>
              : 'Nothing waiting for approval. ' + data.nextDiscovery}
          </p>
        </div>
        <ReadinessChips chips={readiness.chips} />
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link href="/queue" className="group block rounded-[var(--radius)] focus-visible:outline-2">
          <Stat
            label="Ready to approve"
            value={<span className="flex items-center gap-2">{counts.ready}<Icon name="right" size={16} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent" /></span>}
            hint={counts.ready ? 'Open the queue' : 'Queue clear'}
            tone={counts.ready ? 'accent' : undefined}
          />
        </Link>
        <Stat label="Applied this week" value={funnel.appliedWeek} hint={`${funnel.appliedToday} today · cap ${data.settings.dailyApplyCap}/day`} />
        <Stat
          label="Response rate"
          value={funnel.applied ? `${responsePct}%` : '—'}
          hint={funnel.applied ? `${funnel.replied} of ${funnel.applied} applications` : 'No applications yet'}
          tone={funnel.applied && responsePct >= 15 ? 'good' : undefined}
        />
        <Link href="/interviews" className="block rounded-[var(--radius)]">
          <Stat label="Interviews" value={counts.interview} hint={funnel.offer ? `${funnel.offer} offer${funnel.offer === 1 ? '' : 's'}` : 'Upcoming and past'} tone={counts.interview ? 'good' : undefined} />
        </Link>
      </div>

      <SetupCard steps={readiness.steps} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-8">
          <Section
            title={<span className="flex items-center gap-2">Needs you {data.needsYou.length > 0 && <Badge tone="warn">{counts.needs_you}</Badge>}</span>}
            action={counts.needs_you > data.needsYou.length ? <Link href="/jobs?status=needs_you" className="text-[12px] text-faint hover:text-accent">All {counts.needs_you} →</Link> : undefined}
          >
            {data.needsYou.length === 0 ? (
              <Card><p className="text-[13px] text-dim">Nothing is blocked. CAPTCHAs, logins and questions Pursuit can&apos;t answer land here.</p></Card>
            ) : (
              <Card pad={false}>
                <ul className="divide-y divide-line">
                  {data.needsYou.map((job) => (
                    <li key={job.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1">
                        <Link href={`/jobs/${job.id}`} className="block truncate text-[14px] font-medium text-fg hover:text-accent">{job.title}</Link>
                        <div className="truncate text-[12px] text-dim">{job.company} · {locationLabel(job)}</div>
                        {job.needs?.length ? (
                          <ul className="mt-1.5 space-y-0.5">
                            {job.needs.slice(0, 3).map((n, i) => (
                              <li key={i} className="flex gap-1.5 text-[12.5px] text-warn"><span aria-hidden="true">·</span><span className="line-clamp-2">{n}</span></li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-1 text-[12.5px] text-faint">No reason recorded: open the job to check.</p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <HandoffButton jobId={job.id} />
                        <Link href={`/jobs/${job.id}`} className="inline-flex h-7 items-center rounded-[var(--radius-sm)] px-2.5 text-[12px] text-dim hover:bg-panel-hover hover:text-fg">Details</Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </Section>

          <Section title="Funnel" action={<Link href="/analytics" className="text-[12px] text-faint hover:text-accent">Analytics →</Link>}>
            <Card>
              {funnel.discovered === 0 ? (
                <Empty title="No jobs yet">Discovery fills this in. Start the worker or run discovery from ⌘K.</Empty>
              ) : (
                <FunnelStrip funnel={funnel} />
              )}
            </Card>
          </Section>

          {data.interviews.length > 0 && (
            <Section title="Interviews" action={<Link href="/interviews" className="text-[12px] text-faint hover:text-accent">Prep packs →</Link>}>
              <Card pad={false}>
                <ul className="divide-y divide-line">
                  {data.interviews.map((job) => (
                    <li key={job.id}>
                      <Link href={`/jobs/${job.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-panel-hover/50">
                        <Icon name="interviews" className="text-good" />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{job.title} <span className="text-faint">· {job.company}</span></span>
                        <Icon name="right" size={14} className="text-faint" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </Section>
          )}
        </div>

        <div className="space-y-8">
          <Section title="Engine">
            <Card><WorkerPanel worker={data.worker} runs={data.runs} /></Card>
          </Section>
          <Section title="Recent activity">
            <Card><Timeline events={data.activity} empty="No activity yet. It shows up here as the worker runs." /></Card>
          </Section>
        </div>
      </div>
    </div>
  );
}
