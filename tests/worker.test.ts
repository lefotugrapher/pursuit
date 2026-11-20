// Worker tests: scheduler due-ness (injected clock), runTask pause/mutex/lease, lock file, the
// SPEC §7 autopilot gate (each failing condition), pipeline stages with injected fakes, and the
// atsMeta question normaliser. Temp DB + temp data dir; no engine module, network or browser is used.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
process.env.PURSUIT_NOTIFY = 'off';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-worker-test-'));
process.env.PURSUIT_DATA_DIR = path.join(TMP, 'data');
let dbCounter = 0;

const dbm = await import('../src/lib/db');
const time = await import('../src/lib/time');
const { DEFAULT_SETTINGS } = await import('../src/lib/types');
const lock = await import('../src/worker/lock');
const scheduler = await import('../src/worker/scheduler');
const tasks = await import('../src/worker/tasks');
const pipeline = await import('../src/worker/pipeline');
const { questionsFromAtsMeta } = await import('../src/worker/questions');

type Types = typeof import('../src/lib/types');
type Settings = import('../src/lib/types').Settings;
type Job = import('../src/lib/types').Job;
type NewJob = import('../src/lib/types').NewJob;
type AnsweredQuestion = import('../src/lib/types').AnsweredQuestion;
type PipelineDeps = import('../src/worker/deps').PipelineDeps;
type TaskDef = import('../src/worker/tasks').TaskDef;
type TaskName = import('../src/worker/tasks').TaskName;
void (null as unknown as Types);

function freshDb(): void {
  dbm.closeDb();
  process.env.PURSUIT_DB_PATH = path.join(TMP, `w${++dbCounter}.db`);
}

beforeEach(freshDb);
after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch });
/** A UTC instant at hh:mm Dublin time today (Dublin is UTC+0 in November, but don't rely on it). */
function dublinAt(hhmm: string, ymd = time.todayDublin()): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(time.dublinMidnight(ymd).getTime() + (h * 60 + m) * 60_000);
}
const NOON = () => dublinAt('12:00');
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;

let jobSeq = 0;
function makeJob(over: Partial<NewJob> = {}): NewJob {
  const n = ++jobSeq;
  return {
    id: `job${String(n).padStart(13, '0')}`,
    source: 'greenhouse', sourceId: `gh-${n}`, company: `Acme ${n}`, title: 'PR Executive', location: 'Dublin, Ireland', country: 'IE',
    remote: false, url: `https://boards.example.test/acme/${n}`, applyUrl: `https://boards.example.test/acme/${n}`, ats: 'greenhouse',
    atsMeta: {}, description: 'Write press releases and social content.', ...over,
  };
}

function insertJob(status: Job['status'], over: Partial<NewJob> = {}, patch: Partial<Job> = {}): Job {
  const { job } = dbm.upsertJob(makeJob(over));
  if (Object.keys(patch).length) dbm.updateJob(job.id, patch);
  if (status !== 'discovered') dbm.setStatus(job.id, status);
  return dbm.getJob(job.id)!;
}

const PROFILE = { name: { first: 'K', last: 'M', preferred: 'K', full: 'K M' } } as unknown as ReturnType<PipelineDeps['loadProfile']>;
const FACTS = { version: 1, summaries: {}, facts: [], skills: [], tools: [], doNotClaim: [] };
const ANSWERS = { entries: [] };

/** Deps where every engine call throws unless the test overrides it. */
function fakeDeps(over: Partial<PipelineDeps> = {}): Partial<PipelineDeps> {
  const nope = (name: string) => () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    now: NOON,
    sleep: async () => {},
    random: () => 0.5,
    loadProfile: () => PROFILE,
    loadFacts: () => FACTS,
    loadAnswers: () => ANSWERS,
    hardFilters: nope('hardFilters'),
    extractKeywords: () => [{ term: 'press releases', kind: 'skill', weight: 1 }],
    coverage: () => ({ keywords: [], matched: [], gaps: [], pct: 80 }),
    scoreJob: nope('scoreJob'),
    tailorCv: nope('tailorCv'),
    writeCoverLetter: nope('writeCoverLetter'),
    answerQuestions: nope('answerQuestions'),
    applyToJob: nope('applyToJob'),
    findContacts: nope('findContacts'),
    draftOutreachEmail: nope('draftOutreachEmail'),
    draftLinkedInNote: nope('draftLinkedInNote'),
    notify: () => undefined,
    checkCoverLetter: () => ({ guard: { ok: true, problems: [] }, slop: { ok: true, hits: [] }, problems: [] }),
    guardText: nope('guardText'),
    lintSlop: nope('lintSlop'),
    ...over,
  };
}

// ───────────────────────────── Scheduler ─────────────────────────────

