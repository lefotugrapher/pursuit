'use server';
// Message + contact mutations shared by /outreach, /inbox and /interviews. Approving a message
// only marks it 'approved'; the worker's sender does the actual sending (and respects pause + caps).

import { revalidatePath } from 'next/cache';
import { fail, ok, type ActionResult } from '@/components/settings/action-result';
import { addMessage, getInbox, getJob, getMessage, updateMessage, upsertContact } from '@/lib/db';
import { log } from '@/lib/log';
import { LINKEDIN_NOTE_MAX, formString, isEmail, parseNumber, recipientCheckFor, safeHttpUrl, senderFirstName } from '@/lib/server-more';
import { loadProfile } from '@/lib/config';
import type { Message } from '@/lib/types';

const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;

function refresh(): void {
  revalidatePath('/outreach');
  revalidatePath('/inbox');
  revalidatePath('/interviews');
  revalidatePath('/');
}

function loadEditable(fd: FormData): { message?: Message; error?: string } {
  const id = parseNumber(fd.get('messageId'));
  if (id === undefined) return { error: 'Missing message id.' };
  const message = getMessage(id);
  if (!message) return { error: 'That draft no longer exists.' };
  if (message.direction !== 'out') return { error: 'Inbound messages are read-only.' };
  if (message.status !== 'draft' && message.status !== 'approved') return { error: `Already ${message.status}; it can't be changed.` };
  return { message };
}

/** Applies edited to/subject/body from the form. Returns the saved message or an error. */
function saveEdits(message: Message, fd: FormData): { message?: Message; error?: string } {
  const patch: Partial<Message> = {};
  if (fd.has('body')) {
    const body = formString(fd, 'body').replace(/\r\n/g, '\n');
    if (body.length > MAX_BODY) return { error: 'Message is too long.' };
    if (message.channel === 'linkedin' && body.length > LINKEDIN_NOTE_MAX) return { error: `LinkedIn notes must be ${LINKEDIN_NOTE_MAX} characters or fewer.` };
    patch.body = body;
  }
  if (fd.has('subject')) patch.subject = formString(fd, 'subject').trim().slice(0, MAX_SUBJECT) || undefined;
  if (fd.has('to') && message.channel === 'email') {
    const to = formString(fd, 'to').trim();
    if (to && !isEmail(to)) return { error: `"${to}" isn't a valid email address.` };
    patch.to = to || undefined;
  }
  const changed = Object.entries(patch).some(([k, v]) => message[k as keyof Message] !== v);
  // Editing an approved message pulls it back to draft so nothing changed goes out unreviewed.
  if (changed && message.status === 'approved') patch.status = 'draft';
  const saved = changed ? updateMessage(message.id, patch) : message;
  return saved ? { message: saved } : { error: 'Save failed.' };
}

export async function saveMessageAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const loaded = loadEditable(fd);
    if (!loaded.message) return fail(loaded.error ?? 'Not found.');
    const saved = saveEdits(loaded.message, fd);
    if (!saved.message) return fail(saved.error ?? 'Save failed.');
    refresh();
    return ok(loaded.message.status === 'approved' && saved.message.status === 'draft' ? 'Saved. Moved back to draft: approve again to send.' : 'Saved.');
  } catch (err) {
    log.error('dashboard', 'save message failed', err);
    return fail(`Couldn't save: ${(err as Error).message}`);
  }
}

/** Saves edits, then approves an email for the worker to send. Refuses unverified recipients. */
export async function approveMessageAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const loaded = loadEditable(fd);
    if (!loaded.message) return fail(loaded.error ?? 'Not found.');
    if (loaded.message.channel !== 'email') return fail('Only emails can be approved for sending. LinkedIn notes are sent by you.');
    const saved = saveEdits(loaded.message, fd);
    const message = saved.message;
    if (!message) return fail(saved.error ?? 'Save failed.');
    if (!message.body.trim()) return fail('The message is empty.');
    const recipient = recipientCheckFor(message);
    if (!recipient.verified) return fail(`Not approved: ${recipient.reason}`);
    updateMessage(message.id, { status: 'approved', error: undefined });
    const note = `approved ${message.kind} email to ${message.to}`;
    if (message.jobId) log.forJob('info', message.jobId, 'outreach', note, { messageId: message.id });
    else log.info('outreach', note, { messageId: message.id });
    refresh();
    return ok(`Approved. The worker sends it on its next pass (respects pause and the daily email cap).`);
  } catch (err) {
    log.error('dashboard', 'approve message failed', err);
    return fail(`Couldn't approve: ${(err as Error).message}`);
  }
}

