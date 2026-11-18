// SMTP transport (Gmail, port 465 TLS, app password). Gmail files sent mail in Sent automatically.

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { env, hasMail } from '@/lib/env';

export interface SendResult { messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string; /** true = saved to Gmail Drafts, NOT sent */ draftOnly?: boolean }
export interface MailTransport { sendMail(mail: SendMailOptions): Promise<SendResult> }

let override: MailTransport | null = null;
let cached: { key: string; transport: MailTransport } | null = null;
let smtpDownUntil = 0;

const CONNECT_ERRORS = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ESOCKET', 'ECONNECTION', 'ECONNRESET']);
function isConnectError(err: unknown): boolean {
  return CONNECT_ERRORS.has((err as NodeJS.ErrnoException)?.code ?? '');
}

/** Appends the composed message to the Gmail Drafts folder over IMAP (port 993). Nothing is sent. */
async function saveToGmailDrafts(mail: SendMailOptions, user: string, pass: string): Promise<SendResult> {
  const raw = await new MailComposer(mail).compile().build();
  const client = new ImapFlow({ host: env.IMAP_HOST, port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    const drafts = boxes.find((b) => b.specialUse === '\\Drafts')?.path ?? '[Gmail]/Drafts';
    await client.append(drafts, raw, ['\\Draft']);
  } finally {
    await client.logout().catch(() => undefined);
  }
  return { response: 'saved to Gmail Drafts (SMTP unreachable; press Send in Gmail)', draftOnly: true };
}

/** Test hook: route every send through `t` (null restores SMTP). */
export function setTransportForTests(t: MailTransport | null): void {
  override = t;
}

/** The active transport, or null when Gmail isn't configured. */
export function getTransport(): MailTransport | null {
  if (override) return override;
  if (!hasMail()) return null;
  const user = env.GMAIL_USER ?? '';
  const pass = (env.GMAIL_APP_PASSWORD ?? '').replace(/\s+/g, '');
  const key = `${env.SMTP_HOST}|${user}|${pass.length}`;
  if (cached?.key === key) return cached.transport;
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  const transport: MailTransport = {
    async sendMail(mail) {
      // Some networks block outbound SMTP (465/587) but allow IMAP (993). Remember a connect failure for
      // 30 minutes and save to Gmail Drafts instead, so Kayzee can press Send himself.
      if (!(smtpDownUntil > Date.now())) {
        try {
          const info = await transporter.sendMail(mail);
          return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response };
        } catch (err) {
          if (!isConnectError(err)) throw err;
          smtpDownUntil = Date.now() + 30 * 60_000;
        }
      }
      return saveToGmailDrafts(mail, user, pass);
    },
  };
  cached = { key, transport };
  return transport;
}

/** '"Kshitiz Mittal" <user@gmail.com>' style From header. */
export function fromHeader(displayName: string | undefined): string | undefined {
  const user = env.GMAIL_USER;
  if (!user) return undefined;
  const name = (displayName ?? '').replace(/["\r\n<>]/g, '').trim();
  return name ? `"${name}" <${user}>` : user;
}
