import { connection } from 'next/server';
import { CopyButton } from '@/components/comms/CopyButton';
import { CountedTextArea } from '@/components/comms/CountedTextArea';
import { DraftEditor, JobChip, Warnings } from '@/components/comms/DraftEditor';
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { Checkbox, Field, Notice, PageHeader, TabLinks, TextInput } from '@/components/settings/kit';
import { Badge, Card, Empty, LinkButton, timeAgo } from '@/components/ui';
import { hasMail } from '@/lib/env';
import { LINKEDIN_NOTE_MAX, outreachData, safeHttpUrl, type DraftView, type OutreachData } from '@/lib/server-more';
import { addContactAction, messageIntentAction } from './actions';

export const metadata = { title: 'Outreach' };

type Search = Promise<Record<string, string | string[] | undefined>>;
const TABS = ['email', 'linkedin', 'contacts', 'sent'] as const;
type Tab = (typeof TABS)[number];

function EmailDrafts({ drafts }: { drafts: DraftView[] }) {
  if (!drafts.length) {
    return <Empty title="No email drafts">Pursuit drafts outreach and follow-ups when it finds a verified contact for a job you've applied to.</Empty>;
  }
  return (
    <div className="space-y-3">
      {!hasMail() && (
        <Notice tone="warn">Gmail isn't connected, so approved emails will wait in the queue. Setup steps are on the Inbox page.</Notice>
      )}
      {drafts.map((d) => (
        <Card key={d.message.id}>
          <DraftEditor message={d.message} recipient={d.recipient} job={d.job} action={messageIntentAction} />
        </Card>
      ))}
    </div>
  );
}

/** Public people-search URL Kayzee opens himself (Pursuit never loads it). */
function linkedinPeopleSearch(company: string | undefined): string | undefined {
  if (!company) return undefined;
  const q = encodeURIComponent(`recruiter OR talent ${company}`);
  return `https://www.linkedin.com/search/results/people/?keywords=${q}`;
}

function LinkedInNotes({ notes }: { notes: DraftView[] }) {
  return (
    <div className="space-y-3">
      <Notice tone="info" title="You send these yourself">
        Pursuit never logs into LinkedIn or sends messages there: automating your account risks a ban. Copy the note, open the
        search, find the right person and paste it into a connection request. Then mark it sent here.
      </Notice>
      {notes.length === 0 ? (
        <Empty title="No LinkedIn notes">Notes are drafted alongside outreach emails, at most {LINKEDIN_NOTE_MAX} characters each.</Empty>
      ) : (
        notes.map(({ message, job, contact }) => {
          const fieldId = `li-note-${message.id}`;
          const linkedinUrl = safeHttpUrl(contact?.linkedinUrl) ?? linkedinPeopleSearch(contact?.company ?? job?.company);
          return (
            <Card key={message.id}>
              <ActionForm action={messageIntentAction} className="space-y-3">
                <input type="hidden" name="messageId" value={message.id} />
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-faint">
                  <Badge tone="info">LinkedIn note</Badge>
                  <JobChip job={job} />
                  {contact && <span className="text-dim">to {contact.name ?? contact.role ?? 'someone'} at {contact.company}</span>}
                  <span className="ml-auto">{timeAgo(message.createdAt)}</span>
                </div>
                <CountedTextArea id={fieldId} name="body" max={LINKEDIN_NOTE_MAX} defaultValue={message.body} rows={4} aria-label="LinkedIn note" />
                <Warnings guardProblems={message.guardProblems} slopHits={message.slopHits} />
                <div className="flex flex-wrap items-center gap-2">
                  <CopyButton sourceId={fieldId} label="Copy note" variant="primary" />
                  {linkedinUrl ? (
                    <LinkButton href={linkedinUrl} target="_blank" rel="noopener noreferrer" size="sm">Open LinkedIn search</LinkButton>
                  ) : (
                    <span className="text-[12px] text-faint">No LinkedIn link for this contact</span>
                  )}
                  <SubmitButton name="intent" value="linkedin_sent" size="sm" variant="good">Mark sent</SubmitButton>
                  <SubmitButton name="intent" value="save" size="sm" variant="ghost">Save</SubmitButton>
                  <SubmitButton name="intent" value="discard" size="sm" variant="ghost" confirm="Discard this note?">Discard</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          );
        })
      )}
    </div>
  );
}

