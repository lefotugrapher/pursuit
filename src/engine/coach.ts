// Career coach: a chat that interviews Kayzee to grow his fact bank, so CVs and letters get better.
// It sees everything Pursuit knows about him (facts, profile, unconfirmed answers) and what the job
// postings keep asking for that his facts can't back (gaps). It asks one focused question at a time
// and turns what he SAYS into proposed facts. Nothing is added to facts.json until he approves it.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadAnswers, loadFacts, loadProfile, saveAnswers, saveFacts } from '@/lib/config';
import { db, kvGet, kvSet, listJobs, logEvent, setStatus } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import type { Fact, FactBank } from '@/lib/types';
import { CONFIG_DIR } from '@/lib/paths';

/** Private background on Kayzee (CV detail, business numbers, open questions). Local file, never committed. */
function backgroundNotes(): string {
  try {
    return fs.readFileSync(path.join(CONFIG_DIR, 'coach-context.md'), 'utf8').slice(0, 12000);
  } catch {
    return '(no background file yet)';
  }
}

const STOP = new Set(['the','a','an','and','or','of','to','in','on','for','with','you','your','what','which','how','did','do','is','was','were','at','by','from','that','this','it','about','can','could','would','please','me','tell','any','some','exactly','behind']);
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9% ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** True when `question` is essentially one already asked (most of its content words appear in an earlier question). */
export function isRepeat(question: string, asked: string[]): boolean {
  const w = words(question);
  if (w.size < 3) return false;
  return asked.some((a) => {
    const aw = words(a);
    const shared = [...w].filter((x) => aw.has(x)).length;
    return shared / Math.min(w.size, aw.size || 1) >= 0.5;
  });
}

const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/gi;
const YEARS = /\b(?:19|20)\d{2}\b/g;
const NUMBERS = /\d[\d,.]*/g;

/** Every number, month and year in `text`, normalised for comparison. */
function specifics(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.match(NUMBERS) ?? []) out.add(m.replace(/[,.]$/, '').replace(/,/g, ''));
  for (const m of text.match(YEARS) ?? []) out.add(m);
  for (const m of text.match(MONTHS) ?? []) out.add(m.slice(0, 3).toLowerCase());
  return out;
}

/** A proposed fact may only use numbers, months and years that Kayzee said or that are already in his records. */
export function factIsGrounded(text: string, sources: string): boolean {
  const have = specifics(sources);
  return [...specifics(text)].every((x) => have.has(x));
}

/** Word-overlap similarity, used to skip facts already in the bank. */
function similar(a: string, b: string): boolean {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  const shared = [...A].filter((x) => B.has(x)).length;
  return shared / new Set([...A, ...B]).size >= 0.5;
}

/** Questions the coach already asked, so it never repeats one. */
function questionsAsked(turns: CoachTurn[]): string[] {
  return turns.filter((t) => t.role === 'coach').flatMap((t) => (t.text.match(/[^.?!]*\?/g) ?? []).map((q) => q.trim())).slice(-30);
}

const THREAD_KEY = 'coach.thread';
const MAX_TURNS_IN_PROMPT = 24;

export interface ProposedFact {
  key: string;                    // stable within the thread, for approve/dismiss
  text: string;
  kind: Fact['kind'];
  org?: string;
  title?: string;
  tags: string[];
  numbers: string[];
  status: 'pending' | 'added' | 'dismissed';
  factId?: string;
}

export interface ProposedAnswer {
  key: string;
  answerId: string;               // AnswerEntry id
  question: string;
  answer: string;
  status: 'pending' | 'added' | 'dismissed';
}

export interface CoachTurn {
  role: 'coach' | 'you';
  text: string;
  ts: string;
  facts?: ProposedFact[];
  answers?: ProposedAnswer[];
}

export function loadThread(): CoachTurn[] {
  return kvGet<CoachTurn[]>(THREAD_KEY) ?? [];
}

function saveThread(turns: CoachTurn[]): void {
  kvSet(THREAD_KEY, turns.slice(-200));
}

export function resetThread(): void {
  kvSet(THREAD_KEY, []);
}

