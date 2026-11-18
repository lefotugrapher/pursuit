// Question queue tests: normalisation + dedupe across jobs, option fuzzy matching, answer validation,
// learned AnswerEntry (confirm:false) + re-queue of fully answered jobs only, sensitive questions
// never guessed, attestations, job-specific answers, the fill hook and the retry guard.
// Temp DB + temp config dir (copies of config/*.example.json); no network; the real config is untouched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-questions-test-'));
const CONFIG_TMP = path.join(TMP, 'config');
fs.mkdirSync(CONFIG_TMP, { recursive: true });
for (const name of ['profile', 'facts', 'answers', 'sources']) {
  fs.copyFileSync(path.join(ROOT, 'config', `${name}.example.json`), path.join(CONFIG_TMP, `${name}.example.json`));
}
const REAL_ANSWERS = path.join(ROOT, 'config', 'answers.json');
const realAnswersBefore = fs.existsSync(REAL_ANSWERS) ? fs.statSync(REAL_ANSWERS).mtimeMs : null;

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
process.env.PURSUIT_NOTIFY = 'off';
process.env.PURSUIT_DATA_DIR = path.join(TMP, 'data');
process.env.PURSUIT_CONFIG_DIR = CONFIG_TMP;
process.env.OPENROUTER_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.ORCAROUTER_API_KEY = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
globalThis.fetch = (async () => {
  throw new Error('network disabled in tests');
}) as typeof fetch;

const dbm = await import('../src/lib/db');
const { loadAnswers } = await import('../src/lib/config');
const Q = await import('../src/engine/questions');
const { findBankEntry } = await import('../src/engine/tailor/answers');
const { matchBankEntry } = await import('../src/engine/apply/fields');

type Job = import('../src/lib/types').Job;
type ScreeningQuestion = import('../src/lib/types').ScreeningQuestion;
type AnsweredQuestion = import('../src/lib/types').AnsweredQuestion;

let dbCounter = 0;
beforeEach(() => {
  dbm.closeDb();
  process.env.PURSUIT_DB_PATH = path.join(TMP, `q-${++dbCounter}.db`);
  fs.rmSync(path.join(CONFIG_TMP, 'answers.json'), { force: true });
});
after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
/** A job that Kayzee approved and the apply runner then parked in needs_you with `needs`. */
function parkedJob(needs: string[], opts: { approved?: boolean } = {}): Job {
  const n = ++seq;
  const { job } = dbm.upsertJob({
    id: `job${String(n).padStart(13, '0')}`, source: 'greenhouse', sourceId: `gh-${n}`, company: `Acme ${n}`, title: 'PR Executive',
    location: 'Dublin, Ireland', remote: false, url: `https://boards.example.test/${n}`, applyUrl: `https://boards.example.test/${n}`,
    ats: 'greenhouse', atsMeta: {}, description: 'PR role.',
  });
  dbm.setStatus(job.id, 'ready');
  if (opts.approved !== false) dbm.setStatus(job.id, 'approved');
  dbm.updateJob(job.id, { needs });
  dbm.setStatus(job.id, 'needs_you', { needs });
  return dbm.getJob(job.id)!;
}

const need = (label: string) => `Answer required question: "${label}"`;
const q = (label: string, over: Partial<ScreeningQuestion> = {}): ScreeningQuestion => ({ id: `f_${label.length}`, label, type: 'text', required: true, ...over });
const status = (id: string) => dbm.getJob(id)!.status;
const learned = () => loadAnswers().entries.filter((e) => e.id.startsWith('learned-'));
function jobAnswers(jobId: string): AnsweredQuestion[] {
  return JSON.parse(dbm.latestArtifact(jobId, 'answers')?.content ?? '[]') as AnsweredQuestion[];
}

