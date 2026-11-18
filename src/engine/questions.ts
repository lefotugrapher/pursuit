// Question queue: required screening questions Pursuit couldn't answer, deduped by normalised label
// across jobs (one question, many waiting jobs). Server-only.
//
// Flow: the apply runner parks a job in needs_you → queueQuestionsFromFill()/queueQuestion() → the
// Telegram bot asks Kayzee → answerQuestion() validates his reply, saves it to config/answers.json
// as a learned entry (confirm:false: he answered it himself), writes it into each waiting job's
// answers artifact (the apply runner reads that first), and moves every job whose questions are now
// all answered, and that has no other blocker, back to 'approved' so the worker re-applies.
//
// Never guesses (SPEC §0.1/§0.3):
// - EEO/demographic questions and file uploads are never queued: they stay hand-offs.
// - Sensitive questions (visa/sponsorship, right to work, salary, criminal record, health/
//   disability, legal attestations) are only answered by Kayzee and remembered for that exact
//   wording only (anchored pattern). Attestations are always yes/no with the full text shown.
// - "Why this company" style answers are kept for that one application, never put in the bank.
// - Only his own earlier answer to the very same question is ever reused automatically.
//
// State lives in kv 'questions.pending' ({version, questions[]}, open + recent answered history).

import crypto from 'node:crypto';
import { loadAnswers, saveAnswers } from '@/lib/config';
import { addArtifact, getJob, kvGet, kvSet, latestArtifact, listEvents, logEvent, setStatus, STATUS_EVENT, tx, updateJob } from '@/lib/db';
import { log } from '@/lib/log';
import { dublinDate } from '@/lib/time';
import type { AnswerBank, AnswerEntry, AnsweredQuestion, JobStatus, ScreeningQuestion } from '@/lib/types';
import { isAttestationLabel, isEeoLabel } from '@/engine/apply/fields';
import { fitAnswer, mapOption, normaliseLabel } from '@/engine/tailor/answers';
import { notifyTelegram } from '@/engine/telegram/outbox';

type QType = ScreeningQuestion['type'];

export const QUESTIONS_KEY = 'questions.pending';
export const LEARNED_PREFIX = 'learned-';
/** Times an answer may be written into one job for one question before Pursuit stops retrying. */
export const MAX_ATTEMPTS_PER_JOB = 2;
export const MAX_ANSWER_CHARS = 3000;
/** Attestations longer than this can't be shown in full in one Telegram message, so they stay hand-offs. */
export const MAX_ATTESTATION_CHARS = 3000;
const MAX_LABEL_CHARS = 3200;
const MAX_RECORDS = 300;
const KEEP_CLOSED_MS = 60 * 86_400_000;

/** Statuses where nothing waits on a question any more. */
const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['applied', 'replied', 'interview', 'offer', 'rejected', 'withdrawn', 'skipped', 'filtered_out']);

// ───────────────────────────── Normalisation + classification ─────────────────────────────

/** Dedupe key: lowercase, no accents/punctuation/asterisks, no "(required)" or trailing "required". */
export function questionKey(label: string): string {
  return normaliseLabel(label)
    .replace(/\s*\bthis (?:field|question) is (?:required|mandatory)$/, '')
    .replace(/^(?:(?:required|optional|mandatory)\s+)+/, '')
    .replace(/(?:\s+(?:required|optional|mandatory))+$/, '')
    .trim();
}

