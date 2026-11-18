'use client';
// Toast stack fed by toast() from ./client (window CustomEvent, so any client component can post).

import { useEffect, useRef, useState } from 'react';
import { cx } from '@/components/ui';
import { TOAST_EVENT, type ToastInput } from './client';
import { Icon } from './icons';

interface ToastItem extends ToastInput { id: number }

const TONE_CLASS: Record<NonNullable<ToastInput['tone']>, string> = {
  neutral: 'text-fg',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
};
const MAX_TOASTS = 4;

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastInput>).detail;
      if (!detail?.message) return;
      const id = ++seq.current;
      setItems((list) => [...list.slice(-(MAX_TOASTS - 1)), { ...detail, id }]);
      const ms = detail.durationMs ?? (detail.tone === 'bad' ? 9000 : detail.action ? 7000 : 4500);
      const t = setTimeout(() => {
        timers.delete(t);
        setItems((list) => list.filter((x) => x.id !== id));
      }, ms);
      timers.add(t);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  const dismiss = (id: number) => setItems((list) => list.filter((x) => x.id !== id));

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-6 md:bottom-6 md:items-end">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex w-full max-w-sm animate-[toast-in_180ms_ease-out] items-start gap-3 rounded-[var(--radius)] border border-line-strong bg-bg-elev/95 px-3.5 py-2.5 shadow-[var(--shadow)] backdrop-blur"
        >
          <div className="min-w-0 flex-1">
            <div className={cx('text-[13px] font-medium', TONE_CLASS[t.tone ?? 'neutral'])}>{t.message}</div>
            {t.detail && <div className="mt-0.5 line-clamp-3 text-[12px] text-dim">{t.detail}</div>}
          </div>
          {t.action && (
            <button
              type="button"
              className="shrink-0 rounded-[var(--radius-sm)] px-2 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent-soft"
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label="Dismiss" className="shrink-0 text-faint hover:text-fg" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
