// Pursuit's Telegram assistant (v2, after Kayzee's feedback 2026-11-16):
//   - never ask what Pursuit already knows: an AI pass answers open questions from his CV, facts, answer bank,
//     profile and Coach notes before anything is sent (sensitive topics only from answers he gave himself);
//   - one message, at most 10 numbered questions, question text only (no context unless he asks);
//   - he replies once ("1 DkIT\n2 yes" or plain prose); the AI maps it to the questions;
//   - anything else he writes gets a real answer (status, what's pending), and what he tells it is remembered.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadAnswers, loadFacts, loadProfile } from '@/lib/config';
import { countByStatus, kvGet, kvSet, listEvents, listJobs, getJob } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { log } from '@/lib/log';
import { CONFIG_DIR } from '@/lib/paths';
import { guardText } from '@/engine/truthguard';
import { answerQuestion, dismissQuestion, markQuestionSent, pendingQuestions, type PendingQuestion } from '@/engine/questions';

export const DIGEST_KEY = 'telegram.digest';            // { messageId, ids[], sentAt }
const DIGEST_MAX = 10;
const DIGEST_MIN_GAP_MS = 20 * 60_000;                  // at most one question message every 20 minutes
const NOTES_HEADING = '## Things he told the Telegram bot';

export interface Digest { messageId: number; ids: string[]; sentAt: string }

export function currentDigest(): Digest | undefined {
  return kvGet<Digest>(DIGEST_KEY);
}

// ───────────────────────────── What Pursuit knows ─────────────────────────────

function notesFile(): string {
  return path.join(CONFIG_DIR, 'coach-context.md');
}

function background(): string {
  try {
    return fs.readFileSync(notesFile(), 'utf8').slice(0, 9000);
  } catch {
    return '';
  }
}

function knowledge(): string {
  const p = loadProfile();
  const facts = loadFacts();
  const bank = loadAnswers().entries.filter((e) => e.answer && !e.confirm);
  return [
    `PROFILE: ${p.name.full} (${p.name.preferred}); email ${p.email}; phone ${p.phone}; lives in ${p.location}; LinkedIn ${p.links.linkedin ?? '-'}; portfolio ${p.links.portfolio ?? '-'}; work auth: ${p.workAuth.summary}`,
    `ANSWER BANK (his confirmed answers; use the id when you rely on one):\n${bank.map((e) => `[${e.id}] ${e.patterns[0]} => ${e.answer}`).join('\n')}`,
    `FACTS (true, from his CV):\n${facts.facts.map((f) => `- ${f.text}`).join('\n')}`,
    `BACKGROUND NOTES:\n${background()}`,
  ].join('\n\n');
}

// ───────────────────────────── 1. Answer what we already know ─────────────────────────────

const InferSchema = z.object({
  // Free models are sloppy with types: coerce, and treat a missing confidence as "not sure" (never answered).
  answers: z.array(z.object({
    n: z.coerce.number().int(),
    answer: z.string().max(1500).nullable().catch(null),
    confidence: z.coerce.number().min(0).max(1).nullable().catch(null).transform((v) => v ?? 0),
    basis: z.string().max(300).optional().nullable().catch(null),
    answerId: z.string().max(80).optional().nullable().catch(null),
  })).max(DIGEST_MAX * 3).catch([]),
});

const NEVER_INFER = new Set(['attestation']);
const BANK_ONLY = new Set(['visa', 'right_to_work', 'salary', 'criminal_record', 'health']);

function describe(q: PendingQuestion, n: number): string {
  const opts = q.options?.length ? ` | options: ${q.options.slice(0, 40).join(' / ')}${q.options.length > 40 ? ' / …(searchable list)' : ''}` : '';
  return `${n}. [${q.type}${q.category ? `, sensitive:${q.category}` : ''}] ${q.label}${opts}`;
}

/**
 * Answers open questions Pursuit can answer itself. Returns how many were answered (and their jobs re-queued).
 * Free-text answers must pass the truth guard; sensitive ones must come from a bank entry he gave himself.
 */
