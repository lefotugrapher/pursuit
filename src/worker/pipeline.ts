// Pipeline stages: compose the engine modules into job-status transitions. Server-only.
//
//   discovered → filtered_out | scored | skipped          scorePending
//   scored     → tailoring → ready | needs_you            tailorPending
//   ready      → approved (autopilot, SPEC §7 only)        autopilotPass
//   approved   → applying → applied | needs_you | failed   processApproved (runner owns the result)
//   ready/...  → contacts + outreach drafts                outreachPending
//
// Every function takes an optional `deps` override so tests can inject fakes. Status changes go
// through `transition`, which re-reads the job inside a transaction so a concurrent edit from the
// dashboard (skip, withdraw) is never overwritten.

import fs from 'node:fs';
import {
  addArtifact, addMessage, applicationsToday, db, getJob, getSettings, latestArtifact, listEvents, listJobs,
  listMessages, logEvent, setStatus, tx, updateJob, upsertContact, kvGet, kvSet, updateMessage,
} from '@/lib/db';
import { log } from '@/lib/log';
import { dublinDayStartIso, isQuietHours, nowIso } from '@/lib/time';
import type {
  AnsweredQuestion, AnswerBank, ArtifactKind, AtsReport, Contact, FactBank, Job, JobQuery, JobStatus, KeywordCoverage,
  NewArtifact, NewContact, Profile, ScreeningQuestion, Settings, TailoredCv,
} from '@/lib/types';
import { isAbortError, resolveDeps, type DraftResult, type PipelineDeps } from './deps';
import { readLease } from './lock';
import { questionsFromAtsMeta } from './questions';

// ───────────────────────────── Shared helpers ─────────────────────────────

export const DEFAULT_BATCH = 5;
export const MAX_STAGE_FAILURES = 3;
export const APPLY_JITTER_MS = { min: 20_000, max: 60_000 } as const;
export const AUTOPILOT_MIN_ATS_SCORE = 80;
const DEMO_HEADROOM = 20;
const DASHBOARD_URL = 'http://localhost:7020';
const FAILURES_KEY = 'pipeline.failures';

/** Seeded demo jobs (scripts/seed.ts) are never touched by automated stages. */
export function isDemoJob(job: Pick<Job, 'atsMeta'>): boolean {
  return job.atsMeta?.demo === true;
}

