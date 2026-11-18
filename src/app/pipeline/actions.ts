'use server';

import { revalidatePath } from 'next/cache';
import { fail, ok, type ActionResult } from '@/components/settings/action-result';
import { addApplication, getJob, listApplications, setStatus, tx, updateJob } from '@/lib/db';
import { log } from '@/lib/log';
import { canTransition, formString, TRANSITION_LABEL } from '@/lib/server-more';
import { JOB_STATUSES, type JobStatus } from '@/lib/types';

function isJobStatus(v: string): v is JobStatus {
  return (JOB_STATUSES as string[]).includes(v);
}

/** Moves a job along the pipeline by hand. Only PIPELINE_TRANSITIONS moves are accepted. */
export async function moveJobAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = formString(fd, 'jobId');
  const to = formString(fd, 'to');
  if (!id || !isJobStatus(to)) return fail('Unknown job or status.');
  try {
    const job = getJob(id);
    if (!job) return fail('That job no longer exists.');
    if (!canTransition(job.status, to)) return fail(`Can't move from ${job.status} to ${to} by hand.`);

    tx(() => {
      if (to === 'applied') {
        // Kayzee confirms he submitted it himself (headed handoff or outside Pursuit).
        const submitted = listApplications({ jobId: id, status: 'submitted', limit: 1 });
        if (!submitted.length) {
          addApplication({ jobId: id, method: 'manual', status: 'submitted', confirmation: 'Marked applied by Kayzee in the dashboard' });
        }
      }
      if (job.status === 'needs_you' && to !== 'applied') updateJob(id, { needs: undefined });
      setStatus(id, to, { by: 'dashboard', via: 'pipeline' });
    });
    revalidatePath('/pipeline');
    revalidatePath('/');
    revalidatePath('/jobs');
    return ok(`${TRANSITION_LABEL[to] ?? to}: ${job.title}`);
  } catch (err) {
    log.error('dashboard', 'pipeline move failed', err);
    return fail(`Couldn't move the job: ${(err as Error).message}`);
  }
}
