// Job mutations shared by the queue and job-detail server actions. Server-only; not an action file
// itself, so nothing here is callable from the browser except through the 'use server' wrappers.

import {
  addApplication, addArtifact, getJob, getMessage, getSettings, latestArtifact, listApplications, listContacts, setStatus, updateApplication,
  updateJob, updateMessage,
} from '@/lib/db';
import { loadAnswers, loadFacts, loadProfile, saveAnswers } from '@/lib/config';
import { redactSecrets } from '@/lib/env';
import { log } from '@/lib/log';
import { nowIso } from '@/lib/time';
import type { AnswerEntry, AnsweredQuestion, ApplyOutcome, Job, KeywordCoverage, ScreeningQuestion, TailoredCv } from '@/lib/types';
import { artifactFileExists, buildQueueItem, readArtifactText } from '@/lib/server';
import { fail, ok, type ActionResult } from '@/components/job/result';
import { TRANSITIONS, canTransition, type ManualAction, type SkipReason, SKIP_REASONS } from '@/components/job/transitions';
import { applyAnswerEdit, batchEligible, parseAnswers, serializeAnswers } from '@/components/queue/model';

const errText = (err: unknown) => redactSecrets(err instanceof Error ? err.message : String(err));

function needJob(jobId: unknown): Job | string {
  if (typeof jobId !== 'string' || !jobId.trim() || jobId.length > 64) return 'Bad job id';
  return getJob(jobId) ?? 'Job not found (it may have been merged or removed)';
}

// ───────────────────────────── Status moves ─────────────────────────────

export interface MoveDetail { reason?: SkipReason; note?: string }

/** Applies a manual status move after validating the lifecycle rule and the approval gate. */
export function moveJob(jobId: string, action: ManualAction, detail: MoveDetail = {}): ActionResult<{ status: Job['status'] }> {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  const rule = TRANSITIONS[action];
  if (!canTransition(action, job.status)) return fail(`Can't “${rule.label.toLowerCase()}” a job that is ${job.status.replace('_', ' ')}.`);

  if (action === 'approve') {
    const { gate } = buildQueueItem(job);
    if (!gate.ok) return fail(gate.reason ?? 'Not ready to approve');
  }
  if (action === 'requeue' && !artifactFileExists(latestArtifact(job.id, 'cv_pdf'))) {
    return fail('This job has no CV PDF yet: regenerate the CV before sending it back to the queue.');
  }

  const eventDetail: Record<string, unknown> = { by: 'kayzee', action };
  if (detail.reason) eventDetail.reason = SKIP_REASONS.find((r) => r.id === detail.reason)?.label ?? detail.reason;
  if (detail.note?.trim()) eventDetail.note = detail.note.trim().slice(0, 500);

  try {
    if (action === 'markApplied') recordManualApplication(job);
    const moved = setStatus(job.id, rule.to, eventDetail);
    if (!moved) return fail('Job disappeared while updating');
    // needs only explains a needs_you state; clear it once the job moves on.
    if (job.needs?.length && rule.to !== 'needs_you') updateJob(job.id, { needs: undefined });
    return ok(`${rule.label}: ${job.title}`, { status: moved.status });
  } catch (err) {
    return fail(errText(err));
  }
}

/** Kayzee submitted it himself (e.g. after a handoff): close any open attempt or record a manual one. */
function recordManualApplication(job: Job): void {
  const submittedAt = nowIso();
  const confirmation = 'Marked applied manually in the dashboard';
  const open = listApplications({ jobId: job.id, status: ['needs_you', 'started'], limit: 1 })[0];
  if (open) {
    updateApplication(open.id, { status: 'submitted', submittedAt, confirmation });
    return;
  }
  const cv = latestArtifact(job.id, 'cv_pdf');
  const variant = cv?.meta?.summaryVariant;
  addApplication({
    jobId: job.id, method: 'manual', status: 'submitted', submittedAt, confirmation,
    cvArtifactId: cv?.id, summaryVariant: typeof variant === 'string' ? variant : undefined,
  });
}

export function toggleStar(jobId: string): ActionResult<{ starred: boolean }> {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  const updated = updateJob(job.id, { starred: !job.starred });
  return ok(updated?.starred ? 'Starred' : 'Unstarred', { starred: Boolean(updated?.starred) });
}

export const MAX_NOTES = 20_000;

export function saveNotes(jobId: string, notes: string): ActionResult {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  const text = String(notes ?? '').slice(0, MAX_NOTES);
  updateJob(job.id, { notes: text.trim() ? text : undefined });
  return ok('Saved');
}