/** What the job postings ask for most often that the fact bank can't back. */
export function topGaps(limit = 15): { term: string; jobs: number }[] {
  const counts = new Map<string, number>();
  for (const j of listJobs({ status: ['scored', 'ready', 'approved', 'applied', 'needs_you'], limit: 1000 })) {
    for (const g of new Set((j.keywords?.gaps ?? []).map((x) => x.toLowerCase()))) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, jobs]) => ({ term, jobs }));
}

const ReplySchema = z.object({
  reply: z.string().min(1).max(2500),
  proposedFacts: z.array(z.object({
    text: z.string().min(8).max(400),
    kind: z.enum(['role', 'achievement', 'education', 'project', 'skill', 'tool', 'award', 'other']).catch('other'),
    org: z.string().max(120).optional().nullable(),
    title: z.string().max(120).optional().nullable(),
    tags: z.array(z.string().max(40)).max(10).catch([]),
    numbers: z.array(z.string().max(40)).max(10).catch([]),
  })).max(6).catch([]),
  answerUpdates: z.array(z.object({
    answerId: z.string().max(80),
    answer: z.string().min(1).max(400),
  })).max(4).catch([]),
});

function systemPrompt(): string {
  return [
    "You are Kayzee's career coach inside Pursuit, his private job-search tool. You know him well from the BACKGROUND and FACTS below.",
    'Your job: ask him specific, informed questions that draw out true, measurable detail for his CV and letters.',
    '',
    'How to ask:',
    '- Refer to something concrete from BACKGROUND, such as a named campaign, number, role or business. Never a generic',
    '  question like "tell me about a time you worked in a team". That is banned.',
    '- Ask ONE question per reply, and make it answerable in one or two sentences.',
    '- Never repeat or closely reword a question listed under ALREADY ASKED. Move to a different topic if needed.',
    '- If he answers, acknowledge the specific thing he said in one short sentence, then ask the next specific question.',
    '- If he sends a short or off-topic message (e.g. "hi", "which one", "?"), answer it plainly in one line and then ask',
    '  the next specific question. Do not restart the conversation.',
    '- No flattery ("great question", "great to meet you"). No em dashes. Plain, warm, brief.',
    '- Prefer, in this order: missing numbers (results, audiences, periods, baselines), what he personally did,',
    '  tools used, and the GAPS list (ask "have you done X?" only, never assume).',
    '',
    'Facts rules:',
    '- proposedFacts: ONLY things Kayzee himself stated in this conversation. Never invent, inflate or round up.',
    '  Keep his numbers exactly. Write each as a short, CV-ready statement. Skip anything already in FACTS.',
    '- If he is vague, ask a follow-up instead of proposing a fact.',
    '- When he gives a concrete result with a number, you MUST put it in proposedFacts (unless already in FACTS).',
    '- Never state a date range, figure or detail that is not in BACKGROUND or FACTS. If you need it, ask for it.',
    '- Do not summarise or restate what he said back to him at length. One short acknowledgement, then the question.',
    '- answerUpdates: only when he clearly answers one of the UNCONFIRMED ANSWERS (use its exact id).',
    '- Never ask for passwords, bank details, PPS numbers or other sensitive identifiers.',
    '',
    'Return JSON: {"reply": string, "proposedFacts": [{text, kind, org?, title?, tags[], numbers[]}], "answerUpdates": [{answerId, answer}]}.',
  ].join('\n');
}

function contextBlock(facts: FactBank, turns: CoachTurn[]): string {
  const profile = loadProfile();
  const answers = loadAnswers().entries.filter((e) => e.confirm);
  const gaps = topGaps();
  return [
    `PROFILE: ${profile.name.full} (${profile.name.preferred}), ${profile.location}. Targets: ${profile.targets.roles.slice(0, 8).join(', ')}.`,
    `BACKGROUND:\n${backgroundNotes()}`,
    `FACTS (already known, true):\n${facts.facts.map((f) => `- [${f.id}] ${f.text}`).join('\n')}`,
    `SKILLS: ${facts.skills.join(', ')}\nTOOLS: ${facts.tools.join(', ')}`,
    `DO NOT CLAIM (unconfirmed so far; ask about these if useful): ${facts.doNotClaim.slice(0, 40).join(', ')}`,
    `GAPS (job postings ask for these; his facts don't cover them; count = number of jobs): ${gaps.map((g) => `${g.term} (${g.jobs})`).join(', ') || 'none yet'}`,
    `UNCONFIRMED ANSWERS (screening answers he hasn't confirmed): ${answers.map((a) => `[${a.id}] ${a.patterns[0]} → current: "${a.answer}"`).join('; ') || 'none'}`,
    `ALREADY ASKED (never repeat these):\n${questionsAsked(turns).map((q) => `- ${q}`).join('\n') || '- none yet'}`,
  ].join('\n\n');
}

