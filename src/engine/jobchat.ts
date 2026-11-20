// Per-application assistant: a chat on each job's page that knows that application inside out (status, what's
// blocking it, its open questions, the letter and answers Pursuit prepared, its timeline). Kayzee can ask how it's
// going, or give details; answers to this job's open questions are saved (and the job re-queued) straight away.

import { z } from 'zod';
import { getJob, kvGet, kvSet, latestArtifact, listEvents, updateJob } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { answerQuestion, pendingQuestions } from '@/engine/questions';
import { rememberNote } from '@/engine/telegram/assistant';

export interface JobChatTurn { role: 'you' | 'pursuit'; text: string; ts: string; saved?: string[] }

const key = (jobId: string) => `jobchat.${jobId}`;

export function loadJobChat(jobId: string): JobChatTurn[] {
  return kvGet<JobChatTurn[]>(key(jobId)) ?? [];
}

function context(jobId: string): string {
  const job = getJob(jobId)!;
  const open = pendingQuestions().filter((q) => q.waiting.some((w) => w.jobId === jobId));
  const letter = latestArtifact(jobId, 'cover_letter')?.content ?? '';
  const answers = latestArtifact(jobId, 'answers')?.content ?? '';
  const events = listEvents({ jobId, limit: 25 }).map((e) => `${e.ts.slice(5, 16)} ${e.type} ${JSON.stringify(e.detail ?? {}).slice(0, 140)}`);
  return [
    `APPLICATION SENT: ${SENT_STATUSES.has(job.status) ? 'YES' : 'NO. Pursuit has NOT applied to this job. Nothing has been submitted.'}`,
    `JOB: ${job.title} at ${job.company} (${job.location}). Status: ${job.status}. Score ${job.score ?? '-'}.`,
    `FOUND THROUGH (where the posting was discovered, NOT how it was applied to): ${job.source}`,
    `APPLICATION FORM IS ON: ${job.ats} ${job.applyUrl}`,
    `WHY IT SCORED: ${(job.scoreDetail?.reasons ?? []).join('; ')}`,
    `BLOCKING: ${(job.needs ?? []).join(' | ') || 'nothing'}`,
    `OPEN QUESTIONS FOR THIS JOB:\n${open.map((q, i) => `${i + 1}. ${q.label}${q.options?.length ? ` (options: ${q.options.slice(0, 12).join(' / ')})` : ''}`).join('\n') || 'none'}`,
    `NOTES: ${job.notes ?? ''}`,
    `COVER LETTER (prepared): ${letter.slice(0, 1500)}`,
    `SCREENING ANSWERS (prepared, JSON): ${answers.slice(0, 2500)}`,
    `TIMELINE (newest first):\n${events.join('\n')}`,
  ].join('\n\n');
}

/** Statuses in which an application really went out. */
const SENT_STATUSES = new Set<string>(['applied', 'replied', 'interview', 'offer', 'rejected']);
const CLAIMS_SENT = /\b(applied|submitted|sent (the|your|an|this) application)\b/i;
const DENIES_SENT = /\b(not|never|n't|hasn'?t|haven'?t|yet to|before|once|after|will|can'?t|cannot|to be|ready to)\b[^.!?]{0,60}\b(appl(y|ied)|submit(ted)?|sent)\b/i;

/** What is true about an unsent application, written by code so a model can't dress it up. */
export function unsentStatus(job: { status: string; score?: number | null; ats: string; needs?: string[] | null }): string {
  const waiting = (job.needs ?? []).join(' ');
  const stage: Record<string, string> = {
    discovered: 'It has been found but not scored yet.',
    scored: `It is scored${job.score != null ? ` ${Math.round(job.score)}` : ''} and waiting for a CV and cover letter to be written.`,
    tailoring: 'Its CV and cover letter are being written now.',
    ready: 'Its CV and cover letter are ready and it is waiting to be approved.',
    approved: 'It is approved and queued to be submitted.',
    applying: 'It is being submitted right now.',
    needs_you: `It is waiting on you. ${waiting}`.trim(),
    skipped: 'It was skipped.',
    filtered_out: 'It was filtered out.',
    failed: 'The last attempt failed.',
  };
  const where = job.ats === 'linkedin' || job.ats === 'indeed' ? " Pursuit can't submit on LinkedIn or Indeed itself; it is looking for the employer's own application page." : '';
  return `This application has not been sent. ${stage[job.status] ?? `Status: ${job.status}.`}${where} You will see it under Applied, with a screenshot of the confirmation, when it has gone.`;
}

