import { connection } from 'next/server';
import { DailyBars } from '@/components/charts/DailyBars';
import { FunnelBars } from '@/components/charts/FunnelBars';
import { PageHeader } from '@/components/settings/kit';
import { Badge, Card, Section, Stat } from '@/components/ui';
import { dailyApplied, funnelStats, llmUsageSummary, responseRates } from '@/lib/db';
import { env, hasLLM } from '@/lib/env';
import { DIMENSION_LABEL, SOURCE_LABEL, funnelSteps, groupResponseRates, topGapKeywords } from '@/lib/server-more';
import { dublinDayStartIso } from '@/lib/time';
import type { ResponseRateRow, SourceId } from '@/lib/types';

export const metadata = { title: 'Analytics' };

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const usd = (x: number) => (x < 0.01 && x > 0 ? '<$0.01' : `$${x.toFixed(2)}`);
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function keyLabel(dimension: ResponseRateRow['dimension'], key: string): string {
  if (dimension === 'source') return SOURCE_LABEL[key as SourceId] ?? key;
  if (dimension === 'summaryVariant') return key.replace(/_/g, ' ');
  return key;
}

function RateTable({ dimension, rows }: { dimension: ResponseRateRow['dimension']; rows: ResponseRateRow[] }) {
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="border-b border-line px-3 py-2 text-[12.5px] font-semibold text-fg">{DIMENSION_LABEL[dimension]}</div>
      {rows.length === 0 ? (
        <div className="px-3 py-5 text-center text-[12.5px] text-faint">No applications yet</div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="text-[11px] uppercase tracking-[0.06em] text-faint">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">{dimension === 'scoreBucket' ? 'Score' : 'Name'}</th>
              <th className="px-2 py-1.5 text-right font-medium">Applied</th>
              <th className="px-2 py-1.5 text-right font-medium">Replies</th>
              <th className="px-2 py-1.5 text-right font-medium">Interv.</th>
              <th className="px-3 py-1.5 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="max-w-[10rem] truncate px-3 py-1.5 text-fg">{keyLabel(dimension, r.key)}</td>
                <td className="px-2 py-1.5 text-right text-dim">{r.applied}</td>
                <td className="px-2 py-1.5 text-right text-dim">{r.responded}</td>
                <td className="px-2 py-1.5 text-right text-dim">{r.interviews}</td>
                <td className="px-3 py-1.5 text-right">
                  <span className={r.rate >= 0.2 ? 'text-good' : r.rate > 0 ? 'text-fg' : 'text-faint'}>{pct(r.rate)}</span>
                  {r.applied < 5 && <span className="ml-1 text-[10.5px] text-faint" title="Fewer than 5 applications: too few to read much into">·</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default async function AnalyticsPage() {
  await connection();
  const funnel = funnelStats();
  const steps = funnelSteps(funnel);
  const daily = dailyApplied(30);
  const last30 = daily.reduce((n, d) => n + d.count, 0);
  const rates = groupResponseRates(responseRates());
  const { gaps, jobsConsidered } = topGapKeywords(24);
  const llm30 = llmUsageSummary(dublinDayStartIso(29));
  const llmToday = llmUsageSummary(dublinDayStartIso(0));
  const maxGap = Math.max(1, ...gaps.map((g) => g.jobs));

  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" description="What's working: where applications come from, which ones get replies, and which real skills employers keep asking for." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Applied (30 days)" value={last30} hint={`${funnel.appliedWeek} this week · ${funnel.appliedToday} today`} />
        <Stat label="Response rate" value={pct(funnel.responseRate)} hint={`${funnel.replied} of ${funnel.applied} applied`} tone={funnel.responseRate >= 0.15 ? 'good' : undefined} />
        <Stat label="Interviews" value={funnel.interview} hint={`${funnel.offer} offer${funnel.offer === 1 ? '' : 's'} · ${funnel.rejected} rejected`} tone={funnel.interview ? 'good' : undefined} />
        <Stat label="LLM spend (30 days)" value={usd(llm30.costUsd)} hint={hasLLM() ? `${llm30.calls} calls · ${usd(llmToday.costUsd)} today` : 'LLM off: heuristics only'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Funnel">
          <Card><FunnelBars steps={steps} /></Card>
        </Section>
        <Section title="Applications per day" action={<span className="text-[12px] text-faint">Last 30 days, Dublin time</span>}>
          <Card><DailyBars data={daily} title="Applications per day, last 30 days" /></Card>
        </Section>
      </div>

      <Section title="Response rate">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(Object.keys(rates) as ResponseRateRow['dimension'][]).map((d) => <RateTable key={d} dimension={d} rows={rates[d]} />)}
        </div>
      </Section>

      <Section title="Skill gaps employers ask for" action={<span className="text-[12px] text-faint">{jobsConsidered} ready or applied jobs</span>}>
        <Card className="space-y-3">
          <p className="text-[12.5px] text-dim">
            Keywords from job descriptions that your fact bank doesn&apos;t back up. Pursuit never claims these. If one is a skill you
            really have, add it to the fact bank in Settings; if not, it&apos;s a hint for what to learn next.
          </p>
          {gaps.length === 0 ? (
            <div className="py-4 text-center text-[12.5px] text-faint">No gap data yet. It fills in as jobs are scored and tailored.</div>
          ) : (
            <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {gaps.map((g) => (
                <li key={g.term} className="flex items-center gap-2 text-[12.5px]" title={g.examples.join('\n')}>
                  <span className="w-40 shrink-0 truncate text-fg">{g.term}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-sunk">
                    <span className="block h-full rounded-full bg-warn" style={{ width: `${(g.jobs / maxGap) * 100}%` }} />
                  </span>
                  <span className="w-14 shrink-0 text-right tabular text-faint">{g.jobs} job{g.jobs === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Section>

      <Section title="LLM usage" action={<span className="font-mono text-[11.5px] text-faint">{env.LLM_MODEL}</span>}>
        <Card pad={false} className="overflow-hidden">
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-3 py-2.5 text-[12.5px] text-dim">
            <span>Calls <strong className="tabular text-fg">{llm30.calls}</strong></span>
            <span>Failed <strong className={llm30.failed ? 'tabular text-warn' : 'tabular text-fg'}>{llm30.failed}</strong></span>
            <span>Prompt tokens <strong className="tabular text-fg">{tokens(llm30.promptTokens)}</strong></span>
            <span>Completion tokens <strong className="tabular text-fg">{tokens(llm30.completionTokens)}</strong></span>
            <span>Spend <strong className="tabular text-fg">{usd(llm30.costUsd)}</strong></span>
            {!hasLLM() && <Badge tone="warn">LLM off</Badge>}
          </div>
          {llm30.byPurpose.length === 0 ? (
            <div className="px-3 py-5 text-center text-[12.5px] text-faint">No LLM calls in the last 30 days.</div>
          ) : (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead className="text-[11px] uppercase tracking-[0.06em] text-faint">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Purpose</th>
                    <th className="px-2 py-1.5 text-right font-medium">Calls</th>
                    <th className="px-2 py-1.5 text-right font-medium">Failed</th>
                    <th className="px-2 py-1.5 text-right font-medium">Tokens in / out</th>
                    <th className="px-3 py-1.5 text-right font-medium">Spend</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {llm30.byPurpose.map((p) => (
                    <tr key={p.purpose} className="border-t border-line">
                      <td className="px-3 py-1.5 text-fg">{p.purpose}</td>
                      <td className="px-2 py-1.5 text-right text-dim">{p.calls}</td>
                      <td className="px-2 py-1.5 text-right text-dim">{p.failed}</td>
                      <td className="px-2 py-1.5 text-right text-dim">{tokens(p.promptTokens)} / {tokens(p.completionTokens)}</td>
                      <td className="px-3 py-1.5 text-right text-fg">{usd(p.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-line px-3 py-2 text-[11.5px] text-faint">Spend is the cost OpenRouter reports per call; calls without a reported cost count as $0.</div>
        </Card>
      </Section>
    </div>
  );
}
