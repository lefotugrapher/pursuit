// The Telegram bot: one worker pass polls updates, handles Kayzee's commands, replies and button
// presses, then sends pending questions and batched updates. Server-only.
//
// Only the paired chat is ever answered (pairing.ts). Updates from anyone else are dropped and
// counted; the one exception is a correct `/pair <code>` while a dashboard code is active.
// Message texts are never logged. Every outbound message goes through deliver() (rate limit).

import crypto from 'node:crypto';
import { getJob, getMessage, getSettings, kvGet, kvSet, logEvent, tx, updateMessage, updateSettings } from '@/lib/db';
import { log } from '@/lib/log';
import { dublinDate } from '@/lib/time';
import type { ApplyOutcome, Message } from '@/lib/types';
import { findPlaceholder } from '@/engine/outreach/text';
import { verifyRecipient } from '@/engine/outreach/send';
import {
  answerQuestion, dismissQuestion, getQuestion, markQuestionSent, optionList, pendingQuestions, pruneQuestions, questionsToSend,
  resendOpenQuestions, SENSITIVE_LABELS, type AnswerOutcome, type PendingQuestion,
} from '@/engine/questions';
import {
  answerCallbackQuery, asTelegramError, confirmUpdate, editMessageReplyMarkup, hasTelegram, pollUpdates, tokenLooksValid,
  type InlineButton, type InlineKeyboard, type TgCallbackQuery, type TgMessage, type TgUpdate,
} from './api';
import { backoffUntil, deliver, flushOutbox, notifyTelegram, quietNow, setBackoff, type DeliverResult } from './outbox';
import { applyDigestReply, assistantReply, autoAnswerOpen, composeDigest, currentDigest, digestDue, recordDigest } from './assistant';
import { activePairingCode, isPairedChat, pairedChatId, recordIgnoredUpdate, verifyPairingCode } from './pairing';
import { buildDailySummary, buildStatusText, buildTodayText } from './summary';

export { notifyTelegram } from './outbox';
export { buildDailySummary, buildStatusText, buildTodayText } from './summary';

export const QUESTION_MESSAGES_KEY = 'telegram.questionMessages';
export const EMAIL_APPROVALS_KEY = 'telegram.emailApprovals';
export const LAST_POLL_KEY = 'telegram.lastPoll';
export const SUMMARY_KEY = 'telegram.summary.lastDate';
const FAILURES_KEY = 'telegram.pollFailures';
/** Default length of one worker pass (several long polls). */
export const DEFAULT_PASS_MS = 100_000;
const MAX_QUESTIONS_PER_ROUND = 3;
const MAX_BUTTONS = 10;
const MAP_MAX = 400;

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function jobName(jobId: string): string {
  const job = getJob(jobId);
  return job ? `${job.company}: ${job.title}` : 'an application';
}

// ───────────────────────────── Pass ─────────────────────────────

export interface TelegramPassOptions {
  signal?: AbortSignal;
  /** How long to keep long-polling in this run (default 100 s; 0 = one quick check). */
  maxMs?: number;
  /** getUpdates long-poll timeout in seconds (default 25). */
  pollTimeoutSec?: number;
  /** Pause between consecutive outgoing messages (default 1100 ms: Telegram's per-chat pace). */
  sendGapMs?: number;
  now?: () => Date;
}

export interface TelegramPassStats {
  configured: boolean;
  paired: boolean;
  polls: number;
  updates: number;
  ignored: number;
  commands: number;
  answers: number;
  questionsSent: number;
  notificationsSent: number;
  errors: string[];
  stopped?: 'not_configured' | 'bad_token' | 'backoff' | 'aborted' | 'conflict' | 'unauthorized' | 'error';
}

interface Ctx { now: () => Date; signal?: AbortSignal; gapMs: number; stats: TelegramPassStats }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function recordPoll(now: Date, ok: boolean, error?: string): void {
  try {
    kvSet(LAST_POLL_KEY, ok ? { at: now.toISOString(), ok } : { at: now.toISOString(), ok, error });
  } catch {
    // status only
  }
}

/**
 * Worker task body. Polls for up to `maxMs` (long polling), handling each update and confirming
 * its offset, and sends questions/updates between polls. Never throws; problems land in stats.
 */