describe('normalisation + classification', () => {
  test('questionKey strips case, punctuation, asterisks and "required"', () => {
    for (const label of ['Notice period *', 'Notice Period (required)', 'notice period - Required', '  NOTICE   period:  ']) {
      assert.equal(Q.questionKey(label), 'notice period', label);
    }
    assert.equal(Q.questionKey("What's your notice period?"), 'whats your notice period');
  });

  test('sensitive categories', () => {
    assert.equal(Q.sensitiveCategory('Will you now or in the future require visa sponsorship?'), 'visa');
    assert.equal(Q.sensitiveCategory('Do you have the right to work in Ireland?'), 'right_to_work');
    assert.equal(Q.sensitiveCategory('What are your salary expectations?'), 'salary');
    assert.equal(Q.sensitiveCategory('Do you have any criminal convictions?'), 'criminal_record');
    assert.equal(Q.sensitiveCategory('Do you need any reasonable accommodations for the interview?'), 'health');
    assert.equal(Q.sensitiveCategory('I certify that the information in this application is true and complete.'), 'attestation');
    assert.equal(Q.sensitiveCategory('What is your notice period?'), null);
    assert.equal(Q.sensitiveCategory('Do you have a full driving licence?'), null);
  });

  test('EEO and file questions are never queued', () => {
    const job = parkedJob([need('Gender')]);
    assert.equal(Q.queueQuestion({ jobId: job.id, question: q('Gender', { type: 'select', options: ['Male', 'Female'] }) }).reason, 'demographic');
    assert.equal(Q.queueQuestion({ jobId: job.id, question: q('Portfolio', { type: 'file' }) }).reason, 'file_upload');
    assert.equal(Q.pendingQuestions().length, 0);
  });
});

describe('queue', () => {
  test('one question, many waiting jobs (deduped by normalised label)', () => {
    const a = parkedJob([need('Notice period *')]);
    const b = parkedJob([need('Notice Period (required)')]);
    const r1 = Q.queueQuestion({ jobId: a.id, question: q('Notice period *', { id: 'np_a' }) });
    const r2 = Q.queueQuestion({ jobId: b.id, question: q('Notice Period (required)', { id: 'np_b' }) });
    const r3 = Q.queueQuestion({ jobId: a.id, question: q('Notice period *', { id: 'np_a' }) });
    assert.equal(r1.status, 'queued');
    assert.equal(r2.status, 'added');
    assert.equal(r3.status, 'already_waiting');
    assert.equal(r1.questionId, r2.questionId);
    const pending = Q.pendingQuestions();
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].waiting.map((w) => w.jobId).sort(), [a.id, b.id].sort());
    assert.equal(Q.questionsToSend().length, 1);
  });

  test('placeholder options are dropped', () => {
    assert.deepEqual(Q.cleanOptions(['Select...', '-- Please choose --', 'Yes', 'No', 'Yes', '']), ['Yes', 'No']);
  });
});

describe('matching his reply', () => {
  const degrees = ["Bachelor's Degree", "Master's Degree", 'PhD'];
  const notice = ['Immediately', '1 month', '2 months', '3 months or more'];

  test('matchOption: exact, number, yes/no lead, prefix, words, typos', () => {
    assert.equal(Q.matchOption("master's degree", degrees), "Master's Degree");
    assert.equal(Q.matchOption('2', degrees), "Master's Degree");
    assert.equal(Q.matchOption('masters', degrees), "Master's Degree");
    assert.equal(Q.matchOption('one month', notice), '1 month');
    assert.equal(Q.matchOption('imediately', notice), 'Immediately');
    assert.equal(Q.matchOption('yes', ['Yes, I do', "No, I don't"]), 'Yes, I do');
    assert.equal(Q.matchOption('nope', ['Yes, I do', "No, I don't"]), "No, I don't");
    assert.equal(Q.matchOption('1', ['0', '1-2', '3-5', '5+']), '1-2', 'numeric options are never treated as an index');
    assert.equal(Q.matchOption('banana', degrees), null);
    assert.equal(Q.matchOption('9', degrees), null);
  });

  test('validateAnswer by question type', () => {
    assert.deepEqual(Q.validateAnswer({ type: 'yesno' }, 'yep'), { ok: true, answer: 'Yes' });
    assert.equal(Q.validateAnswer({ type: 'yesno' }, 'maybe').ok, false);
    assert.deepEqual(Q.validateAnswer({ type: 'number' }, '€36,700'), { ok: true, answer: '36700' });
    assert.deepEqual(Q.validateAnswer({ type: 'number' }, '35k'), { ok: true, answer: '35000' });
    assert.equal(Q.validateAnswer({ type: 'number' }, 'lots').ok, false);
    assert.deepEqual(Q.validateAnswer({ type: 'url' }, 'linkedin.com/in/kayzee'), { ok: true, answer: 'https://linkedin.com/in/kayzee' });
    assert.deepEqual(Q.validateAnswer({ type: 'date' }, '01/12/2026'), { ok: true, answer: '2026-12-01' });
    assert.equal(Q.validateAnswer({ type: 'date' }, '31/02/2026').ok, false);
    assert.deepEqual(Q.validateAnswer({ type: 'select', options: notice }, '2 months'), { ok: true, answer: '2 months' });
    const bad = Q.validateAnswer({ type: 'select', options: notice }, 'whenever');
    assert.equal(bad.ok, false);
    assert.match((bad as { error: string }).error, /1\. Immediately/);
    assert.deepEqual(Q.validateAnswer({ type: 'checkbox', options: ['English', 'Irish', 'French'] }, 'english, irish'), { ok: true, answer: 'English, Irish' });
    assert.equal(Q.validateAnswer({ type: 'text' }, '   ').ok, false);
  });
});

