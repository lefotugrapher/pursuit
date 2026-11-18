'use client';
// App frame: desktop sidebar, mobile top bar + drawer, paused banner, command palette and toasts.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { Badge, Kbd, cx } from '@/components/ui';
import { setPaused } from './actions';
import { toast } from './client';
import { CommandPalette, openPalette } from './CommandPalette';
import { Icon } from './icons';
import { useLiveStatus } from './LiveStatus';
import { NAV, isActive, type NavCountKey } from './nav';
import { Toaster } from './Toaster';

export interface ShellExtras { inbox: number; drafts: number; dbError: string | null }

function useNavCounts(extras: ShellExtras): Record<NavCountKey, number> {
  const { counts } = useLiveStatus().status;
  return { queue: counts.ready, needsYou: counts.needs_you, interviews: counts.interview, inbox: extras.inbox, drafts: extras.drafts };
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-[var(--radius-sm)] px-1 py-0.5">
      <span className="grid size-7 place-items-center rounded-[8px] bg-gradient-to-br from-accent to-accent-strong text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset,0_6px_16px_-6px_var(--accent)]">
        <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
          <path d="M3 13 8.5 7.5M8.5 7.5V3.5h4v4h-4Z" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Pursuit</span>
    </Link>
  );
}

function NavList({ extras, onNavigate }: { extras: ShellExtras; onNavigate?: () => void }) {
  const pathname = usePathname() ?? '/';
  const counts = useNavCounts(extras);
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = isActive(item.href, pathname);
        const n = item.count ? counts[item.count] : 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'group flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-[13px] transition-colors',
              active ? 'bg-panel-hover text-fg shadow-[inset_0_0_0_1px_var(--border)]' : 'text-dim hover:bg-panel-hover/60 hover:text-fg',
            )}
          >
            <Icon name={item.icon} className={cx(active ? 'text-accent' : 'text-faint group-hover:text-dim')} />
            <span className="flex-1">{item.label}</span>
            {n > 0 && (
              item.emphasis || (item.count === 'needsYou')
                ? <Badge tone={item.count === 'needsYou' ? 'warn' : 'accent'} className="tabular">{n}</Badge>
                : <span className="tabular text-[11px] text-faint">{n}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function WorkerStatus() {
  const { status, stale } = useLiveStatus();
  const { worker } = status;
  const online = worker.online && !stale;
  const label = stale ? 'Dashboard reconnecting' : online ? 'Worker online' : 'Worker offline';
  const age = worker.ageSec == null ? 'never seen' : worker.ageSec < 60 ? `${worker.ageSec}s ago` : worker.ageSec < 3600 ? `${Math.floor(worker.ageSec / 60)}m ago` : `${Math.floor(worker.ageSec / 3600)}h ago`;
  return (
    <div className="flex items-center gap-2.5" title={worker.heartbeatAt ? `Last heartbeat ${new Date(worker.heartbeatAt).toLocaleString('en-IE')}` : 'No heartbeat yet: run pnpm worker'}>
      <span className="relative flex size-2.5 items-center justify-center">
        {online && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-40" />}
        <span className={cx('relative inline-flex size-2 rounded-full', stale ? 'bg-warn' : online ? 'bg-good' : 'bg-faint')} />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="text-[12px] font-medium text-fg">{label}</div>
        <div className="text-[11px] text-faint" suppressHydrationWarning>{online ? `heartbeat ${age}` : worker.ageSec == null ? 'start with pnpm worker' : `last seen ${age}`}</div>
      </div>
    </div>
  );
}

function PauseToggle({ compact = false }: { compact?: boolean }) {
  const { status, patch } = useLiveStatus();
  const [pending, start] = useTransition();
  const toggle = () => {
    const next = !status.paused;
    patch({ paused: next });
    start(async () => {
      const res = await setPaused(next);
      if (!res.ok) {
        patch({ paused: !next });
        toast({ message: 'Could not change pause state', tone: 'bad', detail: res.error });
      } else toast({ message: res.paused ? 'Paused: nothing will be submitted or sent' : 'Resumed: outbound actions are back on', tone: res.paused ? 'warn' : 'good' });
    });
  };
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={status.paused}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] border text-[12px] font-medium transition-colors disabled:opacity-60',
        compact ? 'size-8' : 'h-8 w-full px-3',
        status.paused ? 'border-transparent bg-warn-soft text-warn hover:bg-warn hover:text-black' : 'border-line bg-panel-hover text-dim hover:border-line-strong hover:text-fg',
      )}
      title={status.paused ? 'Resume outbound actions' : 'Pause everything outbound'}
    >
      <Icon name={status.paused ? 'play' : 'pause'} size={14} />
      {!compact && (status.paused ? 'Resume' : 'Pause outbound')}
    </button>
  );
}