export async function telegramPass(opts: TelegramPassOptions = {}): Promise<TelegramPassStats> {
  const clock = opts.now ?? (() => new Date());
  const stats: TelegramPassStats = {
    configured: hasTelegram(), paired: pairedChatId() !== undefined, polls: 0, updates: 0, ignored: 0, commands: 0, answers: 0,
    questionsSent: 0, notificationsSent: 0, errors: [],
  };
  if (!stats.configured) return { ...stats, stopped: 'not_configured' };
  if (!tokenLooksValid()) return { ...stats, stopped: 'bad_token', errors: ["TELEGRAM_BOT_TOKEN doesn't look like a bot token"] };
  if (backoffUntil(clock())) return { ...stats, stopped: 'backoff' };

  const ctx: Ctx = { now: clock, signal: opts.signal, gapMs: Math.max(0, opts.sendGapMs ?? 1100), stats };
  const maxMs = Math.max(0, opts.maxMs ?? DEFAULT_PASS_MS);
  const pollTimeout = Math.max(0, Math.min(50, opts.pollTimeoutSec ?? 25));
  const started = Date.now();

  await outgoing(ctx);
  for (let first = true; !opts.signal?.aborted; first = false) {
    const elapsed = Date.now() - started;
    if (!first && elapsed >= maxMs) break;
    const timeoutSec = Math.max(0, Math.min(pollTimeout, Math.floor((maxMs - elapsed) / 1000)));
    let updates: TgUpdate[];
    try {
      updates = await pollUpdates({ timeoutSec, signal: opts.signal });
      stats.polls++;
      recordPoll(clock(), true);
      if (kvGet(FAILURES_KEY)) kvSet(FAILURES_KEY, 0);
    } catch (err) {
      const e = asTelegramError(err, 'getUpdates');
      if (e.kind === 'aborted') {
        stats.stopped = 'aborted';
        break;
      }
      stats.errors.push(e.message);
      recordPoll(clock(), false, e.message);
      if (e.errorCode === 409) {
        stats.stopped = 'conflict';
        log.warn('telegram', 'another program is polling this bot (a second Pursuit worker, or a webhook): only one machine should run the worker');
      } else if (e.errorCode === 401 || e.errorCode === 404) {
        stats.stopped = 'unauthorized';
        log.warn('telegram', 'Telegram rejected the bot token: check TELEGRAM_BOT_TOKEN');
      } else {
        stats.stopped = 'error';
        const streak = (Number(kvGet(FAILURES_KEY)) || 0) + 1;
        kvSet(FAILURES_KEY, streak);
        if (e.errorCode === 429 && e.retryAfter) setBackoff(clock(), e.retryAfter);
        else if (streak >= 2) setBackoff(clock(), Math.min(300, 15 * 2 ** (streak - 1)));
        if (streak === 1) log.warn('telegram', `polling failed: ${e.message}`);
      }
      break;
    }
    for (const u of updates) {
      stats.updates++;
      try {
        await handleUpdate(u, ctx);
      } catch (err) {
        stats.errors.push(asTelegramError(err, 'update').message.slice(0, 200));
      }
      confirmUpdate(u.update_id); // a broken update is skipped, never retried forever
    }
    await outgoing(ctx);
  }
  stats.paired = pairedChatId() !== undefined;
  return stats;
}

// ───────────────────────────── Outgoing ─────────────────────────────

async function outgoing(ctx: Ctx): Promise<void> {
  if (pairedChatId() === undefined || ctx.signal?.aborted) return;
  try {
    pruneQuestions(ctx.now());
    const urgent = await flushOutbox({ now: ctx.now(), highOnly: true, signal: ctx.signal });
    ctx.stats.notificationsSent += urgent.sent;
    // v2: answer what Pursuit already knows, then send ONE message with the rest (max 10, questions only).
    await autoAnswerOpen(ctx.now()).catch((err) => ctx.stats.errors.push(`autoanswer: ${(err as Error).message}`.slice(0, 200)));
    await sendDigest(ctx);
    const { handoffNudge } = await import('@/worker/handoff');
    const nudge = handoffNudge(ctx.now(), quietNow(ctx.now()));
    if (nudge) notifyTelegram(nudge, { high: true, now: ctx.now() });
    const batch = await flushOutbox({ now: ctx.now(), signal: ctx.signal });
    ctx.stats.notificationsSent += batch.sent;
  } catch (err) {
    ctx.stats.errors.push(asTelegramError(err, 'outgoing').message.slice(0, 200));
  }
}

