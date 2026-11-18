// Browser-side helpers shared by shell, queue and job components: toasts and task runs.
// Import only from client components.

export type ToastTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  detail?: string;
  /** Optional single action (e.g. Undo). */
  action?: { label: string; run: () => void };
  durationMs?: number;
}

export const TOAST_EVENT = 'pursuit:toast';

export function toast(input: ToastInput | string, tone: ToastTone = 'neutral'): void {
  if (typeof window === 'undefined') return;
  const detail: ToastInput = typeof input === 'string' ? { message: input, tone } : input;
  window.dispatchEvent(new CustomEvent<ToastInput>(TOAST_EVENT, { detail }));
}

export interface TaskResponse {
  ok: boolean;
  task?: string;
  label?: string;
  message?: string;
  error?: string;
  skipped?: string;
  stats?: Record<string, unknown>;
  durationMs?: number;
}

/** POSTs /api/task/<name> with the CSRF header and reports the outcome as a toast. */
export async function runTaskFromUi(name: string, label = name): Promise<TaskResponse> {
  toast({ message: `${label}…`, tone: 'neutral', durationMs: 2500 });
  let body: TaskResponse;
  try {
    const res = await fetch(`/api/task/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-pursuit': '1' } });
    body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as TaskResponse;
  } catch (err) {
    body = { ok: false, error: (err as Error).message };
  }
  if (body.ok) toast({ message: `${body.label ?? label} finished`, tone: 'good', detail: summarizeStats(body.stats) });
  else if (body.skipped) toast({ message: body.message ?? `${label} skipped (${body.skipped})`, tone: 'warn' });
  else toast({ message: `${label} failed`, tone: 'bad', detail: body.error });
  return body;
}

/** "found 12 · created 3" from flat numeric stats. */
export function summarizeStats(stats: Record<string, unknown> | undefined): string | undefined {
  if (!stats) return undefined;
  const parts = Object.entries(stats)
    .filter(([k, v]) => typeof v === 'number' && k !== 'durationMs' && k !== 'cap')
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${v as number}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** True when a key event happened inside an editable control (shortcuts must not fire there). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