function Contacts({ contacts }: { contacts: OutreachData['contacts'] }) {
  return (
    <div className="space-y-4">
      <Card pad={false} className="overflow-hidden">
        {contacts.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-faint">No contacts yet. Pursuit adds them from job descriptions and company sites.</div>
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-line text-[11.5px] uppercase tracking-[0.06em] text-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 text-right font-medium">Confidence</th>
                  <th className="px-3 py-2 font-medium">Job</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => {
                  const li = safeHttpUrl(c.linkedinUrl);
                  return (
                    <tr key={c.id} className="border-b border-line last:border-b-0 hover:bg-panel-hover">
                      <td className="px-3 py-2">
                        <div className="text-fg">{c.name ?? <span className="text-faint">Unknown</span>}</div>
                        {c.role && <div className="text-[12px] text-faint">{c.role}</div>}
                      </td>
                      <td className="px-3 py-2 text-dim">{c.company}</td>
                      <td className="px-3 py-2">
                        {c.email ? (
                          <span className="flex items-center gap-1.5">
                            <span className="font-mono text-[12px] text-fg">{c.email}</span>
                            {c.emailVerified ? <Badge tone="good" title="Seen verbatim on a page or in the JD">verified</Badge> : <Badge tone="warn" title="Guessed: never used automatically">unverified</Badge>}
                          </span>
                        ) : li ? (
                          <a href={li} target="_blank" rel="noopener noreferrer" className="text-[12px] text-info hover:underline">LinkedIn</a>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-dim">{c.source}</td>
                      <td className="px-3 py-2 text-right tabular text-dim">{Math.round(c.confidence * 100)}%</td>
                      <td className="max-w-[14rem] px-3 py-2"><JobChip job={c.job} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-[14px] font-semibold text-fg">Add a contact</h2>
        <ActionForm action={addContactAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Company *"><TextInput name="company" required /></Field>
            <Field label="Name"><TextInput name="name" /></Field>
            <Field label="Role"><TextInput name="role" placeholder="Talent Partner" /></Field>
            <Field label="Email"><TextInput name="email" type="email" autoComplete="off" /></Field>
            <Field label="LinkedIn URL"><TextInput name="linkedinUrl" type="url" placeholder="https://www.linkedin.com/in/…" /></Field>
            <Field label="Job id" hint="Optional: links the contact to a job"><TextInput name="jobId" /></Field>
          </div>
          <Checkbox name="verified" label="I've seen this email address written down (on their site, in the JD, or in an email). Never tick this for a guessed address." />
          <SubmitButton size="sm" variant="primary" pendingLabel="Adding…">Add contact</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}

function Sent({ items }: { items: DraftView[] }) {
  if (!items.length) return <Empty title="Nothing sent yet">Approved emails show here once the worker sends them.</Empty>;
  return (
    <Card pad={false} className="divide-y divide-line">
      {items.map(({ message, job }) => (
        <details key={message.id} className="group px-4 py-3">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 [&::-webkit-details-marker]:hidden">
            <Badge tone={message.status === 'sent' ? 'good' : 'bad'}>{message.status === 'sent' ? 'Sent' : 'Failed'}</Badge>
            <Badge>{message.channel === 'linkedin' ? 'LinkedIn' : 'Email'}</Badge>
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{message.subject ?? message.body.slice(0, 80)}</span>
            {message.to && <span className="font-mono text-[11.5px] text-faint">{message.to}</span>}
            <span className="text-[11.5px] text-faint tabular">{timeAgo(message.sentAt ?? message.createdAt)}</span>
          </summary>
          <div className="mt-2 space-y-2">
            <JobChip job={job} />
            {message.error && <div className="text-[12.5px] text-bad">{message.error}</div>}
            <pre className="whitespace-pre-wrap rounded-[var(--radius-sm)] bg-bg-sunk px-3 py-2 font-sans text-[13px] text-dim">{message.body}</pre>
          </div>
        </details>
      ))}
    </Card>
  );
}

export default async function OutreachPage({ searchParams }: { searchParams: Search }) {
  await connection();
  const sp = await searchParams;
  const raw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'email';
  const data = outreachData();
  const tabs = [
    { key: 'email', label: 'Email drafts', href: '/outreach?tab=email', count: data.emailDrafts.length },
    { key: 'linkedin', label: 'LinkedIn notes', href: '/outreach?tab=linkedin', count: data.linkedinNotes.length },
    { key: 'contacts', label: 'Contacts', href: '/outreach?tab=contacts', count: data.contacts.length },
    { key: 'sent', label: 'Sent', href: '/outreach?tab=sent', count: data.sent.length },
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Outreach"
        description="Emails and LinkedIn notes to real people at companies you've applied to. Nothing goes out until you approve it, even in autopilot."
      />
      <TabLinks tabs={tabs} active={tab} label="Outreach sections" />
      {tab === 'email' && <EmailDrafts drafts={data.emailDrafts} />}
      {tab === 'linkedin' && <LinkedInNotes notes={data.linkedinNotes} />}
      {tab === 'contacts' && <Contacts contacts={data.contacts} />}
      {tab === 'sent' && <Sent items={data.sent} />}
    </div>
  );
}