async function sendDigest(ctx: Ctx): Promise<void> {
  const qs = digestDue(ctx.now());
  if (!qs.length || ctx.signal?.aborted) return;
  const res = await deliver(composeDigest(qs), { kind: 'proactive', now: ctx.now(), signal: ctx.signal });
  if (!res.ok) {
    if (res.reason === 'error' && res.error) ctx.stats.errors.push(res.error);
    return;
  }
  recordDigest(res.message.message_id, qs, ctx.now());
  ctx.stats.questionsSent += qs.length;
}

/** v1 one-message-per-question sender (kept for reference; v2 uses sendDigest). */
export async function sendQuestions(ctx: Ctx): Promise<void> {
  for (const q of questionsToSend().slice(0, MAX_QUESTIONS_PER_ROUND)) {
    if (ctx.signal?.aborted) return;
    const view = composeQuestionMessage(q);
    const res = await deliver(view.text, { kind: 'proactive', replyMarkup: view.keyboard, now: ctx.now(), signal: ctx.signal });
    if (!res.ok) {
      if (res.reason === 'error' && res.error) ctx.stats.errors.push(res.error);
      return; // rate limited / backoff / failure: try again next round
    }
    markQuestionSent(q.id, q.askSeq, res.message.message_id, ctx.now());
    rememberQuestionMessage(res.message.message_id, q.id, q.askSeq, ctx.now());
    ctx.stats.questionsSent++;
    await sleep(ctx.gapMs, ctx.signal);
  }
}

interface QuestionRef { q: string; seq: number; at: string }

function rememberQuestionMessage(telegramMessageId: number, qid: string, seq: number, now: Date): void {
  tx(() => {
    const map = kvGet<Record<string, QuestionRef>>(QUESTION_MESSAGES_KEY) ?? {};
    map[String(telegramMessageId)] = { q: qid, seq, at: now.toISOString() };
    const keys = Object.keys(map);
    if (keys.length > MAP_MAX) {
      for (const k of keys.sort((a, b) => map[a].at.localeCompare(map[b].at)).slice(0, keys.length - MAP_MAX)) delete map[k];
    }
    kvSet(QUESTION_MESSAGES_KEY, map);
  });
}

function questionForMessage(telegramMessageId: number): QuestionRef | undefined {
  return kvGet<Record<string, QuestionRef>>(QUESTION_MESSAGES_KEY)?.[String(telegramMessageId)];
}

function isYesNoQuestion(q: PendingQuestion): boolean {
  const n = q.options?.length ?? 0;
  return (q.type === 'yesno' && !n) || (q.type === 'checkbox' && n <= 1) || (q.category === 'attestation' && !n);
}

function typeHint(q: PendingQuestion): string | undefined {
  if (isYesNoQuestion(q)) return 'Answer Yes or No.';
  if (q.options?.length) return q.type === 'checkbox' ? 'Pick one or more options.' : 'Pick one option.';
  switch (q.type) {
    case 'number': return 'Answer with a number.';
    case 'date': return 'Answer with a date, e.g. 01/12/2026.';
    case 'url': return 'Answer with a link.';
    default: return undefined;
  }
}