/** True when a reply says the application went out although it didn't. */
export function wronglyClaimsSent(reply: string, status: string): boolean {
  if (SENT_STATUSES.has(status)) return false;
  return reply.split(/(?<=[.!?])\s+/).some((sentence) => CLAIMS_SENT.test(sentence) && !DENIES_SENT.test(sentence));
}

const ReplySchema = z.object({
  reply: z.string().min(1).max(2000),
  answers: z.array(z.object({ n: z.coerce.number().int(), answer: z.coerce.string().max(1500) })).max(20).catch([]),
  note: z.string().max(800).nullable().optional(),
  remember: z.string().max(800).nullable().optional(),
});

export async function jobChatReply(jobId: string, message: string, now: Date = new Date()): Promise<JobChatTurn[]> {
  const job = getJob(jobId);
  if (!job) throw new Error('That job no longer exists.');
  const turns = loadJobChat(jobId);
  const said = message.trim().slice(0, 4000);
  if (said) turns.push({ role: 'you', text: said, ts: now.toISOString() });

  let turn: JobChatTurn;
  if (!hasLLM()) {
    turn = { role: 'pursuit', text: `Status: ${job.status}. ${(job.needs ?? []).join(' ') || 'Nothing is blocking it.'} (The AI is offline, so I can only show the basics.)`, ts: new Date().toISOString() };
  } else {
    const open = pendingQuestions().filter((q) => q.waiting.some((w) => w.jobId === jobId));
    const out = await llmJSON({
      purpose: 'jobchat',
      system: [
        `You are Pursuit, Kayzee's assistant for ONE job application: ${job.title} at ${job.company}. Speak plainly and briefly, no em dashes.`,
        'Answer his questions about this application from the CONTEXT only (status, what blocks it, what was prepared, what happened).',
        'If APPLICATION SENT says NO, never say or imply it was applied to, submitted or sent. "Found through" is only where the posting was discovered.',
        'If his message answers any OPEN QUESTIONS FOR THIS JOB, return them in "answers" as {n, answer} using his words (option text for option questions).',
        'If he gives a detail only relevant to this job, put it in "note". If he states a general fact about himself, put it in "remember".',
        'Return JSON {"reply": string, "answers": [{n, answer}], "note": string|null, "remember": string|null}.',
      ].join('\n'),
      user: `CONTEXT:\n${context(jobId)}\n\nCONVERSATION SO FAR:\n${untrusted('chat', turns.slice(-12).map((t) => `${t.role === 'you' ? 'KAYZEE' : 'PURSUIT'}: ${t.text}`).join('\n'), 8000)}`,
      schema: ReplySchema,
      maxTokens: 900,
      temperature: 0.3,
    });
    const saved: string[] = [];
    if (out) {
      for (const a of out.answers) {
        const q = open[a.n - 1];
        if (!q) continue;
        const r = answerQuestion(q.id, a.answer, { via: 'dashboard', now });
        saved.push(r.ok ? `Saved "${q.label.slice(0, 60)}": ${a.answer.slice(0, 60)}` : `Couldn't save "${q.label.slice(0, 60)}": ${(r.error ?? '').split('\n')[0].slice(0, 80)}`);
      }
      if (out.note?.trim()) {
        updateJob(jobId, { notes: `${(getJob(jobId)?.notes ?? '').trim()}\n${now.toISOString().slice(0, 10)}: ${out.note.trim()}`.trim() });
        saved.push('Added to this job\'s notes');
      }
      if (out.remember?.trim()) {
        rememberNote(out.remember.trim(), now);
        saved.push('Remembered for future applications');
      }
    }
    turn = {
      role: 'pursuit',
      // A free model once told him an unsent job had been "applied via LinkedIn guest". The status line is the truth.
      text: !out ? "Sorry, I couldn't reach the AI just now. Try again in a moment."
        : wronglyClaimsSent(out.reply, job.status) ? unsentStatus(getJob(jobId) ?? job)
        : out.reply.replace(/\s+[—–]\s+/g, ', '),
      ts: new Date().toISOString(),
      ...(saved.length ? { saved } : {}),
    };
  }
  turns.push(turn);
  kvSet(key(jobId), turns.slice(-60));
  return turns;
}
