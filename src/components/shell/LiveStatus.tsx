'use client';
// Live status context: seeded by the server layout, refreshed from GET /api/status every 5 s while
// the tab is visible. Drives the worker dot, nav counts and the paused banner.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StatusPayload } from '@/app/api/_lib/status';

const POLL_MS = 5_000;

interface LiveStatusValue {
  status: StatusPayload;
  /** True when the last poll failed (server restarting, etc.). */
  stale: boolean;
  /** Optimistic local patch (e.g. paused flag right after the toggle). */
  patch: (p: Partial<StatusPayload>) => void;
  refresh: () => void;
}

const Ctx = createContext<LiveStatusValue | null>(null);

export function LiveStatusProvider({ initial, children }: { initial: StatusPayload; children: ReactNode }) {
  const [status, setStatus] = useState(initial);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);

  // A server re-render (navigation, revalidatePath) brings fresher data than the last poll.
  useEffect(() => setStatus(initial), [initial]);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as StatusPayload;
      if (next.ok) {
        setStatus(next);
        setStale(false);
      }
    } catch {
      setStale(true);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll();
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  const patch = useCallback((p: Partial<StatusPayload>) => setStatus((s) => ({ ...s, ...p })), []);
  const value = useMemo(() => ({ status, stale, patch, refresh: () => void poll() }), [status, stale, patch, poll]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLiveStatus(): LiveStatusValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLiveStatus must be used inside <LiveStatusProvider>');
  return v;
}
