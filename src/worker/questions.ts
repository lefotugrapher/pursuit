// Turns the question schema an ATS adapter captured in job.atsMeta into ScreeningQuestion[].
//
// Adapters may store questions already normalised, or as the ATS's raw shape:
// - Greenhouse: { label, required, fields: [{ name, type, values: [{ label, value }] }] }
// - Lever:      { text, required, type, options: [{ text }] }  (also nested under customQuestions[].fields)
// - Ashby:      { field: { path, title, type, isRequired?, selectableValues: [{ label }] }, isRequired }
// Standard identity/CV fields are dropped: the apply runner fills those from the profile and CV.
// The input is untrusted data, so every value is type-checked and capped.

import type { ScreeningQuestion } from '@/lib/types';

type QType = ScreeningQuestion['type'];

const QUESTION_KEYS = ['questions', 'customQuestions', 'screeningQuestions', 'applicationQuestions'] as const;
const MAX_QUESTIONS = 60;
const MAX_LABEL = 500;
const MAX_OPTIONS = 100;

const STANDARD_FIELDS = new Set([
  'first_name', 'last_name', 'name', 'full_name', 'preferred_name', 'email', 'phone', 'location',
  'resume', 'resume_text', 'cv', 'cover_letter', 'cover_letter_text', 'linkedin', 'urls[linkedin]',
]);

const VALID_TYPES = new Set<QType>(['text', 'textarea', 'select', 'radio', 'checkbox', 'file', 'number', 'url', 'date', 'yesno']);

const TYPE_MAP: Record<string, QType | null> = {
  // Greenhouse
  input_text: 'text', textarea: 'textarea', multi_value_single_select: 'select', multi_value_multi_select: 'checkbox',
  input_file: 'file', input_hidden: null,
  // Lever
  text: 'text', 'multiple-choice': 'radio', 'multiple-select': 'checkbox', dropdown: 'select', file: 'file',
  // Ashby
  string: 'text', longtext: 'textarea', boolean: 'yesno', valueselect: 'select', multivalueselect: 'checkbox',
  number: 'number', email: 'text', phone: 'text', date: 'date', location: 'text', score: 'number',
  // generic
  select: 'select', radio: 'radio', checkbox: 'checkbox', url: 'url', yesno: 'yesno',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_LABEL) : undefined);

function mapType(raw: unknown): QType | null {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) return 'text';
  const exact = TYPE_MAP[key];
  if (exact !== undefined) return exact;
  const lower = TYPE_MAP[key.toLowerCase()];
  if (lower !== undefined) return lower;
  return VALID_TYPES.has(key as QType) ? (key as QType) : 'text';
}

function optionLabels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const labels = raw
    .map((o) => (typeof o === 'string' ? str(o) : isObj(o) ? str(o.label) ?? str(o.text) ?? str(o.value) ?? str(o.name) : undefined))
    .filter((s): s is string => Boolean(s))
    .slice(0, MAX_OPTIONS);
  return labels.length ? labels : undefined;
}

function isStandard(id: string): boolean {
  const lower = id.toLowerCase();
  return STANDARD_FIELDS.has(lower) || lower.startsWith('_systemfield_');
}

function build(id: string | undefined, label: string | undefined, type: QType | null, required: unknown, options?: string[]): ScreeningQuestion | null {
  if (!id || !label || type === null || isStandard(id)) return null;
  const q: ScreeningQuestion = { id: id.slice(0, 200), label, type, required: required === true };
  if (options?.length) q.options = options;
  return q;
}

/** One raw entry → zero or more questions (a Greenhouse question can carry several fields). */
function fromEntry(entry: unknown, index: number): ScreeningQuestion[] {
  if (!isObj(entry)) return [];

  // Already normalised.
  if (str(entry.id) && str(entry.label) && typeof entry.type === 'string' && VALID_TYPES.has(entry.type as QType)) {
    const q = build(str(entry.id), str(entry.label), entry.type as QType, entry.required, optionLabels(entry.options));
    return q ? [q] : [];
  }

  // Greenhouse.
  if (Array.isArray(entry.fields) && str(entry.label)) {
    const label = str(entry.label);
    const out: ScreeningQuestion[] = [];
    for (const field of entry.fields) {
      if (!isObj(field)) continue;
      const q = build(str(field.name), label, mapType(field.type), entry.required, optionLabels(field.values));
      if (q) out.push(q);
    }
    return out;
  }

  // Lever custom-question card: { text?, fields: [...] } where each field is a Lever question.
  if (Array.isArray(entry.fields)) return entry.fields.flatMap((f, i) => fromEntry(f, i));

  // Ashby.
  if (isObj(entry.field)) {
    const f = entry.field;
    const required = entry.isRequired ?? f.isRequired;
    const q = build(str(f.path) ?? str(f.id), str(f.title) ?? str(f.label), mapType(f.type), required, optionLabels(f.selectableValues));
    return q ? [q] : [];
  }

  // Lever single question.
  if (str(entry.text)) {
    const id = str(entry.id) ?? str(entry.name) ?? `q${index}`;
    const q = build(id, str(entry.text), mapType(entry.type), entry.required, optionLabels(entry.options));
    return q ? [q] : [];
  }
  return [];
}

/** Screening questions from job.atsMeta, deduped by id; [] when the adapter captured none. */
export function questionsFromAtsMeta(atsMeta: Record<string, unknown> | undefined): ScreeningQuestion[] {
  if (!isObj(atsMeta)) return [];
  const out: ScreeningQuestion[] = [];
  const seen = new Set<string>();
  for (const key of QUESTION_KEYS) {
    const list = atsMeta[key];
    if (!Array.isArray(list)) continue;
    list.forEach((entry, i) => {
      for (const q of fromEntry(entry, i)) {
        if (seen.has(q.id) || out.length >= MAX_QUESTIONS) continue;
        seen.add(q.id);
        out.push(q);
      }
    });
  }
  return out;
}
