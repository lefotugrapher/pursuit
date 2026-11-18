// Engine dependencies for the pipeline, loaded lazily.
//
// Every engine module is imported on first use (dynamic import with a static specifier), so:
// - a module that fails to load (missing build, bad native dep) only breaks the task that needs it;
// - the Next server can import the task registry without pulling Playwright/IMAP into every route;
// - tests replace any function by passing a partial `PipelineDeps`.

import { loadAnswers, loadFacts, loadProfile } from '@/lib/config';
import { listContacts } from '@/lib/db';
import type {
  AnsweredQuestion, AnswerBank, ApplyOutcome, Contact, FactBank, FilterResult, GuardResult, Job, Keyword,
  KeywordCoverage, Message, NewContact, NewMessage, Profile, ScoreDetail, ScreeningQuestion, TailoredCv,
} from '@/lib/types';

/** writeCoverLetter's result (SPEC §5.4). */
export interface CoverLetterResult {
  text: string;
  guard: GuardResult;
  slop: SlopResult;
}

export interface NotifyOptions { url?: string; priority?: 'min' | 'low' | 'default' | 'high' | 'urgent' }

/** Result of re-checking a stored cover letter (truth guard + slop lint + length). */
export interface LetterCheckResult { guard: GuardResult; slop: SlopResult; problems: string[] }

/** A drafting function may store the message itself (returns a Message with id) or return a NewMessage. */
export type DraftResult = Message | NewMessage | null | undefined;

type MaybePromise<T> = T | Promise<T>;

export interface PipelineDeps {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  loadProfile(): Profile;
  loadFacts(): FactBank;
  loadAnswers(): AnswerBank;
  hardFilters(job: Job, profile: Profile): MaybePromise<FilterResult>;
  extractKeywords(jd: string): MaybePromise<Keyword[]>;
  coverage(keywords: Keyword[], facts: FactBank): MaybePromise<KeywordCoverage>;
  scoreJob(job: Job, profile: Profile, facts: FactBank): Promise<ScoreDetail>;
  tailorCv(job: Job, facts: FactBank, profile: Profile, kw: KeywordCoverage): Promise<TailoredCv>;
  writeCoverLetter(job: Job, facts: FactBank, profile: Profile, kw?: KeywordCoverage): Promise<CoverLetterResult>;
  answerQuestions(questions: ScreeningQuestion[], answers: AnswerBank, profile: Profile, facts: FactBank, job: Job): Promise<AnsweredQuestion[]>;
  applyToJob(jobId: string, opts: { mode: 'submit' | 'fill-only'; headless: boolean }): Promise<ApplyOutcome>;
  findContacts(job: Job): Promise<(Contact | NewContact)[]>;
  draftOutreachEmail(job: Job, contact: Contact, facts: FactBank, profile: Profile): Promise<DraftResult>;
  draftLinkedInNote(job: Job, contact: Contact, facts: FactBank): Promise<DraftResult>;
  notify(title: string, body: string, opts?: NotifyOptions): MaybePromise<unknown>;
  /** Autopilot re-checks the latest letter at decision time (Kayzee may have edited it since tailoring). */
  checkCoverLetter(job: Job, text: string, facts: FactBank, profile: Profile): MaybePromise<LetterCheckResult>;
  /** Truth guard for free text (dashboard draft edits). */
  guardText(text: string, facts: FactBank): MaybePromise<GuardResult>;
  /** Slop lint for free text (dashboard draft edits). */
  lintSlop(text: string): MaybePromise<SlopResult>;
  /** Hands-free: ask Kayzee (Telegram) the questions a job is waiting on. true = queued, the job should wait. */
  askKayzee(job: Job, questions: ScreeningQuestion[]): Promise<boolean>;
  /** Tells Kayzee (Telegram) how an application went. Never throws. */
  reportOutcome(jobId: string, outcome: ApplyOutcome): MaybePromise<unknown>;
}

export interface SlopResult { ok: boolean; hits: { rule: string; match: string }[] }

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError';

