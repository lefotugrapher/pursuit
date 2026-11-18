// Server data helpers for the secondary dashboard pages: pipeline, inbox, outreach, interviews,
// analytics, sources and settings. Server-only (reads SQLite and the filesystem).
//
// Pure helpers (transitions, parsing, templates, aggregation) are exported separately from the
// DB-backed loaders so they can be unit-tested without a database.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  countJobs, db, getContact, getInbox, getJob, kvGet, latestArtifact, listContacts, listEvents, listInbox, listJobs,
  listMessages,
} from './db';
import { ARTIFACTS_DIR, ROOT, isInside } from './paths';
import {
  STATUS_GROUPS,
  type AnswerBank, type AnswerEntry, type Artifact, type AtsKind, type Settings, type Contact, type EmailKind, type Fact, type FunnelStats,
  type InboxItem, type Job, type JobStatus, type Message, type Profile, type ResponseRateRow, type SourceId,
  type WatchCompany,
} from './types';

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'info';

// ───────────────────────────── Generic parsing ─────────────────────────────

/** Splits a textarea/comma list into trimmed, de-duplicated (case-insensitive), non-empty items. */
export function parseList(text: string | null | undefined, separators: RegExp = /[\n,]/): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(separators)) {
    const item = raw.trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Reads a finite number from a form value; undefined when blank or not numeric. */
export function parseNumber(value: FormDataEntryValue | null | undefined): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

export function formString(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;
export const isEmail = (s: string | undefined | null): boolean => Boolean(s && EMAIL_RE.test(s.trim()));

/** Only http(s) URLs are ever rendered as links (untrusted input never yields javascript: etc.). */
export function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────────── Pipeline ─────────────────────────────

/**
 * Status moves Kayzee may make by hand from the dashboard. Worker-owned states (tailoring,
 * applying) are never targets, and `applied` is only reachable from needs_you (after a headed
 * handoff he completed himself) or failed (he applied outside Pursuit), per SPEC §4.
 */
export const PIPELINE_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  discovered: ['skipped', 'withdrawn'],
  scored: ['skipped', 'withdrawn'],
  tailoring: ['skipped', 'withdrawn'],
  filtered_out: ['scored'],
  skipped: ['scored'],
  ready: ['approved', 'skipped', 'withdrawn'],
  approved: ['ready', 'skipped', 'withdrawn'],
  applying: ['withdrawn'],
  needs_you: ['applied', 'approved', 'skipped', 'withdrawn'],
  failed: ['approved', 'applied', 'skipped', 'withdrawn'],
  applied: ['replied', 'interview', 'rejected', 'withdrawn'],
  replied: ['interview', 'offer', 'rejected', 'withdrawn'],
  interview: ['offer', 'rejected', 'withdrawn'],
  offer: ['rejected', 'withdrawn'],
  rejected: ['applied', 'interview'],
  withdrawn: ['scored'],
};

export const TRANSITION_LABEL: Partial<Record<JobStatus, string>> = {
  approved: 'Approve',
  skipped: 'Skip',
  withdrawn: 'Withdraw',
  scored: 'Back to inbox',
  ready: 'Back to ready',
  applied: 'Mark applied',
  replied: 'Mark replied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
};

export function allowedTransitions(from: JobStatus): JobStatus[] {
  return PIPELINE_TRANSITIONS[from] ?? [];
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return allowedTransitions(from).includes(to);
}

export interface PipelineCard {
  id: string;
  company: string;
  title: string;
  location: string;
  status: JobStatus;
  score?: number;
  flags: number;
  ageDays: number;
  updatedAt: string;
}

export interface PipelineColumn {
  name: string;
  statuses: JobStatus[];
  total: number;
  cards: PipelineCard[];
}

/** Distinct soft flags + blockers on a job (score flags, filter flags, needs). */
export function jobFlags(job: Pick<Job, 'scoreDetail' | 'filters' | 'needs'>): string[] {
  const all = [...(job.scoreDetail?.flags ?? []), ...(job.filters?.flags ?? []), ...(job.needs ?? [])];
  return [...new Set(all.map((f) => f.trim()).filter(Boolean))];
}

export function ageInDays(iso: string | undefined, now: Date = new Date()): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function toPipelineCard(job: Job, now: Date = new Date()): PipelineCard {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    status: job.status,
    score: job.score,
    flags: jobFlags(job).length,
    ageDays: ageInDays(job.postedAt ?? job.discoveredAt, now),
    updatedAt: job.updatedAt,
  };
}

