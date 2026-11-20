'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import {
  approveAction, dismissAction, findFactsAction, findFactsInDocAction, getAboutState, removeDocAction, rescoreAction, saveAnswerAction,
  type AboutState,
} from '@/app/about/actions';
import type { EvidenceDoc, IntakeEntry, IntakeProposal, IntakeQuestion } from '@/engine/intake';
import { Badge, Button, Card, Section, cx, timeAgo } from '@/components/ui';

type Apply = (next: AboutState) => void;

const TARGET_LABEL: Record<IntakeProposal['target'], string> = { fact: 'Suggested fact', skill: 'Suggested skill', tool: 'Suggested tool' };

function ProposalCard({ p, scope, ownerId, apply }: { p: IntakeProposal; scope: 'answer' | 'doc'; ownerId: string; apply: Apply }) {
  const [text, setText] = useState(p.text);
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  if (p.status !== 'pending') {
    return (
      <div className="rounded-[var(--radius-sm)] border border-line px-3 py-2 text-[12.5px] text-dim">
        <Badge tone={p.status === 'added' ? 'good' : 'neutral'}>{p.status === 'added' ? `Added (${p.target})` : 'Dismissed'}</Badge>{' '}
        <span className={cx(p.status === 'dismissed' && 'line-through')}>{p.text}</span>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-[var(--radius-sm)] border border-accent/40 bg-accent-soft/40 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-accent">{TARGET_LABEL[p.target]}{p.org ? ` · ${p.org}` : ''}</div>
      {editing ? (
        <textarea aria-label="Edit wording" value={text} onChange={(e) => setText(e.target.value)} rows={p.target === 'fact' ? 3 : 1} className="w-full rounded-md border border-line bg-bg-sunk p-2 text-[13px] text-fg" />
      ) : (
        <p className="text-[13px] text-fg">{text}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="good" disabled={pending} onClick={() => start(async () => apply(await approveAction(scope, ownerId, p.key, text)))}>This is true, add it</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit wording'}</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => apply(await dismissAction(scope, ownerId, p.key)))}>Not right, skip</Button>
      </div>
    </div>
  );
}

/** Clicking "find facts" saves anyway, so the blur that click causes must not start a second, competing save. */
function leavingToFind(e: { relatedTarget: EventTarget | null }): boolean {
  return e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset.find === '1';
}

function QuestionCard({ q, entry, llm, apply }: { q: IntakeQuestion; entry?: IntakeEntry; llm: boolean; apply: Apply }) {
  const [answer, setAnswer] = useState(entry?.answer ?? '');
  const [link, setLink] = useState(entry?.link ?? '');
  const [pending, start] = useTransition();
  const [working, setWorking] = useState<'save' | 'find' | null>(null);
  const dirty = answer.trim() !== (entry?.answer ?? '') || link.trim() !== (entry?.link ?? '');
  const proposals = entry?.proposals ?? [];
  const waiting = proposals.filter((p) => p.status === 'pending').length;
  const id = `q-${q.id}`;

  const run = (kind: 'save' | 'find') => {
    setWorking(kind);
    start(async () => {
      apply(await (kind === 'find' ? findFactsAction(q.id, answer, link) : saveAnswerAction(q.id, answer, link)));
      setWorking(null);
    });
  };

  return (
    <div className="space-y-2 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <label htmlFor={id} className="block text-[13.5px] font-medium text-fg">
        {q.gap ? <>Have you done {q.text}?</> : q.text}
      </label>
      {q.hint && <p className="text-[12.5px] text-dim">{q.hint}</p>}
      <textarea
        id={id}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onBlur={(e) => { if (dirty && !pending && !leavingToFind(e)) run('save'); }}
        rows={answer.length > 280 ? 7 : 4}
        placeholder="Write it the way you would say it. Rough notes are fine."
        className="w-full rounded-md border border-line bg-bg-sunk p-2.5 text-[13px] leading-5 text-fg placeholder:text-faint focus:border-accent focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={`Link to evidence for: ${q.text}`}
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onBlur={(e) => { if (dirty && !pending && !leavingToFind(e)) run('save'); }}
          placeholder="Link that shows it (optional)"
          className="min-w-0 flex-1 rounded-md border border-line bg-bg-sunk px-2.5 py-1.5 text-[12.5px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <Button size="sm" variant="primary" data-find="1" disabled={pending || answer.trim().length < 12 || !llm} title={llm ? undefined : 'Needs the AI connection'} onClick={() => run('find')}>
          {working === 'find' ? 'Reading…' : entry?.checkedAt && !dirty ? 'Find facts again' : 'Save and find facts'}
        </Button>
        <span className="text-[12px] text-faint" aria-live="polite">
          {working === 'save' ? 'Saving…' : dirty ? 'Not saved yet' : entry?.updatedAt && entry.answer ? `Saved ${timeAgo(entry.updatedAt)}` : ''}
        </span>
      </div>
      {proposals.length > 0 && (
        <div className="space-y-2 pt-1">
          {waiting > 0 && <p className="text-[12px] text-dim">{waiting} to review. Only what you approve is ever used.</p>}
          {proposals.map((p) => <ProposalCard key={p.key} p={p} scope="answer" ownerId={q.id} apply={apply} />)}
        </div>
      )}
    </div>
  );
}

function fileSize(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function DocRow({ d, llm, apply }: { d: EvidenceDoc; llm: boolean; apply: Apply }) {
  const [pending, start] = useTransition();
  const [reading, setReading] = useState(false);
  return (
    <li className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a href={`/api/evidence?id=${d.id}`} target="_blank" rel="noreferrer" className="block truncate text-[13px] text-fg underline decoration-line underline-offset-2 hover:decoration-accent">{d.name}</a>
          <div className="text-[12px] text-faint">{fileSize(d.size)} · {d.chars ? 'text readable' : 'kept as evidence only'}</div>
        </div>
        <Button size="sm" variant="ghost" disabled={pending} aria-label={`Remove ${d.name}`} onClick={() => start(async () => apply(await removeDocAction(d.id)))}>Remove</Button>
      </div>
      {d.chars > 0 && (
        <Button size="sm" disabled={pending || !llm} onClick={() => { setReading(true); start(async () => { apply(await findFactsInDocAction(d.id)); setReading(false); }); }}>
          {reading ? 'Reading…' : d.checkedAt ? 'Find facts again' : 'Find facts in this file'}
        </Button>
      )}
      {d.proposals.map((p) => <ProposalCard key={p.key} p={p} scope="doc" ownerId={d.id} apply={apply} />)}
    </li>
  );
}

export function AboutForm({ questions, initial, llm, counts }: {
  questions: IntakeQuestion[];
  initial: AboutState;
  llm: boolean;
  counts: { facts: number; skills: number; tools: number };
}) {
  const [state, setState] = useState<AboutState>(initial);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [added, setAdded] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [pending, start] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  const apply: Apply = (next) => {
    setState({ entries: next.entries, docs: next.docs });
    if (next.message) setNote({ text: next.message, ok: next.ok !== false });
    if (next.ok && next.message?.startsWith('Added')) setAdded((n) => n + 1);
  };

  const groups = useMemo(() => {
    const out: { name: string; items: IntakeQuestion[] }[] = [];
    for (const q of questions) {
      const g = out.find((x) => x.name === q.group);
      if (g) g.items.push(q);
      else out.push({ name: q.group, items: [q] });
    }
    return out;
  }, [questions]);

  const answered = questions.filter((q) => (state.entries[q.id]?.answer ?? '').trim().length > 0).length;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      const body = new FormData();
      for (const f of Array.from(files)) body.append('file', f);
      const res = await fetch('/api/evidence', { method: 'POST', headers: { 'x-pursuit': '1' }, body });
      const json = (await res.json().catch(() => ({}))) as { added?: unknown[]; errors?: string[]; error?: string };
      const errors = json.errors?.length ? ` Not added: ${json.errors.join('; ')}.` : '';
      const n = json.added?.length ?? 0;
      setNote({ text: n ? `${n} file${n === 1 ? '' : 's'} added.${errors}` : json.error ?? `Nothing was added.${errors}`, ok: n > 0 });
      const fresh = await getAboutState();
      setState({ entries: fresh.entries, docs: fresh.docs });
    } catch {
      setNote({ text: 'The upload failed. Try again.', ok: false });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        {!llm && <Card><p className="text-[13px] text-warn">The AI connection is off, so Pursuit can save your answers but can&apos;t suggest facts from them yet.</p></Card>}
        {groups.map((g) => (
          <Card key={g.name}>
            <Section title={g.name}>
              <div className="space-y-4">
                {g.items.map((q) => <QuestionCard key={q.id} q={q} entry={state.entries[q.id]} llm={llm} apply={apply} />)}
              </div>
            </Section>
          </Card>
        ))}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        {note && (
          <div role="status" className={cx('rounded-[var(--radius-sm)] border px-3 py-2 text-[12.5px]', note.ok ? 'border-good/40 text-good' : 'border-warn/40 text-warn')}>{note.text}</div>
        )}
        <Card>
          <Section title="Progress">
            <div className="space-y-1 text-[13px] text-dim">
              <div><span className="tabular text-fg">{answered}</span> of {questions.length} questions answered</div>
              <div><span className="tabular text-fg">{counts.facts + added}</span> facts, <span className="tabular text-fg">{counts.skills}</span> skills, <span className="tabular text-fg">{counts.tools}</span> tools on record</div>
            </div>
            <p className="mt-2 text-[12px] text-faint">Answers save when you click away. You don&apos;t have to do it all at once.</p>
          </Section>
        </Card>

        <Card>
          <Section title="Documents">
            <p className="text-[12.5px] text-dim">Certificates, references, reports, screenshots of results. PDF, text, Word or image, up to 20 MB each.</p>
            <input ref={fileInput} id="evidence-files" type="file" multiple accept=".pdf,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.docx" className="sr-only" onChange={(e) => void upload(e.target.files)} />
            <div className="mt-2">
              <Button variant="primary" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? 'Uploading…' : 'Add files'}</Button>
            </div>
            {state.docs.length > 0 ? (
              <ul className="mt-3 space-y-3">
                {state.docs.map((d) => <DocRow key={d.id} d={d} llm={llm} apply={apply} />)}
              </ul>
            ) : <p className="mt-3 text-[12.5px] text-faint">No files yet.</p>}
          </Section>
        </Card>

        <Card>
          <Section title="Use the new facts">
            <p className="text-[12.5px] text-dim">After you approve facts, send your open jobs back to be judged again, including ones turned down in the last two weeks.</p>
            <div className="mt-2">
              <Button size="sm" disabled={pending} onClick={() => start(async () => apply(await rescoreAction()))}>{pending ? 'Working…' : 'Re-judge my jobs'}</Button>
            </div>
          </Section>
        </Card>

        <Card>
          <Section title="Where this goes">
            <ul className="space-y-1.5 text-[12.5px] text-dim">
              <li>Everything stays on this Mac, in Pursuit&apos;s data folder.</li>
              <li>To suggest facts, your answer or the document&apos;s text is sent to the free AI models.</li>
              <li>Leave out other people&apos;s personal details, such as student cases.</li>
            </ul>
          </Section>
        </Card>
      </aside>
    </div>
  );
}
