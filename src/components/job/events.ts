// Turns raw `events` rows into one-line, human timeline entries. Pure.

import type { EventRow, JobStatus } from '@/lib/types';

export type EventTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'info';

export interface EventView {
  id: number;
  ts: string;
  jobId?: string;
  title: string;
  detail?: string;
  tone: EventTone;
}

const STATUS_TONE: Partial<Record<JobStatus, EventTone>> = {
  ready: 'accent', approved: 'accent', applying: 'accent', needs_you: 'warn', applied: 'good', failed: 'bad',
  replied: 'info', interview: 'good', offer: 'good', rejected: 'bad', skipped: 'neutral', filtered_out: 'neutral',
};

const STATUS_PHRASE: Partial<Record<JobStatus, string>> = {
  discovered: 'Discovered',
  filtered_out: 'Filtered out',
  scored: 'Scored',
  skipped: 'Skipped',
  tailoring: 'Tailoring CV + letter',
  ready: 'Ready for approval',
  approved: 'Approved',
  applying: 'Applying',
  needs_you: 'Needs you',
  applied: 'Applied',
  failed: 'Application failed',
  replied: 'Employer replied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function detailText(v: unknown): string | undefined {
  const direct = str(v);
  if (direct) return direct;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const r = v as Record<string, unknown>;
    return str(r.reason) ?? str(r.msg) ?? str(r.message) ?? str(r.summary) ?? str(r.note) ?? str(r.value) ?? str(r.by);
  }
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ') || undefined;
  return undefined;
}

function humanize(type: string): string {
  const words = type.replace(/[._-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Event';
}

export function describeEvent(e: EventRow): EventView {
  const d = e.detail ?? {};
  const base = { id: e.id, ts: e.ts, jobId: e.jobId };
  if (e.type === 'status') {
    const to = d.to as JobStatus | undefined;
    const title = (to && STATUS_PHRASE[to]) ?? `Status → ${String(to ?? '?')}`;
    const extra = detailText(d.detail);
    return { ...base, title, detail: extra, tone: (to && STATUS_TONE[to]) ?? 'neutral' };
  }
  if (e.type.startsWith('log.')) {
    const level = e.type.slice(4);
    const scope = str(d.scope);
    return {
      ...base,
      title: str(d.msg) ?? humanize(e.type),
      detail: scope,
      tone: level === 'error' ? 'bad' : level === 'warn' ? 'warn' : 'neutral',
    };
  }
  if (e.type === 'settings.updated') {
    const changed = Array.isArray(d.changed) ? d.changed.map(String).join(', ') : undefined;
    return { ...base, title: 'Settings changed', detail: changed, tone: 'neutral' };
  }
  const tone: EventTone = /fail|error/.test(e.type) ? 'bad' : /submit|applied|sent/.test(e.type) ? 'good' : 'neutral';
  return { ...base, title: humanize(e.type), detail: detailText(d), tone };
}

/** Event types that are noise on the Today feed. */
export function isFeedWorthy(e: EventRow): boolean {
  return e.type !== 'log.info' && !e.type.startsWith('llm.');
}