/** Kanban columns in STATUS_GROUPS order. Active columns are ordered by score, Closed by recency. */
export function pipelineColumns(limitPerColumn = 80): PipelineColumn[] {
  const now = new Date();
  return Object.entries(STATUS_GROUPS).map(([name, statuses]) => {
    const orderBy = name === 'Closed' || name === 'Applied' ? 'updatedAt' : 'score';
    const jobs = listJobs({ status: statuses, orderBy, dir: 'desc', limit: limitPerColumn });
    return { name, statuses, total: countJobs({ status: statuses }), cards: jobs.map((j) => toPipelineCard(j, now)) };
  });
}

// ───────────────────────────── Inbox ─────────────────────────────

export const INBOX_KINDS: EmailKind[] = ['interview', 'offer', 'assessment', 'question', 'rejection', 'confirmation', 'job_alert', 'other'];

export const INBOX_KIND_TONE: Record<EmailKind, Tone> = {
  interview: 'good',
  offer: 'good',
  rejection: 'bad',
  assessment: 'warn',
  question: 'info',
  confirmation: 'neutral',
  job_alert: 'neutral',
  other: 'neutral',
};

export const INBOX_KIND_LABEL: Record<EmailKind, string> = {
  interview: 'Interview',
  offer: 'Offer',
  rejection: 'Rejection',
  assessment: 'Assessment',
  question: 'Question',
  confirmation: 'Confirmation',
  job_alert: 'Job alert',
  other: 'Other',
};

export function isEmailKind(v: unknown): v is EmailKind {
  return typeof v === 'string' && (INBOX_KINDS as string[]).includes(v);
}

const CALENDAR_HOSTS = [
  'calendar.google.com', 'calendly.com', 'cal.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.live.com',
  'meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'savvycal.com', 'goodtime.io',
];

