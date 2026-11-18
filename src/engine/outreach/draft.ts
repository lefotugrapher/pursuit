// Drafts outreach emails, LinkedIn notes, follow-ups and replies. Every draft is stored as a
// message with status 'draft' and needs Kayzee's approval before anything is sent (SPEC §0.2).
// Claims come only from the fact bank: LLM drafts are accepted only when the truth guard and slop
// lint are clean and the length limits hold; otherwise a template built from fact text is used.

import { z } from 'zod';
import { loadProfile } from '@/lib/config';
import { addMessage, listApplications, listContacts, listMessages } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { log } from '@/lib/log';
import type { Application, Contact, EmailKind, Fact, FactBank, InboxItem, Job, JobStatus, Message, NewContact, NewMessage, Profile } from '@/lib/types';
import { describeSlop, fixDashes, lintSlop } from '@/engine/slop';
import { guardText } from '@/engine/truthguard';
import { clip, displayName, findPlaceholder, formatDayMonth, isNoReplyAddress, normalizeEmail, personFirstName, replySubject, signature, wordCount } from './text';

export const LIMITS = { outreachWords: 150, followUpWords: 90, linkedinChars: 300, replyWords: 160 } as const;

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

const APPLIED_LIKE: JobStatus[] = ['applied', 'replied', 'interview', 'offer'];

// Sentence-initial words the truth guard can mistake for proper names. None of them can carry a claim.
const COMMON_CAPITALISED = ["I", "I'm", "I've", "I'd", "I'll", 'Hi', 'Hello', 'Dear', 'Thanks', 'Thank', 'Please', 'Would', 'Could', 'Can',
  'Is', 'Are', 'If', 'It', "It's", 'This', 'That', 'The', 'My', 'One', 'As', 'At', 'For', 'In', 'On', 'Since', 'Also', 'Happy', 'Kind', 'Regards',
  'Best', 'CV', 'Re', 'LinkedIn', 'Application', 'Following', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// ───────────────────────────── Quality checks ─────────────────────────────

export interface CheckedText { body: string; guardProblems: string[]; slopHits: string[] }

function allowTerms(job: Job | undefined, profile: Profile, extra: (string | undefined)[] = []): string[] {
  const names = [profile.name.first, profile.name.last, profile.name.preferred, profile.name.full];
  return [...new Set([job?.company, job?.title, ...names, ...extra, ...COMMON_CAPITALISED].filter((s): s is string => Boolean(s?.trim())))];
}

/** fixDashes → truth guard (vs the whole bank) → slop lint. The signature is identity, not a claim, so it isn't guarded. */
export function checkDraft(body: string, facts: FactBank, allow: string[], sig = ''): CheckedText {
  const fixed = fixDashes(body).trim();
  let guardProblems: string[] = [];
  let slopHits: string[] = [];
  try {
    guardProblems = guardText(fixed, facts, { allowTerms: allow }).problems;
  } catch (err) {
    guardProblems = [`truth guard failed to run: ${(err as Error).message}`];
  }
  try {
    slopHits = describeSlop(lintSlop(fixed, { facts, allow }).hits);
  } catch (err) {
    slopHits = [`slop lint failed to run: ${(err as Error).message}`];
  }
  return { body: sig ? `${fixed}\n\n${sig}` : fixed, guardProblems, slopHits };
}

// ───────────────────────────── Fact selection ─────────────────────────────

const STOP = new Set(['and', 'the', 'for', 'with', 'our', 'you', 'your', 'will', 'are', 'this', 'that', 'from', 'have', 'role', 'team', 'work']);

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)));
}

