'use client';
// The approval queue: one job at a time, keyboard-first (A approve, S skip, E edit letter,
// O open posting, J/K next/prev), optimistic transitions with Undo, and a strict batch approve.
// The server re-checks the approval gate on every action; the UI gate is only a convenience.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type RefObject } from 'react';
import { Badge, Button, Kbd, cx } from '@/components/ui';
import { approveAction, approveBatchAction, skipAction, undoAction } from '@/app/queue/actions';
import { isTypingTarget, runTaskFromUi, toast } from '@/components/shell/client';
import { Icon } from '@/components/shell/icons';
import { JobHeader } from '@/components/job/JobHeader';
import { postingUrl } from '@/components/job/format';
import { SKIP_REASONS, type SkipReason } from '@/components/job/transitions';
import { AnswersEditor } from './AnswersEditor';
import { AtsReportView, DraftsPreview, JobDescription, KeywordCoverageView, Panel, SignalList } from './Insights';
import { LetterEditor } from './LetterEditor';
import { BATCH_MIN_SCORE, batchEligible, type QueueItem } from './model';

type Tab = 'cv' | 'letter' | 'jd';

export interface QueueDeckProps {
  items: QueueItem[];
  paused: boolean;
  nextDiscovery: string;
  inFlight: number;
}

export function QueueDeck({ items, paused, nextDiscovery, inFlight }: QueueDeckProps) {
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [currentId, setCurrentId] = useState<string | null>(items[0]?.job.id ?? null);
  const [direction, setDirection] = useState<'fwd' | 'back'>('fwd');
  const [tab, setTab] = useState<Tab>('cv');
  const [skipOpen, setSkipOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [letterDirty, setLetterDirty] = useState(false);
  const [, startTransition] = useTransition();
  const letterRef = useRef<HTMLTextAreaElement | null>(null);

  // Ids the server no longer lists are confirmed gone: stop hiding them, so an undo (or the worker
  // returning a job to the queue later) shows them again.
  useEffect(() => {
    const ids = new Set(items.map((i) => i.job.id));
    setRemoved((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const visible = useMemo(() => items.filter((i) => !removed.has(i.job.id)), [items, removed]);
  const foundIndex = visible.findIndex((i) => i.job.id === currentId);
  const index = foundIndex >= 0 ? foundIndex : 0;
  const current = visible[index];
  const eligible = useMemo(() => visible.filter((i) => batchEligible(i)), [visible]);

  useEffect(() => {
    if (current && current.job.id !== currentId) setCurrentId(current.job.id);
  }, [current, currentId]);

  useEffect(() => {
    setSkipOpen(false);
    setLetterDirty(false);
  }, [current?.job.id]);

  const goTo = useCallback((nextIndex: number) => {
    if (!visible.length) return;
    const clamped = Math.max(0, Math.min(visible.length - 1, nextIndex));
    if (clamped === index) return;
    setDirection(clamped > index ? 'fwd' : 'back');
    setCurrentId(visible[clamped].job.id);
  }, [visible, index]);

  /** Hides the card now and moves to its neighbour; restores it if the server refuses. */
  const removeOptimistically = useCallback((id: string) => {
    const i = visible.findIndex((x) => x.job.id === id);
    const neighbour = visible[i + 1] ?? visible[i - 1];
    setDirection('fwd');
    setCurrentId(neighbour?.job.id ?? null);
    setRemoved((prev) => new Set(prev).add(id));
    return () => setRemoved((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [visible]);

  const undo = useCallback((id: string, title: string) => {
    startTransition(async () => {
      const res = await undoAction(id);
      if (res.ok) {
        setRemoved((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setCurrentId(id);
        toast({ message: `Back in the queue: ${title}`, tone: 'neutral' });
      } else toast({ message: 'Could not undo', tone: 'bad', detail: res.error });
    });
  }, []);

  const approve = useCallback(() => {
    if (!current) return;
    if (!current.gate.ok) {
      toast({ message: 'Not ready to approve', tone: 'warn', detail: current.gate.reason });
      return;
    }
    if (letterDirty) {
      toast({ message: 'Save or revert your letter edits first', tone: 'warn', detail: 'Approving now would send the previous version.' });
      setTab('letter');
      return;
    }
    const { id, title, company } = current.job;
    const restore = removeOptimistically(id);
    startTransition(async () => {
      const res = await approveAction(id);
      if (res.ok) {
        toast({
          message: `Approved: ${title}`,
          detail: paused ? `${company} · waits until you resume` : `${company} · applies on the next worker pass`,
          tone: 'good',
          action: { label: 'Undo', run: () => undo(id, title) },
        });
      } else {
        restore();
        setCurrentId(id);
        toast({ message: 'Approve failed', tone: 'bad', detail: res.error });
      }
    });
  }, [current, letterDirty, removeOptimistically, paused, undo]);

  const skip = useCallback((reason: SkipReason) => {
    if (!current) return;
    setSkipOpen(false);
    const { id, title } = current.job;
    const restore = removeOptimistically(id);
    const label = SKIP_REASONS.find((r) => r.id === reason)?.label ?? reason;
    startTransition(async () => {
      const res = await skipAction(id, reason);
      if (res.ok) toast({ message: `Skipped: ${title}`, detail: label, tone: 'neutral', action: { label: 'Undo', run: () => undo(id, title) } });
      else {
        restore();
        setCurrentId(id);
        toast({ message: 'Skip failed', tone: 'bad', detail: res.error });
      }
    });
  }, [current, removeOptimistically, undo]);

  const editLetter = useCallback(() => {
    setTab('letter');
    requestAnimationFrame(() => {
      letterRef.current?.focus();
      letterRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, []);

  const openPosting = useCallback(() => {
    const url = current ? postingUrl(current.job) : undefined;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else toast({ message: 'This job has no posting link', tone: 'warn' });
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || batchOpen) return;
      if (document.querySelector('[aria-label="Command palette"]')) return;
      if (skipOpen) {
        const n = Number(e.key);
        if (n >= 1 && n <= SKIP_REASONS.length) {
          e.preventDefault();
          skip(SKIP_REASONS[n - 1].id);
        } else if (e.key === 'Escape') setSkipOpen(false);
        return;
      }
      switch (e.key.toLowerCase()) {
        case 'a': e.preventDefault(); approve(); break;
        case 's': e.preventDefault(); if (current) setSkipOpen(true); break;
        case 'e': e.preventDefault(); editLetter(); break;
        case 'o': e.preventDefault(); openPosting(); break;
        case 'j': case 'arrowright': e.preventDefault(); goTo(index + 1); break;
        case 'k': case 'arrowleft': e.preventDefault(); goTo(index - 1); break;
        case '1': setTab('cv'); break;
        case '2': setTab('letter'); break;
        case '3': setTab('jd'); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approve, skip, editLetter, openPosting, goTo, index, skipOpen, batchOpen, current]);

  if (!current) return <QueueClear nextDiscovery={nextDiscovery} inFlight={inFlight} />;

  return (
    <div className="pb-28 md:pb-24">
      <QueueTopBar
        position={index + 1}
        total={visible.length}
        eligibleCount={eligible.length}
        onBatch={() => setBatchOpen(true)}
      />

      <div key={current.job.id} className={cx('mt-4', direction === 'fwd' ? 'animate-[card-in_220ms_ease-out]' : 'animate-[card-in-back_220ms_ease-out]')}>
        <div className="rounded-[14px] border border-line bg-panel p-4 shadow-[var(--shadow)] md:p-5">
          <JobHeader
            job={current.job}
            actions={
              <Link href={`/jobs/${current.job.id}`} className="text-[12px] text-faint hover:text-accent">Details →</Link>
            }
          />
          {!current.gate.ok && (
            <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-sm)] border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
              <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
              <span>{current.gate.reason}</span>
            </div>
          )}
          {current.gate.ok && current.job.ats === 'unknown' && (
            <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-sm)] border border-line bg-bg-sunk/50 px-3 py-2 text-[13px] text-dim">
              <Icon name="hand" size={15} className="mt-0.5 shrink-0 text-warn" />
              <span>Unknown application form: approving fills what Pursuit can, then hands the browser to you. Nothing is submitted for you.</span>
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="space-y-4">
            <Panel title="Why this job">
              <SignalList reasons={current.job.scoreDetail?.reasons ?? []} flags={current.flags} />
            </Panel>
            <Panel title="Keyword coverage">
              <KeywordCoverageView coverage={current.job.keywords} />
            </Panel>
            <Panel
              title="Screening answers"
              aside={current.gate.blocking > 0 ? <Badge tone="warn">{current.gate.blocking} need you</Badge> : current.answers.length ? <Badge tone="good">all answered</Badge> : undefined}
            >
              <AnswersEditor jobId={current.job.id} answers={current.answers} />
            </Panel>
            <Panel title="ATS check" aside={current.cvVersion ? <span className="text-[11px] text-faint">CV v{current.cvVersion}</span> : undefined}>
              <AtsReportView report={current.ats} />
            </Panel>
            <Panel title="Outreach drafts" aside={current.drafts.length ? <Link href="/outreach" className="text-[12px] text-faint hover:text-accent">Outreach →</Link> : undefined}>
              <DraftsPreview drafts={current.drafts} />
            </Panel>
          </div>

          <div className="lg:sticky lg:top-4 lg:self-start">
            <DocumentTabs item={current} tab={tab} setTab={setTab} letterRef={letterRef} onLetterDirty={setLetterDirty} />
          </div>
        </div>
      </div>

      <ActionBar
        item={current}
        position={index + 1}
        total={visible.length}
        paused={paused}
        skipOpen={skipOpen}
        setSkipOpen={setSkipOpen}
        onApprove={approve}
        onSkip={skip}
        onEdit={editLetter}
        onOpen={openPosting}
        onPrev={() => goTo(index - 1)}
        onNext={() => goTo(index + 1)}
      />

      {batchOpen && (
        <BatchDialog
          items={eligible}
          onClose={() => setBatchOpen(false)}
          onApproved={(ids) => {
            setRemoved((prev) => new Set([...prev, ...ids]));
            setBatchOpen(false);
          }}
        />
      )}
    </div>
  );
}

function QueueTopBar({ position, total, eligibleCount, onBatch }: { position: number; total: number; eligibleCount: number; onBatch: () => void }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">Approval queue</h1>
        <p className="mt-0.5 text-[13px] text-dim">
          <span className="tabular text-fg">{position}</span> of <span className="tabular">{total}</span> ready · highest score first
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-1 text-[11px] text-faint lg:flex">
          <Kbd>A</Kbd> approve <Kbd>S</Kbd> skip <Kbd>E</Kbd> edit <Kbd>O</Kbd> open <Kbd>J</Kbd><Kbd>K</Kbd> move
        </span>
        <Button size="sm" variant="secondary" onClick={onBatch} disabled={eligibleCount === 0} title={`Score ≥ ${BATCH_MIN_SCORE}, no flags, every question answered from a confirmed source`}>
          <Icon name="spark" size={13} /> Approve all ≥ {BATCH_MIN_SCORE} <span className="tabular text-faint">({eligibleCount})</span>
        </Button>
      </div>
    </div>
  );
}

function DocumentTabs({
  item, tab, setTab, letterRef, onLetterDirty,
}: {
  item: QueueItem;
  tab: Tab;
  setTab: (t: Tab) => void;
  letterRef: RefObject<HTMLTextAreaElement | null>;
  onLetterDirty: (dirty: boolean) => void;
}) {
  const tabs: { id: Tab; label: string; key: string }[] = [
    { id: 'cv', label: 'CV', key: '1' },
    { id: 'letter', label: 'Cover letter', key: '2' },
    { id: 'jd', label: 'Job description', key: '3' },
  ];
  const cvUrl = item.cvPdfId ? `/api/artifact/${item.cvPdfId}` : null;
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-line bg-panel">
      <div role="tablist" aria-label="Documents" className="flex items-center gap-1 border-b border-line px-2 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              '-mb-px flex items-center gap-1.5 rounded-t-[var(--radius-sm)] border-b-2 px-3 pb-2 pt-1.5 text-[13px] transition-colors',
              tab === t.id ? 'border-accent text-fg' : 'border-transparent text-dim hover:text-fg',
            )}
          >
            {t.label}
            {t.id === 'letter' && item.letter && (item.letter.guardProblems.length + item.letter.slopHits.length) > 0 && <span className="size-1.5 rounded-full bg-warn" aria-label="has warnings" />}
          </button>
        ))}
        {tab === 'cv' && cvUrl && (
          <a href={cvUrl} target="_blank" rel="noreferrer" className="ml-auto mb-1.5 inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-faint hover:text-fg">
            Open PDF <Icon name="external" size={12} />
          </a>
        )}
      </div>
      <div role="tabpanel" className="p-3">
        {tab === 'cv' && (
          cvUrl ? (
            <iframe
              key={cvUrl}
              src={`${cvUrl}#view=FitH&toolbar=0`}
              title={`Tailored CV for ${item.job.company}`}
              className="h-[62vh] w-full rounded-[var(--radius-sm)] border border-line bg-white lg:h-[74vh]"
            />
          ) : (
            <div className="grid h-60 place-items-center rounded-[var(--radius-sm)] border border-dashed border-line text-center text-[13px] text-faint">
              <div>
                No CV PDF yet.
                {item.compileLogId && <> <a className="text-accent hover:underline" href={`/api/artifact/${item.compileLogId}`} target="_blank" rel="noreferrer">See the compile log</a>.</>}
              </div>
            </div>
          )
        )}
        {tab === 'letter' && <LetterEditor jobId={item.job.id} letter={item.letter} textareaRef={letterRef} onDirtyChange={onLetterDirty} />}
        {tab === 'jd' && <JobDescription job={item.job} className="scrollbar-thin max-h-[74vh] overflow-y-auto pr-1" />}
      </div>
    </div>
  );
}

function ActionBar({
  item, position, total, paused, skipOpen, setSkipOpen, onApprove, onSkip, onEdit, onOpen, onPrev, onNext,
}: {
  item: QueueItem;
  position: number;
  total: number;
  paused: boolean;
  skipOpen: boolean;
  setSkipOpen: (open: boolean) => void;
  onApprove: () => void;
  onSkip: (reason: SkipReason) => void;
  onEdit: () => void;
  onOpen: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const progress = total ? (position / total) * 100 : 0;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:left-[232px]">
      <div className="h-0.5 bg-bg-sunk"><div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${progress}%` }} /></div>
      <div className="mx-auto flex max-w-[1240px] items-center gap-1.5 px-2 py-2.5 sm:gap-2 sm:px-3 md:px-8">
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <Button size="md" variant="ghost" onClick={onPrev} disabled={position <= 1} aria-label="Previous (K)" className="px-2"><Icon name="left" /></Button>
          <span className="w-10 text-center text-[12px] tabular text-dim sm:w-14">{position}<span className="hidden sm:inline"> of {total}</span><span className="sm:hidden">/{total}</span></span>
          <Button size="md" variant="ghost" onClick={onNext} disabled={position >= total} aria-label="Next (J)" className="px-2"><Icon name="right" /></Button>
        </div>
        <div className="hidden min-w-0 flex-1 truncate text-[12px] text-faint md:block">
          {!item.gate.ok ? <span className="text-warn">{item.gate.reason}</span> : paused ? 'Paused: approved jobs wait until you resume.' : 'Approve hands it to the worker, which submits only after a visible confirmation.'}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <div className="hidden items-center gap-1.5 sm:flex">
            <Button variant="ghost" onClick={onOpen} title="Open posting (O)"><Icon name="external" size={14} /> Open <span className="hidden lg:inline"><Kbd>O</Kbd></span></Button>
            <Button variant="ghost" onClick={onEdit} title="Edit letter (E)"><Icon name="edit" size={14} /> Edit <span className="hidden lg:inline"><Kbd>E</Kbd></span></Button>
          </div>
          <Button variant="ghost" onClick={onOpen} className="px-2 sm:hidden" aria-label="Open posting"><Icon name="external" size={15} /></Button>
          <div className="relative">
            <Button variant="secondary" onClick={() => setSkipOpen(!skipOpen)} aria-haspopup="menu" aria-expanded={skipOpen} title="Skip (S)">
              <Icon name="skip" size={14} /> Skip <span className="hidden lg:inline"><Kbd>S</Kbd></span>
            </Button>
            {skipOpen && <SkipMenu onPick={onSkip} onClose={() => setSkipOpen(false)} />}
          </div>
          <Button variant="primary" onClick={onApprove} disabled={!item.gate.ok} title={item.gate.ok ? 'Approve (A)' : item.gate.reason} className="sm:min-w-[112px]">
            <Icon name="check" size={14} /> Approve <span className="hidden lg:inline opacity-80"><Kbd>A</Kbd></span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function SkipMenu({ onPick, onClose }: { onPick: (r: SkipReason) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" aria-label="Skip reason" className="absolute bottom-full right-0 mb-2 w-56 animate-[pop-in_120ms_ease-out] overflow-hidden rounded-[var(--radius)] border border-line-strong bg-bg-elev p-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)]">
      <div className="px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-[0.08em] text-faint">Skip because…</div>
      {SKIP_REASONS.map((r, i) => (
        <button
          key={r.id}
          role="menuitem"
          type="button"
          onClick={() => onPick(r.id)}
          className="flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-fg hover:bg-panel-hover"
        >
          {r.label}
          <Kbd>{i + 1}</Kbd>
        </button>
      ))}
    </div>
  );
}

function BatchDialog({ items, onClose, onApproved }: { items: QueueItem[]; onClose: () => void; onApproved: (ids: string[]) => void }) {
  const [pending, start] = useTransition();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !pending && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const confirm = () => {
    start(async () => {
      const res = await approveBatchAction(items.map((i) => i.job.id));
      if (res.ok) {
        onApproved(res.data?.approved ?? []);
        const skipped = res.data?.skipped.length ?? 0;
        toast({ message: res.message ?? 'Approved', tone: 'good', detail: skipped ? `${skipped} changed since the list was shown and stayed in the queue` : undefined });
      } else toast({ message: 'Batch approve failed', tone: 'bad', detail: res.error });
    });
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="batch-title">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/55 animate-[fade-in_100ms_ease-out]" onClick={() => !pending && onClose()} />
      <div className="relative w-full max-w-lg animate-[pop-in_140ms_ease-out] rounded-[14px] border border-line-strong bg-bg-elev p-5 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)]">
        <h2 id="batch-title" className="text-[16px] font-semibold text-fg">Approve {items.length} job{items.length === 1 ? '' : 's'}?</h2>
        <p className="mt-1 text-[13px] text-dim">
          Each has a score of {BATCH_MIN_SCORE}+, no flags, a compiled CV and every screening question answered from a confirmed source.
          The worker submits them within your daily cap and only marks one applied after the site confirms it.
        </p>
        <ul className="scrollbar-thin mt-4 max-h-[40vh] space-y-1 overflow-y-auto">
          {items.map((i) => (
            <li key={i.job.id} className="flex items-center gap-3 rounded-[var(--radius-sm)] bg-panel px-3 py-2 text-[13px]">
              <span className="w-8 shrink-0 text-right font-semibold tabular text-good">{Math.round(i.job.score ?? 0)}</span>
              <span className="min-w-0 flex-1 truncate"><span className="text-fg">{i.job.title}</span> <span className="text-faint">· {i.job.company}</span></span>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="primary" onClick={confirm} disabled={pending || !items.length}>{pending ? 'Approving…' : `Approve ${items.length}`}</Button>
        </div>
      </div>
    </div>
  );
}

function QueueClear({ nextDiscovery, inFlight }: { nextDiscovery: string; inFlight: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const run = (name: string, label: string) => {
    setBusy(name);
    void runTaskFromUi(name, label).finally(() => {
      setBusy(null);
      router.refresh();
    });
  };
  return (
    <div className="mx-auto max-w-xl pt-10 text-center md:pt-20">
      <div className="mx-auto grid size-14 place-items-center rounded-full bg-good-soft text-good">
        <Icon name="check" size={26} />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-fg">Queue clear</h1>
      <p className="mt-1.5 text-[14px] text-dim">{nextDiscovery}</p>
      {inFlight > 0 && <p className="mt-1 text-[13px] text-faint">{inFlight} approved application{inFlight === 1 ? ' is' : 's are'} in flight.</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="secondary" onClick={() => run('discover', 'Discovery')} disabled={busy !== null}>
          <Icon name="refresh" size={14} /> {busy === 'discover' ? 'Discovering…' : 'Run discovery now'}
        </Button>
        <Button variant="secondary" onClick={() => run('tailor', 'Tailoring')} disabled={busy !== null}>
          <Icon name="spark" size={14} /> {busy === 'tailor' ? 'Tailoring…' : 'Tailor next batch'}
        </Button>
        <Link href="/jobs" className="inline-flex h-9 items-center rounded-[var(--radius-sm)] px-3.5 text-[13px] font-medium text-dim hover:bg-panel-hover hover:text-fg">All jobs</Link>
      </div>
    </div>
  );
}
