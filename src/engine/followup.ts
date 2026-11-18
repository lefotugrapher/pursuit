// Drafts follow-ups for applications that have gone quiet (SPEC §5.6). Follow-ups are drafts only:
// they are sent after Kayzee approves them. Rules:
//   - job status is 'applied' and it was applied ≥ settings.followUpDays ago
//   - no response (no linked inbound mail other than confirmations/alerts, no inbound messages)
//   - a verified contact email exists for the job/company
//   - at most two follow-ups ever; the second only ≥14 days after the first was sent
//   - a pending or discarded follow-up blocks a new one (discarding means "don't follow up")

import { loadFacts, loadProfile } from '@/lib/config';
import { getSettings, listApplications, listEvents, listInbox, listJobs, listMessages, STATUS_EVENT } from '@/lib/db';
import { log } from '@/lib/log';
import { daysBetween } from '@/lib/time';
import type { Application, Contact, FactBank, Job, Message, Profile } from '@/lib/types';
import { draftFollowUp, verifiedContactFor } from '@/engine/outreach/draft';

export const SECOND_FOLLOW_UP_AFTER_DAYS = 14;
export const MAX_FOLLOW_UPS = 2;

export type FollowUpSkip = 'too_soon' | 'responded' | 'no_contact' | 'pending_follow_up' | 'discarded' | 'max_reached' | 'second_too_soon' | 'no_applied_date';

export interface FollowUpPlan {
  job: Job;
  application?: Application;
  appliedAt?: string;
  contact?: Contact;
  nth: number;
  skip?: FollowUpSkip;
}

export interface FollowUpSummary { considered: number; drafted: number; skipped: Partial<Record<FollowUpSkip, number>>; errors: number }

/** When the job was applied: confirmed submission, else the status event that moved it to 'applied'. */
export function appliedAtFor(job: Job, application?: Application): string | undefined {
  if (application?.submittedAt) return application.submittedAt;
  const events = listEvents({ jobId: job.id, type: STATUS_EVENT, limit: 200 });
  const applied = events.filter((e) => e.detail?.to === 'applied').map((e) => e.ts).sort();
  return applied[0];
}

function hasResponse(job: Job): boolean {
  const inbound = listInbox({ jobId: job.id, limit: 50 }).some((i) => i.kind !== 'confirmation' && i.kind !== 'job_alert');
  return inbound || listMessages({ jobId: job.id, direction: 'in', limit: 1 }).length > 0;
}

/** Decides whether (and which) follow-up a job needs right now. Pure apart from DB reads. */
export function planFollowUp(job: Job, followUpDays: number, now: Date = new Date()): FollowUpPlan {
  const application = listApplications({ jobId: job.id, status: 'submitted', limit: 1 })[0];
  const appliedAt = appliedAtFor(job, application);
  const plan: FollowUpPlan = { job, application, appliedAt, nth: 1 };
  if (!appliedAt) return { ...plan, skip: 'no_applied_date' };
  if (daysBetween(appliedAt, now) < followUpDays) return { ...plan, skip: 'too_soon' };
  if (hasResponse(job)) return { ...plan, skip: 'responded' };

  const previous: Message[] = listMessages({ jobId: job.id, kind: 'follow_up', limit: 20 });
  if (previous.some((m) => m.status === 'draft' || m.status === 'approved')) return { ...plan, skip: 'pending_follow_up' };
  if (previous.some((m) => m.status === 'discarded')) return { ...plan, skip: 'discarded' };
  const sent = previous.filter((m) => m.status === 'sent');
  if (sent.length >= MAX_FOLLOW_UPS) return { ...plan, skip: 'max_reached' };
  if (sent.length === 1) {
    const lastSent = sent[0].sentAt ?? sent[0].createdAt;
    if (daysBetween(lastSent, now) < SECOND_FOLLOW_UP_AFTER_DAYS) return { ...plan, skip: 'second_too_soon' };
    plan.nth = 2;
  }
  // A failed attempt doesn't count as a follow-up; it's simply drafted again.

  const contact = verifiedContactFor(job);
  if (!contact) return { ...plan, skip: 'no_contact' };
  return { ...plan, contact };
}

/** Drafts every due follow-up. Returns counts; never sends anything. */
export async function scheduleFollowUps(opts: { now?: Date; facts?: FactBank; profile?: Profile } = {}): Promise<FollowUpSummary> {
  const now = opts.now ?? new Date();
  const { followUpDays } = getSettings();
  const summary: FollowUpSummary = { considered: 0, drafted: 0, skipped: {}, errors: 0 };
  const jobs = listJobs({ status: 'applied', orderBy: 'updatedAt', dir: 'asc' });
  if (!jobs.length) return summary;

  const facts = opts.facts ?? loadFacts();
  const profile = opts.profile ?? loadProfile();
  for (const job of jobs) {
    summary.considered++;
    const plan = planFollowUp(job, followUpDays, now);
    if (plan.skip) {
      summary.skipped[plan.skip] = (summary.skipped[plan.skip] ?? 0) + 1;
      continue;
    }
    try {
      await draftFollowUp(job, plan.application, facts, { contact: plan.contact, appliedAt: plan.appliedAt, nth: plan.nth, profile });
      summary.drafted++;
    } catch (err) {
      summary.errors++;
      log.warn('followup', `could not draft follow-up for ${job.company}`, { error: (err as Error).message });
    }
  }
  return summary;
}
