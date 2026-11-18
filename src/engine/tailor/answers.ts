// Screening-question answering. Server-only.
//
// Order per question: file uploads → cover-letter box → profile fields → answer bank → "why this
// role/company" (LLM, guarded) → unknown. Never fabricates: an answer the bank or profile can't
// back with confidence comes back as {answer: null, needsHuman: required}. EEO questions only ever
// get the form's own decline option; legal attestations are always handed to Kayzee.

import { z } from 'zod';
import { addArtifact, latestArtifact } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { log } from '@/lib/log';
import type { AnsweredQuestion, AnswerBank, AnswerEntry, FactBank, Job, Profile, ScreeningQuestion } from '@/lib/types';
import { describeSlop, fixDashes, lintSlop } from '../slop';
import { defaultGuard, guardContextFor, rankFactsForJob, runGuard, wordCount, type GuardTextFn } from './letter';

export const WHY_ANSWER_MAX_WORDS = 120;
const MAX_LLM_ANSWERS_PER_JOB = 3;
/** Profile fields are only matched on short labels, so "May we email your referee?" isn't an email field. */
const PROFILE_LABEL_MAX_WORDS = 6;

// ───────────────────────────── Normalisation ─────────────────────────────

/** Lowercase, no accents, no asterisks/"(required)", apostrophes dropped, other punctuation → space. */
export function normaliseLabel(label: string): string {
  return String(label ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((?:required|optional)\)/g, ' ')
    .replace(/[*]/g, ' ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isRegexPattern = (p: string) => /^\/.+\/[a-z]*$/i.test(p.trim());

interface PatternMatch { start: number; length: number }

/**
 * Where `pattern` matches the normalised label (start = -1 when only the raw label matched a regex).
 * Substring patterns must start on a word boundary; short ones (≤5 chars) must also end on one
 * (optionally plural) so "major" doesn't hit "majority" and "gpa" doesn't hit inside words.
 */
export function patternMatch(pattern: string, normLabel: string, rawLabel: string): PatternMatch | null {
  const p = pattern.trim();
  if (!p) return null;
  if (isRegexPattern(p)) {
    const lastSlash = p.lastIndexOf('/');
    try {
      const re = new RegExp(p.slice(1, lastSlash), p.slice(lastSlash + 1).replace(/[gy]/g, '') || 'i');
      const onNorm = re.exec(normLabel);
      if (onNorm) return { start: onNorm.index, length: Math.max(onNorm[0].length, 1) };
      const onRaw = re.exec(rawLabel.toLowerCase());
      return onRaw ? { start: -1, length: Math.max(onRaw[0].length, 1) } : null;
    } catch {
      return null;
    }
  }
  const np = normaliseLabel(p);
  if (!np) return null;
  const hay = ` ${normLabel} `;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(` ${np}`, from);
    if (i < 0) return null;
    const after = hay.slice(i + 1 + np.length);
    if (np.length > 5 || /^s?\s/.test(after)) return { start: i, length: np.length };
    from = i + 1;
  }
}

export function patternScore(pattern: string, normLabel: string, rawLabel: string): number {
  return patternMatch(pattern, normLabel, rawLabel)?.length ?? 0;
}

/** Characters of the label covered by any of the entry's patterns (overlaps counted once). */
function entryCoverage(entry: AnswerEntry, normLabel: string, rawLabel: string): number {
  const covered = new Set<number>();
  let unpositioned = 0;
  for (const p of entry.patterns) {
    const m = patternMatch(p, normLabel, rawLabel);
    if (!m) continue;
    if (m.start < 0) unpositioned = Math.max(unpositioned, m.length);
    else for (let i = m.start; i < m.start + m.length; i++) covered.add(i);
  }
  return covered.size + unpositioned;
}

/**
 * Best bank entry for a label: the entry whose patterns cover the most of the label wins
 * ("expected graduation date" beats "degree"); ties go to the earlier entry.
 */
export function findBankEntry(label: string, bank: AnswerBank): AnswerEntry | undefined {
  const norm = normaliseLabel(label);
  let best: { entry: AnswerEntry; score: number } | undefined;
  for (const entry of bank.entries) {
    const score = entryCoverage(entry, norm, label);
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry;
}

// ───────────────────────────── Options ─────────────────────────────

const OPTION_STOP = new Set(['a', 'an', 'the', 'of', 'i', 'my', 'to', 'in', 'or', 'and']);

function optionTokens(s: string): string[] {
  return normaliseLabel(s.replace(/['’]s\b/g, ''))
    .split(' ')
    .filter((t) => t && !OPTION_STOP.has(t));
}

const DECLINE_RE = /\b(prefer not|decline|do not wish|dont wish|rather not|choose not|wish not|not to (say|disclose|answer|specify|identify|self identify)|not disclose|no answer|not specified)\b/;

export function isDeclineText(s: string): boolean {
  return DECLINE_RE.test(normaliseLabel(s));
}

/** The form's own "prefer not to say" style option, if it has exactly that kind of option. */
export function declineOption(options: string[]): string | null {
  return options.find((o) => isDeclineText(o)) ?? null;
}

function yesNoValue(s: string): 'yes' | 'no' | null {
  const n = normaliseLabel(s);
  if (/^(yes|y|true)$/.test(n)) return 'yes';
  if (/^(no|n|false)$/.test(n)) return 'no';
  return null;
}

/**
 * Maps a bank answer onto a form's option list: exact (normalised) → yes/no lead word → token
 * similarity (answer tokens contained in the option, or Dice ≥ 0.6). Returns null when no option
 * matches or two options tie: an ambiguous pick is a guess.
 */
export function mapOption(answer: string, options: string[]): string | null {
  const opts = options.filter((o) => o.trim());
  if (!answer.trim() || !opts.length) return null;
  const na = normaliseLabel(answer);
  const exact = opts.filter((o) => normaliseLabel(o) === na);
  if (exact.length) return exact[0];

  const yn = yesNoValue(answer);
  if (yn) {
    const lead = opts.filter((o) => normaliseLabel(o).split(' ')[0] === yn);
    return lead.length === 1 ? lead[0] : null;
  }

  const at = new Set(optionTokens(answer));
  if (!at.size) return null;
  const scored = opts
    .map((o) => {
      const ot = new Set(optionTokens(o));
      const inter = [...at].filter((t) => ot.has(t)).length;
      const dice = ot.size ? (2 * inter) / (at.size + ot.size) : 0;
      const contained = inter / at.size;
      return { o, score: Math.max(dice, contained === 1 ? 0.9 : contained * 0.8) };
    })
    .sort((a, b) => b.score - a.score);
  const [top, next] = scored;
  if (!top || top.score < 0.6) return null;
  if (next && Math.abs(next.score - top.score) < 1e-9) return null;
  return top.o;
}

// ───────────────────────────── Profile fields ─────────────────────────────

function cityOf(location: string): string {
  return location.split(',')[0]?.trim() ?? '';
}

function countryOf(location: string): string {
  const last = location.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  return /^(co\.?|county)\s/i.test(last) ? '' : last;
}

interface ProfileRule { re: RegExp; value: (p: Profile) => string | undefined; kind?: 'url' }

const PROFILE_RULES: ProfileRule[] = [
  { re: /^(legal )?(first|given) name|^forename/, value: (p) => p.name.first },
  { re: /^(legal )?(last name|surname|family name)/, value: (p) => p.name.last },
  { re: /^((your|full|legal|full legal|candidate|applicant) )?name$/, value: (p) => p.name.full },
  { re: /^((your|primary|personal) )?e ?mail( address)?$|^email address/, value: (p) => p.email },
  { re: /\b(phone|mobile|telephone|cell)( number)?\b|^contact number/, value: (p) => p.phone },
  { re: /\blinkedin\b/, value: (p) => p.links.linkedin, kind: 'url' },
  { re: /\bgithub\b/, value: (p) => p.links.github, kind: 'url' },
  { re: /\b(portfolio|personal website|website|personal site)\b/, value: (p) => p.links.portfolio ?? p.links.website, kind: 'url' },
  { re: /^(current )?(city|town)( of residence)?$/, value: (p) => cityOf(p.location) || undefined },
  { re: /^(country|country of residence|current country)$/, value: (p) => countryOf(p.location) || undefined },
  { re: /^((current|your) )?location$|^where are you (currently )?(located|based)$/, value: (p) => p.location },
];

function profileAnswer(norm: string, profile: Profile): string | undefined {
  if (!norm || norm.split(' ').length > PROFILE_LABEL_MAX_WORDS) return undefined;
  for (const rule of PROFILE_RULES) {
    if (rule.re.test(norm)) {
      const v = rule.value(profile)?.trim();
      return v || undefined;
    }
  }
  return undefined;
}

// ───────────────────────────── Special cases ─────────────────────────────

const FILE_DOC_RE = /\b(resume|cv|curriculum vitae|cover letter|covering letter)\b/;
const COVER_LETTER_RE = /\b(cover letter|covering letter|motivation letter|letter of motivation)\b/;
const WHY_RE =
  /\bwhy\b.*\b(work|join|apply|applying|interested|interest|role|position|job|company|organisation|organization|us|here|team|opportunity)\b|\bwhat (interests|attracts|excites|appeals to|draws) you\b|\bwhat makes you want\b|\bmotivation (for|to) (apply|applying|join)/;

/** "How did you hear about us": answered from where the job really came from. */
function heardAboutCandidates(job: Job): { text: string; options: string[] } {
  switch (job.source) {
    case 'linkedin_guest':
      return { text: 'LinkedIn', options: ['linkedin'] };
    case 'adzuna':
      return { text: 'Adzuna', options: ['adzuna', 'job board', 'online job board'] };
    case 'gmail_alert':
      return { text: 'Job alert email', options: ['job alert', 'email alert', 'job board'] };
    case 'manual':
      return { text: '', options: [] };
    default:
      return { text: 'Company careers page', options: ['company careers page', 'careers page', 'company website', 'career site', 'careers site', 'company site', 'website'] };
  }
}

const isEeoEntry = (e: AnswerEntry) => e.id.startsWith('eeo-') || isDeclineText(e.answer);
const hasOptions = (q: ScreeningQuestion) => Array.isArray(q.options) && q.options.some((o) => o.trim());

// ───────────────────────────── Result builders ─────────────────────────────

function unknown(q: ScreeningQuestion): AnsweredQuestion {
  return { ...q, answer: null, source: 'none', needsHuman: q.required };
}

function fromBank(q: ScreeningQuestion, entry: AnswerEntry, answer: string | null, forceHuman = false): AnsweredQuestion {
  return {
    ...q,
    answer,
    source: 'bank',
    answerId: entry.id,
    needsHuman: forceHuman || (answer === null && q.required),
    ...(entry.confirm ? { confirm: true } : {}),
  };
}

/** Fits a bank/profile answer to the question's type. Null when it can't be fitted honestly. */
export function fitAnswer(answer: string, q: ScreeningQuestion): string | null {
  const value = answer.trim();
  if (!value) return null;
  if (hasOptions(q)) return mapOption(value, q.options!);
  switch (q.type) {
    case 'yesno':
    case 'checkbox': {
      const yn = yesNoValue(value);
      return yn ? (yn === 'yes' ? 'Yes' : 'No') : null;
    }
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '')) ? value.replace(/,/g, '') : null;
    case 'url':
      return /^https?:\/\/\S+$/i.test(value) ? value : null;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    case 'file':
      return null;
    default:
      return value;
  }
}

function answerFromEntry(q: ScreeningQuestion, entry: AnswerEntry, job: Job): AnsweredQuestion {
  if (isEeoEntry(entry)) {
    // SPEC rule 3: decline only through the form's own option; otherwise hand off.
    const decline = hasOptions(q) ? declineOption(q.options!) : null;
    return decline ? fromBank(q, entry, decline) : fromBank(q, entry, null, q.required);
  }
  if (entry.id === 'heard-about') {
    const source = heardAboutCandidates(job);
    if (hasOptions(q)) {
      for (const candidate of source.options) {
        const hit = mapOption(candidate, q.options!);
        if (hit) return fromBank(q, entry, hit);
      }
      return fromBank(q, entry, null, q.required);
    }
    return fromBank(q, entry, source.text || null, !source.text && q.required);
  }
  if (!entry.answer.trim()) return fromBank(q, entry, null, q.required); // "Kayzee to answer"
  const fitted = fitAnswer(entry.answer, q);
  return fromBank(q, entry, fitted, fitted === null && q.required);
}

// ───────────────────────────── Why-this-role answers ─────────────────────────────

const WhySchema = z.object({ answer: z.string().min(1), factIds: z.array(z.string()).default([]) });

async function writeWhyAnswer(q: ScreeningQuestion, job: Job, facts: FactBank, profile: Profile, guard: GuardTextFn): Promise<string | null> {
  const ranked = rankFactsForJob(job, facts).slice(0, 8);
  const ctx = guardContextFor(job);
  const system = [
    `You answer job application questions for ${profile.name.full}, in his own plain voice.`,
    ...profile.coverLetter.voiceNotes.map((n) => `- ${n}`),
    `- Answer in ${WHY_ANSWER_MAX_WORDS} words or fewer, one or two short paragraphs, first person.`,
    '- Use only the FACTS given. Never claim anything in GAPS. No numbers that are not in a fact.',
    '- Mention one specific thing from the job posting and one or two facts that connect to it.',
    '- No greeting, no sign-off, no markdown, no exclamation marks, no em dashes.',
    'Output JSON: {"answer": string, "factIds": string[]}.',
  ].join('\n');
  const baseUser = [
    `QUESTION: ${q.label}`,
    `ROLE: ${job.title} at ${job.company}`,
    `GAPS (never claim): ${(ctx.gaps ?? []).join(', ') || 'none'}`,
    'FACTS:',
    ...ranked.map((r) => `- [${r.fact.id}] ${r.fact.text}`),
    'JOB DESCRIPTION:',
    untrusted('job-description', job.description, 6000),
  ].join('\n');

  let problems: string[] = [];
  let previous = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? baseUser : `${baseUser}\n\nPREVIOUS ANSWER:\n${previous}\n\nFix these problems:\n${problems.map((p) => `- ${p}`).join('\n')}`;
    const out = await llmJSON({ purpose: attempt === 0 ? 'answers.why' : 'answers.why:regenerate', system, user, schema: WhySchema, maxTokens: 400, temperature: 0.4 });
    if (!out) return null;
    const text = fixDashes(out.answer.replace(/\*\*(.+?)\*\*/g, '$1').trim());
    const g = runGuard(guard, text, facts, ctx);
    const slop = lintSlop(text, { facts, allow: ctx.allowNames });
    const words = wordCount(text);
    problems = [
      ...g.problems,
      ...describeSlop(slop.hits),
      ...(words > WHY_ANSWER_MAX_WORDS ? [`${words} words; keep it to ${WHY_ANSWER_MAX_WORDS} or fewer.`] : []),
    ];
    if (!problems.length) return text;
    previous = text;
  }
  log.warn('answers', `why-answer for "${q.label.slice(0, 60)}" still had problems; handed to Kayzee`, { problems: problems.slice(0, 5) });
  return null;
}

// ───────────────────────────── Public API ─────────────────────────────

export interface AnswerOptions {
  /** Final cover letter text for "paste your cover letter" boxes (default: latest artifact). */
  coverLetter?: string;
  /** Store an 'answers' artifact (default true). */
  save?: boolean;
  /** Test seam: a guard to use instead of ../truthguard. */
  guard?: GuardTextFn;
}

function coverLetterText(job: Job, explicit?: string): string | null {
  if (explicit?.trim()) return explicit.trim();
  try {
    return latestArtifact(job.id, 'cover_letter')?.content?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Answers every screening question from the profile, the answer bank and (for "why" questions) a
 * guarded LLM paragraph. Unknown required questions come back with needsHuman: true.
 */
export async function answerQuestions(
  questions: ScreeningQuestion[],
  answers: AnswerBank,
  profile: Profile,
  facts: FactBank,
  job: Job,
  opts: AnswerOptions = {},
): Promise<AnsweredQuestion[]> {
  const guard: GuardTextFn = opts.guard ?? defaultGuard;
  let llmBudget = MAX_LLM_ANSWERS_PER_JOB;
  const results: AnsweredQuestion[] = [];

  for (const q of questions) {
    const label = q.label?.trim() || q.id.replace(/[_-]+/g, ' ');
    const norm = normaliseLabel(label);

    if (q.type === 'file') {
      // CV and cover-letter uploads are handled by the apply filler from the package paths.
      results.push(FILE_DOC_RE.test(norm) ? { ...q, answer: null, source: 'none', needsHuman: false } : unknown(q));
      continue;
    }

    if (COVER_LETTER_RE.test(norm) && (q.type === 'textarea' || q.type === 'text')) {
      const letter = coverLetterText(job, opts.coverLetter);
      results.push(letter ? { ...q, answer: letter, source: 'profile', needsHuman: false } : unknown(q));
      continue;
    }

    const fromProfile = profileAnswer(norm, profile);
    if (fromProfile !== undefined) {
      const fitted = fitAnswer(fromProfile, q);
      if (fitted !== null) {
        results.push({ ...q, answer: fitted, source: 'profile', needsHuman: false });
        continue;
      }
    }

    const entry = findBankEntry(label, answers);
    if (entry) {
      results.push(answerFromEntry(q, entry, job));
      continue;
    }

    if (WHY_RE.test(norm) && (q.type === 'textarea' || q.type === 'text')) {
      if (hasLLM() && llmBudget > 0) {
        llmBudget -= 1;
        const text = await writeWhyAnswer(q, job, facts, profile, guard);
        if (text) {
          results.push({ ...q, answer: text, source: 'llm', needsHuman: false });
          continue;
        }
      }
      results.push({ ...q, answer: null, source: 'none', needsHuman: true });
      continue;
    }

    results.push(unknown(q));
  }

  if (opts.save !== false) saveAnswers(job.id, results);
  return results;
}

export function answersSummary(results: AnsweredQuestion[]): { total: number; answered: number; needsHuman: number; unconfirmed: number; llm: number } {
  return {
    total: results.length,
    answered: results.filter((r) => r.answer !== null).length,
    needsHuman: results.filter((r) => r.needsHuman).length,
    unconfirmed: results.filter((r) => r.confirm).length,
    llm: results.filter((r) => r.source === 'llm').length,
  };
}

function saveAnswers(jobId: string, results: AnsweredQuestion[]): void {
  try {
    addArtifact({ jobId, kind: 'answers', content: JSON.stringify(results, null, 2), meta: answersSummary(results) });
  } catch (err) {
    log.forJob('error', jobId, 'answers', 'could not store answers artifact', err);
  }
}
