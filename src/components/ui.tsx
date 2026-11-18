// Shared UI primitives. Server-component safe (no hooks). Import from '@/components/ui'.
import type { ReactNode, ButtonHTMLAttributes, AnchorHTMLAttributes } from 'react';
import type { JobStatus } from '@/lib/types';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Card({ children, className, pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <div className={cx('rounded-[var(--radius)] border border-line bg-panel shadow-[var(--shadow)]', pad && 'p-4', className)}>
      {children}
    </div>
  );
}

export function Section({ title, action, children, className }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('space-y-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-dim">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'good';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong border-transparent',
  secondary: 'bg-panel-hover text-fg hover:border-line-strong border-line',
  ghost: 'bg-transparent text-dim hover:text-fg hover:bg-panel-hover border-transparent',
  danger: 'bg-bad-soft text-bad hover:bg-bad hover:text-white border-transparent',
  good: 'bg-good-soft text-good hover:bg-good hover:text-white border-transparent',
};
const sizes = { sm: 'h-7 px-2.5 text-[12px] gap-1.5', md: 'h-9 px-3.5 text-[13px] gap-2', lg: 'h-11 px-5 text-[14px] gap-2' };

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof sizes }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center rounded-[var(--radius-sm)] border font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
        variants[variant], sizes[size], className,
      )}
    />
  );
}

export function LinkButton({ variant = 'secondary', size = 'md', className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: keyof typeof sizes }) {
  return (
    <a
      {...rest}
      className={cx(
        'inline-flex items-center justify-center rounded-[var(--radius-sm)] border font-medium transition-colors whitespace-nowrap',
        variants[variant], sizes[size], className,
      )}
    />
  );
}

type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-panel-hover text-dim border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  good: 'bg-good-soft text-good border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap', tones[tone], className)}>
      {children}
    </span>
  );
}

const statusTone: Record<JobStatus, Tone> = {
  discovered: 'neutral', filtered_out: 'neutral', scored: 'info', skipped: 'neutral', tailoring: 'info',
  ready: 'accent', approved: 'accent', applying: 'accent', needs_you: 'warn', applied: 'good', failed: 'bad',
  replied: 'info', interview: 'good', offer: 'good', rejected: 'bad', withdrawn: 'neutral',
};
const statusLabel: Partial<Record<JobStatus, string>> = { needs_you: 'needs you', filtered_out: 'filtered' };

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge tone={statusTone[status]}>{statusLabel[status] ?? status}</Badge>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const color = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : tone === 'accent' ? 'text-accent' : 'text-fg';
  return (
    <Card className="min-w-0">
      <div className="text-[12px] text-dim">{label}</div>
      <div className={cx('mt-1 text-[26px] font-semibold leading-8 tabular', color)}>{value}</div>
      {hint && <div className="mt-1 text-[12px] text-faint">{hint}</div>}
    </Card>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius)] border border-dashed border-line px-6 py-12 text-center">
      <div className="text-[14px] font-medium text-fg">{title}</div>
      {children && <div className="mt-1 max-w-md text-[13px] text-dim">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-bg-sunk px-1 font-mono text-[11px] text-dim">{children}</kbd>;
}

/** Circular 0-100 score. Colour: ≥80 good, ≥60 accent, ≥45 warn, else bad. */
export function ScoreRing({ score, size = 44 }: { score?: number | null; size?: number }) {
  const s = Math.max(0, Math.min(100, Math.round(score ?? 0)));
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = score == null ? 'var(--text-faint)' : s >= 80 ? 'var(--good)' : s >= 60 ? 'var(--accent)' : s >= 45 ? 'var(--warn)' : 'var(--bad)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`score ${score ?? 'n/a'}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={4} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round"
        strokeDasharray={`${(s / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.32} fontWeight={600} fill="var(--text)" className="tabular">
        {score == null ? '–' : s}
      </text>
    </svg>
  );
}

/** Horizontal 0-1 bar for score components. */
export function Meter({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex items-center gap-2 text-[12px]">
      {label && <span className="w-20 shrink-0 text-dim">{label}</span>}
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-sunk">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right tabular text-faint">{pct}</span>
    </div>
  );
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });
}
