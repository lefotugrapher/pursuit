'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { addAnswerAction, addFactAction, dismissAction, getCoachThread, resetCoachAction, retailorAction, sendCoachMessage } from '@/app/coach/actions';
import type { CoachTurn, ProposedAnswer, ProposedFact } from '@/engine/coach';
import { Badge, Button, Card, cx } from '@/components/ui';

function FactCard({ p, onChange }: { p: ProposedFact; onChange: (msg: string) => void }) {
  const [text, setText] = useState(p.text);
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  if (p.status !== 'pending') {
    return (
      <div className="rounded-[var(--radius-sm)] border border-line px-3 py-2 text-[12.5px] text-dim">
        <Badge tone={p.status === 'added' ? 'good' : 'neutral'}>{p.status === 'added' ? 'Added to facts' : 'Dismissed'}</Badge>{' '}
        <span className={cx(p.status === 'dismissed' && 'line-through')}>{p.text}</span>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-[var(--radius-sm)] border border-accent/40 bg-accent-soft/40 p-3">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-accent">Suggested fact · {p.kind}{p.org ? ` · ${p.org}` : ''}</div>
      {editing ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-md border border-line bg-bg-sunk p-2 text-[13px] text-fg" />
      ) : (
        <p className="text-[13px] text-fg">{text}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="good" disabled={pending} onClick={() => start(async () => onChange((await addFactAction(p.key, text)).message))}>Add to my facts</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit wording'}</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => onChange((await dismissAction(p.key)).message))}>Not true / skip</Button>
      </div>
    </div>
  );
}

function AnswerCard({ p, onChange }: { p: ProposedAnswer; onChange: (msg: string) => void }) {
  const [pending, start] = useTransition();
  if (p.status !== 'pending') return <div className="text-[12.5px] text-dim"><Badge tone={p.status === 'added' ? 'good' : 'neutral'}>{p.status === 'added' ? 'Answer saved' : 'Dismissed'}</Badge> {p.question}: {p.answer}</div>;
  return (
    <div className="space-y-2 rounded-[var(--radius-sm)] border border-info/40 bg-info-soft p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-info">Screening answer · {p.question}</div>
      <p className="text-[13px] text-fg">{p.answer}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="good" disabled={pending} onClick={() => start(async () => onChange((await addAnswerAction(p.key)).message))}>Save &amp; confirm</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => onChange((await dismissAction(p.key)).message))}>Skip</Button>
      </div>
    </div>
  );
}

export function CoachChat({ initialTurns, llm, readyCount, newFacts }: { initialTurns: CoachTurn[]; llm: boolean; readyCount: number; newFacts: number }) {
  const [turns, setTurns] = useState<CoachTurn[]>(initialTurns);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [addedHere, setAddedHere] = useState(0);
  const [, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, thinking]);

  const send = (message: string) => {
    setThinking(true);
    setNote(null);
    if (message) setTurns((t) => [...t, { role: 'you', text: message, ts: new Date().toISOString() }]);
    start(async () => {
      const res = await sendCoachMessage(message);
      setThinking(false);
      if (res.error) setNote(res.error);
      else setTurns(res.turns);
    });
  };

  // Let the coach open the conversation the first time.
  useEffect(() => {
    if (!opened.current && initialTurns.length === 0 && llm) { opened.current = true; send(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onProposal = (msg: string) => {
    setNote(msg);
    if (/Added to your fact bank/.test(msg)) setAddedHere((n) => n + 1);
    start(async () => setTurns(await getCoachThread()));
  };

  const pendingFacts = newFacts + addedHere;

  return (
    <Card pad={false} className="flex min-h-[70vh] flex-col">
      {!llm && <div className="border-b border-line bg-warn-soft px-4 py-2 text-[13px] text-warn">The coach needs your OpenRouter key in .env.local.</div>}
      {pendingFacts > 0 && readyCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-good-soft px-4 py-2 text-[13px] text-good">
          <span>You added {pendingFacts} new fact{pendingFacts === 1 ? '' : 's'}. Rebuild your {readyCount} queued applications to use them?</span>
          <Button size="sm" variant="good" onClick={() => start(async () => { setNote((await retailorAction()).message); setAddedHere(0); })}>Rebuild applications</Button>
        </div>
      )}
      <div className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
        {turns.map((t, i) => (
          <div key={`${t.ts}-${i}`} className={cx('flex flex-col gap-2', t.role === 'you' ? 'items-end' : 'items-start')}>
            <div className={cx('max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed',
              t.role === 'you' ? 'rounded-br-md bg-accent text-white' : 'rounded-bl-md bg-panel-hover text-fg')}>
              {t.text}
            </div>
            {t.facts?.length ? <div className="w-full max-w-[85%] space-y-2">{t.facts.map((p) => <FactCard key={p.key} p={p} onChange={onProposal} />)}</div> : null}
            {t.answers?.length ? <div className="w-full max-w-[85%] space-y-2">{t.answers.map((p) => <AnswerCard key={p.key} p={p} onChange={onProposal} />)}</div> : null}
          </div>
        ))}
        {thinking && <div className="flex items-center gap-2 text-[13px] text-faint"><span className="h-2 w-2 rounded-full bg-accent animate-pulse-dot" /> Coach is thinking…</div>}
        <div ref={end} />
      </div>
      {note && <div className="border-t border-line px-4 py-2 text-[12.5px] text-dim">{note}</div>}
      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => { e.preventDefault(); const m = draft.trim(); if (!m || thinking) return; setDraft(''); send(m); }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
          rows={2}
          placeholder={llm ? 'Answer the coach, or tell it anything about your work… (Enter to send)' : 'Coach is offline'}
          disabled={!llm}
          className="min-h-[44px] flex-1 resize-none rounded-[var(--radius-sm)] border border-line bg-bg-sunk px-3 py-2 text-[13.5px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <div className="flex flex-col gap-1.5">
          <Button type="submit" variant="primary" disabled={!llm || thinking || !draft.trim()}>Send</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { if (window.confirm('Clear the conversation? Your fact bank stays as it is.')) start(async () => { await resetCoachAction(); setTurns([]); opened.current = false; }); }}>Clear</Button>
        </div>
      </form>
    </Card>
  );
}
