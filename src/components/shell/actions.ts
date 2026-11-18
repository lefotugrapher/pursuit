'use server';
// Shell server actions: global pause switch and command-palette job search.

import { revalidatePath } from 'next/cache';
import { updateSettings } from '@/lib/db';
import { log } from '@/lib/log';
import { searchJobHits, type JobHit } from '@/lib/server';

export interface PauseResult { ok: boolean; paused: boolean; error?: string }

/** Flips settings.paused. Pausing takes effect immediately for every outbound task (SPEC §0.6). */
export async function setPaused(paused: boolean): Promise<PauseResult> {
  try {
    const next = updateSettings({ paused: paused === true });
    log.info('dashboard', next.paused ? 'paused all outbound actions' : 'resumed outbound actions');
    revalidatePath('/', 'layout');
    return { ok: true, paused: next.paused };
  } catch (err) {
    return { ok: false, paused: !paused, error: (err as Error).message };
  }
}

export async function searchJobs(query: string): Promise<JobHit[]> {
  if (typeof query !== 'string') return [];
  try {
    return searchJobHits(query, 8);
  } catch {
    return [];
  }
}