describe('answering', () => {
  test('saves a learned AnswerEntry (confirm:false) and re-queues only fully answered jobs', () => {
    const notice = 'What is your notice period?';
    const licence = 'Do you have a full driving licence?';
    const both = parkedJob([need(notice), need(licence)]);
    const one = parkedJob([need(notice)]);
    const captcha = parkedJob([need(notice), 'CAPTCHA on the form: solve it in the browser']);
    const ready = dbm.upsertJob({ ...dbm.getJob(one.id)!, id: 'readyjob00000001', sourceId: 'r1', company: 'Not Approved Ltd' }).job;
    dbm.setStatus(ready.id, 'ready');

    const nq = Q.queueQuestion({ jobId: both.id, question: q(notice, { id: 'notice' }) }).questionId!;
    Q.queueQuestion({ jobId: one.id, question: q(notice, { id: 'notice' }) });
    Q.queueQuestion({ jobId: captcha.id, question: q(notice, { id: 'notice' }) });
    Q.queueQuestion({ jobId: ready.id, question: q(notice, { id: 'notice' }) });
    const lq = Q.queueQuestion({ jobId: both.id, question: q(licence, { id: 'licence', type: 'yesno' }) }).questionId!;

    const first = Q.answerQuestion(nq, '1 month', { via: 'telegram' });
    assert.equal(first.ok, true);
    assert.deepEqual(first.requeued, [one.id]);
    assert.deepEqual(first.waiting, [both.id]);
    assert.deepEqual(first.blocked.map((b) => b.jobId), [captcha.id]);
    assert.equal(status(one.id), 'approved');
    assert.equal(dbm.getJob(one.id)!.needs, undefined, 'stale needs are cleared');
    assert.equal(status(both.id), 'needs_you', 'still waiting on the licence question');
    assert.equal(status(captcha.id), 'needs_you', 'a CAPTCHA still blocks it');
    assert.equal(status(ready.id), 'ready', 'never approves a job Kayzee has not approved');
    const approvedEvent = dbm.listEvents({ jobId: one.id, type: dbm.STATUS_EVENT, limit: 1 })[0];
    assert.deepEqual(approvedEvent.detail, { from: 'needs_you', to: 'approved', detail: { reason: 'answers learned' } });

    const entry = learned().find((e) => e.id === first.entryId)!;
    assert.equal(entry.id, 'learned-what-is-your-notice-period');
    assert.equal(entry.answer, '1 month');
    assert.equal(entry.confirm, false);
    assert.equal(entry.type, 'text');
    assert.equal(entry.patterns[0], 'what is your notice period');
    assert.ok(entry.patterns.includes('notice period'), 'adds a sensible shorter variant');
    assert.ok(entry.patterns.length <= 3);
    assert.match(entry.notes ?? '', /^Learned from Telegram \d{4}-\d{2}-\d{2}$/);
    assert.equal(loadAnswers().entries[0].id, entry.id, 'learned entries go first');
    assert.equal(jobAnswers(one.id).find((a) => a.id === 'notice')?.answer, '1 month');
    assert.equal(jobAnswers(ready.id).find((a) => a.id === 'notice')?.needsHuman, false, 'ready jobs get the answer too');
    assert.equal(matchBankEntry('Notice period', loadAnswers())?.id, entry.id, 'the apply runner finds it by the shorter variant');

    const second = Q.answerQuestion(lq, 'yes');
    assert.equal(second.ok, true);
    assert.deepEqual(second.requeued, [both.id]);
    assert.equal(status(both.id), 'approved');
    assert.equal(jobAnswers(both.id).find((a) => a.id === 'licence')?.answer, 'Yes');
    assert.equal(Q.pendingQuestions().length, 0);

    assert.equal(Q.answerQuestion(nq, '2 months').ok, false, 'an answered question cannot be answered twice');
  });

  test('an invalid reply leaves the question open', () => {
    const job = parkedJob([need('Highest level of education')]);
    const id = Q.queueQuestion({ jobId: job.id, question: q('Highest level of education', { type: 'select', options: ['Leaving Cert', 'Degree', 'Masters'] }) }).questionId!;
    const out = Q.answerQuestion(id, 'a bit');
    assert.equal(out.ok, false);
    assert.equal(Q.pendingQuestions().length, 1);
    assert.equal(learned().length, 0);
    assert.equal(Q.answerQuestion(id, '3').answer, 'Masters');
  });

  test('a later job with the same question uses his saved answer without asking', () => {
    const first = parkedJob([need('Are you willing to travel?')]);
    const id = Q.queueQuestion({ jobId: first.id, question: q('Are you willing to travel?', { type: 'yesno' }) }).questionId!;
    Q.answerQuestion(id, 'Yes');
    const later = parkedJob([need('Are you willing to travel?')]);
    const r = Q.queueQuestion({ jobId: later.id, question: q('Are you willing to travel?', { id: 'travel', type: 'radio', options: ['Yes', 'No'] }) });
    assert.equal(r.status, 'auto_answered');
    assert.equal(r.requeued, true);
    assert.equal(status(later.id), 'approved');
    assert.equal(jobAnswers(later.id).find((a) => a.id === 'travel')?.answer, 'Yes');
  });
});

