'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { sendJobChat } from '@/app/jobs/[id]/chat-actions';
import type { JobChatTurn } from '@/engine/jobchat';
import { Button, cx } from '@/components/ui';

export function JobChat({ jobId, company, initial }: { jobId: string; company: string; initial: JobChatTurn[] }) {
  const [turns, setTurns] = useState(initial);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [turns.length, pending]);

  const send = (text: string) => {
    if (!text.trim() || pending) return;
    setError(null);
    setTurns((t) => [...t, { role: 'you', text, ts: new Date().toISOString() }]);
    setDraft('');
    start(async () => {
      const res = await sendJobChat(jobId, text);
      if (res.error) setError(res.error);
      else setTurns(res.turns);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="max-h-[360px] space-y-2.5 overflow-y-auto pr-1 scrollbar-thin">
        {turns.length === 0 && (
          <div className="space-y-2 text-[12.5px] text-faint">
            <p>Ask about this application, or give it details. Answers to its open questions are saved straight away.</p>
            <div className="flex flex-wrap gap-1.5">
              {['How is this one going?', 'What is blocking it?', 'What did you send them?'].map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-dim hover:border-accent hover:text-fg">{s}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={`${t.ts}-${i}`} className={cx('flex flex-col gap-1', t.role === 'you' ? 'items-end' : 'items-start')}>
            <div className={cx('max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13px] leading-relaxed', t.role === 'you' ? 'rounded-br-md bg-accent text-white' : 'rounded-bl-md bg-panel-hover text-fg')}>{t.text}</div>
            {t.saved?.map((s) => <div key={s} className="text-[11.5px] text-good">✓ {s}</div>)}
          </div>
        ))}
        {pending && <div className="text-[12px] text-faint">Thinking…</div>}
        <div ref={end} />
      </div>
      {error && <div className="text-[12px] text-bad">{error}</div>}
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); } }}
          rows={2}
          placeholder={`Ask about ${company}, or add a detail…`}
          className="min-h-[42px] flex-1 resize-none rounded-[var(--radius-sm)] border border-line bg-bg-sunk px-3 py-2 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <Button type="submit" variant="primary" size="sm" disabled={pending || !draft.trim()}>Send</Button>
      </form>
    </div>
  );
}
