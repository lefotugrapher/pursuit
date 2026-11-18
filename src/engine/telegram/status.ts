// Connection status for the Settings card. Server-only. Never returns the token.

import crypto from 'node:crypto';
import { kvGet, kvSet } from '@/lib/db';
import { pendingQuestions } from '@/engine/questions';
import { asTelegramError, getMe, hasTelegram, telegramToken, tokenLooksValid } from './api';
import { outboxSize, sendBudget, type SendBudget } from './outbox';
import { activePairingCode, ignoredUpdates, pairedAt, pairingSource } from './pairing';

/** Written by telegramPass (bot.ts); kept literal here so the Settings page doesn't load the bot. */
const LAST_POLL_KEY = 'telegram.lastPoll';
const ME_KEY = 'telegram.me';
const ME_TTL_MS = 6 * 3_600_000;
const ME_ERROR_TTL_MS = 60_000;

interface CachedMe { fingerprint: string; at: string; username?: string; name?: string; error?: string }

export interface BotIdentity { username?: string; name?: string; error?: string }

const fingerprint = (token: string) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);

/** The bot's @username via getMe, cached in kv (6 h; failures for 1 min). */
export async function botIdentity(opts: { refresh?: boolean; now?: Date } = {}): Promise<BotIdentity> {
  const token = telegramToken();
  if (!token) return { error: 'TELEGRAM_BOT_TOKEN is not set' };
  if (!tokenLooksValid(token)) return { error: "TELEGRAM_BOT_TOKEN doesn't look like a bot token" };
  const now = opts.now ?? new Date();
  const fp = fingerprint(token);
  const cached = kvGet<CachedMe>(ME_KEY);
  if (!opts.refresh && cached?.fingerprint === fp) {
    const age = now.getTime() - Date.parse(cached.at);
    if (age >= 0 && age < (cached.error ? ME_ERROR_TTL_MS : ME_TTL_MS)) {
      return cached.error ? { error: cached.error } : { username: cached.username, name: cached.name };
    }
  }
  try {
    const me = await getMe({ timeoutMs: 4_000 });
    kvSet(ME_KEY, { fingerprint: fp, at: now.toISOString(), username: me.username, name: me.first_name } satisfies CachedMe);
    return { username: me.username, name: me.first_name };
  } catch (err) {
    const error = asTelegramError(err, 'getMe').message;
    kvSet(ME_KEY, { fingerprint: fp, at: now.toISOString(), error } satisfies CachedMe);
    return { error };
  }
}

export interface TelegramStatus {
  tokenSet: boolean;
  tokenValid: boolean;
  bot: BotIdentity;
  paired: boolean;
  pairedVia: 'env' | 'code' | null;
  pairedAt?: string;
  code: { createdAt: string; expiresAt: string } | null;
  lastPoll?: { at: string; ok: boolean; error?: string };
  questionsWaiting: number;
  outboxPending: number;
  budget: SendBudget;
  ignored: { count: number; lastAt?: string };
}

export async function telegramStatus(opts: { now?: Date } = {}): Promise<TelegramStatus> {
  const now = opts.now ?? new Date();
  const tokenSet = hasTelegram();
  const via = pairingSource();
  return {
    tokenSet,
    tokenValid: tokenLooksValid(),
    bot: tokenSet ? await botIdentity({ now }) : {},
    paired: via !== null,
    pairedVia: via,
    pairedAt: pairedAt(),
    code: activePairingCode(now),
    lastPoll: kvGet<TelegramStatus['lastPoll']>(LAST_POLL_KEY),
    questionsWaiting: pendingQuestions().length,
    outboxPending: outboxSize(),
    budget: sendBudget(now),
    ignored: ignoredUpdates(),
  };
}
