// Minimal Telegram Bot API client over global fetch (no SDK). Server-only.
//
// The bot token is a secret. It only ever appears inside the request URL: every error this module
// throws is a TelegramApiError whose message has the token (and anything shaped like a bot token)
// removed, so callers may log errors freely. Nothing here logs on its own.
//
// Update offsets are kept in kv 'telegram.offset' (pollUpdates/confirmUpdate) so a restart, or a
// different worker process, carries on where the last one stopped.

import { kvGet, kvSet } from '@/lib/db';
import { env } from '@/lib/env';

export const TELEGRAM_API = 'https://api.telegram.org';
export const OFFSET_KEY = 'telegram.offset';
/** Telegram's limit for one text message. */
export const MAX_TEXT = 4096;
export const DEFAULT_POLL_TIMEOUT_SEC = 25;
const DEFAULT_TIMEOUT_MS = 15_000;

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,80}$/;
const TOKEN_LIKE_RE = /\d{5,15}:[A-Za-z0-9_-]{30,80}/g;

// ───────────────────────────── Environment ─────────────────────────────

function readEnv(key: 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'): string | undefined {
  // Touching any env getter makes env.ts load .env.local once; that fills every key missing from
  // process.env, TELEGRAM_* included. (Integrator: switch to env.TELEGRAM_* once env.ts has them.)
  void env.LLM_MODEL;
  const v = process.env[key]?.trim();
  return v ? v : undefined;
}

export function telegramToken(): string | undefined {
  return readEnv('TELEGRAM_BOT_TOKEN');
}

/** TELEGRAM_BOT_TOKEN is set (it may still be malformed: see tokenLooksValid). */
export function hasTelegram(): boolean {
  return Boolean(telegramToken());
}

export function tokenLooksValid(token: string | undefined = telegramToken()): boolean {
  return Boolean(token && TOKEN_RE.test(token));
}

