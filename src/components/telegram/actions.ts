'use server';
// Server actions for the Telegram card: pairing code, test message, disconnect. The token never
// reaches the browser; errors are token-free (engine/telegram/api.ts redacts them).

import { revalidatePath } from 'next/cache';
import { hasTelegram, tokenLooksValid } from '@/engine/telegram/api';
import { deliver } from '@/engine/telegram/outbox';
import { createPairingCode, pairingSource, unpairTelegram } from '@/engine/telegram/pairing';
import { botIdentity } from '@/engine/telegram/status';
import { log } from '@/lib/log';
import type { TelegramActionState } from './state';

const done = (ok: boolean, message: string, extra: Partial<NonNullable<TelegramActionState>> = {}): TelegramActionState => ({ ok, message, at: Date.now(), ...extra });

export async function generatePairingCodeAction(_prev: TelegramActionState, _fd: FormData): Promise<TelegramActionState> {
  try {
    if (!hasTelegram()) return done(false, 'Add TELEGRAM_BOT_TOKEN to .env.local and restart Pursuit first.');
    if (!tokenLooksValid()) return done(false, "TELEGRAM_BOT_TOKEN doesn't look like a bot token from @BotFather.");
    if (pairingSource() === 'env') return done(false, 'TELEGRAM_CHAT_ID in .env.local already decides the chat. Remove it to pair with a code.');
    const bot = await botIdentity();
    const { code, createdAt, expiresAt } = createPairingCode();
    log.info('telegram', 'pairing code generated from the dashboard');
    revalidatePath('/settings');
    return done(true, 'Pairing code ready.', { code, createdAt, expiresAt, botUsername: bot.username });
  } catch (err) {
    return done(false, `Couldn't create a code: ${(err as Error).message}`);
  }
}

export async function sendTestMessageAction(_prev: TelegramActionState, _fd: FormData): Promise<TelegramActionState> {
  const res = await deliver('Pursuit test message: Telegram is connected. Questions and updates will arrive here.', { kind: 'reply' });
  if (res.ok) return done(true, 'Sent. Check Telegram.');
  const why: Record<string, string> = {
    not_configured: 'TELEGRAM_BOT_TOKEN is not set.',
    not_paired: 'Not paired yet: generate a code and send /pair CODE to the bot.',
    rate_limited: 'Hourly message limit reached. Try again later.',
    backoff: 'Telegram asked Pursuit to slow down. Try again in a minute.',
  };
  return done(false, why[res.reason] ?? `Telegram said: ${res.error ?? res.reason}`);
}

export async function disconnectTelegramAction(_prev: TelegramActionState, _fd: FormData): Promise<TelegramActionState> {
  if (pairingSource() === 'env') return done(false, 'Paired by TELEGRAM_CHAT_ID: remove it from .env.local to disconnect.');
  const removed = unpairTelegram();
  revalidatePath('/settings');
  return done(true, removed ? 'Disconnected. The bot ignores every chat until you pair again.' : 'Nothing was paired.');
}
