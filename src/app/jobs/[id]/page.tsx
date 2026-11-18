// /jobs/[id]: everything about one job: status actions, score, artifacts, apply/handoff, outreach,
// notes and timeline.

import { JobChat } from '@/components/job/JobChat';
import { loadJobChat } from '@/engine/jobchat';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, cx, timeAgo } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { JobHeader } from '@/components/job/JobHeader';
import { Timeline } from '@/components/job/Timeline';
import { ApplyPanel, DraftCard, NotesEditor, RegenerateButtons, StatusActions } from '@/components/job/DetailControls';
import { AUTOMATABLE_ATS, postingUrl, safeLinkedInUrl } from '@/components/job/format';
import { AnswersEditor } from '@/components/queue/AnswersEditor';
import { AtsReportView, JobDescription, KeywordCoverageView, Panel, ScoreBreakdown, SignalList } from '@/components/queue/Insights';
import { LetterEditor } from '@/components/queue/LetterEditor';
import type { DraftView } from '@/components/queue/model';
import { getJobDetail, type ArtifactGroup } from '@/lib/server';
import { getJob } from '@/lib/db';
import type { Application, ArtifactKind } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  try {
    const job = getJob(decodeURIComponent(id));
    return { title: job ? `${job.title} · ${job.company}` : 'Job' };
  } catch {
    return { title: 'Job' };
  }
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  cv_pdf: 'CV (PDF)', cv_tex: 'CV (LaTeX)', cover_letter: 'Cover letter', answers: 'Screening answers', ats_report: 'ATS report',
  compile_log: 'Compile log', prep: 'Interview prep', screenshot: 'Screenshot',
};

