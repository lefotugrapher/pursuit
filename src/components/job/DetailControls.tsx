'use client';
// Interactive controls for /jobs/[id]: status moves, star, regenerate, apply/handoff, notes autosave,
// and outreach draft cards. Every action is a server action that re-validates on the server.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Badge, Button, cx } from '@/components/ui';
import {
  applyNowAction, moveJobAction, regenerateAction, saveNotesAction, setDraftStatusAction, toggleStarAction, updateDraftAction,
} from '@/app/jobs/actions';
import { toast } from '@/components/shell/client';
import { Icon } from '@/components/shell/icons';
import type { ActionResult } from './result';
import { SKIP_REASONS, TRANSITIONS, availableActions, type ManualAction } from './transitions';
import { HandoffButton } from './HandoffButton';
import type { ApprovalGate, DraftView } from '@/components/queue/model';
import type { JobStatus } from '@/lib/types';

function report<T>(res: ActionResult<T>, failTitle: string): boolean {
  if (res.ok) {
    const warn = res.warnings?.length ? res.warnings.slice(0, 3).join(' · ') : undefined;
    toast({ message: res.message ?? 'Done', tone: warn ? 'warn' : 'good', detail: warn });
    return true;
  }
  toast({ message: failTitle, tone: 'bad', detail: res.error });
  return false;
}

const CONFIRM: Partial<Record<ManualAction, string>> = {
  withdraw: 'Withdraw from this job? It leaves every queue and nothing more is sent for it.',
  markRejected: 'Mark this application as rejected?',
  markApplied: 'Mark as applied? Only do this if you submitted it yourself and saw a confirmation.',
};

// ───────────────────────────── Status actions ─────────────────────────────

