// Reads new Gmail INBOX messages over IMAP (app password) and parses them into InboundEmail.
// Cursor: kv 'imap.lastUid' (+ 'imap.uidValidity'). First run looks back 14 days only.

import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { kvGet, kvSet } from '@/lib/db';
import { env, hasMail, redactSecrets } from '@/lib/env';
import { log } from '@/lib/log';
import type { InboundEmail } from '@/lib/types';
import { normalizeEmail } from '@/engine/outreach/text';

export const KV_LAST_UID = 'imap.lastUid';
export const KV_UID_VALIDITY = 'imap.uidValidity';
export const MAX_PER_RUN = 200;
const FIRST_RUN_LOOKBACK_DAYS = 14;
const MAX_TEXT_CHARS = 100_000;
const MAX_LINKS = 150;

let warnedNotConfigured = false;

// ───────────────────────────── Parsing (pure) ─────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+|#39);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Plain text from HTML (only used when the email has no text part). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

/** http(s) links with their visible text, deduplicated by href. */
export function extractLinks(html: string | undefined): { href: string; text: string }[] {
  if (!html) return [];
  const out: { href: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = htmlToText(m[4] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    out.push({ href: href.slice(0, 2000), text });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

function firstAddress(field: AddressObject | AddressObject[] | undefined): { header: string; address?: string } {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  for (const obj of list) {
    for (const v of obj.value ?? []) {
      if (v.address) {
        const address = normalizeEmail(v.address);
        const header = v.name ? `${v.name} <${v.address}>` : v.address;
        return { header, address };
      }
    }
  }
  return { header: list[0]?.text ?? '' };
}

function syntheticMessageId(parts: string[]): string {
  return `<pursuit-${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24)}@local>`;
}

/** mailparser output → InboundEmail. Undefined if it has no usable sender. */
export function parsedToInbound(parsed: ParsedMail, uid?: number): InboundEmail | undefined {
  const from = firstAddress(parsed.from);
  if (!from.address) return undefined;
  const to = firstAddress(parsed.to);
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  const text = (parsed.text?.trim() || (html ? htmlToText(html) : '')).slice(0, MAX_TEXT_CHARS);
  const date = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : new Date().toISOString();
  const subject = (parsed.subject ?? '').replace(/\s+/g, ' ').trim();
  const messageId = parsed.messageId?.trim() || syntheticMessageId([from.address, date, subject, String(uid ?? '')]);
  const email: InboundEmail = { messageId, from: from.header, fromAddress: from.address, subject, date, text };
  if (uid !== undefined) email.uid = uid;
  if (to.address) email.to = to.address;
  if (html) {
    email.html = html.slice(0, 400_000);
    const links = extractLinks(html);
    if (links.length) email.links = links;
  }
  return email;
}

export async function parseRawEmail(source: Buffer | string, uid?: number): Promise<InboundEmail | undefined> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  return parsedToInbound(parsed, uid);
}

// ───────────────────────────── IMAP ─────────────────────────────

function cleanError(err: unknown): string {
  const e = err as { message?: string; responseText?: string; authenticationFailed?: boolean };
  if (e?.authenticationFailed) return 'IMAP authentication failed (check GMAIL_USER / GMAIL_APP_PASSWORD)';
  return redactSecrets(e?.responseText || e?.message || String(err)).slice(0, 300);
}

/** UIDs to fetch this run, oldest first, capped. */
export function selectUids(found: number[], lastUid: number | undefined, max = MAX_PER_RUN): number[] {
  const sorted = [...new Set(found)].filter((u) => Number.isInteger(u) && u > 0).sort((a, b) => a - b);
  if (lastUid === undefined) return sorted.slice(-max); // first run: newest `max` of the lookback window
  return sorted.filter((u) => u > lastUid).slice(0, max); // later runs: continue in order, nothing skipped
}

/**
 * New INBOX messages since the stored cursor. Returns [] when mail isn't configured.
 * Throws on connection/auth failure so the worker run records it; the cursor only moves on success.
 */
export async function fetchNewEmails(opts: { max?: number } = {}): Promise<InboundEmail[]> {
  if (!hasMail()) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      log.info('inbox', 'Gmail not configured (GMAIL_USER / GMAIL_APP_PASSWORD); skipping inbox fetch');
    }
    return [];
  }
  const max = Math.max(1, Math.min(opts.max ?? MAX_PER_RUN, MAX_PER_RUN));
  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: env.GMAIL_USER ?? '', pass: (env.GMAIL_APP_PASSWORD ?? '').replace(/\s+/g, '') },
    logger: false,
    socketTimeout: 60_000,
  });
  client.on('error', () => undefined); // surfaced through the awaited calls below

  try {
    await client.connect();
  } catch (err) {
    throw new Error(`IMAP connect failed: ${cleanError(err)}`);
  }

  const emails: InboundEmail[] = [];
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error('INBOX did not open');
      const validity = String(mailbox.uidValidity);
      let lastUid = kvGet<number>(KV_LAST_UID);
      if (kvGet<string>(KV_UID_VALIDITY) !== validity) {
        if (lastUid !== undefined) log.warn('inbox', 'INBOX UIDVALIDITY changed; rescanning the last 14 days');
        lastUid = undefined;
      }

      // Always bounded by the look-back window: a cursor carried over from another mailbox (or a reset) must
      // never walk years of old mail (Nov 2026: it imported thousands of 2022 job alerts as if they were new).
      const since = new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000);
      const query = lastUid === undefined ? { since } : { uid: `${lastUid + 1}:*`, since };
      const found = (await client.search(query, { uid: true })) || [];
      const uids = selectUids(found, lastUid, max);

      if (uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          if (!msg.source) continue;
          try {
            const email = await parseRawEmail(msg.source, msg.uid);
            if (email) emails.push(email);
          } catch (err) {
            log.warn('inbox', `could not parse message uid ${msg.uid}`, { error: cleanError(err) });
          }
        }
      }

      const newCursor = uids.length ? uids[uids.length - 1] : lastUid ?? Math.max(0, mailbox.uidNext - 1);
      kvSet(KV_LAST_UID, newCursor);
      kvSet(KV_UID_VALIDITY, validity);
    } finally {
      lock.release();
    }
  } catch (err) {
    throw new Error(`IMAP fetch failed: ${cleanError(err)}`);
  } finally {
    await client.logout().catch(() => client.close());
  }

  emails.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
  return emails;
}