function SidebarBody({ extras, onNavigate }: { extras: ShellExtras; onNavigate?: () => void }) {
  const { status } = useLiveStatus();
  return (
    <div className="flex h-full flex-col gap-5 p-3">
      <div className="flex items-center justify-between pl-1 pt-1">
        <Brand />
      </div>
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          openPalette();
        }}
        className="flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-bg-sunk px-2.5 text-[12px] text-faint transition-colors hover:border-line-strong hover:text-dim"
      >
        <Icon name="search" size={14} />
        <span className="flex-1 text-left">Search or jump…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <NavList extras={extras} onNavigate={onNavigate} />
      <div className="mt-auto space-y-3 rounded-[var(--radius)] border border-line bg-panel p-3">
        <WorkerStatus />
        <div className="flex items-center gap-1.5 text-[11px] text-faint">
          <span>Mode</span>
          <Badge tone={status.autopilot ? 'warn' : 'neutral'}>{status.autopilot ? 'autopilot' : 'review'}</Badge>
          {!status.integrations.llm && <Badge tone="neutral" title="No OPENROUTER_API_KEY: heuristics only">LLM off</Badge>}
        </div>
        <PauseToggle />
      </div>
    </div>
  );
}

function PausedBanner() {
  const { status } = useLiveStatus();
  if (!status.paused) return null;
  return (
    <div role="status" className="sticky top-0 z-30 flex items-center justify-center gap-3 border-b border-warn/30 bg-warn-soft px-4 py-2 text-[13px] font-medium text-warn backdrop-blur md:top-0">
      <Icon name="pause" size={14} />
      <span>Paused — nothing will be submitted or sent</span>
      <span className="hidden md:inline"><PauseToggleInline /></span>
    </div>
  );
}

function PauseToggleInline() {
  const { patch } = useLiveStatus();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="rounded-full border border-warn/40 px-2.5 py-0.5 text-[12px] hover:bg-warn hover:text-black disabled:opacity-60"
      onClick={() => {
        patch({ paused: false });
        start(async () => {
          const res = await setPaused(false);
          if (!res.ok) {
            patch({ paused: true });
            toast({ message: 'Could not resume', tone: 'bad', detail: res.error });
          }
        });
      }}
    >
      Resume
    </button>
  );
}

function MobileBar({ extras }: { extras: ShellExtras }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const counts = useNavCounts(extras);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-line bg-bg/90 px-3 backdrop-blur md:hidden">
        <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className="grid size-8 place-items-center rounded-[var(--radius-sm)] text-dim hover:bg-panel-hover hover:text-fg">
          <Icon name="menu" />
        </button>
        <Brand />
        <div className="ml-auto flex items-center gap-1.5">
          <Link href="/queue" className="flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[12px] text-dim hover:bg-panel-hover">
            <Icon name="queue" size={14} />
            {counts.queue > 0 && <Badge tone="accent" className="tabular">{counts.queue}</Badge>}
          </Link>
          <button type="button" aria-label="Search" onClick={() => openPalette()} className="grid size-8 place-items-center rounded-[var(--radius-sm)] text-dim hover:bg-panel-hover hover:text-fg">
            <Icon name="search" />
          </button>
          <PauseToggle compact />
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/50 animate-[fade-in_120ms_ease-out]" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[82%] max-w-[300px] animate-[drawer-in_180ms_ease-out] border-r border-line bg-bg-elev">
            <SidebarBody extras={extras} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

export function AppShell({ extras, children }: { extras: ShellExtras; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 border-r border-line bg-bg-elev/60 md:block">
        <SidebarBody extras={extras} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar extras={extras} />
        <PausedBanner />
        {extras.dbError && (
          <div role="alert" className="border-b border-bad/30 bg-bad-soft px-4 py-2 text-[13px] text-bad">
            Database unavailable: {extras.dbError}. Run <code className="font-mono">pnpm doctor</code> for details.
          </div>
        )}
        <main className="mx-auto w-full max-w-[1240px] flex-1 px-4 pb-16 pt-5 md:px-8 md:pt-8">{children}</main>
      </div>
      <CommandPalette />
      <Toaster />
    </div>
  );
}