export function StatusActions({ jobId, status, starred, gate }: { jobId: string; status: JobStatus; starred: boolean; gate: ApprovalGate }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const actions = availableActions(status).filter((a) => a !== 'skip');
  const canSkip = availableActions(status).includes('skip');

  const run = (action: ManualAction, reason?: string) => {
    const question = CONFIRM[action];
    if (question && !window.confirm(question)) return;
    setBusy(action);
    setSkipOpen(false);
    start(async () => {
      report(await moveJobAction(jobId, action, reason), `${TRANSITIONS[action].label} failed`);
      setBusy(null);
    });
  };

  const star = () => start(async () => {
    setBusy('star');
    const res = await toggleStarAction(jobId);
    if (!res.ok) toast({ message: 'Could not star', tone: 'bad', detail: res.error });
    setBusy(null);
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {actions.map((a) => {
        const rule = TRANSITIONS[a];
        const blocked = a === 'approve' && !gate.ok;
        return (
          <Button
            key={a}
            size="sm"
            variant={rule.tone}
            disabled={pending || blocked}
            title={blocked ? gate.reason : undefined}
            onClick={() => run(a)}
          >
            {busy === a ? '…' : rule.label}
          </Button>
        );
      })}
      {canSkip && (
        <div className="relative">
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => setSkipOpen((o) => !o)} aria-haspopup="menu" aria-expanded={skipOpen}>
            Skip <Icon name="down" size={12} />
          </Button>
          {skipOpen && (
            <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-48 animate-[pop-in_120ms_ease-out] rounded-[var(--radius)] border border-line-strong bg-bg-elev p-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)]">
              {SKIP_REASONS.map((r) => (
                <button key={r.id} role="menuitem" type="button" onClick={() => run('skip', r.id)} className="block w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-panel-hover">
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={star} disabled={pending} aria-pressed={starred} title={starred ? 'Unstar' : 'Star'}>
        <Icon name="star" size={14} className={starred ? 'fill-warn text-warn' : ''} /> {starred ? 'Starred' : 'Star'}
      </Button>
    </div>
  );
}

// ───────────────────────────── Regenerate ─────────────────────────────

const REGEN: { what: 'cv' | 'letter' | 'answers'; label: string; hint: string }[] = [
  { what: 'cv', label: 'Regenerate CV', hint: 'Re-tailor from your fact bank, compile with tectonic, re-run the ATS check' },
  { what: 'letter', label: 'Regenerate letter', hint: 'New cover letter, truth-guarded and slop-linted' },
  { what: 'answers', label: 'Regenerate answers', hint: 'Re-answer screening questions from your answer bank' },
];

export function RegenerateButtons({ jobId }: { jobId: string }) {
  const [running, setRunning] = useState<string | null>(null);
  const [, start] = useTransition();
  return (
    <div className="flex flex-wrap gap-1.5">
      {REGEN.map((r) => (
        <Button
          key={r.what}
          size="sm"
          variant="secondary"
          title={r.hint}
          disabled={running !== null}
          onClick={() => {
            setRunning(r.what);
            start(async () => {
              report(await regenerateAction(jobId, r.what), `${r.label} failed`);
              setRunning(null);
            });
          }}
        >
          <Icon name="refresh" size={13} className={running === r.what ? 'animate-spin' : ''} />
          {running === r.what ? 'Working…' : r.label}
        </Button>
      ))}
    </div>
  );
}

// ───────────────────────────── Apply ─────────────────────────────

export function ApplyPanel({ jobId, company, status, paused, gate, automatable, hasCv }: {
  jobId: string;
  company: string;
  status: JobStatus;
  paused: boolean;
  gate: ApprovalGate;
  automatable: boolean;
  hasCv: boolean;
}) {
  const [pending, start] = useTransition();
  const closed = ['applied', 'replied', 'interview', 'offer', 'withdrawn', 'rejected'].includes(status);
  const applyable = ['ready', 'approved', 'needs_you', 'failed'].includes(status);
  // The gate is computed for a 'ready' job; here only its CV + questions verdict matters.
  const gateProblem = !hasCv ? 'No CV PDF yet: regenerate the CV first.' : gate.blocking > 0 && automatable ? `${gate.blocking} screening question${gate.blocking === 1 ? '' : 's'} still need your answer.` : null;
  const applyBlocked = paused ? 'Paused: resume to submit.' : !automatable ? 'This form type is hand-off only: use Fill & hand off.' : !applyable ? `Not available while the job is ${status.replace('_', ' ')}.` : gateProblem;

  const applyNow = () => {
    if (!window.confirm(`Submit this application to ${company} now?\n\nThis is a real submission. Pursuit fills the form, submits, and marks it applied only after the site shows a confirmation.`)) return;
    start(async () => {
      toast({ message: 'Submitting…', detail: 'Running headless Chrome. This can take a minute.', durationMs: 4000 });
      report(await applyNowAction(jobId), 'Apply failed');
    });
  };

  if (closed) return <p className="text-[13px] text-dim">This job is {status}. No application actions left.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={applyNow} disabled={pending || Boolean(applyBlocked)} title={applyBlocked ?? 'Fill and submit headlessly'}>
          <Icon name="bolt" size={14} /> {pending ? 'Submitting…' : 'Apply now'}
        </Button>
        <HandoffButton jobId={jobId} label="Fill & hand off" size="md" />
      </div>
      <p className="text-[12px] text-faint">
        {applyBlocked ?? 'Apply now submits headlessly and needs a visible confirmation to count.'} Fill &amp; hand off opens a separate Chrome window and never submits.
      </p>
    </div>
  );
}

// ───────────────────────────── Notes ─────────────────────────────

export function NotesEditor({ jobId, initial }: { jobId: string; initial: string }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saved = useRef(initial);

  useEffect(() => {
    if (text === saved.current) return;
    const t = setTimeout(async () => {
      setState('saving');
      const res = await saveNotesAction(jobId, text);
      if (res.ok) {
        saved.current = text;
        setState('saved');
      } else {
        setState('error');
        toast({ message: 'Notes not saved', tone: 'bad', detail: res.error });
      }
    }, 800);
    return () => clearTimeout(t);
  }, [text, jobId]);

  return (
    <div className="space-y-1.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Private notes: who you spoke to, what to mention, deadlines…"
        aria-label="Notes"
        className="w-full resize-y rounded-[var(--radius-sm)] border border-line bg-bg-sunk/60 px-3 py-2.5 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
      />
      <div className="h-4 text-right text-[11px] text-faint" aria-live="polite">
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? <span className="text-bad">Not saved</span> : ''}
      </div>
    </div>
  );
}

// ───────────────────────────── Drafts ─────────────────────────────

const KIND_LABEL: Record<string, string> = {
  outreach: 'Outreach email', follow_up: 'Follow-up', reply: 'Reply', linkedin_note: 'LinkedIn note', digest: 'Digest', thank_you: 'Thank-you',
};

export function DraftCard({ draft, jobId, linkedinUrl }: { draft: DraftView; jobId: string; linkedinUrl?: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body);
  const [pending, start] = useTransition();
  const editable = draft.status === 'draft' || draft.status === 'approved';
  const warnings = [...(draft.guardProblems ?? []), ...(draft.slopHits ?? [])];

  useEffect(() => {
    setSubject(draft.subject ?? '');
    setBody(draft.body);
  }, [draft.subject, draft.body]);

  const save = () => start(async () => {
    if (report(await updateDraftAction(draft.id, subject, body, jobId), 'Could not save the draft')) setEditing(false);
  });
  const setStatus = (next: 'approved' | 'discarded') => {
    if (next === 'discarded' && !window.confirm('Discard this draft?')) return;
    start(async () => {
      report(await setDraftStatusAction(draft.id, next, jobId), next === 'approved' ? 'Could not approve' : 'Could not discard');
      router.refresh();
    });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      toast({ message: 'Copied to clipboard', tone: 'good' });
    } catch {
      toast({ message: 'Copy failed: select the text and copy it manually', tone: 'warn' });
    }
  };

  return (
    <div className={cx('rounded-[var(--radius-sm)] border p-3', draft.status === 'approved' ? 'border-accent/40 bg-accent-soft/40' : 'border-line bg-bg-sunk/40')}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <Badge tone={draft.channel === 'linkedin' ? 'info' : 'neutral'}>{KIND_LABEL[draft.kind] ?? draft.kind}</Badge>
        <Badge tone={draft.status === 'sent' ? 'good' : draft.status === 'approved' ? 'accent' : draft.status === 'failed' ? 'bad' : 'neutral'}>{draft.status}</Badge>
        {draft.to && <span className="truncate text-dim">to {draft.to}</span>}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          {draft.channel === 'email' && (
            <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" className="h-8 w-full rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none" />
          )}
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} aria-label="Message" className="w-full resize-y rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 py-2 text-[13px] leading-relaxed text-fg focus:border-accent focus:outline-none" />
          {draft.channel === 'linkedin' && <div className={cx('text-right text-[11px] tabular', body.length > 300 ? 'text-warn' : 'text-faint')}>{body.length}/300</div>}
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setBody(draft.body); setSubject(draft.subject ?? ''); }} disabled={pending}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={save} disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      ) : (
        <>
          {draft.subject && <div className="mt-2 text-[13px] font-medium text-fg">{draft.subject}</div>}
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-dim">{draft.body}</p>
        </>
      )}
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 rounded-[var(--radius-sm)] bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {editable && !editing && (
        <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setStatus('discarded')} disabled={pending}>Discard</Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={pending}><Icon name="edit" size={12} /> Edit</Button>
          {draft.channel === 'linkedin' ? (
            <>
              <Button size="sm" variant="secondary" onClick={copy}>Copy</Button>
              {linkedinUrl && (
                <a href={linkedinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] bg-accent px-2.5 text-[12px] font-medium text-white hover:bg-accent-strong">
                  Open LinkedIn <Icon name="external" size={12} />
                </a>
              )}
            </>
          ) : draft.status === 'draft' ? (
            <Button size="sm" variant="primary" onClick={() => setStatus('approved')} disabled={pending || !draft.to || Boolean(draft.guardProblems?.length)} title={!draft.to ? 'No recipient' : draft.guardProblems?.length ? 'Fix truth-guard problems first' : 'Approve: the worker sends it (respecting pause + daily cap)'}>
              Approve to send
            </Button>
          ) : (
            <span className="self-center text-[12px] text-accent">Approved: sends on the next worker pass</span>
          )}
        </div>
      )}
    </div>
  );
}