export function approveBatch(ids: string[], minScore: number): ActionResult<{ approved: string[]; skipped: string[] }> {
  if (!Array.isArray(ids) || ids.length === 0) return fail('Nothing selected');
  const approved: string[] = [];
  const skipped: string[] = [];
  for (const id of ids.slice(0, 200)) {
    const job = typeof id === 'string' ? getJob(id) : undefined;
    if (!job || !batchEligible(buildQueueItem(job), minScore)) {
      skipped.push(String(id));
      continue;
    }
    const res = moveJob(job.id, 'approve');
    (res.ok ? approved : skipped).push(job.id);
  }
  if (!approved.length) return fail('None of those jobs are eligible any more (they changed since the list was shown).');
  return ok(`Approved ${approved.length} job${approved.length === 1 ? '' : 's'}`, { approved, skipped });
}

// ───────────────────────────── Letter + answers ─────────────────────────────

export async function saveLetter(jobId: string, text: string): Promise<ActionResult<{ flags: string[] }>> {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  if (typeof text !== 'string' || !text.trim()) return fail('The letter is empty');
  if (text.length > 20_000) return fail('That letter is far too long');
  try {
    const { saveCoverLetter } = await import('@/engine/tailor/letter');
    const saved = await saveCoverLetter(job.id, text);
    const flags = saved.flags ?? [];
    return ok(flags.length ? `Saved v${saved.artifact.version} with ${flags.length} flag${flags.length === 1 ? '' : 's'}` : `Saved v${saved.artifact.version}`, { flags }, flags);
  } catch (err) {
    return fail(errText(err));
  }
}

function bankType(t: ScreeningQuestion['type']): AnswerEntry['type'] {
  if (t === 'select' || t === 'radio') return 'select';
  if (t === 'yesno') return 'yesno';
  if (t === 'number') return 'number';
  if (t === 'url') return 'url';
  return 'text';
}

