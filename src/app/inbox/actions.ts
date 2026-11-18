'use server';

import { revalidatePath } from 'next/cache';
import { fail, ok, type ActionResult } from '@/components/settings/action-result';
import { getInbox, updateInbox } from '@/lib/db';
import { log } from '@/lib/log';
import { parseNumber } from '@/lib/server-more';

/** Toggles an inbox item's handled flag (`handled` = "1" marks handled, "0" reopens). */
export async function setHandledAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const id = parseNumber(fd.get('inboxId'));
    if (id === undefined || !getInbox(id)) return fail('That email no longer exists.');
    const handled = fd.get('handled') !== '0';
    updateInbox(id, { handled });
    revalidatePath('/inbox');
    revalidatePath('/');
    return ok(handled ? 'Marked handled.' : 'Reopened.');
  } catch (err) {
    log.error('dashboard', 'inbox handled toggle failed', err);
    return fail(`Couldn't update: ${(err as Error).message}`);
  }
}