function transcript(turns: CoachTurn[]): string {
  return turns.slice(-MAX_TURNS_IN_PROMPT).map((t) => `${t.role === 'you' ? 'KAYZEE' : 'COACH'}: ${t.text}`).join('\n');
}

function keyFor(i: number, ts: string): string {
  return `${ts.replace(/\D/g, '').slice(-10)}-${i}`;
}

function fallbackReply(): string {
  const gaps = topGaps(3).map((g) => g.term);
  return gaps.length
    ? `The coach needs the AI connection (OpenRouter) to chat. Meanwhile: jobs keep asking for ${gaps.join(', ')}. If you've done any of these, add them as facts in Settings → Fact bank.`
    : 'The coach needs the AI connection (OpenRouter) to chat. Add OPENROUTER_API_KEY to .env.local.';
}

/** One exchange. `message` empty = let the coach open the conversation. */
export async function coachReply(message: string): Promise<CoachTurn[]> {
  const turns = loadThread();
  const now = new Date().toISOString();
  const said = message.trim();
  if (said) turns.push({ role: 'you', text: said.slice(0, 4000), ts: now });

  const facts = loadFacts();
  let turn: CoachTurn;
  if (!hasLLM()) {
    turn = { role: 'coach', text: fallbackReply(), ts: new Date().toISOString() };
  } else {
    const opening = turns.length === 0
      ? 'Start the conversation: one short line of greeting, then ask your single most valuable specific question from BACKGROUND (a named campaign or number that is missing a result).'
      : 'Reply to his latest message in one line, then ask the next specific question. Do not repeat anything under ALREADY ASKED.';
    const call = (extra: string) => llmJSON({
      purpose: 'coach.chat',
      system: systemPrompt(),
      user: [contextBlock(facts, turns), untrusted('conversation', transcript(turns), 16000), opening, extra].filter(Boolean).join('\n\n'),
      schema: ReplySchema,
      maxTokens: 1200,
      temperature: 0.4,
    });
    let out = await call('');
    const asked = questionsAsked(turns);
    if (out && isRepeat(out.reply, asked)) {
      out = (await call('CORRECTION: your last draft repeated a question already asked. Ask about a DIFFERENT specific detail from BACKGROUND.')) ?? out;
    }
    if (out && isRepeat(out.reply, asked)) {
      // Still repeating after a retry: never show the same question twice.
      out = { ...out, reply: 'Thanks, noted. Tell me about the one result from your work you are most proud of, with the number if you have it.' };
    }
    if (out && out.proposedFacts.length === 0 && /\d/.test(said) && said.length > 40) {
      out = (await call('CORRECTION: Kayzee gave a concrete answer with a number. Capture it in proposedFacts as a CV-ready fact (keep his numbers exactly), then ask the next question.')) ?? out;
    }
    const ts = new Date().toISOString();
    if (!out) {
      turn = { role: 'coach', text: "Sorry, I couldn't reach the AI just now. Try sending that again in a moment.", ts };
    } else {
      const known = new Set(facts.facts.map((f) => f.text.toLowerCase().trim()));
      const validAnswerIds = new Set(loadAnswers().entries.map((e) => e.id));
      turn = {
        role: 'coach',
        text: out.reply.replace(/\s+[—–]\s+/g, ', '),
        ts,
        facts: out.proposedFacts
          .filter((f) => !known.has(f.text.toLowerCase().trim()))
          .filter((f) => !facts.facts.some((e) => similar(e.text, f.text)))
          .filter((f) => factIsGrounded(f.text, [...turns.filter((t) => t.role === 'you').map((t) => t.text), JSON.stringify(facts), backgroundNotes()].join('\n')))
          .map((f, i) => ({ key: keyFor(i, ts), text: f.text.trim(), kind: f.kind, org: f.org ?? undefined, title: f.title ?? undefined, tags: f.tags, numbers: f.numbers, status: 'pending' as const })),
        answers: out.answerUpdates
          .filter((a) => validAnswerIds.has(a.answerId))
          .map((a, i) => ({
            key: keyFor(100 + i, ts),
            answerId: a.answerId,
            question: loadAnswers().entries.find((e) => e.id === a.answerId)?.patterns[0] ?? a.answerId,
            answer: a.answer.trim(),
            status: 'pending' as const,
          })),
      };
    }
  }
  turns.push(turn);
  saveThread(turns);
  return turns;
}