describe('scheduler due-ness', () => {
  const ctx = (over: Partial<import('../src/worker/scheduler').DueContext> = {}) => ({
    now: NOON(), settings: settings(), lastRuns: {}, mailConfigured: true, ...over,
  });

  test('a fresh install at noon: everything due except disabled autopilot and not-yet-due digest? (digest is due after 08:00)', () => {
    const due = scheduler.dueTasks(ctx());
    assert.deepEqual(due.sort(), ['apply', 'digest', 'discover', 'followups', 'handoff', 'inbox', 'outreach', 'resolve', 'score', 'send', 'tailor'].sort());
  });

  test('mail-dependent tasks wait for Gmail config', () => {
    const due = scheduler.dueTasks(ctx({ mailConfigured: false }));
    for (const t of ['inbox', 'send', 'digest'] as TaskName[]) assert.ok(!due.includes(t), t);
    assert.deepEqual(scheduler.checkDue('inbox', ctx({ mailConfigured: false })), { due: false, reason: 'Gmail not configured' });
  });

  test('interval tasks respect their interval (with a few seconds of slack)', () => {
    const now = NOON();
    const at = (msAgo: number) => scheduler.checkDue('score', ctx({ now, lastRuns: { score: ago(now, msAgo) } })).due;
    assert.equal(at(10_000), false);
    assert.equal(at(30_000 - 3_000), true);
    assert.equal(at(30_000), true);
    const applyDue = (msAgo: number) => scheduler.checkDue('apply', ctx({ now, lastRuns: { apply: ago(now, msAgo) } })).due;
    assert.equal(applyDue(30_000), false);
    assert.equal(applyDue(MIN), true);
    const inboxDue = (msAgo: number) => scheduler.checkDue('inbox', ctx({ now, lastRuns: { inbox: ago(now, msAgo) } })).due;
    assert.equal(inboxDue(9 * MIN), false);
    assert.equal(inboxDue(10 * MIN), true);
    const outreachDue = (msAgo: number) => scheduler.checkDue('outreach', ctx({ now, lastRuns: { outreach: ago(now, msAgo) } })).due;
    assert.equal(outreachDue(14 * MIN), false);
    assert.equal(outreachDue(15 * MIN), true);
  });

  test('discovery runs every discoveryEveryHours and never in quiet hours', () => {
    const now = NOON();
    const s = settings({ discoveryEveryHours: 3 });
    assert.equal(scheduler.checkDue('discover', ctx({ now, settings: s, lastRuns: { discover: ago(now, 2 * 60 * MIN) } })).due, false);
    assert.equal(scheduler.checkDue('discover', ctx({ now, settings: s, lastRuns: { discover: ago(now, 3 * 60 * MIN) } })).due, true);
    const night = dublinAt('23:30');
    assert.deepEqual(scheduler.checkDue('discover', ctx({ now: night, settings: s })), { due: false, reason: 'quiet hours' });
    assert.equal(scheduler.checkDue('score', ctx({ now: night })).due, true, 'scoring is not outbound and runs at night');
    assert.equal(scheduler.checkDue('discover', ctx({ settings: settings({ discoveryEveryHours: 0 }) })).due, false);
  });

  test('daily tasks: follow-ups after 09:30, digest after 08:00, once per Dublin day', () => {
    assert.equal(scheduler.checkDue('followups', ctx({ now: dublinAt('09:00') })).due, false);
    assert.equal(scheduler.checkDue('followups', ctx({ now: dublinAt('09:30') })).due, true);
    assert.equal(scheduler.checkDue('digest', ctx({ now: dublinAt('07:59') })).due, false);
    assert.equal(scheduler.checkDue('digest', ctx({ now: dublinAt('08:00') })).due, true);
    const now = dublinAt('15:00');
    const ranToday = dublinAt('09:31').toISOString();
    const ranYesterday = dublinAt('09:31', time.addDays(time.todayDublin(), -1)).toISOString();
    assert.deepEqual(scheduler.checkDue('followups', ctx({ now, lastRuns: { followups: ranToday } })), { due: false, reason: 'already ran today' });
    assert.equal(scheduler.checkDue('followups', ctx({ now, lastRuns: { followups: ranYesterday } })).due, true);
  });

  test('pause blocks every outbound task but not the rest', () => {
    const s = settings({ paused: true, mode: 'autopilot', autopilot: { ...DEFAULT_SETTINGS.autopilot, enabled: true } });
    const due = scheduler.dueTasks(ctx({ settings: s }));
    for (const t of ['apply', 'send', 'digest', 'autopilot'] as TaskName[]) assert.ok(!due.includes(t), `${t} should be blocked`);
    for (const t of ['score', 'tailor', 'discover', 'inbox', 'outreach', 'followups'] as TaskName[]) assert.ok(due.includes(t), `${t} should run`);
  });

  test('autopilot every minute only when mode=autopilot and enabled, never in quiet hours', () => {
    const on = settings({ mode: 'autopilot', autopilot: { ...DEFAULT_SETTINGS.autopilot, enabled: true } });
    assert.equal(scheduler.checkDue('autopilot', ctx({ settings: on })).due, true);
    assert.equal(scheduler.checkDue('autopilot', ctx({ settings: { ...on, mode: 'review' } })).due, false);
    assert.equal(scheduler.checkDue('autopilot', ctx({ settings: on, now: dublinAt('23:00') })).due, false);
    const now = NOON();
    assert.equal(scheduler.checkDue('autopilot', ctx({ settings: on, now, lastRuns: { autopilot: ago(now, 20_000) } })).due, false);
  });

  test('tick starts due tasks, skips in-flight ones, writes a heartbeat, and stop aborts waits', async () => {
    const started: string[] = [];
    const release: (() => void)[] = [];
    let aborted = false;
    const s = scheduler.createScheduler({
      now: NOON,
      settings: () => settings(),
      mailConfigured: () => false,
      lastRuns: () => ({}),
      run: (name, signal) => {
        started.push(name);
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise((resolve) => release.push(() => resolve({ task: name, ok: true, startedAt: '', durationMs: 0 })));
      },
    });
    const first = await s.tick();
    assert.deepEqual(first.sort(), ['apply', 'discover', 'followups', 'handoff', 'outreach', 'resolve', 'score', 'tailor'].sort());
    const second = await s.tick();
    assert.deepEqual(second, [], 'in-flight tasks are not started again');
    assert.equal(scheduler.workerStatus(NOON()).online, true);
    const stopping = s.stop(5_000);
    assert.equal(aborted, true);
    release.forEach((r) => r());
    assert.deepEqual(await stopping, []);
    assert.deepEqual(await s.tick(), [], 'a stopped scheduler does nothing');
  });

  test('workerStatus goes offline when the heartbeat is stale', () => {
    scheduler.writeHeartbeat(new Date().toISOString(), 30_000, new Date(Date.now() - 5 * MIN));
    assert.equal(scheduler.workerStatus().online, false);
    scheduler.writeHeartbeat(new Date().toISOString(), 30_000);
    assert.equal(scheduler.workerStatus().online, true);
  });
});

// ───────────────────────────── runTask ─────────────────────────────

