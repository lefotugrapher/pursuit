// Telegram bot tests against an in-process fake of the Bot API (globalThis.fetch is stubbed: the
// real api.telegram.org is never called and .env.local is never read). Covers pairing, ignoring
// other chats, commands, questions answered by reply / button / plain text, notification batching
// and the hourly limit, email approval buttons, the daily summary, and token redaction everywhere.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-telegram-test-'));
const CONFIG_TMP = path.join(TMP, 'config');
fs.mkdirSync(CONFIG_TMP, { recursive: true });
for (const name of ['profile', 'facts', 'answers', 'sources']) {
  fs.copyFileSync(path.join(ROOT, 'config', `${name}.example.json`), path.join(CONFIG_TMP, `${name}.example.json`));
}

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
const SECRET = TOKEN.split(':')[1];
process.env.PURSUIT_SKIP_ENV_FILE = '1'; // never load the real .env.local (it holds the real bot token)
process.env.PURSUIT_LOG_SILENT = '1';
process.env.PURSUIT_NOTIFY = 'off';
process.env.PURSUIT_DATA_DIR = path.join(TMP, 'data');
process.env.PURSUIT_CONFIG_DIR = CONFIG_TMP;
process.env.OPENROUTER_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.ORCAROUTER_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GMAIL_USER = '';
process.env.GMAIL_APP_PASSWORD = '';
process.env.TELEGRAM_BOT_TOKEN = TOKEN;
process.env.TELEGRAM_CHAT_ID = '';

// ───────────────────────────── Fake Bot API ─────────────────────────────

interface SentMessage { id: number; chatId: number; text: string; markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }
const tg = {
  calls: [] as { method: string; body: Record<string, unknown> }[],
  updates: [] as Record<string, unknown>[],
  sent: [] as SentMessage[],
  mode: 'ok' as 'ok' | 'network' | 'unauthorized',
  nextId: 1000,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
  if (!m || m[1] !== TOKEN) throw new Error('unexpected request in tests');
  const method = m[2];
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  tg.calls.push({ method, body });
  // Simulates a fetch failure whose message leaks the full URL (with the token).
  if (tg.mode === 'network') throw new TypeError(`fetch failed: connect ECONNREFUSED for ${url}`);
  if (tg.mode === 'unauthorized') return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
  switch (method) {
    case 'getMe':
      return json({ ok: true, result: { id: 42, is_bot: true, first_name: 'Pursuit', username: 'pursuit_test_bot' } });
    case 'getUpdates': {
      const offset = typeof body.offset === 'number' ? body.offset : 0;
      return json({ ok: true, result: tg.updates.filter((u) => (u.update_id as number) >= offset) });
    }
    case 'sendMessage': {
      const id = ++tg.nextId;
      tg.sent.push({ id, chatId: body.chat_id as number, text: body.text as string, markup: body.reply_markup as SentMessage['markup'] });
      return json({ ok: true, result: { message_id: id, date: 0, chat: { id: body.chat_id, type: 'private' }, text: body.text } });
    }
    default:
      return json({ ok: true, result: true });
  }
}) as typeof fetch;

const dbm = await import('../src/lib/db');
const { loadAnswers } = await import('../src/lib/config');
const api = await import('../src/engine/telegram/api');
const pairing = await import('../src/engine/telegram/pairing');
const outbox = await import('../src/engine/telegram/outbox');
const bot = await import('../src/engine/telegram/bot');
const status = await import('../src/engine/telegram/status');
const Q = await import('../src/engine/questions');

type Job = import('../src/lib/types').Job;
type ScreeningQuestion = import('../src/lib/types').ScreeningQuestion;

const ME = 5550001;
const STRANGER = 5550002;
let dbCounter = 0;
let dbPath = '';
let updateSeq = 1;