/** The question message: which applications wait on it, the exact question, and answer buttons. */
export function composeQuestionMessage(q: PendingQuestion): { text: string; keyboard: InlineKeyboard } {
  const jobs = q.waiting.map((w) => jobName(w.jobId));
  const lines: string[] = [];
  if (q.category === 'attestation') {
    lines.push(jobs.length === 1 ? `${jobs[0]} asks you to confirm a statement.` : `${jobs.length} applications ask you to confirm a statement:`);
    if (jobs.length > 1) lines.push(...jobs.slice(0, 8).map((j) => `• ${j}`));
    lines.push('', 'Do you agree to this exact wording?', '', `"${q.label}"`, '', 'Pursuit never ticks these for you. Your answer is kept for this exact wording only.');
  } else {
    lines.push(jobs.length === 1 ? `An application needs your answer: ${jobs[0]}` : `${jobs.length} applications need the same answer:`);
    if (jobs.length > 1) lines.push(...jobs.slice(0, 8).map((j) => `• ${j}`));
    if (jobs.length > 8) lines.push(`• and ${jobs.length - 8} more`);
    lines.push('', `Question: ${q.label}`);
    const hint = typeHint(q);
    if (hint) lines.push(hint);
    if (q.category) lines.push('', `This is a ${SENSITIVE_LABELS[q.category]} question, so Pursuit never guesses it. Your answer is kept for this exact question only.`);
    else if (q.scope === 'job') lines.push('', 'This answer is used for this application only.');
  }
  if (q.note) lines.push('', q.note);

  const rows: InlineButton[][] = [];
  const options = q.options ?? [];
  const cb = (choice: string) => `a:${q.id}:${q.askSeq}:${choice}`;
  if (isYesNoQuestion(q)) {
    rows.push([{ text: 'Yes', callback_data: cb('y') }, { text: 'No', callback_data: cb('n') }]);
  } else if (options.length && options.length <= MAX_BUTTONS) {
    const short = options.every((o) => o.length <= 18);
    for (let i = 0; i < options.length; i += short ? 2 : 1) {
      rows.push(options.slice(i, i + (short ? 2 : 1)).map((o, j) => ({ text: clip(o, 40), callback_data: cb(String(i + j)) })));
    }
  } else if (options.length) {
    lines.push('', optionList(options, 40));
  }
  rows.push([{ text: "Skip: I'll do it in the dashboard", callback_data: cb('s') }]);
  const buttons = rows.length > 1;
  lines.push('', buttons ? 'Tap an answer, or reply to this message.' : 'Reply to this message with your answer.');
  if (q.scope === 'shared') lines.push("I'll remember it so I don't ask again.");
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

const doneKeyboard = (label: string): InlineKeyboard => ({ inline_keyboard: [[{ text: clip(label, 60), callback_data: 'x' }]] });

async function quietly(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // cosmetic calls (toasts, keyboard edits) must not fail an update
  }
}

// ───────────────────────────── Updates ─────────────────────────────

