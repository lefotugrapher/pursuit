import { connection } from 'next/server';
import { DraftEditor, JobChip } from '@/components/comms/DraftEditor';
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { Notice, PageHeader, TabLinks, type TabItem } from '@/components/settings/kit';
import { Badge, Card, Empty, LinkButton, StatusBadge, cx, timeAgo } from '@/components/ui';
import { hasMail } from '@/lib/env';
import {
  INBOX_KINDS, INBOX_KIND_LABEL, INBOX_KIND_TONE, inboxDetail, inboxKindCounts, inboxList, isEmailKind, recipientCheckFor,
  type InboxDetail, type InboxListRow,
} from '@/lib/server-more';
import type { EmailKind } from '@/lib/types';
import { messageIntentAction, startReplyAction } from '../outreach/actions';
import { setHandledAction } from './actions';

export const metadata = { title: 'Inbox' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function hrefFor(params: { kind?: string; id?: number; all?: boolean }): string {
  const q = new URLSearchParams();
  if (params.kind) q.set('kind', params.kind);
  if (params.all) q.set('all', '1');
  if (params.id !== undefined) q.set('id', String(params.id));
  const s = q.toString();
  return s ? `/inbox?${s}` : '/inbox';
}

function KindBadge({ kind }: { kind?: EmailKind }) {
  const k = kind ?? 'other';
  return <Badge tone={INBOX_KIND_TONE[k]}>{INBOX_KIND_LABEL[k]}</Badge>;
}

function MailSetup() {
  return (
    <Notice tone="warn" title="Gmail isn't connected, so Pursuit can't read replies or send approved emails yet">
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        <li>Turn on <strong className="text-fg">2-Step Verification</strong> for your Google account (Google Account → Security).</li>
        <li>Create an <strong className="text-fg">App password</strong> (Google Account → Security → App passwords), name it &ldquo;Pursuit&rdquo;, and copy the 16 characters.</li>
        <li>
          Add both lines to <code className="rounded bg-bg-sunk px-1 font-mono text-[12px]">.env.local</code> in the Pursuit folder:
          <pre className="mt-1 overflow-x-auto rounded-[var(--radius-sm)] bg-bg-sunk px-3 py-2 font-mono text-[12px] text-fg">{'GMAIL_USER=you@gmail.com\nGMAIL_APP_PASSWORD=abcd efgh ijkl mnop'}</pre>
        </li>
        <li>Restart <code className="font-mono text-[12px]">pnpm dev</code> and <code className="font-mono text-[12px]">pnpm worker</code>. The worker checks the inbox every 10 minutes.</li>
      </ol>
      <p className="mt-2 text-faint">The password stays in .env.local on this Mac. It's never stored in the database or sent to the LLM.</p>
    </Notice>
  );
}

function InboxRow({ row, selected, kind, all }: { row: InboxListRow; selected: boolean; kind?: string; all: boolean }) {
  const { item, job } = row;
  return (
    <li>
      <a
        href={hrefFor({ kind, id: item.id, all })}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'block border-b border-line px-3 py-2.5 transition-colors last:border-b-0',
          selected ? 'bg-accent-soft' : 'hover:bg-panel-hover',
        )}
      >
        <div className="flex items-center gap-2">
          <KindBadge kind={item.kind} />
          <span className={cx('min-w-0 flex-1 truncate text-[12.5px]', item.handled ? 'text-faint' : 'font-medium text-fg')}>{item.from}</span>
          <span className="shrink-0 text-[11.5px] tabular text-faint">{timeAgo(item.date)}</span>
        </div>
        <div className={cx('mt-1 truncate text-[13px]', item.handled ? 'text-dim' : 'text-fg')}>{item.subject || '(no subject)'}</div>
        <div className="mt-0.5 line-clamp-2 text-[12px] text-faint">{item.summary || item.snippet}</div>
        {job && <div className="mt-1.5 truncate text-[11px] text-dim">↳ {job.company} · {job.title}</div>}
      </a>
    </li>
  );
}

