'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, cx } from '@/components/ui';

type State = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; ok: boolean; text: string };

/** Summarises whatever JSON the task endpoint returns (it owns the exact shape). */
function summarise(body: unknown, status: number): { ok: boolean; text: string } {
  const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const ok = status < 400 && rec.ok !== false;
  const error = typeof rec.error === 'string' ? rec.error : undefined;
  if (!ok) return { ok, text: error ?? `Failed (HTTP ${status})` };
  const stats = (rec.stats ?? rec.result ?? rec) as Record<string, unknown>;
  const parts = ['found', 'created'].filter((k) => typeof stats?.[k] === 'number').map((k) => `${stats[k]} ${k}`);
  return { ok, text: parts.length ? `Done: ${parts.join(', ')}` : typeof rec.message === 'string' ? rec.message : 'Done' };
}

/** Runs a worker task in-process via POST /api/task/<name> (the "run now" buttons). */
export function RunTaskButton({ task, label, runningLabel = 'Running…', variant = 'secondary' }: {
  task: string; label: string; runningLabel?: string; variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const router = useRouter();

  async function run() {
    setState({ kind: 'running' });
    try {
      const res = await fetch(`/api/task/${encodeURIComponent(task)}`, { method: 'POST', headers: { 'x-pursuit': '1' } });
      const body: unknown = await res.json().catch(() => null);
      setState({ kind: 'done', ...summarise(body, res.status) });
      router.refresh();
    } catch (err) {
      setState({ kind: 'done', ok: false, text: (err as Error).message || 'Network error' });
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant={variant} onClick={run} disabled={state.kind === 'running'}>
        {state.kind === 'running' ? runningLabel : label}
      </Button>
      {state.kind === 'done' && (
        <span role="status" className={cx('text-[12px]', state.ok ? 'text-good' : 'text-bad')}>{state.text}</span>
      )}
    </span>
  );
}