/** Facts most relevant to the job: keyword-coverage citations first, then tag overlap with title/JD. */
export function pickFacts(job: Job, facts: FactBank, n = 1): Fact[] {
  const titleTokens = tokens(job.title);
  const jdTokens = tokens(`${job.title} ${job.department ?? ''} ${job.description.slice(0, 6000)}`);
  const cited = new Map<string, number>();
  for (const m of job.keywords?.matched ?? []) for (const id of m.factIds) cited.set(id, (cited.get(id) ?? 0) + 1);

  const scored = facts.facts
    .filter((f) => ['achievement', 'project', 'role'].includes(f.kind) && f.text.trim())
    .map((f, index) => {
      let score = (cited.get(f.id) ?? 0) * 3 + (f.kind === 'achievement' ? 1 : 0);
      for (const tag of f.tags) {
        for (const part of tag.toLowerCase().split(/[^a-z0-9]+/)) {
          if (part.length < 2) continue;
          if (titleTokens.has(part)) score += 2;
          else if (jdTokens.has(part)) score += 1;
        }
      }
      return { f, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, n).map((s) => s.f);
}

const PAST_VERB = /^(?:[A-Z][a-z]+ed|Wrote|Shot|Ran|Led|Built|Made|Grew|Won|Took|Gave|Drove|Co-founded|Began|Taught|Sold)\b/;

/**
 * Turns a fact bank sentence into first person without changing what it says:
 * "Wrote press releases…" → "I wrote press releases…", "At X, organised…" → "At X, I organised…".
 */
export function factSentence(fact: Fact): string {
  const text = fact.text.trim().replace(/\s+/g, ' ');
  const withPeriod = /[.!?]$/.test(text) ? text : `${text}.`;
  const lead = /^((?:At|For|As|In|With) [^,]{2,80}, )([a-z][a-z-]+)\b/.exec(withPeriod);
  if (lead && /(?:ed|wrote|shot|ran|led|built|made|grew|won|took|gave)$/.test(lead[2])) {
    return `${lead[1]}I ${withPeriod.slice(lead[1].length)}`;
  }
  if (PAST_VERB.test(withPeriod)) return `I ${withPeriod[0].toLowerCase()}${withPeriod.slice(1)}`;
  return `For example: ${withPeriod}`;
}

// ───────────────────────────── LLM drafting ─────────────────────────────

const LlmDraftSchema = z.object({ body: z.string().min(10).max(4000), factIds: z.array(z.string()).max(3) });

function voiceRules(profile: Profile): string {
  return (profile.coverLetter.voiceNotes ?? []).map((n) => `- ${n}`).join('\n');
}

function factList(facts: Fact[]): string {
  return facts.map((f) => `${f.id}: ${f.text}`).join('\n');
}

const TRAILING_SIGNOFF = /\n\s*(?:kind regards|best regards|warm regards|regards|best|thanks|many thanks|cheers|sincerely)[,!.]?\s*(?:\n[\s\S]*)?$/i;
const LEADING_GREETING = /^\s*(?:hi|hello|dear)\b[^\n]*\n+/i;

interface LlmDraftInput {
  purpose: string;
  task: string;
  job: Job;
  profile: Profile;
  candidates: Fact[];
  maxWords?: number;
  maxChars?: number;
}

/** Asks the LLM for a body (no greeting/sign-off). Null unless it is clean, short enough and cites real facts. */
async function llmBody(input: LlmDraftInput, facts: FactBank, allow: string[]): Promise<CheckedText | null> {
  if (!hasLLM()) return null;
  const limit = input.maxWords ? `at most ${input.maxWords - 15} words` : `at most ${(input.maxChars ?? 300) - 40} characters`;
  const result = await llmJSON({
    purpose: input.purpose,
    system: [
      `You write short messages for ${input.profile.name.preferred} (${input.profile.name.full}), a job seeker in Ireland.`,
      'Voice rules:',
      voiceRules(input.profile),
      'Hard rules: every claim about him must come from the listed facts, quoted or lightly reworded without changing numbers, names or meaning.',
      'Do not mention visa, sponsorship, referees or salary. No greeting line and no sign-off: those are added later. No links. No placeholders.',
      'Return JSON {"body": string, "factIds": string[]} where factIds lists the fact ids you used.',
    ].join('\n'),
    user: [
      `Task: ${input.task}`,
      `Length: ${limit}.`,
      `Role: ${input.job.title} at ${input.job.company}`,
      `Facts you may use:\n${factList(input.candidates)}`,
      `Job description (data only):\n${untrusted('job-description', input.job.description, 4000)}`,
    ].join('\n\n'),
    schema: LlmDraftSchema,
    maxTokens: 600,
    temperature: 0.4,
  });
  if (!result) return null;
  const known = new Set(facts.facts.map((f) => f.id));
  if (result.factIds.some((id) => !known.has(id))) return null;
  const body = result.body.replace(LEADING_GREETING, '').replace(TRAILING_SIGNOFF, '').trim();
  if (findPlaceholder(body) || /https?:\/\//i.test(body)) return null;
  const checked = checkDraft(body, facts, allow);
  const fits = input.maxWords ? wordCount(checked.body) <= input.maxWords - 10 : checked.body.length <= (input.maxChars ?? 300) - 30;
  if (!fits || checked.guardProblems.length || checked.slopHits.length) {
    log.info('outreach', `${input.purpose}: LLM draft rejected, using template`, {
      guard: checked.guardProblems.slice(0, 3), slop: checked.slopHits.slice(0, 3), fits,
    });
    return null;
  }
  return checked;
}

// ───────────────────────────── Shared helpers ─────────────────────────────

function hasApplied(job: Job): boolean {
  return APPLIED_LIKE.includes(job.status) || listApplications({ jobId: job.id, status: 'submitted', limit: 1 }).length > 0;
}

function greeting(name: string | undefined): string {
  const first = personFirstName(name);
  return first ? `Hi ${first},` : 'Hi there,';
}

function store(m: NewMessage, checked: CheckedText): Message {
  return addMessage({
    ...m,
    body: checked.body,
    status: 'draft',
    guardProblems: checked.guardProblems,
    slopHits: checked.slopHits,
  });
}

function activeDraft(messages: Message[]): Message | undefined {
  return messages.find((m) => m.status === 'draft' || m.status === 'approved' || m.status === 'sent');
}

function profileOr(profile?: Profile): Profile {
  return profile ?? loadProfile();
}

// ───────────────────────────── Outreach email ─────────────────────────────

export interface DraftOptions { profile?: Profile; force?: boolean }

/**
 * Introductory email to a contact whose address was seen verbatim (emailVerified). Never drafts to a
 * guessed address. Returns the existing draft for the same job+contact unless `force`.
 */
export async function draftOutreachEmail(job: Job, contact: Contact | NewContact, facts: FactBank, profile?: Profile, opts: DraftOptions = {}): Promise<Message> {
  const to = normalizeEmail(contact.email);
  if (!to || !contact.emailVerified) throw new DraftError('Outreach needs a contact email seen verbatim on the JD or company site (none verified)');
  if (isNoReplyAddress(to)) throw new DraftError(`${to} is a no-reply address`);
  const p = profileOr(profile);
  const contactId = 'id' in contact ? contact.id : undefined;

  if (!opts.force) {
    const existing = activeDraft(listMessages({ jobId: job.id, kind: 'outreach' }).filter((m) => (contactId ? m.contactId === contactId : m.to === to)));
    if (existing) return existing;
  }

  const allow = allowTerms(job, p, [contact.name, contact.role]);
  const applied = hasApplied(job);
  const [fact] = pickFacts(job, facts, 1);
  const sig = signature(p);

  const llm = await llmBody(
    {
      purpose: 'outreach.email',
      task: [
        `Write an email to ${contact.name ?? 'the hiring team'}${contact.role ? ` (${contact.role})` : ''} at ${job.company}.`,
        `Say he has ${applied ? 'applied' : 'is applying'} for the ${job.title} role, give exactly one specific fact that fits the role,`,
        'mention his CV is attached, and politely ask for a short chat or to be pointed to the right person. Two or three short paragraphs.',
      ].join(' '),
      job,
      profile: p,
      candidates: pickFacts(job, facts, 5),
      maxWords: LIMITS.outreachWords,
    },
    facts,
    allow,
  ).catch(() => null);

  const opener = applied
    ? `I've applied for the ${job.title} role at ${job.company} and wanted to introduce myself directly.`
    : `I'm applying for the ${job.title} role at ${job.company} and wanted to introduce myself directly.`;
  const template = [
    opener,
    fact ? factSentence(fact) : '',
    "I've attached my CV. Would you be open to a short call, or could you point me to the right person on the hiring team?",
    'Thanks for your time.',
  ].filter(Boolean).join('\n\n');

  const bodyText = llm?.body ?? template;
  const checked = checkDraft(`${greeting(contact.name)}\n\n${bodyText}`, facts, allow, sig);
  if (wordCount(checked.body.slice(0, checked.body.length - sig.length)) > LIMITS.outreachWords) {
    checked.guardProblems.push(`longer than ${LIMITS.outreachWords} words`);
  }
  return store(
    { jobId: job.id, contactId, direction: 'out', channel: 'email', kind: 'outreach', to, subject: `Application: ${job.title}`, body: '', status: 'draft', attachCv: true },
    checked,
  );
}

// ───────────────────────────── LinkedIn note ─────────────────────────────

function fitNote(parts: string[], max: number): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Connection note (≤300 chars, no links) that Kayzee copies and sends himself. LinkedIn is never automated.
 */
export async function draftLinkedInNote(job: Job, contact: Contact | NewContact, facts: FactBank, profile?: Profile, opts: DraftOptions = {}): Promise<Message> {
  const p = profileOr(profile);
  const contactId = 'id' in contact ? contact.id : undefined;
  if (!opts.force) {
    const existing = activeDraft(listMessages({ jobId: job.id, kind: 'linkedin_note' }).filter((m) => m.contactId === contactId));
    if (existing) return existing;
  }
  const allow = allowTerms(job, p, [contact.name, contact.role]);
  const max = LIMITS.linkedinChars;
  const hello = personFirstName(contact.name) ? `Hi ${personFirstName(contact.name)},` : 'Hi,';
  const title = clip(job.title, 60);
  const company = clip(job.company, 50);
  const opener = hasApplied(job) ? `I've applied for the ${title} role at ${company}.` : `I'm applying for the ${title} role at ${company}.`;
  const closer = "I'd be glad to connect.";
  const sign = p.name.preferred || p.name.first;

  const llm = await llmBody(
    {
      purpose: 'outreach.linkedin',
      task: `Write the middle of a LinkedIn connection note to ${contact.name ?? 'a recruiter'} at ${job.company}: one short sentence with one fact that fits the ${job.title} role. Plain, friendly, no links, no hashtags.`,
      job,
      profile: p,
      candidates: pickFacts(job, facts, 4),
      maxChars: max - (hello.length + opener.length + closer.length + sign.length + 4),
    },
    facts,
    allow,
  ).catch(() => null);

  const candidates = [llm?.body, ...pickFacts(job, facts, 4).map(factSentence)].filter((s): s is string => Boolean(s));
  let note = fitNote([hello, opener, closer, sign], max);
  for (const middle of candidates) {
    const attempt = [hello, opener, middle, closer, sign].join(' ').replace(/\s+/g, ' ').trim();
    if (attempt.length <= max) {
      note = attempt;
      break;
    }
  }
  const checked = checkDraft(note, facts, allow);
  if (checked.body.length > max) checked.guardProblems.push(`longer than ${max} characters`);
  return store(
    { jobId: job.id, contactId, direction: 'out', channel: 'linkedin', kind: 'linkedin_note', to: contact.linkedinUrl, body: '', status: 'draft' },
    checked,
  );
}

// ───────────────────────────── Follow-up ─────────────────────────────

export interface FollowUpOptions extends DraftOptions {
  contact?: Contact;
  /** ISO date of the application when there's no application row (marked applied by hand). */
  appliedAt?: string;
  /** 1 for the first follow-up, 2 for the second. */
  nth?: number;
}

/** Verified-email contact for a job (job-scoped first, then same company). */
export function verifiedContactFor(job: Job): Contact | undefined {
  const ok = (c: Contact) => c.emailVerified && Boolean(normalizeEmail(c.email)) && !isNoReplyAddress(c.email);
  return listContacts({ jobId: job.id, hasEmail: true }).find(ok) ?? listContacts({ company: job.company, hasEmail: true }).find(ok);
}

/** Short follow-up (≤90 words) referencing the application date and role. */
export async function draftFollowUp(job: Job, application: Application | undefined, facts: FactBank, opts: FollowUpOptions = {}): Promise<Message> {
  const p = profileOr(opts.profile);
  const contact = opts.contact ?? verifiedContactFor(job);
  const to = contact?.emailVerified ? normalizeEmail(contact.email) : undefined;
  const appliedIso = application?.submittedAt ?? application?.startedAt ?? opts.appliedAt;
  const when = formatDayMonth(appliedIso);
  const nth = opts.nth ?? 1;
  const allow = allowTerms(job, p, [contact?.name, contact?.role, when]);
  const sig = signature(p);

  // Thread onto the earlier email to this contact when there is one.
  const previous = listMessages({ jobId: job.id, kind: ['outreach', 'follow_up'], status: 'sent' }).find((m) => m.messageId && (!to || m.to === to));

  const opener = nth > 1
    ? `I'm following up once more on my application for the ${job.title} role${when ? `, sent on ${when}` : ''}.`
    : `I applied for the ${job.title} role at ${job.company}${when ? ` on ${when}` : ''} and wanted to follow up.`;
  const middle = "I'm still very interested and happy to share anything else that would help.";
  const [fact] = pickFacts(job, facts, 1);

  const llm = await llmBody(
    {
      purpose: 'outreach.followup',
      task: [
        `Write a polite follow-up email body about his application for the ${job.title} role at ${job.company}${when ? `, submitted on ${when}` : ''}.`,
        nth > 1 ? 'This is the second and final follow-up: keep it to two sentences.' : 'Mention the role and the date, restate interest, optionally one fact.',
      ].join(' '),
      job,
      profile: p,
      candidates: pickFacts(job, facts, 3),
      maxWords: LIMITS.followUpWords,
    },
    facts,
    allow,
  ).catch(() => null);

  let body = llm?.body;
  if (!body || (when && !body.includes(when))) {
    const withFact = [opener, middle, fact ? factSentence(fact) : '', 'Thanks for your time.'].filter(Boolean).join('\n\n');
    body = wordCount(withFact) <= LIMITS.followUpWords - 8 ? withFact : [opener, middle, 'Thanks for your time.'].join('\n\n');
  }
  const checked = checkDraft(`${greeting(contact?.name)}\n\n${body}`, facts, allow, sig);
  if (!to) checked.guardProblems.push('no verified contact email: add one before approving');
  if (wordCount(checked.body.slice(0, checked.body.length - sig.length)) > LIMITS.followUpWords) {
    checked.guardProblems.push(`longer than ${LIMITS.followUpWords} words`);
  }
  return store(
    {
      jobId: job.id,
      contactId: contact?.id,
      direction: 'out',
      channel: 'email',
      kind: 'follow_up',
      to,
      subject: previous?.subject ? replySubject(previous.subject) : `Following up: ${job.title} application`,
      inReplyTo: previous?.messageId,
      body: '',
      status: 'draft',
    },
    checked,
  );
}

// ───────────────────────────── Reply to inbound ─────────────────────────────

export interface ReplyOptions extends DraftOptions { kind?: EmailKind }

function replyBody(kind: EmailKind | undefined, job: Job | undefined): string {
  const about = job ? ` about the ${job.title} role` : '';
  switch (kind) {
    case 'interview':
      return [
        `Thanks for getting in touch${about}. I'm very interested and would be glad to interview.`,
        "I'm available [your availability]. Please let me know which time suits you best.",
        'Thanks again.',
      ].join('\n\n');
    case 'assessment':
      return [
        `Thanks for sending this through${about}.`,
        "I'll complete the assessment by [your deadline] and will let you know if I have any questions.",
      ].join('\n\n');
    case 'question':
      return [`Thanks for your email${about}.`, '[your answer]', 'Please let me know if you need anything else.'].join('\n\n');
    case 'offer':
      return [`Thank you so much for the offer${about}.`, '[your reply]'].join('\n\n');
    default:
      return [`Thanks for your email${about}.`, '[your reply]'].join('\n\n');
  }
}

/**
 * Reply to an inbound email, addressed to its sender only. Interview replies offer
 * "[your availability]" and never invent times; every placeholder blocks sending until filled.
 */
export async function draftReply(inbox: InboxItem, job: Job | undefined, facts: FactBank, opts: ReplyOptions = {}): Promise<Message> {
  if (!opts.force) {
    const existing = activeDraft(listMessages({ inboxId: inbox.id, kind: 'reply' }));
    if (existing) return existing;
  }
  const p = profileOr(opts.profile);
  const senderName = displayName(inbox.from);
  const sender = normalizeEmail(inbox.fromAddress);
  const noReply = !sender || isNoReplyAddress(sender);
  const allow = allowTerms(job, p, [senderName]);
  const kind = opts.kind ?? inbox.kind;

  const checked = checkDraft(`${greeting(senderName)}\n\n${replyBody(kind, job)}`, facts, allow, signature(p));
  if (noReply) checked.guardProblems.push('sender is a no-reply address: reply through the link in the email or find a real contact');
  return store(
    {
      jobId: job?.id ?? inbox.jobId,
      inboxId: inbox.id,
      direction: 'out',
      channel: 'email',
      kind: 'reply',
      to: noReply ? undefined : sender,
      subject: replySubject(inbox.subject),
      inReplyTo: inbox.messageId,
      body: '',
      status: 'draft',
      attachCv: false,
    },
    checked,
  );
}
