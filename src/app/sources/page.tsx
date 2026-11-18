import { connection } from 'next/server';
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { RunTaskButton } from '@/components/settings/RunTaskButton';
import { Checkbox, Field, Notice, PageHeader, Select, TabLinks, TextInput } from '@/components/settings/kit';
import { Badge, Card, Empty, Section, cx, timeAgo } from '@/components/ui';
import { loadSources } from '@/lib/config';
import { hasAdzuna, hasMail } from '@/lib/env';
import { BOARD_ATS, SOURCE_IDS, SOURCE_LABEL, sourceRuns, type SourceRunInfo } from '@/lib/server-more';
import type { SourceId, SourcesConfig } from '@/lib/types';
import { addCompanyAction, companyRowAction, saveLinkedInAction, toggleFeedAction } from './actions';

export const metadata = { title: 'Sources' };

type Search = Promise<Record<string, string | string[] | undefined>>;

function sourceEnabled(id: SourceId, s: SourcesConfig): boolean {
  if ((BOARD_ATS as readonly string[]).includes(id)) return s.companies.some((c) => c.ats === id && c.enabled);
  if (id === 'linkedin_guest') return s.linkedinGuest.enabled;
  if (id === 'adzuna') return s.adzuna.enabled && hasAdzuna();
  if (id === 'gmail_alert') return s.gmailAlerts.enabled && hasMail();
  return false;
}

function RunStatus({ run }: { run: SourceRunInfo | null }) {
  if (!run?.at && run?.found === undefined) return <div className="text-[12px] text-faint">Never run</div>;
  return (
    <div className="space-y-0.5 text-[12px]">
      <div className="text-dim">{run.at ? `Last run ${timeAgo(run.at)}` : 'Last run'}</div>
      {(run.found !== undefined || run.created !== undefined) && (
        <div className="tabular text-faint">{run.found ?? 0} found · {run.created ?? 0} new</div>
      )}
      {run.error && <div className="line-clamp-2 text-bad" title={run.error}>{run.error}</div>}
    </div>
  );
}

function SourceGrid({ sources, runs }: { sources: SourcesConfig; runs: Record<string, SourceRunInfo | null> }) {
  const boardCount = (id: SourceId) => sources.companies.filter((c) => c.ats === id && c.enabled).length;
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      {SOURCE_IDS.map((id) => {
        const on = sourceEnabled(id, sources);
        const isBoard = (BOARD_ATS as readonly string[]).includes(id);
        return (
          <Card key={id} pad={false} className="space-y-1.5 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-fg">{SOURCE_LABEL[id]}</span>
              <span className={cx('size-2 shrink-0 rounded-full', on ? 'bg-good' : 'bg-line-strong')} title={on ? 'On' : 'Off'} />
            </div>
            {isBoard && <div className="text-[11.5px] tabular text-faint">{boardCount(id)} board{boardCount(id) === 1 ? '' : 's'}</div>}
            <RunStatus run={runs[id]} />
          </Card>
        );
      })}
    </div>
  );
}