export function questionId(key: string): string {
  return `q${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}

export type SensitiveCategory = 'attestation' | 'visa' | 'right_to_work' | 'salary' | 'criminal_record' | 'health';

export const SENSITIVE_LABELS: Record<SensitiveCategory, string> = {
  attestation: 'legal attestation',
  visa: 'visa/sponsorship',
  right_to_work: 'right to work',
  salary: 'salary',
  criminal_record: 'criminal record',
  health: 'health/disability',
};

// Matched against the normalised label (lowercase words, no punctuation). Erring broad is safe:
// a false positive only means Kayzee is asked and the answer is kept for that exact wording.
const SENSITIVE_RULES: [Exclude<SensitiveCategory, 'attestation'>, RegExp][] = [
  ['visa', /\b(visas?|sponsor(ship|ed|ing|s)?|work permits?|employment permits?|immigration|stamp ?[1-4][a-z]?|green ?card|residence permits?|residency|permission to (work|remain)|critical skills)\b/],
  ['right_to_work', /\b(rights? to work|authori[sz]ed to work|authori[sz]ation to work|work authori[sz]ation|employment authori[sz]ation|eligib(le|ility) (to|for) (work|employment)|(legally|lawfully) (able|allowed|entitled|permitted|eligible) to work|entitled to work|permitted to work|citizen(s|ship)?|nationality|eu national|eea national)\b/],
  ['salary', /\b(salary|salaries|compensation|remuneration|wages?|pay (expectations?|range|rate|requirements?)|rate of pay|expected pay|desired pay|current pay|day rate|daily rate|hourly rate|ctc|earnings?|package expectations?|bonus expectations?)\b/],
  ['criminal_record', /\b(criminal|convict(ed|ions?)|offen[cs]es?|garda vetting|vetting|police (checks?|clearance|records?|certificates?|cautions?)|background checks?|pending charges?|charged with|felon(y|ies)|misdemeanou?rs?|dbs|disclosure and barring|access ?ni|prosecut\w*)\b/],
  ['health', /\b(disabilit(y|ies)|disabled|health|medical|illness(es)?|impairments?|reasonable (adjustments?|accommodations?)|accommodations?|neuro ?divergen\w*|mental|pregnan\w*|sick(ness)?|vaccinat\w*|allerg(y|ies|ic)|medications?)\b/],
];

/** Which sensitive category a question falls in, if any (attestations first: their wording is legal). */
export function sensitiveCategory(label: string): SensitiveCategory | null {
  if (isAttestationLabel(label)) return 'attestation';
  const norm = normaliseLabel(label);
  for (const [category, re] of SENSITIVE_RULES) if (re.test(norm)) return category;
  return null;
}

/** Answers that only make sense for one employer: kept on that job, never put in the bank. */
const JOB_SPECIFIC_RE = /\bwhy\b|\bwhat (interests|attracts|excites|appeals to|draws) you\b|\bwhat makes you (want|interested|a good fit|the right)\b|\bmotivat\w*|\bcover(ing)? letter\b|\bwhat do you know about (us|our|the company)\b|\banything else\b|\badditional (information|comments)\b/;

/** Questions whose answer must not be stretched to similar wording (numbers, experience claims). */
const EXACT_ONLY_RE = /\b(experience|years?)\b/;

// ───────────────────────────── Records ─────────────────────────────

export interface WaitingJob {
  jobId: string;
  /** The form field's id/name: the apply runner matches answers artifact entries on it. */
  fieldId: string;
  label: string;
  type: QType;
  options?: string[];
  queuedAt: string;
}

export type QuestionStatus = 'open' | 'answered' | 'dismissed';
export type AnswerVia = 'telegram' | 'dashboard' | 'saved';

export interface PendingQuestion {
  id: string;
  /** Dedupe key: questionKey(label), plus '#<jobId>' for job-specific questions. */
  key: string;
  /** questionKey(label). */
  labelKey: string;
  label: string;
  type: QType;
  options?: string[];
  category?: SensitiveCategory;
  /** 'job' = the answer is for one application only and never goes in the bank. */
  scope: 'shared' | 'job';
  status: QuestionStatus;
  /** Jobs blocked on this question (while open). */
  waiting: WaitingJob[];
  /** jobId → how many times an answer to this question was written into that job (retry guard). */
  applied: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  answer?: string;
  answerId?: string;
  answeredAt?: string;
  answeredVia?: AnswerVia;
  /** Extra context for Kayzee when the question is asked again. */
  note?: string;
  /** Bumped whenever the question must be (re)sent; the bot sends while sentSeq < askSeq. */
  askSeq: number;
  sentSeq: number;
  telegramMessageId?: number;
  sentAt?: string;
}

interface QuestionStore { version: 1; questions: PendingQuestion[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function normaliseRecord(raw: Record<string, unknown>): PendingQuestion | null {
  if (typeof raw.id !== 'string' || typeof raw.key !== 'string' || typeof raw.label !== 'string') return null;
  const q = raw as unknown as PendingQuestion;
  return {
    ...q,
    labelKey: typeof q.labelKey === 'string' ? q.labelKey : questionKey(q.label),
    scope: q.scope === 'job' ? 'job' : 'shared',
    status: q.status === 'answered' || q.status === 'dismissed' ? q.status : 'open',
    waiting: Array.isArray(q.waiting) ? q.waiting.filter((w) => isObj(w) && typeof w.jobId === 'string') : [],
    applied: isObj(q.applied) ? q.applied : {},
    askSeq: Number(q.askSeq) || 0,
    sentSeq: Number(q.sentSeq) || 0,
  };
}

function readStore(): QuestionStore {
  const v = kvGet<{ questions?: unknown }>(QUESTIONS_KEY);
  const list: unknown[] = Array.isArray(v?.questions) ? v.questions : [];
  return { version: 1, questions: list.filter(isObj).map(normaliseRecord).filter((q): q is PendingQuestion => q !== null) };
}

function writeStore(store: QuestionStore): void {
  kvSet(QUESTIONS_KEY, store);
}

const PLACEHOLDER_OPTION_RE = /^(?:[-–—\s]*)(?:please\s+)?(?:select|choose|pick)\b.*$|^[-–—_.\s]*$/i;

/** Option list without placeholders ("Select...") or duplicates; undefined when nothing is left. */
export function cleanOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined;
  const out: string[] = [];
  for (const o of options) {
    if (typeof o !== 'string') continue;
    const t = o.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!t || PLACEHOLDER_OPTION_RE.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= 100) break;
  }
  return out.length ? out : undefined;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ───────────────────────────── Answer bank entries ─────────────────────────────

const EXACT_HEAD = '/^(?:(?:required|optional) )?';
const EXACT_TAIL = '(?: (?:required|optional))?$/';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Slash-delimited, anchored regex on the normalised label: tailor/answers.ts only ever matches it
 * against this exact question. (The apply-time bank fallback never matches it either, so the answer
 * reaches forms through the job's answers artifact, which tailoring fills from the bank.)
 */
export function exactPattern(key: string): string {
  return `${EXACT_HEAD}${escapeRegex(key)}${EXACT_TAIL}`;
}

/** The question key an entry pattern was made from (plain key or exactPattern). */
export function keyFromPattern(pattern: string): string {
  if (pattern.startsWith(EXACT_HEAD) && pattern.endsWith(EXACT_TAIL)) {
    return pattern.slice(EXACT_HEAD.length, pattern.length - EXACT_TAIL.length).replace(/\\(.)/g, '$1');
  }
  return pattern;
}

const LEADING = [
  'please', 'kindly', 'briefly', 'what is', 'what are', 'what was', 'whats', 'which is', 'which are', 'how long is', 'how long',
  'do you have', 'do you', 'are you', 'have you', 'can you', 'could you', 'would you', 'will you', 'did you', 'is there',
  'is your', 'state', 'provide', 'enter', 'confirm', 'indicate', 'specify', 'list', 'describe', 'tell us', 'let us know',
  'share', 'give', 'your', 'the', 'a', 'an', 'any',
].sort((a, b) => b.length - a.length);
const TRAILING = [
  'for this role', 'for this position', 'for this job', 'for the role', 'for the position', 'in this role', 'if applicable',
  'if any', 'if so', 'if yes', 'please specify', 'please explain', 'please provide details', 'please describe', 'with us',
  'for us', 'currently', 'at present', 'at the moment',
].sort((a, b) => b.length - a.length);
const GENERIC = new Set([
  'additional information', 'more information', 'other information', 'anything else', 'your answer', 'please specify',
  'comments', 'other details', 'more details', 'further details', 'your response', 'please explain', 'details',
]);

function stripEdges(s: string, list: string[], fromStart: boolean): string {
  let out = s;
  for (let changed = true; changed;) {
    changed = false;
    for (const p of list) {
      if (fromStart && out.startsWith(`${p} `)) {
        out = out.slice(p.length + 1);
        changed = true;
      } else if (!fromStart && out.endsWith(` ${p}`)) {
        out = out.slice(0, -(p.length + 1));
        changed = true;
      }
    }
  }
  return out.trim();
}

/** Up to two shorter phrasings of a key that still say the same thing ("what is your notice period" → "notice period"). */
export function shorterVariants(key: string): string[] {
  const out: string[] = [];
  const v1 = stripEdges(key, LEADING, true);
  const v2 = stripEdges(v1, TRAILING, false);
  for (const v of [v1, v2]) {
    if (v === key || out.includes(v) || GENERIC.has(v)) continue;
    if (v.split(' ').length < 2 || v.length < 8) continue;
    if (sensitiveCategory(v) || isEeoLabel(v)) continue;
    out.push(v);
  }
  return out.slice(0, 2);
}

/** Bank patterns for a learned answer: exact wording for sensitive/numeric/experience questions, else key + variants. */
export function learnedPatterns(key: string, opts: { category?: SensitiveCategory | null; type?: QType } = {}): string[] {
  if (opts.category || opts.type === 'number' || EXACT_ONLY_RE.test(key)) return [exactPattern(key)];
  return [key, ...shorterVariants(key)];
}

function slugify(text: string, max = 48): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'answer';
}

const isLearnedFor = (entry: AnswerEntry, key: string) => entry.id.startsWith(LEARNED_PREFIX) && keyFromPattern(entry.patterns[0] ?? '') === key;

/** Stable id for the learned entry of `key`: reuses its existing entry, avoids clashing with another question's. */
export function learnedEntryId(key: string, bank: AnswerBank): string {
  const existing = bank.entries.find((e) => isLearnedFor(e, key));
  if (existing) return existing.id;
  const base = `${LEARNED_PREFIX}${slugify(key)}`;
  if (!bank.entries.some((e) => e.id === base)) return base;
  return `${base}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
}