describe('sensitive questions', () => {
  test('never answered from generic bank entries, similar wording or other learned answers', () => {
    const visa = 'Do you require visa sponsorship?';
    const a = parkedJob([need(visa)]);
    const id = Q.queueQuestion({ jobId: a.id, question: q(visa, { type: 'yesno' }) }).questionId!;
    assert.equal(Q.getQuestion(id)!.category, 'visa');
    const out = Q.answerQuestion(id, 'Yes');
    const entry = learned().find((e) => e.id === out.entryId)!;
    assert.deepEqual(entry.patterns, [Q.exactPattern('do you require visa sponsorship')], 'exact wording only, no variants');
    assert.match(entry.notes ?? '', /visa\/sponsorship: this exact question only/);

    // Tailoring matches the exact question only.
    assert.equal(findBankEntry('Do you require visa sponsorship? *', loadAnswers())?.id, entry.id);
    assert.notEqual(findBankEntry('Do you require visa sponsorship now or in the future?', loadAnswers())?.id, entry.id);
    // The apply-time bank fallback never uses it (the answer reaches forms through the job's answers).
    assert.equal(matchBankEntry(visa, loadAnswers())?.id === entry.id, false);

    // Different wording: asked, not auto-answered.
    const b = parkedJob([need('Will you require visa sponsorship in the future?')]);
    assert.equal(Q.queueQuestion({ jobId: b.id, question: q('Will you require visa sponsorship in the future?', { type: 'yesno' }) }).status, 'queued');
    // A non-sensitive learned answer whose words appear inside a sensitive question is not used either.
    const relocate = parkedJob([need('Are you willing to relocate?')]);
    Q.answerQuestion(Q.queueQuestion({ jobId: relocate.id, question: q('Are you willing to relocate?', { type: 'yesno' }) }).questionId!, 'Yes');
    const c = parkedJob([need('Are you willing to relocate if we sponsor your visa?')]);
    assert.equal(Q.queueQuestion({ jobId: c.id, question: q('Are you willing to relocate if we sponsor your visa?', { type: 'yesno' }) }).status, 'queued');
    assert.equal(status(c.id), 'needs_you');
  });

  test('a confirmed generic bank entry never answers a sensitive question', () => {
    fs.writeFileSync(path.join(CONFIG_TMP, 'answers.json'), JSON.stringify({
      entries: [{ id: 'right-to-work', patterns: ['right to work'], answer: 'Yes', type: 'yesno', confirm: false }],
    }));
    const job = parkedJob([need('Do you have the right to work in Ireland?')]);
    const r = Q.queueQuestion({ jobId: job.id, question: q('Do you have the right to work in Ireland?', { type: 'yesno' }) });
    assert.equal(r.status, 'queued');
    assert.equal(status(job.id), 'needs_you');
  });

  test('salary questions are asked and kept for the exact wording', () => {
    const job = parkedJob([need('Expected annual salary (EUR)')]);
    const id = Q.queueQuestion({ jobId: job.id, question: q('Expected annual salary (EUR)', { type: 'number' }) }).questionId!;
    assert.equal(Q.getQuestion(id)!.category, 'salary');
    const out = Q.answerQuestion(id, '€36,700');
    assert.equal(out.answer, '36700');
    assert.deepEqual(learned()[0].patterns, [Q.exactPattern('expected annual salary eur')]);
    assert.equal(status(job.id), 'approved');
  });
});

