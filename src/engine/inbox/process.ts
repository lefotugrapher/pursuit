// Inbox pipeline: fetch → store → classify → act. Actions are limited to status changes, drafts
// (which need approval), notifications, job imports from alert emails and prep packs. Nothing an
// email says is ever executed: replies always go back to the sender, never to an address in the body.

import { loadFacts, loadProfile, loadSources } from '@/lib/config';
import { addInbox, latestArtifact, listApplications, listInbox, listJobs, logEvent, setStatus, updateApplication, updateInbox, upsertJob } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import type { Classification, EmailKind, FactBank, InboundEmail, InboxItem, Job, JobStatus, Profile, RawJob } from '@/lib/types';
import { normalizeJob } from '@/engine/sources/normalize';
import { buildPrepPack } from '@/engine/prep';
import { notify } from '@/engine/notify';
import { draftReply } from '@/engine/outreach/draft';
import { isNoReplyAddress, normalizeEmail } from '@/engine/outreach/text';
import { classifyEmail, stripQuoted } from './classify';
import { isJobRelated } from './privacy';
import { extractProposedTimes, formatProposedTime, googleCalendarUrl } from './calendar';
import { fetchNewEmails } from './imap';

export interface InboxStats {
  fetched: number;
  stored: number;
  duplicates: number;
  skippedSelf: number;
  /** Personal (non-job) emails skipped without being stored or read further. */
  skippedPrivate?: number;
  processed: number;
  byKind: Record<EmailKind, number>;
  jobsImported: number;
  jobsCreated: number;
  statusChanges: number;
  drafts: number;
  notifications: number;
  prepPacks: number;
  errors: number;
}

export interface ProcessOptions {
  /** Use these emails instead of fetching over IMAP (tests, manual import). */
  emails?: InboundEmail[];
  /** Build interview prep packs (default true; may fetch the company homepage). */
  buildPrep?: boolean;
  /** Send desktop/phone notifications (default true). */
  notify?: boolean;
  /** Re-run unprocessed rows left by an earlier crash (default true). */
  resumeUnprocessed?: boolean;
}

/** Jobs an inbound email may be about. */
const MATCHABLE: JobStatus[] = ['ready', 'approved', 'applying', 'needs_you', 'applied', 'replied', 'interview', 'offer', 'failed'];
const RESPONDED_FROM: JobStatus[] = ['applied', 'replied', 'interview'];
const MAX_BODY_CHARS = 60_000;

function emptyStats(): InboxStats {
  return {
    fetched: 0, stored: 0, duplicates: 0, skippedSelf: 0, processed: 0,
    byKind: { interview: 0, rejection: 0, offer: 0, assessment: 0, question: 0, confirmation: 0, job_alert: 0, other: 0 },
    jobsImported: 0, jobsCreated: 0, statusChanges: 0, drafts: 0, notifications: 0, prepPacks: 0, errors: 0,
  };
}

function selfAddresses(profile: Profile | null): Set<string> {
  return new Set([normalizeEmail(env.GMAIL_USER), normalizeEmail(profile?.email)].filter((a): a is string => Boolean(a)));
}

/** Rebuilds an InboundEmail from a stored row (used when resuming; html/links aren't stored). */
function fromInboxItem(item: InboxItem): InboundEmail {
  return { messageId: item.messageId, from: item.from, fromAddress: item.fromAddress, subject: item.subject, date: item.date, text: item.body };
}

interface Ctx {
  stats: InboxStats;
  jobs: Job[];
  facts: FactBank | null;
  profile: Profile | null;
  opts: Required<Pick<ProcessOptions, 'buildPrep' | 'notify'>>;
}

async function maybeNotify(ctx: Ctx, title: string, body: string, priority: 'default' | 'high' = 'default'): Promise<void> {
  if (!ctx.opts.notify) return;
  await notify(title, body, { priority, url: 'http://localhost:7020/inbox' });
  ctx.stats.notifications++;
}

function refreshJob(ctx: Ctx, job: Job | undefined, status: JobStatus, detail: Record<string, unknown>): Job | undefined {
  if (!job || job.status === status) return job;
  const updated = setStatus(job.id, status, detail);
  if (updated) {
    ctx.stats.statusChanges++;
    const i = ctx.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) ctx.jobs[i] = updated;
  }
  return updated ?? job;
}

async function makeReplyDraft(ctx: Ctx, item: InboxItem, job: Job | undefined, kind: EmailKind): Promise<void> {
  if (!ctx.facts || !ctx.profile) return;
  if (isNoReplyAddress(item.fromAddress)) return; // nobody reads a no-reply mailbox, and it could never be sent
  try {
    await draftReply({ ...item, kind }, job, ctx.facts, { profile: ctx.profile, kind });
    ctx.stats.drafts++;
  } catch (err) {
    ctx.stats.errors++;
    log.warn('inbox', `could not draft a reply for "${item.subject}"`, { error: (err as Error).message });
  }
}

