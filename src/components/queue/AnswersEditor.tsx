'use client';
// Screening answers with inline editing. Saving writes a new 'answers' artifact version; "remember"
// also stores the answer in config/answers.json for future applications.

import { useEffect, useState, useTransition } from 'react';
import { Badge, Button, cx } from '@/components/ui';
import { saveAnswerAction } from '@/app/queue/actions';
import { toast } from '@/components/shell/client';
import type { AnsweredQuestion } from '@/lib/types';

const SOURCE_LABEL: Record<AnsweredQuestion['source'], string> = { bank: 'answer bank', profile: 'profile', llm: 'written from facts', none: 'no answer' };

function AnswerRow({ jobId, q }: { jobId: string; q: AnsweredQuestion }) {
  const blocking = q.needsHuman && !q.answer?.trim();
  const [editing, setEditing] = useState(blocking);
  const [value, setValue] = useState(q.answer ?? '');
  const [remember, setRemember] = useState(true);
  const [pending, start] = useTransition();

  useEffect(() => {
    setValue(q.answer ?? '');
    setEditing(q.needsHuman && !q.answer?.trim());
  }, [q.answer, q.needsHuman]);

  const save = () => {
    start(async () => {
      const res = await saveAnswerAction(jobId, q.id, value, remember);
      if (res.ok) {
        toast({ message: res.message ?? 'Answer saved', tone: 'good' });
        if (value.trim()) setEditing(false);
      } else toast({ message: 'Could not save the answer', tone: 'bad', detail: res.error });
    });
  };

  const inputId = `ans-${jobId}-${q.id}`;
  const options = q.options?.filter((o) => o.trim()) ?? [];
  const long = q.type === 'textarea' || (q.answer?.length ?? 0) > 90;

  return (
    <li className={cx('rounded-[var(--radius-sm)] border p-3', blocking ? 'border-warn/40 bg-warn-soft' : 'border-line bg-bg-sunk/40')}>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor={inputId} className={cx('text-[13px] font-medium', blocking ? 'text-warn' : 'text-fg')}>
          {q.label}
          {q.required && <span className="ml-1 text-faint" title="Required">*</span>}
        </label>
        <div className="flex shrink-0 items-center gap-1.5">
          {q.confirm && <Badge tone="warn" title="This answer bank entry is marked unconfirmed: check the wording">unconfirmed</Badge>}
          <Badge tone={q.source === 'llm' ? 'info' : q.source === 'none' ? 'warn' : 'neutral'}>{SOURCE_LABEL[q.source]}</Badge>
        </div>
      </div>
      {!editing ? (
        <div className="mt-1.5 flex items-start justify-between gap-3">
          <p className="whitespace-pre-wrap text-[13px] text-dim">{q.answer?.trim() || <span className="text-faint">No answer</span>}</p>
          <button type="button" className="shrink-0 text-[12px] text-accent hover:underline" onClick={() => setEditing(true)}>Edit</button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {options.length > 0 && options.length <= 12 ? (
            <select
              id={inputId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none"
            >
              <option value="">Choose…</option>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : long ? (
            <textarea
              id={inputId}
              value={value}
              rows={3}
              onChange={(e) => setValue(e.target.value)}
              className="w-full resize-y rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 py-2 text-[13px] text-fg focus:border-accent focus:outline-none"
              placeholder="Your answer"
            />
          ) : (
            <input
              id={inputId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !pending && save()}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none"
              placeholder="Your answer"
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-[12px] text-dim">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--accent)]" />
              Remember for future applications
            </label>
            <div className="flex gap-1.5">
              {!blocking && <Button size="sm" variant="ghost" onClick={() => { setValue(q.answer ?? ''); setEditing(false); }}>Cancel</Button>}
              <Button size="sm" variant="primary" onClick={save} disabled={pending || value === (q.answer ?? '')}>{pending ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export function AnswersEditor({ jobId, answers }: { jobId: string; answers: AnsweredQuestion[] }) {
  if (!answers.length) return <p className="text-[13px] text-faint">No screening questions captured for this application.</p>;
  const ordered = [...answers].sort((a, b) => Number(b.needsHuman && !b.answer) - Number(a.needsHuman && !a.answer));
  return (
    <ul className="space-y-2">
      {ordered.map((q) => <AnswerRow key={q.id} jobId={jobId} q={q} />)}
    </ul>
  );
}