async function handleUpdate(u: TgUpdate, ctx: Ctx): Promise<void> {
  if (u.callback_query) return handleCallback(u.callback_query, ctx);
  const msg = u.message;
  if (!msg) return; // edits, channel posts...
  const chat = msg.chat;
  const text = (msg.text ?? '').trim();
  const fromSelf = chat?.type === 'private' && msg.from && !msg.from.is_bot && msg.from.id === chat.id;

  if (!fromSelf || !isPairedChat(chat.id)) {
    const pair = /^\/pair(?:@\w+)?\s+(\d{6})$/i.exec(text);
    if (fromSelf && pair && activePairingCode(ctx.now())) {
      const res = verifyPairingCode(pair[1], chat.id, ctx.now());
      if (res.result === 'paired') {
        ctx.stats.paired = true;
        await deliver(`Paired. This chat is now Pursuit's only contact.\n\n${helpText()}`, { kind: 'reply', chatId: chat.id, now: ctx.now() });
        if (res.previousChatId) {
          await deliver("Pursuit was just paired with a different Telegram chat. If that wasn't you, open Settings and disconnect Telegram.", { kind: 'reply', chatId: res.previousChatId, now: ctx.now() });
        }
        return;
      }
    }
    recordIgnoredUpdate(ctx.now());
    ctx.stats.ignored++;
    return;
  }

  if (!text) return;
  const reply = (body: string) => deliver(body, { kind: 'reply', replyToMessageId: msg.message_id, now: ctx.now() });
  if (text.startsWith('/')) {
    ctx.stats.commands++;
    await reply(runCommand(text, ctx));
    return;
  }

  if (msg.reply_to_message) {
    const ref = questionForMessage(msg.reply_to_message.message_id);
    if (ref) {
      const q = getQuestion(ref.q);
      if (!q || q.status !== 'open') {
        await reply(q?.status === 'answered' ? 'That one is already answered. To change it, edit the answer bank in Settings.' : 'That question is closed now.');
        return;
      }
      await answerAndConfirm(q, text, msg, ctx);
      return;
    }
    const approval = approvalForMessage(msg.reply_to_message.message_id);
    if (approval) {
      const decision = /^(approve|approved|send|send it|yes|y|ok)$/i.test(text) ? 'approve' : /^(discard|delete|no|n|bin it)$/i.test(text) ? 'discard' : null;
      await reply(decision ? decideEmail(Number(approval), undefined, decision, ctx.now()) : 'Tap Approve or Discard on that message.');
      return;
    }
  }

  // One-tap handoff: GO opens the waiting human-check applications in Chrome one by one; STOP ends it.
  if (/^(go|go!|next)$/i.test(text)) {
    ctx.stats.commands++;
    const { startHandoffSession } = await import('@/worker/handoff');
    await reply(startHandoffSession(ctx.now()));
    return;
  }
  if (/^stop$/i.test(text)) {
    ctx.stats.commands++;
    const { stopHandoffSession } = await import('@/worker/handoff');
    await reply(stopHandoffSession());
    return;
  }
  if (/^(status|today|help|pause|resume|start|questions)$/i.test(text)) {
    ctx.stats.commands++;
    await reply(runCommand(`/${text.toLowerCase()}`, ctx));
    return;
  }
  // v2: one reply answers the open question list; anything else is a conversation with the assistant.
  if (currentDigest()) {
    const res = await applyDigestReply(text, ctx.now());
    if (res) {
      ctx.stats.answers += res.answered.length;
      const parts = [
        res.answered.length ? `Saved ${res.answered.join(', ')}.` : '',
        res.failed.length ? `Couldn't use ${res.failed.join('; ')}.` : '',
        res.skipped.length ? `Skipped ${res.skipped.join(', ')}.` : '',
        res.reply ?? '',
      ].filter(Boolean);
      await reply(parts.join(' ') || 'Got it.');
      return;
    }
  }
  await reply(await assistantReply(text, ctx.now()));
}

function helpText(): string {
  return [
    'Commands:',
    '/status: counts at a glance',
    '/today: what happened today',
    '/pause: stop all applying and sending',
    '/resume: start again',
    '/questions: send me the open questions again',
    'GO: open the applications that only need you to tick "I\'m human", one by one (STOP to end)',
    '/help: this list',
    '',
    'When an application needs an answer I message you. Tap a button or reply to that message and I remember the answer.',
  ].join('\n');
}

function runCommand(text: string, ctx: Ctx): string {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const cmd = m?.[1]?.toLowerCase() ?? '';
  switch (cmd) {
    case 'start':
      return `Hi Kayzee. I'm Pursuit's bot: I ask you when an application needs a detail, tell you what went out, and take /pause and /resume.\n\n${helpText()}`;
    case 'help':
      return helpText();
    case 'status':
      return buildStatusText();
    case 'today':
      return buildTodayText(ctx.now());
    case 'pause':
      if (getSettings().paused) return 'Already paused. Send /resume to start again.';
      updateSettings({ paused: true });
      log.info('telegram', 'paused all outbound actions from Telegram');
      return 'Paused. Nothing will be submitted or sent until you send /resume.';
    case 'resume':
      if (!getSettings().paused) return 'Already running.';
      updateSettings({ paused: false });
      log.info('telegram', 'resumed outbound actions from Telegram');
      return 'Resumed. Approved applications and emails go out again, within your daily caps.';
    case 'questions': {
      const n = resendOpenQuestions(ctx.now());
      return n ? `Sending ${plural(n, 'open question')} again.` : 'No questions waiting.';
    }
    case 'pair':
      return 'This chat is already paired.';
    default:
      return `I don't know /${cmd || '?'}.\n\n${helpText()}`;
  }
}

