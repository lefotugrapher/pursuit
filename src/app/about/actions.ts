'use server';

import { revalidatePath } from 'next/cache';
import {
  approveIntake, checkAnswer, checkEvidence, dismissIntake, loadEvidence, loadIntake, removeEvidence, rescoreWithNewFacts, saveIntakeAnswer,
  type EvidenceDoc, type IntakeEntry, type Owner,
} from '@/engine/intake';
import { log } from '@/lib/log';

export interface AboutState { entries: Record<string, IntakeEntry>; docs: EvidenceDoc[]; message?: string; ok?: boolean }

const state = (extra: Partial<AboutState> = {}): AboutState => ({ entries: loadIntake(), docs: loadEvidence(), ...extra });

function owner(scope: string, id: string): Owner {
  return scope === 'doc' ? { scope: 'doc', id: String(id) } : { scope: 'answer', id: String(id) };
}

async function guarded(what: string, fn: () => Promise<Partial<AboutState>> | Partial<AboutState>): Promise<AboutState> {
  try {
    return state(await fn());
  } catch (err) {
    log.error('about', `${what} failed`, { error: (err as Error).message });
    return state({ ok: false, message: `That didn't work: ${(err as Error).message}` });
  }
}

export async function getAboutState(): Promise<AboutState> {
  return state();
}

export async function saveAnswerAction(questionId: string, answer: string, link?: string): Promise<AboutState> {
  return guarded('save', () => {
    saveIntakeAnswer(String(questionId), String(answer ?? ''), link === undefined ? undefined : String(link));
    return { ok: true, message: 'Saved.' };
  });
}

/** Saves the answer, then drafts suggested facts from it for him to approve. */
export async function findFactsAction(questionId: string, answer: string, link?: string): Promise<AboutState> {
  return guarded('find facts', async () => {
    saveIntakeAnswer(String(questionId), String(answer ?? ''), link === undefined ? undefined : String(link));
    const r = await checkAnswer(String(questionId));
    return { ok: r.ok, message: r.message };
  });
}

export async function findFactsInDocAction(id: string): Promise<AboutState> {
  return guarded('read document', async () => {
    const r = await checkEvidence(String(id));
    return { ok: r.ok, message: r.message };
  });
}

export async function approveAction(scope: string, id: string, key: string, text?: string): Promise<AboutState> {
  return guarded('approve', () => {
    const r = approveIntake(owner(scope, id), String(key), text === undefined ? undefined : String(text));
    revalidatePath('/about');
    revalidatePath('/coach');
    revalidatePath('/settings');
    return r;
  });
}

export async function dismissAction(scope: string, id: string, key: string): Promise<AboutState> {
  return guarded('dismiss', () => dismissIntake(owner(scope, id), String(key)));
}

export async function removeDocAction(id: string): Promise<AboutState> {
  return guarded('remove', () => removeEvidence(String(id)));
}

export async function rescoreAction(): Promise<AboutState> {
  return guarded('re-score', () => {
    const r = rescoreWithNewFacts();
    revalidatePath('/jobs');
    return { ok: true, message: `${r.rescored + r.reconsidered} jobs sent back to be judged with your new facts (${r.reconsidered} of them were turned down before).` };
  });
}
