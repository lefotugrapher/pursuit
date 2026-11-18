// Outbound side of the bot: the hourly rate limit, quiet-hours delivery, and the notification
// outbox that batches updates into one message. Server-only.
//
// Limits (all messages, rolling hour): at most HOURLY_LIMIT messages to Kayzee. Proactive messages
// (questions, notifications, approvals, the daily summary) may use PROACTIVE_LIMIT of them, so a
// reply to a command he just sent always has room. During quiet hours messages arrive silently.
//
// notifyTelegram() only queues (kv 'telegram.outbox'); telegramPass() flushes the queue as one
// batched message at most every BATCH_INTERVAL_MS, or straight away when an item is high priority.

import crypto from 'node:crypto';
import { getSettings, kvGet, kvSet, logEvent, tx } from '@/lib/db';
import { isQuietHours } from '@/lib/time';
import { asTelegramError, hasTelegram, sendMessage, type CallOptions, type InlineKeyboard, type TgMessage } from './api';
import { pairedChatId } from './pairing';

export const HOURLY_LIMIT = 20;
export const PROACTIVE_LIMIT = 16;
export const BATCH_INTERVAL_MS = 10 * 60_000;
export const SEND_LOG_KEY = 'telegram.sendLog';
export const OUTBOX_KEY = 'telegram.outbox';
export const BACKOFF_KEY = 'telegram.backoffUntil';
const RATE_LIMITED_KEY = 'telegram.rateLimited';
const HOUR_MS = 3_600_000;
const OUTBOX_MAX = 60;
const BATCH_MAX_CHARS = 3500;
const ITEM_MAX_CHARS = 700;

export type SendKind = 'reply' | 'proactive';

// ───────────────────────────── Rate limit ─────────────────────────────

function readLog(nowMs: number): number[] {
  const v = kvGet<unknown>(SEND_LOG_KEY);
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > nowMs - HOUR_MS && t <= nowMs + 60_000);
}

export interface SendBudget { sentLastHour: number; limit: number; remaining: number; remainingProactive: number }

export function sendBudget(now: Date = new Date()): SendBudget {
  const sent = readLog(now.getTime()).length;
  return {
    sentLastHour: sent,
    limit: HOURLY_LIMIT,
    remaining: Math.max(0, HOURLY_LIMIT - sent),
    remainingProactive: Math.max(0, PROACTIVE_LIMIT - sent),
  };
}

/** Claims one send slot (atomically). Returns the slot's timestamp, or null when over the limit. */
function reserveSlot(kind: SendKind, now: Date): number | null {
  return tx(() => {
    const nowMs = now.getTime();
    const log = readLog(nowMs);
    const cap = kind === 'reply' ? HOURLY_LIMIT : PROACTIVE_LIMIT;
    if (log.length >= cap) return null;
    // Unique per slot so a failed send releases exactly its own entry.
    let slot = nowMs;
    while (log.includes(slot)) slot += 1;
    log.push(slot);
    kvSet(SEND_LOG_KEY, log);
    return slot;
  });
}

function releaseSlot(slot: number): void {
  try {
    tx(() => {
      const v = kvGet<unknown>(SEND_LOG_KEY);
      if (!Array.isArray(v)) return;
      const i = v.indexOf(slot);
      if (i >= 0) {
        v.splice(i, 1);
        kvSet(SEND_LOG_KEY, v);
      }
    });
  } catch {
    // worst case the slot ages out within the hour
  }
}

function countRateLimited(now: Date): void {
  try {
    tx(() => {
      const v = kvGet<{ count?: number }>(RATE_LIMITED_KEY);
      kvSet(RATE_LIMITED_KEY, { count: (Number(v?.count) || 0) + 1, lastAt: now.toISOString() });
    });
  } catch {
    // counter only
  }
}

// ───────────────────────────── Backoff (Telegram 429 / repeated failures) ─────────────────────────────

export function backoffUntil(now: Date = new Date()): string | undefined {
  const v = kvGet<unknown>(BACKOFF_KEY);
  return typeof v === 'string' && Date.parse(v) > now.getTime() ? v : undefined;
}