function Watchlist({ sources, atsFilter }: { sources: SourcesConfig; atsFilter?: string }) {
  const companies = atsFilter ? sources.companies.filter((c) => c.ats === atsFilter) : sources.companies;
  const tabs = [
    { key: 'all', label: 'All', href: '/sources', count: sources.companies.length },
    ...BOARD_ATS.map((a) => ({ key: a, label: SOURCE_LABEL[a], href: `/sources?ats=${a}`, count: sources.companies.filter((c) => c.ats === a).length })).filter((t) => t.count > 0),
  ];
  return (
    <div className="space-y-3">
      <TabLinks tabs={tabs} active={atsFilter ?? 'all'} label="Filter watchlist by ATS" />
      <Card pad={false} className="overflow-hidden">
        {companies.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-faint">No companies on the watchlist yet.</div>
        ) : (
          <div className="scrollbar-thin max-h-[36rem] overflow-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="sticky top-0 z-10 border-b border-line bg-panel text-[11.5px] uppercase tracking-[0.06em] text-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">ATS · token</th>
                  <th className="px-3 py-2 font-medium">Tags</th>
                  <th className="px-3 py-2 font-medium">Verified</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={`${c.ats}:${c.token}`} className={cx('border-b border-line align-top last:border-b-0 hover:bg-panel-hover', !c.enabled && 'opacity-60')}>
                    <td className="px-3 py-2 font-medium text-fg">{c.name}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Badge>{SOURCE_LABEL[c.ats]}</Badge>
                        <span className="font-mono text-[12px] text-dim">{c.token}</span>
                      </div>
                    </td>
                    <td className="max-w-[16rem] px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(c.tags ?? []).slice(0, 4).map((t) => <Badge key={t}>{t}</Badge>)}
                        {(c.tags?.length ?? 0) > 4 && <span className="text-[11px] text-faint" title={c.tags?.join(', ')}>+{(c.tags?.length ?? 0) - 4}</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-[12px] tabular text-faint">{c.verifiedAt ?? '—'}</td>
                    <td className="px-3 py-2">
                      <ActionForm action={companyRowAction} className="flex flex-col items-end gap-1" messageClassName="max-w-[16rem] text-right">
                        <input type="hidden" name="ats" value={c.ats} />
                        <input type="hidden" name="token" value={c.token} />
                        <div className="flex gap-1">
                          <SubmitButton name="intent" value="toggle" size="sm" variant={c.enabled ? 'ghost' : 'good'}>{c.enabled ? 'Pause' : 'Enable'}</SubmitButton>
                          <SubmitButton name="intent" value="test" size="sm" variant="ghost" pendingLabel="Testing…">Test</SubmitButton>
                          <SubmitButton name="intent" value="remove" size="sm" variant="ghost" confirm={`Remove ${c.name} from the watchlist?`}>Remove</SubmitButton>
                        </div>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AddCompany() {
  return (
    <Card>
      <h2 className="mb-1 text-[14px] font-semibold text-fg">Add a company</h2>
      <p className="mb-3 text-[12.5px] text-dim">
        The token is the board name in the careers URL, e.g. <span className="font-mono">boards.greenhouse.io/<strong className="text-fg">intercom</strong></span>,{' '}
        <span className="font-mono">jobs.lever.co/<strong className="text-fg">cartrawler</strong></span>, <span className="font-mono">jobs.ashbyhq.com/<strong className="text-fg">notion</strong></span>.
        Test makes one request to the public board API.
      </p>
      <ActionForm action={addCompanyAction} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Company name"><TextInput name="name" placeholder="Intercom" /></Field>
          <Field label="ATS">
            <Select name="ats" defaultValue="greenhouse">
              {BOARD_ATS.map((a) => <option key={a} value={a}>{SOURCE_LABEL[a]}</option>)}
            </Select>
          </Field>
          <Field label="Board token *"><TextInput name="token" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" placeholder="intercom" className="font-mono" /></Field>
          <Field label="Tags" hint="Comma separated"><TextInput name="tags" placeholder="tech, ie-office" /></Field>
        </div>
        <div className="flex gap-2">
          <SubmitButton name="intent" value="test" size="sm" pendingLabel="Testing…">Test</SubmitButton>
          <SubmitButton name="intent" value="add" size="sm" variant="primary" pendingLabel="Checking…">Test &amp; add</SubmitButton>
        </div>
      </ActionForm>
    </Card>
  );
}

function LinkedInEditor({ sources }: { sources: SourcesConfig }) {
  const lg = sources.linkedinGuest;
  const rows = [...lg.queries, { keywords: '', location: '' }, { keywords: '', location: '' }, { keywords: '', location: '' }];
  return (
    <Card className="space-y-3">
      <Notice tone="info">
        Uses only LinkedIn&apos;s public, logged-out job pages, at most one request every {Math.max(3, Math.round(lg.minIntervalMs / 1000))} seconds. Pursuit never
        logs into LinkedIn, so your account is never touched. Each search below is keywords × location.
      </Notice>
      <ActionForm action={saveLinkedInAction} className="space-y-3">
        <input type="hidden" name="rows" value={rows.length} />
        <div className="flex flex-wrap items-end gap-4">
          <Checkbox name="enabled" defaultChecked={lg.enabled} label="Search LinkedIn public job pages" />
          <Field label="Results per search" className="w-36">
            <TextInput name="maxPerQuery" type="number" min={1} max={100} defaultValue={lg.maxPerQuery} />
          </Field>
        </div>
        <div className="scrollbar-thin max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">
            <span>Keywords</span><span>Location</span><span className="w-16 text-right">Remove</span>
          </div>
          {rows.map((q, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <TextInput name={`kw_${i}`} defaultValue={q.keywords} placeholder={i >= lg.queries.length ? 'e.g. PR executive' : undefined} aria-label={`Keywords ${i + 1}`} />
              <TextInput name={`loc_${i}`} defaultValue={q.location} placeholder={i >= lg.queries.length ? 'e.g. Dublin, Ireland' : undefined} aria-label={`Location ${i + 1}`} />
              <span className="flex w-16 justify-end">
                {i < lg.queries.length && <input type="checkbox" name={`rm_${i}`} aria-label={`Remove search ${i + 1}`} className="size-3.5 accent-[var(--bad)]" />}
              </span>
            </div>
          ))}
        </div>
        <SubmitButton size="sm" variant="primary" pendingLabel="Saving…">Save searches</SubmitButton>
      </ActionForm>
    </Card>
  );
}

function Feeds({ sources }: { sources: SourcesConfig }) {
  const adzunaReady = hasAdzuna();
  const mailReady = hasMail();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Adzuna</h3>
          <Badge tone={sources.adzuna.enabled && adzunaReady ? 'good' : 'neutral'}>{sources.adzuna.enabled ? (adzunaReady ? 'On' : 'On, no keys') : 'Off'}</Badge>
        </div>
        <p className="text-[12.5px] text-dim">
          Job aggregator API for Ireland and the UK. {adzunaReady ? `${sources.adzuna.queries.length} search${sources.adzuna.queries.length === 1 ? '' : 'es'} configured.` : 'Needs ADZUNA_APP_ID and ADZUNA_APP_KEY in .env.local (free at developer.adzuna.com).'}
        </p>
        <ActionForm action={toggleFeedAction}>
          <input type="hidden" name="source" value="adzuna" />
          <SubmitButton size="sm" variant={sources.adzuna.enabled ? 'ghost' : 'secondary'} disabled={!sources.adzuna.enabled && !adzunaReady}>
            {sources.adzuna.enabled ? 'Turn off' : 'Turn on'}
          </SubmitButton>
        </ActionForm>
      </Card>
      <Card className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Gmail job alerts</h3>
          <Badge tone={sources.gmailAlerts.enabled && mailReady ? 'good' : 'neutral'}>{sources.gmailAlerts.enabled ? (mailReady ? 'On' : 'On, Gmail not connected') : 'Off'}</Badge>
        </div>
        <p className="text-[12.5px] text-dim">
          Tip: create LinkedIn, Indeed and IrishJobs job alerts sent to your Gmail. Pursuit imports them. It only reads the alert emails, never your LinkedIn account.
        </p>
        <ActionForm action={toggleFeedAction}>
          <input type="hidden" name="source" value="gmailAlerts" />
          <SubmitButton size="sm" variant={sources.gmailAlerts.enabled ? 'ghost' : 'secondary'}>{sources.gmailAlerts.enabled ? 'Turn off' : 'Turn on'}</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}

export default async function SourcesPage({ searchParams }: { searchParams: Search }) {
  await connection();
  const sp = await searchParams;
  const atsRaw = Array.isArray(sp.ats) ? sp.ats[0] : sp.ats;
  const atsFilter = (BOARD_ATS as readonly string[]).includes(atsRaw ?? '') ? atsRaw : undefined;

  let sources: SourcesConfig;
  try {
    sources = loadSources();
  } catch (err) {
    return (
      <div className="space-y-5">
        <PageHeader title="Sources" />
        <Empty title="config/sources.json can't be read">{(err as Error).message}</Empty>
      </div>
    );
  }
  const runs = sourceRuns();
  const enabledBoards = sources.companies.filter((c) => c.enabled).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sources"
        description={`Where Pursuit looks for jobs: ${enabledBoards} company boards, LinkedIn public pages, Adzuna and your Gmail alerts. Discovery runs every few hours between 08:00 and 22:00.`}
        actions={<RunTaskButton task="discover" label="Run discovery now" runningLabel="Discovering… (a few minutes)" variant="primary" />}
      />
      <SourceGrid sources={sources} runs={runs} />
      <Section title="Company watchlist"><Watchlist sources={sources} atsFilter={atsFilter} /></Section>
      <AddCompany />
      <Section title="LinkedIn searches"><LinkedInEditor sources={sources} /></Section>
      <Section title="Other feeds"><Feeds sources={sources} /></Section>
    </div>
  );
}
