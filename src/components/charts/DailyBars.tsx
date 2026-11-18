// Inline SVG bar chart of a daily count series (e.g. applications per day). Server-renderable,
// themed via CSS variables, with an accessible <title>/<desc> and a visually hidden data table.

export interface DailyPoint { date: string; count: number }

const W = 480;
const H = 170;
const PAD = { top: 12, right: 8, bottom: 26, left: 30 };

/** "Nice" axis maximum: 1, 2, 5 × 10^n at or above the data max (at least 4 for small series). */
export function niceMax(max: number): number {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function DailyBars({ data, title, unit = 'applications' }: { data: DailyPoint[]; title: string; unit?: string }) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.count)));
  const total = data.reduce((n, d) => n + d.count, 0);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(18, slot * 0.68));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const labelEvery = data.length > 21 ? 7 : data.length > 10 ? 3 : 1;
  const titleId = `chart-${title.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={`${titleId}-t ${titleId}-d`}>
        <title id={`${titleId}-t`}>{title}</title>
        <desc id={`${titleId}-d`}>{`${total} ${unit} over ${data.length} days; busiest day had ${Math.max(0, ...data.map((d) => d.count))}.`}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : '2 4'} />
            <text x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize={11} fill="var(--text-faint)" className="tabular">
              {Number.isInteger(t) ? t : t.toFixed(1)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const h = Math.max(d.count > 0 ? 2 : 0, y(0) - y(d.count));
          const isLast = i === data.length - 1;
          return (
            <g key={d.date}>
              <rect
                x={cx - barW / 2}
                y={y(0) - h}
                width={barW}
                height={h}
                rx={Math.min(3, barW / 3)}
                fill={isLast ? 'var(--accent-strong)' : 'var(--accent)'}
                opacity={d.count ? 1 : 0}
              >
                <title>{`${shortDate(d.date)}: ${d.count} ${unit}`}</title>
              </rect>
              {(isLast || (i % labelEvery === 0 && data.length - 1 - i >= Math.ceil(labelEvery / 2))) && (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--text-faint)" className="tabular">
                  {isLast ? 'Today' : shortDate(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">{unit}</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.count}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
