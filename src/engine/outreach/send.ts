// Sends messages Kayzee approved (status 'approved', channel 'email') over SMTP.
// Gates, in order: global pause, daily email cap, recipient must be verified (a contact address seen
// verbatim, or the sender of the inbound email being replied to; never a guessed address), no unfilled
// placeholders, CV PDF present when attachCv. Each message is claimed atomically before sending so two
// processes (worker + dashboard "run now") can never send it twice.

import fs from 'node:fs';
import path from 'node:path';
import type { SendMailOptions } from 'nodemailer';
import { loadProfile } from '@/lib/config';
import { db, getContact, getInbox, getSettings, latestArtifact, listContacts, listMessages, logEvent, sentToday, updateMessage } from '@/lib/db';
import { redactSecrets } from '@/lib/env';
import { log } from '@/lib/log';
import { ARTIFACTS_DIR, isInside } from '@/lib/paths';
import { nowIso } from '@/lib/time';
import type { Message } from '@/lib/types';
import { fromHeader, getTransport } from './smtp';
import { angleId, findPlaceholder, isNoReplyAddress, isSingleAddress, normalizeEmail } from './text';

export { setTransportForTests } from './smtp';

export interface SendSummary { sent: number; failed: number; skipped: number; reason?: string; /** saved to Gmail Drafts because SMTP was unreachable */ drafted?: number }

const SENDABLE_KINDS = new Set<Message['kind']>(['outreach', 'follow_up', 'reply', 'thank_you']);
const CV_FILENAME = 'Kshitiz_Mittal_CV.pdf';

type Check = { ok: true; to: string } | { ok: false; error: string };

/** Why `m` may (or may not) be sent to its `to` address. Pure apart from DB reads. */
export function verifyRecipient(m: Message): Check {
  const raw = m.to?.trim();
  if (!raw) return { ok: false, error: 'no recipient address' };
  if (!isSingleAddress(raw)) return { ok: false, error: `recipient "${raw}" is not a single valid address` };
  const to = normalizeEmail(raw)!;
  if (isNoReplyAddress(to)) return { ok: false, error: `${to} is a no-reply address` };

  if (m.inboxId !== undefined) {
    const inbound = getInbox(m.inboxId);
    if (inbound && normalizeEmail(inbound.fromAddress) === to) return { ok: true, to };
  }
  if (m.contactId !== undefined) {
    const c = getContact(m.contactId);
    if (c?.emailVerified && normalizeEmail(c.email) === to) return { ok: true, to };
  }
  const verified = listContacts({ hasEmail: true, limit: 5000 }).some((c) => c.emailVerified && normalizeEmail(c.email) === to);
  if (verified) return { ok: true, to };
  return { ok: false, error: `recipient ${to} is not verified (not seen on a JD/company page and not the sender being replied to)` };
}

function cvAttachment(jobId: string | undefined): { ok: true; att: { filename: string; path: string } } | { ok: false; error: string } {
  if (!jobId) return { ok: false, error: 'attachCv is set but the message has no job' };
  const art = latestArtifact(jobId, 'cv_pdf');
  const file = art?.path ? path.resolve(art.path) : undefined;
  if (!file || !isInside(ARTIFACTS_DIR, file) || !fs.existsSync(file)) return { ok: false, error: 'attachCv is set but no CV PDF exists for this job' };
  return { ok: true, att: { filename: CV_FILENAME, path: file } };
}

/** Atomically moves approved → sent (provisional) so only one process sends it. */
function claim(id: number): boolean {
  const res = db()
    .prepare("UPDATE messages SET status = 'sent', sent_at = ?, error = 'sending' WHERE id = ? AND status = 'approved'")
    .run(nowIso(), id);
  return Number(res.changes) === 1;
}

