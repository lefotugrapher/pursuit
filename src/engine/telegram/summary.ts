// Text builders for /status, /today and the morning summary. Server-only, read-only.

import { countByStatus, funnelStats, getSettings, listEvents, listInbox, listJobs, STATUS_EVENT } from '@/lib/db';
import { dublinDayStartIso } from '@/lib/time';
import type { EmailKind } from '@/lib/types';
import { collectDigest } from '@/engine/digest';
import { pendingQuestions } from '@/engine/questions';

const RESPONSE_KINDS = new Set<EmailKind>(['interview', 'rejection', 'offer', 'assessment', 'question']);
const s = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
const day = (now: Date) => new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' }).format(now);

/** /status: counts at a glance. */
export function buildStatusText(): string {
  const counts = countByStatus();
  const f = funnelStats();
  const settings = getSettings();
  const questions = pendingQuestions().length;
  return [
    'Pursuit status',
    `Ready to approve: ${counts.ready}`,
    `Applied: ${f.appliedToday} today, ${f.appliedWeek} this week`,
    `In the apply queue: ${counts.approved + counts.applying}`,
    `Needs you: ${counts.needs_you}${questions ? ` (${s(questions, 'question')} waiting here)` : ''}`,
    `Interviews: ${counts.interview}`,
    settings.paused ? 'PAUSED: nothing is submitted or sent. Send /resume to start again.'
      : settings.mode === 'autopilot' && settings.autopilot.enabled ? 'Mode: autopilot (within its limits)' : 'Mode: review (you approve each application)',
  ].join('\n');
}

/** /today: what happened since midnight (Dublin). */
export function buildTodayText(now: Date = new Date()): string {
  const since = dublinDayStartIso(0, now);
  const appliedIds = [...new Set(listEvents({ type: STATUS_EVENT, since, limit: 5000 })
    .filter((e) => e.detail?.to === 'applied' && e.jobId).map((e) => e.jobId as string))];
  const jobs = new Map(listJobs({ orderBy: 'updatedAt', limit: 3000 }).map((j) => [j.id, j]));
  const newJobs = [...jobs.values()].filter((j) => j.discoveredAt >= since).length;
  const replies = listInbox({ since, limit: 500 }).filter((i) => i.jobId && i.kind && RESPONSE_KINDS.has(i.kind));
  const interviews = replies.filter((i) => i.kind === 'interview').length;
  const counts = countByStatus();
  const lines = [`Today so far (${day(now)})`, `Applied: ${appliedIds.length}`];
  for (const id of appliedIds.slice(0, 8)) {
    const j = jobs.get(id);
    if (j) lines.push(`  • ${clip(`${j.company}: ${j.title}`, 90)}`);
  }
  lines.push(
    `New jobs found: ${newJobs}`,
    `Employer replies: ${replies.length}${interviews ? ` (${s(interviews, 'interview invite')})` : ''}`,
    `Needs you: ${counts.needs_you} · Questions waiting: ${pendingQuestions().length}`,
  );
  return lines.join('\n');
}

/** Morning summary: found, applied, replies, interviews, needs-you (last 24 hours). */
export function buildDailySummary(now: Date = new Date()): string {
  const d = collectDigest(now);
  const questions = pendingQuestions().length;
  const lines = [`Good morning. Pursuit, ${day(now)}`, ''];
  if (d.paused) lines.push('Paused: nothing is being submitted or sent. Send /resume to start again.', '');
  lines.push(
    `Found: ${s(d.newJobs, 'new job')}${d.newJobs ? ` (${d.newAboveMin} at or above your minimum score)` : ''}`,
    `Ready to approve: ${d.ready}`,
    `Applied: ${d.applied24h} in the last 24 hours, ${d.appliedWeek} this week`,
    `Replies: ${d.replies}${d.rejections ? ` (${s(d.rejections, 'rejection')})` : ''}${d.offers ? `, ${s(d.offers, 'offer')}` : ''}`,
    `Interviews: ${d.interviews.length}`,
  );
  for (const i of d.interviews.slice(0, 5)) lines.push(`  • ${clip(`${i.company}: ${i.title}`, 90)}`);
  lines.push(`Needs you: ${d.needsYou.length}`);
  for (const j of d.needsYou.slice(0, 5)) lines.push(`  • ${clip(`${j.company}: ${j.title}`, 70)}${j.needs?.length ? ` (${clip(j.needs[0], 70)})` : ''}`);
  if (d.needsYou.length > 5) lines.push(`  • and ${d.needsYou.length - 5} more`);
  if (questions) lines.push(`Questions waiting for you here: ${questions}`);
  lines.push(`Drafts waiting for approval: ${d.draftsWaiting}`);
  return lines.join('\n');
}
