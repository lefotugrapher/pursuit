// Queue view-model types and pure rules (approval gate, batch eligibility, artifact parsing).
// No DB access: shared by server helpers, server actions and client components; unit-tested.

import type { AnsweredQuestion, AtsKind, AtsReport, Job, Message, ScreeningQuestion } from '@/lib/types';

export interface LetterView {
  artifactId: number;
  version: number;
  text: string;
  guardProblems: string[];
  slopHits: string[];
  /** Everything the letter check flagged (guard, slop, length), when the tailor module recorded it. */
  flags: string[];
  edited: boolean;
}

export type DraftView = Pick<Message, 'id' | 'channel' | 'kind' | 'to' | 'subject' | 'body' | 'guardProblems' | 'slopHits' | 'status'>;

export interface QueueItem {
  job: Job;
  cvPdfId: number | null;
  cvVersion: number | null;
  compileLogId: number | null;
  letter: LetterView | null;
  answers: AnsweredQuestion[];
  answersArtifactId: number | null;
  ats: AtsReport | null;
  drafts: DraftView[];
  flags: string[];
  gate: ApprovalGate;
}

export interface ApprovalGate {
  ok: boolean;
  reason?: string;
  /** Unanswered questions that a human must fill. */
  blocking: number;
}

const VALID_SOURCES = new Set<AnsweredQuestion['source']>(['bank', 'profile', 'llm', 'none']);
const VALID_TYPES = new Set<ScreeningQuestion['type']>(['text', 'textarea', 'select', 'radio', 'checkbox', 'file', 'number', 'url', 'date', 'yesno']);

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function toAnswered(raw: unknown, index: number): AnsweredQuestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = asString(r.label) ?? asString(r.question);
  if (!label) return null;
  const type = VALID_TYPES.has(r.type as ScreeningQuestion['type']) ? (r.type as ScreeningQuestion['type']) : 'text';
  const answer = typeof r.answer === 'string' ? r.answer : typeof r.answer === 'number' ? String(r.answer) : null;
  const source = VALID_SOURCES.has(r.source as AnsweredQuestion['source']) ? (r.source as AnsweredQuestion['source']) : answer ? 'bank' : 'none';
  const options = asStringArray(r.options);
  const out: AnsweredQuestion = {
    id: asString(r.id) ?? `q${index + 1}`,
    label,
    type,
    required: r.required === true,
    answer,
    source,
    needsHuman: typeof r.needsHuman === 'boolean' ? r.needsHuman : answer === null || answer.trim() === '',
  };
  if (options.length) out.options = options;
  const answerId = asString(r.answerId);
  if (answerId) out.answerId = answerId;
  if (typeof r.confirm === 'boolean') out.confirm = r.confirm;
  return out;
}

/** Container shape the answers artifact was stored in, so edits are written back the same way. */
export type AnswersShape = { kind: 'array' } | { kind: 'object'; key: string; rest: Record<string, unknown> };

/**
 * Reads an `answers` artifact. Accepts a bare AnsweredQuestion[] or {answers|questions: [...]}.
 * Malformed entries are dropped; unparseable content yields an empty list.
 */
export function parseAnswers(content: string | undefined | null): { list: AnsweredQuestion[]; shape: AnswersShape } {
  let data: unknown;
  try {
    data = JSON.parse(content ?? '');
  } catch {
    return { list: [], shape: { kind: 'array' } };
  }
  let rawList: unknown[] = [];
  let shape: AnswersShape = { kind: 'array' };
  if (Array.isArray(data)) rawList = data;
  else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const key = ['answers', 'questions', 'items'].find((k) => Array.isArray(record[k]));
    if (key) {
      rawList = record[key] as unknown[];
      const { [key]: _list, ...rest } = record;
      shape = { kind: 'object', key, rest };
    }
  }
  const list = rawList.map(toAnswered).filter((q): q is AnsweredQuestion => q !== null);
  return { list, shape };
}

export function serializeAnswers(list: AnsweredQuestion[], shape: AnswersShape): string {
  const body = shape.kind === 'array' ? list : { ...shape.rest, [shape.key]: list };
  return JSON.stringify(body, null, 2);
}