function fail(m: Message, error: string): void {
  updateMessage(m.id, { status: 'failed', error: error.slice(0, 1000) });
  const msg = `email ${m.id} not sent: ${error}`;
  if (m.jobId) log.forJob('warn', m.jobId, 'send', msg);
  else log.warn('send', msg);
}

function buildMail(m: Message, to: string, from: string): SendMailOptions {
  const mail: SendMailOptions = { from, to, subject: m.subject!.trim(), text: m.body };
  const parent = angleId(m.inReplyTo);
  if (parent) {
    mail.inReplyTo = parent;
    mail.references = [parent];
  }
  return mail;
}

/** Sends every approved email that passes the gates. Never sends anything unapproved. */
export async function sendApprovedEmails(opts: { limit?: number } = {}): Promise<SendSummary> {
  const approved = listMessages({ status: 'approved', channel: 'email', direction: 'out', limit: 500 }).reverse(); // oldest first
  const queue = approved.slice(0, opts.limit ?? approved.length);
  if (!queue.length) return { sent: 0, failed: 0, skipped: 0 };

  const settings = getSettings();
  if (settings.paused) return { sent: 0, failed: 0, skipped: queue.length, reason: 'paused' };
  const transport = getTransport();
  const from = fromHeader(safeProfileName());
  if (!transport || !from) return { sent: 0, failed: 0, skipped: queue.length, reason: 'mail not configured' };

  const summary: SendSummary = { sent: 0, failed: 0, skipped: 0 };
  for (const [i, m] of queue.entries()) {
    const live = getSettings(); // the pause switch and cap apply between messages too
    if (live.paused) return { ...summary, skipped: summary.skipped + queue.length - i, reason: 'paused' };
    if (sentToday('email') >= live.dailyEmailCap) {
      return { ...summary, skipped: summary.skipped + queue.length - i, reason: `daily email cap (${live.dailyEmailCap}) reached` };
    }

    if (!SENDABLE_KINDS.has(m.kind)) { fail(m, `kind "${m.kind}" is not sent from the approval queue`); summary.failed++; continue; }
    if (!m.subject?.trim()) { fail(m, 'subject is empty'); summary.failed++; continue; }
    if (!m.body.trim()) { fail(m, 'body is empty'); summary.failed++; continue; }
    const placeholder = findPlaceholder(`${m.subject}\n${m.body}`);
    if (placeholder) { fail(m, `draft still contains the placeholder ${placeholder}`); summary.failed++; continue; }
    const recipient = verifyRecipient(m);
    if (!recipient.ok) { fail(m, recipient.error); summary.failed++; continue; }

    const mail = buildMail(m, recipient.to, from);
    if (m.attachCv) {
      const cv = cvAttachment(m.jobId);
      if (!cv.ok) { fail(m, cv.error); summary.failed++; continue; }
      mail.attachments = [cv.att];
    }

    if (!claim(m.id)) { summary.skipped++; continue; } // another process took it, or it was edited meanwhile
    try {
      const info = await transport.sendMail(mail);
      if (info.draftOnly) {
        updateMessage(m.id, { status: 'in_gmail', error: 'Saved to Gmail Drafts: open Gmail and press Send.' });
        logEvent('email.in_gmail_drafts', { messageId: m.id, kind: m.kind, to: recipient.to, subject: m.subject }, m.jobId);
        summary.drafted = (summary.drafted ?? 0) + 1;
        continue;
      }
      updateMessage(m.id, { status: 'sent', messageId: info.messageId, error: undefined, sentAt: nowIso() });
      logEvent('email.sent', { messageId: m.id, kind: m.kind, to: recipient.to, subject: m.subject }, m.jobId);
      summary.sent++;
    } catch (err) {
      fail(m, `SMTP error: ${redactSecrets((err as Error).message ?? String(err))}`);
      summary.failed++;
    }
  }
  return summary;
}

function safeProfileName(): string | undefined {
  try {
    return loadProfile().name.full;
  } catch {
    return undefined;
  }
}
