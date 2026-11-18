// Settings: fact bank (JSON editor + readable view) and answer bank (inline editor).
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { Field, Notice, Select, TextArea, TextInput } from '@/components/settings/kit';
import { Badge, Card, cx } from '@/components/ui';
import { addAnswerAction, answerRowAction, factsAction } from '@/app/settings/actions';
import { groupFacts } from '@/lib/server-more';
import type { AnswerBank, AnswerEntry, Fact, FactBank } from '@/lib/types';

const FACT_KIND_LABEL: Record<Fact['kind'], string> = {
  summary: 'Summaries', role: 'Roles', achievement: 'Achievements', project: 'Projects', education: 'Education',
  award: 'Awards', skill: 'Skills', tool: 'Tools', other: 'Other',
};

function dates(f: Fact): string | undefined {
  if (!f.start && f.end === undefined) return undefined;
  return `${f.start ?? '?'} to ${f.end === null ? 'present' : f.end ?? '?'}`;
}

function FactList({ bank }: { bank: FactBank }) {
  return (
    <div className="space-y-5">
      {groupFacts(bank.facts).map(({ kind, facts }) => (
        <section key={kind} className="space-y-2">
          <h4 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
            {FACT_KIND_LABEL[kind]} <span className="tabular font-normal">{facts.length}</span>
          </h4>
          <ul className="divide-y divide-line rounded-[var(--radius-sm)] border border-line">
            {facts.map((f) => (
              <li key={f.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint">
                  <span className="font-mono text-dim">{f.id}</span>
                  {(f.org || f.title) && <span>{[f.title, f.org].filter(Boolean).join(' · ')}</span>}
                  {dates(f) && <span className="tabular">{dates(f)}</span>}
                </div>
                <p className="text-[13px] text-fg">{f.text}</p>
                {(f.tags.length > 0 || (f.numbers?.length ?? 0) > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {f.tags.map((t) => <Badge key={t}>{t}</Badge>)}
                    {f.numbers?.map((n) => <Badge key={`n-${n}`} tone="info" title="Number that may be quoted">{n}</Badge>)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Chips({ items, tone }: { items: string[]; tone?: 'bad' | 'neutral' | 'good' }) {
  if (!items.length) return <span className="text-[12.5px] text-faint">None</span>;
  return <div className="flex flex-wrap gap-1">{items.map((x) => <Badge key={x} tone={tone}>{x}</Badge>)}</div>;
}

export function FactsPanel({ bank, error }: { bank?: FactBank; error?: string }) {
  const json = bank ? JSON.stringify(bank, null, 2) : '';
  return (
    <div className="space-y-4">
      <Notice tone="info" title="The only source of truth">
        Every claim in a CV, letter or email must cite a fact here. Keywords a job asks for that aren&apos;t backed by a fact are shown to
        you as gaps and never claimed. Add something only if it&apos;s true and you could talk about it in an interview.
      </Notice>
      {error && <Notice tone="bad" title="config/facts.json can't be loaded">{error}</Notice>}

      {bank && (
        <div className="grid gap-3 md:grid-cols-3">
          <Card className="space-y-2">
            <h3 className="text-[13px] font-semibold text-fg">Claimable skills <span className="tabular font-normal text-faint">{bank.skills.length}</span></h3>
            <Chips items={bank.skills} tone="good" />
          </Card>
          <Card className="space-y-2">
            <h3 className="text-[13px] font-semibold text-fg">Claimable tools <span className="tabular font-normal text-faint">{bank.tools.length}</span></h3>
            <Chips items={bank.tools} tone="good" />
          </Card>
          <Card className="space-y-2">
            <h3 className="text-[13px] font-semibold text-fg">Never claim <span className="tabular font-normal text-faint">{bank.doNotClaim.length}</span></h3>
            <Chips items={bank.doNotClaim} tone="bad" />
          </Card>
        </div>
      )}

      <Card>
        <h3 className="mb-1 text-[14px] font-semibold text-fg">Edit as JSON</h3>
        <p className="mb-3 text-[12.5px] text-dim">Validate checks the schema and duplicate ids without saving. Save writes config/facts.json. Existing drafts aren&apos;t rewritten.</p>
        <ActionForm action={factsAction} className="space-y-3">
          <TextArea
            name="json"
            defaultValue={json}
            rows={22}
            spellCheck={false}
            aria-label="Fact bank JSON"
            className="font-mono text-[12px] leading-[1.55]"
          />
          <div className="flex gap-2">
            <SubmitButton name="intent" value="validate" size="sm" pendingLabel="Checking…">Validate</SubmitButton>
            <SubmitButton name="intent" value="save" size="sm" variant="primary" pendingLabel="Saving…" confirm="Save the fact bank? Future CVs and letters can only claim what's in it.">Save</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      {bank && (
        <>
          {Object.keys(bank.summaries).length > 0 && (
            <Card className="space-y-3">
              <h3 className="text-[14px] font-semibold text-fg">CV summary variants</h3>
              <dl className="space-y-2">
                {Object.entries(bank.summaries).map(([k, v]) => (
                  <div key={k}>
                    <dt className="font-mono text-[11.5px] text-dim">{k}</dt>
                    <dd className="text-[13px] text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
          <Card>
            <h3 className="mb-3 text-[14px] font-semibold text-fg">Facts <span className="tabular font-normal text-faint">{bank.facts.length}</span></h3>
            <FactList bank={bank} />
          </Card>
        </>
      )}
    </div>
  );
}

const TYPE_OPTIONS: NonNullable<AnswerEntry['type']>[] = ['text', 'yesno', 'select', 'number', 'url'];

function AnswerRow({ entry }: { entry: AnswerEntry }) {
  const unconfirmed = Boolean(entry.confirm);
  const blank = !entry.answer.trim();
  return (
    <li className={cx('rounded-[var(--radius-sm)] border p-3', unconfirmed ? 'border-warn/40 bg-warn-soft' : 'border-line')}>
      <ActionForm action={answerRowAction} className="space-y-2">
        <input type="hidden" name="id" value={entry.id} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-fg">{entry.id}</span>
          {entry.type && <Badge>{entry.type}</Badge>}
          {unconfirmed ? <Badge tone="warn">Unconfirmed: autopilot won&apos;t use it</Badge> : <Badge tone="good">Confirmed</Badge>}
          {blank && <Badge tone="info">Blank: always asks you</Badge>}
        </div>
        <div className="text-[12px] text-faint" title={entry.patterns.join('\n')}>
          Matches: {entry.patterns.slice(0, 3).map((p) => `"${p}"`).join(', ')}{entry.patterns.length > 3 ? ` +${entry.patterns.length - 3} more` : ''}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          {entry.answer.length > 90 || entry.answer.includes('\n') ? (
            <TextArea name="answer" defaultValue={entry.answer} rows={3} aria-label={`Answer for ${entry.id}`} className="flex-1" />
          ) : (
            <TextInput name="answer" defaultValue={entry.answer} aria-label={`Answer for ${entry.id}`} placeholder="Blank: always ask me" className="flex-1" />
          )}
          <div className="flex shrink-0 gap-1.5">
            <SubmitButton name="intent" value="save" size="sm" pendingLabel="Saving…">Save</SubmitButton>
            {unconfirmed && (
              <SubmitButton
                name="intent" value="confirm" size="sm" variant="good" disabled={blank}
                title={blank ? 'Write an answer first' : 'Mark this wording as accurate'}
              >
                Confirm
              </SubmitButton>
            )}
          </div>
        </div>
        {entry.notes && <p className="text-[12px] text-dim">{entry.notes}</p>}
        <details>
          <summary className="cursor-pointer text-[12px] text-faint hover:text-dim">Edit patterns, type and notes</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-[2fr_1fr_2fr]">
            <Field label="Question patterns" hint="One per line, lowercase">
              <TextArea name="patterns" defaultValue={entry.patterns.join('\n')} rows={4} className="font-mono text-[12px]" />
            </Field>
            <Field label="Type">
              <Select name="type" defaultValue={entry.type ?? 'text'}>
                {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Notes"><TextArea name="notes" defaultValue={entry.notes ?? ''} rows={4} /></Field>
          </div>
          <div className="mt-2 flex justify-end">
            <SubmitButton name="intent" value="remove" size="sm" variant="danger" confirm={`Remove the "${entry.id}" answer?`}>Remove entry</SubmitButton>
          </div>
        </details>
      </ActionForm>
    </li>
  );
}

function AddAnswer() {
  return (
    <Card>
      <h3 className="mb-3 text-[14px] font-semibold text-fg">Add an answer</h3>
      <ActionForm action={addAnswerAction} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
          <Field label="Question patterns *" hint="One per line: lowercase text that appears in the question label">
            <TextArea name="patterns" rows={3} required className="font-mono text-[12px]" placeholder={'notice period\nwhen can you start'} />
          </Field>
          <div className="space-y-3">
            <Field label="Type">
              <Select name="type" defaultValue="text">{TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
            </Field>
            <Field label="Id" hint="Optional; made from the first pattern"><TextInput name="id" /></Field>
          </div>
        </div>
        <Field label="Answer *"><TextArea name="answer" rows={2} required /></Field>
        <Field label="Notes"><TextInput name="notes" /></Field>
        <SubmitButton size="sm" variant="primary" pendingLabel="Adding…">Add answer</SubmitButton>
        <p className="text-[11.5px] text-faint">New answers start unconfirmed. Confirm them once the wording is exactly right.</p>
      </ActionForm>
    </Card>
  );
}

export function AnswersPanel({ bank, error }: { bank?: AnswerBank; error?: string }) {
  if (error || !bank) return <Notice tone="bad" title="config/answers.json can't be loaded">{error ?? 'Unknown error'}</Notice>;
  const entries = [...bank.entries].sort((a, b) => Number(Boolean(b.confirm)) - Number(Boolean(a.confirm)));
  const unconfirmed = entries.filter((e) => e.confirm).length;
  return (
    <div className="space-y-4">
      <Notice tone={unconfirmed ? 'warn' : 'info'}>
        Screening questions are answered from this bank by matching the question label. Anything it can&apos;t answer confidently
        comes to you as &ldquo;needs you&rdquo;.{' '}
        {unconfirmed > 0 && <strong className="text-fg">{unconfirmed} answer{unconfirmed === 1 ? '' : 's'} still need{unconfirmed === 1 ? 's' : ''} your confirmation.</strong>}
      </Notice>
      <ul className="space-y-2">{entries.map((e) => <AnswerRow key={e.id} entry={e} />)}</ul>
      <AddAnswer />
    </div>
  );
}
