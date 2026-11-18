'use server';

import { revalidatePath } from 'next/cache';
import { approveAnswer, approveFact, coachReply, dismissProposal, loadThread, resetThread, retailorReady, type CoachTurn } from '@/engine/coach';
import { log } from '@/lib/log';

export interface CoachState { turns: CoachTurn[]; error?: string }

export async function sendCoachMessage(message: string): Promise<CoachState> {
  try {
    return { turns: await coachReply(String(message ?? '').slice(0, 4000)) };
  } catch (err) {
    log.error('coach', 'reply failed', { error: (err as Error).message });
    return { turns: [], error: `The coach hit an error: ${(err as Error).message}` };
  }
}

/** Read-only: the current thread (after approving or dismissing a suggestion). */
export async function getCoachThread(): Promise<CoachTurn[]> {
  return loadThread();
}

export async function addFactAction(key: string, text?: string): Promise<{ ok: boolean; message: string }> {
  const r = approveFact(String(key), text === undefined ? undefined : String(text));
  revalidatePath('/coach');
  revalidatePath('/settings');
  return r;
}

export async function addAnswerAction(key: string): Promise<{ ok: boolean; message: string }> {
  const r = approveAnswer(String(key));
  revalidatePath('/coach');
  return r;
}

export async function dismissAction(key: string): Promise<{ ok: boolean; message: string }> {
  const r = dismissProposal(String(key));
  revalidatePath('/coach');
  return r;
}

export async function retailorAction(): Promise<{ ok: boolean; message: string }> {
  const n = retailorReady();
  revalidatePath('/coach');
  revalidatePath('/queue');
  revalidatePath('/');
  return { ok: true, message: n ? `${n} applications will be rebuilt with your updated facts over the next few minutes.` : 'Nothing in the queue to rebuild.' };
}

export async function resetCoachAction(): Promise<{ ok: boolean; message: string }> {
  resetThread();
  revalidatePath('/coach');
  return { ok: true, message: 'Conversation cleared. Your fact bank is unchanged.' };
}
