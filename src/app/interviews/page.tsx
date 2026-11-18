import { connection } from 'next/server';
import { DraftEditor } from '@/components/comms/DraftEditor';
import { Markdown } from '@/components/comms/Markdown';
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { PageHeader } from '@/components/settings/kit';
import { Badge, Card, Empty, LinkButton, ScoreRing, timeAgo } from '@/components/ui';
import { hasLLM } from '@/lib/env';
import { interviewsData, recipientCheckFor, safeHttpUrl, type InterviewView } from '@/lib/server-more';
import { messageIntentAction } from '../outreach/actions';
import { draftThankYouAction, regeneratePrepAction } from './actions';

export const metadata = { title: 'Interviews' };

function Logistics({ view }: { view: InterviewView }) {
  const { extras, emails } = view;
  const latest = emails[0];
  return (
    <div className="space-y-3 text-[13px]">
      {extras.proposedTimes.length > 0 ? (
        <div>
          <div className="text-[12px] font-medium text-dim">Proposed times</div>
          <ul className="mt-1 space-y-0.5">
            {extras.proposedTimes.map((t) => <li key={t} className="tabular text-fg">{t}</li>)}
          </ul>
        </div>
      ) : (
        <div className="text-faint">No times detected yet. Check the email thread.</div>
      )}
      <div className="flex flex-wrap gap-2">
        {extras.calendarUrl && (
          <LinkButton href={extras.calendarUrl} target="_blank" rel="noopener noreferrer" size="sm" variant="good">Add to Google Calendar</LinkButton>
        )}
        {latest && <LinkButton href={`/inbox?id=${latest.id}`} size="sm">Open email</LinkButton>}
      </div>
      {extras.meetingLinks.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[12px] text-faint">Links from the email (check before opening)</div>
          {extras.meetingLinks.map((l) => (
            <a key={l} href={l} target="_blank" rel="noopener noreferrer nofollow" className="block truncate font-mono text-[11.5px] text-info hover:underline">{l}</a>
          ))}
        </div>
      )}
      {emails.length > 0 && (
        <ul className="space-y-1.5 border-t border-line pt-3">
          {emails.slice(0, 4).map((e) => (
            <li key={e.id} className="text-[12.5px]">
              <a href={`/inbox?id=${e.id}`} className="block truncate text-fg hover:underline">{e.subject || '(no subject)'}</a>
              <div className="truncate text-faint">{e.summary ?? e.snippet} · {timeAgo(e.date)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InterviewCard({ view }: { view: InterviewView }) {
  const { job, prep, thankYou } = view;
  const posting = safeHttpUrl(job.url);
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <ScoreRing score={job.score} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-dim">{job.company}{job.location ? ` · ${job.location}` : ''}</div>
          <a href={`/jobs/${encodeURIComponent(job.id)}`} className="text-[15px] font-semibold text-fg hover:underline">{job.title}</a>
          <div className="mt-0.5 text-[12px] text-faint">Interview stage since {timeAgo(job.updatedAt)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {posting && <LinkButton href={posting} target="_blank" rel="noopener noreferrer" size="sm" variant="ghost">Posting</LinkButton>}
          <ActionForm action={draftThankYouAction} messageClassName="mt-1">
            <input type="hidden" name="jobId" value={job.id} />
            <SubmitButton size="sm" pendingLabel="Drafting…" disabled={thankYou.length > 0} title={thankYou.length ? 'Already drafted' : undefined}>
              Draft thank-you note
            </SubmitButton>
          </ActionForm>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="rounded-[var(--radius-sm)] border border-line bg-bg-elev p-3">
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-dim">Logistics</h3>
          <Logistics view={view} />
        </div>
        <div className="rounded-[var(--radius-sm)] border border-line bg-bg-elev p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-dim">
              Prep pack {prep && <span className="font-normal normal-case tracking-normal text-faint">· v{prep.artifact.version}, {timeAgo(prep.artifact.createdAt)}</span>}
            </h3>
            <ActionForm action={regeneratePrepAction} className="flex flex-col items-end gap-1">
              <input type="hidden" name="jobId" value={job.id} />
              <SubmitButton size="sm" variant={prep ? 'ghost' : 'primary'} pendingLabel="Building… (up to a minute)">
                {prep ? 'Regenerate prep' : 'Build prep pack'}
              </SubmitButton>
            </ActionForm>
          </div>
          {prep ? (
            <details open className="group">
              <summary className="mb-2 cursor-pointer text-[12px] text-faint group-open:hidden">Show prep pack</summary>
              <div className="scrollbar-thin max-h-[36rem] overflow-y-auto pr-1">
                <Markdown source={prep.text} />
              </div>
            </details>
          ) : (
            <p className="text-[13px] text-faint">
              No prep pack yet. It covers a company brief from the posting, likely questions, STAR answers built only from your fact bank, and questions to ask.
            </p>
          )}
        </div>
      </div>

      {thankYou.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-dim">Thank-you note</h3>
          {thankYou.map((m) =>
            m.status === 'sent' || m.status === 'failed' ? (
              <div key={m.id} className="flex items-center gap-2 text-[13px]">
                <Badge tone={m.status === 'sent' ? 'good' : 'bad'}>{m.status === 'sent' ? `Sent ${timeAgo(m.sentAt)}` : 'Failed'}</Badge>
                {m.error && <span className="text-bad">{m.error}</span>}
              </div>
            ) : (
              <div key={m.id} className="rounded-[var(--radius-sm)] border border-line p-3">
                <DraftEditor message={m} recipient={recipientCheckFor(m)} action={messageIntentAction} showJob={false} />
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}

export default async function InterviewsPage() {
  await connection();
  const views = interviewsData();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Interviews"
        description="Jobs at interview stage, with what the employer proposed and a prep pack built only from your real experience."
        actions={!hasLLM() ? <Badge tone="warn" title="Prep packs use a simpler template without an OpenRouter key">LLM off</Badge> : undefined}
      />
      {views.length === 0 ? (
        <Empty title="No interviews yet">
          When an employer invites you to interview, the inbox watcher moves the job here and starts a prep pack. You can also move a job to Interview from the Pipeline.
        </Empty>
      ) : (
        <div className="space-y-4">{views.map((v) => <InterviewCard key={v.job.id} view={v} />)}</div>
      )}
    </div>
  );
}