/** Lowercase words only, so the pattern works whether the matcher treats it as substring or regex. */
export function bankPattern(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function rememberAnswer(q: AnsweredQuestion, value: string): void {
  const pattern = bankPattern(q.label);
  if (!pattern) return;
  const bank = loadAnswers();
  const existing = bank.entries.find((e) => e.patterns.some((p) => p.toLowerCase() === pattern));
  if (existing) {
    existing.answer = value;
    existing.confirm = false;
    existing.notes = `Updated from the approval queue ${nowIso().slice(0, 10)}`;
  } else {
    const slug = pattern.replace(/\s+/g, '-').slice(0, 40);
    bank.entries.push({
      id: `kayzee-${slug}-${Date.now().toString(36)}`,
      patterns: [pattern],
      answer: value,
      type: bankType(q.type),
      confirm: false,
      notes: `Added from the approval queue ${nowIso().slice(0, 10)}`,
    });
  }
  saveAnswers(bank);
}

export function saveAnswer(jobId: string, questionId: string, value: string, remember: boolean): ActionResult {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  if (typeof questionId !== 'string' || typeof value !== 'string') return fail('Bad answer');
  if (value.length > 5000) return fail('That answer is too long');
  const current = latestArtifact(job.id, 'answers');
  if (!current) return fail('No answers have been generated for this job yet');
  try {
    const { list, shape } = parseAnswers(readArtifactText(current));
    const next = applyAnswerEdit(list, questionId, value);
    addArtifact({
      jobId: job.id,
      kind: 'answers',
      content: serializeAnswers(next, shape),
      meta: { ...(current.meta ?? {}), editedBy: 'kayzee', editedQuestion: questionId, previousVersion: current.version },
    });
    const edited = next.find((q) => q.id === questionId);
    if (remember && edited && value.trim()) rememberAnswer(edited, value.trim());
    updateJob(job.id, {}); // bump updatedAt
    return ok(remember && value.trim() ? 'Saved and added to your answer bank' : 'Answer saved');
  } catch (err) {
    return fail(errText(err));
  }
}

// ───────────────────────────── Regenerate ─────────────────────────────

export type RegenerateWhat = 'cv' | 'letter' | 'answers';

async function coverageFor(job: Job): Promise<KeywordCoverage> {
  if (job.keywords) return job.keywords;
  const { defaultDeps } = await import('@/worker/deps');
  const kw = await defaultDeps.coverage(await defaultDeps.extractKeywords(job.description || job.title), loadFacts());
  updateJob(job.id, { keywords: kw });
  return kw;
}

/** Stores the CV outputs unless tailorCv already recorded them during this call. */
function recordCv(jobId: string, cv: TailoredCv, sinceIso: string): void {
  const fresh = (kind: Parameters<typeof latestArtifact>[1]) => {
    const latest = latestArtifact(jobId, kind);
    return Boolean(latest && latest.createdAt >= sinceIso);
  };
  const base = { summaryVariant: cv.summaryVariant, regenerated: true };
  if (cv.texPath && !fresh('cv_tex')) addArtifact({ jobId, kind: 'cv_tex', path: cv.texPath, meta: base });
  if (cv.pdfPath && !fresh('cv_pdf')) addArtifact({ jobId, kind: 'cv_pdf', path: cv.pdfPath, meta: { ...base, guard: cv.guard, atsScore: cv.ats?.score ?? null } });
  if (!cv.pdfPath && cv.compileLog && !fresh('compile_log')) addArtifact({ jobId, kind: 'compile_log', content: cv.compileLog.slice(-20_000), meta: base });
  if (cv.ats && !fresh('ats_report')) addArtifact({ jobId, kind: 'ats_report', content: JSON.stringify(cv.ats), meta: { score: cv.ats.score } });
}

export async function regenerate(jobId: string, what: RegenerateWhat): Promise<ActionResult> {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  try {
    const facts = loadFacts();
    const profile = loadProfile();
    if (what === 'cv') {
      const since = nowIso();
      const { defaultDeps } = await import('@/worker/deps');
      const cv = await defaultDeps.tailorCv(job, facts, profile, await coverageFor(job));
      recordCv(job.id, cv, since);
      log.forJob('info', job.id, 'dashboard', 'CV regenerated', { pdf: Boolean(cv.pdfPath), ats: cv.ats?.score ?? null });
      if (!cv.pdfPath) return fail('The CV was rebuilt but the PDF failed to compile. Check the compile log artifact.');
      // A job parked only because its PDF failed can go back to the queue now.
      if (job.status === 'needs_you' && (job.needs ?? []).every((n) => /cv pdf/i.test(n))) {
        setStatus(job.id, 'ready', { by: 'kayzee', action: 'regenerate-cv' });
        updateJob(job.id, { needs: undefined });
      }
      const rejected = cv.guard.rejectedBullets.length;
      return ok(`CV regenerated${cv.ats ? ` (ATS ${Math.round(cv.ats.score)})` : ''}`, undefined, rejected ? [`Truth guard dropped ${rejected} bullet${rejected === 1 ? '' : 's'}`] : undefined);
    }
    if (what === 'letter') {
      const { writeCoverLetter } = await import('@/engine/tailor/letter');
      const res = await writeCoverLetter(job, facts, profile, { coverage: job.keywords });
      return ok(res.flags.length ? `Letter regenerated with ${res.flags.length} flag${res.flags.length === 1 ? '' : 's'}` : 'Letter regenerated', undefined, res.flags);
    }
    const { questionsFromAtsMeta } = await import('@/worker/questions');
    let questions: ScreeningQuestion[] = questionsFromAtsMeta(job.atsMeta);
    if (!questions.length) {
      questions = parseAnswers(readArtifactText(latestArtifact(job.id, 'answers'))).list.map(
        ({ id, label, type, required, options }) => ({ id, label, type, required, ...(options ? { options } : {}) }),
      );
    }
    if (!questions.length) return fail('No screening questions were captured for this job, so there is nothing to answer.');
    const { defaultDeps } = await import('@/worker/deps');
    const answered = await defaultDeps.answerQuestions(questions, loadAnswers(), profile, facts, job);
    const unanswered = answered.filter((a) => a.needsHuman || a.answer === null).map((a) => a.label);
    addArtifact({ jobId: job.id, kind: 'answers', content: JSON.stringify(answered), meta: { total: answered.length, unanswered, regenerated: true } });
    return ok(`Answers regenerated: ${answered.length - unanswered.length}/${answered.length} answered`);
  } catch (err) {
    log.forJob('error', job.id, 'dashboard', `regenerate ${what} failed`, err);
    return fail(errText(err));
  }
}

// ───────────────────────────── Apply ─────────────────────────────

const APPLY_FROM: Job['status'][] = ['ready', 'approved', 'needs_you', 'failed'];

function describeOutcome(o: ApplyOutcome): ActionResult<ApplyOutcome> {
  if (o.status === 'applied') return ok(`Applied${o.confirmation ? `: ${o.confirmation.slice(0, 140)}` : ''}`, o);
  if (o.status === 'needs_you') return ok('Handed off: it needs you', o, o.needs);
  if (o.status === 'skipped') return ok('Skipped by the runner', o, o.needs ?? (o.error ? [o.error] : undefined));
  return fail(o.error ? redactSecrets(o.error) : 'The application failed');
}

/** "Apply now": Kayzee's click is the approval. Headless submit through the runner (which re-checks caps). */
export async function applyNow(jobId: string): Promise<ActionResult<ApplyOutcome>> {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  if (getSettings().paused) return fail('Paused: resume outbound actions to submit applications.');
  if (!APPLY_FROM.includes(job.status)) return fail(`Can't apply to a job that is ${job.status.replace('_', ' ')}.`);
  const item = buildQueueItem({ ...job, status: 'ready' });
  if (!item.cvPdfId) return fail('No CV PDF yet: regenerate the CV first.');
  if (!item.gate.ok) return fail(item.gate.reason ?? 'Not ready to submit');
  // Only the worker drives the browser (one Chrome profile; two processes at once corrupt each other's runs), so
  // "Apply now" queues the job at the front of the worker's apply queue instead of running it in the dashboard.
  if (job.status !== 'approved') setStatus(job.id, 'approved', { by: 'kayzee', action: 'apply-now' });
  updateJob(job.id, { needs: [] });
  return ok('Queued: the worker submits it within a minute. Watch it move to Applied.');
}

/** Fills the form in a visible Chrome window and stops; never submits (Kayzee reviews and submits himself). */
export async function fillAndHandOff(jobId: string): Promise<ActionResult<ApplyOutcome>> {
  const job = needJob(jobId);
  if (typeof job === 'string') return fail(job);
  if (['applied', 'replied', 'interview', 'offer', 'withdrawn'].includes(job.status)) return fail(`Already ${job.status}.`);
  try {
    const { openForHandoff } = await import('@/engine/apply/runner');
    return describeOutcome(await openForHandoff(job.id, { headless: false }));
  } catch (err) {
    return fail(errText(err));
  }
}

// ───────────────────────────── Drafts ─────────────────────────────

const EDITABLE: string[] = ['draft', 'approved'];

export async function updateDraft(messageId: number, subject: string, body: string): Promise<ActionResult> {
  const m = Number.isSafeInteger(messageId) ? getMessage(messageId) : undefined;
  if (!m) return fail('Draft not found');
  if (!EDITABLE.includes(m.status)) return fail(`That message is already ${m.status}`);
  const text = String(body ?? '').trim();
  if (!text) return fail('The message is empty');
  if (text.length > 20_000) return fail('That message is far too long');
  try {
    const { checkDraft } = await import('@/engine/outreach/draft');
    const job = m.jobId ? getJob(m.jobId) : undefined;
    const profile = loadProfile();
    const contact = m.contactId ? listContacts({ jobId: m.jobId, limit: 50 }).find((c) => c.id === m.contactId) : undefined;
    const allow = [job?.company, job?.title, contact?.name, ...Object.values(profile.name)].filter((s): s is string => Boolean(s?.trim()));
    const checked = checkDraft(text, loadFacts(), allow);
    updateMessage(m.id, {
      subject: m.channel === 'email' ? String(subject ?? '').trim().slice(0, 300) || m.subject : m.subject,
      body: checked.body,
      guardProblems: checked.guardProblems,
      slopHits: checked.slopHits,
      status: 'draft', // any edit needs a fresh approval
    });
    const warnings = [...checked.guardProblems, ...checked.slopHits];
    return ok(warnings.length ? 'Saved with warnings' : 'Saved', undefined, warnings);
  } catch (err) {
    return fail(errText(err));
  }
}

export function setDraftStatus(messageId: number, next: 'approved' | 'discarded'): ActionResult {
  const m = Number.isSafeInteger(messageId) ? getMessage(messageId) : undefined;
  if (!m) return fail('Draft not found');
  if (!EDITABLE.includes(m.status)) return fail(`That message is already ${m.status}`);
  if (next === 'approved') {
    if (m.channel !== 'email') return fail('LinkedIn notes are sent by you: copy it and open LinkedIn.');
    if (!m.to?.trim()) return fail('No recipient address on this draft');
    if (m.guardProblems?.length) return fail('Fix the truth-guard problems (edit and save) before approving.');
  }
  updateMessage(m.id, { status: next });
  return ok(next === 'approved' ? 'Approved: it sends on the next worker pass' : 'Discarded');
}