/** TELEGRAM_CHAT_ID pins the bot to one private chat (a positive Telegram user id). */
export function envChatId(): number | undefined {
  const raw = readEnv('TELEGRAM_CHAT_ID');
  if (!raw || !/^\d{1,16}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Removes the bot token, its secret half, and anything token-shaped from `text`. */
export function redactToken(text: string, token: string | undefined = telegramToken()): string {
  let out = String(text ?? '');
  if (token) {
    out = out.split(token).join('[redacted]');
    const secret = token.slice(token.indexOf(':') + 1);
    if (secret.length >= 16) out = out.split(secret).join('[redacted]');
  }
  return out.replace(TOKEN_LIKE_RE, '[redacted]').replace(/\/bot[^/\s"'`]+/g, '/bot[redacted]');
}

// ───────────────────────────── Errors ─────────────────────────────

export type TelegramErrorKind = 'config' | 'network' | 'timeout' | 'aborted' | 'http' | 'api';

export class TelegramApiError extends Error {
  readonly kind: TelegramErrorKind;
  readonly method: string;
  /** HTTP status, when a response arrived. */
  readonly status?: number;
  /** Telegram's error_code (401 bad token, 403 blocked by the user, 409 another poller, 429 slow down). */
  readonly errorCode?: number;
  /** Seconds to wait (429). */
  readonly retryAfter?: number;

  constructor(kind: TelegramErrorKind, method: string, message: string, extra: { status?: number; errorCode?: number; retryAfter?: number } = {}) {
    super(redactToken(message));
    this.name = 'TelegramApiError';
    this.kind = kind;
    this.method = method;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.errorCode !== undefined) this.errorCode = extra.errorCode;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
  }
}

/** Any thrown value as a TelegramApiError with a token-free message. */
export function asTelegramError(err: unknown, method = 'request'): TelegramApiError {
  if (err instanceof TelegramApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TelegramApiError('network', method, message);
}

function describeNetworkError(err: unknown): string {
  const e = err as { message?: unknown; cause?: { code?: unknown } } | null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
  return code ? `${message} (${code})` : message;
}

// ───────────────────────────── Types (the parts Pursuit uses) ─────────────────────────────

export interface TgUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; username?: string; first_name?: string; title?: string }
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export interface InlineButton { text: string; callback_data: string }
export interface InlineKeyboard { inline_keyboard: InlineButton[][] }

interface Envelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

// ───────────────────────────── Transport ─────────────────────────────

export interface CallOptions { timeoutMs?: number; signal?: AbortSignal }

/** POSTs one Bot API method. Throws TelegramApiError (token-free) on any failure. */
export async function callTelegram<T>(method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
  const token = telegramToken();
  if (!token) throw new TelegramApiError('config', method, 'TELEGRAM_BOT_TOKEN is not set');
  if (!TOKEN_RE.test(token)) {
    throw new TelegramApiError('config', method, "TELEGRAM_BOT_TOKEN doesn't look like a bot token (expected the digits:letters value from @BotFather)");
  }
  if (!/^[A-Za-z]{1,64}$/.test(method)) throw new TelegramApiError('config', 'request', 'invalid Bot API method name');
  if (opts.signal?.aborted) throw new TelegramApiError('aborted', method, `Telegram ${method} aborted`);

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const failure = (err: unknown): TelegramApiError => {
    if (opts.signal?.aborted) return new TelegramApiError('aborted', method, `Telegram ${method} aborted`);
    if (timeout.aborted) return new TelegramApiError('timeout', method, `Telegram ${method} timed out`);
    return new TelegramApiError('network', method, `Telegram ${method} request failed: ${describeNetworkError(err)}`);
  };

  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
  } catch (err) {
    throw failure(err);
  }

  let body: Envelope<T> | null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch (err) {
    if (opts.signal?.aborted || timeout.aborted) throw failure(err);
    body = null;
  }
  if (!body || typeof body !== 'object') {
    throw new TelegramApiError('http', method, `Telegram ${method} returned HTTP ${res.status} without a JSON body`, { status: res.status });
  }
  if (!body.ok) {
    const description = typeof body.description === 'string' ? body.description.slice(0, 300) : `HTTP ${res.status}`;
    throw new TelegramApiError('api', method, `Telegram ${method} failed: ${description}`, {
      status: res.status,
      errorCode: typeof body.error_code === 'number' ? body.error_code : undefined,
      retryAfter: typeof body.parameters?.retry_after === 'number' ? body.parameters.retry_after : undefined,
    });
  }
  return body.result as T;
}

// ───────────────────────────── Methods ─────────────────────────────

export function getMe(opts: CallOptions = {}): Promise<TgUser> {
  return callTelegram<TgUser>('getMe', {}, { timeoutMs: 8_000, ...opts });
}

export interface GetUpdatesParams { offset?: number; timeout?: number; limit?: number; allowed_updates?: string[] }

/** Raw getUpdates. `timeout` (seconds) > 0 long-polls; the HTTP timeout is set past it. */
export function getUpdates(params: GetUpdatesParams = {}, opts: CallOptions = {}): Promise<TgUpdate[]> {
  const body: Record<string, unknown> = { timeout: Math.max(0, Math.trunc(params.timeout ?? 0)) };
  if (params.offset !== undefined) body.offset = params.offset;
  if (params.limit !== undefined) body.limit = params.limit;
  if (params.allowed_updates) body.allowed_updates = params.allowed_updates;
  return callTelegram<TgUpdate[]>('getUpdates', body, { timeoutMs: ((body.timeout as number) + 15) * 1000, ...opts });
}

export interface SendExtra {
  replyMarkup?: InlineKeyboard;
  replyToMessageId?: number;
  /** Deliver without a sound (quiet hours). */
  silent?: boolean;
}

/** Clips to Telegram's limit on a character boundary. */
export function clipText(text: string, max = MAX_TEXT): string {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** Plain-text message (no parse mode, so nothing needs escaping), links not previewed. */
export function sendMessage(chatId: number, text: string, extra: SendExtra = {}, opts: CallOptions = {}): Promise<TgMessage> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text: clipText(text),
    link_preview_options: { is_disabled: true },
  };
  if (extra.replyMarkup) params.reply_markup = extra.replyMarkup;
  if (extra.replyToMessageId !== undefined) params.reply_parameters = { message_id: extra.replyToMessageId, allow_sending_without_reply: true };
  if (extra.silent) params.disable_notification = true;
  return callTelegram<TgMessage>('sendMessage', params, opts);
}

/** Stops the button's loading spinner, optionally with a short toast. */
export function answerCallbackQuery(callbackQueryId: string, text?: string, opts: CallOptions = {}): Promise<boolean> {
  const params: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) params.text = clipText(text, 190);
  return callTelegram<boolean>('answerCallbackQuery', params, opts);
}

/** Replaces (or, with no markup, removes) a message's inline keyboard. */
export function editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: InlineKeyboard, opts: CallOptions = {}): Promise<unknown> {
  const params: Record<string, unknown> = { chat_id: chatId, message_id: messageId };
  params.reply_markup = replyMarkup ?? { inline_keyboard: [] };
  return callTelegram<unknown>('editMessageReplyMarkup', params, opts);
}

// ───────────────────────────── Offset tracking ─────────────────────────────

/** Next update_id to ask for (kv 'telegram.offset'); undefined before the first update. */
export function currentOffset(): number | undefined {
  const v = kvGet<unknown>(OFFSET_KEY);
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** Marks an update handled: the next poll starts after it, and Telegram forgets everything before it. */
export function confirmUpdate(updateId: number): void {
  if (!Number.isSafeInteger(updateId)) return;
  const next = updateId + 1;
  const current = currentOffset();
  if (current === undefined || next > current) kvSet(OFFSET_KEY, next);
}

/** Long-polls for new messages and button presses after the stored offset. */
export function pollUpdates(opts: { timeoutSec?: number; limit?: number; signal?: AbortSignal } = {}): Promise<TgUpdate[]> {
  const timeout = Math.max(0, Math.min(50, Math.trunc(opts.timeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC)));
  return getUpdates(
    { offset: currentOffset(), timeout, limit: Math.max(1, Math.min(100, opts.limit ?? 50)), allowed_updates: ['message', 'callback_query'] },
    { signal: opts.signal },
  );
}
