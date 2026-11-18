// Horizontal funnel: one bar per stage (width relative to the first stage) with the conversion
// rate from the previous stage between rows. Plain HTML/CSS so it reflows on narrow screens.
import type { FunnelStep } from '@/lib/server-more';

export function FunnelBars({ steps }: { steps: FunnelStep[] }) {
  const base = Math.max(1, steps[0]?.value ?? 0);
  return (
    <ol className="space-y-1" aria-label="Application funnel">
      {steps.map((s, i) => {
        const pct = Math.max(s.value > 0 ? 1.5 : 0, (s.value / base) * 100);
        return (
          <li key={s.key}>
            {i > 0 && (
              <div className="flex items-center gap-2 py-0.5 pl-[7.5rem] text-[11px] text-faint" aria-label={`Conversion from ${steps[i - 1].label} to ${s.label}`}>
                <span aria-hidden="true">↓</span>
                <span className="tabular">{s.conversion === null ? '—' : `${s.conversion}%`}</span>
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="w-[6.75rem] shrink-0 text-right text-[12.5px] text-dim">{s.label}</span>
              <div className="h-6 flex-1 overflow-hidden rounded-[6px] bg-bg-sunk">
                <div
                  className="h-full rounded-[6px] bg-accent transition-[width]"
                  style={{ width: `${pct}%`, opacity: 1 - i * 0.08 }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-[13px] font-medium tabular text-fg">{s.value}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