function outcomeText(q: PendingQuestion, out: AnswerOutcome): string {
  const answer = clip(out.answer ?? '', 80);
  const lines = [
    out.declined ? `OK: "${answer}". Pursuit won't tick it.`
      : q.scope === 'job' ? `Saved for this application: "${answer}".`
        : q.category ? `Saved for this exact question: "${answer}".` : `Saved: "${answer}". I'll remember it.`,
  ];
  if (out.requeued.length) lines.push(`Back in the apply queue: ${out.requeued.map(jobName).join('; ')}.`);
  if (out.waiting.length) lines.push(`Still waiting on another question: ${out.waiting.map(jobName).join('; ')}.`);
  for (const b of out.blocked.slice(0, 5)) lines.push(`${jobName(b.jobId)} still needs you in the dashboard: ${clip(b.reason, 120)}`);
  if (out.unfitted.length) lines.push(`That doesn't match the options for ${out.unfitted.map(jobName).join('; ')}, so I'll ask again for it.`);
  return lines.join('\n');
}

async function answerAndConfirm(q: PendingQuestion, text: string, msg: TgMessage, ctx: Ctx): Promise<void> {
  const reply = (body: string) => deliver(body, { kind: 'reply', replyToMessageId: msg.message_id, now: ctx.now() });
  if (/^\/?skip$/i.test(text)) {
    dismissQuestion(q.id, ctx.now());
    await reply('Skipped. It stays in Needs you on the dashboard.');
    return;
  }
  const out = answerQuestion(q.id, text, { via: 'telegram', now: ctx.now() });
  if (!out.ok) {
    await reply(out.error ?? "I couldn't use that answer.");
    return;
  }
  ctx.stats.answers++;
  await reply(outcomeText(q, out));
  const chatId = pairedChatId();
  if (chatId !== undefined && q.telegramMessageId !== undefined) {
    await quietly(editMessageReplyMarkup(chatId, q.telegramMessageId, doneKeyboard(`✓ ${out.answer ?? 'Saved'}`), { signal: ctx.signal }));
  }
}

async function handleCallback(cq: TgCallbackQuery, ctx: Ctx): Promise<void> {
  const chatId = cq.message?.chat?.id;
  if (!isPairedChat(cq.from?.id) || !isPairedChat(chatId) || cq.message?.chat?.type !== 'private') {
    recordIgnoredUpdate(ctx.now());
    ctx.stats.ignored++;
    return;
  }
  const data = cq.data ?? '';
  const messageId = cq.message?.message_id;
  const toast = (text?: string) => quietly(answerCallbackQuery(cq.id, text, { signal: ctx.signal }));
  const markDone = (label: string) =>
    chatId !== undefined && messageId !== undefined ? quietly(editMessageReplyMarkup(chatId, messageId, doneKeyboard(label), { signal: ctx.signal })) : Promise.resolve();

  const qm = /^a:(q[0-9a-f]{10}):(\d+):(\d+|y|n|s)$/.exec(data);
  if (qm) {
    const q = getQuestion(qm[1]);
    if (!q || q.status !== 'open') {
      await toast(q?.status === 'answered' ? 'Already answered.' : 'No longer needed.');
      await markDone(q?.status === 'answered' ? `✓ ${q.answer ?? 'Answered'}` : 'Closed');
      return;
    }
    if (Number(qm[2]) !== q.askSeq) {
      await toast('Out of date: use the newest message for this question.');
      return;
    }
    const choice = qm[3];
    if (choice === 's') {
      dismissQuestion(q.id, ctx.now());
      await toast('Skipped: it stays in Needs you on the dashboard.');
      await markDone('Skipped');
      return;
    }
    const answer = choice === 'y' ? 'Yes' : choice === 'n' ? 'No' : q.options?.[Number(choice)];
    if (answer === undefined) {
      await toast('Out of date: use the newest message for this question.');
      return;
    }
    const out = answerQuestion(q.id, answer, { via: 'telegram', now: ctx.now() });
    if (!out.ok) {
      await toast(clip(out.error ?? "Couldn't save that.", 180));
      return;
    }
    ctx.stats.answers++;
    await toast('Saved');
    await markDone(`✓ ${out.answer ?? answer}`);
    await deliver(outcomeText(q, out), { kind: 'reply', replyToMessageId: messageId, now: ctx.now() });
    return;
  }

  const em = /^e:(\d+):(\d+):(a|d)$/.exec(data);
  if (em) {
    const result = decideEmail(Number(em[1]), Number(em[2]), em[3] === 'a' ? 'approve' : 'discard', ctx.now());
    await toast(clip(result, 180));
    const state = getMessage(Number(em[1]))?.status;
    if (state && state !== 'draft') await markDone(state === 'approved' ? '✓ Approved' : state === 'discarded' ? 'Discarded' : state);
    return;
  }
  await toast(data === 'x' ? undefined : 'This button is out of date.');
}