beforeEach(() => {
  dbm.closeDb();
  dbPath = path.join(TMP, `tg-${++dbCounter}.db`);
  process.env.PURSUIT_DB_PATH = dbPath;
  process.env.TELEGRAM_CHAT_ID = '';
  fs.rmSync(path.join(CONFIG_TMP, 'answers.json'), { force: true });
  tg.calls = [];
  tg.updates = [];
  tg.sent = [];
  tg.mode = 'ok';
});
after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function textUpdate(chatId: number, text: string, replyTo?: number) {
  const n = updateSeq++;
  const chat = { id: chatId, type: 'private' };
  return {
    update_id: n,
    message: {
      message_id: 50_000 + n, date: 0, chat, from: { id: chatId, is_bot: false, first_name: 'K' }, text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat } } : {}),
    },
  };
}
function buttonUpdate(chatId: number, data: string, messageId: number) {
  const n = updateSeq++;
  return { update_id: n, callback_query: { id: `cb${n}`, from: { id: chatId, is_bot: false, first_name: 'K' }, message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } }, data } };
}
const pass = () => bot.telegramPass({ maxMs: 0, sendGapMs: 0 });
const pair = (chatId = ME) => dbm.kvSet(pairing.CHAT_ID_KEY, chatId);
const sentTo = (chatId: number) => tg.sent.filter((s) => s.chatId === chatId);
const lastTo = (chatId: number) => sentTo(chatId).at(-1)!;
const buttons = (m: SentMessage) => (m.markup?.inline_keyboard ?? []).flat();

let seq = 0;
function parkedJob(needs: string[]): Job {
  const n = ++seq;
  const { job } = dbm.upsertJob({
    id: `tgjob${String(n).padStart(11, '0')}`, source: 'greenhouse', sourceId: `gh-${n}`, company: `Acme ${n}`, title: 'PR Executive',
    location: 'Dublin, Ireland', remote: false, url: `https://boards.example.test/${n}`, applyUrl: `https://boards.example.test/${n}`,
    ats: 'greenhouse', atsMeta: {}, description: 'PR role.',
  });
  dbm.setStatus(job.id, 'ready');
  dbm.setStatus(job.id, 'approved');
  dbm.updateJob(job.id, { needs });
  dbm.setStatus(job.id, 'needs_you', { needs });
  return dbm.getJob(job.id)!;
}
const need = (label: string) => `Answer required question: "${label}"`;
const q = (label: string, over: Partial<ScreeningQuestion> = {}): ScreeningQuestion => ({ id: `f_${label.length}`, label, type: 'text', required: true, ...over });

// ───────────────────────────── Tests ─────────────────────────────

describe('api', () => {
  test('redactToken removes the token, its secret half and token-shaped strings', () => {
    const text = `GET https://api.telegram.org/bot${TOKEN}/getMe failed; secret=${SECRET}; other 987654321:${'Z'.repeat(35)}`;
    const out = api.redactToken(text);
    assert.ok(!out.includes(SECRET));
    assert.ok(!out.includes('Z'.repeat(35)));
    assert.match(out, /bot\[redacted\]/);
  });

  test('API errors carry the code and no token', async () => {
    tg.mode = 'unauthorized';
    await assert.rejects(api.getMe(), (err: unknown) => {
      assert.ok(err instanceof api.TelegramApiError);
      assert.equal(err.errorCode, 401);
      assert.ok(!err.message.includes(SECRET) && !String(err.stack).includes(SECRET));
      return true;
    });
  });

  test('offset tracking only moves forward', () => {
    api.confirmUpdate(10);
    api.confirmUpdate(4);
    assert.equal(api.currentOffset(), 11);
  });
});

