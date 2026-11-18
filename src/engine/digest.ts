// Daily digest: a plain-text summary of the last 24 hours, emailed only to Kayzee himself.

import { addMessage, countByStatus, funnelStats, getSettings, listEvents, listInbox, listJobs, listMessages, llmUsageSummary, STATUS_EVENT, updateMessage } from '@/lib/db';
import { env, hasMail, redactSecrets } from '@/lib/env';
import { log } from '@/lib/log';
import { dublinDayStartIso } from '@/lib/time';
import type { EmailKind, Job } from '@/lib/types';
import { fromHeader, getTransport } from '@/engine/outreach/smtp';
import { clip } from '@/engine/outreach/text';

const DASHBOARD_URL = 'http://localhost:7020';
const RESPONSE_KINDS: EmailKind[] = ['interview', 'rejection', 'offer', 'assessment', 'question'];

export interface DigestData {
  since: string;
  newJobs: number;
  newAboveMin: number;
  ready: number;
  applied24h: number;
  appliedWeek: number;
  replies: number;
  interviews: { company: string; title: string }[];
  rejections: number;
  offers: number;
  needsYou: Job[];
  draftsWaiting: number;
  llm: { calls: number; costUsd: number; failed: number };
  paused: boolean;
}

function jobLabel(job: Pick<Job, 'company' | 'title'>): string {
  return `${job.company}: ${job.title}`;
}

export function collectDigest(now: Date = new Date()): DigestData {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const settings = getSettings();
  const recentJobs = listJobs({ orderBy: 'discoveredAt', limit: 2000 }).filter((j) => j.discoveredAt >= since);
  const statusEvents = listEvents({ type: STATUS_EVENT, since, limit: 5000 });
  const applied24h = new Set(statusEvents.filter((e) => e.detail?.to === 'applied' && e.jobId).map((e) => e.jobId)).size;
  const inbox = listInbox({ since, limit: 500 }).filter((i) => i.kind && RESPONSE_KINDS.includes(i.kind));
  const interviewJobs = listJobs({ status: 'interview', orderBy: 'updatedAt', limit: 20 });
  const usage = llmUsageSummary(since);

  return {
    since,
    newJobs: recentJobs.length,
    newAboveMin: recentJobs.filter((j) => (j.score ?? -1) >= settings.minScore).length,
    ready: countByStatus().ready,
    applied24h,
    appliedWeek: funnelStats().appliedWeek,
    replies: inbox.filter((i) => i.jobId).length,
    interviews: inbox
      .filter((i) => i.kind === 'interview')
      .map((i) => interviewJobs.find((j) => j.id === i.jobId) ?? { company: i.fromAddress.split('@')[1] ?? i.fromAddress, title: i.subject }),
    rejections: inbox.filter((i) => i.kind === 'rejection').length,
    offers: inbox.filter((i) => i.kind === 'offer').length,
    needsYou: listJobs({ status: 'needs_you', orderBy: 'updatedAt', limit: 50 }),
    draftsWaiting: listMessages({ status: 'draft', direction: 'out', limit: 500 }).length,
    llm: { calls: usage.calls, costUsd: usage.costUsd, failed: usage.failed },
    paused: settings.paused,
  };
}

/** Plain-text digest (markdown-friendly) of the last 24 hours. */
export function buildDigest(now: Date = new Date()): string {
  const d = collectDigest(now);
  const date = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' }).format(now);
  const lines: string[] = [`Pursuit daily digest, ${date}`, ''];
  if (d.paused) lines.push('Pursuit is PAUSED: nothing is being submitted or sent.', '');

  lines.push(
    `New jobs: ${d.newJobs}${d.newJobs ? ` (${d.newAboveMin} at or above your minimum score)` : ''}`,
    `Ready to approve: ${d.ready}`,
    `Applied in the last 24h: ${d.applied24h} (this week: ${d.appliedWeek})`,
    `Employer replies: ${d.replies}${d.rejections ? ` (${d.rejections} rejection${d.rejections === 1 ? '' : 's'})` : ''}`,
    `Interview invites: ${d.interviews.length}${d.offers ? ` · Offers: ${d.offers}` : ''}`,
  );
  for (const i of d.interviews.slice(0, 10)) lines.push(`  - ${clip(jobLabel(i), 120)}`);

  lines.push('', `Needs you: ${d.needsYou.length}`);
  for (const job of d.needsYou.slice(0, 10)) {
    const why = job.needs?.length ? ` (${clip(job.needs.join('; '), 80)})` : '';
    lines.push(`  - ${clip(jobLabel(job), 100)}${why}`);
  }
  if (d.needsYou.length > 10) lines.push(`  - and ${d.needsYou.length - 10} more`);
  lines.push(`Drafts waiting for approval: ${d.draftsWaiting}`);

  const cost = d.llm.costUsd > 0 ? `$${d.llm.costUsd.toFixed(d.llm.costUsd < 0.1 ? 4 : 2)}` : '$0';
  lines.push('', `LLM: ${d.llm.calls} call${d.llm.calls === 1 ? '' : 's'}, ${cost}${d.llm.failed ? `, ${d.llm.failed} failed` : ''}`);
  lines.push('', `Open the dashboard: ${DASHBOARD_URL}`);
  return lines.join('\n');
}

export interface DigestSendResult { sent: boolean; reason?: string; messageId?: number }

/** Emails the digest to GMAIL_USER (never anyone else). One per Dublin day unless `force`. */
export async function sendDigestToSelf(opts: { now?: Date; force?: boolean } = {}): Promise<DigestSendResult> {
  const now = opts.now ?? new Date();
  const to = env.GMAIL_USER;
  if (!hasMail() || !to) return { sent: false, reason: 'mail not configured' };
  if (getSettings().paused) return { sent: false, reason: 'paused' };
  const todayStart = dublinDayStartIso(0, now);
  if (!opts.force && listMessages({ kind: 'digest', status: ['sent', 'in_gmail'], limit: 5 }).some((m) => (m.sentAt ?? m.createdAt) >= todayStart)) {
    return { sent: false, reason: 'already sent today' };
  }
  const transport = getTransport();
  const from = fromHeader('Pursuit');
  if (!transport || !from) return { sent: false, reason: 'mail not configured' };

  const body = buildDigest(now);
  const subject = body.split('\n')[0];
  try {
    const info = await transport.sendMail({ from, to, subject, text: body });
    // draftOnly = SMTP unreachable, so the digest sits in Gmail Drafts rather than the inbox.
    const msg = addMessage({ direction: 'out', channel: 'email', kind: 'digest', to, subject, body, status: info.draftOnly ? 'in_gmail' : 'sent' });
    if (info.messageId) updateMessage(msg.id, { messageId: info.messageId });
    return { sent: !info.draftOnly, reason: info.draftOnly ? 'saved to Gmail Drafts (SMTP unreachable)' : undefined, messageId: msg.id };
  } catch (err) {
    const error = redactSecrets((err as Error).message ?? String(err));
    const msg = addMessage({ direction: 'out', channel: 'email', kind: 'digest', to, subject, body, status: 'failed' });
    updateMessage(msg.id, { error });
    log.warn('digest', 'digest email failed', { error });
    return { sent: false, reason: error, messageId: msg.id };
  }
}