// ───────────────────────────── Handlers ─────────────────────────────

export const ALERT_MAX_AGE_DAYS = 21;

async function importAlertJobs(ctx: Ctx, email: InboundEmail): Promise<boolean> {
  let enabled = true;
  try {
    enabled = loadSources().gmailAlerts.enabled;
  } catch {
    // config unreadable: default to importing
  }
  if (!enabled) return true;

  let parse: ((msg: InboundEmail) => RawJob[]) | undefined;
  try {
    parse = (await import('@/engine/sources/gmailAlerts')).parseAlertEmail;
  } catch (err) {
    log.warn('inbox', 'job alert parser unavailable; alert left unhandled', { error: (err as Error).message });
    return false;
  }
  // A job alert older than this lists postings that are almost certainly closed: don't import them.
  const sent = Date.parse(email.date ?? '');
  if (Number.isFinite(sent) && Date.now() - sent > ALERT_MAX_AGE_DAYS * 86_400_000) return true;
  const raws = parse(email);
  for (const raw of raws) {
    try {
      const { created } = upsertJob(normalizeJob(raw));
      ctx.stats.jobsImported++;
      if (created) ctx.stats.jobsCreated++;
    } catch (err) {
      ctx.stats.errors++;
      log.warn('inbox', `could not import alert job "${raw.title}"`, { error: (err as Error).message });
    }
  }
  return true;
}

function calendarNote(email: InboundEmail, cls: Classification, job: Job | undefined): string | undefined {
  const ref = new Date(email.date);
  const times = extractProposedTimes(stripQuoted(email.text), Number.isNaN(ref.getTime()) ? new Date() : ref);
  if (!times.length) return undefined;
  const title = job ? `Interview: ${job.title} at ${job.company}` : `Interview: ${email.subject}`.slice(0, 120);
  const lines = times.slice(0, 3).map((t) => {
    const url = googleCalendarUrl({ title, start: t.start, end: t.end, allDay: t.allDay, details: `From: ${email.from}\nSubject: ${email.subject}` });
    return `Proposed ${formatProposedTime(t)}: add to calendar ${url}`;
  });
  return `${cls.summary}\n${lines.join('\n')}`;
}

async function onInterview(ctx: Ctx, item: InboxItem, email: InboundEmail, cls: Classification, job: Job | undefined): Promise<string | undefined> {
  const updated = job && job.status !== 'offer' ? refreshJob(ctx, job, 'interview', { inboxId: item.id, subject: email.subject }) : job;
  await maybeNotify(ctx, updated ? `Interview: ${updated.company}` : 'Interview request', updated ? `${updated.title}. Reply drafted for approval.` : email.subject, 'high');
  await makeReplyDraft(ctx, item, updated, 'interview');

  if (updated && ctx.opts.buildPrep && ctx.facts && ctx.profile && !latestArtifact(updated.id, 'prep')) {
    try {
      const times = cls.proposedTimes?.[0];
      await buildPrepPack(updated, ctx.facts, ctx.profile, times ? { interviewAt: times } : {});
      ctx.stats.prepPacks++;
    } catch (err) {
      ctx.stats.errors++;
      log.warn('inbox', `prep pack failed for ${updated.company}`, { error: (err as Error).message });
    }
  }
  return calendarNote(email, cls, updated);
}

function onConfirmation(item: InboxItem, email: InboundEmail, job: Job | undefined): void {
  logEvent('inbox.confirmation', { inboxId: item.id, subject: email.subject, from: email.fromAddress }, job?.id);
  if (!job) return;
  const app = listApplications({ jobId: job.id, limit: 1 })[0];
  if (app && !app.confirmation) {
    updateApplication(app.id, { confirmation: `Confirmation email ${email.date.slice(0, 10)}: "${email.subject.slice(0, 160)}"` });
  }
}

// ───────────────────────────── Per-email ─────────────────────────────