// ───────────────────────────── Email approvals ─────────────────────────────

interface ApprovalRef { tg: number; seq: number; hash: string; at: string }
type Approvals = Record<string, ApprovalRef>;

/** Kinds the sender sends from the approval queue (mirrors outreach/send.ts). */
const SENDABLE_KINDS = new Set<Message['kind']>(['outreach', 'follow_up', 'reply', 'thank_you']);
const KIND_LABEL: Partial<Record<Message['kind'], string>> = {
  outreach: 'Outreach email', follow_up: 'Follow-up email', reply: 'Reply to an employer', thank_you: 'Thank-you email',
};

const emailHash = (m: Message) => crypto.createHash('sha256').update(`${m.to ?? ''}\n${m.subject ?? ''}\n${m.body}\n${m.attachCv ? 1 : 0}`).digest('hex').slice(0, 24);

function approvalForMessage(telegramMessageId: number): string | undefined {
  const map = kvGet<Approvals>(EMAIL_APPROVALS_KEY) ?? {};
  return Object.keys(map).find((k) => map[k]?.tg === telegramMessageId);
}

/** Why an email can't be approved from Telegram (null = it can). Same gates the sender uses. */
export function approvalBlocker(m: Message | undefined): string | null {
  if (!m) return 'that draft no longer exists';
  if (m.channel !== 'email' || m.direction !== 'out') return 'only outbound emails can be approved';
  if (m.status !== 'draft') return `it is already ${m.status}`;
  if (!SENDABLE_KINDS.has(m.kind)) return `${m.kind} messages aren't sent from the approval queue`;
  if (!m.subject?.trim() || !m.body.trim()) return 'the subject or body is empty';
  if (m.guardProblems?.length) return 'the truth guard flagged it: review it in the dashboard';
  const placeholder = findPlaceholder(`${m.subject}\n${m.body}`);
  if (placeholder) return `it still contains the placeholder ${placeholder}`;
  const recipient = verifyRecipient(m);
  return recipient.ok ? null : recipient.error;
}

export function composeEmailApproval(m: Message): string {
  const job = m.jobId ? getJob(m.jobId) : undefined;
  const body = m.body.trim();
  return [
    `${KIND_LABEL[m.kind] ?? 'Email'}: approve it?`,
    '',
    `To: ${m.to ?? '(none)'}`,
    `Subject: ${m.subject ?? '(none)'}`,
    ...(job ? [`Job: ${job.company}: ${job.title}`] : []),
    ...(m.attachCv ? ['Attaches your tailored CV.'] : []),
    '',
    body.length > 400 ? `${body.slice(0, 400)}…` : body,
    '',
    'Approve queues it for the next send run (pause and the daily cap still apply). Discard drops the draft.',
  ].join('\n');
}

/**
 * Sends Kayzee an Approve / Discard message for one outbound email draft (to, subject, first 400
 * characters). The button only flips messages.status; the worker's sender does the sending.
 */
