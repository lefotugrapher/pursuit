import Link from 'next/link';
import { Empty } from '@/components/ui';

export default function NotFound() {
  return (
    <div className="pt-10">
      <Empty
        title="Nothing here"
        action={
          <div className="flex gap-2">
            <Link href="/" className="inline-flex h-9 items-center rounded-[var(--radius-sm)] border border-line bg-panel-hover px-3.5 text-[13px] font-medium text-fg hover:border-line-strong">Today</Link>
            <Link href="/jobs" className="inline-flex h-9 items-center rounded-[var(--radius-sm)] border border-line bg-panel-hover px-3.5 text-[13px] font-medium text-fg hover:border-line-strong">All jobs</Link>
          </div>
        }
      >
        That page or job doesn&apos;t exist. It may have been merged into another posting during discovery.
      </Empty>
    </div>
  );
}