export async function autoAnswerOpen(now: Date = new Date()): Promise<number> {
  if (!hasLLM()) return 0;
  const open = pendingQuestions().filter((q) => q.waiting.length && !NEVER_INFER.has(q.category ?? '') && q.sentSeq < q.askSeq);
  if (!open.length) return 0;
  const batch = open.slice(0, DIGEST_MAX * 2);
  const out = await llmJSON({
    purpose: 'telegram.autoanswer',
    system: [
      "You fill in job-application questions for Kayzee using ONLY what is known about him below. Never invent anything.",
      'For each question return {n, answer, confidence, basis, answerId}. answer=null if it is not clearly known.',
      '- Option questions: answer with one of the given options (exact text); several for checkbox questions, separated by "; ".',
      '- Long searchable lists (marked …): give the known value (e.g. his university) even if it is not in the visible options.',
      '- Questions marked sensitive (visa, right to work, salary, criminal record, health): answer ONLY by reusing an ANSWER BANK entry on the same topic, and give its answerId. Otherwise null.',
      "- 'Have you worked for <company> before?': No, unless that company is in his FACTS.",
      '- Marketing / WhatsApp / SMS / newsletter opt-ins: No.',
      '- Free-text questions about his experience or skills: 2-4 plain first-person sentences built only from FACTS. No numbers that are not in FACTS.',
      '- confidence: 0.9+ only when the answer is directly stated in the data.',
      'Return JSON {"answers": [...]}.',
    ].join('\n'),
    user: `${knowledge()}\n\nQUESTIONS:\n${batch.map((q, i) => describe(q, i + 1)).join('\n')}`,
    schema: InferSchema,
    maxTokens: 1800,
    temperature: 0.1,
  });
  if (!out) return 0;
  const facts = loadFacts();
  const bankIds = new Set(loadAnswers().entries.filter((e) => e.answer && !e.confirm).map((e) => e.id));
  let answered = 0;
  for (const a of out.answers) {
    const q = batch[a.n - 1];
    if (!q || !a.answer?.trim() || a.confidence < 0.85) continue;
    if (BANK_ONLY.has(q.category ?? '') && !(a.answerId && bankIds.has(a.answerId))) continue;
    let answer = a.answer.trim();
    const freeText = (q.type === 'text' || q.type === 'textarea') && !q.options?.length && answer.length > 60;
    if (freeText && !guardText(answer, facts).ok) continue;
    // Searchable lists: keep his value even when the visible options don't contain it (the filler searches).
    if (q.options?.length && !q.options.some((o) => o.toLowerCase() === answer.toLowerCase())) {
      const hit = q.options.find((o) => o.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(o.toLowerCase()));
      if (hit) answer = hit;
    }
    const res = answerQuestion(q.id, answer, { via: 'saved', now });
    if (res.ok) {
      answered++;
      log.info('telegram', `answered "${q.label.slice(0, 80)}" from what Pursuit knows`, { basis: a.basis, answer: answer.slice(0, 120) });
    }
  }
  return answered;
}

// ───────────────────────────── 2. One message, up to 10 questions ─────────────────────────────

function hint(q: PendingQuestion): string {
  const opts = (q.options ?? []).filter((o) => !/^(select|choose|please select|--)/i.test(o.trim()));
  const yesNo = opts.length === 2 && opts.every((o) => /^(yes|no)$/i.test(o.trim()));
  if (((q.type === 'yesno' || q.type === 'checkbox') && opts.length <= 1) || yesNo || q.category === 'attestation') return ' (yes/no)';
  if (opts.length && opts.length <= 6) return ` (${opts.join(' / ')})`;
  return '';
}

/** The questions to send now, or [] if a digest went out recently and nothing new arrived. */
export function digestDue(now: Date = new Date()): PendingQuestion[] {
  const open = pendingQuestions().filter((q) => q.waiting.length);
  if (!open.length) return [];
  const last = currentDigest();
  const unsent = open.filter((q) => q.sentSeq < q.askSeq);
  if (!unsent.length) return [];
  if (last && now.getTime() - Date.parse(last.sentAt) < DIGEST_MIN_GAP_MS) return [];
  // Re-include still-open questions from the last digest so one message always lists everything open.
  return open.slice(0, DIGEST_MAX);
}

