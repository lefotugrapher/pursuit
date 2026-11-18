// Manual status moves Kayzee can make from the dashboard. Pure (shared by server actions and UI).
// Mirrors the lifecycle in SPEC §4; anything not listed here is the worker's job.

import type { JobStatus } from '@/lib/types';

export type ManualAction =
  | 'approve' | 'skip' | 'requeue' | 'markApplied' | 'markReplied' | 'markInterview' | 'markOffer' | 'markRejected' | 'withdraw';

export interface TransitionRule {
  to: JobStatus;
  from: readonly JobStatus[];
  label: string;
  tone: 'primary' | 'secondary' | 'good' | 'danger' | 'ghost';
}

const ALL_BUT = (...exclude: JobStatus[]): JobStatus[] =>
  (['discovered', 'filtered_out', 'scored', 'skipped', 'tailoring', 'ready', 'approved', 'applying', 'needs_you', 'applied', 'failed',
    'replied', 'interview', 'offer', 'rejected', 'withdrawn'] as JobStatus[]).filter((s) => !exclude.includes(s));

export const TRANSITIONS: Record<ManualAction, TransitionRule> = {
  approve: { to: 'approved', from: ['ready'], label: 'Approve', tone: 'primary' },
  skip: { to: 'skipped', from: ['discovered', 'filtered_out', 'scored', 'tailoring', 'ready', 'approved', 'needs_you', 'failed'], label: 'Skip', tone: 'secondary' },
  // Back to the approval queue: undo an approval before the worker picks it up, or retry a failed/handed-off job.
  requeue: { to: 'ready', from: ['approved', 'skipped', 'failed', 'needs_you'], label: 'Back to queue', tone: 'secondary' },
  markApplied: { to: 'applied', from: ['ready', 'approved', 'applying', 'needs_you', 'failed', 'skipped', 'scored'], label: 'Mark applied manually', tone: 'good' },
  markReplied: { to: 'replied', from: ['applied'], label: 'Mark replied', tone: 'secondary' },
  markInterview: { to: 'interview', from: ['applied', 'replied'], label: 'Mark interview', tone: 'good' },
  markOffer: { to: 'offer', from: ['applied', 'replied', 'interview'], label: 'Mark offer', tone: 'good' },
  markRejected: { to: 'rejected', from: ['applied', 'replied', 'interview', 'offer', 'approved', 'needs_you'], label: 'Mark rejected', tone: 'danger' },
  withdraw: { to: 'withdrawn', from: ALL_BUT('withdrawn', 'filtered_out', 'skipped'), label: 'Withdraw', tone: 'ghost' },
};

export const MANUAL_ACTIONS = Object.keys(TRANSITIONS) as ManualAction[];

export function isManualAction(value: unknown): value is ManualAction {
  return typeof value === 'string' && Object.hasOwn(TRANSITIONS, value);
}

export function canTransition(action: ManualAction, from: JobStatus): boolean {
  return TRANSITIONS[action].from.includes(from);
}

export function availableActions(status: JobStatus): ManualAction[] {
  return MANUAL_ACTIONS.filter((a) => canTransition(a, status));
}

export const SKIP_REASONS = [
  { id: 'not_interested', label: 'Not interested' },
  { id: 'location', label: 'Location' },
  { id: 'salary', label: 'Salary' },
  { id: 'seniority', label: 'Seniority' },
  { id: 'company', label: 'Company' },
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number]['id'];

export function isSkipReason(value: unknown): value is SkipReason {
  return typeof value === 'string' && SKIP_REASONS.some((r) => r.id === value);
}
