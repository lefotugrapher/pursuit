'use server';
// Approval-queue server actions. The approval gate is enforced server-side in ../jobs/mutations,
// whatever the client shows.

import { revalidatePath } from 'next/cache';
import { getJob } from '@/lib/db';
import { fail, type ActionResult } from '@/components/job/result';
import { isSkipReason } from '@/components/job/transitions';
import { BATCH_MIN_SCORE } from '@/components/queue/model';
import * as m from '../jobs/mutations';

function refresh(jobId?: string): void {
  revalidatePath('/', 'layout');
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

export async function approveAction(jobId: string): Promise<ActionResult<{ status: string }>> {
  const res = m.moveJob(jobId, 'approve');
  if (res.ok) refresh(jobId);
  return res;
}

export async function skipAction(jobId: string, reason: string): Promise<ActionResult<{ status: string }>> {
  const res = m.moveJob(jobId, 'skip', { reason: isSkipReason(reason) ? reason : undefined });
  if (res.ok) refresh(jobId);
  return res;
}

/** Undo an approve/skip from the queue, only while the worker hasn't started on it. */
export async function undoAction(jobId: string): Promise<ActionResult<{ status: string }>> {
  const job = typeof jobId === 'string' ? getJob(jobId) : undefined;
  if (!job) return fail('Job not found');
  if (job.status !== 'approved' && job.status !== 'skipped') return fail(`Too late to undo: the job is already ${job.status.replace('_', ' ')}.`);
  const res = m.moveJob(job.id, 'requeue', { note: 'undo from queue' });
  if (res.ok) refresh(job.id);
  return res;
}

export async function approveBatchAction(ids: string[]): Promise<ActionResult<{ approved: string[]; skipped: string[] }>> {
  const res = m.approveBatch(ids, BATCH_MIN_SCORE);
  if (res.ok) refresh();
  return res;
}

export async function saveLetterAction(jobId: string, text: string): Promise<ActionResult<{ flags: string[] }>> {
  const res = await m.saveLetter(jobId, text);
  if (res.ok) refresh(jobId);
  return res;
}

export async function saveAnswerAction(jobId: string, questionId: string, value: string, remember: boolean): Promise<ActionResult> {
  const res = m.saveAnswer(jobId, questionId, value, remember === true);
  if (res.ok) refresh(jobId);
  return res;
}
