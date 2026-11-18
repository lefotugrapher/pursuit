'use client';
// ⌘K command palette: jump to pages, search jobs (server action), run worker tasks, pause/resume.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Kbd, StatusBadge, cx } from '@/components/ui';
import type { JobHit } from '@/lib/server';
import { searchJobs, setPaused } from './actions';
import { isTypingTarget, runTaskFromUi, toast } from './client';
import { Icon, type IconName } from './icons';
import { useLiveStatus } from './LiveStatus';
import { NAV, PALETTE_TASKS } from './nav';

const OPEN_EVENT = 'pursuit:palette';

export function openPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface Item {
  id: string;
  group: 'Jobs' | 'Go to' | 'Run' | 'Actions';
  label: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  hit?: JobHit;
  run: () => void;
}

/** Every query token must prefix-match a word in label/keywords; earlier, tighter matches rank higher. */
export function matchScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const hay = text.toLowerCase();
  const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const token of q.split(/\s+/)) {
    const wordIdx = words.findIndex((w) => w.startsWith(token));
    if (wordIdx >= 0) score += 10 - Math.min(wordIdx, 8);
    else if (hay.includes(token)) score += 2;
    else return 0;
  }
  return score;
}

export function CommandPalette() {
  const router = useRouter();
  const { status, patch } = useLiveStatus();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<JobHit[]>([]);
  const [searching, startSearch] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setActive(0);
  }, []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Debounced job search through the server action; stale responses are dropped.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      startSearch(async () => {
        const result = await searchJobs(q);
        if (seq === searchSeq.current) setHits(result);
      });
    }, 140);
    return () => clearTimeout(t);
  }, [query, open]);

  const go = useCallback((href: string) => {
    close();
    router.push(href);
  }, [close, router]);

  const items = useMemo<Item[]>(() => {
    const jobItems: Item[] = hits.map((h) => ({
      id: `job:${h.id}`, group: 'Jobs', label: h.title, hint: h.company, icon: 'jobs', hit: h, run: () => go(`/jobs/${h.id}`),
    }));
    const pages: Item[] = NAV.map((n) => ({ id: `nav:${n.href}`, group: 'Go to', label: n.label, icon: n.icon, keywords: n.keywords, run: () => go(n.href) }));
    const tasks: Item[] = PALETTE_TASKS.map((t) => ({
      id: `task:${t.name}`, group: 'Run', label: t.label, hint: t.hint, icon: 'bolt', keywords: `task run ${t.name}`,
      run: () => {
        close();
        void runTaskFromUi(t.name, t.label).then(() => router.refresh());
      },
    }));
    const actions: Item[] = [
      {
        id: 'act:pause', group: 'Actions', label: status.paused ? 'Resume outbound actions' : 'Pause everything outbound',
        hint: status.paused ? 'Submissions and emails start again' : 'Nothing is submitted or sent until you resume', icon: status.paused ? 'play' : 'pause',
        keywords: 'pause resume stop kill switch',
        run: () => {
          close();
          const next = !status.paused;
          patch({ paused: next });
          void setPaused(next).then((r) => {
            if (!r.ok) {
              patch({ paused: !next });
              toast({ message: 'Could not change pause state', tone: 'bad', detail: r.error });
            } else toast({ message: r.paused ? 'Paused' : 'Resumed', tone: r.paused ? 'warn' : 'good' });
          });
        },
      },
      { id: 'act:ready', group: 'Actions', label: 'Review the approval queue', icon: 'queue', keywords: 'approve', run: () => go('/queue') },
      { id: 'act:needs', group: 'Actions', label: 'Jobs that need you', icon: 'hand', keywords: 'blocked handoff captcha', run: () => go('/jobs?status=needs_you') },
    ];
    const q = query.trim();
    const ranked = [...pages, ...tasks, ...actions]
      .map((item) => ({ item, score: matchScore(q, `${item.label} ${item.keywords ?? ''} ${item.hint ?? ''}`) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => (q ? b.score - a.score : 0))
      .map((x) => x.item);
    return q ? [...jobItems, ...ranked] : ranked;
  }, [hits, query, status.paused, go, close, patch, router]);

  useEffect(() => setActive(0), [query, hits.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[active]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-3 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/55 backdrop-blur-[2px] animate-[fade-in_100ms_ease-out]" onClick={close} />
      <div className="relative w-full max-w-[600px] animate-[pop-in_140ms_ease-out] overflow-hidden rounded-[14px] border border-line-strong bg-bg-elev shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Icon name="search" className="text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search jobs, jump to a page, run a task…"
            className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
            aria-label="Command"
            aria-activedescendant={items[active] ? `pal-${active}` : undefined}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          {searching && <span className="size-3 animate-spin rounded-full border border-faint border-t-transparent" aria-label="Searching" />}
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="scrollbar-thin max-h-[52vh] overflow-y-auto p-1.5">
          {items.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-faint">{searching ? 'Searching…' : 'No matches'}</div>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{header}</div>}
                <button
                  type="button"
                  id={`pal-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={item.run}
                  className={cx(
                    'flex w-full items-center gap-3 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px]',
                    i === active ? 'bg-panel-hover text-fg' : 'text-dim',
                  )}
                >
                  <Icon name={item.icon} className={i === active ? 'text-accent' : 'text-faint'} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-fg">{item.label}</span>
                    {item.hint && <span className="ml-2 text-faint">{item.hint}</span>}
                  </span>
                  {item.hit && (
                    <span className="flex shrink-0 items-center gap-2">
                      {item.hit.score != null && <span className="tabular text-[12px] text-faint">{Math.round(item.hit.score)}</span>}
                      <StatusBadge status={item.hit.status} />
                    </span>
                  )}
                  {i === active && !item.hit && <Icon name="right" size={14} className="text-faint" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="ml-auto flex items-center gap-1"><Kbd>⌘K</Kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