/** listJobs minus demo rows, without letting demo rows starve the batch. */
function pickJobs(q: JobQuery, limit: number): Job[] {
  if (limit <= 0) return [];
  return listJobs({ ...q, limit: limit + DEMO_HEADROOM }).filter((j) => !isDemoJob(j)).slice(0, limit);
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Moves a job from one of `from` to `to` atomically, applying `patch` first. Returns undefined (and
 * changes nothing) when the job is gone or no longer in an expected status.
 */
export function transition(
  id: string,
  from: JobStatus | JobStatus[],
  to: JobStatus,
  detail?: Record<string, unknown>,
  patch?: Partial<Job>,
): Job | undefined {
  const froms = Array.isArray(from) ? from : [from];
  return tx(() => {
    const current = getJob(id);
    if (!current || !froms.includes(current.status)) return undefined;
    if (patch && Object.keys(patch).length) updateJob(id, patch);
    return setStatus(id, to, detail);
  });
}

interface FailureRecord { stage: string; count: number; lastError: string; at: string }

/** Per-job failure counter (kv), so one poison job can't be retried forever. Returns the new count. */
function recordFailure(stage: string, jobId: string, err: unknown): number {
  return tx(() => {
    const all = kvGet<Record<string, FailureRecord>>(FAILURES_KEY) ?? {};
    const key = `${stage}:${jobId}`;
    const next: FailureRecord = { stage, count: (all[key]?.count ?? 0) + 1, lastError: errMessage(err), at: nowIso() };
    all[key] = next;
    kvSet(FAILURES_KEY, all);
    return next.count;
  });
}

function clearFailure(stage: string, jobId: string): void {
  tx(() => {
    const all = kvGet<Record<string, FailureRecord>>(FAILURES_KEY);
    const key = `${stage}:${jobId}`;
    if (!all || !(key in all)) return;
    delete all[key];
    kvSet(FAILURES_KEY, all);
  });
}

async function safeNotify(deps: PipelineDeps, title: string, body: string, url?: string): Promise<void> {
  try {
    await deps.notify(title, body, url ? { url } : undefined);
  } catch (err) {
    log.warn('pipeline', `notification failed: ${errMessage(err)}`);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function clampScore(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ───────────────────────────── Scoring ─────────────────────────────

export interface ScoreStats {
  considered: number; scored: number; skipped: number; filteredOut: number; failed: number;
  errors: { jobId: string; error: string }[];
}

/** discovered → filtered_out | scored | skipped (total < settings.autoSkipBelow). */
export async function scorePending(limit = DEFAULT_BATCH, overrides?: Partial<PipelineDeps>): Promise<ScoreStats> {
  const deps = resolveDeps(overrides);
  const stats: ScoreStats = { considered: 0, scored: 0, skipped: 0, filteredOut: 0, failed: 0, errors: [] };
  // Oldest first, but jobs Pursuit can submit itself go ahead of LinkedIn/Indeed links: the free AI quota is
  // daily, so it should be spent where it can end in an application.
  const pool = pickJobs({ status: 'discovered', orderBy: 'discoveredAt', dir: 'asc' }, 500);
  const jobs = [...pool.filter((j) => !isUnresolved(j)), ...pool.filter((j) => isUnresolved(j))].slice(0, limit);
  if (!jobs.length) return stats;

  const settings = getSettings();
  const profile = deps.loadProfile();
  const facts = deps.loadFacts();

  for (const job of jobs) {
    stats.considered++;
    try {
      const outcome = await scoreOne(job, profile, facts, settings, deps);
      if (outcome === 'filtered_out') stats.filteredOut++;
      else if (outcome === 'skipped') stats.skipped++;
      else if (outcome === 'scored') stats.scored++;
      clearFailure('score', job.id);
    } catch (err) {
      stats.errors.push({ jobId: job.id, error: errMessage(err) });
      const count = recordFailure('score', job.id, err);
      log.forJob('error', job.id, 'pipeline', `scoring failed (attempt ${count}): ${errMessage(err)}`);
      if (count >= MAX_STAGE_FAILURES) {
        transition(job.id, 'discovered', 'failed', { stage: 'score', error: errMessage(err), attempts: count });
        stats.failed++;
      }
    }
  }
  return stats;
}

async function scoreOne(job: Job, profile: Profile, facts: FactBank, settings: Settings, deps: PipelineDeps): Promise<JobStatus | 'gone'> {
  const filters = await deps.hardFilters(job, profile);
  if (!filters.pass) {
    const moved = transition(job.id, 'discovered', 'filtered_out', { reasons: filters.rejected }, { filters });
    return moved ? 'filtered_out' : 'gone';
  }

  const keywords = await deps.extractKeywords(job.description || job.title);
  const kw = await deps.coverage(keywords, facts);
  const detail = await deps.scoreJob({ ...job, filters, keywords: kw }, profile, facts);
  const total = clampScore(detail.total);
  const patch: Partial<Job> = { filters, keywords: kw, score: total, scoreDetail: { ...detail, total } };

  if (total < settings.autoSkipBelow) {
    const reason = `Score ${total} is below the auto-skip threshold of ${settings.autoSkipBelow}`;
    return transition(job.id, 'discovered', 'skipped', { reason, score: total, auto: true }, patch) ? 'skipped' : 'gone';
  }
  return transition(job.id, 'discovered', 'scored', { score: total }, patch) ? 'scored' : 'gone';
}

// ───────────────────────────── Tailoring ─────────────────────────────

export interface TailorStats {
  considered: number; ready: number; needsYou: number; failed: number; retried: number;
  tailoredToday: number; cap: number; capped: boolean;
  errors: { jobId: string; error: string }[];
}

/** cv_pdf artifacts created since Dublin midnight (SPEC dailyTailorCap). */
export function tailoredToday(now: Date = new Date()): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'cv_pdf' AND created_at >= ?")
    .get(dublinDayStartIso(0, now));
  return Number(row?.n ?? 0);
}

/** scored (≥ minScore, best first, under the daily cap) → tailoring → ready | needs_you. */
export async function tailorPending(limit = DEFAULT_BATCH, overrides?: Partial<PipelineDeps>): Promise<TailorStats> {
  const deps = resolveDeps(overrides);
  const settings = getSettings();
  const used = tailoredToday(deps.now());
  const remaining = Math.max(0, settings.dailyTailorCap - used);
  const stats: TailorStats = {
    considered: 0, ready: 0, needsYou: 0, failed: 0, retried: 0,
    tailoredToday: used, cap: settings.dailyTailorCap, capped: remaining === 0, errors: [],
  };
  if (remaining === 0) return stats;

  const take = Math.min(limit, remaining);
  // Hands-free: a letter for a LinkedIn/Indeed link Pursuit can't submit just burns the daily cap and the free AI
  // quota. Wait until the resolver has found the employer's own page.
  const jobs = settings.autopilot.handsFree
    ? pickJobs({ status: 'scored', minScore: settings.minScore, orderBy: 'score', dir: 'desc' }, 500).filter((j) => !isUnresolved(j)).slice(0, take)
    : pickJobs({ status: 'scored', minScore: settings.minScore, orderBy: 'score', dir: 'desc' }, take);
  if (!jobs.length) return stats;

  const profile = deps.loadProfile();
  const facts = deps.loadFacts();
  const answers = deps.loadAnswers();
  const readyJobs: Job[] = [];

  for (const job of jobs) {
    if (!transition(job.id, 'scored', 'tailoring')) continue;
    stats.considered++;
    try {
      const status = await tailorOne(job, profile, facts, answers, deps);
      clearFailure('tailor', job.id);
      if (status === 'ready') {
        stats.ready++;
        readyJobs.push(job);
      } else if (status === 'needs_you') stats.needsYou++;
    } catch (err) {
      stats.errors.push({ jobId: job.id, error: errMessage(err) });
      const count = recordFailure('tailor', job.id, err);
      log.forJob('error', job.id, 'pipeline', `tailoring failed (attempt ${count}): ${errMessage(err)}`);
      if (count >= MAX_STAGE_FAILURES) {
        transition(job.id, 'tailoring', 'failed', { stage: 'tailor', error: errMessage(err), attempts: count });
        stats.failed++;
      } else {
        transition(job.id, 'tailoring', 'scored', { retry: count, error: errMessage(err) });
        stats.retried++;
      }
    }
  }
  stats.tailoredToday = tailoredToday(deps.now());

  if (readyJobs.length) {
    const top = readyJobs.slice(0, 3).map((j) => `${j.title} at ${j.company}`).join('; ');
    await safeNotify(deps, `${plural(readyJobs.length, 'new application')} ready to approve`, top, `${DASHBOARD_URL}/queue`);
  }
  return stats;
}

/** True when an artifact of `kind` was already written for this job since `sinceIso` (by the engine module). */
function hasArtifactSince(jobId: string, kind: ArtifactKind, sinceIso: string): boolean {
  const latest = latestArtifact(jobId, kind);
  return Boolean(latest && latest.createdAt >= sinceIso);
}

/** Adds the artifact unless the engine module already stored one during this tailoring run. */
function recordOnce(a: NewArtifact, sinceIso: string): void {
  if (!hasArtifactSince(a.jobId, a.kind, sinceIso)) addArtifact(a);
}

function recordCvArtifacts(jobId: string, cv: TailoredCv, sinceIso: string): void {
  const base = { summaryVariant: cv.summaryVariant };
  if (cv.texPath) recordOnce({ jobId, kind: 'cv_tex', path: cv.texPath, meta: base }, sinceIso);
  if (cv.pdfPath) {
    recordOnce({ jobId, kind: 'cv_pdf', path: cv.pdfPath, meta: { ...base, guard: cv.guard, atsScore: cv.ats?.score ?? null } }, sinceIso);
  } else if (cv.compileLog) {
    recordOnce({ jobId, kind: 'compile_log', content: cv.compileLog.slice(-20_000), meta: base }, sinceIso);
  }
  if (cv.ats) recordOnce({ jobId, kind: 'ats_report', content: JSON.stringify(cv.ats), meta: { score: cv.ats.score } }, sinceIso);
}

async function ensureCoverage(job: Job, facts: FactBank, deps: PipelineDeps): Promise<KeywordCoverage> {
  if (job.keywords) return job.keywords;
  const kw = await deps.coverage(await deps.extractKeywords(job.description || job.title), facts);
  updateJob(job.id, { keywords: kw });
  return kw;
}

async function tailorOne(job: Job, profile: Profile, facts: FactBank, answers: AnswerBank, deps: PipelineDeps): Promise<JobStatus | 'gone'> {
  const since = nowIso();
  const kw = await ensureCoverage(job, facts, deps);

  const cv = await deps.tailorCv(job, facts, profile, kw);
  recordCvArtifacts(job.id, cv, since);

  const letter = await deps.writeCoverLetter(job, facts, profile, kw);
  recordOnce({ jobId: job.id, kind: 'cover_letter', content: letter.text, meta: { guard: letter.guard, slop: letter.slop } }, since);

  const questions = questionsFromAtsMeta(job.atsMeta);
  const answered = questions.length ? await deps.answerQuestions(questions, answers, profile, facts, job) : [];
  const unanswered = answered.filter((a) => a.needsHuman).map((a) => a.label);
  recordOnce({ jobId: job.id, kind: 'answers', content: JSON.stringify(answered), meta: { total: answered.length, unanswered } }, since);

  const needs: string[] = [];
  if (!cv.pdfPath) needs.push('CV PDF failed to compile (see the compile log); regenerate or fix the CV before approving');
  const status: JobStatus = needs.length ? 'needs_you' : 'ready';
  const detail = {
    summaryVariant: cv.summaryVariant,
    atsScore: cv.ats?.score ?? null,
    cvGuardOk: cv.guard.ok,
    rejectedBullets: cv.guard.rejectedBullets.length,
    letterGuardOk: letter.guard.ok,
    letterSlopOk: letter.slop.ok,
    questions: answered.length,
    unanswered: unanswered.length,
  };
  const moved = transition(job.id, 'tailoring', status, detail, { needs: needs.length ? needs : undefined });
  if (moved) logEvent('tailor.done', detail, job.id);
  return moved ? status : 'gone';
}

// ───────────────────────────── Approved queue → apply ─────────────────────────────

export interface ApplyStats {
  attempted: number; applied: number; needsYou: number; failed: number; skipped: number;
  stoppedBy?: 'paused' | 'daily_cap' | 'shutdown';
  outcomes: { jobId: string; status: string; needs?: string[]; error?: string }[];
}

function jitterMs(deps: PipelineDeps): number {
  return Math.round(APPLY_JITTER_MS.min + deps.random() * (APPLY_JITTER_MS.max - APPLY_JITTER_MS.min));
}

/** Why the apply loop must stop now, if it must. Re-read every iteration: pause takes effect immediately. */
function applyStopReason(signal?: AbortSignal): ApplyStats['stoppedBy'] | undefined {
  if (signal?.aborted) return 'shutdown';
  const settings = getSettings();
  if (settings.paused) return 'paused';
  if (applicationsToday() >= settings.dailyApplyCap) return 'daily_cap';
  return undefined;
}

/** approved jobs, oldest approval first, one at a time with 20-60 s jitter; stops on pause/cap/shutdown. */
export async function processApproved(overrides?: Partial<PipelineDeps>, signal?: AbortSignal): Promise<ApplyStats> {
  const deps = resolveDeps(overrides);
  const stats: ApplyStats = { attempted: 0, applied: 0, needsYou: 0, failed: 0, skipped: 0, outcomes: [] };
  const queue = pickJobs({ status: 'approved', orderBy: 'updatedAt', dir: 'asc' }, 200);

  for (const queued of queue) {
    stats.stoppedBy = applyStopReason(signal);
    if (stats.stoppedBy) break;
    if (getJob(queued.id)?.status !== 'approved') continue;
    // Still a LinkedIn/Indeed link: the resolver hasn't found the employer's page yet. Leave it approved for later,
    // without costing a browser run or the 20-60 s spacing.
    if (UNRESOLVED_ATS.has(queued.ats) || /linkedin\.com|indeed\.(com|ie)/i.test(queued.applyUrl ?? '')) {
      stats.skipped++;
      continue;
    }

    if (stats.attempted > 0) {
      try {
        await deps.sleep(jitterMs(deps), signal);
      } catch (err) {
        if (isAbortError(err)) {
          stats.stoppedBy = 'shutdown';
          break;
        }
        throw err;
      }
      stats.stoppedBy = applyStopReason(signal);
      if (stats.stoppedBy) break;
      if (getJob(queued.id)?.status !== 'approved') continue;
    }

    stats.attempted++;
    try {
      const outcome = await deps.applyToJob(queued.id, { mode: 'submit', headless: true });
      stats.outcomes.push({ jobId: queued.id, status: outcome.status, needs: outcome.needs, error: outcome.error });
      // A form asked something only Kayzee can answer: text him (and remember the answer), unless a CAPTCHA, login or
      // account wall blocks the job anyway. The question queue re-approves the job once every question is answered.
      const otherBlockers = (outcome.blockedBy ?? []).filter((b) => b !== 'unknown_required_field' && b !== 'attestation');
      if (outcome.status === 'needs_you' && outcome.questions?.length && !otherBlockers.length) {
        const job = getJob(queued.id);
        if (job) await deps.askKayzee(job, outcome.questions).catch(() => false);
      }
      await Promise.resolve(deps.reportOutcome(queued.id, outcome)).catch(() => undefined);
      if (outcome.status === 'applied') stats.applied++;
      else if (outcome.status === 'needs_you') stats.needsYou++;
      else if (outcome.status === 'failed') stats.failed++;
      else stats.skipped++;
    } catch (err) {
      // We can't know whether the form was submitted, so hand it to Kayzee rather than retrying.
      const needs = [`The apply step crashed (${errMessage(err)}). Check the employer site before re-applying.`];
      transition(queued.id, ['approved', 'applying'], 'needs_you', { stage: 'apply', error: errMessage(err) }, { needs });
      log.forJob('error', queued.id, 'pipeline', `apply crashed: ${errMessage(err)}`);
      stats.needsYou++;
      stats.outcomes.push({ jobId: queued.id, status: 'needs_you', needs, error: errMessage(err) });
    }
  }
  return stats;
}

// ───────────────────────────── Autopilot (SPEC §7) ─────────────────────────────

export interface AutopilotStats {
  skipped?: 'disabled' | 'paused' | 'quiet_hours' | 'daily_cap';
  considered: number;
  approved: string[];
  rejected: Record<string, string[]>;
  approvedToday: number;
}

/** Autopilot approvals since Dublin midnight (its own daily cap). */
export function autopilotApprovedToday(now: Date = new Date()): number {
  return listEvents({ type: 'autopilot.approved', since: dublinDayStartIso(0, now), limit: 10_000 }).length;
}

function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function atsScoreFor(jobId: string): number | undefined {
  const report = latestArtifact(jobId, 'ats_report');
  const parsed = parseJson<Partial<AtsReport>>(report?.content);
  if (typeof parsed?.score === 'number') return parsed.score;
  if (typeof report?.meta?.score === 'number') return report.meta.score;
  const pdfScore = latestArtifact(jobId, 'cv_pdf')?.meta?.atsScore;
  return typeof pdfScore === 'number' ? pdfScore : undefined;
}

function answerProblems(answered: AnsweredQuestion[], requireAll: boolean): string[] {
  const problems: string[] = [];
  for (const q of answered) {
    const label = `"${q.label.slice(0, 80)}"`;
    if (q.needsHuman) {
      problems.push(`Question needs Kayzee: ${label}`);
      continue;
    }
    if (q.answer === null || q.answer === '') {
      // CV / cover-letter uploads come back empty but handled: the apply filler attaches the files.
      if (q.type === 'file') continue;
      if (requireAll || q.required) problems.push(`Unanswered question ${label}`);
      continue;
    }
    if (q.source !== 'bank' && q.source !== 'profile') problems.push(`Answer to ${label} is not from the answer bank (${q.source})`);
    if (q.confirm) problems.push(`Answer to ${label} uses a bank entry Kayzee hasn't confirmed`);
  }
  return problems;
}

/** Hands-free never tries these: not resolved to the employer yet, or the employer's system needs an account. */
const UNRESOLVED_ATS = new Set<string>(['linkedin', 'indeed']);
const ACCOUNT_WALL_ATS = new Set<string>(['workday']);
/** Still a LinkedIn/Indeed (or unknown board) link: Pursuit can't apply until the resolver finds the employer page. */
function isUnresolved(job: Job): boolean {
  return UNRESOLVED_ATS.has(job.ats) || job.ats === 'unknown' || /linkedin\.com|indeed\.(com|ie)/i.test(job.applyUrl ?? '');
}
/** Flags that still stop hands-free (the rest are informational or already hard filters). */
const HANDSFREE_DEALBREAKERS: RegExp[] = [
  /unpaid|voluntary/i,
  /irish language mentioned: check if essential/i,
  /driving licen[cs]e \/ own transport required/i,
  /no sponsorship/i,
  /^Filtered:/i,
];

/**
 * Every reason this ready job may NOT be auto-approved (empty = eligible). Checks the per-job
 * conditions of SPEC §7; the global ones (mode, quiet hours, cap) are checked by autopilotPass.
 */
export async function autopilotBlockers(job: Job, settings: Settings, facts: FactBank, profile: Profile, deps: PipelineDeps): Promise<string[]> {
  const ap = settings.autopilot;
  const reasons: string[] = [];
  if (job.status !== 'ready') reasons.push(`Status is ${job.status}, not ready`);
  if (isDemoJob(job)) reasons.push('Demo job');
  if (job.needs?.length) reasons.push(`Has open needs: ${job.needs.join('; ')}`);

  const score = job.score ?? job.scoreDetail?.total;
  if (typeof score !== 'number') reasons.push('Not scored');
  else if (score < ap.minScore) reasons.push(`Score ${score} is below the autopilot minimum of ${ap.minScore}`);

  if (ap.handsFree) {
    // Any form the runner can fill. LinkedIn/Indeed links wait for the resolver to find the employer's own page;
    // account-wall systems are never signed up for on his behalf.
    if (UNRESOLVED_ATS.has(job.ats) || /linkedin\.com|indeed\.(com|ie)/i.test(job.applyUrl ?? '')) reasons.push("Not on the employer's own site yet");
    if (ACCOUNT_WALL_ATS.has(job.ats)) reasons.push(`"${job.ats}" needs an account; Pursuit never creates one for him`);
  } else if (!ap.ats.includes(job.ats)) {
    reasons.push(`ATS "${job.ats}" is not in the autopilot list (${ap.ats.join(', ') || 'none'})`);
  }

  const flags = [...new Set([...(job.scoreDetail?.flags ?? []), ...(job.filters?.flags ?? [])])];
  const blocking = ap.handsFree ? flags.filter((f) => HANDSFREE_DEALBREAKERS.some((re) => re.test(f))) : flags;
  if (blocking.length) reasons.push(`Has flags: ${blocking.join('; ')}`);

  const cvPdf = latestArtifact(job.id, 'cv_pdf');
  if (!cvPdf?.path) reasons.push('No tailored CV PDF');
  else if (!fs.existsSync(cvPdf.path)) reasons.push('Tailored CV PDF is missing on disk');
  const cvGuard = cvPdf?.meta?.guard as { ok?: unknown } | undefined;
  if (cvPdf && cvGuard?.ok !== true) reasons.push('CV truth guard is not clean');

  const ats = atsScoreFor(job.id);
  if (ats === undefined) reasons.push('No ATS report');
  else if (ats < AUTOPILOT_MIN_ATS_SCORE) reasons.push(`ATS score ${ats} is below ${AUTOPILOT_MIN_ATS_SCORE}`);

  const letter = latestArtifact(job.id, 'cover_letter');
  if (!letter?.content?.trim()) reasons.push('No cover letter');
  else {
    const check = await deps.checkCoverLetter(job, letter.content, facts, profile);
    // The truth guard always blocks. Style (slop lint, length, naming the company) blocks only in strict autopilot.
    if (!check.guard.ok) reasons.push(`Cover letter truth guard: ${check.guard.problems.slice(0, 3).join('; ') || 'not clean'}`);
    if (!ap.handsFree) {
      if (!check.slop.ok) reasons.push(`Cover letter slop lint: ${check.slop.hits.slice(0, 3).map((h) => h.match).join(', ') || 'not clean'}`);
      const other = check.guard.ok && check.slop.ok ? check.problems : [];
      if (other.length) reasons.push(`Cover letter: ${other.slice(0, 3).join('; ')}`);
    }
  }

  const questions = questionsFromAtsMeta(job.atsMeta);
  const answersArtifact = latestArtifact(job.id, 'answers');
  const answered = parseJson<AnsweredQuestion[]>(answersArtifact?.content);
  if (questions.length && !Array.isArray(answered)) reasons.push('Screening questions were not answered');
  else if (Array.isArray(answered) && !ap.handsFree) {
    reasons.push(...answerProblems(answered, ap.requireAllAnswers));
    const answeredIds = new Set(answered.map((a) => a.id));
    const missing = questions.filter((q) => !answeredIds.has(q.id) && (ap.requireAllAnswers || q.required));
    if (missing.length) reasons.push(`Questions without an answer: ${missing.map((q) => `"${q.label.slice(0, 60)}"`).join(', ')}`);
  }
  return reasons;
}

/** Hands-free: the questions on a job only Kayzee can answer (unknown, or from a bank entry he hasn't confirmed). */
export function questionsForKayzee(job: Job): ScreeningQuestion[] {
  const questions = questionsFromAtsMeta(job.atsMeta);
  const answered = parseJson<AnsweredQuestion[]>(latestArtifact(job.id, 'answers')?.content) ?? [];
  const byId = new Map(answered.map((a) => [a.id, a]));
  const out: ScreeningQuestion[] = [];
  for (const a of answered) {
    if (a.type === 'file') continue;
    if (a.needsHuman || a.confirm || ((a.answer === null || a.answer === '') && a.required)) out.push(a);
  }
  for (const q of questions) if (q.required && !byId.has(q.id)) out.push(q);
  return out;
}

/** Logs the rejection reasons for a job only when they changed since the last pass (no event spam). */
function logRejection(jobId: string, reasons: string[]): void {
  const last = listEvents({ jobId, type: 'autopilot.rejected', limit: 1 })[0];
  const previous = Array.isArray(last?.detail?.reasons) ? (last.detail.reasons as string[]) : undefined;
  if (previous && previous.join('\n') === reasons.join('\n')) return;
  logEvent('autopilot.rejected', { reasons }, jobId);
}

/** Auto-approves ready jobs that pass every SPEC §7 condition; everything else stays in the queue. */
export async function autopilotPass(overrides?: Partial<PipelineDeps>): Promise<AutopilotStats> {
  const deps = resolveDeps(overrides);
  const settings = getSettings();
  const now = deps.now();
  const approvedToday = autopilotApprovedToday(now);
  const stats: AutopilotStats = { considered: 0, approved: [], rejected: {}, approvedToday };

  if (settings.mode !== 'autopilot' || !settings.autopilot.enabled) return { ...stats, skipped: 'disabled' };
  if (settings.paused) return { ...stats, skipped: 'paused' };
  if (isQuietHours(settings, now) && !settings.autopilot.handsFree) return { ...stats, skipped: 'quiet_hours' };
  if (approvedToday >= settings.autopilot.dailyCap) return { ...stats, skipped: 'daily_cap' };

  const facts = deps.loadFacts();
  const profile = deps.loadProfile();
  const candidates = listJobs({ status: 'ready', orderBy: 'score', dir: 'desc', limit: 500 }).filter((j) => !isDemoJob(j));
  for (const job of candidates) {
    stats.considered++;
    const reasons = await autopilotBlockers(job, settings, facts, profile, deps);
    if (!reasons.length && approvedToday + stats.approved.length >= settings.autopilot.dailyCap) {
      reasons.push(`Autopilot daily cap of ${settings.autopilot.dailyCap} reached`);
    }
    if (reasons.length) {
      stats.rejected[job.id] = reasons;
      logRejection(job.id, reasons);
      continue;
    }
    if (settings.autopilot.handsFree) {
      const ask = questionsForKayzee(job);
      if (ask.length) {
        // Hands-free approves the job (recorded, so the question queue may later put it back in line), parks it with
        // one standard need per question, then asks him. Answers he already gave are reused at once and the job is
        // re-queued straight away; new questions go to Telegram and re-queue the job when he replies.
        if (!transition(job.id, 'ready', 'approved', { by: 'autopilot', handsFree: true, score: job.score })) continue;
        transition(job.id, 'approved', 'needs_you', { by: 'autopilot', waitingOn: 'answers', questions: ask.map((q) => q.label).slice(0, 10) });
        updateJob(job.id, { needs: ask.map((q) => `Answer required question: "${q.label}"`) });
        const queued = await deps.askKayzee(job, ask).catch(() => false);
        logEvent(queued ? 'autopilot.asked' : 'autopilot.ask_failed', { questions: ask.map((q) => q.label).slice(0, 10) }, job.id);
        if (!queued) stats.rejected[job.id] = [`Needs your answer to: ${ask.map((q) => `"${q.label.slice(0, 50)}"`).join(', ')}`];
        continue;
      }
    }
    const moved = transition(job.id, 'ready', 'approved', { by: 'autopilot', score: job.score });
    if (!moved) continue;
    logEvent('autopilot.approved', { score: job.score, ats: job.ats }, job.id);
    stats.approved.push(job.id);
  }

  if (stats.approved.length) {
    const titles = stats.approved.map((id) => getJob(id)).filter((j): j is Job => Boolean(j)).map((j) => `${j.title} at ${j.company}`);
    await safeNotify(deps, `Autopilot approved ${plural(stats.approved.length, 'application')}`, titles.slice(0, 5).join('; '), `${DASHBOARD_URL}/pipeline`);
  }
  stats.approvedToday = approvedToday + stats.approved.length;
  return stats;
}

// ───────────────────────────── Outreach ─────────────────────────────

export interface OutreachStats {
  considered: number; contactsFound: number; emailDrafts: number; linkedinDrafts: number;
  errors: { jobId: string; error: string }[];
}

const OUTREACH_STATUSES: JobStatus[] = ['ready', 'approved', 'applying', 'applied'];
const OUTREACH_SCAN = 200;

function outreachDone(jobId: string): boolean {
  return listEvents({ jobId, type: 'outreach.processed', limit: 1 }).length > 0;
}

function hasDraftOfKind(jobId: string, kind: 'outreach' | 'linkedin_note'): boolean {
  return listMessages({ jobId, kind, direction: 'out', limit: 1 }).length > 0;
}

const byConfidence = (a: Contact, b: Contact) => b.confidence - a.confidence;

/** findContacts may return rows it already saved; upsertContact wants the NewContact shape. */
function asNewContact(c: Contact | NewContact, jobId: string): NewContact {
  const { id: _id, createdAt: _createdAt, ...rest } = c as Partial<Contact> & NewContact;
  return { ...rest, jobId: rest.jobId ?? jobId };
}

/**
 * Runs one drafting call. A DraftError is the drafter declining (no-reply address, unverified email...):
 * that's a "no draft" outcome, not a stage failure worth retrying.
 */
async function tryDraft(jobId: string, kind: string, draft: () => Promise<DraftResult>): Promise<DraftResult> {
  try {
    return await draft();
  } catch (err) {
    if (err instanceof Error && err.name === 'DraftError') {
      log.forJob('info', jobId, 'pipeline', `no ${kind} draft: ${errMessage(err)}`);
      return null;
    }
    throw err;
  }
}

/** Stores a drafting result as a draft. Approval only ever comes from Kayzee, so status is forced to draft. */
function storeDraft(result: DraftResult, job: Job, contact: Contact): boolean {
  if (!result) return false;
  if ('id' in result && typeof result.id === 'number') {
    if (result.status === 'approved') updateMessage(result.id, { status: 'draft' });
    return true;
  }
  if (!result.body?.trim()) return false;
  addMessage({ ...result, jobId: result.jobId ?? job.id, contactId: result.contactId ?? contact.id, direction: 'out', status: 'draft' });
  return true;
}

/** Finds contacts and drafts an outreach email + LinkedIn note for jobs not yet processed. */
export async function outreachPending(limit = DEFAULT_BATCH, overrides?: Partial<PipelineDeps>): Promise<OutreachStats> {
  const deps = resolveDeps(overrides);
  const stats: OutreachStats = { considered: 0, contactsFound: 0, emailDrafts: 0, linkedinDrafts: 0, errors: [] };
  const jobs = pickJobs({ status: OUTREACH_STATUSES, orderBy: 'score', dir: 'desc' }, OUTREACH_SCAN)
    .filter((j) => !outreachDone(j.id))
    .slice(0, limit);
  if (!jobs.length) return stats;

  const profile = deps.loadProfile();
  const facts = deps.loadFacts();

  for (const job of jobs) {
    stats.considered++;
    try {
      const found = await deps.findContacts(job);
      const contacts = found.map((c) => upsertContact(asNewContact(c, job.id)));
      stats.contactsFound += contacts.length;

      let emailDraft = false;
      const emailContact = contacts.filter((c) => c.email && c.emailVerified).sort(byConfidence)[0];
      if (emailContact && !hasDraftOfKind(job.id, 'outreach')) {
        const result = await tryDraft(job.id, 'outreach email', () => deps.draftOutreachEmail(job, emailContact, facts, profile));
        emailDraft = storeDraft(result, job, emailContact);
        if (emailDraft) stats.emailDrafts++;
      }

      let noteDraft = false;
      const liContact = contacts.filter((c) => c.linkedinUrl).sort(byConfidence)[0];
      if (liContact && !hasDraftOfKind(job.id, 'linkedin_note')) {
        const result = await tryDraft(job.id, 'LinkedIn note', () => deps.draftLinkedInNote(job, liContact, facts));
        noteDraft = storeDraft(result, job, liContact);
        if (noteDraft) stats.linkedinDrafts++;
      }

      logEvent('outreach.processed', { contacts: contacts.length, emailDraft, noteDraft }, job.id);
      clearFailure('outreach', job.id);
    } catch (err) {
      stats.errors.push({ jobId: job.id, error: errMessage(err) });
      const count = recordFailure('outreach', job.id, err);
      log.forJob('warn', job.id, 'pipeline', `outreach failed (attempt ${count}): ${errMessage(err)}`);
      if (count >= MAX_STAGE_FAILURES) logEvent('outreach.processed', { error: errMessage(err), attempts: count }, job.id);
    }
  }
  return stats;
}

// ───────────────────────────── Crash recovery ─────────────────────────────

export const STUCK_AFTER_MS = 15 * 60_000;

/**
 * Called once at worker start. A job left in 'tailoring' goes back to 'scored' (safe to redo).
 * A job left in 'applying' goes to 'needs_you': it may or may not have been submitted, and
 * re-submitting could double-apply. Skipped while a live lease shows another process is on it.
 */
export function recoverInterrupted(now: Date = new Date()): { tailoring: number; applying: number } {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();
  const result = { tailoring: 0, applying: 0 };

  if (!readLease('tailor', now)) {
    for (const job of listJobs({ status: 'tailoring' })) {
      if (job.updatedAt > cutoff || isDemoJob(job)) continue;
      if (transition(job.id, 'tailoring', 'scored', { recovered: 'worker restarted mid-tailoring' })) result.tailoring++;
    }
  }
  if (!readLease('apply', now)) {
    for (const job of listJobs({ status: 'applying' })) {
      if (job.updatedAt > cutoff || isDemoJob(job)) continue;
      const needs = ['The worker stopped mid-application. Check whether it was submitted, then mark it applied or re-approve.'];
      if (transition(job.id, 'applying', 'needs_you', { recovered: 'worker restarted mid-apply' }, { needs })) result.applying++;
    }
  }
  return result;
}
