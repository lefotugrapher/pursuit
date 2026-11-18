// Vertical event timeline. Hook-free (server + client safe).

import Link from 'next/link';
import { cx, timeAgo } from '@/components/ui';
import type { EventTone, EventView } from './events';

const DOT: Record<EventTone, string> = {
  neutral: 'bg-faint', accent: 'bg-accent', good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info',
};

export interface TimelineEntry extends EventView {
  job?: { id: string; title: string; company: string };
}

export function Timeline({ events, empty = 'Nothing yet.' }: { events: TimelineEntry[]; empty?: string }) {
  if (!events.length) return <p className="text-[13px] text-faint">{empty}</p>;
  return (
    <ol className="relative space-y-3.5 before:absolute before:bottom-1 before:left-[3px] before:top-1.5 before:w-px before:bg-line">
      {events.map((e) => (
        <li key={e.id} className="relative flex gap-3 pl-0">
          <span aria-hidden="true" className={cx('relative z-[1] mt-[6px] size-[7px] shrink-0 rounded-full ring-4 ring-panel', DOT[e.tone])} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[13px] text-fg">{e.title}</span>
              <time dateTime={e.ts} title={new Date(e.ts).toLocaleString('en-IE')} className="shrink-0 text-[11px] tabular text-faint" suppressHydrationWarning>{timeAgo(e.ts)}</time>
            </div>
            {(e.job || e.detail) && (
              <div className="truncate text-[12px] text-dim">
                {e.job && (
                  <Link href={`/jobs/${e.job.id}`} className="hover:text-accent">{e.job.company} · {e.job.title}</Link>
                )}
                {e.job && e.detail && <span className="text-faint"> · </span>}
                {e.detail && <span className="text-faint">{e.detail}</span>}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
