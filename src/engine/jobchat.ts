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
    `JOB: ${job.title} at ${job.company} (${job.location}). Status: ${job.status}. Score ${job.score ?? '-'}. Applies via: ${job.ats} ${job.applyUrl}`,
    `WHY IT SCORED: ${(job.scoreDetail?.reasons ?? []).join('; ')}`,
    `BLOCKING: ${(job.needs ?? []).join(' | ') || 'nothing'}`,
    `OPEN QUESTIONS FOR THIS JOB:\n${open.map((q, i) => `${i + 1}. ${q.label}${q.options?.length ? ` (options: ${q.options.slice(0, 12).join(' / ')})` : ''}`).join('\n') || 'none'}`,
    `NOTES: ${job.notes ?? ''}`,
    `COVER LETTER (prepared): ${letter.slice(0, 1500)}`,
    `SCREENING ANSWERS (prepared, JSON): ${answers.slice(0, 2500)}`,
    `TIMELINE (newest first):\n${events.join('\n')}`,
  ].join('\n\n');
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
        'Never claim it was submitted unless the status is applied/replied/interview/offer.',
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
      text: out ? out.reply.replace(/\s+[—–]\s+/g, ', ') : "Sorry, I couldn't reach the AI just now. Try again in a moment.",
      ts: new Date().toISOString(),
      ...(saved.length ? { saved } : {}),
    };
  }
  turns.push(turn);
  kvSet(key(jobId), turns.slice(-60));
  return turns;
}