/** Scheduling / meeting links found in an email body (http(s) only, deduped, capped). */
export function extractCalendarLinks(text: string, max = 5): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'()\[\]]+/gi)) {
    const url = safeHttpUrl(m[0].replace(/[.,;:!?]+$/, ''));
    if (!url) continue;
    const host = new URL(url).hostname.toLowerCase();
    if (!CALENDAR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

export interface InboxExtras {
  proposedTimes: string[];
  /** Google Calendar "add event" link built by the inbox processor, if any. */
  calendarUrl?: string;
  /** Scheduling/meeting links seen in the email body (untrusted: shown, never followed). */
  meetingLinks: string[];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/**
 * Pulls proposed times / calendar link for an inbox item out of event details the inbox processor
 * wrote (any event whose detail references the item by inboxId or messageId).
 */
export function extrasFromEvents(item: Pick<InboxItem, 'id' | 'messageId' | 'body'>, details: unknown[]): InboxExtras {
  const times: string[] = [];
  let calendarUrl: string | undefined;
  for (const raw of details) {
    const d = asRecord(raw);
    if (!d) continue;
    const refersToItem = d.inboxId === item.id || (typeof d.messageId === 'string' && d.messageId === item.messageId);
    if (!refersToItem) continue;
    for (const t of stringArray(d.proposedTimes)) if (!times.includes(t)) times.push(t);
    calendarUrl ??= safeHttpUrl(d.calendarUrl) ?? safeHttpUrl(d.calendarLink) ?? safeHttpUrl(d.gcalUrl);
  }
  return { proposedTimes: times, calendarUrl, meetingLinks: extractCalendarLinks(item.body ?? '') };
}

export function inboxExtras(item: InboxItem): InboxExtras {
  const events = item.jobId ? listEvents({ jobId: item.jobId, limit: 300 }) : listEvents({ typePrefix: 'inbox', limit: 300 });
  return extrasFromEvents(item, events.map((e) => e.detail));
}

export interface InboxListRow { item: InboxItem; job?: Pick<Job, 'id' | 'company' | 'title' | 'status'> }

export function inboxList(opts: { kind?: EmailKind; showHandled?: boolean; limit?: number } = {}): InboxListRow[] {
  const items = listInbox({ kind: opts.kind, handled: opts.showHandled ? undefined : false, limit: opts.limit ?? 200 });
  const jobs = new JobCache();
  return items.map((item) => ({ item, job: jobs.brief(item.jobId) }));
}

export function inboxKindCounts(showHandled = false): Record<EmailKind | 'all', number> {
  const counts = Object.fromEntries([...INBOX_KINDS, 'all'].map((k) => [k, 0])) as Record<EmailKind | 'all', number>;
  for (const item of listInbox({ handled: showHandled ? undefined : false, limit: 1000 })) {
    counts.all++;
    counts[item.kind ?? 'other']++;
  }
  return counts;
}

export interface InboxDetail {
  item: InboxItem;
  job?: Job;
  replies: Message[];
  extras: InboxExtras;
}

export function inboxDetail(id: number): InboxDetail | undefined {
  const item = getInbox(id);
  if (!item) return undefined;
  const replies = listMessages({ inboxId: id, direction: 'out', limit: 20 }).filter((m) => m.status !== 'discarded');
  return { item, job: item.jobId ? getJob(item.jobId) : undefined, replies, extras: inboxExtras(item) };
}

// ───────────────────────────── Recipients ─────────────────────────────

export interface RecipientCheck { verified: boolean; reason: string }

/**
 * Whether an outbound email's recipient is an address Pursuit actually saw (never a guess).
 * Verified when: it is the sender of the email being replied to, a contact whose address was seen
 * verbatim (emailVerified), or an address that emailed Kayzee about this job.
 */
export function checkRecipient(
  m: Pick<Message, 'to'>,
  ctx: { contact?: Pick<Contact, 'email' | 'emailVerified' | 'source'>; inbox?: Pick<InboxItem, 'fromAddress'>; jobSenders?: string[] },
): RecipientCheck {
  const to = m.to?.trim().toLowerCase();
  if (!to) return { verified: false, reason: 'No recipient address yet.' };
  if (!isEmail(to)) return { verified: false, reason: `"${m.to}" isn't a valid email address.` };
  if (ctx.inbox && ctx.inbox.fromAddress.trim().toLowerCase() === to) return { verified: true, reason: 'Replying to the sender.' };
  const contactEmail = ctx.contact?.email?.trim().toLowerCase();
  if (contactEmail === to) {
    return ctx.contact?.emailVerified
      ? { verified: true, reason: `Seen verbatim (${ctx.contact.source}).` }
      : { verified: false, reason: 'Guessed address: Pursuit never sends to guessed addresses.' };
  }
  if (ctx.jobSenders?.some((s) => s.trim().toLowerCase() === to)) return { verified: true, reason: 'This address emailed you about this job.' };
  return { verified: false, reason: "Address doesn't match a verified contact." };
}

/** Addresses of verified contacts + inbound senders, for a job (or globally when no job). */
function verifiedAddressesForJob(jobId: string | undefined): string[] {
  const out = new Set<string>();
  if (jobId) {
    for (const i of listInbox({ jobId, limit: 100 })) out.add(i.fromAddress.toLowerCase());
    for (const c of listContacts({ jobId, hasEmail: true })) if (c.emailVerified && c.email) out.add(c.email.toLowerCase());
  }
  return [...out];
}

export function recipientCheckFor(m: Message): RecipientCheck {
  const contact = m.contactId ? getContact(m.contactId) : undefined;
  const inbox = m.inboxId ? getInbox(m.inboxId) : undefined;
  return checkRecipient(m, { contact, inbox, jobSenders: verifiedAddressesForJob(m.jobId) });
}

// ───────────────────────────── Outreach ─────────────────────────────

/** LinkedIn connection notes are capped at 300 characters. */
export const LINKEDIN_NOTE_MAX = 300;

export interface DraftView {
  message: Message;
  job?: Pick<Job, 'id' | 'company' | 'title' | 'status'>;
  contact?: Contact;
  recipient: RecipientCheck;
}

export interface OutreachData {
  emailDrafts: DraftView[];
  linkedinNotes: DraftView[];
  sent: DraftView[];
  contacts: (Contact & { job?: Pick<Job, 'id' | 'company' | 'title' | 'status'> })[];
}

export function outreachData(): OutreachData {
  const jobs = new JobCache();
  const contactCache = new Map<number, Contact | undefined>();
  const contactFor = (id?: number) => {
    if (!id) return undefined;
    if (!contactCache.has(id)) contactCache.set(id, getContact(id));
    return contactCache.get(id);
  };
  const view = (message: Message): DraftView => ({
    message,
    job: jobs.brief(message.jobId),
    contact: contactFor(message.contactId),
    recipient: message.channel === 'email' ? recipientCheckFor(message) : { verified: true, reason: 'Sent by you on LinkedIn.' },
  });
  const outbound = listMessages({ direction: 'out', limit: 500 }).filter((m) => m.kind !== 'digest');
  return {
    emailDrafts: outbound.filter((m) => m.channel === 'email' && (m.status === 'draft' || m.status === 'approved')).map(view),
    linkedinNotes: outbound.filter((m) => m.channel === 'linkedin' && m.status === 'draft').map(view),
    sent: outbound.filter((m) => m.status === 'sent' || m.status === 'failed').map(view),
    contacts: listContacts({ limit: 500 }).map((c) => ({ ...c, job: jobs.brief(c.jobId) })),
  };
}

// ───────────────────────────── Interviews ─────────────────────────────

/** Reads an artifact's text: inline content, else its file (only from inside data/artifacts). */
export function readArtifactText(a: Artifact | undefined): string | undefined {
  if (!a) return undefined;
  if (a.content) return a.content;
  if (!a.path) return undefined;
  const file = path.resolve(a.path);
  if (!isInside(ARTIFACTS_DIR, file)) return undefined;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export interface InterviewView {
  job: Job;
  emails: InboxItem[];
  extras: InboxExtras;
  prep?: { artifact: Artifact; text: string };
  thankYou: Message[];
}

export function mergeExtras(list: InboxExtras[]): InboxExtras {
  const times: string[] = [];
  const links: string[] = [];
  let calendarUrl: string | undefined;
  for (const e of list) {
    for (const t of e.proposedTimes) if (!times.includes(t)) times.push(t);
    for (const l of e.meetingLinks) if (!links.includes(l)) links.push(l);
    calendarUrl ??= e.calendarUrl;
  }
  return { proposedTimes: times, calendarUrl, meetingLinks: links };
}

export function interviewView(job: Job): InterviewView {
  const emails = listInbox({ jobId: job.id, kind: ['interview', 'assessment', 'question', 'offer'], limit: 20 });
  const prepArtifact = latestArtifact(job.id, 'prep');
  const prepText = readArtifactText(prepArtifact);
  return {
    job,
    emails,
    extras: mergeExtras(emails.map((e) => inboxExtras(e))),
    prep: prepArtifact && prepText ? { artifact: prepArtifact, text: prepText } : undefined,
    thankYou: listMessages({ jobId: job.id, kind: 'thank_you', limit: 10 }).filter((m) => m.status !== 'discarded'),
  };
}

export function interviewsData(): InterviewView[] {
  return listJobs({ status: 'interview', orderBy: 'updatedAt', dir: 'desc', limit: 100 }).map(interviewView);
}

/** First name from a "Name <addr>" header, letters only; undefined if it looks like an address/role. */
export function senderFirstName(fromHeader: string | undefined): string | undefined {
  if (!fromHeader) return undefined;
  const display = fromHeader.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  if (!display || display.includes('@')) return undefined;
  const first = display.split(/[\s,]+/)[0] ?? '';
  if (!/^[\p{L}][\p{L}'-]{1,30}$/u.test(first)) return undefined;
  if (/^(no|noreply|careers|recruiting|talent|hr|jobs|team|the|hiring)$/i.test(first)) return undefined;
  return first[0].toUpperCase() + first.slice(1);
}

/**
 * Plain thank-you note in Kayzee's voice. Makes no claims beyond having interviewed, so it needs no
 * fact citations; no dashes, no buzzwords; signed per profile.coverLetter.signOff + full name.
 */
export function thankYouTemplate(input: { job: Pick<Job, 'title' | 'company'>; firstName?: string; profile: Pick<Profile, 'name' | 'coverLetter'> }): { subject: string; body: string } {
  const { job, firstName, profile } = input;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const signOff = profile.coverLetter.signOff?.trim() || `Kind Regards,\n${profile.name.preferred}`;
  const body = [
    greeting,
    '',
    `Thanks for taking the time to talk with me about the ${job.title} role. I enjoyed hearing more about the team at ${job.company} and what the role involves.`,
    '',
    "It's made me even keener on the position. If there's anything else you need from me, just let me know.",
    '',
    signOff,
    profile.name.full,
  ].join('\n');
  return { subject: `Thank you: ${job.title} interview`, body };
}

/** Best reply-to address for a job: the most recent interview/question email sender. */
export function interviewerAddress(jobId: string): { address?: string; name?: string } {
  const item = listInbox({ jobId, kind: ['interview', 'question', 'assessment', 'offer'], limit: 1 })[0];
  return item ? { address: item.fromAddress, name: senderFirstName(item.from) } : {};
}

// ───────────────────────────── Analytics ─────────────────────────────

export interface FunnelStep { key: keyof FunnelStats; label: string; value: number; conversion: number | null }

const FUNNEL_ORDER: { key: keyof FunnelStats; label: string }[] = [
  { key: 'discovered', label: 'Discovered' },
  { key: 'scored', label: 'Scored' },
  { key: 'ready', label: 'Ready' },
  { key: 'applied', label: 'Applied' },
  { key: 'replied', label: 'Responded' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
];

/** Funnel steps with conversion % from the previous step (null for the first or a zero base). */
export function funnelSteps(f: FunnelStats): FunnelStep[] {
  return FUNNEL_ORDER.map(({ key, label }, i) => {
    const value = Number(f[key]) || 0;
    const prev = i > 0 ? Number(f[FUNNEL_ORDER[i - 1].key]) || 0 : 0;
    return { key, label, value, conversion: i === 0 || prev === 0 ? null : Math.round((value / prev) * 1000) / 10 };
  });
}

export interface GapKeyword { term: string; jobs: number; examples: string[] }

/**
 * Most common JD keywords NOT backed by facts across the given jobs (each job counts once per term).
 * Shows Kayzee which real skills are worth building; they are never claimed.
 */
export function aggregateGaps(jobs: Pick<Job, 'company' | 'title' | 'keywords'>[], limit = 25): GapKeyword[] {
  const map = new Map<string, { display: Map<string, number>; jobs: number; examples: string[] }>();
  for (const job of jobs) {
    const seen = new Set<string>();
    for (const raw of job.keywords?.gaps ?? []) {
      const term = raw.trim();
      const key = term.toLowerCase().replace(/\s+/g, ' ');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = map.get(key) ?? { display: new Map<string, number>(), jobs: 0, examples: [] };
      entry.jobs++;
      entry.display.set(term, (entry.display.get(term) ?? 0) + 1);
      if (entry.examples.length < 3) entry.examples.push(`${job.title} at ${job.company}`);
      map.set(key, entry);
    }
  }
  return [...map.entries()]
    .map(([key, e]) => ({
      term: [...e.display.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key,
      jobs: e.jobs,
      examples: e.examples,
    }))
    .sort((a, b) => b.jobs - a.jobs || a.term.localeCompare(b.term))
    .slice(0, limit);
}

const GAP_STATUSES: JobStatus[] = ['ready', 'approved', 'applying', 'needs_you', 'applied', 'replied', 'interview', 'offer'];

export function topGapKeywords(limit = 25): { gaps: GapKeyword[]; jobsConsidered: number } {
  const jobs = listJobs({ status: GAP_STATUSES, limit: 2000 });
  return { gaps: aggregateGaps(jobs, limit), jobsConsidered: jobs.length };
}

export const DIMENSION_LABEL: Record<ResponseRateRow['dimension'], string> = {
  source: 'By source',
  ats: 'By ATS',
  scoreBucket: 'By score',
  summaryVariant: 'By CV summary variant',
};

export function groupResponseRates(rows: ResponseRateRow[]): Record<ResponseRateRow['dimension'], ResponseRateRow[]> {
  const out: Record<ResponseRateRow['dimension'], ResponseRateRow[]> = { source: [], ats: [], scoreBucket: [], summaryVariant: [] };
  for (const r of rows) out[r.dimension]?.push(r);
  return out;
}

// ───────────────────────────── Sources ─────────────────────────────

export const BOARD_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'] as const satisfies readonly WatchCompany['ats'][];
export type BoardAts = (typeof BOARD_ATS)[number];

export const SOURCE_IDS: SourceId[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'linkedin_guest', 'adzuna', 'gmail_alert', 'board_search'];

export const SOURCE_LABEL: Record<SourceId, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable',
  linkedin_guest: 'LinkedIn (public pages)', adzuna: 'Adzuna', gmail_alert: 'Gmail job alerts', manual: 'Manual', board_search: 'Workable + SmartRecruiters search',
};

export function isBoardAts(v: unknown): v is BoardAts {
  return typeof v === 'string' && (BOARD_ATS as readonly string[]).includes(v);
}

/** Board tokens are short slugs; anything else is rejected before it reaches a URL. */
export function isValidBoardToken(token: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(token);
}

/** Public, logged-out board API listing endpoint (the same ones the discovery adapters use). */
export function boardApiUrl(ats: BoardAts, token: string): string {
  const t = encodeURIComponent(token);
  switch (ats) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`;
    case 'lever': return `https://api.lever.co/v0/postings/${t}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${t}`;
    case 'smartrecruiters': return `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${t}`;
  }
}

const IRELAND_RE = /\b(ireland|dublin|cork|galway|limerick|waterford|kilkenny|athlone|sligo|dundalk|drogheda|louth|meath|kildare|wicklow|belfast|derry|londonderry|newry|armagh|lisburn|northern ireland)\b/i;

function locationStrings(ats: BoardAts, job: unknown): string[] {
  const j = asRecord(job) ?? {};
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (ats) {
    case 'greenhouse': return [s(asRecord(j.location)?.name)];
    case 'lever': {
      const cat = asRecord(j.categories) ?? {};
      return [s(cat.location), ...stringArray(cat.allLocations), s(j.country)];
    }
    case 'ashby': {
      const addr = asRecord(asRecord(j.address)?.postalAddress) ?? {};
      const secondary = Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((x) => s(asRecord(x)?.location)) : [];
      return [s(j.location), s(addr.addressCountry), s(addr.addressLocality), ...secondary];
    }
    case 'smartrecruiters': {
      const loc = asRecord(j.location) ?? {};
      return [s(loc.city), s(loc.region), s(loc.country) === 'ie' ? 'Ireland' : s(loc.country), s(loc.fullLocation)];
    }
    case 'workable': return [s(j.city), s(j.state), s(j.country), s(j.location)];
  }
}

/** Job count (and how many mention an Irish/NI location) from a board API response body. */
export function countBoardJobs(ats: BoardAts, body: unknown): { total: number; ireland: number } | null {
  const rec = asRecord(body);
  let jobs: unknown[] | undefined;
  let total: number | undefined;
  if (ats === 'lever') jobs = Array.isArray(body) ? body : undefined;
  else if (ats === 'smartrecruiters') {
    jobs = Array.isArray(rec?.content) ? rec.content : undefined;
    total = typeof rec?.totalFound === 'number' ? rec.totalFound : undefined;
  } else jobs = Array.isArray(rec?.jobs) ? rec.jobs : undefined;
  if (!jobs) return null;
  const ireland = jobs.filter((j) => locationStrings(ats, j).some((l) => IRELAND_RE.test(l))).length;
  return { total: total ?? jobs.length, ireland };
}

export interface BoardTestResult { ok: boolean; url: string; status?: number; total?: number; ireland?: number; error?: string }

/** One polite GET to a public board API. Never retries; 15 s timeout. */
export async function testBoard(ats: BoardAts, token: string, fetchImpl: typeof fetch = fetch): Promise<BoardTestResult> {
  if (!isValidBoardToken(token)) return { ok: false, url: '', error: 'Token can only contain letters, numbers, dot, dash and underscore.' };
  const url = boardApiUrl(ats, token);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'Pursuit/1.0 (personal job search)', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (!res.ok) {
      const hint = res.status === 404 ? ' (no board with that token)' : res.status === 429 ? ' (rate limited; try later)' : '';
      return { ok: false, url, status: res.status, error: `HTTP ${res.status}${hint}` };
    }
    const body: unknown = await res.json().catch(() => undefined);
    const counted = countBoardJobs(ats, body);
    if (!counted) return { ok: false, url, status: res.status, error: "Unexpected response shape: is this the right ATS?" };
    return { ok: true, url, status: res.status, ...counted };
  } catch (err) {
    const e = err as Error;
    return { ok: false, url, error: e.name === 'TimeoutError' ? 'Timed out after 15 s' : e.message };
  }
}

export interface SourceRunInfo { at?: string; ok?: boolean; found?: number; created?: number; error?: string }

/** Tolerant reader for kv 'source.<id>.lastRun' (the discovery module owns the exact shape). */
export function parseSourceRun(value: unknown): SourceRunInfo | null {
  if (typeof value === 'string') return { at: value };
  const r = asRecord(value);
  if (!r) return null;
  const str = (...keys: string[]) => keys.map((k) => r[k]).find((v): v is string => typeof v === 'string' && v !== '');
  const num = (...keys: string[]) => keys.map((k) => r[k]).find((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const error = str('error', 'lastError');
  return {
    at: str('at', 'ts', 'finishedAt', 'ranAt', 'time', 'startedAt'),
    ok: typeof r.ok === 'boolean' ? r.ok : error ? false : undefined,
    found: num('found', 'fetched', 'count', 'jobs'),
    created: num('created', 'new', 'added'),
    error,
  };
}

export function sourceRuns(): Record<string, SourceRunInfo | null> {
  return Object.fromEntries(SOURCE_IDS.map((id) => [id, parseSourceRun(kvGet(`source.${id}.lastRun`))]));
}

// ───────────────────────────── Settings ─────────────────────────────

/** ATSs with a dedicated, tested filler (SPEC §5.5). Autopilot can only use these. */
export const AUTOPILOT_ATS: AtsKind[] = ['greenhouse', 'lever', 'ashby'];
export const ATS_LABEL: Partial<Record<AtsKind, string>> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' };

export function autopilotActive(s: Pick<Settings, 'mode' | 'autopilot'>): boolean {
  return s.mode === 'autopilot' && s.autopilot.enabled;
}

/** The SPEC §7 limits, phrased for Kayzee, with his current numbers filled in. */
export function autopilotLimits(s: Settings): string[] {
  const ats = s.autopilot.ats.length ? s.autopilot.ats.map((a) => ATS_LABEL[a] ?? a).join(', ') : 'none selected (so nothing qualifies)';
  return [
    `Score ${s.autopilot.minScore} or higher`,
    `Only on ${ats}`,
    'ATS parse check 80 or higher',
    'Truth guard clean: every claim backed by your fact bank',
    'Style check clean: no AI-sounding phrasing',
    'Every screening question answered from your confirmed answer bank (no AI-written answers)',
    'No flags on the job (visa wording, NI right-to-work, years asked, etc.)',
    `Not during quiet hours (${s.quietHours.start} to ${s.quietHours.end})`,
    `At most ${s.autopilot.dailyCap} autopilot applications a day (inside your overall cap of ${s.dailyApplyCap})`,
    'Each submission is logged and notified. Emails, follow-ups and replies are never auto-sent.',
  ];
}

export function groupFacts(facts: Fact[]): { kind: Fact['kind']; facts: Fact[] }[] {
  const order: Fact['kind'][] = ['summary', 'role', 'achievement', 'project', 'education', 'award', 'skill', 'tool', 'other'];
  const groups = new Map<Fact['kind'], Fact[]>();
  for (const f of facts) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
  return order.filter((k) => groups.has(k)).map((kind) => ({ kind, facts: groups.get(kind)! }));
}

/** Clears the "unconfirmed" flag on an answer entry (autopilot may then use it). */
export function confirmAnswerEntry(bank: AnswerBank, id: string): AnswerBank {
  if (!bank.entries.some((e) => e.id === id)) throw new Error(`No answer entry "${id}"`);
  return { entries: bank.entries.map((e) => (e.id === id ? { ...e, confirm: false } : e)) };
}

/** Replaces the entry with the same id, or appends a new one. */
export function upsertAnswerEntry(bank: AnswerBank, entry: AnswerEntry): AnswerBank {
  const exists = bank.entries.some((e) => e.id === entry.id);
  return { entries: exists ? bank.entries.map((e) => (e.id === entry.id ? entry : e)) : [...bank.entries, entry] };
}

export function removeAnswerEntry(bank: AnswerBank, id: string): AnswerBank {
  return { entries: bank.entries.filter((e) => e.id !== id) };
}

/** URL/id-safe slug for new answer entries. */
export function slugify(text: string, max = 48): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'entry';
}

/** Jobs inserted by scripts/seed.ts (same predicate it uses to clear them). */
export function demoJobCount(): number {
  try {
    const row = db()
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE source = 'manual' AND company LIKE 'Demo %' AND json_extract(ats_meta, '$.demo') = 1")
      .get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

export const SEED_SCRIPT = path.join(ROOT, 'scripts', 'seed.ts');

export function seedScriptAvailable(): boolean {
  return fs.existsSync(SEED_SCRIPT);
}

/** Runs scripts/seed.ts in a child process (it owns the demo-data logic). */
export function runSeedScript(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (!seedScriptAvailable()) {
      resolve({ ok: false, output: 'scripts/seed.ts not found' });
      return;
    }
    execFile(
      process.execPath,
      ['--import', 'tsx', SEED_SCRIPT, ...args],
      { cwd: ROOT, timeout: 120_000, env: { ...process.env, PURSUIT_LOG_SILENT: '1' }, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim().split('\n').slice(-6).join('\n');
        resolve({ ok: !err, output: output || (err ? err.message : 'done') });
      },
    );
  });
}

// ───────────────────────────── Shared ─────────────────────────────

/** Memoised job lookups for list views. */
class JobCache {
  private cache = new Map<string, Job | undefined>();

  get(id: string | undefined): Job | undefined {
    if (!id) return undefined;
    if (!this.cache.has(id)) this.cache.set(id, getJob(id));
    return this.cache.get(id);
  }

  brief(id: string | undefined): Pick<Job, 'id' | 'company' | 'title' | 'status'> | undefined {
    const j = this.get(id);
    return j ? { id: j.id, company: j.company, title: j.title, status: j.status } : undefined;
  }
}