/** Pulls an approved (not yet sent) email back to draft. */
export async function unapproveMessageAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const loaded = loadEditable(fd);
  if (!loaded.message) return fail(loaded.error ?? 'Not found.');
  if (loaded.message.status !== 'approved') return fail('Only approved messages can be pulled back.');
  updateMessage(loaded.message.id, { status: 'draft' });
  refresh();
  return ok('Back to draft.');
}

export async function discardMessageAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const loaded = loadEditable(fd);
  if (!loaded.message) return fail(loaded.error ?? 'Not found.');
  updateMessage(loaded.message.id, { status: 'discarded' });
  refresh();
  return ok('Discarded.');
}

/** Kayzee sent a LinkedIn note himself: record it as sent. */
export async function markLinkedInSentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const loaded = loadEditable(fd);
  if (!loaded.message) return fail(loaded.error ?? 'Not found.');
  if (loaded.message.channel !== 'linkedin') return fail('Not a LinkedIn note.');
  const saved = saveEdits(loaded.message, fd);
  if (!saved.message) return fail(saved.error ?? 'Save failed.');
  updateMessage(loaded.message.id, { status: 'sent' });
  refresh();
  return ok('Marked as sent.');
}

/** Starts a blank reply to an inbox email (to the sender, which counts as a verified address). */
export async function startReplyAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const inboxId = parseNumber(fd.get('inboxId'));
    const item = inboxId !== undefined ? getInbox(inboxId) : undefined;
    if (!item) return fail('That email no longer exists.');
    const profile = loadProfile();
    const name = senderFirstName(item.from);
    const subject = /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`;
    addMessage({
      jobId: item.jobId,
      inboxId: item.id,
      direction: 'out',
      channel: 'email',
      kind: 'reply',
      to: item.fromAddress,
      subject: subject.slice(0, MAX_SUBJECT),
      body: `${name ? `Hi ${name},` : 'Hi,'}\n\n\n\n${profile.coverLetter.signOff}\n${profile.name.full}`,
      status: 'draft',
      inReplyTo: item.messageId,
    });
    refresh();
    return ok('Reply started.');
  } catch (err) {
    log.error('dashboard', 'start reply failed', err);
    return fail(`Couldn't start a reply: ${(err as Error).message}`);
  }
}

/** Adds a contact by hand. Kayzee typing an address he has seen counts as verified only if he says so. */
export async function addContactAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const company = formString(fd, 'company').trim();
    if (!company) return fail('Company is required.');
    const email = formString(fd, 'email').trim();
    if (email && !isEmail(email)) return fail(`"${email}" isn't a valid email address.`);
    const linkedinRaw = formString(fd, 'linkedinUrl').trim();
    const linkedinUrl = linkedinRaw ? safeHttpUrl(linkedinRaw) : undefined;
    if (linkedinRaw && !linkedinUrl) return fail('LinkedIn URL must start with https://');
    const jobId = formString(fd, 'jobId').trim() || undefined;
    if (jobId && !getJob(jobId)) return fail('Unknown job id.');
    const name = formString(fd, 'name').trim() || undefined;
    if (!email && !name && !linkedinUrl) return fail('Add at least a name, email or LinkedIn URL.');
    upsertContact({
      jobId,
      company,
      name,
      role: formString(fd, 'role').trim() || undefined,
      email: email || undefined,
      emailVerified: Boolean(email) && fd.get('verified') === 'on',
      linkedinUrl,
      source: 'manual',
      confidence: 1,
    });
    refresh();
    return ok(`Added ${name ?? email ?? 'contact'} at ${company}.`);
  } catch (err) {
    log.error('dashboard', 'add contact failed', err);
    return fail(`Couldn't add contact: ${(err as Error).message}`);
  }
}

/** Single entry point for draft editors: the clicked button's `intent` picks the operation. */
export async function messageIntentAction(prev: ActionResult, fd: FormData): Promise<ActionResult> {
  switch (formString(fd, 'intent')) {
    case 'save': return saveMessageAction(prev, fd);
    case 'approve': return approveMessageAction(prev, fd);
    case 'unapprove': return unapproveMessageAction(prev, fd);
    case 'discard': return discardMessageAction(prev, fd);
    case 'linkedin_sent': return markLinkedInSentAction(prev, fd);
    default: return fail('Unknown action.');
  }
}
