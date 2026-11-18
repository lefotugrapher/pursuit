'use server';

import { revalidatePath } from 'next/cache';
import { fail, ok, type ActionResult } from '@/components/settings/action-result';
import { buildPrepPack } from '@/engine/prep';
import { loadFacts, loadProfile } from '@/lib/config';
import { addArtifact, addMessage, getJob, listMessages } from '@/lib/db';
import { log } from '@/lib/log';
import { formString, interviewerAddress, thankYouTemplate } from '@/lib/server-more';

/** Rebuilds the interview prep pack for a job and stores it as a new 'prep' artifact version. */
export async function regeneratePrepAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const job = getJob(formString(fd, 'jobId'));
  if (!job) return fail('That job no longer exists.');
  try {
    const markdown = await buildPrepPack(job, loadFacts(), loadProfile());
    if (!markdown?.trim()) return fail('The prep builder returned nothing. Try again in a minute.');
    addArtifact({ jobId: job.id, kind: 'prep', content: markdown, meta: { source: 'dashboard' } });
    log.forJob('info', job.id, 'interviews', 'prep pack regenerated');
    revalidatePath('/interviews');
    revalidatePath(`/jobs/${job.id}`);
    return ok('Prep pack updated.');
  } catch (err) {
    log.forJob('error', job.id, 'interviews', 'prep pack failed', err);
    return fail(`Couldn't build the prep pack: ${(err as Error).message}`);
  }
}

/**
 * Drafts a short thank-you email (template; it makes no claims, so nothing to fact-check) to the
 * person who emailed about the interview. Always a draft: Kayzee approves it in Outreach.
 */
export async function draftThankYouAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const job = getJob(formString(fd, 'jobId'));
  if (!job) return fail('That job no longer exists.');
  try {
    const existing = listMessages({ jobId: job.id, kind: 'thank_you', status: ['draft', 'approved'], limit: 1 });
    if (existing.length) return fail('A thank-you draft already exists for this job. Edit it below.');
    const { address, name } = interviewerAddress(job.id);
    const { subject, body } = thankYouTemplate({ job, firstName: name, profile: loadProfile() });
    addMessage({ jobId: job.id, direction: 'out', channel: 'email', kind: 'thank_you', to: address, subject, body, status: 'draft' });
    revalidatePath('/interviews');
    revalidatePath('/outreach');
    return ok(address ? `Drafted to ${address}. Review and approve it below.` : 'Drafted. Add the interviewer\'s email before approving.');
  } catch (err) {
    log.forJob('error', job.id, 'interviews', 'thank-you draft failed', err);
    return fail(`Couldn't draft the note: ${(err as Error).message}`);
  }
}