export const defaultDeps: PipelineDeps = {
  now: () => new Date(),
  sleep: abortableSleep,
  random: Math.random,
  loadProfile,
  loadFacts,
  loadAnswers,
  hardFilters: async (job, profile) => (await import('@/engine/score')).hardFilters(job, profile),
  extractKeywords: async (jd) => (await import('@/engine/keywords')).extractKeywords(jd),
  coverage: async (keywords, facts) => (await import('@/engine/keywords')).coverage(keywords, facts),
  scoreJob: async (job, profile, facts) => (await import('@/engine/score')).scoreJob(job, profile, facts),
  tailorCv: async (job, facts, profile, kw) => (await import('@/engine/tailor/cv')).tailorCv(job, facts, profile, kw),
  writeCoverLetter: async (job, facts, profile, kw) =>
    (await import('@/engine/tailor/letter')).writeCoverLetter(job, facts, profile, kw ? { coverage: kw } : {}),
  answerQuestions: async (questions, answers, profile, facts, job) =>
    (await import('@/engine/tailor/answers')).answerQuestions(questions, answers, profile, facts, job),
  applyToJob: async (jobId, opts) => (await import('@/engine/apply/runner')).applyToJob(jobId, opts),
  findContacts: async (job) => (await import('@/engine/outreach/contacts')).findContacts(job),
  draftOutreachEmail: async (job, contact, facts, profile) =>
    (await import('@/engine/outreach/draft')).draftOutreachEmail(job, contact, facts, profile),
  draftLinkedInNote: async (job, contact, facts) => (await import('@/engine/outreach/draft')).draftLinkedInNote(job, contact, facts),
  notify: async (title, body, opts) => (await import('@/engine/notify')).notify(title, body, opts),
  checkCoverLetter: async (job, text, facts, profile) => {
    const letter = await import('@/engine/tailor/letter');
    const { guardText } = await import('@/engine/truthguard');
    // Same context the letter module uses when saving an edit: company, title, contact and his own
    // names are allowed; only the claims are judged.
    const contact = listContacts({ jobId: job.id }).find((c) => c.name?.trim() && c.confidence >= 0.6)?.name?.trim();
    const names = [...(contact ? [contact] : []), profile.name.full, profile.name.preferred, profile.name.first, profile.name.last];
    const check = letter.checkLetter(text, letter.stripFrame(text), facts, letter.guardContextFor(job, names), guardText);
    return { guard: check.guard, slop: check.slop, problems: check.problems };
  },
  guardText: async (text, facts) => (await import('@/engine/truthguard')).guardText(text, facts),
  lintSlop: async (text) => (await import('@/engine/slop')).lintSlop(text),
  // Queues each question (deduped across jobs; reuses his earlier answer to the identical question). The Telegram
  // pass sends open questions and re-queues the job once every one is answered.
  askKayzee: async (job, questions) => {
    const { queueQuestion } = await import('@/engine/questions');
    const results = questions.map((question) => queueQuestion({ jobId: job.id, question }));
    return results.some((r) => r.ok);
  },
  reportOutcome: async (jobId, outcome) => (await import('@/engine/telegram/bot')).notifyApplyOutcome(jobId, outcome),
};

export function resolveDeps(overrides?: Partial<PipelineDeps>): PipelineDeps {
  return overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** Task-level engine calls that don't go through the pipeline (one function each). */
export interface TaskEngine {
  runDiscovery(): Promise<unknown>;
  processInbox(): Promise<unknown>;
  sendApprovedEmails(): Promise<unknown>;
  scheduleFollowUps(): Promise<unknown>;
  sendDigestToSelf(): Promise<unknown>;
}

export const defaultTaskEngine: TaskEngine = {
  runDiscovery: async () => (await import('@/engine/sources')).runDiscovery(),
  processInbox: async () => (await import('@/engine/inbox/process')).processInbox(),
  sendApprovedEmails: async () => (await import('@/engine/outreach/send')).sendApprovedEmails(),
  scheduleFollowUps: async () => (await import('@/engine/followup')).scheduleFollowUps(),
  sendDigestToSelf: async () => (await import('@/engine/digest')).sendDigestToSelf(),
};