function entryType(q: Pick<PendingQuestion, 'type' | 'options' | 'category'>): NonNullable<AnswerEntry['type']> {
  const options = q.options ?? [];
  if (q.type === 'yesno' || (q.type === 'checkbox' && options.length <= 1) || (q.category === 'attestation' && !options.length)) return 'yesno';
  if (options.length) return 'select';
  if (q.type === 'number') return 'number';
  if (q.type === 'url') return 'url';
  return 'text';
}

/** His saved answer to this exact question (a learned entry for the same key), if any. */
function knownAnswer(labelKey: string): { entryId: string; answer: string } | null {
  let bank: AnswerBank;
  try {
    bank = loadAnswers();
  } catch {
    return null;
  }
  const entry = bank.entries.find((e) => isLearnedFor(e, labelKey) && e.confirm !== true && e.answer.trim());
  return entry ? { entryId: entry.id, answer: entry.answer } : null;
}

function saveLearnedAnswer(q: PendingQuestion, answer: string, via: AnswerVia, now: Date): AnswerEntry {
  const bank = loadAnswers();
  const id = learnedEntryId(q.labelKey, bank);
  const source = via === 'dashboard' ? 'the dashboard' : 'Telegram';
  const exact = q.category ? ` (${SENSITIVE_LABELS[q.category]}: this exact question only)` : '';
  const entry: AnswerEntry = {
    id,
    patterns: learnedPatterns(q.labelKey, { category: q.category, type: q.type }),
    answer,
    type: entryType(q),
    confirm: false,
    notes: `Learned from ${source} ${dublinDate(now)}${exact}`,
  };
  // First in the bank: tailoring breaks equal-coverage ties in favour of the earlier entry.
  saveAnswers({ entries: [entry, ...bank.entries.filter((e) => e.id !== id)] });
  return entry;
}

// ───────────────────────────── Validating his reply ─────────────────────────────

const YES = new Set(['y', 'yes', 'yeah', 'yea', 'yep', 'yup', 'ya', 'aye', 'sure', 'ok', 'okay', 'true', 'correct', 'affirmative',
  'i do', 'i am', 'i have', 'i agree', 'agree', 'agreed', 'i accept', 'accept', 'i confirm', 'confirmed', 'definitely',
  'absolutely', 'of course', 'yes i do', 'yes i am', 'yes i have', 'yes i agree', 'yes please']);
const NO = new Set(['n', 'no', 'nope', 'nah', 'false', 'negative', 'i dont', 'i do not', 'i am not', 'im not', 'i havent',
  'i have not', 'i disagree', 'disagree', 'i decline', 'decline', 'no i dont', 'no i do not', 'no i am not', 'no i have not',
  'no thanks', 'not']);