export function composeDigest(qs: PendingQuestion[]): string {
  const lines = qs.map((q, i) => `${i + 1}. ${q.label.replace(/\s+/g, ' ').trim()}${hint(q)}`);
  return [`${qs.length} question${qs.length === 1 ? '' : 's'}:`, '', ...lines, '', 'Reply in one message, e.g. "1 yes, 2 DkIT". Say "skip 3" to leave one for the dashboard.'].join('\n');
}

export function recordDigest(messageId: number, qs: PendingQuestion[], now: Date): void {
  kvSet(DIGEST_KEY, { messageId, ids: qs.map((q) => q.id), sentAt: now.toISOString() } satisfies Digest);
  for (const q of qs) markQuestionSent(q.id, q.askSeq, messageId, now);
}

// ───────────────────────────── 3. His one reply → answers ─────────────────────────────

const MapSchema = z.object({
  answers: z.array(z.object({ n: z.coerce.number().int(), answer: z.coerce.string().max(1500) })).max(DIGEST_MAX).catch([]),
  skip: z.array(z.coerce.number().int()).max(DIGEST_MAX).catch([]),
  remember: z.string().max(1500).nullable().optional(),
  reply: z.string().max(1500).nullable().optional(),
});

/** Splits "1 yes, 2 DkIT" / "1. yes\n2) DkIT" deterministically. Returns null when it doesn't look numbered. */
export function parseNumbered(text: string, count: number): { answers: Map<number, string>; skip: Set<number> } | null {
  const answers = new Map<number, string>();
  const skip = new Set<number>();
  const parts = text.split(/(?:^|\n|,|;)\s*(?=\d{1,2}\s*[.):\-]?\s+\S)/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    const m = /^(\d{1,2})\s*[.):\-]?\s+([\s\S]+)$/.exec(p);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count) continue;
    const v = m[2].trim().replace(/[,;]\s*$/, '');
    if (/^skip$/i.test(v)) skip.add(n);
    else answers.set(n, v);
  }
  const skipped = /\bskip\s+(\d{1,2})\b/gi;
  for (let m = skipped.exec(text); m; m = skipped.exec(text)) skip.add(Number(m[1]));
  return answers.size || skip.size ? { answers, skip } : null;
}

export interface DigestReplyResult { answered: string[]; failed: string[]; skipped: string[]; reply?: string }

/** Applies his reply to the open digest. Returns null when the message doesn't answer anything (it's chat). */
export async function applyDigestReply(text: string, now: Date = new Date()): Promise<DigestReplyResult | null> {
  const digest = currentDigest();
  if (!digest) return null;
  // Numbers stay as they were in the message he's looking at: an already-answered question keeps its slot.
  const open = new Map(pendingQuestions().map((q) => [q.id, q]));
  const qs = digest.ids.map((id) => open.get(id));
  if (!qs.some(Boolean)) return null;
  let answers = new Map<number, string>();
  let skip = new Set<number>();
  let remember: string | null | undefined;
  let reply: string | null | undefined;
  const numbered = parseNumbered(text, qs.length);
  if (numbered) ({ answers, skip } = numbered);
  else if (hasLLM()) {
    const out = await llmJSON({
      purpose: 'telegram.mapreply',
      system: 'Kayzee replied to numbered job-application questions. Map his message to the questions it answers (keep his words; for option questions use the closest option text). Questions he did not answer: leave out. If he also stated a general fact about himself, put it in "remember". If the message is not an answer at all, return answers: [] and put a short helpful reply in "reply". Return JSON {"answers":[{n,answer}],"skip":[n],"remember":string|null,"reply":string|null}.',
      user: `QUESTIONS:\n${qs.map((q, i) => (q ? describe(q, i + 1) : `${i + 1}. (already answered)`)).join('\n')}\n\n${untrusted('his reply', text, 3000)}`,
      schema: MapSchema,
      maxTokens: 900,
      temperature: 0.1,
    });
    if (out) {
      for (const a of out.answers) if (a.n >= 1 && a.n <= qs.length) answers.set(a.n, a.answer);
      for (const n of out.skip) skip.add(n);
      remember = out.remember;
      reply = out.reply;
    }
  }
  if (!answers.size && !skip.size) return null;
  const res: DigestReplyResult = { answered: [], failed: [], skipped: [] };
  for (const [n, value] of answers) {
    const q = qs[n - 1];
    if (!q) { res.answered.push(`${n} (already done)`); continue; }
    const r = answerQuestion(q.id, value, { via: 'telegram', now });
    if (r.ok) res.answered.push(`${n}`);
    else res.failed.push(`${n} (${(r.error ?? 'not accepted').split('\n')[0].slice(0, 90)})`);
  }
  for (const n of skip) {
    const q = qs[n - 1];
    if (!q) continue;
    dismissQuestion(q.id, now); // stays in Needs you on the dashboard
    res.skipped.push(`${n}`);
  }
  if (remember?.trim()) rememberNote(remember.trim(), now);
  if (reply) res.reply = reply;
  return res;
}