export async function sendEmailApproval(messageId: number, opts: { now?: Date; signal?: AbortSignal } = {}): Promise<{ ok: boolean; reason?: string; telegramMessageId?: number }> {
  const m = getMessage(messageId);
  const blocker = approvalBlocker(m);
  if (blocker || !m) return { ok: false, reason: blocker ?? 'not found' };
  const now = opts.now ?? new Date();
  const previous = kvGet<Approvals>(EMAIL_APPROVALS_KEY)?.[String(m.id)];
  const seq = (previous?.seq ?? 0) + 1;
  const keyboard: InlineKeyboard = { inline_keyboard: [[
    { text: 'Approve', callback_data: `e:${m.id}:${seq}:a` },
    { text: 'Discard', callback_data: `e:${m.id}:${seq}:d` },
  ]] };
  const res: DeliverResult = await deliver(composeEmailApproval(m), { kind: 'proactive', replyMarkup: keyboard, now, signal: opts.signal });
  if (!res.ok) return { ok: false, reason: res.error ?? res.reason };
  tx(() => {
    const map = kvGet<Approvals>(EMAIL_APPROVALS_KEY) ?? {};
    map[String(m.id)] = { tg: res.message.message_id, seq, hash: emailHash(m), at: now.toISOString() };
    const keys = Object.keys(map);
    if (keys.length > MAP_MAX) for (const k of keys.sort((a, b) => map[a].at.localeCompare(map[b].at)).slice(0, keys.length - MAP_MAX)) delete map[k];
    kvSet(EMAIL_APPROVALS_KEY, map);
  });
  logEvent('telegram.email_offered', { messageId: m.id, kind: m.kind }, m.jobId);
  return { ok: true, telegramMessageId: res.message.message_id };
}

/** Applies an Approve/Discard press. Refuses when the draft changed after it was shown. */
function decideEmail(messageId: number, seq: number | undefined, decision: 'approve' | 'discard', now: Date): string {
  const result = tx((): { text: string; reoffer?: boolean } => {
    const ref = kvGet<Approvals>(EMAIL_APPROVALS_KEY)?.[String(messageId)];
    const m = getMessage(messageId);
    if (!ref || !m) return { text: 'That draft no longer exists.' };
    if (seq !== undefined && seq !== ref.seq) return { text: 'Out of date: use the newest approval message for this email.' };
    if (m.status !== 'draft') return { text: `Already ${m.status}.` };
    if (emailHash(m) !== ref.hash) return { text: 'This draft was edited after I sent it, so I sent you the new version to approve.', reoffer: true };
    if (decision === 'discard') {
      updateMessage(m.id, { status: 'discarded' });
      logEvent('telegram.email_discarded', { messageId: m.id, kind: m.kind }, m.jobId);
      return { text: 'Discarded.' };
    }
    const blocker = approvalBlocker(m);
    if (blocker) return { text: `Not approved: ${blocker}.` };
    updateMessage(m.id, { status: 'approved', error: undefined });
    logEvent('telegram.email_approved', { messageId: m.id, kind: m.kind }, m.jobId);
    return { text: 'Approved. It goes out on the next send run.' };
  });
  if (result.reoffer) void sendEmailApproval(messageId, { now }).catch(() => undefined);
  return result.text;
}

// ───────────────────────────── Other helpers for the worker ─────────────────────────────

/** Sends the morning summary once per Dublin day (unless `force`). The worker schedules it. */
export async function sendDailySummary(opts: { now?: Date; force?: boolean; signal?: AbortSignal } = {}): Promise<{ sent: boolean; reason?: string }> {
  if (!hasTelegram()) return { sent: false, reason: 'not_configured' };
  if (pairedChatId() === undefined) return { sent: false, reason: 'not_paired' };
  const now = opts.now ?? new Date();
  const today = dublinDate(now);
  if (!opts.force && kvGet(SUMMARY_KEY) === today) return { sent: false, reason: 'already sent today' };
  const res = await deliver(buildDailySummary(now), { kind: 'proactive', now, signal: opts.signal });
  if (!res.ok) return { sent: false, reason: res.error ?? res.reason };
  kvSet(SUMMARY_KEY, today);
  return { sent: true };
}

/** One-line update after an apply attempt (queued, batched). Question hand-offs are asked separately. */
export function notifyApplyOutcome(jobId: string, outcome: Pick<ApplyOutcome, 'status' | 'needs' | 'error'>): { queued: boolean; reason?: string } {
  const name = jobName(jobId);
  // v2 (his feedback): only good news is pushed, batched by the outbox. Questions come as one list; anything that
  // needs the dashboard (CAPTCHA, account walls, failures) is in the morning summary and on the Today page.
  if (outcome.status === 'applied') return notifyTelegram(`Applied ✓ ${name}`);
  void clip;
  return { queued: false, reason: 'summary only' };
}