describe('pairing', () => {
  test('right code pairs; wrong codes do not; other chats are ignored and never answered', async () => {
    tg.updates.push(textUpdate(STRANGER, '/pair 123456'));
    await pass();
    assert.equal(pairing.pairedChatId(), undefined, 'no code active: nothing pairs');
    assert.equal(tg.sent.length, 0);

    const { code } = pairing.createPairingCode();
    assert.ok(!JSON.stringify(dbm.kvGet(pairing.PAIR_CODE_KEY)).includes(code), 'the code is stored hashed');
    const wrong = code === '000000' ? '111111' : '000000';
    tg.updates.push(textUpdate(STRANGER, `/pair ${wrong}`), textUpdate(STRANGER, '/start'));
    await pass();
    assert.equal(pairing.pairedChatId(), undefined);
    assert.equal(tg.sent.length, 0, 'strangers get no reply at all');

    tg.updates.push(textUpdate(ME, `/pair ${code}`));
    await pass();
    assert.equal(pairing.pairedChatId(), ME);
    assert.equal(pairing.pairingSource(), 'code');
    assert.match(lastTo(ME).text, /^Paired/);
    assert.equal(pairing.activePairingCode(), null, 'the code is used up');

    tg.updates.push(textUpdate(STRANGER, '/status'), textUpdate(STRANGER, '/pause'), buttonUpdate(STRANGER, 'x', 1));
    const stats = await pass();
    assert.equal(stats.ignored, 3);
    assert.equal(sentTo(STRANGER).length, 0);
    assert.equal(dbm.getSettings().paused, false);
    assert.equal(tg.calls.filter((c) => c.method === 'answerCallbackQuery').length, 0);
    assert.ok(pairing.ignoredUpdates().count >= 5);
    assert.ok(!JSON.stringify(dbm.kvGet(pairing.IGNORED_KEY)).includes(String(STRANGER)), 'only a counter is kept');
  });

  test('expired codes and repeated wrong guesses do not pair', () => {
    const t0 = new Date('2026-11-16T10:00:00Z');
    const first = pairing.createPairingCode(t0);
    assert.equal(pairing.verifyPairingCode(first.code, ME, new Date(t0.getTime() + 16 * 60_000)).result, 'expired');
    assert.equal(pairing.pairedChatId(), undefined);

    const { code } = pairing.createPairingCode();
    const wrong = code === '999999' ? '888888' : '999999';
    for (let i = 0; i < pairing.MAX_FAILURES_PER_CHAT; i++) assert.equal(pairing.verifyPairingCode(wrong, STRANGER).result, 'wrong');
    assert.equal(pairing.verifyPairingCode(code, STRANGER).result, 'locked', 'that chat is locked out even with the right code');
    assert.equal(pairing.verifyPairingCode(code, ME).result, 'paired');
    assert.equal(pairing.pairedChatId(), ME);
  });

  test('TELEGRAM_CHAT_ID pre-pairs and pins the chat', async () => {
    pair(STRANGER); // an older code pairing must not survive the env pin
    process.env.TELEGRAM_CHAT_ID = String(ME);
    assert.equal(pairing.pairingSource(), 'env');
    assert.equal(pairing.pairedChatId(), ME);
    const { code } = pairing.createPairingCode();
    assert.equal(pairing.verifyPairingCode(code, STRANGER).result, 'pinned');
    tg.updates.push(textUpdate(STRANGER, '/status'), textUpdate(STRANGER, `/pair ${code}`), textUpdate(ME, '/help'));
    const stats = await pass();
    assert.equal(stats.ignored, 2);
    assert.equal(sentTo(STRANGER).length, 0);
    assert.match(lastTo(ME).text, /\/status/);
    assert.equal(pairing.pairedChatId(), ME);
  });

  test('polling starts from Telegram\'s current position, then continues from the stored offset', async () => {
    pair();
    tg.updates.push(textUpdate(ME, '/help'));
    await pass();
    const polls = tg.calls.filter((c) => c.method === 'getUpdates');
    assert.equal(polls[0].body.offset, undefined, 'no stored offset: Telegram serves only unconfirmed updates');
    const last = tg.updates.at(-1)!.update_id as number;
    assert.equal(dbm.kvGet(api.OFFSET_KEY), last + 1);
    await pass();
    assert.equal(tg.calls.filter((c) => c.method === 'getUpdates').at(-1)!.body.offset, last + 1);
    assert.equal(sentTo(ME).length, 1, 'a handled update is never handled twice');
  });
});