describe('attestations', () => {
  const text = 'I certify that the information provided in this application is true and complete.';
  const legal = `Legal attestation needs your decision: "${text}"`;

  test('yes/no only, stored for the exact wording, ticks via the job answers', () => {
    const job = parkedJob([legal]);
    const id = Q.queueQuestion({ jobId: job.id, question: q(text, { id: 'certify', type: 'checkbox', options: [text] }) }).questionId!;
    const rec = Q.getQuestion(id)!;
    assert.equal(rec.category, 'attestation');
    assert.equal(rec.label, text, 'the exact text is kept');
    assert.equal(Q.answerQuestion(id, 'probably').ok, false);
    const out = Q.answerQuestion(id, 'I agree');
    assert.equal(out.answer, 'Yes');
    const entry = learned()[0];
    assert.deepEqual(entry.patterns, [Q.exactPattern(Q.questionKey(text))]);
    assert.equal(entry.type, 'yesno');
    assert.equal(jobAnswers(job.id).find((a) => a.id === 'certify')?.answer, 'Yes');
    assert.equal(status(job.id), 'approved');
    // A longer statement that merely contains this one is a different attestation.
    assert.notEqual(findBankEntry(`${text} I also consent to a background check.`, loadAnswers())?.id, entry.id);
  });

  test('No keeps the job parked, and later jobs with that statement are not retried', () => {
    const job = parkedJob([legal]);
    const id = Q.queueQuestion({ jobId: job.id, question: q(text, { type: 'checkbox' }) }).questionId!;
    const out = Q.answerQuestion(id, 'no');
    assert.equal(out.declined, true);
    assert.deepEqual(out.requeued, []);
    assert.equal(status(job.id), 'needs_you');
    const later = parkedJob([legal]);
    assert.equal(Q.queueQuestion({ jobId: later.id, question: q(text, { type: 'checkbox' }) }).reason, 'attestation_declined');
  });
});