describe('runTask', () => {
  const def = (run: TaskDef['run'], outbound = false): TaskDef => ({ label: 'fake', outbound, run });

  test('refuses outbound tasks while paused (nothing runs, nothing recorded)', async () => {
    dbm.updateSettings({ paused: true });
    let ran = false;
    const r = await tasks.runTask('apply', { tasks: { apply: def(async () => ((ran = true), {}), true) } });
    assert.equal(r.skipped, 'paused');
    assert.equal(ran, false);
    assert.equal(dbm.listRuns(10).length, 0);
    assert.equal(tasks.lastRunAt('apply'), undefined, 'a paused skip must not push back the schedule');
  });

  test('runs non-outbound tasks while paused, records the run and the last-run time', async () => {
    dbm.updateSettings({ paused: true });
    const r = await tasks.runTask('score', { tasks: { score: def(async () => ({ scored: 3 })) }, trigger: 'manual' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.stats, { scored: 3 });
    const [run] = dbm.listRuns(1);
    assert.equal(run.kind, 'score');
    assert.equal(run.ok, true);
    assert.deepEqual(run.stats, { scored: 3, trigger: 'manual' });
    assert.ok(tasks.lastRunAt('score'));
    assert.equal(lock.readLease('score'), undefined, 'lease released after the run');
  });

  test('a throwing task is caught, recorded as failed, and the lease is released', async () => {
    const r = await tasks.runTask('discover', { tasks: { discover: def(async () => { throw new Error('board down'); }) } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'board down');
    const [run] = dbm.listRuns(1);
    assert.equal(run.ok, false);
    assert.equal(run.error, 'board down');
    assert.equal(lock.readLease('discover'), undefined);
  });

  test('in-process mutex: the same task never runs twice at once', async () => {
    let finish!: () => void;
    let calls = 0;
    const slow = def(() => {
      calls++;
      return new Promise((resolve) => {
        finish = () => resolve({});
      });
    });
    const first = tasks.runTask('tailor', { tasks: { tailor: slow } });
    const second = await tasks.runTask('tailor', { tasks: { tailor: slow } });
    assert.equal(second.skipped, 'running');
    assert.deepEqual(tasks.runningTasks(), ['tailor']);
    finish();
    assert.equal((await first).ok, true);
    assert.equal(calls, 1);
    assert.deepEqual(tasks.runningTasks(), []);
  });

  test('DB lease held by another process blocks the run; an expired one does not', async () => {
    const other = lock.acquireLease('inbox', { owner: 'other-host:999:abc', ttlMs: 10 * MIN });
    assert.equal(other.ok, true);
    let ran = 0;
    const fake = def(async () => ((ran++), {}));
    const blocked = await tasks.runTask('inbox', { tasks: { inbox: fake } });
    assert.equal(blocked.skipped, 'leased');
    assert.equal(blocked.holder?.pid, process.pid);
    assert.equal(ran, 0);

    lock.acquireLease('inbox', { owner: 'other-host:999:abc', ttlMs: 10 * MIN, now: new Date(Date.now() - 11 * MIN) });
    const r = await tasks.runTask('inbox', { tasks: { inbox: fake } });
    assert.equal(r.ok, true);
    assert.equal(ran, 1);
  });

  test('lease renewal keeps a long task leased; only the owner can renew or release', async () => {
    const a = lock.acquireLease('send', { owner: 'a', ttlMs: 1_000 });
    assert.equal(a.ok, true);
    assert.equal(lock.acquireLease('send', { owner: 'b' }).ok, false);
    assert.equal(lock.renewLease('send', { owner: 'b' }), false);
    assert.equal(lock.renewLease('send', { owner: 'a', ttlMs: 60_000 }), true);
    lock.releaseLease('send', 'b');
    assert.ok(lock.readLease('send'), 'non-owner release is ignored');
    lock.releaseLease('send', 'a');
    assert.equal(lock.readLease('send'), undefined);
  });

  test('releaseOwnedLeases and clearDeadLeases', () => {
    lock.acquireLease('score', { owner: 'me' });
    lock.acquireLease('tailor', { owner: 'me' });
    assert.equal(lock.releaseOwnedLeases('me'), 2);
    dbm.kvSet('lease.apply', { owner: `${os.hostname()}:1:x`, pid: 2 ** 22 + 12345, host: os.hostname(), acquiredAt: '', expiresAt: new Date(Date.now() + MIN).toISOString() });
    assert.deepEqual(lock.clearDeadLeases(), ['lease.apply']);
    assert.equal(lock.readLease('apply'), undefined);
  });

  test('unknown task names are rejected without throwing', async () => {
    const r = await tasks.runTask('nope' as TaskName);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /Unknown task/);
  });

  test('registry covers every task and marks the outbound ones', () => {
    assert.deepEqual(Object.keys(tasks.TASKS).sort(), [...tasks.TASK_NAMES].sort());
    const outbound = tasks.TASK_NAMES.filter((n) => tasks.TASKS[n].outbound).sort();
    assert.deepEqual(outbound, ['apply', 'autopilot', 'digest', 'handoff', 'send']);
  });
});

// ───────────────────────────── Lock file ─────────────────────────────

describe('worker lock file', () => {
  const file = () => path.join(TMP, `lock-${++dbCounter}`, 'worker.lock');

  test('takes a free lock, writes pid first, releases it', () => {
    const f = file();
    const r = lock.acquireWorkerLock(f);
    assert.equal(r.ok, true);
    assert.equal(Number(/\d+/.exec(fs.readFileSync(f, 'utf8'))?.[0]), process.pid, 'doctor reads the first number as the pid');
    if (r.ok) r.release();
    assert.equal(fs.existsSync(f), false);
  });

  test('refuses when a live process holds it', () => {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: 'x' }));
    const r = lock.acquireWorkerLock(f);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.holder?.pid, process.ppid);
  });

  test('replaces a stale lock (dead pid or garbage)', () => {
    const dead = 2 ** 22 + 4321;
    assert.equal(lock.isPidAlive(dead), false);
    for (const content of [JSON.stringify({ pid: dead }), 'not json']) {
      const f = file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      const r = lock.acquireWorkerLock(f);
      assert.equal(r.ok, true, content);
      if (r.ok) r.release();
    }
  });
});

// ───────────────────────────── Autopilot gate ─────────────────────────────