describe('commands', () => {
  test('/status, /pause, /resume, /today and /help from the paired chat', async () => {
    pair();
    parkedJob([need('Notice period')]);
    tg.updates.push(textUpdate(ME, '/status'), textUpdate(ME, '/pause'));
    const stats = await pass();
    assert.equal(stats.commands, 2);
    assert.match(sentTo(ME)[0].text, /Pursuit status[\s\S]*Needs you: 1/);
    assert.equal(dbm.getSettings().paused, true);
    tg.updates.push(textUpdate(ME, '/resume'), textUpdate(ME, '/today'), textUpdate(ME, '/help'), textUpdate(ME, '/nonsense'));
    await pass();
    assert.equal(dbm.getSettings().paused, false);
    const texts = sentTo(ME).map((m) => m.text);
    assert.match(texts[2], /Resumed/);
    assert.match(texts[3], /^Today so far/);
    assert.match(texts[4], /\/pause/);
    assert.match(texts[5], /I don't know \/nonsense/);
  });
});

describe('questions over Telegram', () => {
  test('v2: ONE message lists the questions (question text only); one numbered reply answers them; job re-queued', async () => {
    pair();
    const notice = 'What is your notice period?';
    const licence = 'Do you have a full driving licence?';
    const job = parkedJob([need(notice), need(licence)]);
    Q.queueQuestion({ jobId: job.id, question: q(notice, { id: 'notice', type: 'select', options: ['Select...', 'Immediately', '1 month', '2 months'] }) });
    Q.queueQuestion({ jobId: job.id, question: q(licence, { id: 'licence', type: 'yesno' }) });

    const stats = await pass();
    assert.equal(stats.questionsSent, 2);
    assert.equal(sentTo(ME).length, 1, 'one message, not one per question');
    const digest = lastTo(ME);
    assert.match(digest.text, /^2 questions:/);
    assert.match(digest.text, /1\. What is your notice period\? \(Immediately \/ 1 month \/ 2 months\)/);
    assert.match(digest.text, /2\. Do you have a full driving licence\? \(yes\/no\)/);
    assert.doesNotMatch(digest.text, new RegExp(job.company), 'no context unless he asks');

    await pass();
    assert.equal(sentTo(ME).length, 1, 'not re-sent');

    tg.updates.push(textUpdate(ME, '1 2 months, 2 yes'));
    await pass();
    assert.equal(dbm.getJob(job.id)!.status, 'approved');
    assert.match(lastTo(ME).text, /Saved 1, 2\./);
    const entries = loadAnswers().entries.filter((e) => e.id.startsWith('learned-'));
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.confirm === false));
    assert.deepEqual(entries.map((e) => e.answer).sort(), ['2 months', 'Yes']);
  });

  test('v2: numbers in his reply keep pointing at the message he saw, even after some were answered elsewhere', async () => {
    pair();
    const job = parkedJob([need('Do you have a car?'), need('Do you have a bike?')]);
    Q.queueQuestion({ jobId: job.id, question: q('Do you have a car?', { id: 'car', type: 'yesno' }) });
    Q.queueQuestion({ jobId: job.id, question: q('Do you have a bike?', { id: 'bike', type: 'yesno' }) });
    await pass();
    const car = Q.pendingQuestions().find((x) => /car/.test(x.label))!;
    Q.answerQuestion(car.id, 'No', { via: 'dashboard' });
    tg.updates.push(textUpdate(ME, '2 yes'));
    await pass();
    const bike = loadAnswers().entries.find((e) => e.patterns.some((p) => /bike/.test(p)));
    assert.equal(bike?.answer, 'Yes', 'answer 2 went to question 2 (bike), not shifted onto the car');
    assert.equal(dbm.getJob(job.id)!.status, 'approved');
  });

  test('v2: a message that is not an answer gets a reply, never "which question?"', async () => {
    pair();
    tg.updates.push(textUpdate(ME, 'how many applied today?'));
    await pass();
    assert.match(lastTo(ME).text, /AI is offline|\/status/, 'tests run without an AI key');
  });

  test('v2: an invalid answer is explained and stays open; "skip 1" leaves it for the dashboard', async () => {
    pair();
    const job = parkedJob([need('Do you have a car?')]);
    Q.queueQuestion({ jobId: job.id, question: q('Do you have a car?', { type: 'yesno' }) });
    await pass();
    tg.updates.push(textUpdate(ME, '1 it depends'));
    await pass();
    assert.match(lastTo(ME).text, /Couldn't use 1/);
    assert.equal(Q.pendingQuestions().length, 1);
    tg.updates.push(textUpdate(ME, 'skip 1'));
    await pass();
    assert.match(lastTo(ME).text, /Skipped 1/);
    assert.equal(Q.pendingQuestions().length, 0);
    assert.equal(dbm.getJob(job.id)!.status, 'needs_you');
  });

  test('nothing is sent before pairing', async () => {
    const job = parkedJob([need('Notice period')]);
    Q.queueQuestion({ jobId: job.id, question: q('Notice period') });
    bot.notifyTelegram('Applied: something');
    await pass();
    assert.equal(tg.sent.length, 0);
  });
});