export function setBackoff(now: Date, seconds: number): void {
  const ms = Math.max(1, Math.min(3600, Math.ceil(seconds))) * 1000;
  kvSet(BACKOFF_KEY, new Date(now.getTime() + ms).toISOString());
}

export function quietNow(now: Date): boolean {
  try {
    return isQuietHours(getSettings(), now);
  } catch {
    return false;
  }
}

// ───────────────────────────── Delivery ─────────────────────────────

export type DeliverResult =
  | { ok: true; message: TgMessage }
  | { ok: false; reason: 'not_configured' | 'not_paired' | 'rate_limited' | 'backoff' | 'error'; error?: string; errorCode?: number };

export interface DeliverOptions extends CallOptions {
  kind: SendKind;
  /** Defaults to the paired chat. Only the pairing reply ever passes another chat. */
  chatId?: number;
  replyMarkup?: InlineKeyboard;
  replyToMessageId?: number;
  /** Default: proactive messages are silent during quiet hours. */
  silent?: boolean;
  now?: Date;
}

/** Sends one message to Kayzee within the rate limit. Never throws. */
export async function deliver(text: string, opts: DeliverOptions): Promise<DeliverResult> {
  try {
    if (!hasTelegram()) return { ok: false, reason: 'not_configured' };
    const chatId = opts.chatId ?? pairedChatId();
    if (chatId === undefined) return { ok: false, reason: 'not_paired' };
    const now = opts.now ?? new Date();
    if (backoffUntil(now)) return { ok: false, reason: 'backoff' };
    const slot = reserveSlot(opts.kind, now);
    if (slot === null) {
      countRateLimited(now);
      return { ok: false, reason: 'rate_limited' };
    }
    const silent = opts.silent ?? (opts.kind === 'proactive' && quietNow(now));
    try {
      const message = await sendMessage(
        chatId, text,
        { replyMarkup: opts.replyMarkup, replyToMessageId: opts.replyToMessageId, silent },
        { signal: opts.signal, timeoutMs: opts.timeoutMs },
      );
      return { ok: true, message };
    } catch (err) {
      releaseSlot(slot);
      const e = asTelegramError(err, 'sendMessage');
      if (e.errorCode === 429 && e.retryAfter) setBackoff(now, e.retryAfter);
      return { ok: false, reason: 'error', error: e.message, ...(e.errorCode !== undefined ? { errorCode: e.errorCode } : {}) };
    }
  } catch (err) {
    return { ok: false, reason: 'error', error: asTelegramError(err, 'sendMessage').message };
  }
}

// ───────────────────────────── Notification outbox ─────────────────────────────

interface OutboxItem { id: string; text: string; at: string; high: boolean }
interface Outbox { items: OutboxItem[]; dropped: number; lastFlushAt?: string }

function readOutbox(): Outbox {
  const v = kvGet<Partial<Outbox>>(OUTBOX_KEY);
  const items = Array.isArray(v?.items)
    ? v.items.filter((i): i is OutboxItem => Boolean(i) && typeof i.text === 'string' && typeof i.id === 'string')
    : [];
  return { items, dropped: Number(v?.dropped) || 0, ...(typeof v?.lastFlushAt === 'string' ? { lastFlushAt: v.lastFlushAt } : {}) };
}

function cleanItem(text: string): string {
  const flat = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return flat.length > ITEM_MAX_CHARS ? `${flat.slice(0, ITEM_MAX_CHARS - 1)}…` : flat;
}

/** Adds an update to the outbox (batched by the bot). Returns false for empty text. */
export function queueNotification(text: string, opts: { high?: boolean; now?: Date } = {}): boolean {
  const clean = cleanItem(text);
  if (!clean) return false;
  const now = opts.now ?? new Date();
  tx(() => {
    const box = readOutbox();
    box.items.push({ id: crypto.randomBytes(6).toString('hex'), text: clean, at: now.toISOString(), high: Boolean(opts.high) });
    if (box.items.length > OUTBOX_MAX) {
      const extra = box.items.length - OUTBOX_MAX;
      box.items.splice(0, extra);
      box.dropped += extra;
    }
    kvSet(OUTBOX_KEY, box);
  });
  return true;
}

