'use server';
// Job-detail server actions. Thin wrappers: validate input shape, call ./mutations, revalidate.

import { revalidatePath } from 'next/cache';
import { fail, type ActionResult } from '@/components/job/result';
import { isManualAction, isSkipReason } from '@/components/job/transitions';
import type { ApplyOutcome } from '@/lib/types';
import * as m from './mutations';

function refresh(jobId?: string): void {
  revalidatePath('/', 'layout');
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

export async function moveJobAction(jobId: string, action: string, reason?: string, note?: string): Promise<ActionResult<{ status: string }>> {
  if (!isManualAction(action)) return fail('Unknown action');
  const res = m.moveJob(jobId, action, { reason: isSkipReason(reason) ? reason : undefined, note });
  if (res.ok) refresh(jobId);
  return res;
}

export async function toggleStarAction(jobId: string): Promise<ActionResult<{ starred: boolean }>> {
  const res = m.toggleStar(jobId);
  if (res.ok) refresh(jobId);
  return res;
}

/** Autosave target: no revalidation, the textarea already shows the latest text. */
export async function saveNotesAction(jobId: string, notes: string): Promise<ActionResult> {
  return m.saveNotes(jobId, notes);
}

export async function regenerateAction(jobId: string, what: string): Promise<ActionResult> {
  if (what !== 'cv' && what !== 'letter' && what !== 'answers') return fail('Unknown artifact');
  const res = await m.regenerate(jobId, what);
  refresh(jobId);
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

export async function applyNowAction(jobId: string): Promise<ActionResult<ApplyOutcome>> {
  const res = await m.applyNow(jobId);
  refresh(jobId);
  return res;
}

export async function handOffAction(jobId: string): Promise<ActionResult<ApplyOutcome>> {
  const res = await m.fillAndHandOff(jobId);
  refresh(jobId);
  return res;
}

export async function updateDraftAction(messageId: number, subject: string, body: string, jobId?: string): Promise<ActionResult> {
  const res = await m.updateDraft(Number(messageId), subject, body);
  if (res.ok) refresh(jobId);
  return res;
}

export async function setDraftStatusAction(messageId: number, next: string, jobId?: string): Promise<ActionResult> {
  if (next !== 'approved' && next !== 'discarded') return fail('Unknown draft action');
  const res = m.setDraftStatus(Number(messageId), next);
  if (res.ok) refresh(jobId);
  return res;
}