describe('job-specific answers and the fill hook', () => {
  test('"why us" answers stay on that job and never go in the bank', () => {
    const a = parkedJob([need('Why do you want to work here?')]);
    const b = parkedJob([need('Why do you want to work here?')]);
    const qa = Q.queueQuestion({ jobId: a.id, question: q('Why do you want to work here?', { id: 'why', type: 'textarea' }) }).questionId!;
    const qb = Q.queueQuestion({ jobId: b.id, question: q('Why do you want to work here?', { id: 'why', type: 'textarea' }) }).questionId!;
    assert.notEqual(qa, qb, 'asked per application');
    const out = Q.answerQuestion(qa, "I like Acme 1's community PR work.");
    assert.equal(out.ok, true);
    assert.equal(out.entryId, undefined);
    assert.equal(learned().length, 0);
    assert.equal(status(a.id), 'approved');
    assert.equal(status(b.id), 'needs_you');
  });

  test('queueQuestionsFromFill queues only when answering unblocks the job', () => {
    const job = parkedJob([need('Notice period'), need('Do you have a car?')]);
    const seen: ScreeningQuestion[] = [q('Notice period', { id: 'np' }), q('Do you have a car?', { id: 'car', type: 'yesno' })];
    const ok = Q.queueQuestionsFromFill(job.id, {
      unfilledRequired: ['Notice period', 'Do you have a car?'], questionsSeen: seen, blockers: ['unknown_required_field'],
      reasons: { 'Notice period': need('Notice period'), 'Do you have a car?': need('Do you have a car?') },
    });
    assert.deepEqual(ok.queued.map((r) => r.status), ['queued', 'queued']);

    const other = parkedJob([need('Notice period')]);
    assert.match(Q.queueQuestionsFromFill(other.id, { unfilledRequired: ['Notice period'], questionsSeen: seen, blockers: ['captcha', 'unknown_required_field'] }).skipped ?? '', /captcha/);
    const upload = Q.queueQuestionsFromFill(other.id, {
      unfilledRequired: ['Notice period', 'Portfolio'], questionsSeen: seen, blockers: ['unknown_required_field'],
      reasons: { 'Notice period': need('Notice period'), Portfolio: 'File upload required: "Portfolio"' },
    });
    assert.equal(upload.queued.length, 0);
    assert.match(upload.skipped ?? '', /File upload/);
  });

  test('stops retrying a job after the form refuses his answer twice', () => {
    const job = parkedJob([need('Notice period')]);
    const id = Q.queueQuestion({ jobId: job.id, question: q('Notice period', { id: 'np' }) }).questionId!;
    Q.answerQuestion(id, '1 month');
    assert.equal(status(job.id), 'approved');
    // The runner comes back: the form still flagged it. Asked again, with a note.
    dbm.setStatus(job.id, 'needs_you');
    const again = Q.queueQuestion({ jobId: job.id, question: q('Notice period', { id: 'np' }) });
    assert.equal(again.status, 'queued');
    assert.match(Q.getQuestion(id)!.note ?? '', /form still flagged/);
    Q.answerQuestion(id, '4 weeks');
    dbm.setStatus(job.id, 'needs_you');
    assert.equal(Q.queueQuestion({ jobId: job.id, question: q('Notice period', { id: 'np' }) }).reason, 'repeated_failure');
  });

  test('withdrawn jobs drop out and their questions close', () => {
    const job = parkedJob([need('Notice period')]);
    Q.queueQuestion({ jobId: job.id, question: q('Notice period') });
    dbm.setStatus(job.id, 'withdrawn');
    assert.deepEqual(Q.pruneQuestions(), { dismissed: 1, removed: 0 });
    assert.equal(Q.pendingQuestions().length, 0);
  });

  test('needLabel reads the runner needs', () => {
    assert.equal(Q.needLabel('Answer required question: "Notice period"'), 'Notice period');
    assert.equal(Q.needLabel('No option matches the approved answer "BA" for "Education"'), 'Education');
    assert.equal(Q.needLabel('CAPTCHA on the form'), null);
  });

  test('the real config/answers.json is never touched', () => {
    const now = fs.existsSync(REAL_ANSWERS) ? fs.statSync(REAL_ANSWERS).mtimeMs : null;
    assert.equal(now, realAnswersBefore);
  });
});