describe('rate limit + batching', () => {
  test('notifications batch into one message, wait for the batch window, and high priority goes at once', async () => {
    pair();
    for (let i = 0; i < 25; i++) assert.equal(bot.notifyTelegram(`Applied: job ${i}`).queued, true);
    await pass();
    assert.equal(sentTo(ME).length, 1);
    assert.match(sentTo(ME)[0].text, /^Pursuit: 25 updates/);
    assert.ok(sentTo(ME)[0].text.includes('Applied: job 0') && sentTo(ME)[0].text.includes('Applied: job 24'));

    bot.notifyTelegram('Applied: later');
    await pass();
    assert.equal(sentTo(ME).length, 1, 'held for the next batch');
    bot.notifyTelegram('Interview invite: Acme', { priority: 'high' });
    await pass();
    assert.equal(sentTo(ME).length, 2);
    assert.ok(sentTo(ME)[1].text.includes('Applied: later') && sentTo(ME)[1].text.includes('Interview invite'));
  });

  test('at most 20 messages an hour; proactive ones leave room for replies', async () => {
    pair();
    const results = [];
    for (let i = 0; i < 20; i++) results.push(await outbox.deliver(`update ${i}`, { kind: 'proactive' }));
    assert.equal(results.filter((r) => r.ok).length, outbox.PROACTIVE_LIMIT);
    assert.equal(results.filter((r) => !r.ok && r.reason === 'rate_limited').length, 20 - outbox.PROACTIVE_LIMIT);
    const replies = [];
    for (let i = 0; i < 10; i++) replies.push(await outbox.deliver(`reply ${i}`, { kind: 'reply' }));
    assert.equal(replies.filter((r) => r.ok).length, outbox.HOURLY_LIMIT - outbox.PROACTIVE_LIMIT);
    assert.equal(tg.sent.length, outbox.HOURLY_LIMIT);
    assert.equal(outbox.sendBudget().remaining, 0);
    const later = new Date(Date.now() + 61 * 60_000);
    assert.equal((await outbox.deliver('an hour later', { kind: 'proactive', now: later })).ok, true);
  });
});