export function outboxSize(): number {
  return readOutbox().items.length;
}

/** One message for a batch of updates; `used` = how many items it includes (oldest first). */
export function composeBatch(items: { text: string }[], dropped = 0, maxChars = BATCH_MAX_CHARS): { text: string; used: number } {
  if (!items.length) return { text: '', used: 0 };
  if (items.length === 1 && !dropped) return { text: items[0].text, used: 1 };
  const footer = dropped ? `\n\n(${dropped} older update${dropped === 1 ? ' was' : 's were'} dropped: see the dashboard.)` : '';
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    const line = `• ${item.text}`;
    if (parts.length && length + line.length + 2 > maxChars - footer.length - 60) break;
    parts.push(line);
    length += line.length + 2;
  }
  const rest = items.length - parts.length;
  const header = `Pursuit: ${items.length} update${items.length === 1 ? '' : 's'}`;
  const more = rest ? `\n\n(${rest} more in the next message.)` : '';
  return { text: `${header}\n\n${parts.join('\n\n')}${more}${footer}`, used: parts.length };
}

export interface FlushResult { sent: number; pending: number; reason?: string }

/**
 * Sends queued updates as one batched message when due: an item is high priority, or the last
 * batch went out at least BATCH_INTERVAL_MS ago. `highOnly` flushes only when a high item waits.
 */
export async function flushOutbox(opts: { now?: Date; force?: boolean; highOnly?: boolean; signal?: AbortSignal } = {}): Promise<FlushResult> {
  const now = opts.now ?? new Date();
  const box = readOutbox();
  if (!box.items.length) return { sent: 0, pending: 0 };
  const high = box.items.some((i) => i.high);
  const last = box.lastFlushAt ? Date.parse(box.lastFlushAt) : Number.NaN;
  const intervalDue = !Number.isFinite(last) || now.getTime() - last >= BATCH_INTERVAL_MS;
  if (opts.highOnly && !high && !opts.force) return { sent: 0, pending: box.items.length, reason: 'no high-priority updates' };
  if (!opts.force && !high && !intervalDue) return { sent: 0, pending: box.items.length, reason: 'batching' };

  const { text, used } = composeBatch(box.items, box.dropped);
  const sentIds = new Set(box.items.slice(0, used).map((i) => i.id));
  const res = await deliver(text, { kind: 'proactive', now, signal: opts.signal });
  if (!res.ok) return { sent: 0, pending: box.items.length, reason: res.reason };

  let pending = 0;
  tx(() => {
    const current = readOutbox(); // items may have arrived while sending
    current.items = current.items.filter((i) => !sentIds.has(i.id));
    current.dropped = 0;
    current.lastFlushAt = now.toISOString();
    pending = current.items.length;
    kvSet(OUTBOX_KEY, current);
  });
  logEvent('telegram.notified', { items: used, pending });
  return { sent: used, pending };
}

export type NotifyPriorityLike = 'min' | 'low' | 'default' | 'high' | 'urgent';

/**
 * Queues an update for Kayzee's Telegram (sent batched by the worker's Telegram pass). Synchronous,
 * never throws, and a no-op when the bot isn't set up or paired, so notify() can call it freely.
 */
export function notifyTelegram(text: string, opts: { priority?: NotifyPriorityLike; high?: boolean; now?: Date } = {}): { queued: boolean; reason?: string } {
  try {
    if (!hasTelegram()) return { queued: false, reason: 'not_configured' };
    if (pairedChatId() === undefined) return { queued: false, reason: 'not_paired' };
    const high = opts.high ?? (opts.priority === 'high' || opts.priority === 'urgent');
    return queueNotification(text, { high, now: opts.now }) ? { queued: true } : { queued: false, reason: 'empty' };
  } catch {
    return { queued: false, reason: 'error' };
  }
}
