// Pairing: the bot only ever talks to one private chat, Kayzee's. Server-only.
//
// The dashboard shows a 6-digit code (stored only as a salted SHA-256 hash in kv 'telegram.pairCode',
// valid 15 minutes); he sends `/pair 123456` to the bot and that chat id is stored in kv
// 'telegram.chatId'. TELEGRAM_CHAT_ID in .env.local pins the chat instead (no code needed).
// Wrong guesses are capped per chat and per code. Updates from any other chat are dropped and only
// counted (kv 'telegram.ignored'): no ids, names or text are kept.

import crypto from 'node:crypto';
import { kvDelete, kvGet, kvSet, logEvent, tx } from '@/lib/db';
import { envChatId } from './api';

export const CHAT_ID_KEY = 'telegram.chatId';
export const PAIRED_AT_KEY = 'telegram.pairedAt';
export const PAIR_CODE_KEY = 'telegram.pairCode';
export const IGNORED_KEY = 'telegram.ignored';
export const PAIR_CODE_TTL_MS = 15 * 60_000;
/** Wrong codes accepted before the code is thrown away (Kayzee then generates a new one). */
export const MAX_FAILURES_PER_CODE = 10;
/** Wrong codes one chat may send before it is ignored for the rest of this code's life. */
export const MAX_FAILURES_PER_CHAT = 3;

interface StoredPairCode {
  hash: string;
  salt: string;
  createdAt: string;
  expiresAt: string;
  failures: number;
  /** sha256(salt:chatId) prefix → wrong attempts (no raw chat ids stored). */
  byChat: Record<string, number>;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const hashCode = (salt: string, code: string) => sha256(`${salt}:${code}`);
const chatTag = (salt: string, chatId: number) => sha256(`${salt}:chat:${chatId}`).slice(0, 16);

function readCode(): StoredPairCode | undefined {
  const v = kvGet<StoredPairCode>(PAIR_CODE_KEY);
  if (!v || typeof v.hash !== 'string' || typeof v.salt !== 'string' || typeof v.expiresAt !== 'string') return undefined;
  return { ...v, failures: Number(v.failures) || 0, byChat: v.byChat && typeof v.byChat === 'object' ? v.byChat : {} };
}

function storedChatId(): number | undefined {
  const v = kvGet<unknown>(CHAT_ID_KEY);
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/** New pairing code (replaces any previous one). The plaintext code is returned once and never stored. */
export function createPairingCode(now: Date = new Date()): { code: string; expiresAt: string; createdAt: string } {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString();
  const stored: StoredPairCode = { hash: hashCode(salt, code), salt, createdAt, expiresAt, failures: 0, byChat: {} };
  kvSet(PAIR_CODE_KEY, stored);
  logEvent('telegram.pair_code', { expiresAt });
  return { code, expiresAt, createdAt };
}

/** Whether a code is waiting to be used (never reveals it). */
export function activePairingCode(now: Date = new Date()): { createdAt: string; expiresAt: string } | null {
  const stored = readCode();
  if (!stored || Date.parse(stored.expiresAt) <= now.getTime() || stored.failures >= MAX_FAILURES_PER_CODE) return null;
  return { createdAt: stored.createdAt, expiresAt: stored.expiresAt };
}

export function cancelPairingCode(): void {
  kvDelete(PAIR_CODE_KEY);
}

export type PairResult = 'paired' | 'no_code' | 'expired' | 'wrong' | 'locked' | 'pinned';

/**
 * Checks `/pair <code>` from `chatId`. On a match the chat becomes the paired chat and the code is
 * used up. `pinned` = TELEGRAM_CHAT_ID decides the chat, so codes are refused.
 */
export function verifyPairingCode(code: string, chatId: number, now: Date = new Date()): { result: PairResult; previousChatId?: number } {
  if (envChatId() !== undefined) return { result: 'pinned' };
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return { result: 'wrong' };
  return tx(() => {
    const stored = readCode();
    if (!stored) return { result: 'no_code' as const };
    if (Date.parse(stored.expiresAt) <= now.getTime()) {
      kvDelete(PAIR_CODE_KEY);
      return { result: 'expired' as const };
    }
    const tag = chatTag(stored.salt, chatId);
    if (stored.failures >= MAX_FAILURES_PER_CODE || (stored.byChat[tag] ?? 0) >= MAX_FAILURES_PER_CHAT) return { result: 'locked' as const };

    const clean = String(code ?? '').trim();
    const candidate = /^\d{6}$/.test(clean) ? hashCode(stored.salt, clean) : '';
    const ok = candidate.length === stored.hash.length
      && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(stored.hash, 'hex'));
    if (!ok) {
      stored.failures += 1;
      stored.byChat[tag] = (stored.byChat[tag] ?? 0) + 1;
      if (stored.failures >= MAX_FAILURES_PER_CODE) {
        kvDelete(PAIR_CODE_KEY);
        logEvent('telegram.pair_code_burned', { failures: stored.failures });
      } else {
        kvSet(PAIR_CODE_KEY, stored);
      }
      return { result: 'wrong' as const };
    }

    const previous = storedChatId();
    kvSet(CHAT_ID_KEY, chatId);
    kvSet(PAIRED_AT_KEY, now.toISOString());
    kvDelete(PAIR_CODE_KEY);
    logEvent('telegram.paired', { replacedAnotherChat: previous !== undefined && previous !== chatId });
    return previous !== undefined && previous !== chatId ? { result: 'paired' as const, previousChatId: previous } : { result: 'paired' as const };
  });
}

/** The one chat the bot talks to: TELEGRAM_CHAT_ID, else the chat that paired with a code. */
export function pairedChatId(): number | undefined {
  return envChatId() ?? storedChatId();
}

export function pairingSource(): 'env' | 'code' | null {
  if (envChatId() !== undefined) return 'env';
  return storedChatId() !== undefined ? 'code' : null;
}

export function pairedAt(): string | undefined {
  const v = kvGet<unknown>(PAIRED_AT_KEY);
  return typeof v === 'string' ? v : undefined;
}

export function isPairedChat(chatId: number | undefined): boolean {
  const paired = pairedChatId();
  return paired !== undefined && chatId === paired;
}

/** Forgets the code-paired chat (TELEGRAM_CHAT_ID can only be removed from .env.local). */
export function unpairTelegram(): boolean {
  const had = storedChatId() !== undefined;
  kvDelete(CHAT_ID_KEY);
  kvDelete(PAIRED_AT_KEY);
  kvDelete(PAIR_CODE_KEY);
  if (had) logEvent('telegram.unpaired', {});
  return had;
}

/** Counts an update from a chat that isn't Kayzee's. Nothing about the sender is stored. */
export function recordIgnoredUpdate(now: Date = new Date()): void {
  try {
    tx(() => {
      const current = kvGet<{ count?: number }>(IGNORED_KEY);
      kvSet(IGNORED_KEY, { count: (Number(current?.count) || 0) + 1, lastAt: now.toISOString() });
    });
  } catch {
    // a counter must never break the bot
  }
}

export function ignoredUpdates(): { count: number; lastAt?: string } {
  const v = kvGet<{ count?: number; lastAt?: string }>(IGNORED_KEY);
  return { count: Number(v?.count) || 0, ...(typeof v?.lastAt === 'string' ? { lastAt: v.lastAt } : {}) };
}
