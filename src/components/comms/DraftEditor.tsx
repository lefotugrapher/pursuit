// Editable outbound email draft: to / subject / body, truth-guard + slop warnings, recipient
// verification, and Save / Approve & send / Discard. Approve only marks the message 'approved';
// the worker sends it (respecting pause + caps). Server component; the form itself is ActionForm.
import { Badge, timeAgo } from '@/components/ui';
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import type { FormAction } from '@/components/settings/action-result';
import { Field, TextArea, TextInput } from '@/components/settings/kit';
import type { RecipientCheck } from '@/lib/server-more';
import type { Job, Message } from '@/lib/types';

const KIND_LABEL: Record<Message['kind'], string> = {
  outreach: 'Outreach', follow_up: 'Follow-up', reply: 'Reply', linkedin_note: 'LinkedIn note', digest: 'Digest', thank_you: 'Thank-you',
};

export function JobChip({ job }: { job?: Pick<Job, 'id' | 'company' | 'title'> }) {
  if (!job) return null;
  return (
    <a
      href={`/jobs/${encodeURIComponent(job.id)}`}
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-line bg-panel-hover px-2 py-0.5 text-[11px] text-dim hover:border-line-strong hover:text-fg"
      title={`${job.title} at ${job.company}`}
    >
      <span className="truncate">{job.company} · {job.title}</span>
    </a>
  );
}

export function Warnings({ guardProblems, slopHits }: { guardProblems?: string[]; slopHits?: string[] }) {
  const guard = guardProblems ?? [];
  const slop = slopHits ?? [];
  if (!guard.length && !slop.length) return null;
  return (
    <div className="space-y-1.5 rounded-[var(--radius-sm)] border border-warn/25 bg-warn-soft px-3 py-2 text-[12px]">
      {guard.length > 0 && (
        <div>
          <div className="font-medium text-warn">Truth guard: {guard.length} claim{guard.length === 1 ? '' : 's'} not backed by your fact bank</div>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-dim">{guard.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {slop.length > 0 && (
        <div>
          <div className="font-medium text-warn">Style: {slop.length} AI-sounding pattern{slop.length === 1 ? '' : 's'}</div>
          <div className="mt-0.5 flex flex-wrap gap-1">{slop.map((s, i) => <Badge key={i} tone="warn">{s}</Badge>)}</div>
        </div>
      )}
      <div className="text-faint">Checked when the draft was written; edit the text to fix before approving.</div>
    </div>
  );
}

export function DraftEditor({ message, recipient, job, action, showJob = true }: {
  message: Message;
  recipient: RecipientCheck;
  job?: Pick<Job, 'id' | 'company' | 'title'>;
  action: FormAction;
  showJob?: boolean;
}) {
  const approved = message.status === 'approved';
  const warningCount = (message.guardProblems?.length ?? 0) + (message.slopHits?.length ?? 0);
  const fieldId = `msg-${message.id}`;
  return (
    <ActionForm action={action} className="space-y-3" id={`${fieldId}-form`}>
      <input type="hidden" name="messageId" value={message.id} />
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-faint">
        <Badge tone="accent">{KIND_LABEL[message.kind]}</Badge>
        {approved && <Badge tone="good">Approved · queued to send</Badge>}
        {message.status === 'draft' && <Badge>Draft</Badge>}
        {message.attachCv && <Badge tone="info">CV attached</Badge>}
        {showJob && <JobChip job={job} />}
        <span className="ml-auto">{timeAgo(message.createdAt)}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="To"
          hint={<span className={recipient.verified ? 'text-good' : 'text-warn'}>{recipient.verified ? '✓ ' : ''}{recipient.reason}</span>}
        >
          <TextInput name="to" type="email" defaultValue={message.to ?? ''} placeholder="name@company.com" autoComplete="off" />
        </Field>
        <Field label="Subject">
          <TextInput name="subject" defaultValue={message.subject ?? ''} maxLength={300} />
        </Field>
      </div>
      <Field label="Message">
        <TextArea id={`${fieldId}-body`} name="body" defaultValue={message.body} rows={Math.min(18, Math.max(7, message.body.split('\n').length + 1))} />
      </Field>
      <Warnings guardProblems={message.guardProblems} slopHits={message.slopHits} />
      <div className="flex flex-wrap items-center gap-2">
        {approved ? (
          <SubmitButton name="intent" value="unapprove" size="sm" variant="secondary">Pull back to draft</SubmitButton>
        ) : (
          <SubmitButton
            name="intent"
            value="approve"
            size="sm"
            variant="primary"
            disabled={!recipient.verified}
            title={recipient.verified ? 'Approve: the worker sends it on its next pass' : recipient.reason}
            confirm={warningCount ? `This draft has ${warningCount} warning${warningCount === 1 ? '' : 's'}. Approve it anyway?` : undefined}
            pendingLabel="Approving…"
          >
            Approve &amp; send
          </SubmitButton>
        )}
        <SubmitButton name="intent" value="save" size="sm" pendingLabel="Saving…">Save</SubmitButton>
        <SubmitButton name="intent" value="discard" size="sm" variant="ghost" confirm="Discard this draft?">Discard</SubmitButton>
        {!recipient.verified && !approved && (
          <span className="text-[12px] text-faint">Approve unlocks once the recipient is a verified address.</span>
        )}
      </div>
    </ActionForm>
  );
}