describe('email approvals', () => {
  function draft(over: Partial<import('../src/lib/types').NewMessage> = {}) {
    const job = parkedJob([]);
    const contact = dbm.upsertContact({ jobId: job.id, company: job.company, name: 'Jane', email: 'jane@acme.example', emailVerified: true, source: 'jd', confidence: 0.9 });
    return dbm.addMessage({
      jobId: job.id, contactId: contact.id, direction: 'out', channel: 'email', kind: 'outreach', to: 'jane@acme.example',
      subject: 'PR Executive application', body: `${'A'.repeat(400)}TAIL END`, status: 'draft', ...over,
    });
  }

  test('shows to/subject/first 400 characters; Approve and Discard set the status', async () => {
    pair();
    const m1 = draft();
    const r = await bot.sendEmailApproval(m1.id);
    assert.equal(r.ok, true);
    const msg = lastTo(ME);
    assert.match(msg.text, /To: jane@acme\.example/);
    assert.match(msg.text, /Subject: PR Executive application/);
    assert.ok(msg.text.includes('A'.repeat(400)) && !msg.text.includes('TAIL END'));
    const approve = buttons(msg).find((b) => b.text === 'Approve')!;
    tg.updates.push(buttonUpdate(ME, approve.callback_data, msg.id));
    await pass();
    assert.equal(dbm.getMessage(m1.id)!.status, 'approved');

    const m2 = draft();
    await bot.sendEmailApproval(m2.id);
    const discard = buttons(lastTo(ME)).find((b) => b.text === 'Discard')!;
    tg.updates.push(buttonUpdate(ME, discard.callback_data, lastTo(ME).id));
    await pass();
    assert.equal(dbm.getMessage(m2.id)!.status, 'discarded');
  });

  test('refuses edited drafts, unverified recipients and truth-guard problems', async () => {
    pair();
    const m = draft();
    await bot.sendEmailApproval(m.id);
    const offer = lastTo(ME);
    dbm.updateMessage(m.id, { body: 'Edited after the offer was sent.' });
    tg.updates.push(buttonUpdate(ME, buttons(offer).find((b) => b.text === 'Approve')!.callback_data, offer.id));
    await pass();
    assert.equal(dbm.getMessage(m.id)!.status, 'draft', 'not approved: he never saw this version');

    const guessed = draft({ contactId: undefined, to: 'guess@unknown.example' });
    assert.equal((await bot.sendEmailApproval(guessed.id)).ok, false);
    const flagged = draft({ guardProblems: ['number not in facts'] });
    assert.equal((await bot.sendEmailApproval(flagged.id)).ok, false);
  });
});

describe('daily summary', () => {
  test('covers found, applied, replies, interviews and needs-you; sends once a day', async () => {
    pair();
    parkedJob([need('Notice period')]);
    const text = bot.buildDailySummary();
    for (const re of [/Found: /, /Applied: /, /Replies: /, /Interviews: /, /Needs you: 1/]) assert.match(text, re);
    assert.deepEqual(await bot.sendDailySummary(), { sent: true });
    assert.equal((await bot.sendDailySummary()).sent, false);
    assert.equal(tg.sent.length, 1);
  });
});

describe('secrets', () => {
  test('the bot token never reaches errors, stats, events, kv, runs, the DB file or the console', async () => {
    const captured: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    delete process.env.PURSUIT_LOG_SILENT;
    try {
      pair();
      tg.mode = 'network';
      const s1 = await pass();
      assert.equal(s1.stopped, 'error');
      assert.ok(s1.errors.length && s1.errors.every((e) => !e.includes(SECRET)));
      const d = await outbox.deliver('hello', { kind: 'reply' });
      assert.equal(d.ok, false);
      assert.ok(!JSON.stringify(d).includes(SECRET));
      await assert.rejects(api.getMe(), (err: unknown) => err instanceof api.TelegramApiError && !err.message.includes(SECRET) && !String(err.stack).includes(SECRET));
      const me = await status.botIdentity({ refresh: true });
      assert.ok(me.error && !me.error.includes(SECRET));

      tg.mode = 'unauthorized';
      const s2 = await pass();
      assert.equal(s2.stopped, 'unauthorized');
      const card = await status.telegramStatus();
      assert.ok(!JSON.stringify(card).includes(SECRET));

      const runId = dbm.startRun('telegram');
      dbm.finishRun(runId, true, s1 as unknown as Record<string, unknown>, s1.errors.join('; '));
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      process.env.PURSUIT_LOG_SILENT = '1';
    }
    assert.ok(tg.calls.length > 0, 'the fake API was exercised');
    for (const table of ['events', 'kv', 'runs']) {
      const rows = dbm.db().prepare(`SELECT * FROM ${table}`).all();
      assert.ok(!JSON.stringify(rows).includes(SECRET), `token found in ${table}`);
    }
    assert.ok(captured.length > 0, 'the console was captured');
    assert.ok(!captured.join('\n').includes(SECRET), 'token printed to the console');
    dbm.closeDb();
    for (const f of fs.readdirSync(TMP).filter((name) => name.startsWith(path.basename(dbPath)))) {
      assert.ok(!fs.readFileSync(path.join(TMP, f)).includes(SECRET), `token found in ${f}`);
    }
  });
});