// ───────────────────────────── 4. Real answers to anything else ─────────────────────────────

/** Saves something he said about himself so future answers (and the Coach) can use it. */
export function rememberNote(note: string, now: Date = new Date()): void {
  try {
    const file = notesFile();
    let s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!s.includes(NOTES_HEADING)) s = `${s.trimEnd()}\n\n${NOTES_HEADING}\n`;
    s = `${s.trimEnd()}\n- (${now.toISOString().slice(0, 10)}) ${note.replace(/\s+/g, ' ').slice(0, 600)}\n`;
    fs.writeFileSync(file, s);
  } catch (err) {
    log.warn('telegram', 'could not save a note', { error: (err as Error).message });
  }
}

function statusSnapshot(): string {
  const c = countByStatus();
  const applied = listJobs({ status: ['applied', 'replied', 'interview', 'offer'], orderBy: 'updatedAt', dir: 'desc', limit: 10 });
  const inflight = listJobs({ status: ['approved', 'applying', 'needs_you'], orderBy: 'updatedAt', dir: 'desc', limit: 12 });
  const recent = listEvents({ typePrefix: 'apply.', limit: 15 }).map((e) => `${e.ts.slice(5, 16)} ${e.type} ${getJob(e.jobId ?? '')?.company ?? ''}`);
  return [
    `COUNTS: ${JSON.stringify(Object.fromEntries(Object.entries(c).filter(([, n]) => n)))}`,
    `APPLIED: ${applied.map((j) => `${j.company}: ${j.title} (${j.status})`).join('; ') || 'none yet'}`,
    `IN FLIGHT: ${inflight.map((j) => `${j.company}: ${j.title} [${j.status}${j.needs?.length ? `: ${j.needs[0].slice(0, 80)}` : ''}]`).join('; ') || 'none'}`,
    `OPEN QUESTIONS: ${pendingQuestions().length}`,
    `RECENT: ${recent.join(' | ')}`,
  ].join('\n');
}

const ChatSchema = z.object({ reply: z.string().min(1).max(1500), remember: z.string().max(1000).nullable().optional() });

/** A real reply to a free-form message (status questions, instructions, facts about himself). */
export async function assistantReply(text: string, now: Date = new Date()): Promise<string> {
  if (!hasLLM()) return 'The AI is offline right now (no OpenRouter key). Send /status for counts.';
  const out = await llmJSON({
    purpose: 'telegram.chat',
    system: [
      "You are Pursuit, Kayzee's job-application assistant, talking on Telegram. Be brief and direct (1-4 short lines), no fluff, no em dashes.",
      'Answer from the STATUS data below. Never claim something was submitted unless it is listed under APPLIED.',
      'If he tells you a fact about himself (experience, preferences, availability), say you saved it and put it in "remember".',
      'You cannot change settings from chat except via /pause and /resume; tell him those commands if relevant.',
      'Return JSON {"reply": string, "remember": string|null}.',
    ].join('\n'),
    user: `STATUS:\n${statusSnapshot()}\n\n${untrusted('his message', text, 2000)}`,
    schema: ChatSchema,
    maxTokens: 500,
    temperature: 0.3,
  });
  if (!out) return "Sorry, I couldn't think that through just now. Try again in a minute, or send /status.";
  if (out.remember?.trim()) rememberNote(out.remember.trim(), now);
  return out.reply.replace(/\s+[—–]\s+/g, ', ');
}