async function processOne(ctx: Ctx, item: InboxItem, email: InboundEmail): Promise<void> {
  const cls = await classifyEmail(email, ctx.jobs);
  const job = cls.jobId ? ctx.jobs.find((j) => j.id === cls.jobId) : undefined;
  ctx.stats.byKind[cls.kind]++;
  let summary = cls.summary;
  let handled = false;

  switch (cls.kind) {
    case 'job_alert':
      handled = await importAlertJobs(ctx, email);
      break;
    case 'interview':
      summary = (await onInterview(ctx, item, email, cls, job)) ?? summary;
      break;
    case 'rejection':
      if (job && RESPONDED_FROM.includes(job.status)) refreshJob(ctx, job, 'rejected', { inboxId: item.id, subject: email.subject });
      handled = true;
      break;
    case 'offer': {
      const updated = job && RESPONDED_FROM.includes(job.status) ? refreshJob(ctx, job, 'offer', { inboxId: item.id, subject: email.subject }) : job;
      await maybeNotify(ctx, updated ? `Offer: ${updated.company}` : 'Possible job offer', updated ? updated.title : email.subject, 'high');
      break;
    }
    case 'question':
    case 'assessment': {
      const updated = job?.status === 'applied' ? refreshJob(ctx, job, 'replied', { inboxId: item.id, subject: email.subject }) : job;
      const label = cls.kind === 'assessment' ? 'Assessment' : 'Question';
      await maybeNotify(ctx, `${label}: ${updated?.company ?? email.from}`, `${email.subject}. Reply drafted for approval.`);
      await makeReplyDraft(ctx, item, updated, cls.kind);
      break;
    }
    case 'confirmation':
      onConfirmation(item, email, job);
      handled = true;
      break;
    case 'other':
      handled = !job; // unrelated mail needs nothing; mail linked to a job stays visible
      break;
  }

  updateInbox(item.id, { kind: cls.kind, confidence: cls.confidence, summary: summary.slice(0, 4000), jobId: job?.id, handled });
  if (job) logEvent('inbox.email', { inboxId: item.id, kind: cls.kind, subject: email.subject.slice(0, 200), llmUsed: cls.llmUsed }, job.id);
  ctx.stats.processed++;
}

// ───────────────────────────── Public API ─────────────────────────────

/** Fetches (unless `emails` given), stores, classifies and acts on new inbound email. */
export async function processInbox(opts: ProcessOptions = {}): Promise<InboxStats> {
  const stats = emptyStats();
  const emails = opts.emails ?? (await fetchNewEmails());
  stats.fetched = emails.length;

  let facts: FactBank | null = null;
  let profile: Profile | null = null;
  try { facts = loadFacts(); } catch (err) { log.warn('inbox', 'fact bank unreadable; replies will not be drafted', { error: (err as Error).message }); }
  try { profile = loadProfile(); } catch (err) { log.warn('inbox', 'profile unreadable; replies will not be drafted', { error: (err as Error).message }); }

  const self = selfAddresses(profile);
  const pending: { item: InboxItem; email: InboundEmail }[] = [];
  const gateJobs = listJobs({ status: MATCHABLE, orderBy: 'updatedAt', limit: 2000 });

  // Phase 1: store job-search mail first, so a crash mid-run never loses it (the IMAP cursor already moved).
  // PRIVACY: this is Kayzee's personal inbox. Anything not about his job search is skipped entirely:
  // never stored, shown, classified or sent to an AI model (see ./privacy.ts).
  for (const email of emails) {
    if (self.has(normalizeEmail(email.fromAddress) ?? '')) { stats.skippedSelf++; continue; }
    if (!isJobRelated(email, gateJobs)) { stats.skippedPrivate = (stats.skippedPrivate ?? 0) + 1; continue; }
    try {
      const { item, created } = addInbox({
        messageId: email.messageId,
        fromAddress: normalizeEmail(email.fromAddress) ?? email.fromAddress,
        from: email.from,
        subject: email.subject,
        date: email.date,
        body: (email.text ?? '').slice(0, MAX_BODY_CHARS),
      });
      if (created) stats.stored++;
      else stats.duplicates++;
      if (!item.kind) pending.push({ item, email });
    } catch (err) {
      stats.errors++;
      log.warn('inbox', `could not store email "${email.subject}"`, { error: (err as Error).message });
    }
  }

  if (opts.resumeUnprocessed !== false) {
    const queued = new Set(pending.map((p) => p.item.id));
    for (const item of listInbox({ handled: false, limit: 200 })) {
      if (!item.kind && !queued.has(item.id) && !self.has(item.fromAddress)) pending.push({ item, email: fromInboxItem(item) });
    }
  }

  // Phase 2: classify and act, one email at a time; a failure never stops the rest.
  const ctx: Ctx = {
    stats,
    jobs: listJobs({ status: MATCHABLE, orderBy: 'updatedAt', limit: 2000 }),
    facts,
    profile,
    opts: { buildPrep: opts.buildPrep ?? true, notify: opts.notify ?? true },
  };
  pending.sort((a, b) => a.email.date.localeCompare(b.email.date));
  for (const { item, email } of pending) {
    try {
      await processOne(ctx, item, email);
    } catch (err) {
      stats.errors++;
      const message = (err as Error).message;
      log.error('inbox', `failed to process "${email.subject}"`, { error: message });
      // Park it as 'other' (unhandled, so it stays visible) instead of retrying a broken email every run.
      try {
        updateInbox(item.id, { kind: 'other', handled: false, summary: `Could not process automatically: ${message}`.slice(0, 500) });
      } catch {
        // already logged
      }
    }
  }
  return stats;
}