function Detail({ detail, kind, all }: { detail: InboxDetail; kind?: string; all: boolean }) {
  const { item, job, replies, extras } = detail;
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={item.kind} />
              {item.confidence !== undefined && <span className="text-[11.5px] text-faint tabular">{Math.round(item.confidence * 100)}% sure</span>}
              {item.handled && <Badge tone="good">Handled</Badge>}
            </div>
            <h2 className="text-[15px] font-semibold leading-snug text-fg">{item.subject || '(no subject)'}</h2>
            <div className="text-[12.5px] text-dim">
              {item.from} · <time dateTime={item.date} title={new Date(item.date).toLocaleString('en-IE')}>{timeAgo(item.date)}</time>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={setHandledAction} hideSuccess>
              <input type="hidden" name="inboxId" value={item.id} />
              <input type="hidden" name="handled" value={item.handled ? '0' : '1'} />
              <SubmitButton size="sm" variant={item.handled ? 'ghost' : 'good'}>{item.handled ? 'Reopen' : 'Mark handled'}</SubmitButton>
            </ActionForm>
            <LinkButton href={hrefFor({ kind, all })} size="sm" variant="ghost" className="lg:hidden">Back</LinkButton>
          </div>
        </div>
        {job && (
          <div className="flex flex-wrap items-center gap-2">
            <JobChip job={job} />
            <StatusBadge status={job.status} />
          </div>
        )}
        {item.summary && <p className="rounded-[var(--radius-sm)] bg-bg-sunk px-3 py-2 text-[13px] text-dim">{item.summary}</p>}
        {(extras.proposedTimes.length > 0 || extras.calendarUrl || extras.meetingLinks.length > 0) && (
          <div className="space-y-2 rounded-[var(--radius-sm)] border border-good/25 bg-good-soft px-3 py-2 text-[12.5px]">
            {extras.proposedTimes.length > 0 && (
              <div>
                <span className="font-medium text-good">Proposed times: </span>
                <span className="text-fg">{extras.proposedTimes.join(' · ')}</span>
              </div>
            )}
            {extras.calendarUrl && (
              <LinkButton href={extras.calendarUrl} target="_blank" rel="noopener noreferrer" size="sm" variant="good">Add to Google Calendar</LinkButton>
            )}
            {extras.meetingLinks.length > 0 && (
              <div className="space-y-0.5">
                <div className="text-faint">Scheduling links in this email (check the address before opening):</div>
                {extras.meetingLinks.map((l) => (
                  <a key={l} href={l} target="_blank" rel="noopener noreferrer nofollow" className="block truncate font-mono text-[11.5px] text-info hover:underline">{l}</a>
                ))}
              </div>
            )}
          </div>
        )}
        <details className="group" open={!replies.length}>
          <summary className="cursor-pointer text-[12px] font-medium text-dim hover:text-fg">Full email</summary>
          {/* Untrusted: rendered as plain text only, never as HTML. */}
          <pre className="scrollbar-thin mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-bg-sunk px-3 py-2.5 font-sans text-[13px] leading-relaxed text-fg">
            {item.body || item.snippet || '(empty)'}
          </pre>
        </details>
      </Card>

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-dim">Reply</h3>
        {replies.length ? (
          replies.map((m) =>
            m.status === 'sent' || m.status === 'failed' ? (
              <Card key={m.id} className="space-y-1 text-[13px]">
                <Badge tone={m.status === 'sent' ? 'good' : 'bad'}>{m.status === 'sent' ? `Sent ${timeAgo(m.sentAt)}` : 'Send failed'}</Badge>
                {m.error && <div className="text-bad">{m.error}</div>}
                <pre className="whitespace-pre-wrap font-sans text-dim">{m.body}</pre>
              </Card>
            ) : (
              <Card key={m.id}>
                <DraftEditor message={m} recipient={recipientCheckFor(m)} action={messageIntentAction} showJob={false} />
              </Card>
            ),
          )
        ) : (
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-dim">No reply drafted. Pursuit drafts replies for interview requests and questions.</span>
            <ActionForm action={startReplyAction} hideSuccess>
              <input type="hidden" name="inboxId" value={item.id} />
              <SubmitButton size="sm">Write a reply</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </section>
    </div>
  );
}

export default async function InboxPage({ searchParams }: { searchParams: Search }) {
  await connection();
  const sp = await searchParams;
  const kindParam = one(sp.kind);
  const kind = isEmailKind(kindParam) ? kindParam : undefined;
  const all = one(sp.all) === '1';
  const selectedId = Number(one(sp.id));
  const mailOn = hasMail();

  const rows = inboxList({ kind, showHandled: all });
  const counts = inboxKindCounts(all);
  const detail = Number.isInteger(selectedId) && selectedId > 0 ? inboxDetail(selectedId) : undefined;

  const tabs: TabItem[] = [
    { key: 'all', label: 'All', href: hrefFor({ all }), count: counts.all },
    ...INBOX_KINDS.filter((k) => counts[k] > 0 || k === kind).map((k) => ({ key: k, label: INBOX_KIND_LABEL[k], href: hrefFor({ kind: k, all }), count: counts[k] })),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inbox"
        description="Replies from employers, classified and linked to jobs. Drafted replies wait here for your approval."
        actions={
          <LinkButton href={all ? hrefFor({ kind }) : hrefFor({ kind, all: true })} size="sm" variant="ghost">
            {all ? 'Hide handled' : 'Show handled'}
          </LinkButton>
        }
      />
      {!mailOn && <MailSetup />}
      <TabLinks tabs={tabs} active={kind ?? 'all'} label="Filter by kind" />

      {rows.length === 0 && !detail ? (
        <Empty title={kind ? `No ${INBOX_KIND_LABEL[kind].toLowerCase()} emails` : all ? 'No emails yet' : 'Inbox zero'}>
          {mailOn
            ? 'New employer emails appear here after the worker checks Gmail (every 10 minutes).'
            : 'Connect Gmail (steps above) and Pursuit will sort employer replies here.'}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card pad={false} className={cx('overflow-hidden', detail && 'hidden lg:block')}>
            {rows.length ? (
              <ul className="scrollbar-thin max-h-[calc(100vh-14rem)] overflow-y-auto">
                {rows.map((r) => <InboxRow key={r.item.id} row={r} selected={r.item.id === detail?.item.id} kind={kind} all={all} />)}
              </ul>
            ) : (
              <div className="p-6 text-center text-[13px] text-faint">Nothing in this filter.</div>
            )}
          </Card>
          <div className="min-w-0">
            {detail ? (
              <Detail detail={detail} kind={kind} all={all} />
            ) : (
              <div className="hidden h-full min-h-48 items-center justify-center rounded-[var(--radius)] border border-dashed border-line text-[13px] text-faint lg:flex">
                Select an email
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