function slugId(text: string, existing: Set<string>): string {
  const base = `coach-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-')}` || 'coach-fact';
  let id = base;
  for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
  return id;
}

function findProposal<T extends { key: string }>(turns: CoachTurn[], key: string, pick: (t: CoachTurn) => T[] | undefined): T | undefined {
  for (const t of turns) {
    const hit = pick(t)?.find((p) => p.key === key);
    if (hit) return hit;
  }
  return undefined;
}

/** Adds an approved proposal to facts.json (optionally with Kayzee's edited wording). */
export function approveFact(key: string, editedText?: string): { ok: boolean; message: string; factId?: string } {
  const turns = loadThread();
  const p = findProposal(turns, key, (t) => t.facts);
  if (!p) return { ok: false, message: 'That suggestion no longer exists.' };
  if (p.status !== 'pending') return { ok: false, message: `Already ${p.status}.` };
  const text = (editedText ?? p.text).trim();
  if (text.length < 8) return { ok: false, message: 'The fact is too short.' };
  const bank = loadFacts();
  const id = slugId(text, new Set(bank.facts.map((f) => f.id)));
  const numbers = [...new Set([...(p.numbers ?? []), ...(text.match(/\d[\d,.:%]*/g) ?? [])].filter((n) => text.includes(n)))];
  const fact: Fact = { id, kind: p.kind, text, tags: [...new Set([...(p.tags ?? []), 'from-coach'])], ...(p.org ? { org: p.org } : {}), ...(p.title ? { title: p.title } : {}), ...(numbers.length ? { numbers } : {}) };
  saveFacts({ ...bank, facts: [...bank.facts, fact] });
  p.status = 'added';
  p.factId = id;
  p.text = text;
  saveThread(turns);
  logEvent('coach.fact_added', { factId: id, text });
  return { ok: true, message: 'Added to your fact bank.', factId: id };
}

export function approveAnswer(key: string): { ok: boolean; message: string } {
  const turns = loadThread();
  const p = findProposal(turns, key, (t) => t.answers);
  if (!p) return { ok: false, message: 'That suggestion no longer exists.' };
  if (p.status !== 'pending') return { ok: false, message: `Already ${p.status}.` };
  const bank = loadAnswers();
  const entry = bank.entries.find((e) => e.id === p.answerId);
  if (!entry) return { ok: false, message: 'That screening question no longer exists.' };
  saveAnswers({ entries: bank.entries.map((e) => (e.id === p.answerId ? { ...e, answer: p.answer, confirm: false } : e)) });
  p.status = 'added';
  saveThread(turns);
  logEvent('coach.answer_confirmed', { answerId: p.answerId });
  return { ok: true, message: 'Screening answer saved and confirmed.' };
}

export function dismissProposal(key: string): { ok: boolean; message: string } {
  const turns = loadThread();
  const p = findProposal(turns, key, (t) => t.facts) ?? findProposal(turns, key, (t) => t.answers);
  if (!p) return { ok: false, message: 'That suggestion no longer exists.' };
  p.status = 'dismissed';
  saveThread(turns);
  return { ok: true, message: 'Dismissed.' };
}

/** Facts the coach added after `iso` (used to nudge a re-tailor). */
export function coachFactsSince(iso: string): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'coach.fact_added' AND ts > ?").get(iso) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Sends every 'ready' (not yet approved) application back to be re-tailored with the current fact bank. */
export function retailorReady(): number {
  const ready = listJobs({ status: 'ready', limit: 1000 });
  for (const j of ready) setStatus(j.id, 'scored', { reason: 'retailor', by: 'kayzee' });
  logEvent('coach.retailor', { jobs: ready.length });
  return ready.length;
}