function ArtifactRow({ group }: { group: ArtifactGroup }) {
  const [latest, ...older] = group.versions;
  const link = (id: number, text: string) =>
    group.servable[id]
      ? <a href={`/api/artifact/${id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{text}<Icon name="external" size={11} /></a>
      : <span className="text-faint" title="File missing on disk">{text} (missing)</span>;
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3 text-[13px]">
        <Icon name="file" size={14} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-fg">{KIND_LABEL[group.kind]}</span>
        <span className="text-[12px] tabular text-faint" suppressHydrationWarning>v{latest.version} · {timeAgo(latest.createdAt)}</span>
        <span className="text-[12px]">{link(latest.id, 'Open')}</span>
      </div>
      {older.length > 0 && (
        <details className="ml-7 mt-1 text-[12px]">
          <summary className="cursor-pointer text-faint hover:text-dim">{older.length} older version{older.length === 1 ? '' : 's'}</summary>
          <ul className="mt-1 space-y-0.5">
            {older.map((a) => (
              <li key={a.id} className="flex items-center gap-3 text-dim">
                <span className="tabular">v{a.version}</span>
                <span className="text-faint" suppressHydrationWarning>{timeAgo(a.createdAt)}</span>
                {link(a.id, 'Open')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

const APP_TONE: Record<Application['status'], 'good' | 'warn' | 'bad' | 'neutral'> = { submitted: 'good', needs_you: 'warn', failed: 'bad', started: 'neutral' };

export default async function JobDetailPage({ params }: Params) {
  const { id } = await params;
  const detail = await getJobDetail(decodeURIComponent(id));
  if (!detail) notFound();
  const { job } = detail;
  const url = postingUrl(job);
  const automatable = AUTOMATABLE_ATS.includes(job.ats);
  const contactById = new Map(detail.contacts.map((c) => [c.id, c]));
  const drafts: DraftView[] = detail.messages
    .filter((m) => m.direction === 'out' && m.status !== 'discarded')
    .map((m) => ({ id: m.id, channel: m.channel, kind: m.kind, to: m.to, subject: m.subject, body: m.body, guardProblems: m.guardProblems, slopHits: m.slopHits, status: m.status }));
  const linkedinFor = (d: DraftView) => {
    const msg = detail.messages.find((m) => m.id === d.id);
    const contact = msg?.contactId ? contactById.get(msg.contactId) : undefined;
    return safeLinkedInUrl(contact?.linkedinUrl ?? detail.contacts.find((c) => c.linkedinUrl)?.linkedinUrl);
  };

  return (
    <div className="space-y-5">
      <nav className="flex items-center gap-2 text-[12px] text-faint">
        <Link href="/jobs" className="inline-flex items-center gap-1 hover:text-fg"><Icon name="left" size={12} /> Jobs</Link>
        {job.status === 'ready' && <><span>·</span><Link href="/queue" className="hover:text-fg">Queue</Link></>}
      </nav>

      <Card className="p-4 md:p-5">
        <JobHeader
          job={job}
          showStatus
          actions={url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] text-dim hover:text-accent">
              Posting <Icon name="external" size={12} />
            </a>
          ) : undefined}
        />
        {job.status === 'needs_you' && (
          <div className="mt-4 rounded-[var(--radius-sm)] border border-warn/30 bg-warn-soft px-3 py-2.5 text-[13px] text-warn">
            <div className="font-medium">Needs you</div>
            {job.needs?.length ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-4">{job.needs.map((n, i) => <li key={i}>{n}</li>)}</ul>
            ) : <p className="mt-0.5">No reason recorded.</p>}
          </div>
        )}
        <div className="mt-4 border-t border-line pt-4">
          <StatusActions jobId={job.id} status={job.status} starred={Boolean(job.starred)} gate={detail.gate} />
          {job.status === 'ready' && !detail.gate.ok && <p className="mt-2 text-[12px] text-warn">{detail.gate.reason}</p>}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 space-y-5">
          <Panel title="Ask about this application">
            <JobChat jobId={job.id} company={job.company} initial={loadJobChat(job.id)} />
          </Panel>
          <Panel title="Apply">
            <ApplyPanel
              jobId={job.id}
              company={job.company}
              status={job.status}
              paused={detail.paused}
              gate={detail.gate}
              automatable={automatable}
              hasCv={detail.cvPdfId !== null}
            />
            {detail.applications.length > 0 && (
              <ul className="mt-4 divide-y divide-line border-t border-line">
                {detail.applications.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
                    <Badge tone={APP_TONE[a.status]}>{a.status.replace('_', ' ')}</Badge>
                    <span className="text-dim">{a.method}</span>
                    <span className="text-faint" suppressHydrationWarning>{timeAgo(a.submittedAt ?? a.startedAt)}</span>
                    {a.confirmation && <span className="min-w-0 flex-1 truncate text-faint" title={a.confirmation}>{a.confirmation}</span>}
                    {a.error && <span className="min-w-0 flex-1 truncate text-bad" title={a.error}>{a.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Artifacts" aside={<RegenerateButtons jobId={job.id} />}>
            {detail.artifactGroups.length === 0 ? (
              <p className="text-[13px] text-faint">Nothing generated yet. Tailoring runs after scoring, or regenerate above.</p>
            ) : (
              <ul className="divide-y divide-line">{detail.artifactGroups.map((g) => <ArtifactRow key={g.kind} group={g} />)}</ul>
            )}
          </Panel>

          {detail.cvPdfId && (
            <Panel title="CV preview" aside={<a href={`/api/artifact/${detail.cvPdfId}`} target="_blank" rel="noreferrer" className="text-[12px] text-faint hover:text-fg">Open PDF ↗</a>}>
              <iframe src={`/api/artifact/${detail.cvPdfId}#view=FitH&toolbar=0`} title="Tailored CV" className="h-[70vh] w-full rounded-[var(--radius-sm)] border border-line bg-white" />
            </Panel>
          )}

          <Panel title="Cover letter">
            <LetterEditor jobId={job.id} letter={detail.letter} rows={14} />
          </Panel>

          <Panel title="Screening answers" aside={detail.gate.blocking > 0 ? <Badge tone="warn">{detail.gate.blocking} need you</Badge> : undefined}>
            <AnswersEditor jobId={job.id} answers={detail.answers} />
          </Panel>

          <Panel title="Job description">
            <JobDescription job={job} />
          </Panel>
        </div>

        <div className="min-w-0 space-y-5">
          <Panel title="Score" aside={job.score != null ? <span className="text-[13px] font-semibold tabular text-fg">{Math.round(job.score)}/100</span> : undefined}>
            <ScoreBreakdown detail={job.scoreDetail} />
            {(job.scoreDetail?.reasons.length || detail.flags.length) ? (
              <div className="mt-4 border-t border-line pt-3"><SignalList reasons={job.scoreDetail?.reasons ?? []} flags={detail.flags} /></div>
            ) : null}
          </Panel>

          {job.filters && (
            <Panel title="Hard filters" aside={<Badge tone={job.filters.pass ? 'good' : 'bad'}>{job.filters.pass ? 'passed' : 'rejected'}</Badge>}>
              {job.filters.rejected.length === 0 && job.filters.flags.length === 0 ? (
                <p className="text-[13px] text-dim">No rejections or warnings.</p>
              ) : (
                <ul className="space-y-1 text-[13px]">
                  {job.filters.rejected.map((r, i) => <li key={`r${i}`} className="text-bad">✕ {r}</li>)}
                  {job.filters.flags.map((f, i) => <li key={`f${i}`} className="text-warn">! {f}</li>)}
                </ul>
              )}
            </Panel>
          )}

          <Panel title="Keyword coverage"><KeywordCoverageView coverage={job.keywords} /></Panel>
          <Panel title="ATS check"><AtsReportView report={detail.ats} /></Panel>

          <Panel title="Contacts & drafts" aside={<Link href="/outreach" className="text-[12px] text-faint hover:text-accent">Outreach →</Link>}>
            {detail.contacts.length === 0 && drafts.length === 0 ? (
              <p className="text-[13px] text-faint">No contacts found for this job yet.</p>
            ) : (
              <div className="space-y-3">
                {detail.contacts.length > 0 && (
                  <ul className="space-y-1.5">
                    {detail.contacts.map((c) => {
                      const li = safeLinkedInUrl(c.linkedinUrl);
                      return (
                        <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                          <span className="text-fg">{c.name ?? c.role ?? 'Contact'}</span>
                          {c.name && c.role && <span className="text-faint">{c.role}</span>}
                          {c.email && <span className={cx('text-dim', !c.emailVerified && 'italic')} title={c.emailVerified ? 'Seen verbatim on a page' : 'Unverified: never used automatically'}>{c.email}</span>}
                          {c.email && !c.emailVerified && <Badge tone="warn">unverified</Badge>}
                          {li && <a href={li} target="_blank" rel="noopener noreferrer" className="text-[12px] text-accent hover:underline">LinkedIn ↗</a>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {drafts.map((d) => <DraftCard key={d.id} draft={d} jobId={job.id} linkedinUrl={linkedinFor(d)} />)}
              </div>
            )}
          </Panel>

          <Panel title="Notes"><NotesEditor jobId={job.id} initial={job.notes ?? ''} /></Panel>

          <Panel title="Timeline">
            <Timeline events={detail.timeline} empty="No events recorded." />
          </Panel>
        </div>
      </div>
    </div>
  );
}
