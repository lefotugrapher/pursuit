// Small server-safe layout pieces shared by the secondary dashboard pages.
import type { ReactNode, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from 'react';
import { cx } from '@/components/ui';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[18px] font-semibold leading-7 text-fg">{title}</h1>
        {description && <p className="mt-0.5 max-w-2xl text-[13px] text-dim">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export interface TabItem { key: string; label: string; href: string; count?: number }

/** Link-based tabs (state lives in the URL, so they work without JS and survive reloads). */
export function TabLinks({ tabs, active, label }: { tabs: TabItem[]; active: string; label: string }) {
  return (
    <nav aria-label={label} className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <a
            key={t.key}
            href={t.href}
            aria-current={on ? 'page' : undefined}
            className={cx(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 text-[12.5px] font-medium transition-colors',
              on ? 'border-line-strong bg-panel-hover text-fg' : 'border-transparent text-dim hover:bg-panel-hover hover:text-fg',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className={cx('tabular text-[11px]', on ? 'text-dim' : 'text-faint')}>{t.count}</span>}
          </a>
        );
      })}
    </nav>
  );
}

const control =
  'w-full rounded-[var(--radius-sm)] border border-line bg-bg-sunk px-2.5 text-[13px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-50';

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block min-w-0 space-y-1', className)}>
      <span className="block text-[12px] font-medium text-dim">{label}</span>
      {children}
      {hint && <span className="block text-[11.5px] text-faint">{hint}</span>}
    </label>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(control, 'h-8', className)} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(control, 'min-h-20 py-2 leading-relaxed', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(control, 'h-8 pr-7', className)}>
      {children}
    </select>
  );
}

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-[13px] text-fg', className)}>
      <input type="checkbox" {...rest} className="size-3.5 rounded border-line accent-[var(--accent)]" />
      {label}
    </label>
  );
}

/** Calm inline notice (setup steps, safety notes). */
export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'bad' | 'good' | 'neutral'; title?: ReactNode; children: ReactNode; className?: string }) {
  const tones = {
    info: 'border-info/25 bg-info-soft',
    warn: 'border-warn/25 bg-warn-soft',
    bad: 'border-bad/25 bg-bad-soft',
    good: 'border-good/25 bg-good-soft',
    neutral: 'border-line bg-panel',
  } as const;
  const titleTone = { info: 'text-info', warn: 'text-warn', bad: 'text-bad', good: 'text-good', neutral: 'text-fg' } as const;
  return (
    <div className={cx('rounded-[var(--radius)] border px-4 py-3 text-[13px] text-dim', tones[tone], className)}>
      {title && <div className={cx('mb-1 font-medium', titleTone[tone])}>{title}</div>}
      {children}
    </div>
  );
}

/** Two-column label/value list for dense facts. */
export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-faint">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
