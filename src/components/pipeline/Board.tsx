// Kanban board for /pipeline. Server component: each card links to the job, and a small
// <details> menu offers only the moves PIPELINE_TRANSITIONS allows (no JS needed to open it).
import { Badge, ScoreRing, StatusBadge, cx } from '@/components/ui';
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import type { FormAction } from '@/components/settings/action-result';
import { allowedTransitions, TRANSITION_LABEL, type PipelineCard, type PipelineColumn } from '@/lib/server-more';

const COLUMN_ACCENT: Record<string, string> = {
  Inbox: 'bg-faint',
  Ready: 'bg-accent',
  'In flight': 'bg-warn',
  Applied: 'bg-good',
  Interview: 'bg-good',
  Offer: 'bg-good',
  Closed: 'bg-line-strong',
};

function age(days: number): string {
  if (days <= 0) return 'today';
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function MoveMenu({ card, action }: { card: PipelineCard; action: FormAction }) {
  const moves = allowedTransitions(card.status);
  if (!moves.length) return null;
  return (
    <details className="group/menu relative">
      <summary
        aria-label={`Move ${card.title}`}
        className="flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-faint hover:bg-panel-hover hover:text-fg [&::-webkit-details-marker]:hidden"
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" />
        </svg>
      </summary>
      <div className="absolute right-0 top-7 z-20 w-48 rounded-[var(--radius-sm)] border border-line-strong bg-bg-elev p-1 shadow-[var(--shadow)]">
        <div className="px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-[0.08em] text-faint">Move to</div>
        <ActionForm action={action} hideSuccess className="flex flex-col" messageClassName="px-2 py-1">
          <input type="hidden" name="jobId" value={card.id} />
          {moves.map((to) => (
            <SubmitButton
              key={to}
              name="to"
              value={to}
              variant="ghost"
              size="sm"
              className="justify-start"
              confirm={to === 'applied' ? `Confirm you submitted the application for "${card.title}" yourself?` : to === 'withdrawn' ? `Withdraw "${card.title}"?` : undefined}
            >
              {TRANSITION_LABEL[to] ?? to}
            </SubmitButton>
          ))}
        </ActionForm>
      </div>
    </details>
  );
}

function Card({ card, action }: { card: PipelineCard; action: FormAction }) {
  return (
    <li className="group relative rounded-[var(--radius-sm)] border border-line bg-panel p-2.5 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-2.5">
        <ScoreRing score={card.score} size={30} />
        <a href={`/jobs/${encodeURIComponent(card.id)}`} className="min-w-0 flex-1 after:absolute after:inset-0 after:content-['']">
          <div className="truncate text-[12px] text-dim">{card.company}</div>
          <div className="line-clamp-2 text-[13px] font-medium leading-snug text-fg">{card.title}</div>
        </a>
        <div className="relative z-10">
          <MoveMenu card={card} action={action} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[38px] text-[11px] text-faint">
        <StatusBadge status={card.status} />
        <span className="tabular" title="Age since posted or discovered">{age(card.ageDays)}</span>
        {card.location && <span className="max-w-[9rem] truncate">{card.location}</span>}
        {card.flags > 0 && <Badge tone="warn" title="Flags and blockers on this job">{card.flags} flag{card.flags === 1 ? '' : 's'}</Badge>}
      </div>
    </li>
  );
}

function ColumnBody({ column, action }: { column: PipelineColumn; action: FormAction }) {
  if (!column.cards.length) {
    return <div className="rounded-[var(--radius-sm)] border border-dashed border-line px-3 py-6 text-center text-[12px] text-faint">Nothing here</div>;
  }
  const hidden = column.total - column.cards.length;
  return (
    <>
      <ul className="space-y-2">
        {column.cards.map((c) => <Card key={c.id} card={c} action={action} />)}
      </ul>
      {hidden > 0 && (
        <a href={`/jobs?status=${column.statuses.join(',')}`} className="mt-2 block text-center text-[12px] text-dim hover:text-fg">
          +{hidden} more in Jobs
        </a>
      )}
    </>
  );
}

function ColumnHeader({ column }: { column: PipelineColumn }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cx('size-2 rounded-full', COLUMN_ACCENT[column.name] ?? 'bg-faint')} aria-hidden="true" />
      <span className="text-[12.5px] font-semibold text-fg">{column.name}</span>
      <span className="tabular text-[12px] text-faint">{column.total}</span>
    </span>
  );
}

export function Board({ columns, action }: { columns: PipelineColumn[]; action: FormAction }) {
  return (
    <div className="scrollbar-thin -mx-4 overflow-x-auto px-4 pb-4 md:-mx-8 md:px-8">
      <div className="flex min-w-max items-start gap-3">
        {columns.map((column) =>
          column.name === 'Closed' ? (
            <details key={column.name} className="group w-[272px] shrink-0 rounded-[var(--radius)] border border-line bg-bg-elev p-2.5 open:w-[272px]">
              <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-1 py-0.5 [&::-webkit-details-marker]:hidden">
                <ColumnHeader column={column} />
                <span className="text-[11px] text-faint group-open:hidden">Show</span>
                <span className="hidden text-[11px] text-faint group-open:inline">Hide</span>
              </summary>
              <div className="mt-2.5">
                <ColumnBody column={column} action={action} />
              </div>
            </details>
          ) : (
            <section key={column.name} aria-label={column.name} className="w-[272px] shrink-0 rounded-[var(--radius)] border border-line bg-bg-elev p-2.5">
              <div className="mb-2.5 px-1 py-0.5"><ColumnHeader column={column} /></div>
              <ColumnBody column={column} action={action} />
            </section>
          ),
        )}
      </div>
    </div>
  );
}