/** Kayzee typed an answer: it is now human-provided and no longer blocking. */
export function applyAnswerEdit(list: AnsweredQuestion[], questionId: string, value: string): AnsweredQuestion[] {
  const trimmed = value.trim();
  let found = false;
  const next = list.map((q) => {
    if (q.id !== questionId) return q;
    found = true;
    const edited: AnsweredQuestion & { editedByKayzee?: boolean } = {
      ...q,
      answer: trimmed || null,
      needsHuman: trimmed === '',
      confirm: false,
      editedByKayzee: true,
    };
    return edited;
  });
  if (!found) throw new Error(`Question ${questionId} not found in the answers artifact`);
  return next;
}

export function blockingAnswers(answers: AnsweredQuestion[]): AnsweredQuestion[] {
  return answers.filter((q) => q.needsHuman && !(q.answer && q.answer.trim()));
}

/**
 * Whether Approve is allowed. Unknown ATS jobs are always handed off (the generic filler never
 * submits), so open questions don't block them: Kayzee answers those in the browser.
 */
export function approvalGate(input: { status: Job['status']; ats: AtsKind; answers: AnsweredQuestion[]; hasCv: boolean }): ApprovalGate {
  const blocking = blockingAnswers(input.answers).length;
  if (input.status !== 'ready') return { ok: false, blocking, reason: `Job is ${input.status.replace('_', ' ')}, not ready.` };
  if (!input.hasCv) return { ok: false, blocking, reason: 'No CV PDF yet: regenerate the CV first.' };
  if (blocking > 0 && input.ats !== 'unknown') {
    return { ok: false, blocking, reason: `${blocking} screening question${blocking === 1 ? '' : 's'} need${blocking === 1 ? 's' : ''} your answer first.` };
  }
  return { ok: true, blocking };
}

/** Score + filter flags, de-duplicated (case-insensitive), in display order. */
export function jobFlags(job: Pick<Job, 'scoreDetail' | 'filters'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const flag of [...(job.filters?.flags ?? []), ...(job.scoreDetail?.flags ?? [])]) {
    const key = flag.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(flag.trim());
    }
  }
  return out;
}

export const BATCH_MIN_SCORE = 85;

/** "Approve all ≥ 85 with no flags": strict, so a batch never approves anything needing a look. */
export function batchEligible(item: Pick<QueueItem, 'job' | 'answers' | 'flags' | 'gate'>, minScore = BATCH_MIN_SCORE): boolean {
  return (
    item.gate.ok &&
    (item.job.score ?? 0) >= minScore &&
    item.flags.length === 0 &&
    blockingAnswers(item.answers).length === 0 &&
    !item.answers.some((a) => a.confirm === true)
  );
}

/** Reads an ats_report artifact; null when missing or not an object. */
export function parseAtsReport(content: string | undefined | null): AtsReport | null {
  let data: unknown;
  try {
    data = JSON.parse(content ?? '');
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    score: num(r.score),
    pages: num(r.pages),
    textExtractable: r.textExtractable !== false,
    badChars: asStringArray(r.badChars),
    sectionsFound: asStringArray(r.sectionsFound),
    sectionsMissing: asStringArray(r.sectionsMissing),
    contactFound: r.contactFound !== false,
    keywordPct: num(r.keywordPct),
    keywordsInText: asStringArray(r.keywordsInText),
    keywordsMissing: asStringArray(r.keywordsMissing),
    problems: asStringArray(r.problems),
  };
}

/** Pulls guard/slop findings from a cover_letter artifact's meta (shape set by the tailor module). */
export function letterFindings(meta: Record<string, unknown> | undefined): { guardProblems: string[]; slopHits: string[]; flags: string[]; edited: boolean } {
  if (!meta) return { guardProblems: [], slopHits: [], flags: [], edited: false };
  const guard = meta.guard as { problems?: unknown } | undefined;
  const slop = meta.slop as { hits?: unknown } | undefined;
  const guardProblems = asStringArray(guard?.problems ?? meta.guardProblems);
  const rawHits = Array.isArray(slop?.hits) ? slop.hits : Array.isArray(meta.slopHits) ? meta.slopHits : [];
  const slopHits = rawHits
    .map((h) => (typeof h === 'string' ? h : h && typeof h === 'object' ? `${(h as { rule?: string }).rule ?? 'slop'}: ${(h as { match?: string }).match ?? ''}` : null))
    .filter((h): h is string => Boolean(h));
  return { guardProblems, slopHits, flags: asStringArray(meta.flags), edited: meta.edited === true };
}