/** "Yes"/"No" from a reply, or null when it isn't clearly one of them. */
export function parseYesNo(raw: string): 'Yes' | 'No' | null {
  const s = String(raw ?? '').trim();
  if (/^(?:👍|✅|✔️?|☑️?)$/u.test(s)) return 'Yes';
  if (/^(?:👎|❌|✖️?|🚫)$/u.test(s)) return 'No';
  const n = normaliseLabel(s);
  if (YES.has(n)) return 'Yes';
  if (NO.has(n)) return 'No';
  return null;
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};
const optNorm = (s: string) => normaliseLabel(s).split(' ').map((t) => NUMBER_WORDS[t] ?? t).join(' ');

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Maps his reply onto one of the form's options: exact → option number → yes/no lead word → unique
 * prefix → token overlap (tailor's mapOption) → small typos. Null when nothing fits or two tie.
 */
export function matchOption(reply: string, options: string[]): string | null {
  const opts = options.map((o) => o.trim()).filter(Boolean);
  const r = optNorm(reply);
  if (!r || !opts.length) return null;

  const exact = opts.filter((o) => optNorm(o) === r);
  if (exact.length) return exact[0];

  const num = /^(?:no |number |option )?(\d{1,2})$/.exec(r);
  if (num && !opts.some((o) => /^\d/.test(optNorm(o)))) {
    const i = Number(num[1]) - 1;
    return i >= 0 && i < opts.length ? opts[i] : null;
  }

  const yn = parseYesNo(reply);
  if (yn) {
    const lead = opts.filter((o) => optNorm(o).split(' ')[0] === yn.toLowerCase());
    if (lead.length === 1) return lead[0];
    if (lead.length > 1) return null;
  }

  const prefix = opts.filter((o) => {
    const n = optNorm(o);
    return n.startsWith(`${r} `) || r.startsWith(`${n} `);
  });
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) return null;

  const mapped = mapOption(reply, opts);
  if (mapped) return mapped;

  let best: { o: string; s: number } | null = null;
  let tie = false;
  for (const o of opts) {
    const n = optNorm(o);
    const s = 1 - editDistance(r, n) / Math.max(r.length, n.length);
    if (!best || s > best.s + 1e-9) {
      best = { o, s };
      tie = false;
    } else if (Math.abs(s - best.s) < 1e-9) tie = true;
  }
  return best && best.s >= 0.8 && !tie ? best.o : null;
}

/** "Check all that apply": every comma/semicolon/newline part must match an option. Null otherwise. */
function matchMany(text: string, options: string[]): string | null {
  if (!/[,;\n]/.test(text)) return null;
  const picks = text.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean).map((p) => matchOption(p, options));
  return picks.length > 1 && picks.every((p): p is string => p !== null) ? [...new Set(picks)].join(', ') : null;
}

export type ValidateResult = { ok: true; answer: string } | { ok: false; error: string };

const isYesNoOnly = (q: { type: QType; category?: SensitiveCategory | null }, options: string[]) =>
  (q.type === 'yesno' && !options.length) || (q.type === 'checkbox' && options.length <= 1) || (q.category === 'attestation' && !options.length);

export function optionList(options: string[], max = 12): string {
  const shown = options.slice(0, max).map((o, i) => `${i + 1}. ${o}`).join('\n');
  return options.length > max ? `${shown}\n…and ${options.length - max} more` : shown;
}

function parseNumberAnswer(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[€£$,\s]/g, '').replace(/^(eur|gbp|usd)/, '').replace(/(eur|gbp|usd|euros?|pounds?)$/, '');
  const unit = /^(-?\d+(?:\.\d+)?)(k|years?|yrs?|months?|weeks?|days?|hours?|hrs?)?$/.exec(s);
  if (!unit) return null;
  const n = Number(unit[1]) * (unit[2] === 'k' ? 1000 : 1);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : null;
}