describe('autopilot gate (SPEC §7)', () => {
  const ON: Partial<Settings> = { mode: 'autopilot', autopilot: { enabled: true, minScore: 85, dailyCap: 10, ats: ['greenhouse', 'lever', 'ashby'], requireAllAnswers: true } };
  const goodAnswers: AnsweredQuestion[] = [
    { id: 'q1', label: 'Do you need sponsorship?', type: 'yesno', required: true, answer: 'No', source: 'bank', answerId: 'visa', needsHuman: false },
    { id: 'resume', label: 'Resume/CV', type: 'file', required: true, answer: null, source: 'none', needsHuman: false },
  ];

  interface Variant { job?: Partial<Job>; newJob?: Partial<NewJob>; answers?: AnsweredQuestion[]; atsScore?: number; cvGuardOk?: boolean; noPdfFile?: boolean; questions?: unknown[] }

  function eligibleJob(v: Variant = {}): Job {
    const pdf = path.join(TMP, `cv-${++dbCounter}.pdf`);
    if (!v.noPdfFile) fs.writeFileSync(pdf, '%PDF-1.4 test');
    const job = insertJob('ready', { atsMeta: { questions: v.questions ?? [{ id: 'q1', label: 'Do you need sponsorship?', type: 'yesno', required: true }] }, ...v.newJob }, {
      score: 90,
      scoreDetail: { total: 90, components: { skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: [], llmUsed: false, scoredAt: new Date().toISOString() },
      filters: { pass: true, rejected: [], flags: [] },
      ...v.job,
    });
    dbm.addArtifact({ jobId: job.id, kind: 'cv_pdf', path: pdf, meta: { guard: { ok: v.cvGuardOk ?? true, rejectedBullets: [] } } });
    dbm.addArtifact({ jobId: job.id, kind: 'ats_report', content: JSON.stringify({ score: v.atsScore ?? 92 }) });
    dbm.addArtifact({ jobId: job.id, kind: 'cover_letter', content: 'Dear Hiring Team,\n\nLetter.\n\nKind Regards,\nKayzee' });
    dbm.addArtifact({ jobId: job.id, kind: 'answers', content: JSON.stringify(v.answers ?? goodAnswers) });
    return dbm.getJob(job.id)!;
  }

  async function runGate(v: Variant = {}, deps: Partial<PipelineDeps> = {}, s: Partial<Settings> = ON) {
    dbm.updateSettings(s as Parameters<typeof dbm.updateSettings>[0]);
    const job = eligibleJob(v);
    const stats = await pipeline.autopilotPass(fakeDeps(deps));
    return { job, stats, after: dbm.getJob(job.id)! };
  }

  test('approves a job that meets every condition, with an event and a notification', async () => {
    const notes: string[] = [];
    const { job, stats, after } = await runGate({}, { notify: (title) => void notes.push(title) });
    assert.deepEqual(stats.approved, [job.id]);
    assert.equal(after.status, 'approved');
    assert.equal(dbm.listEvents({ jobId: job.id, type: 'autopilot.approved' }).length, 1);
    assert.deepEqual(notes, ['Autopilot approved 1 application']);
  });

  const globalCases: [string, Partial<Settings>, string, Partial<PipelineDeps>?][] = [
    ['review mode', { ...ON, mode: 'review' }, 'disabled'],
    ['autopilot not enabled', { ...ON, autopilot: { ...ON.autopilot!, enabled: false } }, 'disabled'],
    ['paused', { ...ON, paused: true }, 'paused'],
    ['quiet hours', ON, 'quiet_hours', { now: () => dublinAt('23:15') }],
  ];
  for (const [name, s, skipped, deps] of globalCases) {
    test(`does nothing when ${name}`, async () => {
      const { stats, after } = await runGate({}, deps, s);
      assert.equal(stats.skipped, skipped);
      assert.equal(after.status, 'ready');
    });
  }

  test('does nothing once the autopilot daily cap is reached', async () => {
    for (let i = 0; i < 2; i++) dbm.logEvent('autopilot.approved', {}, undefined);
    const { stats, after } = await runGate({}, {}, { ...ON, autopilot: { ...ON.autopilot!, dailyCap: 2 } });
    assert.equal(stats.skipped, 'daily_cap');
    assert.equal(after.status, 'ready');
  });

  const jobCases: [string, Variant, RegExp, Partial<PipelineDeps>?][] = [
    ['score below autopilot minimum', { job: { score: 80 } }, /below the autopilot minimum of 85/],
    ['ATS not in the allowed list', { newJob: { ats: 'workday' } }, /ATS "workday" is not in the autopilot list/],
    ['ATS report under 80', { atsScore: 79 }, /ATS score 79 is below 80/],
    ['CV truth guard not clean', { cvGuardOk: false }, /CV truth guard is not clean/],
    ['CV PDF missing on disk', { noPdfFile: true }, /missing on disk/],
    ['cover letter fails the truth guard', {}, /Cover letter truth guard: number 40% not in facts/, {
      checkCoverLetter: () => ({ guard: { ok: false, problems: ['number 40% not in facts'] }, slop: { ok: true, hits: [] }, problems: ['Truth: number 40% not in facts'] }),
    }],
    ['cover letter fails the slop lint', {}, /Cover letter slop lint: delve/, {
      checkCoverLetter: () => ({ guard: { ok: true, problems: [] }, slop: { ok: false, hits: [{ rule: 'ai-vocab', match: 'delve' }] }, problems: ['Style: delve'] }),
    }],
    ['an LLM-written answer', { answers: [{ ...goodAnswers[0], source: 'llm' }] }, /not from the answer bank \(llm\)/],
    ['a question needing Kayzee', { answers: [{ ...goodAnswers[0], answer: null, source: 'none', needsHuman: true }] }, /Question needs Kayzee/],
    ['an unconfirmed bank answer', { answers: [{ ...goodAnswers[0], confirm: true }] }, /hasn't confirmed/],
    ['a question the answers artifact skipped', { answers: [] }, /Questions without an answer: "Do you need sponsorship\?"/],
    ['score flags', { job: { scoreDetail: { total: 90, components: { skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: ['Requires sponsorship-free right to work'], llmUsed: false, scoredAt: '' } } }, /Has flags: Requires sponsorship-free/],
    ['filter flags', { job: { filters: { pass: true, rejected: [], flags: ['Northern Ireland right to work'] } } }, /Has flags: Northern Ireland/],
  ];
  for (const [name, variant, pattern, deps] of jobCases) {
    test(`keeps the job in the queue on ${name}, and logs why`, async () => {
      const { job, stats, after } = await runGate(variant, deps);
      assert.equal(after.status, 'ready', 'stays in the queue');
      assert.deepEqual(stats.approved, []);
      const reasons = stats.rejected[job.id];
      assert.ok(reasons?.some((r) => pattern.test(r)), `expected ${pattern} in ${JSON.stringify(reasons)}`);
      const [event] = dbm.listEvents({ jobId: job.id, type: 'autopilot.rejected' });
      assert.deepEqual(event.detail?.reasons, reasons);
    });
  }

  test('rejection reasons are logged once, not every pass', async () => {
    dbm.updateSettings({ ...ON } as Parameters<typeof dbm.updateSettings>[0]);
    const job = eligibleJob({ atsScore: 50 });
    await pipeline.autopilotPass(fakeDeps());
    await pipeline.autopilotPass(fakeDeps());
    assert.equal(dbm.listEvents({ jobId: job.id, type: 'autopilot.rejected' }).length, 1);
  });

  test('stops approving mid-pass at the daily cap', async () => {
    dbm.updateSettings({ ...ON, autopilot: { ...ON.autopilot!, dailyCap: 1 } } as Parameters<typeof dbm.updateSettings>[0]);
    const a = eligibleJob();
    const b = eligibleJob();
    const stats = await pipeline.autopilotPass(fakeDeps());
    assert.equal(stats.approved.length, 1);
    const other = stats.approved[0] === a.id ? b.id : a.id;
    assert.match(stats.rejected[other]?.[0] ?? '', /daily cap of 1 reached/);
  });

  // ── Hands-free (Kayzee's "do everything for me" mode) ──
  const HF: Partial<Settings> = { mode: 'autopilot', autopilot: { enabled: true, minScore: 60, dailyCap: 25, ats: [], requireAllAnswers: false, handsFree: true } };
  const softFlags = { scoreDetail: { total: 90, components: { skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: ['Remote across Europe/EMEA: check they can employ you in Ireland', 'Offers visa/work-permit sponsorship'], llmUsed: false, scoredAt: '' } };
  const slopOnly = { checkCoverLetter: () => ({ guard: { ok: true, problems: [] }, slop: { ok: false, hits: [{ rule: 'rule-of-three', match: 'a, b and c' }] }, problems: ['Style: a, b and c'] }) };

  test('hands-free approves any fillable ATS, ignores soft flags and style-only letter issues', async () => {
    const { job, stats, after } = await runGate({ newJob: { ats: 'smartrecruiters' }, job: softFlags }, slopOnly, HF);
    assert.deepEqual(stats.approved, [job.id]);
    assert.equal(after.status, 'approved');
  });

  test('hands-free still blocks a letter that fails the truth guard', async () => {
    const { after, stats, job } = await runGate({ newJob: { ats: 'smartrecruiters' } }, {
      checkCoverLetter: () => ({ guard: { ok: false, problems: ['employer "Acme" not in facts'] }, slop: { ok: true, hits: [] }, problems: [] }),
    }, HF);
    assert.equal(after.status, 'ready');
    assert.ok(stats.rejected[job.id]?.some((r) => /truth guard/.test(r)));
  });

  const hfBlocks: [string, Variant, RegExp][] = [
    ['an unresolved LinkedIn job', { newJob: { ats: 'linkedin', applyUrl: 'https://www.linkedin.com/jobs/view/1' } }, /Not on the employer's own site yet/],
    ['an account-wall ATS', { newJob: { ats: 'workday' } }, /needs an account/],
    ['a dealbreaker flag', { newJob: { ats: 'greenhouse' }, job: { filters: { pass: true, rejected: [], flags: ['Irish language mentioned: check if essential'] } } }, /Has flags: Irish language/],
  ];
  for (const [name, variant, pattern] of hfBlocks) {
    test(`hands-free holds back ${name}`, async () => {
      const { job, stats, after } = await runGate(variant, {}, HF);
      assert.equal(after.status, 'ready');
      assert.ok(stats.rejected[job.id]?.some((r) => pattern.test(r)), JSON.stringify(stats.rejected[job.id]));
    });
  }

  test('hands-free asks Kayzee on Telegram instead of approving when an answer is missing', async () => {
    const asked: string[][] = [];
    const missing = [{ ...goodAnswers[0], answer: null, source: 'none' as const, needsHuman: true }];
    const { job, after, stats } = await runGate({ newJob: { ats: 'greenhouse' }, answers: missing }, {
      askKayzee: async (_job, qs) => { asked.push(qs.map((q) => q.label)); return true; },
    }, HF);
    assert.deepEqual(asked, [['Do you need sponsorship?']]);
    assert.equal(after.status, 'needs_you');
    assert.deepEqual(after.needs, ['Answer required question: "Do you need sponsorship?"'], 'standard need, so the question queue can re-queue it');
    assert.deepEqual(stats.approved, []);
    assert.equal(dbm.listEvents({ jobId: job.id, type: 'autopilot.asked' }).length, 1);
    assert.ok(dbm.listEvents({ jobId: job.id, type: 'status', limit: 20 }).some((e) => e.detail?.to === 'approved'), 'approval recorded for the re-queue gate');
  });

  test('hands-free parks the job in Needs you (with the questions) if they could not be queued', async () => {
    const missing = [{ ...goodAnswers[0], confirm: true }];
    const { after, stats, job } = await runGate({ newJob: { ats: 'greenhouse' }, answers: missing }, { askKayzee: async () => false }, HF);
    assert.equal(after.status, 'needs_you');
    assert.deepEqual(after.needs, ['Answer required question: "Do you need sponsorship?"']);
    assert.ok(stats.rejected[job.id]?.some((r) => /Needs your answer/.test(r)));
    assert.equal(dbm.listEvents({ jobId: job.id, type: 'autopilot.ask_failed' }).length, 1);
  });

  test('hands-free keeps applying overnight', async () => {
    const { stats, after } = await runGate({ newJob: { ats: 'greenhouse' } }, { now: () => dublinAt('03:10') }, HF);
    assert.equal(stats.skipped, undefined);
    assert.equal(after.status, 'approved');
    const s = settings(HF);
    assert.equal(scheduler.quietNow(s, dublinAt('03:10')), false);
    assert.equal(scheduler.quietNow(settings({ ...HF, mode: 'review' }), dublinAt('03:10')), true);
  });

  test('never touches demo jobs', async () => {
    const { stats, after } = await runGate({ newJob: { atsMeta: { demo: true } } });
    assert.equal(after.status, 'ready');
    assert.equal(stats.considered, 0);
  });
});

// ───────────────────────────── Pipeline stages ─────────────────────────────

describe('unattendedRank', () => {
  test('sites that submit with no human check go first, links that cannot be submitted last', () => {
    const rank = (ats: string, applyUrl = 'https://example.test/job') => pipeline.unattendedRank({ ats, applyUrl, url: applyUrl } as never);
    assert.equal(rank('greenhouse'), 0);
    assert.equal(rank('ashby'), 0);
    assert.equal(rank('lever'), 1);
    assert.equal(rank('smartrecruiters'), 2);
    assert.equal(rank('workable'), 2);
    assert.equal(rank('linkedin'), 3);
    assert.equal(rank('greenhouse', 'https://www.linkedin.com/jobs/view/1'), 3);
    // An employer's own careers page with no named system is submittable by the universal filler: not "stuck".
    assert.equal(rank('unknown', 'https://careers.example.test/jobs/1'), 1);
    assert.equal(rank('unknown', ''), 3);
  });
});

describe('posting age limit', () => {
  test('a posting older than 30 days is skipped before scoring, tailoring or applying; no posted date is not a reason', async () => {
    const old = new Date(NOON().getTime() - 45 * 86_400_000).toISOString();
    const recent = new Date(NOON().getTime() - 5 * 86_400_000).toISOString();
    assert.equal(pipeline.postingAgeDays({ postedAt: old }, NOON()), 45);
    assert.equal(pipeline.postingAgeDays({}, NOON()), null);

    const oldNew = insertJob('discovered', { postedAt: old });
    const freshNew = insertJob('discovered', { postedAt: recent });
    const undated = insertJob('discovered');
    let scoredCalls = 0;
    await pipeline.scorePending(10, fakeDeps({
      hardFilters: () => ({ pass: true, rejected: [], flags: [] }),
      scoreJob: async () => (scoredCalls++, { total: 80, components: { skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: [], llmUsed: false, scoredAt: '' }),
    }));
    assert.equal(scoredCalls, 2, 'the old posting never reaches the scorer');
    assert.equal(dbm.getJob(oldNew.id)?.status, 'skipped');
    assert.equal(dbm.getJob(freshNew.id)?.status, 'scored');
    assert.equal(dbm.getJob(undated.id)?.status, 'scored');
    const [ev] = dbm.listEvents({ jobId: oldNew.id, type: 'status' });
    assert.match(String((ev.detail?.detail as Record<string, unknown>).reason), /Posted 45 days ago: older than the 30-day limit/);

    const oldScored = insertJob('scored', { postedAt: old }, { score: 90 });
    const oldApproved = insertJob('approved', { postedAt: old });
    const tailor = await pipeline.tailorPending(5, fakeDeps({ tailorCv: async () => { throw new Error('must not tailor'); }, fitCheck: async () => ({ apply: false, fit: 0, reason: 'test: stop here' }) }));
    assert.equal(dbm.getJob(oldScored.id)?.status, 'skipped');
    assert.equal(tailor.considered, 0);
    await pipeline.processApproved(fakeDeps({ applyToJob: async () => { throw new Error('must not apply'); } }));
    assert.equal(dbm.getJob(oldApproved.id)?.status, 'skipped');
  });
});

describe('freshFirst', () => {
  test('unattended sites, then the newest posting day, then score', () => {
    const j = (id: string, ats: string, postedAt: string, score: number) => ({ id, ats, applyUrl: 'https://example.test/j', url: 'https://example.test/j', postedAt, discoveredAt: '2026-11-01T00:00:00Z', score });
    const order = pipeline.freshFirst([
      j('old-top', 'greenhouse', '2026-11-10T09:00:00Z', 95),
      j('today-low', 'greenhouse', '2026-11-20T08:00:00Z', 62),
      j('today-high', 'ashby', '2026-11-20T07:00:00Z', 80),
      j('today-check', 'smartrecruiters', '2026-11-20T10:00:00Z', 99),
      j('today-linkedin', 'linkedin', '2026-11-20T11:00:00Z', 99),
    ] as never).map((x) => (x as unknown as { id: string }).id);
    assert.deepEqual(order, ['today-high', 'today-low', 'old-top', 'today-check', 'today-linkedin']);
    // No posted date: falls back to when Pursuit first saw it.
    assert.equal(pipeline.freshness({ discoveredAt: '2026-11-20T00:00:00Z' } as never), Date.parse('2026-11-20T00:00:00Z'));
  });
});

describe('scorePending', () => {
  test('filters, scores, auto-skips below threshold, leaves demo jobs alone', async () => {
    const reject = insertJob('discovered', { title: 'Head of PR' });
    const low = insertJob('discovered', { title: 'Sales Rep' });
    const good = insertJob('discovered', { title: 'PR Executive' });
    const demo = insertJob('discovered', { atsMeta: { demo: true } });
    const stats = await pipeline.scorePending(10, fakeDeps({
      hardFilters: (job) => (job.title.startsWith('Head') ? { pass: false, rejected: ['seniority'], flags: [] } : { pass: true, rejected: [], flags: ['visa'] }),
      scoreJob: async (job) => ({ total: job.title === 'Sales Rep' ? 30 : 77.6, components: { skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: [], llmUsed: false, scoredAt: '' }),
    }));
    assert.deepEqual({ ...stats, errors: undefined }, { considered: 3, scored: 1, skipped: 1, filteredOut: 1, failed: 0, errors: undefined });
    assert.equal(dbm.getJob(reject.id)?.status, 'filtered_out');
    assert.deepEqual(dbm.getJob(reject.id)?.filters?.rejected, ['seniority']);
    const skipped = dbm.getJob(low.id)!;
    assert.equal(skipped.status, 'skipped');
    const [ev] = dbm.listEvents({ jobId: low.id, type: 'status' });
    assert.match(String(ev.detail?.detail && (ev.detail.detail as Record<string, unknown>).reason), /below the auto-skip threshold of 45/);
    const scored = dbm.getJob(good.id)!;
    assert.equal(scored.status, 'scored');
    assert.equal(scored.score, 78);
    assert.equal(scored.keywords?.pct, 80);
    assert.deepEqual(scored.filters?.flags, ['visa']);
    assert.equal(dbm.getJob(demo.id)?.status, 'discovered');
  });

  test('a job outside his line of work is skipped whatever its total', async () => {
    const off = insertJob('discovered', { title: 'Graduate Programme, Accountancy' });
    const on = insertJob('discovered', { title: 'PR Executive' });
    const stats = await pipeline.scorePending(10, fakeDeps({
      hardFilters: () => ({ pass: true, rejected: [], flags: [] }),
      scoreJob: async (job) => ({ total: 72, components: { skills: 1, roleFit: job.title.includes('Accountancy') ? 0.09 : 0.5, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: [], llmUsed: false, scoredAt: '' }),
    }));
    assert.equal(stats.skipped, 1);
    assert.equal(stats.scored, 1);
    assert.equal(dbm.getJob(off.id)?.status, 'skipped');
    assert.equal(dbm.getJob(off.id)?.score, 72);
    const [ev] = dbm.listEvents({ jobId: off.id, type: 'status' });
    assert.match(String((ev.detail?.detail as Record<string, unknown>).reason), /Role fit 9% is below 50%/);
    assert.equal(dbm.getJob(on.id)?.status, 'scored');
  });

  test('a job that keeps failing to score is parked as failed after 3 attempts', async () => {
    const job = insertJob('discovered');
    const deps = fakeDeps({ hardFilters: () => { throw new Error('bad JD'); } });
    for (let i = 0; i < 2; i++) {
      await pipeline.scorePending(5, deps);
      assert.equal(dbm.getJob(job.id)?.status, 'discovered');
    }
    const stats = await pipeline.scorePending(5, deps);
    assert.equal(stats.failed, 1);
    assert.equal(dbm.getJob(job.id)?.status, 'failed');
  });
});

describe('tailorPending', () => {
  const cv = (pdfPath: string | null) => ({
    model: { preamble: '', header: '', summary: '', sections: [], postamble: '' },
    texPath: '/tmp/cv.tex', pdfPath, summaryVariant: 'pr_comms', guard: { ok: true, rejectedBullets: [] },
    ats: pdfPath ? { score: 90 } as never : null, compileLog: pdfPath ? undefined : 'error: missing }',
  });
  const letter = async () => ({ text: 'Letter', guard: { ok: true, problems: [] }, slop: { ok: true, hits: [] } });

  test('the fit check skips an off-target job before any CV is written; a failing check goes by the score', async () => {
    dbm.updateSettings({ minScore: 60 });
    const off = insertJob('scored', { title: 'IT Labs Graduate Programme' }, { score: 90 });
    const on = insertJob('scored', { title: 'PR Executive' }, { score: 80 });
    const flaky = insertJob('scored', { title: 'Content Executive' }, { score: 70 });
    const tailored: string[] = [];
    const stats = await pipeline.tailorPending(5, fakeDeps({
      fitCheck: async (job) => {
        if (job.id === flaky.id) throw new Error('model down');
        return job.id === off.id ? { apply: false, fit: 0.1, reason: 'This is a software engineering programme.' } : { apply: true, fit: 0.9, reason: 'Same function.' };
      },
      tailorCv: async (job) => (tailored.push(job.id), cv(`/tmp/${job.id}.pdf`)),
      writeCoverLetter: letter,
    }));
    assert.deepEqual(tailored, [on.id, flaky.id]);
    assert.equal(stats.offTarget, 1);
    assert.equal(stats.ready, 2);
    assert.equal(dbm.getJob(off.id)?.status, 'skipped');
    const [ev] = dbm.listEvents({ jobId: off.id, type: 'status' });
    assert.match(String((ev.detail?.detail as Record<string, unknown>).reason), /^Fit check: This is a software engineering programme/);
  });

  test('best-scored first, writes artifacts, marks ready, notifies once', async () => {
    dbm.updateSettings({ minScore: 60 });
    const low = insertJob('scored', {}, { score: 55 });
    const best = insertJob('scored', { atsMeta: { questions: [{ label: 'Why us?', required: true, fields: [{ name: 'question_1', type: 'textarea' }] }] } }, { score: 90 });
    const mid = insertJob('scored', {}, { score: 70 });
    const order: string[] = [];
    const notes: [string, string][] = [];
    let questionsSeen: unknown[] = [];
    const stats = await pipeline.tailorPending(5, fakeDeps({
      tailorCv: async (job) => (order.push(job.id), cv(`/tmp/${job.id}.pdf`)),
      writeCoverLetter: letter,
      answerQuestions: async (qs) => ((questionsSeen = qs), qs.map((q) => ({ ...q, answer: 'Because', source: 'bank' as const, needsHuman: false }))),
      notify: (title, body) => void notes.push([title, body]),
    }));
    assert.deepEqual(order, [best.id, mid.id]);
    assert.equal(stats.ready, 2);
    assert.equal(dbm.getJob(low.id)?.status, 'scored', 'below minScore stays put');
    assert.equal(dbm.getJob(best.id)?.status, 'ready');
    assert.deepEqual(questionsSeen, [{ id: 'question_1', label: 'Why us?', type: 'textarea', required: true }]);
    for (const kind of ['cv_tex', 'cv_pdf', 'ats_report', 'cover_letter', 'answers'] as const) {
      assert.equal(dbm.listArtifacts(best.id, kind).length, 1, kind);
    }
    assert.equal(stats.tailoredToday, 2);
    assert.equal(notes.length, 1);
    assert.equal(notes[0][0], '2 new applications ready to approve');
  });

  test('does not duplicate artifacts the engine module already stored', async () => {
    const job = insertJob('scored', {}, { score: 80 });
    await pipeline.tailorPending(5, fakeDeps({
      tailorCv: async (j) => cv(`/tmp/${j.id}.pdf`),
      writeCoverLetter: async (j) => {
        dbm.addArtifact({ jobId: j.id, kind: 'cover_letter', content: 'stored by module' });
        return letter();
      },
    }));
    const letters = dbm.listArtifacts(job.id, 'cover_letter');
    assert.equal(letters.length, 1);
    assert.equal(letters[0].content, 'stored by module');
  });

  test('a CV that fails to compile goes to needs_you with the compile log kept', async () => {
    const job = insertJob('scored', {}, { score: 80 });
    const stats = await pipeline.tailorPending(5, fakeDeps({ tailorCv: async () => cv(null), writeCoverLetter: letter }));
    assert.equal(stats.needsYou, 1);
    const after = dbm.getJob(job.id)!;
    assert.equal(after.status, 'needs_you');
    assert.match(after.needs?.[0] ?? '', /failed to compile/);
    assert.equal(dbm.listArtifacts(job.id, 'compile_log').length, 1);
  });

  test('respects dailyTailorCap', async () => {
    dbm.updateSettings({ dailyTailorCap: 1 });
    const done = insertJob('ready');
    dbm.addArtifact({ jobId: done.id, kind: 'cv_pdf', path: '/tmp/x.pdf' });
    const waiting = insertJob('scored', {}, { score: 90 });
    const stats = await pipeline.tailorPending(5, fakeDeps());
    assert.equal(stats.capped, true);
    assert.equal(dbm.getJob(waiting.id)?.status, 'scored');
  });

  test('an engine error puts the job back to scored for a retry', async () => {
    const job = insertJob('scored', {}, { score: 80 });
    const stats = await pipeline.tailorPending(5, fakeDeps({ tailorCv: async () => { throw new Error('LLM timeout'); } }));
    assert.equal(stats.retried, 1);
    assert.equal(dbm.getJob(job.id)?.status, 'scored');
  });
});

describe('processApproved', () => {
  test('applies newest first with 20-60 s jitter between, never before the first', async () => {
    const a = insertJob('approved');
    await new Promise((r) => setTimeout(r, 5)); // distinct discoveredAt so "newest first" is deterministic
    const b = insertJob('approved');
    const calls: string[] = [];
    const sleeps: number[] = [];
    const stats = await pipeline.processApproved(fakeDeps({
      random: () => 0.25,
      sleep: async (ms) => void sleeps.push(ms),
      applyToJob: async (id, opts) => {
        assert.deepEqual(opts, { mode: 'submit', headless: true });
        calls.push(id);
        dbm.setStatus(id, 'applied');
        return { status: 'applied' };
      },
    }));
    assert.deepEqual(calls, [b.id, a.id]);
    assert.deepEqual(sleeps, [30_000]);
    assert.equal(stats.applied, 2);
  });

  test('stops when paused or at the daily apply cap', async () => {
    insertJob('approved');
    dbm.updateSettings({ paused: true });
    const paused = await pipeline.processApproved(fakeDeps());
    assert.equal(paused.stoppedBy, 'paused');
    assert.equal(paused.attempted, 0);

    dbm.updateSettings({ paused: false, dailyApplyCap: 1 });
    insertJob('applied');
    const capped = await pipeline.processApproved(fakeDeps());
    assert.equal(capped.stoppedBy, 'daily_cap');
    assert.equal(capped.attempted, 0);
  });

  test('pausing during the jitter wait stops before the next application', async () => {
    insertJob('approved');
    insertJob('approved');
    let applied = 0;
    const stats = await pipeline.processApproved(fakeDeps({
      sleep: async () => void dbm.updateSettings({ paused: true }),
      applyToJob: async (id) => (applied++, dbm.setStatus(id, 'applied'), { status: 'applied' }),
    }));
    assert.equal(applied, 1);
    assert.equal(stats.stoppedBy, 'paused');
  });

  test('a crash in the runner hands the job to Kayzee (never retried blindly)', async () => {
    const job = insertJob('approved');
    const stats = await pipeline.processApproved(fakeDeps({
      applyToJob: async (id) => {
        dbm.setStatus(id, 'applying');
        throw new Error('browser died');
      },
    }));
    assert.equal(stats.needsYou, 1);
    const after = dbm.getJob(job.id)!;
    assert.equal(after.status, 'needs_you');
    assert.match(after.needs?.[0] ?? '', /browser died/);
  });

  test('abort during the jitter wait stops the loop', async () => {
    insertJob('approved');
    insertJob('approved');
    const controller = new AbortController();
    const stats = await pipeline.processApproved(fakeDeps({
      sleep: async () => {
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
      applyToJob: async (id) => (dbm.setStatus(id, 'applied'), { status: 'applied' }),
    }), controller.signal);
    assert.equal(stats.attempted, 1);
    assert.equal(stats.stoppedBy, 'shutdown');
  });
});

describe('outreachPending', () => {
  test('stores contacts, drafts for verified email + LinkedIn, forces draft status, runs once per job', async () => {
    const job = insertJob('ready', {}, { score: 80 });
    let emailDrafts = 0;
    const deps = fakeDeps({
      findContacts: async (j) => [
        { jobId: j.id, company: j.company, email: 'guess@example.com', emailVerified: false, source: 'company_site', confidence: 0.9 },
        { jobId: j.id, company: j.company, name: 'Pat', email: 'pat@example.com', emailVerified: true, source: 'jd', confidence: 0.8 },
        { jobId: j.id, company: j.company, linkedinUrl: 'https://www.linkedin.com/search/results/people/?keywords=x', emailVerified: false, source: 'jd', confidence: 0.3 },
      ],
      draftOutreachEmail: async (j, contact) => {
        emailDrafts++;
        assert.equal(contact.email, 'pat@example.com', 'never drafts to a guessed address');
        return { jobId: j.id, direction: 'out', channel: 'email', kind: 'outreach', to: contact.email, body: 'Hi Pat', status: 'approved' };
      },
      draftLinkedInNote: async (j, contact) => ({ jobId: j.id, contactId: contact.id, direction: 'out', channel: 'linkedin', kind: 'linkedin_note', body: 'Hi', status: 'draft' }),
    });
    const stats = await pipeline.outreachPending(5, deps);
    assert.equal(stats.contactsFound, 3);
    assert.equal(stats.emailDrafts, 1);
    assert.equal(stats.linkedinDrafts, 1);
    const msgs = dbm.listMessages({ jobId: job.id });
    assert.equal(msgs.length, 2);
    assert.ok(msgs.every((m) => m.status === 'draft'), 'approval only ever comes from Kayzee');
    const again = await pipeline.outreachPending(5, deps);
    assert.equal(again.considered, 0);
    assert.equal(emailDrafts, 1);
  });

  test('a drafter declining (DraftError) is a no-draft outcome, not a failure; saved contacts are accepted', async () => {
    const job = insertJob('ready', {}, { score: 80 });
    const saved = dbm.upsertContact({ jobId: job.id, company: job.company, email: 'noreply@example.com', emailVerified: true, source: 'jd', confidence: 0.9 });
    const deps = fakeDeps({
      findContacts: async () => [saved],
      draftOutreachEmail: async () => {
        const err = new Error('noreply@example.com is a no-reply address');
        err.name = 'DraftError';
        throw err;
      },
    });
    const stats = await pipeline.outreachPending(5, deps);
    assert.equal(stats.errors.length, 0);
    assert.equal(stats.contactsFound, 1);
    assert.equal(stats.emailDrafts, 0);
    assert.equal(dbm.listContacts({ jobId: job.id }).length, 1, 'no duplicate contact row');
    assert.equal(dbm.listEvents({ jobId: job.id, type: 'outreach.processed' }).length, 1, 'marked processed: not retried');
  });
});

describe('recoverInterrupted', () => {
  test('stale tailoring → scored, stale applying → needs_you, fresh ones untouched', () => {
    const t = insertJob('tailoring');
    const a = insertJob('applying');
    const fresh = insertJob('applying');
    const later = new Date(Date.now() + 20 * MIN);
    // `fresh` was touched 1 minute before the recovery clock: well inside STUCK_AFTER_MS.
    dbm.db().prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(new Date(later.getTime() - MIN).toISOString(), fresh.id);
    const r = pipeline.recoverInterrupted(later);
    assert.deepEqual(r, { tailoring: 1, applying: 1 });
    assert.equal(dbm.getJob(t.id)?.status, 'scored');
    assert.equal(dbm.getJob(a.id)?.status, 'needs_you');
    assert.equal(dbm.getJob(fresh.id)?.status, 'applying');
    assert.equal(pipeline.recoverInterrupted(new Date()).applying, 0);
  });

  test('skips while another process holds the task lease', () => {
    const job = insertJob('applying');
    const at = new Date(Date.now() + 20 * MIN + 1);
    lock.acquireLease('apply', { owner: 'next-server', now: at });
    assert.equal(pipeline.recoverInterrupted(at).applying, 0);
    assert.equal(dbm.getJob(job.id)?.status, 'applying');
    lock.releaseLease('apply', 'next-server');
    assert.equal(pipeline.recoverInterrupted(at).applying, 1, 'recovers once the lease is gone');
  });
});

// ───────────────────────────── Questions ─────────────────────────────

describe('questionsFromAtsMeta', () => {
  test('normalises Greenhouse, Lever and Ashby shapes and drops standard fields', () => {
    const qs = questionsFromAtsMeta({
      questions: [
        { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
        { label: 'Resume/CV', required: true, fields: [{ name: 'resume', type: 'input_file' }, { name: 'resume_text', type: 'textarea' }] },
        { label: 'Do you require sponsorship?', required: true, fields: [{ name: 'question_9', type: 'multi_value_single_select', values: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] }] },
        { field: { path: '_systemfield_email', title: 'Email', type: 'Email' }, isRequired: true },
        { field: { path: 'abc-123', title: 'Willing to relocate?', type: 'Boolean' }, isRequired: false },
        { text: 'Portfolio link', type: 'text', required: false, id: 'lever-q1' },
        { id: 'already', label: 'Notice period', type: 'select', required: true, options: ['1 month', '3 months'] },
        'garbage',
        { label: 'Hidden', fields: [{ name: 'h', type: 'input_hidden' }] },
      ],
      customQuestions: [{ text: 'Card', fields: [{ text: 'Salary expectation', type: 'dropdown', required: true, options: [{ text: '30-35k' }] }] }],
    });
    assert.deepEqual(qs, [
      { id: 'question_9', label: 'Do you require sponsorship?', type: 'select', required: true, options: ['Yes', 'No'] },
      { id: 'abc-123', label: 'Willing to relocate?', type: 'yesno', required: false },
      { id: 'lever-q1', label: 'Portfolio link', type: 'text', required: false },
      { id: 'already', label: 'Notice period', type: 'select', required: true, options: ['1 month', '3 months'] },
      { id: 'q0', label: 'Salary expectation', type: 'select', required: true, options: ['30-35k'] },
    ]);
  });

  test('returns [] for missing or malformed metadata', () => {
    assert.deepEqual(questionsFromAtsMeta(undefined), []);
    assert.deepEqual(questionsFromAtsMeta({ questions: 'nope' }), []);
    assert.deepEqual(questionsFromAtsMeta({}), []);
  });
});