function parseDateAnswer(raw: string): string | null {
  const t = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseUrlAnswer(raw: string): string | null {
  const t = raw.trim();
  const candidate = /^https?:\/\//i.test(t) ? t : /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t) ? `https://${t}` : null;
  if (!candidate || /\s/.test(candidate)) return null;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/** Checks his reply against the question's type and options; returns the canonical answer to store. */
export function validateAnswer(q: { type: QType; options?: string[]; category?: SensitiveCategory | null }, raw: string): ValidateResult {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim().replace(/^["“”]+|["“”]+$/g, '').trim();
  if (!text) return { ok: false, error: 'Send an answer, or tap Skip to leave it for the dashboard.' };
  if (text.length > MAX_ANSWER_CHARS) return { ok: false, error: `That's too long (${text.length} characters, limit ${MAX_ANSWER_CHARS}).` };
  const options = cleanOptions(q.options) ?? [];

  if (isYesNoOnly(q, options)) {
    const yn = parseYesNo(text);
    return yn ? { ok: true, answer: yn } : { ok: false, error: 'Reply Yes or No.' };
  }
  if (options.length) {
    const many = q.type === 'checkbox' ? matchMany(text, options) : null;
    if (many) return { ok: true, answer: many };
    const whole = matchOption(text, options);
    if (whole) return { ok: true, answer: whole };
    if (q.type === 'checkbox') return { ok: false, error: `Pick from these (several are fine, separated by commas):\n${optionList(options)}` };
    return { ok: false, error: `That doesn't match an option. Pick one:\n${optionList(options)}` };
  }
  switch (q.type) {
    case 'number': {
      const n = parseNumberAnswer(text);
      return n !== null ? { ok: true, answer: n } : { ok: false, error: 'Send a single number, e.g. 3 or 36700.' };
    }
    case 'url': {
      const u = parseUrlAnswer(text);
      return u ? { ok: true, answer: u } : { ok: false, error: 'Send a link, e.g. https://example.com/me.' };
    }
    case 'date': {
      const d = parseDateAnswer(text);
      return d ? { ok: true, answer: d } : { ok: false, error: 'Send a date like 01/12/2026 (day/month/year) or 2026-12-01.' };
    }
    default:
      return { ok: true, answer: text.replace(/\n{3,}/g, '\n\n') };
  }
}

/** The value to put in one job's form for this answer (its own type/options), or null when it doesn't fit. */
export function fitForJob(answer: string, ref: { type: QType; options?: string[] }): string | null {
  const options = cleanOptions(ref.options) ?? [];
  if (ref.type === 'checkbox' && options.length <= 1) return parseYesNo(answer);
  if (options.length) return (ref.type === 'checkbox' ? matchMany(answer, options) : null) ?? matchOption(answer, options);
  if (ref.type === 'yesno') return parseYesNo(answer);
  return fitAnswer(answer, { id: 'q', label: 'q', required: true, type: ref.type });
}

// ───────────────────────────── Job side effects ─────────────────────────────

function parseAnswerList(content: string | undefined): AnsweredQuestion[] {
  if (!content?.trim()) return [];
  try {
    const data: unknown = JSON.parse(content);
    const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.answers) ? data.answers : [];
    return list.filter((a): a is AnsweredQuestion => isObj(a) && typeof a.label === 'string');
  } catch {
    return [];
  }
}

/** New version of the job's answers artifact with this question answered (the runner reads it first). */
function writeJobAnswer(ref: WaitingJob, value: string, answerId: string | undefined, qid: string): void {
  const list = parseAnswerList(latestArtifact(ref.jobId, 'answers')?.content);
  const refKey = questionKey(ref.label);
  const idx = list.findIndex((a) => (ref.fieldId && a.id === ref.fieldId) || questionKey(a.label) === refKey);
  const base: AnsweredQuestion = idx >= 0
    ? list[idx]
    : { id: ref.fieldId || slugify(refKey, 60).replace(/-/g, '_'), label: ref.label, type: ref.type, required: true, answer: null, source: 'none', needsHuman: true };
  const next: AnsweredQuestion = { ...base, type: ref.type, required: true, answer: value, source: 'bank', needsHuman: false };
  if (ref.options?.length) next.options = ref.options;
  if (answerId) next.answerId = answerId;
  else delete next.answerId;
  delete next.confirm;
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  addArtifact({
    jobId: ref.jobId,
    kind: 'answers',
    content: JSON.stringify(list, null, 2),
    meta: { total: list.length, unanswered: list.filter((a) => a.needsHuman).map((a) => a.label), learned: { questionId: qid, label: clip(ref.label, 200) } },
  });
}

function wasApproved(jobId: string): boolean {
  return listEvents({ jobId, type: STATUS_EVENT, limit: 1000 }).some((e) => e.detail?.to === 'approved');
}

const NEED_RES = [
  /^Answer required question: "([\s\S]*)"$/,
  // The universal filler words topic questions as e.g. 'Marketing / communications question needs you: "…"'.
  /^[^":]{1,60} question needs you: "([\s\S]*)"$/,
  /^Legal attestation needs your decision: "([\s\S]*)"$/,
  /^No option matches the approved answer "[\s\S]*" for "([\s\S]*)"$/,
];

/** The question label inside an apply-runner need, when the need is an answerable question. */
export function needLabel(need: string): string | null {
  const text = String(need ?? '').trim();
  for (const re of NEED_RES) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

const isDeclinedAttestation = (q: Pick<PendingQuestion, 'category' | 'answer'>) => q.category === 'attestation' && parseYesNo(q.answer ?? '') === 'No';

export type RequeueState =
  | { state: 'requeued' }
  | { state: 'waiting'; questions: string[] }
  | { state: 'blocked'; reason: string }
  | { state: 'unchanged'; reason: string };

/**
 * Back to 'approved' when the job is in needs_you, was approved before (never bypass the approval
 * gate), waits on no open question, and every need it has is a question that is now answered.
 */
function requeueIfReady(jobId: string): RequeueState {
  return tx((): RequeueState => {
    const job = getJob(jobId);
    if (!job) return { state: 'unchanged', reason: 'job not found' };
    const store = readStore();
    const open = store.questions.filter((q) => q.status === 'open' && q.waiting.some((w) => w.jobId === jobId));
    if (open.length) return { state: 'waiting', questions: open.map((q) => q.id) };
    if (job.status !== 'needs_you') return { state: 'unchanged', reason: `status is ${job.status}` };
    if (!wasApproved(jobId)) return { state: 'blocked', reason: 'it was never approved: approve it in the dashboard' };
    const answered = store.questions.filter((q) => q.status === 'answered' && (q.applied[jobId] ?? 0) > 0 && !isDeclinedAttestation(q));
    const answeredKeys = new Set(answered.map((q) => q.labelKey));
    const other = (job.needs ?? []).filter((n) => {
      const label = needLabel(n);
      return label === null || !answeredKeys.has(questionKey(label));
    });
    if (other.length) return { state: 'blocked', reason: other[0] };
    updateJob(jobId, { needs: undefined });
    setStatus(jobId, 'approved', { reason: 'answers learned' });
    logEvent('questions.requeued', { questions: answered.filter((q) => q.waiting.length === 0).map((q) => q.id) }, jobId);
    return { state: 'requeued' };
  });
}

function jobName(jobId: string): string {
  const job = getJob(jobId);
  return job ? `${job.company}: ${job.title}` : jobId;
}

// ───────────────────────────── Queueing ─────────────────────────────

export type QueueStatus = 'queued' | 'added' | 'already_waiting' | 'auto_answered' | 'rejected';
export type RejectReason =
  | 'job_not_found' | 'empty_label' | 'file_upload' | 'demographic' | 'too_long' | 'attestation_declined' | 'repeated_failure' | 'error';

export interface QueueResult {
  ok: boolean;
  status: QueueStatus;
  questionId?: string;
  reason?: RejectReason;
  detail?: string;
  /** auto_answered only: whether the job went straight back to 'approved'. */
  requeued?: boolean;
}

const NOTE_FORM_REFUSED = 'Pursuit used your saved answer here, but the form still flagged this question. Send exactly what this form needs.';
const NOTE_NO_FIT = "Your saved answer doesn't match this form's options, so please pick again.";

function newRecord(id: string, key: string, labelKey: string, now: string): PendingQuestion {
  return {
    id, key, labelKey, label: '', type: 'text', scope: 'shared', status: 'open', waiting: [], applied: {},
    createdAt: now, updatedAt: now, askSeq: 0, sentSeq: 0,
  };
}

/**
 * Adds one unanswered question for a job. Deduped by normalised label across jobs. Reuses only his
 * own earlier answer to the identical question. Never throws (the apply runner calls it).
 */
export function queueQuestion(input: { jobId: string; question: ScreeningQuestion }, opts: { now?: Date } = {}): QueueResult {
  try {
    return queueOne(input.jobId, input.question, opts.now ?? new Date());
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    log.forJob('warn', input.jobId, 'questions', `could not queue a question: ${detail}`);
    return { ok: false, status: 'rejected', reason: 'error', detail };
  }
}

function queueOne(jobId: string, question: ScreeningQuestion, now: Date): QueueResult {
  const reject = (reason: RejectReason, detail?: string): QueueResult => ({ ok: false, status: 'rejected', reason, ...(detail ? { detail } : {}) });
  const job = getJob(jobId);
  if (!job) return reject('job_not_found');
  const label = String(question?.label ?? '').replace(/\s+/g, ' ').trim() || String(question?.id ?? '').replace(/[_-]+/g, ' ').trim();
  if (!label) return reject('empty_label');
  if (question.type === 'file') return reject('file_upload');
  if (isEeoLabel(label)) return reject('demographic', 'EEO questions are only ever declined through the form, or handed to you');
  const category = sensitiveCategory(label);
  if (category === 'attestation' && label.length > MAX_ATTESTATION_CHARS) return reject('too_long');
  const labelKey = questionKey(label);
  if (!labelKey) return reject('empty_label');
  const scope: PendingQuestion['scope'] = !category && JOB_SPECIFIC_RE.test(labelKey) ? 'job' : 'shared';
  const key = scope === 'job' ? `${labelKey}#${jobId}` : labelKey;
  const id = questionId(key);
  const nowIso = now.toISOString();
  const ref: WaitingJob = { jobId, fieldId: String(question.id ?? '').slice(0, 200), label: clip(label, MAX_LABEL_CHARS), type: question.type, queuedAt: nowIso };
  const options = cleanOptions(question.options);
  if (options) ref.options = options;
  const known = scope === 'shared' ? knownAnswer(labelKey) : null; // answers.json read outside the transaction

  type Step = { result: QueueResult; requeue?: boolean; tell?: string };
  const step = tx((): Step => {
    const store = readStore();
    const existing = store.questions.find((q) => q.key === key);

    if (existing?.status === 'open') {
      const i = existing.waiting.findIndex((w) => w.jobId === jobId);
      if (i >= 0) existing.waiting[i] = ref;
      else existing.waiting.push(ref);
      if (!existing.options && ref.options) existing.options = ref.options;
      existing.updatedAt = nowIso;
      writeStore(store);
      return { result: { ok: true, status: i >= 0 ? 'already_waiting' : 'added', questionId: existing.id } };
    }

    const attempts = existing?.applied[jobId] ?? 0;
    if (category === 'attestation' && known && parseYesNo(known.answer) === 'No') {
      return {
        result: reject('attestation_declined'),
        tell: `${jobName(jobId)} needs you to accept a statement you said No to before ("${clip(label, 90)}"). It stays in Needs you on the dashboard.`,
      };
    }
    if (attempts >= MAX_ATTEMPTS_PER_JOB) {
      return {
        result: reject('repeated_failure'),
        tell: `${jobName(jobId)}: the form still won't take an answer to "${clip(label, 90)}". Finish this one from the dashboard.`,
      };
    }

    const rec = existing ?? newRecord(id, key, labelKey, nowIso);
    Object.assign(rec, { label: ref.label, type: ref.type, scope, updatedAt: nowIso });
    if (category) rec.category = category;
    else delete rec.category;
    if (ref.options) rec.options = ref.options;
    else delete rec.options;

    if (known && attempts === 0) {
      const value = fitForJob(known.answer, ref);
      if (value !== null) {
        writeJobAnswer(ref, value, known.entryId, rec.id);
        rec.applied[jobId] = 1;
        if (rec.status !== 'answered') {
          rec.status = 'answered';
          rec.answer = known.answer;
          rec.answerId = known.entryId;
          rec.answeredAt = rec.answeredAt ?? nowIso;
          rec.answeredVia = rec.answeredVia ?? 'saved';
        }
        rec.waiting = [];
        delete rec.note;
        if (!existing) store.questions.push(rec);
        writeStore(store);
        return { result: { ok: true, status: 'auto_answered', questionId: rec.id }, requeue: true };
      }
    }

    rec.status = 'open';
    rec.waiting = [ref];
    rec.askSeq += 1;
    if (attempts > 0) rec.note = NOTE_FORM_REFUSED;
    else if (known) rec.note = NOTE_NO_FIT;
    else delete rec.note;
    if (!existing) store.questions.push(rec);
    writeStore(store);
    return { result: { ok: true, status: 'queued', questionId: rec.id } };
  });

  if (step.tell) notifyTelegram(step.tell);
  const result = step.result;
  if (step.requeue) result.requeued = requeueIfReady(jobId).state === 'requeued';
  logEvent('questions.queued', { status: result.status, reason: result.reason, questionId: result.questionId, label: clip(label, 120), category }, jobId);
  return result;
}

/** Structural subset of the apply runner's FormFillResult (readonly arrays accepted). */
export interface FillReport {
  unfilledRequired: readonly string[];
  questionsSeen: readonly ScreeningQuestion[];
  reasons?: Readonly<Record<string, string>>;
  blockers?: readonly string[];
}

export interface FillQueueResult { queued: QueueResult[]; skipped?: string }

const QUESTION_BLOCKERS = new Set(['unknown_required_field', 'attestation']);
const ASKABLE_REASON_RE = /^(?:Answer required question|Legal attestation needs your decision|No option matches the approved answer)\b/;

/**
 * Apply-runner hook: queues every unfilled required question from a form fill, but only when
 * answering them would unblock the job (no CAPTCHA/login/upload/EEO hand-off in the way).
 */
export function queueQuestionsFromFill(jobId: string, fill: FillReport, opts: { now?: Date } = {}): FillQueueResult {
  try {
    const other = (fill.blockers ?? []).filter((b) => !QUESTION_BLOCKERS.has(b));
    if (other.length) return { queued: [], skipped: `other blockers: ${other.join(', ')}` };
    const labels = [...new Set(fill.unfilledRequired ?? [])];
    const unaskable = labels.filter((l) => {
      const reason = fill.reasons?.[l];
      return reason !== undefined && !ASKABLE_REASON_RE.test(reason);
    });
    if (unaskable.length) return { queued: [], skipped: `needs the dashboard: ${fill.reasons?.[unaskable[0]] ?? unaskable[0]}` };
    const seen = fill.questionsSeen ?? [];
    const queued = labels.map((label) => {
      const match = seen.find((q) => q.label === label) ?? seen.find((q) => questionKey(q.label) === questionKey(label));
      const question: ScreeningQuestion = match ? { ...match, required: true } : { id: '', label, type: 'text', required: true };
      return queueQuestion({ jobId, question }, opts);
    });
    return { queued };
  } catch (err) {
    return { queued: [], skipped: `error: ${(err as Error)?.message ?? err}` };
  }
}

// ───────────────────────────── Reading + bot bookkeeping ─────────────────────────────

const byCreated = (a: PendingQuestion, b: PendingQuestion) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Open questions, oldest first. */
export function pendingQuestions(): PendingQuestion[] {
  return readStore().questions.filter((q) => q.status === 'open').sort(byCreated);
}

export function getQuestion(id: string): PendingQuestion | undefined {
  return readStore().questions.find((q) => q.id === id);
}

/** Open questions the bot still has to (re)send. */
export function questionsToSend(): PendingQuestion[] {
  return pendingQuestions().filter((q) => q.waiting.length > 0 && q.sentSeq < q.askSeq);
}

export function markQuestionSent(id: string, seq: number, telegramMessageId: number, now: Date = new Date()): void {
  tx(() => {
    const store = readStore();
    const q = store.questions.find((x) => x.id === id);
    if (!q) return;
    q.sentSeq = Math.max(q.sentSeq, seq);
    q.telegramMessageId = telegramMessageId;
    q.sentAt = now.toISOString();
    writeStore(store);
  });
}

/** Marks every open question to be sent again (Kayzee lost the messages). Returns how many. */
export function resendOpenQuestions(now: Date = new Date()): number {
  return tx(() => {
    const store = readStore();
    let n = 0;
    for (const q of store.questions) {
      if (q.status !== 'open' || !q.waiting.length) continue;
      q.askSeq = q.sentSeq + 1;
      q.updatedAt = now.toISOString();
      n++;
    }
    if (n) writeStore(store);
    return n;
  });
}

/** Kayzee chose to handle it himself: the question closes, its jobs stay in needs_you. */
export function dismissQuestion(id: string, now: Date = new Date()): PendingQuestion | undefined {
  const rec = tx(() => {
    const store = readStore();
    const q = store.questions.find((x) => x.id === id);
    if (!q || q.status !== 'open') return undefined;
    q.status = 'dismissed';
    q.note = 'Skipped: left for the dashboard.';
    q.updatedAt = now.toISOString();
    writeStore(store);
    return structuredClone(q);
  });
  if (rec) logEvent('questions.dismissed', { questionId: id, jobs: rec.waiting.length });
  return rec;
}

/**
 * Drops waiting jobs that moved on (applied, withdrawn...), closes questions nothing waits on, and
 * forgets closed questions after 60 days. Cheap; the bot calls it before sending.
 */
export function pruneQuestions(now: Date = new Date()): { dismissed: number; removed: number } {
  return tx(() => {
    const store = readStore();
    let dismissed = 0;
    let changed = false;
    for (const q of store.questions) {
      if (q.status !== 'open') continue;
      const keep = q.waiting.filter((w) => {
        const job = getJob(w.jobId);
        return Boolean(job && !TERMINAL.has(job.status));
      });
      if (keep.length !== q.waiting.length) {
        q.waiting = keep;
        q.updatedAt = now.toISOString();
        changed = true;
      }
      if (!keep.length) {
        q.status = 'dismissed';
        q.note = 'No application is waiting on it any more.';
        dismissed++;
        changed = true;
      }
    }
    const before = store.questions.length;
    const cutoff = now.getTime() - KEEP_CLOSED_MS;
    store.questions = store.questions.filter((q) => q.status === 'open' || Date.parse(q.updatedAt) >= cutoff);
    if (store.questions.length > MAX_RECORDS) {
      const closed = store.questions.filter((q) => q.status !== 'open').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const drop = new Set(closed.slice(0, store.questions.length - MAX_RECORDS).map((q) => q.id));
      store.questions = store.questions.filter((q) => !drop.has(q.id));
    }
    const removed = before - store.questions.length;
    if (changed || removed) writeStore(store);
    return { dismissed, removed };
  });
}

// ───────────────────────────── Answering ─────────────────────────────

export interface AnswerOutcome {
  ok: boolean;
  /** Why the reply wasn't accepted (the question stays open). */
  error?: string;
  question?: PendingQuestion;
  /** Canonical answer that was saved. */
  answer?: string;
  /** Learned AnswerEntry id (shared questions). */
  entryId?: string;
  /** Jobs moved back to 'approved'. */
  requeued: string[];
  /** Jobs still waiting on another question. */
  waiting: string[];
  /** Jobs that still need the dashboard for something else. */
  blocked: { jobId: string; reason: string }[];
  /** Jobs whose form options don't take this answer: the question is asked again for them. */
  unfitted: string[];
  /** An attestation he said No to. */
  declined?: boolean;
}

/**
 * Validates and saves Kayzee's answer: learned AnswerEntry (shared questions), each waiting job's
 * answers artifact, then re-queues every job that has nothing else blocking it.
 */
export function answerQuestion(questionId: string, rawAnswer: string, opts: { via?: AnswerVia; now?: Date } = {}): AnswerOutcome {
  const now = opts.now ?? new Date();
  const via = opts.via ?? 'telegram';
  const blank = (): Pick<AnswerOutcome, 'requeued' | 'waiting' | 'blocked' | 'unfitted'> => ({ requeued: [], waiting: [], blocked: [], unfitted: [] });
  const q = getQuestion(questionId);
  if (!q) return { ok: false, error: 'That question is no longer in the queue.', ...blank() };
  if (q.status !== 'open') return { ok: false, error: q.status === 'answered' ? 'That one is already answered.' : 'That question was closed.', question: q, ...blank() };
  const v = validateAnswer(q, rawAnswer);
  if (!v.ok) return { ok: false, error: v.error, question: q, ...blank() };

  let entry: AnswerEntry | undefined;
  if (q.scope === 'shared') {
    try {
      entry = saveLearnedAnswer(q, v.answer, via, now);
    } catch (err) {
      return { ok: false, error: `Couldn't save it to answers.json: ${(err as Error).message}`, question: q, ...blank() };
    }
  }
  const declined = q.category === 'attestation' && parseYesNo(v.answer) === 'No';
  const nowIso = now.toISOString();
  const fitted: string[] = [];
  const unfitted: string[] = [];

  const updated = tx(() => {
    const store = readStore();
    const rec = store.questions.find((x) => x.id === questionId);
    if (!rec || rec.status !== 'open') return undefined;
    const remaining: WaitingJob[] = [];
    for (const w of rec.waiting) {
      const job = getJob(w.jobId);
      if (!job || TERMINAL.has(job.status)) continue;
      const value = fitForJob(v.answer, w);
      if (value === null) {
        remaining.push(w);
        unfitted.push(w.jobId);
        continue;
      }
      writeJobAnswer(w, value, entry?.id, rec.id);
      rec.applied[w.jobId] = (rec.applied[w.jobId] ?? 0) + 1;
      fitted.push(w.jobId);
    }
    rec.answer = v.answer;
    rec.answeredAt = nowIso;
    rec.answeredVia = via;
    if (entry) rec.answerId = entry.id;
    rec.updatedAt = nowIso;
    if (remaining.length) {
      rec.waiting = remaining;
      rec.type = remaining[0].type;
      if (remaining[0].options) rec.options = remaining[0].options;
      rec.note = `Your answer "${clip(v.answer, 60)}" doesn't match the options on this form.`;
      rec.askSeq += 1;
    } else {
      rec.status = 'answered';
      rec.waiting = [];
      delete rec.note;
    }
    writeStore(store);
    return structuredClone(rec);
  });
  if (!updated) return { ok: false, error: 'That one is already answered.', question: getQuestion(questionId), ...blank() };

  const outcome: AnswerOutcome = { ok: true, question: updated, answer: v.answer, ...blank(), unfitted, ...(declined ? { declined } : {}) };
  if (entry) outcome.entryId = entry.id;
  for (const jobId of fitted) {
    if (declined) {
      outcome.blocked.push({ jobId, reason: 'you said No to the attestation it requires' });
      continue;
    }
    const r = requeueIfReady(jobId);
    if (r.state === 'requeued') outcome.requeued.push(jobId);
    else if (r.state === 'waiting') outcome.waiting.push(jobId);
    else if (r.state === 'blocked') outcome.blocked.push({ jobId, reason: r.reason });
  }
  logEvent('questions.answered', {
    questionId, via, category: q.category, scope: q.scope, entryId: entry?.id,
    jobs: fitted.length, requeued: outcome.requeued.length, unfitted: unfitted.length,
  });
  return outcome;
}
